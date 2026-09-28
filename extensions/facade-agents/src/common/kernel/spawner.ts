/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { AgentAdapter, AgentCatalog, FirstRunAnswer, HookPolicy, InstalledAgent, LaunchSpec, McpLaunch } from '../agents';
import { TrustDecisions, WorkerLaunchRequest, WorktreeFactory } from '../engine';
import { Git } from '../git';
import { normalizePath } from '../glob';
import { AgentRef, formatAgent, parseRung } from '../model';
import { Environment } from '../spawn';
import { claudeTranscriptUsage, withPrice } from '../usage';
import { Kernel, KernelError } from './kernel';
import { Caller, Participant, YOU } from './model';
import { agentName, NameError } from './names';
import { AgentHost, HookHost, SpawnPlace, SpawnRequest, SpawnResult } from './tools';

/*
 * Starting and stopping agents (L2-PLAN, step 28). An agent joins the workspace under a name with a
 * token of its own, and runs through its vendor's adapter as its own interactive UI in a terminal,
 * where the person can watch it and type to it. Every launch's configuration is its own - flags,
 * files in its run folder, files injected into its folder and put back when it stops - and nothing
 * is written into the user's own agent configuration, but for the answers to the questions the
 * agent's UI asks as it starts, which the person let Facade give (`AgentAdapter.firstRun`).
 */

/** A launch, with the questions the agent's UI asks as it starts that Facade answers for the person. */
export interface AgentLaunchRequest extends WorkerLaunchRequest {
	readonly answers?: readonly FirstRunAnswer[];
}

/** Starts, stops and finds agents' processes: in Facade's terminals, or as plain processes in tests. */
export interface AgentRunner {
	/** Starts a process. Its name is its handle, unique per incarnation, valid across a window reload. */
	launch(request: AgentLaunchRequest): Promise<void>;
	stop(handle: string): void;
	isAlive(handle: string): Promise<boolean>;
	/** Types a line into a running process's terminal and presses Enter. */
	type?(handle: string, text: string): Promise<boolean>;
	/** When the person last typed into that terminal, if the runner can tell. */
	lastInputAt?(handle: string): Promise<number | undefined>;
	/** Puts a process's terminal in front; false when it has none. */
	reveal?(handle: string): Promise<boolean>;
}

export interface SpawnerOptions {
	readonly kernel: Kernel;
	readonly git: Git;
	readonly worktrees: WorktreeFactory;
	readonly runner: AgentRunner;
	readonly trust: TrustDecisions;
	/** How to start Facade's shim; the spawner adds the subcommand and its arguments. */
	readonly shim: McpLaunch;
	/** The window's pipe, which the agents' MCP servers and hooks call. */
	pipe(): string;
	readonly env: Environment;
	catalog(): AgentCatalog;
	/** Where worktrees made for agents go: `~/.facade/worktrees`. */
	readonly worktreesRoot: string;
	/** Where hook launchers go: `~/.facade/hooks`. */
	readonly hooksDir: string;
	/** The Claude plugin with the process skills, once there is one. */
	pluginDir?(): string | undefined;
	/**
	 * Makes a worktree the way the window's New Worktree does - its folder under `~/.facade/worktrees`,
	 * its row, its setup - without the dialog, when the window can; answers with its folder. Without
	 * it, `worktrees` makes one at a path of the spawner's choosing.
	 */
	makeWorktree?(repoRoot: string, branch: string, startPoint: string): Promise<string>;
	/** Something the person should know, once. */
	notice?(message: string): void;
	log(message: string): void;
}

/** An agent's process, kept in `runs/` so that a reload finds it again. */
interface RunRecord {
	readonly name: string;
	readonly incarnation: number;
	readonly agent: string;
	readonly place: string;
	readonly tokenFile: string;
	readonly hookCommand?: string;
	/** Its terminal's name. */
	readonly handle: string;
	/** Files put into its folder, with what was there before, to put back when it stops. */
	readonly injected: readonly { readonly path: string; readonly original: string | null }[];
	/** Claude's session so far, named by its Stop hook: what its usage is read from. */
	transcript?: string;
}

const RUNS_DIR = 'runs';

export class Spawner implements AgentHost, HookHost {

	private readonly records = new Map<string, RunRecord>();
	private readonly noticed = new Set<string>();

	constructor(private readonly options: SpawnerOptions) {
		for (const record of this.loadRecords()) {
			this.records.set(record.name, record);
		}
	}

	private get kernel(): Kernel {
		return this.options.kernel;
	}

	private get runsDir(): string {
		return path.join(this.kernel.dir, RUNS_DIR);
	}

	agents(): readonly string[] {
		return [...this.options.catalog().installed.keys()];
	}

	/** Puts the agent's terminal in front: the one of its latest run. */
	async reveal(name: string): Promise<boolean> {
		const record = this.current(name);
		return !!record && !!this.options.runner.reveal && this.options.runner.reveal(record.handle);
	}

	/*
	 * spawn and stop
	 */

	async spawn(caller: Caller, request: SpawnRequest, _signal: AbortSignal, progress: (message: string) => void): Promise<SpawnResult> {
		const ref = parseRung(request.agent);
		const installed = this.options.catalog().installed.get(ref.id);
		if (!installed) {
			const known = this.agents();
			throw new KernelError('NOT_FOUND', `${ref.id} is not installed here. ${known.length ? `Installed: ${known.join(', ')}.` : 'No agent is installed.'}`);
		}
		const adapter = installed.adapter;
		let name: string;
		try {
			name = request.name ? agentName(request.name) : this.kernel.freeName(ref.id);
		} catch (err) {
			throw err instanceof NameError ? new KernelError('INVALID', err.message) : err;
		}
		const previous = this.kernel.state.participants.get(name);
		if (previous && previous.kind !== 'agent') {
			throw new KernelError('INVALID', `@${name} is not an agent.`);
		}
		// Asked before anything is made, so that a no leaves nothing behind.
		const trusted = await this.trusted(adapter);
		if (trusted === false) {
			throw new KernelError('INVALID', `The person did not let Facade start ${adapter.displayName} trusting the folders it makes for it.`);
		}
		const place = await this.place(caller, request.where, progress);
		// A question about the folder is answered only for a worktree Facade made: the person's own
		// folders are theirs to trust.
		const answers = trusted && adapter.firstRun ? adapter.firstRun.answers.filter(answer => !answer.aboutTheFolder || place.branch !== undefined) : undefined;
		if (previous && previous.state !== 'stopped' && previous.state !== 'failed') {
			this.end(previous, 'stopped', `replaced by a new @${name}, started by @${caller.name}`);
		}
		const added = this.kernel.addAgent({ name, agent: formatAgent(ref), place: place.folder, startedBy: caller.name, text: request.text, groups: request.groups });
		try {
			await this.launch(added.name, added.incarnation, added.token, ref, installed, place.folder, trusted, answers);
		} catch (err) {
			const detail = (err as Error).message;
			this.options.log(`[spawner] starting @${name} failed: ${detail}`);
			const participant = this.kernel.state.participants.get(name);
			if (participant) {
				this.end(participant, 'failed', detail);
			}
			throw new KernelError('INVALID', `@${name} could not start: ${detail}`);
		}
		return { name: added.name, incarnation: added.incarnation, agent: formatAgent(ref), place: place.folder, branch: place.branch };
	}

	async stop(caller: Caller, target: string): Promise<string> {
		let name: string;
		try {
			name = agentName(target);
		} catch (err) {
			throw err instanceof NameError ? new KernelError('INVALID', err.message) : err;
		}
		const participant = this.kernel.state.participants.get(name);
		if (!participant) {
			throw new KernelError('NOT_FOUND', `Nobody here is called @${name}.`);
		}
		if (participant.kind !== 'agent') {
			throw new KernelError('INVALID', `@${name} is not an agent.`);
		}
		if (participant.state === 'stopped' || participant.state === 'failed') {
			return `@${name} is already ${participant.state}.`;
		}
		this.end(participant, 'stopped', `stopped by @${caller.name}`);
		return `Stopped @${name}.`;
	}

	/** Ends an incarnation: its process, its injected files, its token. */
	private end(participant: Participant, state: 'stopped' | 'failed', detail: string): void {
		const record = this.records.get(participant.name);
		if (record && record.incarnation === participant.incarnation) {
			this.options.runner.stop(record.handle);
			this.collectUsage(record);
			this.restoreInjected(record);
		}
		this.kernel.setState(participant.name, participant.incarnation, state, detail);
	}

	/** Where the agent works: a folder that exists, or a worktree made for it. */
	private async place(caller: Caller, where: SpawnPlace, progress: (message: string) => void): Promise<{ folder: string; branch?: string }> {
		const callerPlace = this.kernel.state.participants.get(caller.name)?.place;
		const resolve = (folder: string) => path.resolve(callerPlace ?? process.cwd(), folder);
		if (where.folder) {
			const folder = resolve(where.folder);
			if (!isDirectory(folder)) {
				throw new KernelError('NOT_FOUND', `There is no folder ${folder}.`);
			}
			return { folder: fs.realpathSync.native(folder) };
		}
		if (!where.branch) {
			throw new KernelError('INVALID', 'where needs folder, for an existing folder, or branch, for a new worktree.');
		}
		const from = where.repo ? resolve(where.repo) : callerPlace;
		if (!from) {
			throw new KernelError('INVALID', `Say which repository: where.repo. ${caller.name === YOU ? 'You are' : `@${caller.name} is`} not working in one.`);
		}
		const git = this.options.git;
		let repoRoot: string;
		try {
			repoRoot = await git.toplevel(from);
		} catch {
			throw new KernelError('INVALID', `${from} is not in a git repository.`);
		}
		const branch = where.branch.trim();
		if (!await git.isValidBranchName(repoRoot, branch)) {
			throw new KernelError('INVALID', `${branch} is not a valid branch name.`);
		}
		if (await git.branchExists(repoRoot, branch)) {
			throw new KernelError('INVALID', `The branch ${branch} exists already. Give a new branch name, or where.folder for a folder that has it checked out.`);
		}
		// The base is read where the caller stands, so a lead on its integration branch starts workers from it.
		const baseFrom = !where.base && callerPlace && await sameRepository(git, callerPlace, repoRoot) ? callerPlace : repoRoot;
		const base = await git.resolveCommit(baseFrom, where.base ?? 'HEAD');
		if (!base) {
			throw new KernelError('INVALID', `${where.base ?? 'HEAD'} is not a commit in ${baseFrom}.`);
		}
		progress(`Making a worktree on the new branch ${branch}`);
		this.options.log(`[spawner] making a worktree of ${repoRoot} on ${branch} from ${base}`);
		let worktree: string;
		if (this.options.makeWorktree) {
			// The window's own New Worktree, without its dialog: its folder, its row, its setup.
			try {
				worktree = await this.options.makeWorktree(repoRoot, branch, base);
			} catch (err) {
				throw new KernelError('INVALID', (err as Error).message);
			}
		} else {
			worktree = freePath(path.join(this.options.worktreesRoot, await repositoryName(git, repoRoot), branchSlug(branch)));
			await this.options.worktrees.create(repoRoot, worktree, branch, base);
		}
		return { folder: fs.realpathSync.native(worktree), branch };
	}

	/**
	 * Whether the person lets Facade start this agent trusting what Facade gives it - the folders it
	 * makes, its hooks - by flags on its command line or by answering the questions its UI asks as it
	 * starts. Asked once; undefined when there is nothing to ask.
	 */
	private async trusted(adapter: AgentAdapter): Promise<boolean | undefined> {
		if (adapter.firstRun) {
			return this.options.trust.decide(adapter.id, adapter.displayName, adapter.firstRun.detail);
		}
		if (!adapter.trust) {
			return undefined;
		}
		if (!adapter.trust.flags?.length) {
			// It asks in its own terminal; the person only needs to know.
			if (!this.noticed.has(adapter.id)) {
				this.noticed.add(adapter.id);
				this.options.notice?.(adapter.trust.detail);
			}
			return undefined;
		}
		return this.options.trust.decide(adapter.id, adapter.displayName, adapter.trust.detail);
	}

	/** Starts an incarnation: the agent's own interactive UI, in a terminal. */
	private async launch(name: string, incarnation: number, token: string, ref: AgentRef, installed: InstalledAgent, folder: string, trusted: boolean | undefined, answers: readonly FirstRunAnswer[] | undefined): Promise<void> {
		const adapter = installed.adapter;
		fs.mkdirSync(this.runsDir, { recursive: true });
		const slug = `${name}-${incarnation}`;
		const tokenFile = path.join(this.runsDir, `${slug}.token`);
		fs.writeFileSync(tokenFile, token, { mode: 0o600 });
		const hookCommand = adapter.id === 'claude' || adapter.commandHooks ? this.hookCommand(slug, tokenFile) : adapter.id === 'codex' ? this.stableHookCommand() : undefined;
		const mcp: McpLaunch = { command: this.options.shim.command, args: [...this.options.shim.args, 'mcp', '--pipe', this.options.pipe(), '--token-file', tokenFile], env: this.options.shim.env };
		const spec = adapter.buildLaunch({
			agent: ref,
			worktree: folder,
			prompt: this.kernel.participant(name).text ?? 'Call whoami.',
			mcp,
			runDir: this.runsDir,
			slug,
			acceptance: [],
			trusted,
			hookCommand,
			participant: { pluginDir: adapter.id === 'claude' ? this.options.pluginDir?.() : undefined }
		}, installed.executable);
		for (const file of spec.files) {
			fs.writeFileSync(file.path, file.content, { mode: 0o600 });
		}
		const env = adapter.id === 'codex'
			// Codex's hooks must be the same for every launch to stay trusted: they find Facade from these.
			? { ...spec.env, FACADE_AGENTS_PIPE: this.options.pipe(), FACADE_AGENTS_TOKEN: token }
			: spec.env;
		const handle = `@${name} · ${adapter.displayName}${incarnation > 1 ? ` (${incarnation})` : ''}`;
		const record: RunRecord = { name, incarnation, agent: formatAgent(ref), place: folder, tokenFile, hookCommand, handle, injected: this.inject(folder, spec) };
		this.records.set(name, record);
		this.saveRecord(record);
		this.options.log(`[spawner] starting ${handle} in ${folder}`);
		await this.options.runner.launch({ name: handle, executable: spec.executable, args: spec.args, env, cwd: spec.cwd, initialInput: spec.initialInput, answers });
		this.options.log(`[spawner] ${handle} is running`);
	}

	/** Types a line into an agent's terminal; false when it has none running. */
	async type(name: string, text: string): Promise<boolean> {
		const record = this.current(name);
		if (!record || !this.options.runner.type || !await this.options.runner.isAlive(record.handle)) {
			return false;
		}
		return this.options.runner.type(record.handle, text);
	}

	/** When the person last typed into the agent's terminal, if the runner can tell. */
	async lastInputAt(name: string): Promise<number | undefined> {
		const record = this.current(name);
		return record && this.options.runner.lastInputAt ? this.options.runner.lastInputAt(record.handle) : undefined;
	}

	/** The run record of the agent's current incarnation. */
	private current(name: string): RunRecord | undefined {
		const participant = this.kernel.state.participants.get(name);
		const record = this.records.get(name);
		return participant && record && record.incarnation === participant.incarnation ? record : undefined;
	}

	/** The runner's word that an agent's process ended. */
	exited(handle: string, exitCode: number | undefined): void {
		const record = [...this.records.values()].find(candidate => candidate.handle === handle);
		if (!record) {
			return;
		}
		const participant = this.kernel.state.participants.get(record.name);
		if (!participant || participant.incarnation !== record.incarnation || participant.state === 'stopped' || participant.state === 'failed') {
			return;
		}
		this.end(participant, 'stopped', exitCode !== undefined ? `its process exited with code ${exitCode}` : 'its terminal closed');
	}

	/** After a reload or a restart: agents whose process is gone are stopped. */
	async recover(): Promise<void> {
		for (const participant of this.kernel.state.participants.values()) {
			if (participant.kind !== 'agent' || participant.state === 'stopped' || participant.state === 'failed') {
				continue;
			}
			const record = this.records.get(participant.name);
			if (record && record.incarnation === participant.incarnation && await this.options.runner.isAlive(record.handle)) {
				continue;
			}
			this.end(participant, 'stopped', 'its process is gone: Facade restarted');
		}
	}

	/*
	 * Hooks
	 */

	async hook(caller: Caller, event: string, payload: unknown): Promise<string> {
		const participant = this.kernel.state.participants.get(caller.name);
		if (!participant || participant.incarnation !== caller.incarnation) {
			return '';
		}
		const input = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
		switch (event) {
			case 'stop': {
				const record = this.records.get(caller.name);
				if (record && typeof input.transcript_path === 'string') {
					record.transcript = input.transcript_path;
					this.saveRecord(record);
					this.collectUsage(record);
				}
				this.kernel.setState(caller.name, caller.incarnation, 'idle');
				return '';
			}
			case 'prompt':
				this.kernel.setState(caller.name, caller.incarnation, 'working');
				return '';
			case 'notification': {
				const type = String(input.notification_type ?? '');
				if (type === 'permission_prompt' || type === 'elicitation_dialog') {
					this.kernel.setState(caller.name, caller.incarnation, 'waiting', typeof input.message === 'string' ? input.message : type === 'permission_prompt' ? 'a permission prompt' : 'a question');
				} else if (type === 'idle_prompt') {
					this.kernel.setState(caller.name, caller.incarnation, 'idle');
				}
				return '';
			}
			case 'agy-stop':
				this.kernel.setState(caller.name, caller.incarnation, 'idle');
				return JSON.stringify({ decision: 'stop' });
			case 'permission':
				this.kernel.setState(caller.name, caller.incarnation, 'waiting', 'a permission request');
				return '';
		}
		return '';
	}

	/*
	 * Files
	 */

	/** Writes the files an agent reads from its folder, remembering what they replace. */
	private inject(folder: string, spec: LaunchSpec): { path: string; original: string | null }[] {
		const injected: { path: string; original: string | null }[] = [];
		for (const file of spec.injected ?? []) {
			const target = path.join(folder, file.path);
			let original: string | null = null;
			try {
				original = fs.readFileSync(target, 'utf8');
			} catch {
				original = null;
			}
			let content = file.content;
			if (original !== null && file.path.endsWith('.json')) {
				try {
					content = JSON.stringify(mergeJson(JSON.parse(original), JSON.parse(file.content)), undefined, '\t');
				} catch {
					// Not JSON: Facade's file replaces it while the agent runs.
				}
			}
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content, { mode: 0o600 });
			injected.push({ path: normalizePath(file.path), original });
		}
		return injected;
	}

	private restoreInjected(record: RunRecord): void {
		for (const file of record.injected) {
			const target = path.join(record.place, ...file.path.split('/'));
			try {
				if (file.original === null) {
					fs.rmSync(target, { force: true });
					removeEmptyParents(path.dirname(target), record.place);
				} else {
					fs.writeFileSync(target, file.original);
				}
			} catch (err) {
				this.options.log(`[spawner] putting back ${target} failed: ${(err as Error).message}`);
			}
		}
	}

	/** A launcher for an agent's command hooks: a script in `~/.facade/hooks` that runs the shim's hook handler. */
	private hookCommand(slug: string, tokenFile: string): string {
		const dir = this.options.hooksDir;
		fs.mkdirSync(dir, { recursive: true });
		const name = `${path.basename(this.kernel.dir)}-${slug}`;
		const policyFile = path.join(this.runsDir, `${slug}.policy.json`);
		// Facade's own tools pass without asking; everything else is the agent's own business.
		const policy: HookPolicy = { server: 'facade', allowCommands: [], denyCommands: [] };
		fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
		const shim = this.options.shim;
		const args = [...shim.args, 'hook', '--pipe', this.options.pipe(), '--token-file', tokenFile, '--policy', policyFile];
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

	/**
	 * One hook launcher for every Codex: Codex runs a hook only once the person trusted its exact
	 * definition, so the definition must not change from one launch to the next. It finds the
	 * window and its agent from the environment Facade gives each Codex.
	 */
	private stableHookCommand(): string {
		const dir = this.options.hooksDir;
		fs.mkdirSync(dir, { recursive: true });
		const shim = this.options.shim;
		const args = [...shim.args, 'hook'];
		let script: string;
		let file: string;
		if (process.platform === 'win32') {
			file = path.join(dir, 'facade-event.cmd');
			script = ['@echo off', ...Object.entries(shim.env).map(([key, value]) => `set "${key}=${value}"`), `"${shim.command}" ${args.map(arg => `"${arg}"`).join(' ')} %*`, ''].join('\r\n');
		} else {
			file = path.join(dir, 'facade-event.sh');
			const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
			script = ['#!/bin/sh', `${Object.entries(shim.env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} exec ${[shim.command, ...args].map(quote).join(' ')} "$@"`, ''].join('\n');
		}
		let current: string | undefined;
		try {
			current = fs.readFileSync(file, 'utf8');
		} catch {
			current = undefined;
		}
		if (current !== script) {
			fs.writeFileSync(file, script, { mode: 0o700 });
		}
		const command = normalizePath(file);
		return /\s/.test(command) ? `"${command}"` : command;
	}

	/** The usage of the agent's session so far, from the transcript its Stop hook named: Claude's. */
	private collectUsage(record: RunRecord): void {
		if (!record.transcript || !fs.existsSync(record.transcript)) {
			return;
		}
		try {
			const whole = claudeTranscriptUsage(fs.readFileSync(record.transcript, 'utf8'));
			if (whole) {
				this.kernel.setUsage(record.name, record.incarnation, withPrice(whole));
			}
		} catch (err) {
			this.options.log(`[spawner] reading the usage of @${record.name} failed: ${(err as Error).message}`);
		}
	}

	private saveRecord(record: RunRecord): void {
		fs.mkdirSync(this.runsDir, { recursive: true });
		fs.writeFileSync(path.join(this.runsDir, `${record.name}.json`), JSON.stringify(record, undefined, '\t'), { mode: 0o600 });
	}

	private loadRecords(): RunRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.runsDir).filter(file => file.endsWith('.json') && !file.endsWith('.policy.json') && !file.endsWith('.mcp.json') && !file.endsWith('.settings.json'));
		} catch {
			return [];
		}
		const records: RunRecord[] = [];
		for (const file of names) {
			try {
				const record = JSON.parse(fs.readFileSync(path.join(this.runsDir, file), 'utf8')) as RunRecord;
				if (typeof record.name === 'string' && typeof record.handle === 'string') {
					records.push(record);
				}
			} catch {
				// Not a run record.
			}
		}
		return records;
	}
}

function isDirectory(folder: string): boolean {
	try {
		return fs.statSync(folder).isDirectory();
	} catch {
		return false;
	}
}

/** Whether `folder` is in the same repository as `repoRoot`, a worktree of it included. */
async function sameRepository(git: Git, folder: string, repoRoot: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([commonDir(git, folder), commonDir(git, repoRoot)]);
		return comparable(a) === comparable(b);
	} catch {
		return false;
	}
}

async function commonDir(git: Git, folder: string): Promise<string> {
	const { stdout } = await git.exec(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
	return stdout.trim();
}

/** The repository's name: its main checkout's folder, whichever worktree `repoRoot` is. */
async function repositoryName(git: Git, repoRoot: string): Promise<string> {
	try {
		const common = await commonDir(git, repoRoot);
		const base = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(common).replace(/\.git$/, '');
		return base || path.basename(repoRoot);
	} catch {
		return path.basename(repoRoot);
	}
}

function branchSlug(branch: string): string {
	return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'worktree';
}

function freePath(candidate: string): string {
	let result = candidate;
	for (let i = 2; fs.existsSync(result); i++) {
		result = `${candidate}-${i}`;
	}
	return result;
}

function comparable(file: string): string {
	const normalized = normalizePath(path.resolve(file));
	return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function removeEmptyParents(dir: string, stopAt: string): void {
	let current = dir;
	while (comparable(current) !== comparable(stopAt) && comparable(current).startsWith(comparable(stopAt))) {
		try {
			fs.rmdirSync(current);
		} catch {
			return;
		}
		current = path.dirname(current);
	}
}

function mergeJson(first: unknown, second: unknown): unknown {
	if (first && second && typeof first === 'object' && typeof second === 'object' && !Array.isArray(first) && !Array.isArray(second)) {
		const merged: Record<string, unknown> = { ...(first as Record<string, unknown>) };
		for (const [key, value] of Object.entries(second as Record<string, unknown>)) {
			merged[key] = Object.hasOwn(merged, key) ? mergeJson(merged[key], value) : value;
		}
		return merged;
	}
	return second;
}
