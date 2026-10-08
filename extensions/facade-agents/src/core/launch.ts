/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentCli, Environment, Injected, InstalledCli, LaunchInput, LaunchSpec } from '../clis/cli';
import { launchTarget, unsafeForCmd } from '../clis/executable';
import { trustTarget } from '../clis/trust';
import { AgentTable } from '../record/agents';
import { Agent, Caller, isLive } from '../record/events';
import { Message } from '../record/messages';
import { FacadeError } from './errors';
import { Injections } from './injections';
import { AgentSetup, CliCatalog, Disposable, Ports, Timing } from './ports';

/**
 * How long Facade waits where the person sets nothing else: two minutes, for a new agent to come up,
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
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	readonly injections: Injections;
	/** How long the core waits, as the person sets it. */
	readonly timing?: () => Timing;
	/** The name of the terminal an agent runs in. */
	terminalOf(agent: Agent): string;
	/** Ends an agent that did not come up: recorded as failed, its terminal closed. */
	fail(agent: Agent, reason: string): Promise<void>;
	/** Records the task the caller gives a new agent: a message to it, sent right after it was recorded. */
	sendTask(caller: Caller, agent: Agent, task: string): Message;
	/** Records that an agent's first line, given as its launch argument, rang for its task. */
	firstRing(agent: Agent, task: number): void;
	/** An agent is running: its MCP server said hello. */
	running(agent: Agent): void;
	log(message: string): void;
}

/** A child as `launch` answers with it: the agent, and the number of its task. */
export interface Launched {
	readonly agent: Agent;
	readonly task?: number;
}

/** An agent on its way up. */
interface Startup {
	/** Settles once the agent is up - its MCP server said hello - or once it exited. */
	readonly up: DeferredPromise<void>;
	/** Ends it as failed once its time to come up is over. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether a start waits for it, and says how it went: not one found starting after a reload. */
	readonly waited: boolean;
}

/**
 * Launches children: each recorded, its task sent to it as a message, its CLI started in its terminal
 * with its first line, and waited for until it is up: its MCP server said hello. A CLI that is told of
 * its task in its terminal has its first line typed by its doorbell (AGENT-MESSAGES.md M7). After a
 * reload, an agent found starting is waited for again, by no start.
 */
export class Launcher implements Disposable {

	/** The agents on their way up, by number. */
	private readonly startups = new Map<number, Startup>();
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
	 * Throws where `installed` could not be started on `model` at `effort` as the person has it set up, in
	 * its environment `env` - a `${name}` its launch or its trust has no value for, or an argument that
	 * would not reach a CLI Windows starts through cmd.exe as it is - so that a spawn refuses before
	 * anything is made for it. The launch is computed, not run, with a first line as a task's would be;
	 * the model and the effort are the CLI's to take or refuse.
	 */
	check(installed: InstalledCli, model: string, effort: string, folder: string, caller: Caller, env: Environment): void {
		const { cli } = installed;
		try {
			this.launchOf(installed, {
				folder,
				// The arguments for a worktree Facade made are checked too.
				trusted: true,
				...(cli.task === 'argument' ? { prompt: this.context.setup.firstLine({ id: 1, name: 'check' }, caller, 1) } : {}),
				model,
				effort,
				mcp: { command: 'facade', args: [], env: {} },
				skills: [],
				runDir: this.context.table.runsDir,
				messagesDir: this.context.table.messages.folder,
				slug: 'check'
			});
			trustTarget(installed.cli, installed.config, { folder, repository: folder }, env);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `${installed.cli.displayName} cannot be started as its settings are: ${messageOf(err)}`);
		}
	}

	/**
	 * Records `run` as a new child of the caller, sends it its task, starts its CLI in its terminal, and
	 * waits until it is up. Should anything fail on the way, the child is ended as failed, and the call
	 * fails with why.
	 */
	async launch(caller: Caller, installed: InstalledCli, run: Run, progress: ((message: string) => void) | undefined): Promise<Launched> {
		const { table, ports, setup } = this.context;
		const { cli } = installed;
		this.stillOpen();
		const started = table.start({ name: run.name, parent: caller.id, cli: cli.id, model: run.model, effort: run.effort, worktree: run.worktree, folder: run.folder, yolo: !!installed.config.launch.arguments.fullAccess?.length });
		const { agent } = started;
		const startup = this.watch(agent, true);
		const terminal = this.context.terminalOf(agent);
		if (caller.id !== undefined && !isLive(table.get(caller.id))) {
			ports.person.tell(l10n.t("@{0} #a{1} ended while it started @{2} #a{3}, which is yours now.", caller.name, caller.id, agent.name, agent.id), terminal);
		}
		let task: Message | undefined;
		try {
			// Its task's text never goes on a command line: its first line names it, and a CLI whose first
			// conversation has no MCP tools has that line typed by its doorbell once it is running
			task = run.prompt === undefined ? undefined : this.context.sendTask(caller, agent, run.prompt);
			const firstLine = task && cli.task === 'argument' ? setup.firstLine({ id: agent.id, name: agent.name }, caller, task.id) : undefined;
			const { spec, args, throughCmd } = this.launchOf(installed, {
				folder: run.folder,
				trusted: run.trusted,
				...(firstLine !== undefined ? { prompt: firstLine } : {}),
				model: run.model,
				effort: run.effort,
				mcp: cli.sharedServer ? setup.sharedMcpServer() : setup.mcpServer(started.tokenFile),
				skills: setup.skills(),
				runDir: table.runsDir,
				messagesDir: table.messages.folder,
				slug: String(agent.id)
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
			progress?.(`Starting @${agent.name} #a${agent.id}.`);
			await ports.terminals.launch({ name: terminal, command: cli.command, executable: spec.executable, args, env, cwd: spec.cwd, reveal: caller.id === undefined });
		} catch (err) {
			// A window that closed leaves it to the next one: starting, or gone with its terminal.
			if (err instanceof FacadeError && err.code === 'UNAVAILABLE') {
				throw err;
			}
			await this.context.fail(agent, messageOf(err));
			throw didNotStart(cli, agent, messageOf(err));
		}
		if (task && cli.task === 'argument') {
			try {
				this.context.firstRing(agent, task.id);
			} catch (err) {
				// Its doorbell types its first line again: a line twice is no harm
				this.context.log(`That ${terminal} was given its first line could not be recorded: ${messageOf(err)}`);
			}
		}
		progress?.(`Waiting for @${agent.name} to come up.`);
		try {
			await startup.up.p;
		} catch (err) {
			throw err instanceof FacadeError ? err : didNotStart(cli, agent, messageOf(err));
		}
		return { agent, ...(task ? { task: task.id } : {}) };
	}

	/** A starting agent's MCP server said hello: it is running, and up. */
	hello(agent: Agent): void {
		if (this.disposed || agent.state !== 'starting') {
			return;
		}
		this.context.table.setRunning(agent.id);
		this.context.log(`${this.context.terminalOf(agent)} is running: its MCP server said hello.`);
		this.isUp(agent);
		const running = this.context.table.get(agent.id);
		if (running) {
			this.context.running(running);
		}
	}

	/** After a reload: an agent that was starting is waited for again, though no start waits for it. */
	resume(agent: Agent): void {
		if (this.isRunning(agent) && agent.state === 'starting' && !this.startups.has(agent.id)) {
			this.watch(agent, false);
		}
	}

	/** Whether a start waits for the agent `id` to come up: then that start says how it went. */
	isWaited(id: number): boolean {
		return !!this.startups.get(id)?.waited;
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

	/** An agent exited: the spawn that waits for it fails with why. */
	ended(id: number, reason: string): void {
		const startup = this.startups.get(id);
		if (startup) {
			this.startups.delete(id);
			clearTimeout(startup.timer);
			startup.up.error(new Error(reason));
		}
	}

	/** Waits for a starting agent to come up, for the time it has: then it is ended as failed. `waited`: a start waits for it. */
	private watch(agent: Agent, waited: boolean): Startup {
		const ms = this.timing().startTimeoutMs;
		const startup: Startup = {
			up: new DeferredPromise<void>(),
			timer: setTimeout(() => {
				startup.timer = undefined;
				if (this.context.table.get(agent.id)?.state === 'starting') {
					this.background(`Ending ${this.context.terminalOf(agent)}`, this.context.fail(agent, `it did not come up within ${Math.round(ms / 1000)} seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal`));
				}
			}, ms),
			waited
		};
		// Seen by the spawn that waits for it, if one does: never a rejection nobody handles.
		startup.up.p.catch(() => undefined);
		this.startups.set(agent.id, startup);
		return startup;
	}

	/** An agent is up: the spawn that waits for it answers. */
	private isUp(agent: Agent): void {
		const startup = this.startups.get(agent.id);
		if (startup) {
			this.startups.delete(agent.id);
			clearTimeout(startup.timer);
			startup.up.complete();
		}
	}

	/** How long the core waits, as the person sets it now. */
	private timing(): Timing {
		return this.context.timing?.() ?? { startTimeoutMs: START_TIMEOUT_MS };
	}

	/** Whether the window is open and `agent` has not exited: what is done for it goes on. */
	private isRunning(agent: Agent): boolean {
		return !this.disposed && isLive(this.context.table.get(agent.id));
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

function didNotStart(cli: AgentCli, agent: Agent, reason: string): FacadeError {
	return new FacadeError('FAILED', `${cli.displayName} did not start as @${agent.name} #a${agent.id}: ${reason}`);
}
