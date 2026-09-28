/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentAdapter, AgentCatalog, commandPrefixes, FORBIDDEN_COMMANDS, HookPolicy, LaunchSpec, McpLaunch } from './agents';
import { CancelledError, KeyedMutex, sleep } from './async';
import { ChecksRunner } from './checks';
import { Git } from './git';
import { normalizePath } from './glob';
import { hashToken, newToken } from './ipc';
import { McpToolResult } from './mcp';
import { AgentRef, CheckSummary, Cmd, Finding, FindingLocation, FindingRoute, formatAgent, LEAD_RUNG, LeadSubmitKind, MergeRecord, parseRung, ProgramEvent, ProgramEventBody, ProgramPlan, ProgramState, ProgressStep, QueueItem, ShipMode, WorkerResult, FeatureState, FeatureStatus } from './model';
import { conflictResolver, mergeItem, MergeOutcome, outsideOwnership, ownerOf, stagedRef } from './queue';
import { attemptCommands, criterionId, failedCheckSummary, initialPrompt, nextStep, renderChecks, renderContract, renderDigest, renderEvent, REPORTED } from './render';
import { completionProblems, featureOfFinding, MergeFacts, routeProblem, SEVERITIES, similarFinding, writeIntegrationPacket, writeMergePacket } from './review';
import { holdsSlot, pickStarts } from './scheduler';
import { cleanup, CleanupPlan, ShipError, shipMessage, shipProblems, shipToBase } from './ship';
import { Environment, OutputTail, runProcess, which } from './spawn';
import { checkCacheKey } from './state';
import { listProgramDirs, ProgramLog } from './store';
import { Role } from './tools';
import { claudeTranscriptUsage, jsonLines, withPrice } from './usage';
import { commandKey, ladderOf, validatePlan } from './validator';

/*
 * The engine behind every tool (design doc sections 6 to 10). The lead plans, reviews and decides;
 * everything mechanical happens here: worktrees, branches, workers, checks, the merge queue, the
 * review ledger, shipping and the order of it all. It holds no state of its own that a reload
 * could lose: every change is an event in the program's log first.
 */

export type Principal =
	| { readonly role: 'lead'; readonly session: string }
	| { readonly role: 'worker'; readonly programId: string; readonly featureId: string; readonly attempt: number };

export class ToolError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'ToolError';
	}
}

export interface EngineSettings {
	readonly maxParallel: number;
	readonly checkSlots: number;
	readonly ladder: readonly string[];
	readonly retriesPerRung: number;
	readonly agentConcurrency: { readonly [agent: string]: number };
	readonly hotspots: readonly string[];
	readonly stallMinutes: number;
	readonly closeVerifiedWorkers: boolean;
	/** Interactive: each worker is its agent's own terminal UI. Headless: its non-interactive mode. */
	readonly workerMode: 'interactive' | 'headless';
}

export interface WorkerLaunchRequest {
	readonly name: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** Typed into the terminal once the agent has started. */
	readonly initialInput?: string;
}

/** Starts and stops workers. Facade runs them in its terminals; tests run them as processes. */
export interface WorkerRunner {
	/** Starts a worker. Its name is its handle, unique per attempt and valid across a window reload. */
	launch(request: WorkerLaunchRequest): Promise<void>;
	stop(handle: string): void;
	isAlive(handle: string): Promise<boolean>;
}

export interface WorktreeFactory {
	create(repoRoot: string, worktreePath: string, branch: string, startPoint: string): Promise<void>;
}

/** What the person sees and decides. */
export interface EngineUi {
	planSubmitted(program: ProgramState): void;
	programInterrupted(program: ProgramState): void;
	changed(program: ProgramState): void;
	/** The lead asked to ship; the person approves it, or not, in Facade. */
	shipRequested(program: ProgramState): void;
	/** Something outside Facade moved or holds the integration branch. */
	queueHalted(program: ProgramState, reason: string): void;
	/** Something the person should know, once. */
	notice(message: string): void;
}

export interface CommandApprovals {
	approved(repoRoot: string): ReadonlySet<string>;
	approve(repoRoot: string, keys: readonly string[]): void;
}

/** The person's answer to whether an agent may trust the worktrees Facade makes for it. */
export interface TrustDecisions {
	/** Resolves with the stored answer, asking the person the first time. */
	decide(agentId: string, displayName: string, detail: string): Promise<boolean>;
}

export interface EngineOptions {
	readonly storageDir: string;
	readonly worktreesRoot: string;
	readonly git: Git;
	readonly worktrees: WorktreeFactory;
	readonly runner: WorkerRunner;
	readonly ui: EngineUi;
	readonly commandApprovals: CommandApprovals;
	readonly trust: TrustDecisions;
	/** How to start Facade's shim; the engine adds the subcommand (`mcp`, `run`, `hook`) and its arguments. */
	readonly shim: McpLaunch;
	readonly pipe: string;
	readonly env: Environment;
	settings(): EngineSettings;
	catalog(): AgentCatalog;
	log(message: string): void;
	readonly now?: () => number;
	/** How long a question waits before the worker is told to go on without an answer. */
	readonly questionTimeoutMs?: number;
}

/** Events that wake a lead waiting in `await_events`. */
const LEAD_EVENTS: ReadonlySet<ProgramEvent['type']> = new Set([
	'plan.approved', 'plan.changes_requested', 'feature.question', 'feature.escalated', 'feature.needs_lead', 'feature.stalled', 'feature.waiting', 'feature.turn_ended',
	'feature.ended', 'feature.launch_failed', 'queue.merged', 'queue.conflict', 'queue.checks_failed', 'queue.halted', 'checks.full', 'program.all_merged', 'review.recorded',
	'ship.done', 'ship.failed', 'ship.cancelled', 'program.paused', 'program.aborted'
]);

/** Events that end a queue item. */
const ITEM_OUTCOMES: ReadonlySet<ProgramEvent['type']> = new Set(['queue.merged', 'queue.checks_failed', 'queue.conflict', 'queue.dropped']);

const PROGRESS_INTERVAL_MS = 15_000;
const DEFAULT_AWAIT_SEC = 600;
const DEFAULT_ASK_WAIT_SEC = 300;
/** How often a hook may send a worker that has not submitted back to work before it may stop. */
const MAX_STOP_BLOCKS = 2;

/** Lines that look like credentials. Deliberately narrow: a false alarm costs a worker a round. */
const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
	/\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
	/\bsk-[A-Za-z0-9]{32,}\b/,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/
];

/** The start or end of a conflict git left in a file. */
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/;

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*\.py$/i;
const TEST_CASE = /\b(test|it|suite|describe|context|specify)\s*\(|\bdef test_|\bfunc Test|#\[test\]|@Test\b/g;
const ASSERTION = /\bassert\w*\b|\bexpect\s*\(/g;

export class Engine {

	private readonly programs = new Map<string, ProgramLog>();
	private readonly principals = new Map<string, Principal>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly mutex = new KeyedMutex();
	private readonly launching = new Set<string>();
	private readonly draining = new Set<string>();
	private readonly activity = new Map<string, number>();
	private readonly stalled = new Set<string>();
	/** How often a Stop hook sent each attempt back to work. */
	private readonly stopBlocks = new Map<string, number>();
	/** The transcript each interactive attempt's Stop hook named, for its token usage. */
	private readonly transcripts = new Map<string, string>();
	private readonly noticed = new Set<string>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly checks: ChecksRunner;
	private readonly now: () => number;
	/** Cancels the checks the queue runs in the background when the engine goes away. */
	private readonly shutdown = new AbortController();
	/** Work the engine started on its own, such as a queue drain or a launch, while it runs. */
	private readonly background = new Set<Promise<unknown>>();
	private stallTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(private readonly options: EngineOptions) {
		this.now = options.now ?? Date.now;
		this.checks = new ChecksRunner({ slots: options.settings().checkSlots, env: options.env });
	}

	/*
	 * Lifecycle
	 */

	/** Loads every program and takes up the work a reload left running. */
	async start(): Promise<void> {
		fs.mkdirSync(this.options.storageDir, { recursive: true });
		for (const dir of listProgramDirs(this.options.storageDir)) {
			const log = ProgramLog.load(dir, this.now);
			if (log) {
				this.programs.set(log.state.id, log);
			}
		}
		for (const log of this.programs.values()) {
			try {
				await this.recover(log);
			} catch (err) {
				this.options.log(`[engine] recovering ${log.state.id} failed: ${(err as Error).stack ?? err}`);
			}
		}
		this.stallTimer = setInterval(() => this.checkStalls(), 60_000);
		this.stallTimer.unref?.();
	}

	/** Resolves once the work the engine started on its own has ended; after `dispose`, that is soon. */
	async idle(): Promise<void> {
		while (this.background.size) {
			await Promise.allSettled([...this.background]);
		}
	}

	private track<T>(work: Promise<T>): Promise<T> {
		this.background.add(work);
		void work.finally(() => this.background.delete(work)).catch(() => undefined);
		return work;
	}

	dispose(): void {
		this.disposed = true;
		this.shutdown.abort();
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
		}
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		for (const log of this.programs.values()) {
			log.close();
		}
		for (const listeners of this.listeners.values()) {
			for (const wake of listeners) {
				wake();
			}
		}
	}

	/**
	 * A worker whose terminal is still there survived a window reload and carries on. When none
	 * of a running program's workers survived, the app restarted: the program pauses until the
	 * person resumes it, because agents do not outlive the app (L1). The merge queue checks that
	 * the integration branch is where the log says, and finds a merge the log did not record.
	 */
	private async recover(log: ProgramLog): Promise<void> {
		const program = log.state;
		if (program.ship?.status === 'shipping') {
			const base = await this.options.git.resolveCommit(program.repoRoot, `refs/heads/${program.plan.base}`);
			this.append(log, { type: 'ship.failed', reason: `Facade reloaded while shipping. ${program.plan.base} is at ${base?.slice(0, 9) ?? 'nothing'}; check it before shipping again.` });
		}
		if (program.status !== 'running' && program.status !== 'paused' && program.status !== 'approved') {
			return;
		}
		await this.reconcileQueue(log);
		let working = 0;
		let survived = 0;
		for (const feature of program.features.values()) {
			const attempt = feature.active;
			if (!attempt) {
				continue;
			}
			// A verified feature whose worker is still open does not decide whether work was lost.
			const isWorking = feature.status === 'running' || feature.status === 'verifying';
			if (isWorking) {
				working++;
			}
			if (attempt.terminal && await this.options.runner.isAlive(attempt.terminal)) {
				if (isWorking) {
					survived++;
				}
				this.principals.set(attempt.tokenHash, { role: 'worker', programId: program.id, featureId: feature.spec.id, attempt: attempt.attempt });
				if (feature.status === 'verifying') {
					// The checks ran in the old extension host and died with it.
					this.append(log, { type: 'feature.reset', feature: feature.spec.id, attempt: attempt.attempt, reason: 'the window reloaded while its checks ran' });
				}
			} else {
				this.append(log, { type: 'feature.ended', feature: feature.spec.id, attempt: attempt.attempt, reason: 'interrupted' });
			}
		}
		if (program.status === 'running' && working > 0 && survived === 0) {
			this.append(log, { type: 'program.paused', reason: 'interrupted: Facade restarted while workers ran' });
			this.options.ui.programInterrupted(program);
		}
		this.pumpQueue(program.id);
		await this.schedule(program.id);
	}

	/** The integration branch must be where the log says; a merge the log missed is recorded now. */
	private async reconcileQueue(log: ProgramLog): Promise<void> {
		const program = log.state;
		const git = this.options.git;
		if (!program.integrationBranch || !program.integrationTip) {
			return;
		}
		const current = await git.resolveCommit(program.repoRoot, `refs/heads/${program.integrationBranch}`);
		if (current === program.integrationTip) {
			return;
		}
		const head = program.queue[0];
		if (head && current && await git.resolveCommit(program.repoRoot, stagedRef(program.id, head.id)) === current) {
			const parents = await git.parents(program.repoRoot, current);
			if (parents.length === 2 && parents[0] === program.integrationTip && parents[1] === head.commit) {
				// The queue moved the branch and the window went before the log said so. The branch only
				// moves after the fast checks pass, so they passed.
				const checks: CheckSummary = { passed: true, tree: await git.tree(program.repoRoot, current), runs: [] };
				const packet = await this.writePacketQuietly(program, { commit: current, parent: program.integrationTip, item: head, checks });
				this.append(log, { type: 'queue.merged', itemId: head.id, commit: current, parent: program.integrationTip, checks, packet });
				return;
			}
		}
		this.haltQueue(log, `the integration branch ${program.integrationBranch} is at ${current?.slice(0, 9) ?? 'nothing'}, not at ${program.integrationTip.slice(0, 9)} where Facade left it`);
	}

	/*
	 * Principals
	 */

	/** A token that makes its holder a lead in this window. */
	issueLeadToken(session: string): string {
		const token = newToken();
		this.principals.set(hashToken(token), { role: 'lead', session });
		return token;
	}

	authenticate(token: string): Principal | undefined {
		const principal = this.principals.get(hashToken(token));
		if (principal?.role === 'worker') {
			const feature = this.programs.get(principal.programId)?.state.features.get(principal.featureId);
			// A worker's token dies with its attempt.
			if (feature?.active?.attempt !== principal.attempt) {
				return undefined;
			}
		}
		return principal;
	}

	hello(principal: Principal): { role: Role; program?: string; feature?: string } {
		return principal.role === 'lead' ? { role: 'lead' } : { role: 'worker', program: principal.programId, feature: principal.featureId };
	}

	/*
	 * Tools
	 */

	async call(principal: Principal, tool: string, args: unknown, cwd: string | undefined, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		try {
			const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
			if (principal.role === 'worker') {
				if (tool !== 'worker_hook') {
					this.touch(principal);
				}
				switch (tool) {
					case 'get_contract': return this.getContract(principal);
					case 'report_progress': return this.reportProgress(principal, input);
					case 'ask_lead': return await this.askLead(principal, input, signal, progress);
					case 'submit_result': return await this.submitResult(principal, input, signal, progress);
					case 'worker_hook': return this.workerHook(principal, input);
				}
			} else {
				switch (tool) {
					case 'plan_save': return await this.planSave(input, cwd);
					case 'plan_submit': return await this.planSubmit(input);
					case 'lead_workspace': return await this.leadWorkspace(input);
					case 'lead_submit': return await this.leadSubmit(input, signal, progress);
					case 'program_start': return await this.programStart(input);
					case 'await_events': return await this.awaitEvents(input, signal, progress);
					case 'program_status': return await this.programStatus(input, cwd);
					case 'answer': return this.answer(input);
					case 'feature_update': return await this.featureUpdate(input);
					case 'program_control': return await this.programControl(input);
					case 'review_packet': return await this.reviewPacket(input);
					case 'review_record': return this.reviewRecord(input);
					case 'review_route': return await this.reviewRoute(input);
					case 'review_complete': return this.reviewComplete(input);
					case 'ship': return await this.ship(input);
				}
			}
			throw new ToolError('UNKNOWN_TOOL', `${tool} is not a ${principal.role} tool.`);
		} catch (err) {
			if (err instanceof ToolError) {
				return { text: err.message, data: { error: err.code }, isError: true };
			}
			if (err instanceof CancelledError) {
				throw err;
			}
			this.options.log(`[engine] ${tool} failed: ${(err as Error).stack ?? err}`);
			return { text: `Facade could not complete ${tool}: ${(err as Error).message}`, data: { error: 'INTERNAL' }, isError: true };
		}
	}

	private async planSave(input: Record<string, unknown>, cwd: string | undefined): Promise<McpToolResult> {
		const plan = input.plan as ProgramPlan;
		const existingId = typeof input.program_id === 'string' ? input.program_id : undefined;
		let repoRoot: string;
		let log: ProgramLog | undefined;
		if (existingId) {
			log = this.program(existingId);
			if (log.state.status !== 'draft' && log.state.status !== 'awaiting_approval') {
				throw new ToolError('CONFLICT', `Program ${existingId} is ${log.state.status}; its plan can no longer change.`);
			}
			repoRoot = log.state.repoRoot;
		} else {
			if (!cwd) {
				throw new ToolError('NO_REPOSITORY', 'Facade could not tell which repository you are in.');
			}
			repoRoot = await this.repositoryOf(cwd);
		}
		const base = plan && typeof plan.base === 'string' ? await this.options.git.resolveCommit(repoRoot, plan.base) : undefined;
		const validation = validatePlan(plan, {
			trackedFiles: base ? await this.options.git.trackedFiles(repoRoot, base) : [],
			hotspots: this.options.settings().hotspots,
			knownAgents: this.options.catalog().known,
			availableAgents: new Set(this.options.catalog().installed.keys()),
			defaultLadder: this.defaultLadder(),
			approvedCommands: this.options.commandApprovals.approved(repoRoot),
			otherPrograms: [...this.programs.values()].filter(other => other !== log && other.state.repoRoot === repoRoot && !['aborted', 'draft', 'shipped'].includes(other.state.status)).map(other => ({ id: other.state.id, owns: other.state.plan.features.flatMap(feature => feature.owns) }))
		});
		const errors = [...validation.errors];
		if (plan && typeof plan.base === 'string' && !base) {
			errors.push({ rule: 'V0', message: `The base branch "${plan.base}" does not exist in ${repoRoot}.` });
		}
		if (errors.length) {
			const text = [`The plan was not saved: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`, ...errors.map(issue => `- [${issue.rule}] ${issue.message}`), ...validation.warnings.map(issue => `- warning [${issue.rule}] ${issue.message}`), 'Fix every problem and call plan_save again.'].join('\n');
			return { text, data: { saved: false, errors, warnings: validation.warnings }, isError: true };
		}
		if (log) {
			this.append(log, { type: 'plan.updated', plan });
		} else {
			const id = this.newProgramId();
			log = ProgramLog.create(this.options.storageDir, id, { type: 'program.created', plan, repoRoot, repoName: path.basename(repoRoot), createdBy: 'lead' }, this.now);
			this.programs.set(id, log);
			this.options.ui.changed(log.state);
		}
		const commands = validation.newCommands.map(key => JSON.parse(key) as string[]).map(([cwd, ...argv]) => `  ${cwd === '.' ? '' : `${cwd}> `}${argv.join(' ')}`);
		const text = [
			`Saved program ${log.state.id} with ${plan.features.length} features.`,
			...validation.warnings.map(issue => `- warning [${issue.rule}] ${issue.message}`),
			...(commands.length ? ['These commands are new to this repository; the user approves them with the plan:', ...commands] : []),
			'Next: plan_submit, then tell the user the plan is waiting for their approval in Facade.'
		].join('\n');
		return { text, data: { saved: true, program: log.state.id, warnings: validation.warnings, newCommands: validation.newCommands } };
	}

	private async planSubmit(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		if (program.status === 'awaiting_approval') {
			return { text: `Program ${program.id} is already waiting for the user's approval.`, data: { status: program.status } };
		}
		if (program.status !== 'draft') {
			throw new ToolError('CONFLICT', `Program ${program.id} is ${program.status}.`);
		}
		const baseCommit = await this.options.git.resolveCommit(program.repoRoot, program.plan.base);
		if (!baseCommit) {
			throw new ToolError('NO_BASE', `The base branch "${program.plan.base}" no longer exists.`);
		}
		const branch = program.plan.integrationBranch ?? `facade/${program.id}${slug(program.plan.goal) ? `-${slug(program.plan.goal)}` : ''}`;
		if (!await this.options.git.isValidBranchName(program.repoRoot, branch)) {
			throw new ToolError('BAD_BRANCH', `"${branch}" is not a valid branch name; set integrationBranch in the plan.`);
		}
		if (await this.options.git.branchExists(program.repoRoot, branch)) {
			throw new ToolError('BRANCH_EXISTS', `The branch ${branch} already exists. Choose another integrationBranch with plan_save.`);
		}
		const approved = this.options.commandApprovals.approved(program.repoRoot);
		const newCommands = [...new Set(allCommands(program.plan).map(commandKey))].filter(key => !approved.has(key));
		this.append(log, { type: 'plan.submitted', baseCommit, integrationBranch: branch, newCommands });
		this.options.ui.planSubmitted(program);
		return { text: `Program ${program.id} is waiting for the user's approval in Facade. You cannot approve it yourself. Tell the user, then call await_events with cursor ${program.seq}.`, data: { status: program.status, cursor: program.seq } };
	}

	/**
	 * The lead's one worktree: made at the integration tip, or brought up to it. With a feature, that
	 * feature's work is merged in so the lead can finish it; with sync, the base branch is merged in.
	 */
	private async leadWorkspace(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		this.requireApproved(program);
		const featureId = typeof input.feature === 'string' && input.feature ? input.feature : undefined;
		const feature = featureId !== undefined ? program.features.get(featureId) : undefined;
		if (featureId !== undefined && !feature) {
			throw new ToolError('NOT_FOUND', `Program ${program.id} has no feature ${featureId}.`);
		}
		if (feature && feature.status !== 'needs_lead') {
			throw new ToolError('CONFLICT', `${feature.spec.id} is ${feature.status}. You take over only a feature that needs you.`);
		}
		const sync = input.sync === true;
		return this.mutex.run(`lead:${program.id}`, async () => {
			const git = this.options.git;
			const tip = program.integrationTip!;
			let conflicts: string[] = [];
			const merged: string[] = [];
			if (!program.lead || !await git.hasWorktree(program.repoRoot, program.lead.path)) {
				const worktree = this.freePath(path.join(this.options.worktreesRoot, program.repoName, `${program.id}-lead`));
				let branch = `facade/${program.id}/lead`;
				if (await git.branchExists(program.repoRoot, branch)) {
					branch = `${branch}-${program.seq}`;
				}
				await this.options.worktrees.create(program.repoRoot, worktree, branch, tip);
				this.append(log, { type: 'lead.workspace', path: worktree, branch, commit: tip });
			} else {
				const lead = program.lead;
				if (await git.mergeInProgress(lead.path) || await git.hasChanges(lead.path)) {
					const changed = await git.changedPaths(lead.path, 'HEAD');
					throw new ToolError('DIRTY', `Your worktree ${lead.path} has changes that are not submitted${changed.length ? `: ${changed.slice(0, 20).join(', ')}` : ''}. lead_submit them, or undo them, then call lead_workspace again.`);
				}
				conflicts = await this.bringUpToDate(lead.path, tip, `Merge ${program.integrationBranch} into ${lead.branch}`);
				if (!conflicts.length) {
					merged.push(`the integration branch at ${tip.slice(0, 9)}`);
				}
			}
			const lead = program.lead!;
			if (!conflicts.length && feature?.branch) {
				const featureTip = await git.resolveCommit(program.repoRoot, `refs/heads/${feature.branch}`);
				if (featureTip && !await git.isAncestor(program.repoRoot, featureTip, await git.head(lead.path))) {
					conflicts = (await git.merge(lead.path, featureTip, `Merge ${feature.branch} into ${lead.branch}`)).conflicts;
					merged.push(`${feature.spec.id}'s branch ${feature.branch}`);
				}
			}
			if (!conflicts.length && sync) {
				const baseTip = await git.resolveCommit(program.repoRoot, `refs/heads/${program.plan.base}`);
				if (baseTip && !await git.isAncestor(program.repoRoot, baseTip, await git.head(lead.path))) {
					conflicts = (await git.merge(lead.path, baseTip, `Merge ${program.plan.base} into ${lead.branch}`)).conflicts;
					merged.push(`${program.plan.base} at ${baseTip.slice(0, 9)}`);
				}
			}
			const head = await git.head(lead.path);
			const then = feature ? `finish ${feature.spec.id} there (its contract: program_status), then lead_submit with kind "implement" and feature "${feature.spec.id}"` : sync ? 'lead_submit with kind "resolve"' : program.scaffoldMerged ? 'make your change, then lead_submit with kind "fix" (with the finding ids in resolves) or "resolve"' : 'write the scaffold, then lead_submit with kind "scaffold"';
			const text = conflicts.length
				? `Your worktree is ${lead.path} on ${lead.branch}. Merging ${merged.length ? merged.join(' and ') : 'into it'} left conflicts in: ${conflicts.join(', ')}. Resolve every conflict marker there, then ${feature ? `finish ${feature.spec.id} and lead_submit with kind "implement"` : 'lead_submit with kind "resolve"'}. Facade commits the merge for you.`
				: `Your worktree is ${lead.path} on ${lead.branch}, at ${head.slice(0, 9)}${merged.length ? `; merged ${merged.join(' and ')}` : ''}. Enter it with EnterWorktree (path) if you have not, ${then}.`;
			return { text, data: { path: lead.path, branch: lead.branch, head, integrationTip: tip, conflicts } };
		});
	}

	/** Brings a worktree's branch up to `tip`: nothing, a fast-forward, or a merge. Returns conflicts. */
	private async bringUpToDate(worktree: string, tip: string, message: string): Promise<string[]> {
		const git = this.options.git;
		const head = await git.head(worktree);
		if (await git.isAncestor(worktree, tip, head)) {
			return [];
		}
		if (await git.isAncestor(worktree, head, tip)) {
			await git.fastForward(worktree, tip);
			return [];
		}
		return (await git.merge(worktree, tip, message)).conflicts;
	}

	/**
	 * The lead's change goes through the merge queue like a worker's (invariants I1, I2 and I6): the
	 * call returns once it is merged, or once the queue says why it is not.
	 */
	private async leadSubmit(input: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		this.requireApproved(program);
		const kind = input.kind as LeadSubmitKind;
		if (!['scaffold', 'fix', 'resolve', 'implement'].includes(kind)) {
			throw new ToolError('BAD_INPUT', 'kind must be "scaffold", "fix", "resolve" or "implement".');
		}
		const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim() : undefined;
		if (!message) {
			throw new ToolError('BAD_INPUT', 'lead_submit needs a commit message.');
		}
		if (!program.lead) {
			throw new ToolError('NO_WORKSPACE', 'Call lead_workspace first.');
		}
		if (kind === 'scaffold' && program.scaffoldMerged) {
			throw new ToolError('CONFLICT', 'The scaffold is already merged. Submit later changes with kind "fix" or "resolve".');
		}
		const resolves = Array.isArray(input.resolves) ? [...new Set((input.resolves as unknown[]).filter((id): id is string => typeof id === 'string'))] : [];
		for (const id of resolves) {
			const finding = program.findings.get(id);
			if (!finding) {
				throw new ToolError('NOT_FOUND', `There is no finding ${id}.`);
			}
			if (finding.route !== 'lead' || finding.status !== 'fixing') {
				throw new ToolError('CONFLICT', `${id} is ${finding.status}${finding.route ? `, routed to ${finding.route}` : ''}. Route it to yourself with review_route first.`);
			}
		}
		const featureId = typeof input.feature === 'string' && input.feature ? input.feature : undefined;
		const feature = featureId !== undefined ? program.features.get(featureId) : undefined;
		if (kind === 'implement' && (!feature || feature.status !== 'needs_lead')) {
			throw new ToolError('BAD_INPUT', `kind "implement" needs the id of a feature that needs you${feature ? `; ${feature.spec.id} is ${feature.status}` : ''}.`);
		}
		const lead = program.lead;
		return this.mutex.run(`lead:${program.id}`, async () => {
			const git = this.options.git;
			// Conflicted files count as resolved once their markers are gone; Facade stages them.
			const unresolved = (await git.unmergedPaths(lead.path)).filter(file => hasConflictMarkers(path.join(lead.path, file)));
			if (unresolved.length) {
				throw new ToolError('CONFLICTS_LEFT', `Conflict markers are still in ${unresolved.join(', ')}. Resolve them, then call lead_submit again.`);
			}
			const trailers = [`Facade-Program: ${program.id}`, `Facade-Kind: ${kind}`, ...(feature ? [`Facade-Feature: ${feature.spec.id}`] : []), ...(resolves.length ? [`Facade-Resolves: ${resolves.join(', ')}`] : [])];
			const commit = await git.commitAll(lead.path, `${message}\n\n${trailers.join('\n')}`);
			const tip = program.integrationTip!;
			if (await git.isAncestor(program.repoRoot, commit, tip)) {
				throw new ToolError('NOTHING_TO_SUBMIT', 'Your worktree has nothing the integration branch lacks.');
			}
			const notes = await this.busyFeatureNotes(program, commit);
			const item: QueueItem = { id: `lead-${program.seq + 1}`, kind: 'lead', commit, title: message.split('\n')[0], leadKind: kind, resolves: resolves.length ? resolves : undefined, feature: feature?.spec.id, at: this.now() };
			this.append(log, { type: 'lead.submitted', item });
			this.pumpQueue(program.id);
			const outcome = await this.awaitItem(log, item.id, signal, progress);
			const lines: string[] = [];
			let status: string;
			switch (outcome.type) {
				case 'queue.merged': {
					status = 'merged';
					lines.push(`Merged into ${program.integrationBranch} as ${outcome.commit.slice(0, 9)}; the fast checks passed on it.`, renderChecks(outcome.checks));
					lines.push(`Like every merge it needs a review: start facade-reviewer in the background with the packet ${outcome.packet ?? `from review_packet target "${outcome.commit}"`}.`);
					if (kind === 'scaffold') {
						lines.push(`Next: ${program.status === 'running' ? 'await_events' : 'program_start'}.`);
					}
					break;
				}
				case 'queue.checks_failed': {
					status = 'checks_failed';
					const failed = outcome.checks.runs.find(run => run.status !== 'pass');
					lines.push(`The fast checks failed on your change merged with the integration branch (${failedCheckSummary(outcome.checks)}); the branch did not move.`, renderChecks(outcome.checks), '', 'Last output:', failed?.tail ?? '', '', 'Fix it in your worktree and call lead_submit again.');
					break;
				}
				case 'queue.conflict':
					status = 'conflict';
					lines.push(`Your change conflicts with the integration branch in: ${outcome.paths.join(', ')}. Call lead_workspace: it merges the branch into your worktree. Resolve the conflicts there, then lead_submit again.`);
					break;
				default:
					status = 'dropped';
					lines.push(`Nothing was merged: ${(outcome as Extract<ProgramEvent, { type: 'queue.dropped' }>).reason}.`);
			}
			lines.push(...notes);
			return { text: lines.join('\n'), data: { status, commit, item: item.id, ...(outcome.type === 'queue.merged' ? { mergedAs: outcome.commit, packet: outcome.packet } : {}) } };
		});
	}

	/** Warns the lead when its change touches files of a feature a worker is changing right now. */
	private async busyFeatureNotes(program: ProgramState, commit: string): Promise<string[]> {
		const git = this.options.git;
		const base = await git.mergeBase(program.repoRoot, program.integrationTip!, commit);
		const changed = base ? await git.diffNames(program.repoRoot, base, commit) : [];
		const busy = new Map<string, string[]>();
		for (const file of changed) {
			const owner = ownerOf(program, file);
			if (owner && ['pending', 'running', 'verifying', 'verified'].includes(owner.status) && owner.attempts > 0) {
				busy.set(owner.spec.id, [...(busy.get(owner.spec.id) ?? []), file]);
			}
		}
		return [...busy].map(([id, files]) => `Note: ${id} is being worked on and your change touches its files (${files.join(', ')}). Facade merges your change into its branch before its next attempt; its worker may have to resolve a conflict.`);
	}

	/** Waits for the event that ends a queue item. */
	private async awaitItem(log: ProgramLog, itemId: string, signal: AbortSignal, progress: (message: string) => void): Promise<Extract<ProgramEvent, { type: 'queue.merged' | 'queue.checks_failed' | 'queue.conflict' | 'queue.dropped' }>> {
		for (; ;) {
			const outcome = log.eventsAfter(0).slice().reverse().find(event => ITEM_OUTCOMES.has(event.type) && (event as { itemId?: string }).itemId === itemId);
			if (outcome) {
				return outcome as Extract<ProgramEvent, { type: 'queue.merged' | 'queue.checks_failed' | 'queue.conflict' | 'queue.dropped' }>;
			}
			if (this.disposed) {
				throw new CancelledError();
			}
			const program = log.state;
			if (program.queueHalted) {
				throw new ToolError('HALTED', `The merge queue stopped: ${program.queueHalted}. Your change stays queued as ${itemId} and merges once the user resumes the program in Facade; await_events tells you.`);
			}
			const ahead = program.queue.findIndex(item => item.id === itemId);
			progress(program.queueHalted ? `The merge queue is halted: ${program.queueHalted}` : ahead > 0 ? `Waiting in the merge queue behind ${ahead} change${ahead === 1 ? '' : 's'}` : 'Merging and running the fast checks');
			await this.waitForChange(program.id, PROGRESS_INTERVAL_MS, signal);
		}
	}

	private async programStart(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		if (program.status === 'running') {
			return { text: `Program ${program.id} is already running. Call await_events with cursor ${program.seq}.`, data: { status: program.status, cursor: program.seq } };
		}
		this.requireApproved(program);
		if (program.status !== 'approved') {
			throw new ToolError('CONFLICT', `Program ${program.id} is ${program.status}.`);
		}
		if (program.plan.scaffold.paths.length && !program.scaffoldMerged) {
			throw new ToolError('NO_SCAFFOLD', 'The plan has a scaffold that is not merged yet: lead_workspace, write it, lead_submit with kind "scaffold".');
		}
		this.append(log, { type: 'program.started' });
		await this.schedule(program.id);
		const started = [...program.features.values()].filter(feature => holdsSlot(feature.status)).map(feature => feature.spec.id);
		const waiting = [...program.features.values()].filter(feature => feature.status === 'pending').map(feature => feature.spec.id);
		return { text: `Program ${program.id} started. Working: ${started.join(', ') || 'none yet'}. Waiting for a slot or a dependency: ${waiting.join(', ') || 'none'}. Now call await_events with cursor ${program.seq}.`, data: { started, waiting, cursor: program.seq } };
	}

	private async awaitEvents(input: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const cursor = typeof input.cursor === 'number' && input.cursor >= 0 ? Math.floor(input.cursor) : 0;
		const timeoutMs = (typeof input.timeout_sec === 'number' ? Math.min(600, Math.max(1, input.timeout_sec)) : DEFAULT_AWAIT_SEC) * 1000;
		const deadline = this.now() + timeoutMs;
		const relevant = () => log.eventsAfter(cursor).filter(event => LEAD_EVENTS.has(event.type)).map(event => ({ event, text: renderEvent(event, log.state) })).filter(item => item.text !== undefined);
		let found = relevant();
		while (!found.length && this.now() < deadline && !this.disposed) {
			await this.waitForChange(log.state.id, Math.min(PROGRESS_INTERVAL_MS, deadline - this.now()), signal);
			found = relevant();
			if (!found.length) {
				progress(this.statusLine(log.state));
			}
		}
		const program = log.state;
		const lines = found.length ? [`${found.length} event${found.length === 1 ? '' : 's'}:`, ...found.map(item => `- ${item.text}`)] : ['No events yet.'];
		lines.push(this.statusLine(program), `Next: ${nextStep(program)} Cursor ${program.seq}.`);
		return {
			text: lines.join('\n'),
			data: { events: found.map(item => ({ seq: item.event.seq, type: item.event.type, text: item.text })), cursor: program.seq, timedOut: !found.length, status: program.status }
		};
	}

	private async programStatus(input: Record<string, unknown>, cwd: string | undefined): Promise<McpToolResult> {
		if (typeof input.program_id === 'string') {
			const log = this.program(input.program_id);
			return renderDigest(log.state, feature => this.ladder(log.state, feature));
		}
		const repoRoot = cwd ? await this.repositoryOf(cwd).catch(() => undefined) : undefined;
		const programs = [...this.programs.values()].map(log => log.state).filter(program => !repoRoot || program.repoRoot === repoRoot).sort((a, b) => b.updatedAt - a.updatedAt);
		if (!programs.length) {
			return { text: 'No programs in this repository. Plan one with plan_save.', data: { programs: [] } };
		}
		return {
			text: ['Programs, newest first:', ...programs.map(program => `- ${program.id} · ${program.status} · ${program.plan.goal.split('\n')[0].slice(0, 120)}`), 'Call program_status with a program_id for its details.'].join('\n'),
			data: { programs: programs.map(program => ({ id: program.id, status: program.status, goal: program.plan.goal, updatedAt: program.updatedAt })) }
		};
	}

	private answer(input: Record<string, unknown>): McpToolResult {
		const log = this.program(input.program_id);
		const question = log.state.questions.get(String(input.question_id));
		if (!question) {
			throw new ToolError('NOT_FOUND', `There is no question ${String(input.question_id)} in program ${log.state.id}.`);
		}
		const text = typeof input.text === 'string' ? input.text.trim() : '';
		if (!text) {
			throw new ToolError('BAD_INPUT', 'The answer is empty.');
		}
		if (question.answer === undefined) {
			this.append(log, { type: 'feature.answered', questionId: question.id, answer: text, by: 'lead' });
		}
		return { text: question.answeredBy === 'timeout' ? `${question.id} had already timed out; the worker went on with its own assumption.` : `Answered ${question.id}; ${question.feature} continues.`, data: { question: question.id, answeredBy: question.answeredBy } };
	}

	private async featureUpdate(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		const feature = program.features.get(String(input.feature_id));
		if (!feature) {
			throw new ToolError('NOT_FOUND', `Program ${program.id} has no feature ${String(input.feature_id)}.`);
		}
		const id = feature.spec.id;
		if (feature.status === 'merged' || feature.status === 'abandoned') {
			throw new ToolError('CONFLICT', `${id} is ${feature.status}.${feature.status === 'merged' ? ' To change it, record a finding and route it.' : ''}`);
		}
		switch (input.op) {
			case 'retry':
				this.stopWorker(log, feature, 'retried by the lead');
				this.append(log, { type: 'feature.retry', feature: id });
				break;
			case 'reassign': {
				const ladder = Array.isArray(input.ladder) ? (input.ladder as unknown[]).filter((rung): rung is string => typeof rung === 'string' && rung.trim().length > 0) : [];
				const unknown = ladder.map(parseRung).filter(rung => rung.id !== LEAD_RUNG && !this.options.catalog().known.has(rung.id));
				if (!ladder.length || unknown.length) {
					throw new ToolError('BAD_INPUT', `reassign needs a ladder of known agents (${[...this.options.catalog().known].join(', ')}, lead).`);
				}
				this.stopWorker(log, feature, 'reassigned by the lead');
				this.append(log, { type: 'feature.reassigned', feature: id, ladder });
				break;
			}
			case 'abandon':
				this.stopWorker(log, feature, 'abandoned by the lead');
				this.append(log, { type: 'feature.abandoned', feature: id });
				this.pumpQueue(program.id);
				break;
			default:
				throw new ToolError('BAD_INPUT', 'op must be retry, reassign or abandon.');
		}
		await this.schedule(program.id);
		return { text: `${id} is now ${feature.status}.`, data: { feature: id, status: feature.status } };
	}

	private async programControl(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		if (input.op === 'pause') {
			if (program.status === 'running') {
				this.append(log, { type: 'program.paused', reason: 'paused by the lead' });
			}
		} else if (input.op === 'resume') {
			if (program.status === 'paused') {
				if (program.queueHalted) {
					throw new ToolError('HALTED', `The merge queue halted (${program.queueHalted}). Only the user can resume the program, in Facade, once that is sorted out.`);
				}
				this.append(log, { type: 'program.resumed' });
				await this.schedule(program.id);
			}
		} else {
			throw new ToolError('BAD_INPUT', 'op must be pause or resume.');
		}
		return { text: `Program ${program.id} is ${program.status}.`, data: { status: program.status } };
	}

	/*
	 * Review (design doc section 9)
	 */

	private async reviewPacket(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		const target = typeof input.target === 'string' ? input.target.trim() : '';
		if (target === 'integration') {
			if (!program.integrationTip || !program.baseCommit) {
				throw new ToolError('NOT_READY', 'Nothing is merged yet.');
			}
			const file = path.join(this.reviewDir(program.id), `integration-${program.integrationTip.slice(0, 12)}.md`);
			const stats = await writeIntegrationPacket(this.options.git, program, file);
			return { text: `The integration packet is ${file}: ${stats.files} files changed since ${program.plan.base}, +${stats.added} -${stats.removed}. Read it, starting with the hotspots, then record your review with review_record target "integration".`, data: { ...stats } };
		}
		const record = this.findMerge(program, target);
		if (!record) {
			throw new ToolError('NOT_FOUND', `No merge matches "${target}". Merges: ${program.merges.map(merge => `${merge.commit.slice(0, 9)} (${merge.item.id})`).join(', ') || 'none yet'}.`);
		}
		const file = record.packet && fs.existsSync(record.packet) ? record.packet : path.join(this.reviewDir(program.id), `${record.commit.slice(0, 12)}.md`);
		const stats = await writeMergePacket(this.options.git, program, record, file);
		return { text: `The packet for ${record.item.id}, merged as ${record.commit.slice(0, 9)}, is ${file}: ${stats.files} files, +${stats.added} -${stats.removed}. Give its path to facade-reviewer; do not read the diff yourself.`, data: { ...stats, merge: record.commit } };
	}

	private reviewRecord(input: Record<string, unknown>): McpToolResult {
		const log = this.program(input.program_id);
		const program = log.state;
		const target = typeof input.target === 'string' ? input.target.trim() : '';
		const record = target === 'integration' ? undefined : this.findMerge(program, target);
		if (target !== 'integration' && !record) {
			throw new ToolError('NOT_FOUND', `No merge matches "${target}". Use the commit from the packet, or "integration".`);
		}
		const merge = record?.commit ?? 'integration';
		const problems: string[] = [];
		const findings = Array.isArray(input.findings) ? input.findings as Record<string, unknown>[] : [];
		const parsed = findings.map((raw, index) => {
			const severity = raw?.severity as Finding['severity'];
			const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 200) : '';
			const detail = typeof raw?.detail === 'string' ? raw.detail.trim().slice(0, 4000) : '';
			if (!SEVERITIES.includes(severity)) {
				problems.push(`findings[${index}]: severity must be one of ${SEVERITIES.join(', ')}.`);
			}
			if (!title || !detail) {
				problems.push(`findings[${index}]: needs a title and a detail.`);
			}
			const file = typeof raw?.path === 'string' && raw.path.trim() ? normalizePath(raw.path.trim()) : undefined;
			const line = typeof raw?.line === 'number' && raw.line > 0 ? Math.floor(raw.line) : undefined;
			const paths: FindingLocation[] = file ? [{ path: file, line }] : [];
			return { severity, title, detail, paths, suggestion: typeof raw?.suggestion === 'string' && raw.suggestion.trim() ? raw.suggestion.trim().slice(0, 2000) : undefined };
		});
		const claimed = new Set(record?.item.resolves ?? []);
		const marks = Array.isArray(input.addressed) ? input.addressed as Record<string, unknown>[] : [];
		const addressed = marks.map(mark => ({ id: String(mark?.id ?? ''), addressed: mark?.status === 'addressed', note: typeof mark?.note === 'string' ? mark.note.slice(0, 1000) : undefined }));
		for (const mark of addressed) {
			if (!claimed.has(mark.id)) {
				problems.push(`addressed: ${mark.id} is not one of the findings this change says it fixes (${[...claimed].join(', ') || 'none'}).`);
			}
		}
		if (problems.length) {
			throw new ToolError('BAD_INPUT', `Nothing was recorded:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
		}
		const added: Finding[] = [];
		const duplicates: string[] = [];
		let next = program.findings.size + 1;
		for (const item of parsed) {
			const same = similarFinding([...program.findings.values(), ...added], merge, item.paths[0], item.title);
			if (same) {
				duplicates.push(`"${item.title}" is ${same.id}`);
				continue;
			}
			added.push({ id: `r${next++}`, merge, feature: featureOfFinding(program, record, item.paths), paths: item.paths, severity: item.severity, title: item.title, detail: item.detail, suggestion: item.suggestion, source: target === 'integration' ? 'lead' : 'reviewer', status: 'open', rounds: 0 });
		}
		const verdict = added.some(finding => finding.severity === 'blocker' || finding.severity === 'major') ? 'issues' : 'clean';
		this.append(log, { type: 'review.recorded', merge, verdict, added, addressed });
		const unmarked = [...claimed].filter(id => !addressed.some(mark => mark.id === id) && program.findings.get(id)?.status === 'fixed');
		const lines = [
			`Recorded the review of ${merge === 'integration' ? 'the whole program' : merge.slice(0, 9)}: ${added.length ? added.map(finding => `${finding.id} ${finding.severity}`).join(', ') : 'no new findings'}.`,
			...(duplicates.length ? [`Already recorded: ${duplicates.join('; ')}.`] : []),
			...(addressed.length ? [`Addressed: ${addressed.filter(mark => mark.addressed).map(mark => mark.id).join(', ') || 'none'}. Not addressed: ${addressed.filter(mark => !mark.addressed).map(mark => mark.id).join(', ') || 'none'}.`] : []),
			...(unmarked.length ? [`Still to mark: ${unmarked.join(', ')}.`] : [])
		];
		return { text: lines.join('\n'), data: { added: added.map(finding => finding.id), duplicates, verdict } };
	}

	private async reviewRoute(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		const raw = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : [];
		if (!raw.length) {
			throw new ToolError('BAD_INPUT', 'items lists the findings to route: [{ "id": "r1", "route": "worker" }].');
		}
		const items = raw.map(item => ({ id: String(item?.id ?? ''), route: item?.route as FindingRoute, ruling: typeof item?.ruling === 'string' && item.ruling.trim() ? item.ruling.trim().slice(0, 1000) : undefined }));
		const problems: string[] = [];
		const seen = new Set<string>();
		for (const item of items) {
			const finding = program.findings.get(item.id);
			if (!finding) {
				problems.push(`There is no finding ${item.id}.`);
				continue;
			}
			if (seen.has(item.id)) {
				problems.push(`${item.id} is listed twice.`);
			}
			seen.add(item.id);
			if (!['worker', 'lead', 'follow-up', 'wontfix'].includes(item.route)) {
				problems.push(`${item.id}: route must be worker, lead, follow-up or wontfix.`);
				continue;
			}
			const problem = routeProblem(program, finding, item.route, item.ruling);
			if (problem) {
				problems.push(problem);
			}
		}
		if (problems.length) {
			throw new ToolError('BAD_INPUT', `Nothing was routed:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
		}
		this.append(log, { type: 'findings.routed', items });
		// One fix attempt per feature for everything routed to its worker.
		const byFeature = new Map<string, string[]>();
		for (const item of items.filter(each => each.route === 'worker')) {
			const feature = program.findings.get(item.id)!.feature!;
			byFeature.set(feature, [...(byFeature.get(feature) ?? []), item.id]);
		}
		for (const [feature, findings] of byFeature) {
			this.append(log, { type: 'feature.fix_requested', feature, findings });
		}
		await this.schedule(program.id);
		const lines = [
			...[...byFeature].map(([feature, findings]) => `${findings.join(', ')} → ${feature}'s worker, one fix attempt; its merge comes back for a re-review.`),
			...items.filter(item => item.route === 'lead').map(item => `${item.id} → you: fix it in your worktree (lead_workspace), then lead_submit with kind "fix" and resolves ["${item.id}"].`),
			...items.filter(item => item.route === 'follow-up' || item.route === 'wontfix').map(item => `${item.id} → ${item.route}: ${item.ruling}`)
		];
		return { text: lines.join('\n'), data: { routed: items.map(item => item.id), fixes: Object.fromEntries(byFeature) } };
	}

	private reviewComplete(input: Record<string, unknown>): McpToolResult {
		const log = this.program(input.program_id);
		const program = log.state;
		const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 4000) : '';
		const problems = completionProblems(program);
		if (!summary) {
			problems.push('summary is empty: write what the program does and what the review found, for the merge message.');
		}
		if (problems.length) {
			return { text: `Not complete yet:\n${problems.map(problem => `- ${problem}`).join('\n')}`, data: { accepted: false, problems } };
		}
		this.append(log, { type: 'review.completed', tip: program.integrationTip!, summary });
		return { text: `Review complete at ${program.integrationTip!.slice(0, 9)}. Tell the user the program is ready and what is in it; they choose how it goes into ${program.plan.base}: merge, squash or pr. Then call ship with that mode.`, data: { accepted: true, tip: program.integrationTip } };
	}

	private findMerge(program: ProgramState, target: string): MergeRecord | undefined {
		if (!target) {
			return undefined;
		}
		const byCommit = program.merges.find(merge => target.length >= 7 && merge.commit.startsWith(target.toLowerCase()));
		if (byCommit) {
			return byCommit;
		}
		const byItem = program.merges.find(merge => merge.item.id === target);
		if (byItem) {
			return byItem;
		}
		// A feature's id names its latest merge.
		return program.merges.slice().reverse().find(merge => merge.item.feature === target);
	}

	/*
	 * Shipping (design doc section 10)
	 */

	private async ship(input: Record<string, unknown>): Promise<McpToolResult> {
		const log = this.program(input.program_id);
		const program = log.state;
		const mode = input.mode as ShipMode;
		if (!['merge', 'squash', 'pr'].includes(mode)) {
			throw new ToolError('BAD_INPUT', 'mode must be "merge", "squash" or "pr".');
		}
		const problems = shipProblems(program);
		if (problems.length) {
			throw new ToolError('NOT_READY', `Not ready to ship:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
		}
		const git = this.options.git;
		const tip = program.integrationTip!;
		const baseTip = await git.resolveCommit(program.repoRoot, `refs/heads/${program.plan.base}`);
		if (!baseTip) {
			throw new ToolError('NO_BASE', `The base branch ${program.plan.base} no longer exists.`);
		}
		if (!await git.isAncestor(program.repoRoot, baseTip, tip)) {
			// The base branch moved: it goes into the integration branch through the queue first (10.2).
			const merged = await git.mergeTree(program.repoRoot, tip, baseTip);
			if (merged.conflicts.length) {
				throw new ToolError('BASE_CONFLICTS', `${program.plan.base} moved and conflicts with the integration branch in ${merged.conflicts.join(', ')}. Call lead_workspace with sync true, resolve the conflicts, lead_submit with kind "resolve", have that merge reviewed, call review_complete again, then ship.`);
			}
			if (!program.queue.some(item => item.kind === 'sync')) {
				this.append(log, { type: 'sync.enqueued', item: { id: `sync-${program.seq + 1}`, kind: 'sync', commit: baseTip, title: `Merge ${program.plan.base}`, at: this.now() } });
				this.pumpQueue(program.id);
			}
			return { text: `${program.plan.base} moved since the program started. Facade is merging it into the integration branch through the queue. Then: have that merge reviewed (its packet comes with the queue.merged event), wait for the full checks, call review_complete again, and call ship again.`, data: { status: 'syncing' } };
		}
		if (mode === 'pr') {
			if (!which('gh', this.options.env)) {
				throw new ToolError('NO_GH', 'Shipping as a pull request needs the GitHub CLI, gh, on PATH.');
			}
			if (!await git.remoteFor(program.repoRoot, program.plan.base)) {
				throw new ToolError('NO_REMOTE', 'Shipping as a pull request needs a remote to push the integration branch to; the repository has none.');
			}
		} else {
			const holder = await git.branchCheckedOutAt(program.repoRoot, program.plan.base);
			const dirty = holder ? await git.isDirty(holder) : [];
			if (dirty.length) {
				throw new ToolError('DIRTY', `${program.plan.base} is checked out in ${holder} with uncommitted changes (${dirty.slice(0, 5).join(', ')}). Ask the user to commit or stash them there, or ship with mode "pr".`);
			}
		}
		this.append(log, { type: 'ship.requested', mode, tip });
		fs.mkdirSync(path.join(this.options.storageDir, program.id), { recursive: true });
		fs.writeFileSync(this.shipMessageFile(program.id), shipMessage(program, mode));
		this.options.ui.shipRequested(program);
		return { text: `Shipping by ${mode} waits for the user's approval in Facade; you cannot approve it yourself. The result arrives as ship.done or ship.failed from await_events (cursor ${program.seq}).`, data: { status: 'awaiting_approval', cursor: program.seq } };
	}

	/** The merge message the person reads before approving; written when the lead asks to ship. */
	shipMessage(programId: string): string {
		const program = this.program(programId).state;
		try {
			return fs.readFileSync(this.shipMessageFile(programId), 'utf8');
		} catch {
			return shipMessage(program, program.ship?.mode ?? 'merge');
		}
	}

	approveShip(programId: string): void {
		const log = this.program(programId);
		const program = log.state;
		if (program.ship?.status !== 'awaiting_approval') {
			throw new ToolError('CONFLICT', `Program ${programId} is not waiting to ship.`);
		}
		this.append(log, { type: 'ship.approved' });
		void this.executeShip(log);
	}

	cancelShip(programId: string, reason: string): void {
		const log = this.program(programId);
		if (log.state.ship?.status === 'awaiting_approval') {
			this.append(log, { type: 'ship.cancelled', reason: reason.trim() || 'the user did not approve it' });
		}
	}

	private async executeShip(log: ProgramLog): Promise<void> {
		const program = log.state;
		const ship = program.ship!;
		try {
			if (program.integrationTip !== ship.tip || program.reviewCompleted?.tip !== ship.tip) {
				throw new ShipError('The integration branch moved after shipping was requested; review the new merges, then ship again.');
			}
			const message = this.shipMessage(program.id);
			const result = await shipToBase({
				git: this.options.git,
				run: async (argv, cwd) => {
					const tail = new OutputTail(200);
					const run = await runProcess(argv, { cwd, env: this.options.env, timeoutMs: 120_000, onOutput: chunk => tail.push(chunk) });
					return { exitCode: run.spawnError ? null : run.exitCode, output: run.spawnError ?? tail.toString() };
				}
			}, program, ship.mode, message);
			for (const feature of program.features.values()) {
				this.stopWorker(log, feature, 'the program shipped');
			}
			const { removed, kept } = await cleanup(this.options.git, program, this.cleanupPlan(log, ship.mode));
			this.removeHookLaunchers(program.id);
			this.append(log, { type: 'ship.done', mode: ship.mode, commit: result.commit, url: result.url, removed, kept });
		} catch (err) {
			this.options.log(`[engine] shipping ${program.id} failed: ${(err as Error).stack ?? err}`);
			this.append(log, { type: 'ship.failed', reason: err instanceof ShipError ? err.message : `git failed: ${(err as Error).message}` });
		}
	}

	private removeHookLaunchers(programId: string): void {
		try {
			for (const file of fs.readdirSync(this.hooksDir()).filter(name => name.startsWith(`${programId}-`))) {
				fs.rmSync(path.join(this.hooksDir(), file), { force: true });
			}
		} catch {
			// No launchers were written.
		}
	}

	/** Every worktree and branch the log says Facade made for this program, and the files it wrote into them. */
	private cleanupPlan(log: ProgramLog, mode: ShipMode): CleanupPlan {
		const worktrees = new Set<string>();
		const branches = new Set<string>();
		const injected = new Map<string, Set<string>>();
		for (const event of log.eventsAfter(0)) {
			if (event.type === 'feature.started') {
				worktrees.add(event.worktree);
				branches.add(event.branch);
				const files = injected.get(event.worktree) ?? new Set<string>();
				event.injected?.forEach(file => files.add(file));
				injected.set(event.worktree, files);
			} else if (event.type === 'lead.workspace') {
				worktrees.add(event.path);
				branches.add(event.branch);
			} else if (event.type === 'integration.worktree') {
				worktrees.add(event.path);
				branches.add(event.branch);
			}
		}
		return { worktrees: [...worktrees], branches: [...branches], deleteIntegration: mode === 'merge', injected: new Map([...injected].map(([worktree, files]) => [worktree, [...files]])) };
	}

	/*
	 * Worker tools
	 */

	private getContract(principal: Extract<Principal, { role: 'worker' }>): McpToolResult {
		const { program, feature } = this.workerContext(principal);
		return renderContract(program, feature);
	}

	private reportProgress(principal: Extract<Principal, { role: 'worker' }>, input: Record<string, unknown>): McpToolResult {
		const { log, feature } = this.workerContext(principal);
		const steps: ProgressStep[] = Array.isArray(input.steps) ? (input.steps as { title?: unknown; status?: unknown }[]).filter(step => typeof step?.title === 'string').slice(0, 30).map(step => ({ title: String(step.title).slice(0, 200), status: step.status === 'done' || step.status === 'active' ? step.status : 'pending' })) : [];
		const note = typeof input.note === 'string' ? input.note.slice(0, 500) : undefined;
		this.append(log, { type: 'feature.progress', feature: feature.spec.id, attempt: principal.attempt, steps, note });
		return { text: 'Noted. No messages from the lead.', data: { messages: [] } };
	}

	private async askLead(principal: Extract<Principal, { role: 'worker' }>, input: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		const { log, feature } = this.workerContext(principal);
		const program = log.state;
		let questionId = typeof input.question_id === 'string' ? input.question_id : undefined;
		if (!questionId) {
			const text = typeof input.question === 'string' ? input.question.trim() : '';
			if (!text) {
				throw new ToolError('BAD_INPUT', 'ask_lead needs a question.');
			}
			const open = feature.openQuestion ? program.questions.get(feature.openQuestion) : undefined;
			if (open && open.question === text) {
				// The same question again, after a reload cut the first call: keep waiting on it.
				questionId = open.id;
			} else {
				questionId = `q-${program.questions.size + 1}`;
				const options = Array.isArray(input.options) ? (input.options as unknown[]).filter((option): option is string => typeof option === 'string').slice(0, 10) : undefined;
				this.append(log, { type: 'feature.question', feature: feature.spec.id, attempt: principal.attempt, questionId, question: text.slice(0, 2000), options });
			}
		}
		const question = program.questions.get(questionId);
		if (!question || question.feature !== feature.spec.id) {
			throw new ToolError('NOT_FOUND', `You have no question ${questionId}.`);
		}
		const waitMs = (typeof input.wait_sec === 'number' ? Math.min(600, Math.max(1, input.wait_sec)) : DEFAULT_ASK_WAIT_SEC) * 1000;
		const deadline = this.now() + waitMs;
		const timeoutAt = question.askedAt + (this.options.questionTimeoutMs ?? 10 * 60_000);
		while (question.answer === undefined && this.now() < deadline && !this.disposed) {
			if (this.now() >= timeoutAt) {
				this.append(log, { type: 'feature.answered', questionId, answer: 'No answer came in time. Choose the most reasonable option, go on, and list your choice under assumptions in submit_result.', by: 'timeout' });
				break;
			}
			try {
				await this.waitForChange(program.id, Math.min(PROGRESS_INTERVAL_MS, deadline - this.now(), Math.max(1, timeoutAt - this.now())), signal);
			} catch (err) {
				if (err instanceof CancelledError) {
					throw err;
				}
			}
			this.touch(principal);
			if (question.answer === undefined) {
				progress(`Waiting for the lead to answer ${questionId}`);
			}
		}
		if (question.answer === undefined) {
			return { text: `pending: ${questionId} has no answer yet. Call ask_lead with question_id "${questionId}" to keep waiting.`, data: { status: 'pending', question_id: questionId } };
		}
		if (question.answeredBy === 'timeout') {
			return { text: `timeout: ${question.answer}`, data: { status: 'timeout', question_id: questionId } };
		}
		return { text: `The lead answered ${questionId}: ${question.answer}`, data: { status: 'answered', question_id: questionId, answer: question.answer } };
	}

	/**
	 * What an agent's own hooks report (step 25). A Stop hook sends a worker that has not submitted
	 * back to work, twice at most; a notification says the agent waits for the person.
	 */
	private workerHook(principal: Extract<Principal, { role: 'worker' }>, input: Record<string, unknown>): McpToolResult {
		const { log, feature } = this.workerContext(principal);
		const key = attemptKey(principal.programId, principal.featureId, principal.attempt);
		const event = String(input.event ?? '');
		if (event === 'stop' || event === 'agy-stop') {
			if (typeof input.transcript_path === 'string' && input.transcript_path) {
				this.transcripts.set(key, input.transcript_path);
			}
			const keepGoing = feature.status === 'running' && !feature.openQuestion && (this.stopBlocks.get(key) ?? 0) < MAX_STOP_BLOCKS;
			if (keepGoing) {
				this.stopBlocks.set(key, (this.stopBlocks.get(key) ?? 0) + 1);
				const reason = 'You have not called submit_result yet. Finish the task and call the facade tool submit_result; if a decision blocks you, call ask_lead.';
				return { text: JSON.stringify(event === 'stop' ? { decision: 'block', reason } : { decision: 'continue', reason }) };
			}
			if (feature.status === 'running') {
				this.append(log, { type: 'feature.turn_ended', feature: feature.spec.id, attempt: principal.attempt });
			}
			return { text: event === 'stop' ? '{}' : JSON.stringify({ decision: 'stop' }) };
		}
		if (event === 'notification') {
			const type = String(input.type ?? '');
			const reason = type === 'permission_prompt' ? 'a permission prompt' : type === 'elicitation_dialog' ? 'a question in its terminal' : type === 'idle_prompt' ? 'it stopped and waits for input' : undefined;
			if (reason && feature.status === 'running' && feature.waiting !== reason) {
				this.append(log, { type: 'feature.waiting', feature: feature.spec.id, attempt: principal.attempt, reason });
			}
			return { text: '{}' };
		}
		throw new ToolError('BAD_INPUT', `Unknown hook event "${event}".`);
	}

	/**
	 * The worker's hand-in, checked while it waits: scope, a commit, the secret scan, then the
	 * acceptance commands. The verdict is the return value, so a worker fixes and resubmits in its
	 * own session and no one has to type into its terminal.
	 */
	private async submitResult(principal: Extract<Principal, { role: 'worker' }>, input: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		const { log, feature } = this.workerContext(principal);
		const id = feature.spec.id;
		if (feature.status === 'verifying') {
			throw new ToolError('BUSY', 'Your previous submission is still being checked.');
		}
		if (feature.status !== 'running') {
			return this.stopVerdict(`${id} is ${feature.status}; stop working on it.`);
		}
		const result = parseResult(input, feature.spec.acceptance.criteria.length);
		if (typeof result === 'string') {
			throw new ToolError('INVALID_RESULT', `${result} Fix the call and submit again.`);
		}
		this.append(log, { type: 'feature.submitted', feature: id, attempt: principal.attempt, result });
		if (result.outcome === 'blocked') {
			return this.afterFailure(log, feature, 'its worker reported it is blocked', principal);
		}
		try {
			return await this.verify(log, feature, principal, result, signal, progress);
		} catch (err) {
			// Whatever cut the check short was not the worker's doing: hand the feature back uncounted.
			// Read afresh: the checks above moved the status on since it was tested.
			if (statusOf(feature) === 'verifying' && feature.active?.attempt === principal.attempt) {
				this.append(log, { type: 'feature.reset', feature: id, attempt: principal.attempt, reason: err instanceof CancelledError ? 'the submission was cancelled' : (err as Error).message });
			}
			throw err;
		}
	}

	private async verify(log: ProgramLog, feature: FeatureState, principal: Extract<Principal, { role: 'worker' }>, result: WorkerResult, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
		const program = log.state;
		const id = feature.spec.id;
		const git = this.options.git;
		const worktree = feature.worktree!;
		const base = feature.base!;
		const injected = new Set(feature.injected ?? []);
		progress('Checking which files you changed');
		const changed = (await git.changedPaths(worktree, base)).filter(file => !injected.has(file));
		const outside = outsideOwnership(program, feature, changed);
		if (outside.length) {
			const detail = `you changed files you do not own: ${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ` and ${outside.length - 20} more` : ''}`;
			this.append(log, { type: 'feature.rejected', feature: id, attempt: principal.attempt, reason: 'out_of_scope', detail, paths: outside });
			return this.changesOrStop(log, feature, principal, `changes_required: ${detail}. Undo those changes (restore them to how they were at the start). If you need one of them changed, call ask_lead.`);
		}
		const merging = await git.mergeInProgress(worktree);
		if (!changed.length && !merging) {
			this.append(log, { type: 'feature.rejected', feature: id, attempt: principal.attempt, reason: 'no_changes', detail: 'nothing changed in the worktree' });
			return this.changesOrStop(log, feature, principal, 'changes_required: nothing in your worktree differs from where you started. Do the work, then submit.');
		}

		progress('Committing your changes');
		const agent = feature.active ? formatAgent(feature.active.agent) : 'unknown';
		const commit = await git.commitAll(worktree, `${feature.spec.title}\n\n${result.summary}\n\nFacade-Program: ${program.id}\nFacade-Feature: ${id}\nFacade-Agent: ${agent}\nFacade-Attempt: ${principal.attempt}`, [...injected]);
		const added = await git.addedLines(worktree, base, commit);
		const secrets = added.filter(line => SECRET_PATTERNS.some(pattern => pattern.test(line)));
		if (secrets.length) {
			this.append(log, { type: 'feature.rejected', feature: id, attempt: principal.attempt, reason: 'secret_added', detail: `${secrets.length} added line${secrets.length === 1 ? '' : 's'} look like credentials` });
			return this.changesOrStop(log, feature, principal, `changes_required: ${secrets.length} line${secrets.length === 1 ? '' : 's'} you added look like credentials or keys. Remove them; read secrets from the environment instead.`);
		}
		const markers = added.filter(line => CONFLICT_MARKER.test(line));
		if (markers.length) {
			this.append(log, { type: 'feature.rejected', feature: id, attempt: principal.attempt, reason: 'conflict_markers', detail: `${markers.length} conflict marker line${markers.length === 1 ? '' : 's'} left in` });
			return this.changesOrStop(log, feature, principal, 'changes_required: conflict markers (<<<<<<< or >>>>>>>) are still in your files. Resolve every conflict, keeping both sides\' behaviour, then submit.');
		}
		const flags = await this.testsWeakened(worktree, base, commit) ? ['tests_weakened'] : [];

		const checks = await this.runChecks(program, attemptCommands(program, feature), worktree, commit, path.join(this.runDir(program.id), id), signal, progress);
		if (signal.aborted) {
			throw new CancelledError();
		}
		this.append(log, { type: 'feature.checked', feature: id, attempt: principal.attempt, commit, checks });
		if (!checks.passed) {
			const failed = checks.runs.find(run => run.status !== 'pass');
			return this.changesOrStop(log, feature, principal, `changes_required: ${failedCheckSummary(checks)}.\n${renderChecks(checks)}\n\nLast output:\n${failed?.tail ?? ''}\n\nFix it and call submit_result again.`);
		}
		this.append(log, { type: 'feature.verified', feature: id, attempt: principal.attempt, commit, flags });
		this.pumpQueue(program.id);
		// A headless worker ends by itself once it read the verdict, and its last event carries its usage.
		if (this.options.settings().closeVerifiedWorkers && !feature.active?.headless) {
			this.stopLater(feature.active?.terminal);
		}
		void this.schedule(program.id);
		return {
			text: `verified: ${id} passed its checks at ${commit.slice(0, 9)}.\n${renderChecks(checks)}\nFacade merges it into the integration branch next. You are done. Stop working now.`,
			data: { status: 'verified', commit, checks }
		};
	}

	/** Whether test files that existed before lost cases or assertions: a note for the review, not a block. */
	private async testsWeakened(worktree: string, base: string, commit: string): Promise<boolean> {
		const git = this.options.git;
		for (const file of (await git.diffNames(worktree, base, commit)).filter(each => TEST_FILE.test(each))) {
			const before = await git.show(worktree, base, file);
			if (before === undefined) {
				continue;
			}
			const after = await git.show(worktree, commit, file) ?? '';
			const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
			if (count(after, TEST_CASE) < count(before, TEST_CASE) || count(after, ASSERTION) < count(before, ASSERTION)) {
				return true;
			}
		}
		return false;
	}

	/*
	 * Failures and the ladder
	 */

	private changesOrStop(log: ProgramLog, feature: FeatureState, principal: Extract<Principal, { role: 'worker' }>, message: string): McpToolResult {
		const retries = this.retries(log.state);
		if (feature.failuresOnRung <= retries) {
			return { text: `${message}\n(${retries - feature.failuresOnRung + 1} more submission${retries - feature.failuresOnRung + 1 === 1 ? '' : 's'} before another agent takes over.)`, data: { status: 'changes_required' } };
		}
		return this.afterFailure(log, feature, `failed ${feature.failuresOnRung} times on this agent`, principal);
	}

	/** Moves a feature up its ladder, or to the lead, and tells its worker to stop. */
	private afterFailure(log: ProgramLog, feature: FeatureState, reason: string, principal?: Extract<Principal, { role: 'worker' }>): McpToolResult {
		const ladder = this.ladder(log.state, feature);
		let next = feature.rung + 1;
		while (next < ladder.length && parseRung(ladder[next]).id !== LEAD_RUNG && !this.options.catalog().installed.has(parseRung(ladder[next]).id)) {
			next++;
		}
		const terminal = feature.active?.terminal;
		if (next >= ladder.length || parseRung(ladder[next]).id === LEAD_RUNG) {
			this.append(log, { type: 'feature.needs_lead', feature: feature.spec.id, reason: `${reason}; no agent left on its ladder` });
		} else {
			this.append(log, { type: 'feature.escalated', feature: feature.spec.id, fromRung: feature.rung, toRung: next, reason: `${reason}; ${ladder[next]} takes over` });
		}
		if (principal) {
			this.stopLater(terminal);
		}
		void this.schedule(log.state.id);
		return this.stopVerdict(`stop: ${reason}. Another agent or the lead takes this feature over. Stop working now.`);
	}

	private stopVerdict(text: string): McpToolResult {
		return { text, data: { status: 'stop' } };
	}

	/** Called when a worker's terminal or process ends. */
	workerExited(handle: string, exitCode?: number): void {
		if (this.disposed) {
			return;
		}
		for (const log of this.programs.values()) {
			for (const feature of log.state.features.values()) {
				if (feature.active?.terminal !== handle) {
					continue;
				}
				const attempt = feature.active.attempt;
				const wasWorking = feature.status === 'running' || feature.status === 'verifying';
				this.collectUsage(log, feature, attempt, feature.active.agent, !!feature.active.headless);
				this.append(log, { type: 'feature.ended', feature: feature.spec.id, attempt, reason: wasWorking ? 'exited' : 'finished', detail: exitCode !== undefined ? `exit code ${exitCode}` : undefined });
				if (wasWorking && log.state.status === 'running') {
					if (feature.failuresOnRung > this.retries(log.state)) {
						this.afterFailure(log, feature, 'its worker kept exiting before it was verified');
					} else {
						void this.schedule(log.state.id);
					}
				}
				return;
			}
		}
	}

	private stopWorker(log: ProgramLog, feature: FeatureState, reason: string): void {
		const active = feature.active;
		if (!active) {
			return;
		}
		this.collectUsage(log, feature, active.attempt, active.agent, !!active.headless);
		this.append(log, { type: 'feature.ended', feature: feature.spec.id, attempt: active.attempt, reason: 'stopped', detail: reason });
		if (active.terminal) {
			this.options.runner.stop(active.terminal);
		}
	}

	/** Stops a worker a few seconds from now, after it has read its verdict. */
	private stopLater(handle: string | undefined): void {
		if (!handle) {
			return;
		}
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			this.options.runner.stop(handle);
		}, 5000);
		this.timers.add(timer);
		timer.unref?.();
	}

	/** Records what an attempt spent, from its headless log or its transcript, once. */
	private collectUsage(log: ProgramLog, feature: FeatureState, attempt: number, agent: AgentRef, headless: boolean): void {
		const id = feature.spec.id;
		if (log.eventsAfter(0).some(event => event.type === 'feature.usage' && event.feature === id && event.attempt === attempt)) {
			return;
		}
		try {
			let usage;
			let source: string;
			if (headless) {
				const adapter = this.options.catalog().installed.get(agent.id)?.adapter;
				const file = this.outputLog(log.state.id, id, attempt);
				usage = adapter?.usage && fs.existsSync(file) ? adapter.usage(jsonLines(fs.readFileSync(file, 'utf8'))) : undefined;
				source = 'stream';
			} else {
				const transcript = this.transcripts.get(attemptKey(log.state.id, id, attempt));
				usage = transcript && fs.existsSync(transcript) ? claudeTranscriptUsage(fs.readFileSync(transcript, 'utf8')) : undefined;
				source = 'transcript';
			}
			if (usage) {
				this.append(log, { type: 'feature.usage', feature: id, attempt, agent, usage: withPrice(usage), source });
			}
		} catch (err) {
			this.options.log(`[engine] reading the usage of ${log.state.id}/${id} a${attempt} failed: ${(err as Error).message}`);
		}
	}

	/*
	 * The merge queue (design doc section 8)
	 */

	/** Starts draining the program's queue, unless it already is. */
	private pumpQueue(programId: string): void {
		if (this.disposed || this.draining.has(programId)) {
			return;
		}
		this.draining.add(programId);
		void this.track(this.drainQueue(programId))
			.catch(err => this.options.log(`[engine] the merge queue of ${programId} failed: ${(err as Error).stack ?? err}`))
			.finally(() => {
				this.draining.delete(programId);
				const program = this.programs.get(programId)?.state;
				// An item that arrived while the last one finished.
				if (program && program.queue.length && this.queueRuns(program)) {
					this.pumpQueue(programId);
				}
			});
	}

	private queueRuns(program: ProgramState): boolean {
		return !this.disposed && !program.queueHalted && program.integrationTip !== undefined && (program.status === 'approved' || program.status === 'running' || program.status === 'paused');
	}

	private async drainQueue(programId: string): Promise<void> {
		for (; ;) {
			const log = this.programs.get(programId);
			if (!log || !this.queueRuns(log.state)) {
				return;
			}
			const item = log.state.queue[0];
			if (!item) {
				await this.whenQueueEmpty(log);
				return;
			}
			await this.processItem(log, item);
		}
	}

	private async processItem(log: ProgramLog, item: QueueItem): Promise<void> {
		const program = log.state;
		const feature = item.feature !== undefined ? program.features.get(item.feature) : undefined;
		if (item.kind === 'feature' && (!feature || feature.status !== 'verified' || feature.verifiedCommit !== item.commit)) {
			this.append(log, { type: 'queue.dropped', itemId: item.id, reason: `${item.feature} is ${feature?.status ?? 'gone'} now` });
			return;
		}
		let outcome: MergeOutcome;
		try {
			outcome = await mergeItem({
				git: this.options.git,
				runChecks: (commands, worktree, commit, fresh) => this.runChecks(program, commands, worktree, commit, path.join(this.runDir(program.id), 'queue'), this.shutdown.signal, () => { }, fresh),
				integrationWorktree: () => this.integrationWorktree(log)
			}, program, item);
		} catch (err) {
			if (this.disposed) {
				return;
			}
			this.options.log(`[engine] merging ${program.id}/${item.id} failed: ${(err as Error).stack ?? err}`);
			this.haltQueue(log, `merging ${item.id} failed: ${(err as Error).message.split('\n')[0]}`);
			return;
		}
		if (this.disposed) {
			// Checks cut off by the window going away prove nothing; the item waits for the next start.
			return;
		}
		switch (outcome.kind) {
			case 'merged': {
				const packet = await this.writePacketQuietly(program, { commit: outcome.commit, parent: outcome.parent, item, checks: outcome.checks, flaky: outcome.flaky });
				this.append(log, { type: 'queue.merged', itemId: item.id, commit: outcome.commit, parent: outcome.parent, checks: outcome.checks, flaky: outcome.flaky.length ? outcome.flaky : undefined, packet });
				void this.schedule(program.id);
				break;
			}
			case 'already':
				this.append(log, { type: 'queue.dropped', itemId: item.id, reason: 'the integration branch already has this commit', alreadyIn: outcome.tip });
				break;
			case 'conflict':
				this.append(log, { type: 'queue.conflict', itemId: item.id, paths: outcome.paths, resolver: item.kind === 'feature' && feature ? conflictResolver(program, feature, outcome.paths) : 'lead' });
				void this.schedule(program.id);
				break;
			case 'checks_failed':
				this.append(log, { type: 'queue.checks_failed', itemId: item.id, candidate: outcome.candidate, checks: outcome.checks });
				void this.schedule(program.id);
				break;
			case 'moved':
				this.haltQueue(log, `the integration branch ${program.integrationBranch} moved outside Facade, to ${outcome.found?.slice(0, 9) ?? 'nothing'}`);
				break;
			case 'checked_out':
				this.haltQueue(log, `${program.integrationBranch} is checked out in ${outcome.path}; moving it would change the files there. Switch that worktree to another branch`);
				break;
		}
	}

	/** Stops the queue, and pauses a running program, until the person has looked. */
	private haltQueue(log: ProgramLog, reason: string): void {
		this.append(log, { type: 'queue.halted', reason });
		if (log.state.status === 'running') {
			this.append(log, { type: 'program.paused', reason: `the merge queue halted: ${reason}` });
		}
		this.options.ui.queueHalted(log.state, reason);
	}

	/** Once every feature is merged: announce it, and run the full checks on the tip. */
	private async whenQueueEmpty(log: ProgramLog): Promise<void> {
		const program = log.state;
		const features = [...program.features.values()];
		if (!features.length || !features.every(feature => feature.status === 'merged' || feature.status === 'abandoned') || !program.integrationTip) {
			return;
		}
		const tip = program.integrationTip;
		if (program.allMergedAt === undefined) {
			this.append(log, { type: 'program.all_merged', commit: tip });
		}
		if (program.fullChecks?.commit === tip) {
			return;
		}
		const worktree = await this.integrationWorktree(log);
		await this.options.git.checkoutDetached(worktree, tip);
		const checks = await this.runChecks(program, program.plan.checks.full, worktree, tip, path.join(this.runDir(program.id), 'full'), this.shutdown.signal, () => { }, false);
		if (log.state.integrationTip === tip && !this.disposed) {
			this.append(log, { type: 'checks.full', commit: tip, checks });
		}
	}

	private async integrationWorktree(log: ProgramLog): Promise<string> {
		const program = log.state;
		const git = this.options.git;
		if (program.integrationWorktree && await git.hasWorktree(program.repoRoot, program.integrationWorktree.path)) {
			return program.integrationWorktree.path;
		}
		const worktree = this.freePath(path.join(this.options.worktreesRoot, program.repoName, `${program.id}-int`));
		let branch = `facade/${program.id}/int`;
		if (await git.branchExists(program.repoRoot, branch)) {
			branch = `${branch}-${program.seq}`;
		}
		await this.options.worktrees.create(program.repoRoot, worktree, branch, program.integrationTip!);
		this.append(log, { type: 'integration.worktree', path: worktree, branch });
		return worktree;
	}

	/** Writes a merge's review packet; a packet that cannot be written is logged, not fatal. */
	private async writePacketQuietly(program: ProgramState, merge: MergeFacts): Promise<string | undefined> {
		const file = path.join(this.reviewDir(program.id), `${merge.commit.slice(0, 12)}.md`);
		try {
			return (await writeMergePacket(this.options.git, program, merge, file)).path;
		} catch (err) {
			this.options.log(`[engine] writing the review packet of ${merge.commit} failed: ${(err as Error).message}`);
			return undefined;
		}
	}

	/*
	 * Scheduling and launching
	 */

	/** Starts every feature that can start now. Safe to call at any time and any number of times. */
	private schedule(programId: string): Promise<void> {
		return this.mutex.run(`schedule:${programId}`, async () => {
			const log = this.programs.get(programId);
			if (!log || this.disposed || log.state.status !== 'running') {
				return;
			}
			const program = log.state;
			const catalog = this.options.catalog();
			for (const feature of program.features.values()) {
				if (feature.status !== 'pending') {
					continue;
				}
				// Skip rungs whose agent is not installed; a lead rung hands the feature back.
				const ladder = this.ladder(program, feature);
				const rung = ladder[feature.rung];
				if (rung === undefined || parseRung(rung).id === LEAD_RUNG) {
					this.append(log, { type: 'feature.needs_lead', feature: feature.spec.id, reason: rung === undefined ? 'its ladder is exhausted' : 'its ladder hands it to the lead' });
				} else if (!catalog.installed.has(parseRung(rung).id)) {
					this.afterFailure(log, feature, `${parseRung(rung).id} is not installed`);
				} else if (feature.failuresOnRung > this.retries(program)) {
					this.afterFailure(log, feature, `failed ${feature.failuresOnRung} times on ${rung}`);
				}
			}
			const settings = this.options.settings();
			const starts = pickStarts({
				features: [...program.features.values()].map((feature, order) => ({
					id: feature.spec.id,
					status: this.launching.has(`${programId}/${feature.spec.id}`) ? 'running' : feature.status,
					dependsOn: feature.spec.dependsOn ?? [],
					size: feature.spec.size,
					order,
					agent: this.ladder(program, feature)[feature.rung] === undefined ? undefined : parseRung(this.ladder(program, feature)[feature.rung]).id
				})),
				// A dependency counts once its work is on the integration branch.
				merged: new Set([...program.features.values()].filter(feature => feature.mergedCommit !== undefined).map(feature => feature.spec.id)),
				maxParallel: program.plan.policy?.maxParallel ?? settings.maxParallel,
				agentCaps: new Map(Object.entries(settings.agentConcurrency))
			});
			for (const featureId of starts) {
				const key = `${programId}/${featureId}`;
				this.launching.add(key);
				void this.track(this.launch(log, program.features.get(featureId)!)).finally(() => {
					this.launching.delete(key);
					// A launch that did not start a worker, such as an agent the person did not trust,
					// may have freed the slot for the feature's next agent.
					void this.schedule(programId);
				});
			}
		});
	}

	private async launch(log: ProgramLog, feature: FeatureState): Promise<void> {
		const program = log.state;
		const id = feature.spec.id;
		const agent: AgentRef = parseRung(this.ladder(program, feature)[feature.rung]);
		const installed = this.options.catalog().installed.get(agent.id);
		const attempt = feature.attempts + 1;
		try {
			if (!installed) {
				throw new Error(`${agent.id} is not installed`);
			}
			const adapter = installed.adapter;
			const trusted = await this.trusted(adapter);
			if (trusted === false) {
				this.afterFailure(log, feature, `the user did not let Facade start ${adapter.displayName} with trust in its worktrees`);
				return;
			}
			const place = await this.prepareWorktree(log, feature, attempt);
			if (!place) {
				return;
			}
			const settings = this.options.settings();
			const headless = settings.workerMode === 'headless' && adapter.headless;
			const runDir = this.runDir(program.id);
			fs.mkdirSync(runDir, { recursive: true });
			const token = newToken();
			const tokenFile = path.join(runDir, `${id}-a${attempt}.token`);
			fs.writeFileSync(tokenFile, token, { mode: 0o600 });
			const mcp: McpLaunch = { command: this.options.shim.command, args: [...this.options.shim.args, 'mcp', '--pipe', this.options.pipe, '--token-file', tokenFile], env: this.options.shim.env };
			const acceptance = attemptCommands(program, feature).map(cmd => cmd.argv);
			const spec = adapter.buildLaunch({
				agent,
				worktree: place.worktree,
				prompt: initialPrompt(program.id, feature),
				mcp,
				runDir,
				slug: `${id}-a${attempt}`,
				acceptance,
				headless,
				trusted,
				hookCommand: adapter.commandHooks ? this.hookCommand(program.id, id, attempt, tokenFile, acceptance) : undefined
			}, installed.executable);
			for (const file of spec.files) {
				fs.writeFileSync(file.path, file.content, { mode: 0o600 });
			}
			const injected = this.inject(place.worktree, spec);
			const tokenHash = hashToken(token);
			// Registered before the launch: the agent may call before `launch` returns.
			this.principals.set(tokenHash, { role: 'worker', programId: program.id, featureId: id, attempt });
			const name = `${adapter.displayName} · ${program.id} ${id} a${attempt}`;
			// The event goes first, so a tool call racing the launch finds the attempt active.
			this.append(log, { type: 'feature.started', feature: id, attempt, rung: feature.rung, agent, worktree: place.worktree, branch: place.branch, base: place.base, tokenHash, terminal: name, kind: feature.kind, injected, headless: headless || undefined });
			const request = headless ? this.headlessLaunch(spec, this.outputLog(program.id, id, attempt)) : spec;
			await this.options.runner.launch({ name, executable: request.executable, args: request.args, env: request.env, cwd: request.cwd, initialInput: spec.initialInput });
		} catch (err) {
			const detail = (err as Error).message;
			this.options.log(`[engine] launching ${program.id}/${id} failed: ${detail}`);
			if (feature.active?.attempt === attempt) {
				this.append(log, { type: 'feature.ended', feature: id, attempt, reason: 'launch_failed', detail });
			} else {
				this.append(log, { type: 'feature.launch_failed', feature: id, attempt, detail });
			}
			await sleep(1000);
			void this.schedule(program.id);
		}
	}

	/** Whether the person lets this agent trust Facade's worktrees; undefined when it does not ask. */
	private async trusted(adapter: AgentAdapter): Promise<boolean | undefined> {
		if (!adapter.trust) {
			return undefined;
		}
		if (!adapter.trust.flags?.length) {
			// It asks in its own terminal; the person only needs to know.
			if (!this.noticed.has(adapter.id)) {
				this.noticed.add(adapter.id);
				this.options.ui.notice(adapter.trust.detail);
			}
			return undefined;
		}
		return this.options.trust.decide(adapter.id, adapter.displayName, adapter.trust.detail);
	}

	/**
	 * The worktree an attempt runs in. A feature keeps its worktree across attempts; one that is
	 * gone is made again from its branch, so no work is lost. Before a resolve, regression or fix
	 * attempt, the integration branch is merged in: conflicts stay for the worker to resolve when
	 * they are in its own files, and go to the lead otherwise.
	 */
	private async prepareWorktree(log: ProgramLog, feature: FeatureState, attempt: number): Promise<{ worktree: string; branch: string; base: string } | undefined> {
		const program = log.state;
		const git = this.options.git;
		const id = feature.spec.id;
		const tip = program.integrationTip!;
		let worktree = feature.worktree;
		let branch = feature.branch;
		let base = feature.base;
		if (!worktree || !branch || !base || !await git.hasWorktree(program.repoRoot, worktree)) {
			const previous = branch ? await git.resolveCommit(program.repoRoot, `refs/heads/${branch}`) : undefined;
			const keepWork = previous !== undefined && !await git.isAncestor(program.repoRoot, previous, tip);
			branch = `facade/${program.id}/${id}${slug(feature.spec.title) ? `-${slug(feature.spec.title)}` : ''}`;
			if (await git.branchExists(program.repoRoot, branch)) {
				branch = `${branch}-${attempt}`;
			}
			worktree = this.freePath(path.join(this.options.worktreesRoot, program.repoName, `${program.id}-${id}`));
			await this.options.worktrees.create(program.repoRoot, worktree, branch, keepWork ? previous! : tip);
			base = keepWork && feature.base ? feature.base : tip;
		}
		if (feature.syncBeforeNext) {
			let conflicts: string[];
			if (await git.mergeInProgress(worktree)) {
				// A merge an earlier attempt did not finish.
				conflicts = await git.unmergedPaths(worktree);
			} else {
				const injected = feature.injected ?? [];
				if ((await git.changedPaths(worktree, 'HEAD')).some(file => !injected.includes(file))) {
					// Work an attempt left without submitting stays on the branch, rather than in the way of the merge.
					await git.commitAll(worktree, `Keep the unsubmitted work of ${id} before merging ${program.integrationBranch}\n\nFacade-Program: ${program.id}\nFacade-Feature: ${id}`, injected);
				}
				conflicts = await this.bringUpToDate(worktree, tip, `Merge ${program.integrationBranch} into ${branch}`);
			}
			const outside = outsideOwnership(program, feature, conflicts);
			if (outside.length) {
				await git.abortMerge(worktree);
				this.append(log, { type: 'feature.needs_lead', feature: id, reason: `merging the integration branch into it conflicts in files it does not own: ${outside.join(', ')}` });
				return undefined;
			}
			this.append(log, { type: 'feature.synced', feature: id, base: tip, conflicts });
			base = tip;
		}
		return { worktree, branch, base };
	}

	/** Writes the files an agent reads from its worktree; returns their paths for the injection list. */
	private inject(worktree: string, spec: LaunchSpec): string[] {
		const paths: string[] = [];
		for (const file of spec.injected ?? []) {
			const target = path.join(worktree, file.path);
			let content = file.content;
			if (file.path.endsWith('.json') && fs.existsSync(target)) {
				try {
					content = JSON.stringify(mergeJson(JSON.parse(fs.readFileSync(target, 'utf8')), JSON.parse(file.content)), undefined, '\t');
				} catch {
					// Not JSON: Facade's file replaces it in this worktree only.
				}
			}
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content, { mode: 0o600 });
			paths.push(normalizePath(file.path));
		}
		return paths;
	}

	/**
	 * A launcher for agents whose hooks can only run a command line: a script in `~/.facade/hooks`
	 * that runs the shim's hook handler for this attempt, with its policy file.
	 */
	private hookCommand(programId: string, featureId: string, attempt: number, tokenFile: string, acceptance: readonly (readonly string[])[]): string {
		const dir = this.hooksDir();
		fs.mkdirSync(dir, { recursive: true });
		const name = `${programId}-${featureId}-a${attempt}`;
		const policyFile = path.join(this.runDir(programId), `${name}.policy.json`);
		const policy: HookPolicy = { server: 'facade', allowCommands: commandPrefixes(acceptance), denyCommands: FORBIDDEN_COMMANDS };
		fs.mkdirSync(path.dirname(policyFile), { recursive: true });
		fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
		const shim = this.options.shim;
		const args = [...shim.args, 'hook', '--pipe', this.options.pipe, '--token-file', tokenFile, '--policy', policyFile];
		let script: string;
		let file: string;
		if (process.platform === 'win32') {
			file = path.join(dir, `${name}.cmd`);
			script = ['@echo off', ...Object.entries(shim.env).map(([key, value]) => `set "${key}=${value}"`), `"${shim.command}" ${args.map(arg => `"${arg}"`).join(' ')} %*`, ''].join('\r\n');
		} else {
			file = path.join(dir, `${name}.sh`);
			const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
			script = ['#!/bin/sh', `${Object.entries(shim.env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} exec ${[shim.command, ...args].map(quote).join(' ')} "$@"`, ''].join('\n');
		}
		fs.writeFileSync(file, script, { mode: 0o700 });
		const command = normalizePath(file);
		return /\s/.test(command) ? `"${command}"` : command;
	}

	/** Runs a headless agent under the shim, which logs its output for the usage and shows it. */
	private headlessLaunch(spec: LaunchSpec, logFile: string): LaunchSpec {
		return {
			...spec,
			executable: this.options.shim.command,
			args: [...this.options.shim.args, 'run', '--log', logFile, '--', spec.executable, ...spec.args],
			env: { ...this.options.shim.env, ...spec.env }
		};
	}

	/*
	 * Host actions: what the person decides in Facade
	 */

	approvePlan(programId: string): void {
		const log = this.program(programId);
		const program = log.state;
		if (program.status !== 'awaiting_approval') {
			throw new ToolError('CONFLICT', `Program ${programId} is ${program.status}.`);
		}
		this.options.commandApprovals.approve(program.repoRoot, program.newCommands);
		this.append(log, { type: 'plan.approved', approvedCommands: program.newCommands });
		void this.createIntegration(log);
	}

	private async createIntegration(log: ProgramLog): Promise<void> {
		const program = log.state;
		try {
			if (!await this.options.git.branchExists(program.repoRoot, program.integrationBranch!)) {
				await this.options.git.createBranch(program.repoRoot, program.integrationBranch!, program.baseCommit!);
			}
			const tip = await this.options.git.resolveCommit(program.repoRoot, `refs/heads/${program.integrationBranch}`);
			this.append(log, { type: 'integration.created', branch: program.integrationBranch!, commit: tip! });
		} catch (err) {
			this.options.log(`[engine] creating ${program.integrationBranch} failed: ${(err as Error).message}`);
			this.append(log, { type: 'program.paused', reason: `could not create ${program.integrationBranch}: ${(err as Error).message}` });
		}
	}

	requestChanges(programId: string, comment: string): void {
		const log = this.program(programId);
		if (log.state.status !== 'awaiting_approval') {
			throw new ToolError('CONFLICT', `Program ${programId} is ${log.state.status}.`);
		}
		this.append(log, { type: 'plan.changes_requested', comment: comment.trim() || 'No comment.' });
	}

	/** The person resumes a paused program or a halted queue; the integration branch is checked again first. */
	async resume(programId: string): Promise<void> {
		const log = this.program(programId);
		const halted = log.state.queueHalted;
		if (log.state.status === 'paused') {
			this.append(log, { type: 'program.resumed' });
		} else if (halted) {
			this.append(log, { type: 'queue.resumed' });
		} else {
			return;
		}
		if (halted) {
			await this.reconcileQueue(log);
		}
		this.pumpQueue(programId);
		await this.schedule(programId);
	}

	abort(programId: string): void {
		const log = this.program(programId);
		for (const feature of log.state.features.values()) {
			this.stopWorker(log, feature, 'the user stopped the program');
		}
		this.append(log, { type: 'program.aborted' });
	}

	programsState(): readonly ProgramState[] {
		return [...this.programs.values()].map(log => log.state);
	}

	getProgram(programId: string): ProgramState | undefined {
		return this.programs.get(programId)?.state;
	}

	digest(programId: string): string {
		const log = this.program(programId);
		return renderDigest(log.state, feature => this.ladder(log.state, feature)).text;
	}

	/*
	 * Helpers
	 */

	private append(log: ProgramLog, body: ProgramEventBody): ProgramEvent {
		const event = log.append(body);
		this.wake(log.state.id);
		this.options.ui.changed(log.state);
		return event;
	}

	private wake(programId: string): void {
		const listeners = this.listeners.get(programId);
		if (listeners) {
			this.listeners.delete(programId);
			for (const wake of listeners) {
				wake();
			}
		}
	}

	/** Resolves on the program's next event, after `ms`, or rejects when `signal` aborts. */
	private waitForChange(programId: string, ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new CancelledError());
				return;
			}
			const listeners = this.listeners.get(programId) ?? new Set<() => void>();
			this.listeners.set(programId, listeners);
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				listeners.delete(done);
				resolve();
			};
			const onAbort = () => {
				clearTimeout(timer);
				listeners.delete(done);
				reject(new CancelledError());
			};
			const timer = setTimeout(done, Math.max(0, ms));
			listeners.add(done);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private async runChecks(program: ProgramState, commands: readonly Cmd[], worktree: string, commit: string, logDir: string, signal: AbortSignal, progress: (message: string) => void, fresh = false): Promise<CheckSummary> {
		this.checks.setSlots(this.options.settings().checkSlots);
		const tree = await this.options.git.tree(worktree, commit);
		return this.checks.run({
			commands,
			worktree,
			tree,
			logDir,
			cached: cmd => fresh ? undefined : program.checkCache.get(checkCacheKey(tree, cmd)),
			signal,
			onProgress: progress
		});
	}

	private workerContext(principal: Extract<Principal, { role: 'worker' }>): { log: ProgramLog; program: ProgramState; feature: FeatureState } {
		const log = this.program(principal.programId);
		const feature = log.state.features.get(principal.featureId);
		if (!feature || feature.active?.attempt !== principal.attempt) {
			throw new ToolError('STALE', 'This attempt is over; another agent or the lead has the feature. Stop working.');
		}
		return { log, program: log.state, feature };
	}

	private touch(principal: Extract<Principal, { role: 'worker' }>): void {
		const key = attemptKey(principal.programId, principal.featureId, principal.attempt);
		this.activity.set(key, this.now());
		this.stalled.delete(key);
	}

	private checkStalls(): void {
		const limit = this.options.settings().stallMinutes * 60_000;
		for (const log of this.programs.values()) {
			if (log.state.status !== 'running') {
				continue;
			}
			for (const feature of log.state.features.values()) {
				const active = feature.active;
				if (!active || feature.status !== 'running' || feature.openQuestion) {
					continue;
				}
				const key = attemptKey(log.state.id, feature.spec.id, active.attempt);
				const last = Math.max(this.activity.get(key) ?? 0, feature.lastActivity ?? 0, active.startedAt);
				if (this.now() - last >= limit && !this.stalled.has(key)) {
					this.stalled.add(key);
					this.append(log, { type: 'feature.stalled', feature: feature.spec.id, attempt: active.attempt, idleMinutes: Math.round((this.now() - last) / 60_000) });
				}
			}
		}
	}

	private program(id: unknown): ProgramLog {
		const log = typeof id === 'string' ? this.programs.get(id) : undefined;
		if (!log) {
			throw new ToolError('NOT_FOUND', `There is no program ${String(id)}. program_status lists them.`);
		}
		return log;
	}

	private requireApproved(program: ProgramState): void {
		if (program.status === 'draft' || program.status === 'awaiting_approval') {
			throw new ToolError('NOT_APPROVED', `Program ${program.id} is ${program.status}: the user has not approved its plan.`);
		}
		if (program.status === 'aborted' || program.status === 'shipped') {
			throw new ToolError(program.status.toUpperCase(), program.status === 'aborted' ? `The user stopped program ${program.id}.` : `Program ${program.id} has shipped.`);
		}
		if (!program.integrationTip) {
			throw new ToolError('NOT_READY', `Program ${program.id}'s integration branch is not ready yet; try again in a moment.`);
		}
	}

	private ladder(program: ProgramState, feature: FeatureState): readonly string[] {
		return ladderOf(program.plan, feature.spec, this.defaultLadder(), feature.ladder);
	}

	private defaultLadder(): readonly string[] {
		const configured = this.options.settings().ladder;
		return configured.length ? configured : this.options.catalog().defaultLadder;
	}

	private retries(program: ProgramState): number {
		return program.plan.policy?.retriesPerRung ?? this.options.settings().retriesPerRung;
	}

	private runDir(programId: string): string {
		return path.join(this.options.storageDir, programId, 'runs');
	}

	private reviewDir(programId: string): string {
		return path.join(this.options.storageDir, programId, 'reviews');
	}

	private shipMessageFile(programId: string): string {
		return path.join(this.options.storageDir, programId, 'ship-message.txt');
	}

	/** Hook launchers live outside the workspace storage, whose path has spaces on Windows. */
	private hooksDir(): string {
		return path.join(path.dirname(this.options.worktreesRoot), 'hooks');
	}

	private outputLog(programId: string, featureId: string, attempt: number): string {
		return path.join(this.runDir(programId), `${featureId}-a${attempt}.out.jsonl`);
	}

	private async repositoryOf(cwd: string): Promise<string> {
		try {
			// The main worktree's root, also from inside a linked worktree such as the lead's own.
			const common = (await this.options.git.exec(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
			return path.basename(common) === '.git' ? path.dirname(common) : await this.options.git.toplevel(cwd);
		} catch {
			throw new ToolError('NO_REPOSITORY', `${cwd} is not in a git repository.`);
		}
	}

	private freePath(candidate: string): string {
		let result = candidate;
		for (let index = 2; fs.existsSync(result); index++) {
			result = `${candidate}-${index}`;
		}
		return result;
	}

	private newProgramId(): string {
		for (; ;) {
			const id = `p-${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;
			if (!this.programs.has(id) && !fs.existsSync(path.join(this.options.storageDir, id))) {
				return id;
			}
		}
	}

	private statusLine(program: ProgramState): string {
		const counts = new Map<string, number>();
		for (const feature of program.features.values()) {
			counts.set(feature.status, (counts.get(feature.status) ?? 0) + 1);
		}
		const queue = program.queue.length ? ` · queue ${program.queue.length}` : '';
		return `Status: ${[...counts].map(([status, count]) => `${count} ${status}`).join(' · ')}${queue}.`;
	}
}

function hasConflictMarkers(file: string): boolean {
	try {
		return fs.readFileSync(file, 'utf8').split('\n').some(line => CONFLICT_MARKER.test(line));
	} catch {
		// Deleted on one side: nothing left to resolve in it.
		return false;
	}
}

function attemptKey(programId: string, featureId: string, attempt: number): string {
	return `${programId}/${featureId}/${attempt}`;
}

function statusOf(feature: FeatureState): FeatureStatus {
	return feature.status;
}

function allCommands(plan: ProgramPlan): Cmd[] {
	return [...plan.checks.fast, ...plan.checks.full, ...plan.features.flatMap(feature => feature.acceptance.commands)];
}

/** Objects merge key by key, the second winning; anything else is replaced by the second. */
export function mergeJson(first: unknown, second: unknown): unknown {
	if (first && second && typeof first === 'object' && typeof second === 'object' && !Array.isArray(first) && !Array.isArray(second)) {
		const result: Record<string, unknown> = { ...first as Record<string, unknown> };
		for (const [key, value] of Object.entries(second as Record<string, unknown>)) {
			result[key] = Object.prototype.hasOwnProperty.call(result, key) ? mergeJson(result[key], value) : value;
		}
		return result;
	}
	return second;
}

/** Lowercase letters, digits and dashes, at most 32 characters. */
export function slug(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

/** Checks a `submit_result` call; a string says what is wrong with it. */
function parseResult(input: Record<string, unknown>, criteriaCount: number): WorkerResult | string {
	const outcome = input.outcome;
	if (outcome !== 'done' && outcome !== 'partial' && outcome !== 'blocked') {
		return 'outcome must be "done", "partial" or "blocked".';
	}
	const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
	if (!summary) {
		return 'summary is empty.';
	}
	const criteria = Array.isArray(input.criteria) ? input.criteria as { id?: unknown; status?: unknown; evidence?: unknown }[] : [];
	const expected = Array.from({ length: criteriaCount }, (_, index) => criterionId(index));
	const given = new Set(criteria.map(criterion => criterion?.id));
	const missing = expected.filter(id => !given.has(id));
	if (missing.length) {
		return `criteria must give a status for every criterion; missing ${missing.join(', ')}.`;
	}
	const unknown = criteria.filter(criterion => !expected.includes(String(criterion?.id)));
	if (unknown.length) {
		return `criteria has ids the contract does not: ${unknown.map(criterion => String(criterion?.id)).join(', ')}.`;
	}
	const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 500)).slice(0, 20) : undefined;
	return {
		outcome,
		summary: summary.slice(0, 2000),
		criteria: criteria.map(criterion => ({
			id: String(criterion.id),
			status: criterion.status === 'met' || criterion.status === 'not_met' ? criterion.status : 'unknown',
			evidence: list(criterion.evidence)
		})),
		assumptions: list(input.assumptions),
		risks: list(input.risks)
	};
}

/** The worker's own words, for display; marked as data. */
export function reported(text: string): string {
	return `${REPORTED} ${JSON.stringify(text)}`;
}

/** Keeps `normalizePath` in this module's public surface for the host's path comparisons. */
export { normalizePath };
