/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise, timeout } from '../base/async';
import { clauseOf, messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { AgentCli, Connection, Environment, Injected, InstalledCli, LaunchInput, LaunchSpec, launchFor, sandboxOf } from '../clis/cli';
import { launchTarget, unsafeForCmd } from '../clis/executable';
import { trustTarget } from '../clis/trust';
import { AgentTable, agentName, StartedAgent } from '../record/agents';
import { Agent, agentRef, Caller, describe, Ignored, isLive, messageRef, PERSON, StartPhase } from '../record/events';
import { FacadeError } from './errors';
import { InjectionGit, Injections, InjectionUser } from './injections';
import { AgentSetup, CliCatalog, Disposable, Ports, Timing } from './ports';

/**
 * How long Facade waits where the person sets nothing else: two minutes, for a new agent to come up,
 * and for an agent's MCP server to find the window again.
 */
export const START_TIMEOUT_MS = 120_000;

/**
 * Why `name` cannot be a custom agent's, as a clause for the list of what its settings have wrong: not an
 * agent's name, or a built-in's id, by which agents start a built-in. Undefined where it can be.
 */
export function customAgentNameProblem(name: string, builtIns: ReadonlySet<string>): string | undefined {
	if (builtIns.has(name)) {
		return `${name} is a built-in's id, by which agents start it: give the custom agent another name`;
	}
	try {
		return agentName(name) === name ? undefined : `"${name}" is not a name as an agent's is`;
	} catch (err) {
		// The name's own refusal is a sentence; in the list it is one clause among others (N-56)
		return clauseOf(messageOf(err));
	}
}

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
	/** Its folder is in no Git repository: it has no worktree or branch (N-05). */
	readonly outsideGit?: boolean;
	/** The home folder, as the environment its terminal starts with has it (X-58). */
	readonly home?: string;
	/** What its caller is told of its launch as it is accepted - what takes away its exemption, say - and the log says. */
	readonly notes?: readonly string[];
	readonly folder: string;
	/** The main checkout of its folder's repository, which its CLI is given the person's trust in; the folder itself outside any. */
	readonly repository: string;
	/** Its YOLO: the setting for the person's, its creator's for an agent's. */
	readonly yolo: boolean;
	/**
	 * Whether nobody may be watching it: started through `start_agent` - by an agent, or by the person's scripts -
	 * not by the person from the UI; it runs with its launch's unattended part (AGENT-LAUNCHER.md, L4).
	 */
	readonly unattended: boolean;
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

/**
 * Whether an agent with no task is given its opening alone as its argument - who it is, and to ask in words: one
 * started through `start_agent` of a CLI that takes its notice as an argument and keeps its question tool, which
 * nothing else it is sure to read would tell it (L4; N-71).
 */
function opensAlone(cli: AgentCli, unattended: boolean): boolean {
	return unattended && cli.task === 'argument' && cli.questionTool === 'kept';
}

/** How a launch came out: the agent started, or its start is not confirmed - the timeout over - and why. */
export interface Launched {
	readonly agent: Agent;
	readonly status: 'started' | 'unconfirmed';
	readonly why?: string;
	/** What its preparation came to that its caller is told: its setup's outcome, what could not be copied, a failed hook. */
	readonly notes: readonly string[];
}

/** How the folder of a start is prepared before its CLI: its worktree made and set up. */
export interface Prepared {
	/** Where it runs: the worktree, where it was made. */
	readonly folder: string;
	/** What its caller is told of it. */
	readonly notes: readonly string[];
	/** What the agent is told of it with its task: that its setup's completion is not known. */
	readonly startNote?: string;
}

/** How `launch` goes. */
export interface LaunchOptions {
	/** Whether its caller waits until it has started; else, once its terminal runs. */
	readonly wait: boolean;
	/** Word of how it goes; with the run's number once it is recorded, for a caller whose call is cut after to name it. */
	readonly progress?: (message: string, agent?: number) => void;
	/** When its start was accepted: its time counts from then (AGENT-ORCHESTRATION.md, O9); now, where not given. */
	readonly acceptedAt?: number;
	/** Prepares its folder - its worktree made and set up - recording each phase, once it is recorded. */
	readonly prepare?: (agent: Agent) => Promise<Prepared>;
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
	/**
	 * Whether the start's caller hears how it goes: a tool call's throughout; the person's own, from the
	 * agent menu, only until its terminal is up - from then on, the person is told.
	 */
	answered: boolean;
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
	/** The launches under way, by number: each settles once its terminal is open, or it gave up. */
	private readonly opening = new Map<number, Promise<void>>();
	/** The agents whose task notice is being typed into their terminals, by number: once each. */
	private readonly typing = new Set<number>();
	/** What each start's preparation came to that its caller is told, by number. */
	private readonly notes = new Map<number, readonly string[]>();
	/** What each agent is told of its preparation with its task, by number. */
	private readonly startNotes = new Map<number, string>();
	private disposed = false;

	constructor(private readonly context: LaunchContext) { }

	dispose(): void {
		this.disposed = true;
		for (const [id, startup] of this.startups) {
			clearTimeout(startup.timer);
			startup.up.error(new FacadeError('UNAVAILABLE', 'The window closed meanwhile: whether the agent came up is not known. list_agents says, once the window is back.', { outcome: 'unknown', agent: id }));
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
		let conflict: string | undefined;
		let injected: readonly Injected[];
		try {
			const { spec } = this.launchOf(installed, {
				folder: run.folder,
				repository: run.repository,
				...(run.home !== undefined ? { home: run.home } : {}),
				messagesDir: table.messagesDir,
				yolo: run.yolo,
				unattended: run.unattended,
				...(run.task !== undefined ? { task: taskNotice(opening, 1, path.join(table.dir, 'messages', '1.md')) } : opensAlone(installed.cli, run.unattended) ? { task: opening } : {}),
				...applied(run),
				// What goes into the folder as the launch will put it: a server the same for every agent, and the skills.
				...(run.integration ? { connection: installed.cli.sharedServer ? { mcp: setup.sharedMcpServer(), values: {} } : setup.connection(path.join(table.runsDir, 'check.token')) } : {}),
				skills: run.integration ? setup.skills() : [],
				runDir: table.runsDir,
				slug: 'check'
			});
			trustTarget(installed.cli, launchFor(installed.config, run.unattended), { folder: run.folder, repository: run.repository }, env);
			conflict = installed.cli.conflict?.(spec.args, run.folder, env);
			injected = spec.injected;
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `${installed.cli.displayName} cannot be started as its settings are: ${messageOf(err)}`);
		}
		// The person's own configuration of it, which the launch would mix Facade's into (X-47)
		if (conflict) {
			throw new FacadeError('UNAVAILABLE', `${installed.cli.displayName} cannot be started: ${conflict}`);
		}
		return injected;
	}

	/**
	 * Refuses, naming the file, a start whose `files` could not go into its folder as things are: one of the
	 * person's that cannot take Facade's part, or one other agents use with other content.
	 */
	checkFiles(installed: InstalledCli, files: readonly Injected[], folder: string | undefined): void {
		// A new worktree, not made yet, has nothing of anyone's in it but what its commit has: `checkCommitted`'s.
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
	 * Refuses, naming the file, a start in a new worktree - to be made at `folder`, from `commit` of the
	 * repository whose main checkout is `main` - whose `files` could not go into it as that commit has them:
	 * one there that cannot take Facade's part. Before the worktree is made, as in an existing folder (X-30).
	 */
	async checkCommitted(installed: InstalledCli, files: readonly Injected[], main: string, commit: string, folder: string): Promise<void> {
		for (const file of files) {
			const committed = await this.context.ports.git.fileAt(main, commit, file.path);
			if (committed !== undefined && file.merge?.(committed) === undefined) {
				throw new FacadeError('REFUSED', `${installed.cli.displayName} is not started: ${path.join(folder, file.path)} is in the commit its worktree would start at, and Facade does not write over it. Nothing was made.`);
			}
		}
	}

	/**
	 * Records `run` as a new agent of the caller, prepares its folder where `prepare` says how - its
	 * worktree made and set up (AGENT-ORCHESTRATION.md, O4) - starts its CLI in its terminal, and - with
	 * `wait` - waits until it has started, or its time is over: counted from `acceptedAt`, when the start was
	 * accepted, whatever phase it is in then (O9). Should its preparation or launch fail on the way, or its
	 * process end before it started, the agent is ended as failed, and the call fails with why. Without
	 * `wait` it answers once its terminal runs, the agent starting; from then on the person is told should
	 * its start not be confirmed in time, or its process end before it started. A stop that comes before its
	 * terminal opens ends the start there: no terminal is opened afterwards, in any phase.
	 */
	async launch(caller: Caller, installed: InstalledCli, run: Run, options: LaunchOptions): Promise<Launched> {
		const { table } = this.context;
		const { cli } = installed;
		this.stillOpen();
		const notice = run.task === undefined ? undefined : cli.task === 'terminal' ? 'typed' : 'argument';
		const started = table.start({
			name: run.name,
			creator: caller.id,
			cli: cli.id,
			custom: !!cli.custom,
			...(run.model !== undefined ? { model: run.model } : {}),
			...(run.effort !== undefined ? { effort: run.effort } : {}),
			ignored: run.ignored,
			yolo: run.yolo,
			...(run.unattended ? { unattended: true } : {}),
			// As the launch the person has set up leaves it: never on where its file is left out (X-07)
			sandbox: sandboxOf(cli, launchFor(installed.config, run.unattended), { framework: run.integration, yolo: run.yolo, model: run.model !== undefined && !run.ignored.includes('model'), effort: run.effort !== undefined && !run.ignored.includes('effort'), task: run.task !== undefined, trust: true }),
			integration: run.integration,
			worktree: run.worktree,
			...(run.outsideGit ? { outsideGit: true } : {}),
			folder: run.folder,
			...(run.task !== undefined && notice ? { task: { text: run.task, notice } } : {}),
			phase: options.prepare ? 'creating_worktree' : 'launching_cli'
		});
		const { agent } = started;
		if (run.notes?.length) {
			this.notes.set(agent.id, run.notes);
			run.notes.forEach(note => this.context.log(`${describe(agent)}: ${note}`));
		}
		options.progress?.(`${describe(agent)} is recorded, and starting.`, agent.id);
		const startup = this.watch(agent, run.integration, options.acceptedAt);
		// Prepared and opened on its own: the caller hears whichever comes first - its time over, unconfirmed in
		// whatever phase it is, its start failing, or its terminal open.
		const opening = this.prepareAndOpen(caller, installed, run, started, notice, options);
		opening.catch(() => undefined);
		const first = await Promise.race([opening.then(() => 'opened' as const), startup.up.p.then(up => up, err => { throw err; })]).catch(err => {
			throw this.failureOf(err, cli, agent);
		});
		if (first !== 'opened') {
			return { agent: table.get(agent.id) ?? agent, status: first.why === undefined ? 'started' : 'unconfirmed', ...(first.why !== undefined ? { why: first.why } : {}), notes: this.notes.get(agent.id) ?? [] };
		}
		// A launch without Facade's integration has started once its process runs.
		if (!run.integration) {
			this.isUp(agent);
		}
		if (!options.wait) {
			// Its process may have ended as its terminal opened: the person's start says so, as it would have said a failure before.
			const now = table.get(agent.id) ?? agent;
			if (now.end) {
				throw this.failureOf(didNotStart(cli, agent, now.end.reason), cli, agent);
			}
			// From here on, the person is told how it goes: nobody waits for this start's answer.
			startup.answered = false;
			return { agent: now, status: 'started', notes: this.notes.get(agent.id) ?? [] };
		}
		options.progress?.(`Waiting for @${agent.name} to start.`);
		let up: { readonly why?: string };
		try {
			up = await startup.up.p;
		} catch (err) {
			throw this.failureOf(err, cli, agent);
		}
		return { agent: table.get(agent.id) ?? agent, status: up.why === undefined ? 'started' : 'unconfirmed', ...(up.why !== undefined ? { why: up.why } : {}), notes: this.notes.get(agent.id) ?? [] };
	}

	/**
	 * `launch`'s preparation and its terminal: the folder prepared where `options.prepare` says how, then
	 * its CLI started there. Settles once its terminal runs; rejects, the agent ended as failed, where it
	 * could not be - or where it was stopped meanwhile, ended by its stop.
	 */
	private async prepareAndOpen(caller: Caller, installed: InstalledCli, run: Run, started: StartedAgent, notice: 'typed' | 'argument' | undefined, options: LaunchOptions): Promise<void> {
		const { table, ports, setup } = this.context;
		const { cli } = installed;
		const { agent } = started;
		const label = describe(agent);
		let folder = run.folder;
		try {
			if (options.prepare) {
				const prepared = await options.prepare(agent);
				folder = prepared.folder;
				if (prepared.notes.length) {
					this.notes.set(agent.id, [...this.notes.get(agent.id) ?? [], ...prepared.notes]);
				}
				if (prepared.startNote) {
					this.startNotes.set(agent.id, prepared.startNote);
				}
				this.stillOpen();
				this.assertStarting(agent);
				table.phase(agent.id, 'launching_cli');
			}
			const opened = new DeferredPromise<void>();
			this.opening.set(agent.id, opened.p);
			try {
				const creator = caller.id === undefined ? undefined : table.get(caller.id);
				const opening = this.openingOf(agent, cli, creator);
				const connection: Connection | undefined = !run.integration ? undefined : cli.sharedServer ? { mcp: setup.sharedMcpServer(), values: {} } : setup.connection(started.tokenFile);
				const { spec, args, throughCmd } = this.launchOf(installed, {
					folder,
					repository: run.repository,
					...(run.home !== undefined ? { home: run.home } : {}),
					messagesDir: table.messagesDir,
					yolo: run.yolo,
					unattended: run.unattended,
					...(notice === 'argument' && agent.taskMessage !== undefined ? { task: taskNotice(opening, agent.taskMessage, table.messageFileOf(agent.taskMessage)) } : notice === undefined && opensAlone(cli, run.unattended) ? { task: opening } : {}),
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
				await this.inject(folder, spec.injected, cli.displayName, user);
				this.stillOpen();
				// A server the same for every launch finds the agent from its environment.
				const env = cli.sharedServer && run.integration ? { ...spec.env, ...setup.agentEnv(started.tokenFile) } : spec.env;
				// A stop that came meanwhile ends the start here, before it has a terminal.
				this.assertStarting(agent);
				this.context.log(`Starting ${label} (${cli.displayName}) in ${folder}, ${run.outsideGit ? 'in no Git repository' : `the worktree ${run.worktree}`}, YOLO ${run.yolo ? 'on' : 'off'}${run.integration ? '' : ', without Facade\'s tools'}${throughCmd ? ', through cmd.exe' : ''}.`);
				// The person's history says what it runs: its command line and the settings it is given (UI-14)
				table.launching(agent.id, { program: spec.executable, args, environment: spec.env, files: spec.files.filter(file => args.some(arg => arg.includes(file.path))) });
				options.progress?.(`Starting ${label}.`);
				const { processId } = await ports.terminals.launch({ id: agent.id, name: label, command: cli.custom ? spec.executable : cli.command, ...(cli.custom ? { custom: true } : {}), executable: spec.executable, args, env, cwd: spec.cwd, reveal: caller.id === undefined && !options.wait });
				if (processId !== undefined) {
					table.launched(agent.id, processId);
					if (spec.injected.length) {
						this.context.injections.launched(user, processId);
					}
				} else if (spec.injected.length) {
					this.context.log(`${label}'s process has not said its id: what Facade put into ${folder} for it stays while its window is open.`);
				}
			} finally {
				this.opening.delete(agent.id);
				opened.complete();
			}
		} catch (err) {
			// A window that closed leaves it to the next one: starting, or gone with its terminal.
			if (err instanceof FacadeError && err.code === 'UNAVAILABLE') {
				throw err.outcome ? err : new FacadeError(err.code, err.message, { outcome: 'unknown', agent: agent.id });
			}
			// One stopped meanwhile is the stop's to record.
			if (table.get(agent.id)?.state === 'starting') {
				await this.context.fail(agent, messageOf(err));
			}
			throw err instanceof FacadeError && err.outcome ? err : didNotStart(cli, agent, messageOf(err));
		}
	}

	/**
	 * `err`, the failure of the start of `agent`, as its caller is answered: with the phase the start had got
	 * to, where it names the agent - what may have happened is said with where (AGENT-ORCHESTRATION.md, O2).
	 */
	private failureOf(err: unknown, cli: AgentCli, agent: Agent): FacadeError {
		const failure = err instanceof FacadeError ? err : didNotStart(cli, agent, messageOf(err));
		const phase = this.context.table.get(agent.id)?.phase;
		return failure.outcome?.agent === agent.id && failure.outcome.phase === undefined && phase !== undefined
			? new FacadeError(failure.code, failure.message, { ...failure.outcome, phase })
			: failure;
	}

	/** Throws where `agent` is no longer starting: stopped meanwhile, its start goes no further. */
	private assertStarting(agent: Agent): void {
		if (this.context.table.get(agent.id)?.state !== 'starting') {
			throw new Error('it was stopped before its CLI was launched');
		}
	}

	/** The words an agent's notice opens with: who it is, and - where its setup's completion is not known - that. */
	private openingOf(agent: Agent, cli: AgentCli, creator: Agent | undefined): string {
		const opening = this.context.setup.opening({ id: agent.id, name: agent.name, cliName: cli.displayName }, creator ?? PERSON);
		const note = this.startNotes.get(agent.id);
		return note ? `${opening} ${note}` : opening;
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
		} else if (agent.state === 'starting' && !this.startups.has(agent.id)) {
			// Its start's wait went with the window before: timed again, for what is left of it since the agent
			// started, so that a start that does not come up is said to be unconfirmed - to the person, for their
			// own (AGENT-LAUNCHER.md, L5) - rather than starting for ever.
			const startup = this.watch(agent, true, agent.startTime);
			startup.answered = agent.creator !== undefined;
		}
	}

	/** Whether a start waits for the agent `id` and answers its caller how it goes - a tool call's, or the person's while its terminal is not up. */
	answers(id: number): boolean {
		return this.startups.get(id)?.answered ?? false;
	}

	/** Settles once a launch under way for the agent `id` has opened its terminal, or given up; at once where none is under way. */
	whenOpened(id: number): Promise<void> {
		return this.opening.get(id) ?? Promise.resolve();
	}

	/**
	 * The launch of `installed` for `input`, as the person has it set up, with its arguments whole; throws
	 * where one would not reach a CLI that Windows starts through cmd.exe as it is.
	 */
	private launchOf(installed: InstalledCli, input: Omit<LaunchInput, 'config'>): { readonly spec: LaunchSpec; readonly args: readonly string[]; readonly throughCmd: boolean } {
		const { cli } = installed;
		const target = launchTarget(installed.executable);
		// The launch of its starter: an agent's, or the person's (L4)
		const spec = cli.launch({ ...input, config: launchFor(installed.config, input.unattended) }, target.executable);
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
	private watch(agent: Agent, integration: boolean, since = Date.now()): Startup {
		const ms = this.timing().startTimeoutMs;
		const startup: Startup = {
			up: new DeferredPromise<{ readonly why?: string }>(),
			timer: setTimeout(() => {
				startup.timer = undefined;
				this.unconfirmed(agent, notStartedWhy(this.context.table.get(agent.id)?.phase, integration, ms));
			}, Math.max(ms - (Date.now() - since), 0)),
			answered: true
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
		if (!startup.answered && this.isRunning(agent)) {
			// One nonmodal notice for the person's own: its terminal stays theirs to use (AGENT-LAUNCHER.md, L5).
			this.context.ports.person.tell(l10n.t("{0} is open, but has not connected to Facade: it has no Facade tools yet. It may be slow, or waiting for an answer on its screen.", describe(agent)), agent.id, 'warning');
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
			const opening = this.context.setup.opening({ id: agent.id, name: agent.name, cliName: cli?.displayName ?? agent.cli }, creator);
			const note = this.startNotes.get(agent.id);
			const line = taskNotice(note ? `${opening} ${note}` : opening, agent.taskMessage, table.messageFileOf(agent.taskMessage));
			// Its delays as its start had them, whatever the settings say now.
			const { taskDelay, enterDelay } = delaysOf(table.launchFileOf(agent.id));
			await timeout(taskDelay);
			if (!this.isRunning(agent)) {
				return;
			}
			table.taskTyping(agent.id);
			// One line, the person's typing held back from its start to its Enter, so that none of theirs is in it (X-43)
			if (!await ports.terminals.type(agent.id, line, 'begin')) {
				// Its terminal is gone: its end, which the window tells of, answers the start that waits for it - its
				// time otherwise. Not that it stays starting, which it would never be again (N-80)
				ports.terminals.type(agent.id, '', 'end').then(undefined, () => undefined);
				return;
			}
			await timeout(enterDelay);
			if (!this.isRunning(agent)) {
				await ports.terminals.type(agent.id, '', 'end');
				return;
			}
			await ports.terminals.type(agent.id, '\r', 'end');
			if (!this.isRunning(agent)) {
				return;
			}
			table.taskTyped(agent.id);
			this.context.log(`${describe(agent)} was told of its task, message ${messageRef(agent.taskMessage)}.`);
			this.isUp(agent);
		} catch (err) {
			// The person's typing is held back no more, however far the line came
			ports.terminals.type(agent.id, '', 'end').then(undefined, () => undefined);
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
		return timingOf(this.context.timing);
	}

	/** Whether the window is open and `agent` has neither exited nor is being stopped: what is done for it goes on. */
	private isRunning(agent: Agent): boolean {
		// One being stopped is brought up no further: nothing more is typed into it after its stop (X-43)
		const now = this.context.table.get(agent.id);
		return !this.disposed && isLive(now) && now.state !== 'stopping';
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

	private background(what: string, work: Promise<unknown>): void {
		inBackground(what, work, message => this.context.log(message));
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw windowClosed();
		}
	}
}

/** How long the core waits, as `timing` says the person sets it now; two minutes where nothing does. */
export function timingOf(timing: (() => Timing) | undefined): Timing {
	return timing?.() ?? { startTimeoutMs: START_TIMEOUT_MS };
}

/** Runs `work` on its own: should it fail, `log` says what failed and why, and nothing is left unhandled. */
export function inBackground(what: string, work: Promise<unknown>, log: (message: string) => void): void {
	work.catch(err => log(`${what} failed: ${messageOf(err)}`));
}

/** Why a start is not confirmed once its time is over, by the phase it is in (AGENT-ORCHESTRATION.md, O4). */
function notStartedWhy(phase: StartPhase | undefined, integration: boolean, ms: number): string {
	const seconds = Math.round(ms / 1000);
	switch (phase) {
		case 'creating_worktree': return `it has not started within ${seconds} seconds: its worktree is still being made`;
		case 'running_setup': return `it has not started within ${seconds} seconds: its worktree's setup is still running`;
		case 'launching_cli': return `it has not started within ${seconds} seconds: its CLI is still being launched`;
		default: return integration
			? `it has not started within ${seconds} seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen`
			: `its process has not started within ${seconds} seconds`;
	}
}

/** What a call answers once the window closed under it: it does nothing more. */
export function windowClosed(): FacadeError {
	return new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
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
	return new FacadeError('FAILED', `${cli.displayName} did not start as ${describe(agent)}: ${reason}`, { outcome: 'failed', agent: agent.id });
}
