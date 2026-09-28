/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentAdapter } from '../common/agents';
import { CommandApprovals, Engine, EngineSettings, EngineUi, Principal, TrustDecisions, WorkerLaunchRequest, WorkerRunner } from '../common/engine';
import { Git } from '../common/git';
import { McpToolResult } from '../common/mcp';
import { FeatureSpec, ProgramPlan, ProgramState } from '../common/model';
import { catalogOf, fakeAdapter, gitEnvironment, makeRepo, plan, settings, tempDir, waitFor, write } from './util';

/*
 * An engine against a real repository, with workers that are functions in this process calling
 * the engine's own tool entry: the engine tests' test bench.
 */

export type Call = (tool: string, args?: object) => Promise<McpToolResult>;
export type Behavior = (call: Call, worktree: string, attempt: number) => Promise<void>;

export function status(result: McpToolResult): string | undefined {
	return (result.data as { status?: string } | undefined)?.status;
}

/** Runs each worker as a function in this process, against the engine's own tool entry. */
export class InProcessRunner implements WorkerRunner {

	readonly alive = new Set<string>();
	readonly launches: string[] = [];
	readonly requests: WorkerLaunchRequest[] = [];
	engine!: Engine;

	constructor(public behavior: (featureId: string, attempt: number, agent: string) => Behavior) { }

	async launch(request: WorkerLaunchRequest): Promise<void> {
		const [, agent, featureId, attempt] = /^Fake (\S+) · \S+ (\S+) a(\d+)$/.exec(request.name)!;
		this.alive.add(request.name);
		this.launches.push(`${featureId}:${agent}`);
		this.requests.push(request);
		const mcp = JSON.parse(request.env.FACADE_FAKE_MCP) as { args: string[] };
		const token = fs.readFileSync(mcp.args[mcp.args.indexOf('--token-file') + 1], 'utf8');
		setImmediate(async () => {
			const principal = this.engine.authenticate(token)!;
			const call: Call = (tool, args = {}) => this.engine.call(principal, tool, args, request.cwd, new AbortController().signal, () => { });
			try {
				await this.behavior(featureId, Number(attempt), agent)(call, request.cwd, Number(attempt));
			} catch {
				// A behaviour cut off by a stop.
			}
		});
	}

	stop(name: string): void {
		if (this.alive.delete(name)) {
			this.engine.workerExited(name);
		}
	}

	async isAlive(name: string): Promise<boolean> {
		return this.alive.has(name);
	}
}

/** Reads the contract, writes `content` into the feature's own file, and submits. */
export function writes(content: string | ((featureId: string, attempt: number) => string)): Behavior {
	return async (call, worktree, attempt) => {
		const contract = await call('get_contract');
		const data = contract.data as { feature: string; criteria: { id: string }[] };
		write(path.join(worktree, 'src', `${data.feature}.txt`), typeof content === 'string' ? content : content(data.feature, attempt));
		await call('submit_result', { outcome: 'done', summary: 'Wrote the file.', criteria: data.criteria.map(criterion => ({ id: criterion.id, status: 'met' })) });
	};
}

export const writesDone: Behavior = writes('done\n');

export class RecordingUi implements EngineUi {
	readonly submitted: string[] = [];
	readonly interrupted: string[] = [];
	readonly shipRequests: string[] = [];
	readonly halted: string[] = [];
	readonly notices: string[] = [];
	planSubmitted(program: ProgramState): void {
		this.submitted.push(program.id);
	}
	programInterrupted(program: ProgramState): void {
		this.interrupted.push(program.id);
	}
	changed(): void { }
	shipRequested(program: ProgramState): void {
		this.shipRequests.push(program.id);
	}
	queueHalted(_program: ProgramState, reason: string): void {
		this.halted.push(reason);
	}
	notice(message: string): void {
		this.notices.push(message);
	}
}

export class MemoryApprovals implements CommandApprovals {
	private readonly keys = new Set<string>();
	approved(): ReadonlySet<string> {
		return this.keys;
	}
	approve(_repoRoot: string, keys: readonly string[]): void {
		keys.forEach(key => this.keys.add(key));
	}
}

export class ScriptedTrust implements TrustDecisions {
	readonly asked: string[] = [];
	constructor(private readonly answer = true) { }
	async decide(agentId: string): Promise<boolean> {
		this.asked.push(agentId);
		return this.answer;
	}
}

export interface HarnessOptions {
	readonly settings?: Partial<EngineSettings>;
	readonly adapters?: readonly AgentAdapter[];
	readonly trust?: TrustDecisions;
	readonly env?: NodeJS.ProcessEnv;
	readonly shim?: { command: string; args: string[] };
}

/** One repository, and engines on it that share its storage, as windows over the same workspace would. */
export class Harness {

	readonly temp = tempDir('facade-engine-');
	readonly repo: string;
	readonly git = new Git('git', gitEnvironment);
	private readonly engines: Engine[] = [];

	constructor(files: Record<string, string> = { 'src/shared.txt': 'shared\n', 'README.md': 'readme\n' }) {
		this.repo = makeRepo(this.temp.dir, files);
	}

	createEngine(runner: WorkerRunner & { engine?: Engine }, options: HarnessOptions = {}): { engine: Engine; lead: Call; ui: RecordingUi } {
		const ui = new RecordingUi();
		const git = this.git;
		const engine = new Engine({
			storageDir: path.join(this.temp.dir, 'storage'),
			worktreesRoot: path.join(this.temp.dir, 'worktrees'),
			git,
			worktrees: { create: (root, worktree, branch, startPoint) => git.addWorktree(root, worktree, branch, startPoint) },
			runner,
			ui,
			commandApprovals: new MemoryApprovals(),
			trust: options.trust ?? new ScriptedTrust(),
			shim: { command: options.shim?.command ?? process.execPath, args: options.shim?.args ?? ['shim.js'], env: {} },
			pipe: 'unused',
			env: options.env ?? process.env,
			settings: () => ({ ...settings, ...options.settings }),
			catalog: () => catalogOf(options.adapters ?? [fakeAdapter('codex', 'unused'), fakeAdapter('claude', 'unused')]),
			log: () => { },
			questionTimeoutMs: 2_000
		});
		runner.engine = engine;
		this.engines.push(engine);
		const principal: Principal = engine.authenticate(engine.issueLeadToken('test'))!;
		const lead: Call = (tool, args = {}) => engine.call(principal, tool, args, this.repo, new AbortController().signal, () => { });
		return { engine, lead, ui };
	}

	/** Plans, approves, writes the scaffold and starts a program; returns its id. */
	async startProgram(engine: Engine, lead: Call, features: readonly FeatureSpec[], overrides: Partial<ProgramPlan> = {}): Promise<string> {
		const saved = await lead('plan_save', { plan: plan(features, overrides) });
		assert.strictEqual(saved.isError, undefined, saved.text);
		const id = (saved.data as { program: string }).program;
		await lead('plan_submit', { program_id: id });
		engine.approvePlan(id);
		await waitFor(() => engine.getProgram(id)!.integrationTip !== undefined, 10_000, 'the integration branch');
		const workspace = (await lead('lead_workspace', { program_id: id })).data as { path: string };
		write(path.join(workspace.path, 'src', 'shared.txt'), 'shared, with the scaffold\n');
		const submitted = await lead('lead_submit', { program_id: id, kind: 'scaffold', message: 'Add the scaffold' });
		assert.strictEqual(status(submitted), 'merged', submitted.text);
		const started = await lead('program_start', { program_id: id });
		assert.strictEqual(started.isError, undefined, started.text);
		return id;
	}

	/** Records a clean review of every merge not reviewed yet, as reviewers would. */
	async reviewAll(engine: Engine, lead: Call, id: string): Promise<void> {
		for (const merge of engine.getProgram(id)!.merges.filter(each => !each.review)) {
			const addressed = (merge.item.resolves ?? []).map(finding => ({ id: finding, status: 'addressed' }));
			const recorded = await lead('review_record', { program_id: id, target: merge.commit, findings: [], addressed });
			assert.strictEqual(recorded.isError, undefined, recorded.text);
		}
	}

	allMerged(engine: Engine, id: string): boolean {
		const program = engine.getProgram(id)!;
		return [...program.features.values()].every(each => each.status === 'merged' || each.status === 'abandoned') && !program.queue.length;
	}

	/** Stops the engines, and the checks they run, before their folders go. */
	async dispose(): Promise<void> {
		this.engines.forEach(engine => engine.dispose());
		await new Promise(resolve => setTimeout(resolve, 500));
		this.temp.remove();
	}
}
