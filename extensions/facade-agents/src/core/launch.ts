/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise, timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentCli, Environment, Injected, InstalledCli, LaunchInput, LaunchSpec } from '../clis/cli';
import { launchTarget, unsafeForCmd } from '../clis/executable';
import { trustTarget } from '../clis/trust';
import { Caller, isLive, Process, YOU_PID } from '../record/events';
import { ProcessTable } from '../record/processes';
import { FacadeError } from './errors';
import { Injections } from './injections';
import { AgentSetup, CliCatalog, Disposable, Ports, Timing } from './ports';

/**
 * How long Facade waits where the person sets nothing else: two minutes, for a new process to come up,
 * and for an agent's MCP server to find the window again.
 */
export const START_TIMEOUT_MS = 120_000;

/** A child's start, as `spawn` decided it. */
export interface Run {
	readonly name: string;
	readonly model: string;
	readonly effort: string;
	readonly prompt?: string;
	readonly worktree: string;
	readonly folder: string;
	/** In a worktree Facade made, whose trust the CLI is given. */
	readonly trusted: boolean;
}

/** What a launch needs of the core around it. */
export interface LaunchContext {
	readonly table: ProcessTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	readonly injections: Injections;
	/** How long the core waits, as the person sets it. */
	readonly timing?: () => Timing;
	/** The name of the terminal a process runs in. */
	terminalOf(process: Process): string;
	/** Ends a process that did not come up, or could not be told of its task: recorded as failed, its terminal closed. */
	fail(process: Process, reason: string): Promise<void>;
	log(message: string): void;
}

/** A process on its way up. */
interface Startup {
	/** Settles once the process is up - its MCP server said hello, and it was told of its task where it is told in its terminal - or once it exited. */
	readonly up: DeferredPromise<void>;
	/** Ends it as failed once its time to come up is over; cleared by its MCP server's hello. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The PID of the caller whose spawn waits for it; none for one found starting after a reload. */
	readonly waiter?: number;
}

/**
 * Launches children: each recorded, its CLI started in its terminal, and waited for until it is up -
 * its MCP server said hello and, for a CLI told of its task in its terminal, the line telling it was
 * typed. After a reload, a process found starting is waited for again, and one not yet told of its task
 * is told.
 */
export class Launcher implements Disposable {

	/** The processes on their way up, by PID. */
	private readonly startups = new Map<number, Startup>();
	/** The processes whose task is being typed into their terminals, by PID: once each. */
	private readonly typing = new Set<number>();
	private disposed = false;

	constructor(private readonly context: LaunchContext) { }

	dispose(): void {
		this.disposed = true;
		for (const startup of this.startups.values()) {
			clearTimeout(startup.timer);
			startup.up.error(new FacadeError('UNAVAILABLE', 'The window closed meanwhile: whether the agent came up is not known. ps says, once the window is back.'));
		}
		this.startups.clear();
	}

	/**
	 * Throws where `installed` could not be started on `model` at `effort` with `prompt` as the person has
	 * it set up, in its environment `env` - a `${name}` its launch or its trust has no value for, or an
	 * argument that would not reach a CLI Windows starts through cmd.exe as it is - so that a spawn refuses
	 * before anything is made for it. The launch is computed, not run; the model and the effort are the
	 * CLI's to take or refuse.
	 */
	check(installed: InstalledCli, model: string, effort: string, folder: string, prompt: string | undefined, env: Environment): void {
		const inTerminal = installed.cli.task === 'terminal' || launchTarget(installed.executable).throughCmd;
		try {
			this.launchOf(installed, {
				folder,
				// The arguments for a worktree Facade made are checked too.
				trusted: true,
				...(!inTerminal && prompt !== undefined ? { prompt } : {}),
				model,
				effort,
				mcp: { command: 'facade', args: [], env: {} },
				skills: [],
				runDir: this.context.table.runsDir,
				slug: 'check'
			});
			trustTarget(installed.cli, installed.config, { folder, repository: folder }, env);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `${installed.cli.displayName} cannot be started as its settings are: ${messageOf(err)}`);
		}
	}

	/**
	 * Records `run` as a new child of the caller, starts its CLI in its terminal, and waits until it is up.
	 * Should anything fail on the way, the child is ended as failed, and the call fails with why.
	 */
	async launch(caller: Caller, installed: InstalledCli, run: Run, progress: ((message: string) => void) | undefined): Promise<Process> {
		const { table, ports, setup } = this.context;
		const { cli } = installed;
		// No text of an agent's or the person's goes through cmd.exe, where it could run commands: a CLI
		// Windows starts so is told of its task in its terminal, as a CLI whose first conversation has no
		// MCP tools is.
		const inTerminal = cli.task === 'terminal' || launchTarget(installed.executable).throughCmd;
		const { prompt } = run;
		const first = prompt === undefined ? undefined : (pid: number) => `${setup.opening({ pid, name: run.name, cliName: cli.displayName }, caller)}\n\n${prompt}`;
		this.stillOpen();
		const started = table.start({ name: run.name, ppid: caller.pid, cli: cli.id, model: run.model, effort: run.effort, worktree: run.worktree, folder: run.folder, ...(inTerminal && first ? { task: first } : {}) });
		const { process } = started;
		const startup = this.watch(process, caller.pid);
		const terminal = this.context.terminalOf(process);
		if (caller.pid !== YOU_PID && !isLive(table.get(caller.pid))) {
			ports.person.tell(l10n.t("@{0} (PID {1}) exited while it started @{2} (PID {3}), which is yours now.", caller.name, caller.pid, process.name, process.pid), terminal);
		}
		try {
			const { spec, args, throughCmd } = this.launchOf(installed, {
				folder: run.folder,
				trusted: run.trusted,
				...(!inTerminal && first ? { prompt: first(process.pid) } : {}),
				model: run.model,
				effort: run.effort,
				mcp: cli.sharedServer ? setup.sharedMcpServer() : setup.mcpServer(started.tokenFile),
				skills: setup.skills(),
				runDir: table.runsDir,
				slug: String(process.pid)
			});
			for (const file of spec.files) {
				fs.mkdirSync(path.dirname(file.path), { recursive: true });
				fs.writeFileSync(file.path, file.content, { mode: 0o600 });
			}
			await this.inject(run.folder, spec.injected, cli.displayName);
			this.stillOpen();
			// A server the same for every launch finds the agent from its environment.
			const env = cli.sharedServer ? { ...spec.env, ...setup.agentEnv(started.token) } : spec.env;
			this.context.log(`Starting ${terminal} in ${run.folder}, the worktree ${run.worktree}${throughCmd ? ', through cmd.exe' : ''}.`);
			progress?.(`Starting @${process.name}, PID ${process.pid}.`);
			await ports.terminals.launch({ name: terminal, command: cli.command, executable: spec.executable, args, env, cwd: spec.cwd, reveal: caller.pid === YOU_PID });
		} catch (err) {
			// A window that closed leaves it to the next one: starting, or gone with its terminal.
			if (err instanceof FacadeError && err.code === 'UNAVAILABLE') {
				throw err;
			}
			await this.context.fail(process, messageOf(err));
			throw didNotStart(cli, process, messageOf(err));
		}
		progress?.(`Waiting for @${process.name} to come up.`);
		try {
			await startup.up.p;
		} catch (err) {
			throw err instanceof FacadeError ? err : didNotStart(cli, process, messageOf(err));
		}
		return process;
	}

	/** A starting process's MCP server said hello: it is running, and is told of its task where it is told in its terminal. */
	hello(process: Process): void {
		if (this.disposed || process.state !== 'starting') {
			return;
		}
		this.context.table.setRunning(process.pid);
		this.context.log(`${this.context.terminalOf(process)} is running: its MCP server said hello.`);
		const startup = this.startups.get(process.pid);
		if (startup) {
			clearTimeout(startup.timer);
			startup.timer = undefined;
		}
		this.bringUp(process);
	}

	/** After a reload: a process that was starting is waited for again; one running but not yet told of its task is told. */
	resume(process: Process): void {
		if (!this.isRunning(process)) {
			return;
		}
		if (process.state !== 'starting') {
			this.bringUp(process);
		} else if (!this.startups.has(process.pid)) {
			this.watch(process, undefined);
		}
	}

	/** The PID of the caller whose spawn waits for `pid` to come up, if one does. */
	waiterOf(pid: number): number | undefined {
		return this.startups.get(pid)?.waiter;
	}

	/**
	 * The launch of `installed` for `input`, as the person has it set up, with its arguments whole; throws
	 * where one would not reach a CLI that Windows starts through cmd.exe as it is.
	 */
	private launchOf(installed: InstalledCli, input: Omit<LaunchInput, 'config'>): { readonly spec: LaunchSpec; readonly args: readonly string[]; readonly throughCmd: boolean } {
		const { cli } = installed;
		const target = launchTarget(installed.executable);
		const spec = cli.launch({ ...input, config: installed.config }, target.executable);
		const args = [...target.args, ...spec.args];
		const unsafe = target.throughCmd ? args.find(unsafeForCmd) : undefined;
		if (unsafe !== undefined) {
			throw new Error(`${cli.displayName} is ${spec.executable} on this machine, which Windows starts through cmd.exe, and ${JSON.stringify(unsafe)} would not reach it as it is. Install it with its own installer, which puts an .exe on PATH.`);
		}
		return { spec, args, throughCmd: target.throughCmd };
	}

	/** A process exited: the spawn that waits for it fails with why. */
	ended(pid: number, reason: string): void {
		const startup = this.startups.get(pid);
		if (startup) {
			this.startups.delete(pid);
			clearTimeout(startup.timer);
			startup.up.error(new Error(reason));
		}
	}

	/** Waits for a starting process to come up, for the time it has: then it is ended as failed. */
	private watch(process: Process, waiter: number | undefined): Startup {
		const ms = this.timing().startTimeoutMs;
		const startup: Startup = {
			up: new DeferredPromise<void>(),
			timer: setTimeout(() => {
				startup.timer = undefined;
				if (this.context.table.get(process.pid)?.state === 'starting') {
					this.background(`Ending ${this.context.terminalOf(process)}`, this.context.fail(process, `it did not come up within ${Math.round(ms / 1000)} seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal`));
				}
			}, ms),
			...(waiter !== undefined ? { waiter } : {})
		};
		// Seen by the spawn that waits for it, if one does: never a rejection nobody handles.
		startup.up.p.catch(() => undefined);
		this.startups.set(process.pid, startup);
		return startup;
	}

	/** Tells a running process of its task where it is told in its terminal, once; then it is up. */
	private bringUp(process: Process): void {
		if (process.taskFile === undefined || process.taskTyped) {
			this.isUp(process);
		} else if (!this.typing.has(process.pid)) {
			this.typing.add(process.pid);
			this.background(`Telling ${this.context.terminalOf(process)} of its task`, this.typeTask(process, process.taskFile).finally(() => this.typing.delete(process.pid)));
		}
	}

	/**
	 * Types the line that tells a process of its task file into its terminal, a moment after its MCP
	 * server's hello, and presses Enter after the pause its CLI needs. One that cannot be told is failed.
	 */
	private async typeTask(process: Process, taskFile: string): Promise<void> {
		const { table, ports } = this.context;
		const terminal = this.context.terminalOf(process);
		try {
			const cli = this.context.clis.known.find(each => each.id === process.cli);
			if (!cli) {
				throw new Error(`Facade does not know the CLI ${process.cli}`);
			}
			const { taskDelay, enterDelay } = this.context.clis.configOf(cli).launch;
			await timeout(taskDelay);
			if (!this.isRunning(process)) {
				return;
			}
			if (!await ports.terminals.type(terminal, `[facade] Your task is in ${taskFile}: read that file, then do what it says.`)) {
				throw new Error('its terminal was not there');
			}
			await timeout(enterDelay);
			if (!this.isRunning(process)) {
				return;
			}
			await ports.terminals.type(terminal, '\r');
			if (!this.isRunning(process)) {
				return;
			}
			table.setTaskTyped(process.pid);
			this.context.log(`${terminal} was told of its task, in ${taskFile}.`);
			this.isUp(process);
		} catch (err) {
			await this.context.fail(process, `its task could not be typed into its terminal: ${messageOf(err)}`);
		}
	}

	/** A process is up: the spawn that waits for it answers. */
	private isUp(process: Process): void {
		const startup = this.startups.get(process.pid);
		if (startup) {
			this.startups.delete(process.pid);
			clearTimeout(startup.timer);
			startup.up.complete();
		}
	}

	/** How long the core waits, as the person sets it now. */
	private timing(): Timing {
		return this.context.timing?.() ?? { startTimeoutMs: START_TIMEOUT_MS };
	}

	/** Whether the window is open and `process` has not exited: what is done for it goes on. */
	private isRunning(process: Process): boolean {
		return !this.disposed && isLive(this.context.table.get(process.pid));
	}

	/**
	 * Puts files into a folder for an agent of `cli`, kept out of git; where one may not go, the agent is
	 * not started, and the error says why.
	 */
	private async inject(folder: string, files: readonly Injected[], cli: string): Promise<void> {
		if (!files.length) {
			return;
		}
		const { git } = this.context.ports;
		const paths = files.map(file => file.path);
		const [exclude, tracked] = await Promise.all([git.excludeOf(folder), git.tracks(folder, paths)]);
		const untracked = exclude ? await git.untrackedAnywhere(folder, paths) : new Set<string>();
		this.stillOpen();
		this.context.injections.put(folder, files, { exclude, tracked, untracked }, cli);
	}

	/** Runs `work` on its own: should it fail, the log says what failed and why, and nothing is left unhandled. */
	private background(what: string, work: Promise<unknown>): void {
		work.catch(err => this.context.log(`${what} failed: ${messageOf(err)}`));
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
	}
}

function didNotStart(cli: AgentCli, process: Process, reason: string): FacadeError {
	return new FacadeError('FAILED', `${cli.displayName} did not start as @${process.name} (PID ${process.pid}): ${reason}`);
}
