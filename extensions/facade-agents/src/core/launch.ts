/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise, timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { AgentCli, Connection, Environment, Injected, InstalledCli, LaunchInput, LaunchSpec } from '../clis/cli';
import { launchTarget, unsafeForCmd } from '../clis/executable';
import { trustTarget } from '../clis/trust';
import { AgentTable } from '../record/agents';
import { Agent, agentRef, Caller, describe, Ignored, isLive, messageRef, PERSON } from '../record/events';
import { FacadeError } from './errors';
import { InjectionGit, Injections, InjectionUser } from './injections';
import { AgentSetup, CliCatalog, Disposable, Ports, Timing } from './ports';

/**
 * How long Facade waits where the person sets nothing else: two minutes, for a new agent to come up,
 * and for an agent's MCP server to find the window again.
 */
export const START_TIMEOUT_MS = 120_000;

/** A start, as `start_agent` or the person decided it, with the settings read as it was accepted. */
export interface Run {
	readonly name: string;
	/** As the caller gave them; none for the CLI's own. One in `ignored` is recorded, and not given to the CLI. */
	readonly model?: string;
	readonly effort?: string;
	/** What the caller gave and the CLI's launch has no group for: left out, and said. */
	readonly ignored: readonly Ignored[];
	readonly task?: string;
	readonly worktree: string;
	readonly folder: string;
	/** Its YOLO: the setting for the person's, its creator's for an agent's. */
	readonly yolo: boolean;
	/** Whether the agent framework's integration goes into the launch: the framework was on, and the CLI's launch connects it. */
	readonly integration: boolean;
}

/**
 * The plan of an agent's launch, which its run's `launch.json` holds: what its terminal runs, and the
 * delays its task notice is typed with, from the settings as they were when its start was accepted.
 */
interface LaunchPlan {
	readonly program: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** What its launch sets in its environment: not Facade's own variables, which carry its token. */
	readonly environment: { readonly [name: string]: string };
	readonly enterDelay: number;
	readonly taskDelay: number;
}

/** The notice of an agent's task: who it is, and where its task's message is (AGENT-LAUNCHER.md, L9). */
function taskNotice(opening: string, message: number, file: string): string {
	return `${opening} Your task is message ${messageRef(message)}, in ${file}: read that file, then do what it says.`;
}

/** How a launch came out: the agent started, or its start is not confirmed - the timeout over - and why. */
export interface Launched {
	readonly agent: Agent;
	readonly status: 'started' | 'unconfirmed';
	readonly why?: string;
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
	/** Ends an agent whose launch failed before it had a process: recorded as failed, its terminal closed. */
	fail(agent: Agent, reason: string): Promise<void>;
	log(message: string): void;
}

/** An agent on its way up, a start waiting for it. */
interface Startup {
	/**
	 * Settles once the agent has started - its MCP server said hello, and it was told of its task where it is
	 * told in its terminal - or, with why, once its start is not confirmed; rejects once it ended.
	 */
	readonly up: DeferredPromise<{ readonly why?: string }>;
	/** Answers the start as not confirmed once its time is over; cleared by its MCP server's hello. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The caller whose start waits for it. */
	readonly waiter: Caller;
	/** Whether nobody waits for the start's answer - the person's own, from the agent menu - so that the person is told should it not be confirmed. */
	readonly tell: boolean;
}

/**
 * Launches agents: each recorded, its CLI started in its terminal, and waited for until it has started -
 * its MCP server said hello and, for a CLI told of its task in its terminal, the line telling it was typed;
 * for a launch without the agent framework's integration, its process running - for the time the person
 * gives it. A start not confirmed by then answers so, the agent left starting; the person is told of one of
 * theirs, once, and its later start needs no word. After a reload, an agent found starting is let start,
 * and one not yet told of its task is told.
 */
export class Launcher implements Disposable {

	/** The agents on their way up whose starts wait for them, by number. */
	private readonly startups = new Map<number, Startup>();
	/** The agents whose task notice is being typed into their terminals, by number: once each. */
	private readonly typing = new Set<number>();
	private disposed = false;

	constructor(private readonly context: LaunchContext) { }

	dispose(): void {
		this.disposed = true;
		for (const startup of this.startups.values()) {
			clearTimeout(startup.timer);
			startup.up.error(new FacadeError('UNAVAILABLE', 'The window closed meanwhile: whether the agent came up is not known. list_agents says, once the window is back.'));
		}
		this.startups.clear();
	}

	/**
	 * Throws where `installed` could not be started for `run` as the person has it set up, in its
	 * environment `env` - a `${name}` its launch or its trust has no value for, or an argument that would not
	 * reach a CLI Windows starts through cmd.exe as it is - so that a start refuses before anything is made
	 * for it; answers with the files its launch puts into its folder, which are the same for every agent of
	 * the CLI. The launch is computed, not run; the model and the effort are the CLI's to take or refuse.
	 */
	check(installed: InstalledCli, run: Omit<Run, 'name' | 'worktree'>, env: Environment): readonly Injected[] {
		const { setup, table } = this.context;
		// Its notice as a stand-in's: Facade's own words, and names cmd.exe takes as they are.
		const opening = setup.opening({ id: 1, name: 'check', cliName: installed.cli.displayName }, PERSON);
		try {
			const { spec } = this.launchOf(installed, {
				folder: run.folder,
				yolo: run.yolo,
				...(run.task !== undefined ? { task: taskNotice(opening, 1, path.join(table.dir, 'messages', '1.md')) } : {}),
				...applied(run),
				// What goes into the folder as the launch will put it: a server the same for every agent, and the skills.
				...(run.integration ? { connection: installed.cli.sharedServer ? { mcp: setup.sharedMcpServer(), values: {} } : setup.connection(path.join(table.runsDir, 'check.token')) } : {}),
				skills: run.integration ? setup.skills() : [],
				runDir: table.runsDir,
				slug: 'check'
			});
			trustTarget(installed.cli, installed.config, { folder: run.folder, repository: run.folder }, env);
			return spec.injected;
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `${installed.cli.displayName} cannot be started as its settings are: ${messageOf(err)}`);
		}
	}

	/**
	 * Refuses, naming the file, a start whose `files` could not go into its folder as things are: one of the
	 * person's that cannot take Facade's part, or one other agents use with other content.
	 */
	checkFiles(installed: InstalledCli, files: readonly Injected[], folder: string | undefined): void {
		// A new worktree, not made yet, has nothing of anyone's in it but what its commit has, which is merged into.
		if (!files.length || folder === undefined) {
			return;
		}
		this.stillOpen();
		try {
			this.context.injections.check(folder, files, installed.cli.displayName);
		} catch (err) {
			throw new FacadeError('REFUSED', messageOf(err));
		}
	}

	/**
	 * Records `run` as a new agent of the caller, starts its CLI in its terminal, and - with `wait` - waits
	 * until it has started, or its time is over. Should its launch fail on the way, or its process end before
	 * it started, the agent is ended as failed, and the call fails with why. Without `wait` it answers once
	 * its terminal runs, the agent starting; the person is told should its start not be confirmed in time.
	 */
	async launch(caller: Caller, installed: InstalledCli, run: Run, options: { readonly wait: boolean; readonly progress?: (message: string) => void }): Promise<Launched> {
		const { table, ports, setup } = this.context;
		const { cli } = installed;
		this.stillOpen();
		const notice = run.task === undefined ? undefined : cli.task === 'terminal' ? 'typed' : 'argument';
		const creator = caller.id === undefined ? undefined : table.get(caller.id);
		const started = table.start({
			name: run.name,
			creator: caller.id,
			cli: cli.id,
			custom: !!cli.custom,
			...(run.model !== undefined ? { model: run.model } : {}),
			...(run.effort !== undefined ? { effort: run.effort } : {}),
			ignored: run.ignored,
			yolo: run.yolo,
			sandbox: run.yolo ? cli.sandbox.yoloOn : cli.sandbox.yoloOff,
			integration: run.integration,
			worktree: run.worktree,
			folder: run.folder,
			...(run.task !== undefined && notice ? { task: { text: run.task, notice } } : {})
		});
		const { agent } = started;
		const label = describe(agent);
		const opening = setup.opening({ id: agent.id, name: agent.name, cliName: cli.displayName }, creator ?? PERSON);
		const startup = this.watch(agent, caller, run.integration, !options.wait);
		try {
			const connection: Connection | undefined = !run.integration ? undefined : cli.sharedServer ? { mcp: setup.sharedMcpServer(), values: {} } : setup.connection(started.tokenFile);
			const { spec, args, throughCmd } = this.launchOf(installed, {
				folder: run.folder,
				yolo: run.yolo,
				...(notice === 'argument' && agent.taskMessage !== undefined ? { task: taskNotice(opening, agent.taskMessage, table.messageFileOf(agent.taskMessage)) } : {}),
				...applied(run),
				...(connection ? { connection } : {}),
				skills: run.integration ? setup.skills() : [],
				runDir: table.runsDir,
				slug: String(agent.id)
			});
			const { enterDelay, taskDelay } = installed.config.launch;
			const plan: LaunchPlan = { program: spec.executable, args, cwd: spec.cwd, environment: spec.env, enterDelay, taskDelay };
			for (const file of [...spec.files, { path: table.launchFileOf(agent.id), content: JSON.stringify(plan, undefined, '\t') }]) {
				fs.mkdirSync(path.dirname(file.path), { recursive: true });
				fs.writeFileSync(file.path, file.content, { mode: 0o600 });
			}
			const user = { workspace: table.dir, id: agent.id };
			await this.inject(run.folder, spec.injected, cli.displayName, user);
			this.stillOpen();
			// A server the same for every launch finds the agent from its environment.
			const env = cli.sharedServer && run.integration ? { ...spec.env, ...setup.agentEnv(started.token) } : spec.env;
			this.context.log(`Starting ${label} (${cli.displayName}) in ${run.folder}, the worktree ${run.worktree}, YOLO ${run.yolo ? 'on' : 'off'}${run.integration ? '' : ', without Facade\'s tools'}${throughCmd ? ', through cmd.exe' : ''}.`);
			options.progress?.(`Starting ${label}.`);
			const { processId } = await ports.terminals.launch({ id: agent.id, name: label, command: cli.custom ? spec.executable : cli.command, executable: spec.executable, args, env, cwd: spec.cwd, reveal: caller.id === undefined && !options.wait });
			if (processId !== undefined) {
				table.launched(agent.id, processId);
				if (spec.injected.length) {
					this.context.injections.launched(user, processId);
				}
			} else if (spec.injected.length) {
				this.context.log(`${label}'s process has not said its id: what Facade put into ${run.folder} for it stays while its window is open.`);
			}
		} catch (err) {
			// A window that closed leaves it to the next one: starting, or gone with its terminal.
			if (err instanceof FacadeError && err.code === 'UNAVAILABLE') {
				throw err;
			}
			await this.context.fail(agent, messageOf(err));
			throw didNotStart(cli, agent, messageOf(err));
		}
		// A launch without Facade's integration has started once its process runs.
		if (!run.integration) {
			this.isUp(agent);
		}
		if (!options.wait) {
			return { agent: table.get(agent.id) ?? agent, status: 'started' };
		}
		options.progress?.(`Waiting for @${agent.name} to start.`);
		let up: { readonly why?: string };
		try {
			up = await startup.up.p;
		} catch (err) {
			throw err instanceof FacadeError ? err : didNotStart(cli, agent, messageOf(err));
		}
		return { agent: table.get(agent.id) ?? agent, status: up.why === undefined ? 'started' : 'unconfirmed', ...(up.why !== undefined ? { why: up.why } : {}) };
	}

	/** A starting agent's MCP server said hello: it is connected, and is told of its task where it is told in its terminal. */
	hello(agent: Agent): void {
		if (this.disposed || agent.state !== 'starting') {
			return;
		}
		this.context.table.connected(agent.id);
		this.context.log(`${describe(agent)} is connected: its MCP server said hello.`);
		const startup = this.startups.get(agent.id);
		if (startup) {
			clearTimeout(startup.timer);
			startup.timer = undefined;
		}
		this.bringUp(agent);
	}

	/**
	 * After a reload: an agent whose MCP server said hello is brought up - told its task, where that was
	 * not typed yet. One whose server has not said hello starts once it does; one launched without Facade's
	 * integration is running already.
	 */
	resume(agent: Agent): void {
		if (!this.isRunning(agent)) {
			return;
		}
		if (!agent.integration) {
			this.isUp(agent);
		} else if (agent.connected) {
			this.bringUp(agent);
		}
	}

	/** The caller whose start waits for the agent `id` to come up, if one does. */
	waiterOf(id: number): Caller | undefined {
		return this.startups.get(id)?.waiter;
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

	/** An agent ended: the start that waits for it fails with why. */
	ended(id: number, reason: string): void {
		const startup = this.startups.get(id);
		if (startup) {
			this.startups.delete(id);
			clearTimeout(startup.timer);
			startup.up.error(new Error(reason));
		}
	}

	/**
	 * Waits for a starting agent to start, for the time it has: then its start answers that it is not
	 * confirmed, and the agent is left starting - it may be slow, or waiting for an answer on its screen.
	 * Where nobody waits for that answer - the person's own start, from the agent menu - the person is told,
	 * once, with a way to its terminal; a script's start that waits answers the script instead.
	 */
	private watch(agent: Agent, waiter: Caller, integration: boolean, tell: boolean): Startup {
		const ms = this.timing().startTimeoutMs;
		const startup: Startup = {
			up: new DeferredPromise<{ readonly why?: string }>(),
			timer: setTimeout(() => {
				startup.timer = undefined;
				this.unconfirmed(agent, integration
					? `it has not started within ${Math.round(ms / 1000)} seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen`
					: `its process has not started within ${Math.round(ms / 1000)} seconds`);
			}, ms),
			waiter,
			tell
		};
		// Seen by the start that waits for it: never a rejection nobody handles.
		startup.up.p.catch(() => undefined);
		this.startups.set(agent.id, startup);
		return startup;
	}

	/** The start waiting for `agent` answers that it is not confirmed, saying why; the agent stays starting. */
	private unconfirmed(agent: Agent, why: string): void {
		const startup = this.startups.get(agent.id);
		if (!startup) {
			return;
		}
		this.startups.delete(agent.id);
		clearTimeout(startup.timer);
		this.context.log(`${describe(agent)} is not confirmed to have started: ${why}.`);
		if (startup.tell && this.isRunning(agent)) {
			// One nonmodal notice for the person's own: its terminal stays theirs to use (AGENT-LAUNCHER.md, L5).
			this.context.ports.person.tell(l10n.t("{0} is open, but has not connected to Facade: it has no Facade tools yet. It may be slow, or waiting for an answer on its screen.", describe(agent)), agent.id);
		}
		startup.up.complete({ why });
	}

	/**
	 * Tells a connected agent of its task where it is told in its terminal, once; then it is up. A notice
	 * whose typing was cut short is not typed again: it may have reached the CLI, whole or in part.
	 */
	private bringUp(agent: Agent): void {
		if (agent.task !== 'pending') {
			this.isUp(agent);
		} else if (!this.typing.has(agent.id)) {
			this.typing.add(agent.id);
			this.background(`Telling ${describe(agent)} of its task`, this.typeTask(agent).finally(() => this.typing.delete(agent.id)));
		}
	}

	/**
	 * Types the notice of an agent's task - its opening, and where its task's message is - into its terminal,
	 * its task delay after its MCP server's hello, and presses Enter after its enter delay, each as its launch
	 * had it. One that cannot be told stays starting, and its start answers why.
	 */
	private async typeTask(agent: Agent): Promise<void> {
		const { table, ports } = this.context;
		try {
			const cli = this.cliOf(agent.cli);
			if (agent.taskMessage === undefined) {
				throw new Error('it has no task message');
			}
			// A list cleared keeps the creator of every agent that has not ended.
			const creator = agent.creator === undefined ? PERSON : table.get(agent.creator);
			if (!creator) {
				throw new Error(`its creator ${agentRef(agent.creator ?? 0)} is not in the list`);
			}
			const line = taskNotice(this.context.setup.opening({ id: agent.id, name: agent.name, cliName: cli?.displayName ?? agent.cli }, creator), agent.taskMessage, table.messageFileOf(agent.taskMessage));
			// Its delays as its start had them, whatever the settings say now.
			const { taskDelay, enterDelay } = delaysOf(table.launchFileOf(agent.id));
			await timeout(taskDelay);
			if (!this.isRunning(agent)) {
				return;
			}
			table.taskTyping(agent.id);
			if (!await ports.terminals.type(agent.id, line)) {
				throw new Error('its terminal was not there');
			}
			await timeout(enterDelay);
			if (!this.isRunning(agent)) {
				return;
			}
			await ports.terminals.type(agent.id, '\r');
			if (!this.isRunning(agent)) {
				return;
			}
			table.taskTyped(agent.id);
			this.context.log(`${describe(agent)} was told of its task, message ${messageRef(agent.taskMessage)}.`);
			this.isUp(agent);
		} catch (err) {
			this.unconfirmed(agent, `the notice of its task could not be typed into its terminal: ${messageOf(err)}`);
		}
	}

	/** An agent has started: the start that waits for it answers. */
	private isUp(agent: Agent): void {
		this.context.table.running(agent.id);
		const startup = this.startups.get(agent.id);
		if (startup) {
			this.startups.delete(agent.id);
			clearTimeout(startup.timer);
			startup.up.complete({});
		}
	}

	/** A CLI by its id: a built-in, or a custom agent's name. */
	private cliOf(id: string): AgentCli | undefined {
		return this.context.clis.known.find(each => each.id === id) ?? this.context.clis.custom().find(each => each.cli.id === id)?.cli;
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
	 * Puts files into a folder for `user`, an agent of `cli`, kept out of git; where one may not go, the
	 * agent is not started, and the error says why.
	 */
	private async inject(folder: string, files: readonly Injected[], cli: string, user: InjectionUser): Promise<void> {
		if (!files.length) {
			return;
		}
		const git = await this.gitOf(folder, files.map(file => file.path));
		this.stillOpen();
		this.context.injections.put(folder, files, git, cli, user);
	}

	/** What git says of `folder`, for the files at `paths` in it. */
	private async gitOf(folder: string, paths: readonly string[]): Promise<InjectionGit> {
		const { git } = this.context.ports;
		const [exclude, tracked] = await Promise.all([git.excludeOf(folder), git.tracks(folder, paths)]);
		const untracked = exclude ? await git.untrackedAnywhere(folder, paths) : new Set<string>();
		return { exclude, tracked, untracked };
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

/** The model and the effort a launch gives its CLI: those the caller gave that its launch has a group for. */
function applied(run: Pick<Run, 'model' | 'effort' | 'ignored'>): { readonly model?: string; readonly effort?: string } {
	return {
		...(run.model !== undefined && !run.ignored.includes('model') ? { model: run.model } : {}),
		...(run.effort !== undefined && !run.ignored.includes('effort') ? { effort: run.effort } : {})
	};
}

/** The delays a launch's task notice is typed with, as its run's `launch.json` holds them; throws where it cannot be read. */
function delaysOf(file: string): Pick<LaunchPlan, 'enterDelay' | 'taskDelay'> {
	const plan: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!isJsonObject(plan) || typeof plan.enterDelay !== 'number' || typeof plan.taskDelay !== 'number') {
		throw new Error(`${file} holds no plan of a launch`);
	}
	return { enterDelay: plan.enterDelay, taskDelay: plan.taskDelay };
}

function didNotStart(cli: AgentCli, agent: Agent, reason: string): FacadeError {
	return new FacadeError('FAILED', `${cli.displayName} did not start as ${describe(agent)}: ${reason}`);
}
