/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise, timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { disposeAll } from '../base/lifecycle';
import { canonicalFolder, isEqualPath, isInsideFolder } from '../base/files';
import { withFileLock } from '../base/lock';
import { isProcessRunning, processStartedAt, workingFoldersOf } from '../base/system';
import { AgentCli, capabilitiesOf, CliConfig, Environment, exemptionGroupsChanged, InstalledCli, launchFor, Sandbox } from '../clis/cli';
import { whyNotInstalled } from '../clis/config';
import { homeOf } from '../clis/executable';
import { TrustedFolder, trustProblem, writeTrust } from '../clis/trust';
import { agentName, AgentTable } from '../record/agents';
import { identityOf } from '../record/identity';
import { Agent, agentRef, AgentState, Caller, describe, End, EndKind, Ignored, isLive, LiveAgent, parseAgentReference, PERSON, StartPhase, StoppedBy } from '../record/events';
import { closedByItsWindow, isLedgerHeld } from '../record/ledger';
import { HUMAN, Recipient } from '../record/messages';
import { injectedFile } from '../record/paths';
import { screensDir } from '../record/screens';
import { LaunchDelays } from './doorbell';
import { FacadeError } from './errors';
import { Injections, InjectionUser, UnchangedFile } from './injections';
import { delaysOf, inBackground, Launched, Launcher, Prepared, timingOf, windowClosed } from './launch';
import { Mail, Mailbox } from './mail';
import { AgentSetup, CliCatalog, Disposable, EndedAgent, MadeWorktreeFolder, OwnedFile, Ports, Repository, Severity, StopSignal, TerminalEnd, Timing } from './ports';
import { ScreenRead, Screens } from './screens';

/**
 * How often, and how many times, what could not be taken back yet - a file the disk refused, a folder
 * a process of an ended agent still had in use - is tried again: three minutes, past the two an MCP
 * server of Facade's waits for its window where the person sets nothing else. The next window to start
 * tries too.
 */
const TAKE_BACK_AGAIN_MS = 15_000;
const TAKE_BACK_TRIES = 12;
/** The exit code of a CLI interrupted from the keyboard: the person's doing (AGENT-LAUNCHER.md, L6). */
const INTERRUPTED = 130;
/** How many of the files a worktree's deletion would lose a refusal names before saying how many more. */
const SHOWN_CHANGES = 10;
/**
 * How long Facade waits to ask again after an agent whose process the window could not tell of as Facade
 * came back, and how many times: two minutes, a pty host's slowest start.
 */
const FIND_AGAIN_MS = 15_000;
const FIND_AGAIN_TRIES = 8;
/**
 * The delays of a launch whose plan cannot be read, of a CLI Facade no longer knows: the longest of its
 * CLIs', so that nothing is typed into it too soon.
 */
const UNKNOWN_DELAYS: LaunchDelays = { enterDelay: 900, taskDelay: 2_000 };

/** What the core is made with: the record, the window's ports, the CLIs, and what agents are given. */
export interface FacadeOptions {
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	readonly log: (message: string) => void;
	/** The record of the files Facade put into folders, which every window shares: by default `~/.facade/injected.json`. */
	readonly injected?: string;
	/** Whether a process runs, as the operating system says unless set: another workspace's agent's, which uses what Facade put into a folder. */
	readonly isRunning?: (pid: number) => boolean;
	/** The folders each tree of processes works in, by its root, as the operating system says unless set: where an agent's CLI went since it started. */
	readonly workingFolders?: (roots: readonly number[]) => Promise<ReadonlyMap<number, readonly string[]>>;
	/** When a process started, as the operating system says unless set: an agent's CLI's, told from one that got its id since. */
	readonly processStartedAt?: (pid: number) => number | undefined;
	/** Sends a process a signal, as the operating system does unless set: an agent's CLI's, its terminal lost to the window. */
	readonly killProcess?: (pid: number, signal: StopSignal) => void;
	/** What is wrong in the person's settings that hold for every agent, and what is used instead: said with each start. */
	readonly settingsProblems?: () => readonly string[];
	/** How long the core waits, as the person sets it; where left out, two minutes. */
	readonly timing?: () => Timing;
}

/** What a caller asks `start_agent` for (AGENT-ORCHESTRATION.md, O3). */
export interface StartRequest {
	/** Its name: a label, and with `newWorktree` its branch too. */
	readonly name: string;
	/** The CLI, by its id, or a custom agent, by its name. */
	readonly cli: string;
	/** The model and the effort as the CLI takes them, where given: Facade passes them on as they are; left out, the CLI's own apply. */
	readonly model?: string;
	readonly effort?: string;
	/** Its task, if it is given one: a message from the caller, which it fetches itself (AGENT-MESSAGES.md, M7). */
	readonly task?: string;
	/**
	 * Where it works: a folder of the window, by its absolute path, or a worktree of the caller's own
	 * repository, by the branch checked out in it. Omitted: the caller's own folder; the folder on screen for
	 * the person.
	 */
	readonly folder?: string;
	/** Whether it works in a new worktree of that folder's repository, on a new branch called `name`. */
	readonly newWorktree?: boolean;
}

/** An agent as the tools describe it: who, how, where, and in what state. */
export interface AgentFacts {
	readonly id: number;
	readonly name: string;
	/** The agent that started it; none for the person. */
	readonly creator?: number;
	/** Its tree's root. */
	readonly root: number;
	readonly cli: string;
	readonly custom: boolean;
	/** As asked for; none where the CLI's own applies. */
	readonly model?: string;
	readonly effort?: string;
	/** What was asked for and left out, its launch having no group for it: not applied, so not known. */
	readonly ignored: readonly Ignored[];
	readonly yolo: boolean;
	readonly sandbox: Agent['sandbox'];
	/** Whether it has Facade's integration, and whether its MCP server said hello. */
	readonly integration: boolean;
	readonly connected: boolean;
	readonly worktree: string;
	/** Its folder is in no Git repository: it has no worktree or branch (N-05). */
	readonly outsideGit?: true;
	readonly folder: string;
	readonly state: AgentState;
	/** Where its start is, while it is starting (O4, O6). */
	readonly phase?: StartPhase;
	/** Who set out to stop it, and why, while it is stopping. */
	readonly stopping?: { readonly by?: StoppedBy; readonly reason: string };
	readonly startTime: number;
	/** The number of its task's message, `#m12`, where it was given a task (M7). */
	readonly taskMessage?: number;
	/** Its mailbox, as `list_agents` gives it (AGENT-MESSAGES.md, M3). */
	readonly mailbox?: Mailbox;
	readonly end?: End;
}

/** What `start_agent` answers with: whether the child has started, and the child. */
export interface Started extends AgentFacts {
	/** `started`; `unconfirmed` while it has not, the timeout over - it stays starting, and may start yet. */
	readonly status: 'started' | 'unconfirmed';
	/** Why its start is not confirmed, where it is not. */
	readonly why?: string;
	/** Whether its worktree was made for it, on the new branch `worktree`. */
	readonly newWorktree: boolean;
	/** What its preparation came to: its worktree's setup, what could not be copied into it, a failed hook. */
	readonly notes?: readonly string[];
	/** Where its start is not confirmed: the last lines of its screen, as they were then (O3). */
	readonly screen?: ScreenRead;
}

/**
 * How an agent ended, for its messages (AGENT-MESSAGES.md, M6, M8): `how`, as Facade's messages say it - "stopped
 * by @human", "it exited, with exit code 1"; whether its creator, an agent, is told; and whose messages to it are
 * noted in its chat room rather than sent back, their senders told of the end otherwise.
 */
interface EndNotice {
	readonly how: string;
	readonly tell: boolean;
	readonly knownTo: readonly Recipient[];
}

/** A folder of the window an agent can start in, and the worktree it is. */
export interface WindowFolder {
	readonly folder: string;
	readonly worktree: string;
}

/** A CLI an agent can start, as `list_agents` gives it (O6): its id, and what its launch takes. */
export interface StartableCli {
	readonly id: string;
	readonly displayName: string;
	readonly custom: boolean;
	readonly integration: boolean;
	readonly task: boolean;
	readonly model: boolean;
	readonly effort: boolean;
}

/** What `list_agents` answers with: the caller, its reach, the agents it lists, and the CLIs it can start. */
export interface Listed {
	/** The caller's YOLO; none for the person, who reaches every agent. */
	readonly yolo?: boolean;
	readonly agents: readonly AgentFacts[];
	readonly clis: readonly StartableCli[];
}

/** What `stop_agent` answers with: the agents it stopped, and what became of the worktree. */
export interface Stopped {
	/** The agent the call named. */
	readonly agent: AgentFacts;
	/** Whether it had ended before the call: then its end says how. */
	readonly alreadyEnded: boolean;
	/** Every agent the call stopped, the named one among them. */
	readonly stopped: readonly AgentFacts[];
	/** With `delete_worktree`: the folder, and whether it was deleted - or why not. */
	readonly worktree?: { readonly folder: string; readonly deleted: boolean; readonly why?: string };
}

/** Half of a character written as two UTF-16 units, without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** How far a process's start, to the second, may be from its launch as recorded: it starts a moment before. */
const PROCESS_START_SLACK_MS = 3_000;

/** How long a process sent a signal by its id is given to end before the next, stronger one. */
const PROCESS_END_WAIT_MS = 5_000;

/**
 * What `stop_agent` deletes: a worktree of the repository whose main checkout is `main`, at `head` - or what a
 * deletion left of the worktree of the branch `leftover`, which git no longer lists.
 */
interface DeletionTarget {
	readonly main: string;
	readonly head?: string;
	readonly leftover?: string;
}

/**
 * Where a child starts: a folder there is - with the main checkout of its repository, or the folder itself
 * outside any, which its CLI is given trust in - or a worktree to make.
 */
type Place =
	| { readonly kind: 'folder'; readonly folder: string; readonly worktree: string; readonly main: string; readonly outsideGit: boolean }
	| { readonly kind: 'new'; readonly repository: Repository; readonly head: string; readonly branch: string };

/**
 * Facade, the kernel of AGENT-LAUNCHER.md and AGENT-ORCHESTRATION.md: it starts agents, keeps their list,
 * and stops them. An agent has a number no other gets, a creator that never changes - the person, who has
 * no number, or another agent - a tree, the agent the person started that it comes from, and a YOLO it
 * keeps: a child takes its creator's. Facade knows what it did and what is certain - an agent started, its
 * MCP server said hello, its terminal ended - and never what an agent is doing. Every caller comes through
 * here - the contract for an agent's tool calls, Start Agent for the person - and it reaches the window only
 * through its ports. With YOLO off an agent reaches its own tree only; with it on, every agent of the window.
 */
export class Facade implements Disposable {

	private readonly table: AgentTable;
	private readonly ports: Ports;
	private readonly disposables: Disposable[] = [];
	/** What this window put into folders for its agents, beside what other windows did. */
	private readonly injections: Injections;
	private readonly launcher: Launcher;
	/** The agents' messages, and the person's (AGENT-MESSAGES.md). */
	readonly mail: Mail;
	/** The agents' screens: read, typed into, and kept as their terminals end (AGENT-DEBUGGING.md). */
	readonly screens: Screens;
	/**
	 * The ends recorded together - as Facade came back - whose messages are settled once all of them are: none's
	 * unread messages go back to another of them.
	 */
	private settling: [Agent, EndNotice][] | undefined;
	/** The delays of each agent's launch, as its run's plan has them, by number: read once. */
	private readonly delays = new Map<number, LaunchDelays>();
	/** The worktrees being deleted: no agent starts in one meanwhile. */
	/** The new branches starts are making worktrees on, by their repositories' main checkouts: a second start on one is refused. */
	private readonly branchesBeingMade: { readonly main: string; readonly branch: string }[] = [];
	/** The deletions of worktrees under way: no agent starts there meanwhile, and a second deletion joins the first. */
	private readonly deletions: { readonly folder: string; readonly done: Promise<Stopped> }[] = [];
	/** The processes of the agents' MCP servers, as each said in its hello, by number: every one that did. */
	private readonly servers = new Map<number, Set<number>>();
	/** When the folders a process had in use are tried again, while some are. */
	private takingBack: ReturnType<typeof setTimeout> | undefined;
	private takeBackTriesLeft = 0;
	private disposed = false;
	/** Whether the window that had the record before is this very one, its extension host started again (`recover`). */
	private sameWindow = false;
	/** The custom agents whose programs a terminal finds, by name, as `refreshClis` last looked; all of them before it has. */
	private customFound: ReadonlySet<string> | undefined;

	constructor(private readonly options: FacadeOptions) {
		this.table = options.table;
		this.ports = options.ports;
		this.injections = new Injections(options.injected ?? injectedFile(), message => this.log(message), text => this.ports.person.tell(text, undefined, 'warning'), user => this.mayRun(user));
		this.screens = new Screens({
			table: this.table,
			ports: this.ports,
			dir: screensDir(this.table.dir),
			timing: () => this.timing(),
			agentNamed: (target, caller) => this.agentNamed(target, caller),
			enterDelayOf: agent => this.delaysOf(agent).enterDelay,
			log: message => this.log(message),
			audit: what => this.table.auditInput(what)
		});
		this.launcher = new Launcher({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			injections: this.injections,
			...(options.timing ? { timing: options.timing } : {}),
			fail: (agent, reason) => this.fail(agent, reason),
			sendTask: (caller, agent, task) => this.mail.sendTask(caller, agent, task),
			firstRing: (agent, task) => this.mail.firstRing(agent, task),
			running: agent => this.mail.running(agent),
			finalScreenOf: agent => this.screens.finalScreenOf(agent),
			excerptOf: (agent, ended) => this.screens.excerptOf(agent, ended),
			log: message => this.log(message)
		});
		this.mail = new Mail({
			table: this.table,
			ports: this.ports,
			timing: () => this.timing(),
			agentNamed: (text, caller) => this.agentNamed(text, caller),
			reaches: (caller, agent) => this.reaches(caller, agent),
			firstLine: (agent, task) => this.firstLineOf(agent, task),
			delaysOf: agent => this.delaysOf(agent),
			frameworkOn: () => this.frameworkOn(),
			isConnected: agent => this.isConnected(agent),
			excerptOf: agent => this.screens.excerptOf(agent, true),
			log: message => this.log(message)
		});
		this.disposables.push(this.launcher, this.mail, this.ports.terminals.onDidEnd((id, end) => this.terminalEnded(id, end)));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		disposeAll(this.disposables.splice(0), err => this.log(`Stopping Facade agents: ${messageOf(err)}`));
		clearTimeout(this.takingBack);
		this.takingBack = undefined;
	}

	/** The agent numbered `id`, ended or not. */
	agent(id: number): Agent | undefined {
		return this.table.get(id);
	}

	/** Who started or stopped an agent, as Facade's words name them: `@lead #a1`, `@human`; a number alone for one the list no longer has. */
	whoIs(who: StoppedBy | undefined): string {
		return this.table.whoIs(who);
	}

	/** The agent a caller is; undefined for the person. */
	agentOf(caller: Caller): Agent | undefined {
		return caller.id === undefined ? undefined : this.table.get(caller.id);
	}

	/** A CLI's name for people, by its id: a custom agent's is its name. */
	cliName(id: string): string {
		return this.cliOf(id)?.cli.displayName ?? id;
	}

	/** Whether a CLI's models carry their effort, by its id: then an effort given with a model is not used (N-64). */
	modelCarriesEffort(id: string): boolean {
		return !!this.cliOf(id)?.cli.modelCarriesEffort;
	}

	/** Whether the agent framework is on: Facade's tools answer only while it is. */
	frameworkOn(): boolean {
		return this.options.clis.framework();
	}

	/**
	 * The agent framework was turned on or off: off, no doorbell goes in and nothing is told of as unfetched; on,
	 * the agents running are watched again from now (AGENT-MESSAGES.md, M10).
	 */
	frameworkChanged(): void {
		if (!this.disposed) {
			this.mail.frameworkChanged(this.frameworkOn());
		}
	}

	/** The agent numbered `id` once it ended, as a notice about it shows it: where its last screen is; undefined while it runs. */
	endedAgent(id: number): EndedAgent | undefined {
		const agent = this.table.get(id);
		return agent?.end && { id, name: agent.name, finalScreen: this.screens.finalScreenOf(agent), ending: `${agent.end.kind}: ${agent.end.reason}` };
	}

	/** The agents an agent can start: the built-ins this machine has and the person offers, then the person's custom agents, each with what its launch takes. */
	/** Finds the CLIs this machine has again, as a terminal would now; what fails is said, the last found kept. */
	async refreshClis(): Promise<void> {
		try {
			await this.options.clis.refresh?.();
			// The custom agents' programs too, where a terminal in the folder on screen finds them, as the built-ins are
			const folder = await this.ports.workspace.activeFolder() ?? this.ports.workspace.folders().at(0);
			if (folder !== undefined) {
				const env = await this.options.clis.environment(folder);
				this.customFound = new Set(this.options.clis.custom().filter(({ cli, config }) => this.options.clis.locate(cli, config, { ...env, ...config.launch.environment }, folder)).map(({ cli }) => cli.id));
			}
		} catch (err) {
			this.log(`The CLIs could not be looked for again: ${messageOf(err)}`);
		}
	}

	/**
	 * What an agent can start here, as `list_agents` lists it: a built-in the person offers and this machine has,
	 * and a custom agent whose program is found - neither with settings that are wrong, which keep it from
	 * starting. Each left out the same way (C-LAUNCH-16; X-39).
	 */
	startable(): readonly StartableCli[] {
		// What an agent can give each, which it starts through start_agent (L4)
		const each = (cli: AgentCli, config: CliConfig): StartableCli => ({ id: cli.id, displayName: cli.displayName, custom: !!cli.custom, ...capabilitiesOf(cli, launchFor(config, true)) });
		return [
			...this.options.clis.installed().filter(({ config }) => !config.wrong).map(({ cli, config }) => each(cli, config)),
			...this.options.clis.custom().filter(({ cli, config }) => !config.wrong && (this.customFound?.has(cli.id) ?? true)).map(({ cli, config }) => each(cli, config))
		];
	}

	/**
	 * An agent's MCP server said hello to Facade: one starting has started, and is running; one running whose
	 * doorbell waited for it to connect again is rung (AGENT-MESSAGES.md, M5).
	 */
	connected(caller: Caller, serverPid?: number): void {
		const agent = this.agentOf(caller);
		if (agent && serverPid !== undefined) {
			const servers = this.servers.get(agent.id) ?? new Set<number>();
			servers.add(serverPid);
			this.servers.set(agent.id, servers);
		}
		if (this.disposed || !agent) {
			return;
		}
		if (agent.state === 'starting') {
			this.launcher.hello(agent);
		} else {
			this.mail.connected(agent);
		}
	}

	/**
	 * Whether an agent is connected: its MCP server said hello, and - where its servers said which processes they
	 * are - one of them still runs: a second one under its token that ended, a client of its own or its server
	 * started anew, leaves it connected through the other (N-77). A server that ended, or was killed, leaves its
	 * agent running and not connected (O6); one found ended is forgotten, its number never taken for a later
	 * process's.
	 */
	private isConnected(agent: Agent): boolean {
		const servers = this.servers.get(agent.id);
		if (!agent.connected || servers === undefined) {
			return agent.connected;
		}
		const isRunning = this.options.isRunning ?? isProcessRunning;
		for (const pid of servers) {
			if (!isRunning(pid)) {
				servers.delete(pid);
			}
		}
		return servers.size > 0;
	}

	/**
	 * The folders of the window an agent can start in: its workspace's, and every worktree of their
	 * repositories - those the workspace bar lists - each once, with the worktree it is.
	 */
	async windowFolders(): Promise<readonly WindowFolder[]> {
		const found: WindowFolder[] = [];
		const add = (folder: string, worktree: string) => {
			if (!found.some(each => isEqualPath(each.folder, folder))) {
				found.push({ folder, worktree });
			}
		};
		for (const folder of this.ports.workspace.folders()) {
			// One gone from the disk is no folder an agent can start in, and git cannot be asked about it (X-37)
			if (!fs.existsSync(folder)) {
				continue;
			}
			const repository = await this.ports.git.repositoryOf(folder);
			add(folder, repository?.worktree ?? path.basename(folder));
			for (const listed of repository ? await this.ports.git.worktreesOf(repository.main) : []) {
				add(listed.folder, listed.name);
			}
		}
		return found;
	}

	/**
	 * What its start says, with YOLO off, where the person's settings take away what lets Facade's server
	 * through unasked: a deny rule of theirs, or a group of Facade's launch that carries it changed - never that
	 * it works (AGENT-LAUNCHER.md, L4, rule 4: the launch diagnostics; X-38; YO-09).
	 */
	private exemptionNotes(installed: InstalledCli, yolo: boolean, unattended: boolean, env: Environment, folder: string): string[] {
		if (yolo) {
			return [];
		}
		// A rule of the person's that refuses Facade's tools, and a group of Facade's launch changed: the first
		// refuses them, the second may have them asked for - each said as it is (N-45)
		const config = launchFor(installed.config, unattended);
		const own = installed.cli.exemptionOverride?.(config, env, folder);
		const changed = exemptionGroupsChanged(installed.cli, installed.config, unattended);
		return [
			...own !== undefined ? [`With YOLO off, ${installed.cli.displayName} refuses Facade's tools: ${own}.`] : [],
			...changed.length ? [`With YOLO off, ${installed.cli.displayName} may ask for approval before Facade's tools: its launch's ${changed.join(' and ')} ${changed.length > 1 ? 'groups are' : 'group is'} changed from Facade's, which lets its server through.`] : []
		];
	}

	/**
	 * What would refuse a start of `installed` in `folder` as things are, before anything is allocated - a
	 * `${name}` of its launch Facade has no value for, the person's own configuration of it that Facade's would
	 * be mixed into - with either YOLO, for the person's start and an agent's given a task, a model and an
	 * effort where its launch takes them: as Show Agent Launch shows them (AGENT-LAUNCHER.md, L9; X-38).
	 */
	async launchProblems(installed: InstalledCli, folder: string): Promise<string[]> {
		// One line for each: a `${name}` an agent's start and the person's have no value for is the same problem,
		// said with the names each has - the agent's, which uses every group the person's does, first
		const problems = new Map<string, string>();
		const add = (message: string) => {
			const key = message.replace(/, for which Facade has no value: it has [^]*$/, '');
			if (!problems.has(key)) {
				problems.set(key, message);
			}
		};
		try {
			const repository = await this.ports.git.repositoryOf(folder);
			const env = await this.environmentOf(installed, folder);
			// An agent's start, through start_agent, and the person's, from the UI, each with its own launch (L4)
			const can = capabilitiesOf(installed.cli, launchFor(installed.config, true));
			const integration = this.options.clis.framework() && can.integration;
			const theirs = this.options.clis.framework() && capabilitiesOf(installed.cli, launchFor(installed.config, false)).integration;
			const given = { ...(integration && can.task ? { task: 'A task.' } : {}), ...(can.model ? { model: 'model' } : {}), ...(can.effort ? { effort: 'high' } : {}) };
			for (const yolo of [true, false]) {
				const run = { ignored: [], folder, repository: repository?.main ?? folder, home: homeOf(env), yolo };
				for (const each of [{ ...run, ...given, integration, unattended: true }, { ...run, integration: theirs, unattended: false }]) {
					try {
						this.launcher.check(installed, each, env);
					} catch (err) {
						add(messageOf(err));
					}
				}
			}
		} catch (err) {
			add(messageOf(err));
		}
		return [...problems.values()];
	}

	/**
	 * Starts the agent the person chose from the agent menu or Start Agent: in `folder`, the one on screen,
	 * named after its CLI's id or the custom agent's name, given no model, effort or task, its YOLO the
	 * setting's (AGENT-LAUNCHER.md, L3). `custom` says it is the custom agent of that name, never a built-in
	 * started in its place. Its terminal comes up in front, focused; the call answers once it runs, the agent
	 * starting until it connects. A start refused leaves nothing behind.
	 */
	async startForPerson(cli: string, folder: string, custom = false): Promise<AgentFacts> {
		this.assertNotDeleting(folder);
		const { installed, config } = await this.startableHere(cli, folder, custom);
		const yolo = this.yolo(PERSON);
		const integration = this.options.clis.framework() && capabilitiesOf(installed.cli, launchFor(config, false)).integration;
		const name = this.nameOf(installed.cli.id);
		const repository = await this.ports.git.repositoryOf(folder);
		const worktree = repository?.worktree ?? path.basename(folder);
		const env = await this.environmentOf(installed, folder);
		this.stillOpen();
		// The person's own, from the UI: it runs as its CLI usually does (L4)
		const run = { ignored: [], folder, repository: repository?.main ?? folder, home: homeOf(env), yolo, unattended: false, integration, notes: this.exemptionNotes(installed, yolo, false, env, folder) };
		const files = this.launcher.check(installed, run, env);
		this.launcher.checkFiles(installed, files, folder);
		this.stillOpen();
		this.trust(installed, { folder, repository: run.repository }, env);
		const { agent } = await this.launcher.launch(PERSON, installed, { ...run, name, worktree, outsideGit: !repository }, { wait: false });
		return this.factsOf(agent);
	}

	/**
	 * Starts a child of the caller called `name`, in its own UI: in a folder of the window - the caller's own
	 * where none is named - or in a new worktree of that folder's repository, on a new branch named after the
	 * child, at the caller's commit in its own repository and at the main checkout's in another. Its YOLO is
	 * its creator's - the setting's for `@human`. A start refused leaves nothing behind. Answers once the
	 * child has started, or once the timeout runs out with it starting still - left as it is, for the caller
	 * to decide; a child whose process ends before it started fails the call. Once begun, a start is carried
	 * through: a caller that ends meanwhile leaves its child as it is. Its model and effort go to its CLI as
	 * they are, where given: the CLI is the one that knows which it has.
	 */
	async startAgent(caller: Caller, request: StartRequest, progress?: (message: string, agent?: number) => void): Promise<Started> {
		// Its time counts from now, when it is accepted, whatever it waits for after (O9).
		const acceptedAt = Date.now();
		this.stillOpen();
		// The person's settings are read once, as the call is accepted: a change applies to the next start.
		const yolo = this.yolo(caller);
		const name = this.nameOf(request.name);
		const model = request.model?.trim() || undefined;
		const effort = request.effort?.trim() || undefined;
		const task = request.task?.trim() ? request.task : undefined;
		// Everything that can refuse the call is asked before anything is made for it.
		const place = await this.placeOf(caller, request.folder, request.newWorktree === true, name);
		// A new branch is this start's from here until its worktree is made, or the start ends without one: a second
		// start on it is refused at once, before anything is allocated for it (AS-21)
		const reserved = place.kind === 'new' ? this.reserveBranch(place.repository.main, place.branch) : undefined;
		try {
			const home = place.kind === 'new' ? place.repository.main : place.folder;
			const { installed, config } = await this.startableHere(request.cli, home);
			// Through start_agent, where nobody may be watching: its launch's unattended part (L4)
			const launch = launchFor(config, true);
			const capabilities = capabilitiesOf(installed.cli, launch);
			const integration = this.options.clis.framework() && capabilities.integration;
			if (task !== undefined && !(integration && capabilities.task)) {
				// Its cause named: the framework off, or the person's launch without the group a task needs (X-55)
				const name = installed.cli.custom ? installed.cli.id : installed.cli.displayName;
				throw new FacadeError('REFUSED', !this.options.clis.framework()
					? `${name} cannot be given a task while the agent framework is off.`
					: `${name} cannot be given a task: its launch in ${installed.cli.setting}.launch has ${capabilities.integration ? 'no task group' : 'no connect group, so it cannot read Facade\'s messages'}. Start it without a task, or ask the person to fill that in.`);
			}
			// A model that carries its effort decides it: an effort given with it would be recorded and never run (N-64)
			const effortOfModel = model !== undefined && capabilities.model && !!installed.cli.modelCarriesEffort;
			const ignored: Ignored[] = [...model !== undefined && !capabilities.model ? ['model' as const] : [], ...effort !== undefined && (!capabilities.effort || effortOfModel) ? ['effort' as const] : []];
			// What cannot reach the CLI as it is - read as an option of its own, or no text at all - is refused before
			// anything is made, not rewritten (AGENT-LAUNCHER.md, L10; X-08, N-10)
			for (const [what, value] of [['model', model], ['effort', effort]] as const) {
				if (value === undefined || ignored.includes(what)) {
					continue;
				}
				if (value.includes('\0') || LONE_SURROGATE.test(value)) {
					throw new FacadeError('INVALID', `The ${what} has a character no CLI can be given as it is - a NUL, or half of one written as two: give it as plain text.`);
				}
				if (value.startsWith('-') && (launch.launch.arguments[what] ?? []).includes(`\${${what}}`)) {
					throw new FacadeError('INVALID', `The ${what} ${value} starts with a dash: ${installed.cli.displayName} would read it as an option of its own, not as the ${what}. Give it without the leading dash.`);
				}
			}
			const env = await this.environmentOf(installed, home);
			this.stillOpen();
			// Recorded as asked for; given to the CLI only where its launch has a group for it.
			const repository = place.kind === 'new' ? place.repository.main : place.main;
			const run = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ignored, task, folder: home, repository, home: homeOf(env), yolo, unattended: true, integration, notes: this.exemptionNotes(installed, yolo, true, env, home) };
			const files = this.launcher.check(installed, run, env);
			this.launcher.checkFiles(installed, files, place.kind === 'new' ? undefined : place.folder);
			this.stillOpen();

			// Wherever it starts, the CLI is given the person's trust in its folder's repository - or in the folder,
			// outside any - so that it does not stop to ask; what would keep that from being given refuses the start
			// before anything is made for it, a new worktree included (X-30).
			if (place.kind !== 'new') {
				try {
					this.trust(installed, { folder: place.folder, repository }, env);
				} catch (err) {
					throw new FacadeError('FAILED', messageOf(err));
				}
				const launched = await this.launcher.launch(caller, installed, { ...run, name, worktree: place.worktree, outsideGit: place.outsideGit, folder: place.folder }, { wait: true, acceptedAt, ...(progress ? { progress } : {}) });
				return this.startedOf(launched, false);
			}
			const planned = this.ports.git.plannedWorktreeFolder(place.repository.main, place.branch);
			const problem = trustProblem(installed.cli, installed.config, { folder: planned, repository }, env);
			if (problem) {
				throw new FacadeError('FAILED', problem);
			}
			await this.launcher.checkCommitted(installed, files, place.repository.main, place.head, planned);
			this.stillOpen();
			// Recorded first, then its worktree made and set up, each phase recorded, then its CLI started (O9): it
			// can be listed and stopped all along, and an interruption leaves a run that says how far it came.
			let made: string | undefined;
			const prepare = async (agent: Agent): Promise<Prepared> => {
				progress?.(`Making the worktree ${place.branch} for ${describe(agent)}.`);
				let worktree: MadeWorktreeFolder;
				try {
					worktree = await this.ports.git.makeWorktree(place.repository.main, place.branch, place.head);
				} catch (err) {
					throw new FacadeError('FAILED', `The worktree ${place.branch} could not be made: ${messageOf(err)}`, { outcome: 'failed', agent: agent.id });
				} finally {
					// Made, git has the branch; not made, it is free again
					reserved?.dispose();
				}
				const folder = made = worktree.folder;
				// Recorded even where the window closed or the agent was stopped meanwhile: it was made, and stays.
				this.table.recordWorktree({ name: place.branch, folder, repository: place.repository.main, commit: place.head, ...(caller.id !== undefined ? { madeBy: caller.id } : {}) });
				if (!this.isStarting(agent)) {
					this.ports.git.stopSetup(folder);
					throw new Error('it was stopped as its worktree was made');
				}
				this.table.phase(agent.id, 'running_setup', folder);
				const notes = [
					// The branch is the name asked for; the folder, where its own was taken, gets a suffix - said, not silent (WT-2.3; O3)
					...!isEqualPath(folder, planned) ? [`Its worktree is at ${folder}: ${planned} was taken.`] : [],
					...worktree.copyFailures.length ? [`What .worktreeinclude names could not all be copied into its worktree: ${worktree.copyFailures.join(', ')}.`] : [],
					...worktree.hookFailure ? [`A git hook failed as its worktree was made: ${worktree.hookFailure}`] : []
				];
				progress?.(`Setting up the worktree ${place.branch}.`);
				const setup = await this.ports.git.setupOutcome(folder);
				if (!this.isStarting(agent)) {
					throw new Error('it was stopped as its worktree was set up');
				}
				let startNote: string | undefined;
				switch (setup.kind) {
					case 'failed':
						throw new FacadeError('FAILED', `its worktree's setup failed - \`${setup.line}\` exited with code ${setup.exitCode}${setup.output ? `: ${setup.output.trim()}` : ''}`, { outcome: 'failed', agent: agent.id });
					case 'stopped':
						throw new FacadeError('FAILED', 'its worktree\'s setup ended before it finished: its terminal was closed', { outcome: 'failed', agent: agent.id });
					case 'succeeded':
						notes.push('Its worktree\'s setup ran, and succeeded.');
						break;
					case 'submitted':
						notes.push('Its worktree\'s setup was sent without shell integration: whether it finished, or how, is not known.');
						startNote = 'Your worktree\'s setup was sent without shell integration: whether it finished is not known - check before you rely on it.';
						break;
					case 'invalid':
						notes.push('Its repository\'s .facade/worktrees.json could not be read: no setup was run.');
						break;
				}
				try {
					this.trust(installed, { folder, repository }, env);
				} catch (err) {
					throw new FacadeError('FAILED', messageOf(err), { outcome: 'failed', agent: agent.id });
				}
				return { folder, notes, ...(startNote ? { startNote } : {}) };
			};
			try {
				const launched = await this.launcher.launch(caller, installed, { ...run, name, worktree: place.branch, folder: planned }, { wait: true, acceptedAt, prepare, ...(progress ? { progress } : {}) });
				return this.startedOf(launched, true);
			} catch (err) {
				// A worktree made for a start that fails stays, its branch with it: the answer says where (O4).
				if (made !== undefined && err instanceof FacadeError && err.code === 'FAILED') {
					throw new FacadeError(err.code, `${err.message}. The worktree ${place.branch} was made for it, at ${made}, and stays, with its branch: start an agent there by its folder, or delete it.`, { ...err.outcome ?? { outcome: 'failed' }, worktree: made });
				}
				throw err;
			}
		} finally {
			reserved?.dispose();
		}
	}

	/** A start's answer: the agent's facts, how its start went, and what its preparation came to. */
	private startedOf(launched: Launched, newWorktree: boolean): Started {
		const { agent, status, why, screen } = launched;
		// What of the person's settings was not taken as set goes with the start it changed (X-59)
		const notes = [...(this.options.settingsProblems?.() ?? []).map(problem => `${problem}.`), ...launched.notes];
		return { status, ...(why !== undefined ? { why } : {}), ...this.factsOf(this.table.get(agent.id) ?? agent), newWorktree, ...(notes.length ? { notes } : {}), ...(screen ? { screen } : {}) };
	}

	/** Whether `agent` is starting still: not stopped meanwhile. */
	private isStarting(agent: Agent): boolean {
		return !this.disposed && this.table.get(agent.id)?.state === 'starting';
	}

	/**
	 * The agents as the caller sees them (AGENT-ORCHESTRATION.md, O6): itself, its creator, and the agents
	 * it started, ended ones too - for the person, the agents they started; with `all`, every agent it
	 * reaches. By number, with the CLIs it can start.
	 */
	listAgents(caller: Caller, all = false): Listed {
		const self = this.agentOf(caller);
		const agents = [...this.table.state.agents.values()]
			.filter(agent => all
				? this.reaches(caller, agent)
				: agent.id === caller.id || (self?.creator !== undefined && agent.id === self.creator) || agent.creator === caller.id)
			.sort((a, b) => a.id - b.id)
			.map(agent => {
				// Each with its mailbox: what it has not fetched shows without a guess at what it does (M3)
				const mailbox = this.mail.mailboxOf(agent.id, caller);
				return { ...this.factsOf(agent), ...(mailbox ? { mailbox } : {}) };
			});
		return { ...(self ? { yolo: self.yolo } : {}), agents, clis: this.startable() };
	}

	/**
	 * Stops one agent the caller reaches - a child, a sibling, its creator, itself, one the person started -
	 * and, with `deleteWorktree`, the other agents in its worktree and then the worktree, its branch kept
	 * (AGENT-ORCHESTRATION.md, O5). A worktree with work in it that would be lost is not deleted, and nothing
	 * is stopped, unless the call says to discard it. Answers once everything is done; a process that has not
	 * ended in time answers pending, and its worktree stays.
	 */
	/**
	 * The person is deleting the worktree `folder` in the window: the agents still starting in it - making it, or
	 * running its setup - are stopped by them, its worktree deleted, before it goes; no CLI is launched in it after
	 * (AGENT-LAUNCHER.md: removing a worktree stops the agents associated with it; N-34). Those running in it end as
	 * its terminals close (N-04).
	 */
	async worktreeDeleting(folder: string): Promise<void> {
		const starting = this.liveAgents().filter(agent => agent.state === 'starting' && isEqualPath(agent.folder, folder));
		await Promise.all(starting.map(agent => this.stopOne(agent, 'human', 'as its worktree was deleted').catch(err => this.log(`Stopping ${describe(agent)} as its worktree is deleted: ${messageOf(err)}`))));
	}

	async stopAgent(caller: Caller, target: string, options: { readonly deleteWorktree?: boolean; readonly discardChanges?: boolean } = {}): Promise<Stopped> {
		this.stillOpen();
		if (options.discardChanges && !options.deleteWorktree) {
			throw new FacadeError('INVALID', 'discard_changes says what to do with the changes in a worktree being deleted: give it with delete_worktree.');
		}
		const agent = this.agentNamed(target, caller);
		this.assertReaches(caller, agent);
		const by = caller.id ?? 'human';
		// Read now: the record's agent is the one its end is written into.
		const alreadyEnded = !!agent.end;
		if (!options.deleteWorktree) {
			if (alreadyEnded) {
				return { agent: this.factsOf(agent), alreadyEnded, stopped: [] };
			}
			await this.stopOne(agent, by, 'with stop_agent');
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded: false, stopped: [this.factsOf(this.table.get(agent.id) ?? agent)] };
		}

		// A worktree whose folder is gone already - deleted by hand - has nothing left to delete: the agent alone is
		// stopped, and the answer says so, rather than what git says of a folder that is not there (X-37).
		const folder = agent.folder;
		if (!fs.existsSync(folder)) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			if (this.table.madeWorktree(folder)) {
				this.table.forgetWorktree(folder);
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: 'its folder is gone already: there is nothing left to delete' } };
		}
		// A main checkout - or a folder in one - or a folder outside git, is never deleted: the agent alone is stopped.
		// What a deletion left of a worktree Facade made - a folder git no longer lists, whose files could not all
		// be deleted then - is no repository, and a retry finishes it (AGENT-ORCHESTRATION.md, O5).
		const repository = await this.ports.git.repositoryOf(folder);
		const leftover = repository ? undefined : this.table.madeWorktree(folder);
		if ((!repository && !leftover) || repository?.mainCheckout) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: repository ? 'it is its repository\'s main checkout, which is never deleted' : 'it is in no git repository: there is no worktree to delete' } };
		}
		// A worktree that is one of the window's folders is the window's: deleting it would take it out of the
		// workspace - and, the window's only folder, put the repository's main checkout in its place - which an
		// agent's work never does (AGENT-ORCHESTRATION.md, O1). The person can, or their scripts.
		if (caller.id !== undefined && this.ports.workspace.folders().some(each => isEqualPath(each, folder))) {
			throw new FacadeError('REFUSED', `${folder} is one of this window's folders, so an agent does not delete it: that would change the person's window. Nothing was stopped. Stop the agents without delete_worktree, or ask the person to remove the folder from the window first.`);
		}
		// One deletion of a folder at a time: a second joins the first, and answers as it does (X-10). Registered
		// before anything is awaited, so that two that come at once cannot both go.
		const underWay = this.deletions.find(each => isEqualPath(each.folder, folder));
		if (underWay) {
			const joined = await underWay.done;
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped: [], ...(joined.worktree ? { worktree: joined.worktree } : {}) };
		}
		const deleting = new DeferredPromise<Stopped>();
		deleting.p.catch(() => undefined);
		const entry = { folder, done: deleting.p };
		this.deletions.push(entry);
		try {
			const target: DeletionTarget = repository ? { main: repository.main, ...(repository.head !== undefined ? { head: repository.head } : {}) } : { main: leftover!.repository, leftover: leftover!.name };
			const stopped = await this.deleteWorktreeOf(caller, agent, folder, target, by, alreadyEnded, options);
			deleting.complete(stopped);
			return stopped;
		} catch (err) {
			deleting.error(err);
			throw err;
		} finally {
			this.deletions.splice(this.deletions.indexOf(entry), 1);
		}
	}

	/**
	 * `stopAgent`'s deletion of the worktree `folder` of `target`'s repository - or of what a deletion left of it -
	 * once no other is under way: refused, nothing stopped, where an agent working in it is out of the caller's reach
	 * or it has work deleting it would lose; else every agent working in it stopped, then - what came meanwhile
	 * looked at again - the worktree deleted, its branch kept.
	 */
	private async deleteWorktreeOf(caller: Caller, agent: Agent, folder: string, target: DeletionTarget, by: StoppedBy, alreadyEnded: boolean, options: { readonly discardChanges?: boolean }): Promise<Stopped> {
		// Every agent working in it: started there, or gone there since - a CLI that cd'd into it - wherever
		// it was started; its terminal goes with it, so it is stopped and said to be (AGENT-ORCHESTRATION.md, O5;
		// X-74). One the window holds for another record is no agent of this list to stop.
		const terminals = await this.ports.terminals.inside(folder);
		if (terminals.others) {
			throw new FacadeError('REFUSED', `${folder} has ${terminals.others === 1 ? 'an agent' : `${terminals.others} agents`} working in it that ${terminals.others === 1 ? 'is' : 'are'} not of this window's list, which deleting it would end unasked. Nothing was stopped. Stop ${terminals.others === 1 ? 'it' : 'them'} first.`);
		}
		// Another window's agents there are its to stop: the window sees their terminals - the pty host holds every
		// window's - and what Facade put there for them says so too. Refused before anything is stopped (X-10; N-53).
		const elsewhere = terminals.elsewhere.length ? terminals.elsewhere : this.othersUsing(folder).map(user => `#a${user.id} of its list`);
		if (elsewhere.length) {
			throw new FacadeError('REFUSED', `${folder} has ${elsewhere.length === 1 ? 'an agent' : `${elsewhere.length} agents`} of another window working in it - ${elsewhere.join(', ')} - which this call does not stop. Nothing was stopped. Stop ${elsewhere.length === 1 ? 'it' : 'them'} in that window first.`);
		}
		const live = this.liveAgents();
		// Its terminal the window cannot see go there - the CLI itself, or a shell it runs, cd'd - its processes say
		const startedElsewhere = live.filter(each => !isEqualPath(each.folder, folder) && !terminals.agents.includes(each.id) && each.processId !== undefined);
		const working = startedElsewhere.length ? await (this.options.workingFolders ?? workingFoldersOf)(startedElsewhere.map(each => each.processId!)) : new Map<number, readonly string[]>();
		// The system names a process's folder by its real path
		const real = canonicalFolder(folder);
		const wentThere = (agent: Agent) => (working.get(agent.processId!) ?? []).some(each => [folder, real].some(at => isEqualPath(each, at) || isInsideFolder(each, at)));
		const inside = live.filter(each => isEqualPath(each.folder, folder) || terminals.agents.includes(each.id) || (each.processId !== undefined && wentThere(each)));
		const outOfReach = inside.filter(each => !this.reaches(caller, each));
		if (outOfReach.length) {
			throw new FacadeError('REFUSED', `${folder} has ${outOfReach.map(each => `${describe(each)}${isEqualPath(each.folder, folder) ? '' : ` (started in ${each.folder})`}`).join(', ')} working in it, outside your tree: your YOLO is off, and you reach only your own tree. Nothing was stopped.`);
		}
		const changes = await this.changesIn(folder, target);
		if (changes && !options.discardChanges) {
			throw new FacadeError('REFUSED', `${folder} has work that deleting it would lose: ${changes}. Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`);
		}
		const results = await Promise.allSettled(inside.map(each => this.stopOne(each, by, 'with stop_agent, its worktree being deleted')));
		const pending = results.some(result => result.status === 'rejected');
		const stopped = inside.map(each => this.factsOf(this.table.get(each.id) ?? each));
		if (pending) {
			throw new FacadeError('UNAVAILABLE', `Not every agent in ${folder} has ended yet, so it was not deleted: ${stopped.filter(each => each.state !== 'ended').map(each => describe(each)).join(', ')} ${stopped.filter(each => each.state !== 'ended').length === 1 ? 'is' : 'are'} still stopping. Call stop_agent with delete_worktree again once it has ended.`, { outcome: 'pending', agent: agent.id });
		}
		this.stillOpen();
		// Looked at again, the agents gone and what Facade put there taken back: what came meanwhile - an edit
		// a CLI finished as it ended, a build's output - is work too, and is not deleted unasked.
		const since = options.discardChanges ? undefined : await this.changesIn(folder, target);
		this.stillOpen();
		if (since) {
			// Refused, as an error: what happened all the same - the agents stopped - said with it (X-23)
			throw new FacadeError('REFUSED', `${folder} was not deleted: work came into it as its agents stopped, which deleting it would lose: ${since}. Stopped meanwhile: ${stopped.map(each => describe(each)).join(', ')}. Commit what should stay, or call again with discard_changes: true to lose it.`, { agent: agent.id, worktree: folder, stopped: stopped.map(each => each.id) });
		}
		try {
			await this.ports.git.deleteWorktree(folder, {
				discardChanges: !!options.discardChanges,
				ownFiles: target.leftover === undefined ? await this.ownFilesIn(folder, target) : [],
				main: target.main,
				agents: [...new Set([...inside.map(each => each.id), ...terminals.agents])],
				...(target.leftover !== undefined ? { leftover: true } : {})
			});
		} catch (err) {
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped, worktree: { folder, deleted: false, why: messageOf(err) } };
		}
		this.table.forgetWorktree(folder);
		this.log(`${folder} was deleted with stop_agent by ${this.whoIs(by)}.`);
		return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped, worktree: { folder, deleted: true } };
	}

	/**
	 * As Facade comes back - after a reload, a restart, or turned on again - an agent whose terminal is
	 * gone has ended. When the window before was closed - the person quit Facade, closed the window, or
	 * opened another workspace in it - and none of its agents came back, they went with it: stopped as the
	 * window went, without a word to the person. After a reload, after a crash, or beside others that came
	 * back, nothing saw one gone end: it is lost, or failed, if it had not started. One that was starting is
	 * waited for again, its MCP server's hello coming to this window; one whose task notice was not yet typed
	 * is told it now. What windows that closed left in folders is taken back, and a start of the window that
	 * is no reload begins a new list.
	 *
	 * @param reloaded Whether a reload of the window before loaded this one.
	 * @param sameWindow Whether this very window had the record before, its extension host started again - as the
	 * window remembers it, however the host before went: killed, it left no word of its going in the ledger (WIN-18).
	 */
	async recover(reloaded = false, sameWindow = false): Promise<void> {
		this.sameWindow = sameWindow;
		if (this.sweep()) {
			this.takeBackLater();
		}
		// A worktree Facade made that is gone - deleted by the person, or by git - is its no more.
		for (const made of [...this.table.state.worktrees.values()]) {
			if (!fs.existsSync(made.folder)) {
				this.table.forgetWorktree(made.folder);
			}
		}
		const gone: LiveAgent[] = [];
		const untold: LiveAgent[] = [];
		let cameBack = false;
		// Every agent asked after at once: the window waits a while for one it cannot tell of yet, and the tool
		// calls wait for this, so the wait is that while, however many agents there are. Not one whose start was
		// cut before its CLI was launched: it has no process to ask after, and one the window could not tell of
		// stayed starting for good (N-60)
		const live = this.liveAgents();
		const found = await Promise.allSettled(live.map(agent => cutBeforeLaunch(agent) ? Promise.resolve(false) : this.ports.terminals.isAlive(agent.id)));
		if (this.disposed) {
			return;
		}
		live.forEach((agent, i) => {
			const alive = found[i];
			if (alive.status === 'fulfilled' && alive.value) {
				cameBack = true;
				this.cameBackRunning(agent);
			} else if (alive.status === 'fulfilled') {
				gone.push(agent);
			} else {
				// One whose terminal the window does not answer for keeps neither the others nor Facade from
				// coming back: it is asked after again, a while on.
				this.log(`Coming back to ${describe(agent)} failed: ${messageOf(alive.reason)}. Facade asks again in a while.`);
				untold.push(agent);
			}
		});
		if (untold.length) {
			this.background('Finding the agents the window could not tell of', this.findAgain(untold));
		}
		// The window before was closed: another workspace's, or this workspace's and not reloaded - not this
		// very window, whose extension host started again, and not Facade letting go of its agents
		const last = this.table.lastClose;
		const windowClosed = last?.by === 'window' && !last.thisWindow && (!last.ownWindow || !reloaded);
		const closedByThePerson = windowClosed && !cameBack;
		// A worktree git finished making after the window went - its start cut, git's answer never heard - is
		// the one made for it all the same: recorded, and its end says where it stays (LC-renderer_crash-creating_worktree)
		for (const agent of gone) {
			if (agent.state === 'starting' && agent.phase === 'creating_worktree' && !this.table.madeWorktree(agent.folder) && fs.existsSync(agent.folder)) {
				const repository = await this.ports.git.repositoryOf(agent.folder).catch(() => undefined);
				if (repository && !repository.mainCheckout && repository.worktree === agent.worktree && repository.head !== undefined && !this.disposed) {
					this.table.recordWorktree({ name: agent.worktree, folder: agent.folder, repository: repository.main, commit: repository.head, ...(agent.creator !== undefined ? { madeBy: agent.creator } : {}) });
				}
			}
		}
		// They ended together: none's unread messages go back to another of them (AGENT-MESSAGES.md, M10)
		this.settling = [];
		try {
			for (const agent of gone) {
				// The window has no terminal for it, yet its own process runs on - a CLI that ignored the hang-up its
				// terminal's going sent it: nobody can reach it now, so it is ended by its process, and its end is
				// recorded once it is gone, not before (AGENT-LAUNCHER.md, LA-15; N-24)
				if (this.runningProcessOf(agent) !== undefined) {
					this.background(`Ending ${describe(agent)}, cut off from its terminal`, this.endCutOff(agent, closedByThePerson));
					continue;
				}
				this.endedUnseen(agent, closedByThePerson);
			}
		} finally {
			const settled = this.settling;
			this.settling = undefined;
			for (const [agent, notice] of settled) {
				this.messagesOfEnded(agent, notice);
			}
		}
		// What was put into folders for agents that ended while no window was there to see it.
		if (this.sweep()) {
			this.takeBackLater();
		}
		// A fresh start begins a new list: the agents that ended leave it, and the log keeps them, and their mailboxes
		// are emptied - the chat rooms keep their messages (M10). Not a reload, nor this window's extension host
		// starting again - nor a window coming back after its renderer crashed, which the window cannot tell from a
		// start but its agents can: some came back, or may yet (L12: "at an ordinary fresh app start" only; N-36)
		const fresh = !reloaded && !last?.thisWindow && !cameBack && !untold.length;
		if (fresh && ([...this.table.state.agents.values()].some(agent => !isLive(agent)) || this.table.state.mail.mailboxes.size)) {
			const endedBefore = [...this.table.state.agents.values()].filter(agent => !isLive(agent)).map(agent => agent.id);
			this.table.clearList();
			// Their screens go with the agents that leave the list (AGENT-DEBUGGING.md, D6)
			this.screens.discard(new Set(endedBefore.filter(id => !this.table.state.agents.has(id))));
		}
		this.mail.recover(fresh, last?.by === 'facade');
		this.endLeftBehind();
	}

	/**
	 * Ends the agents of untitled workspaces whose windows went - quit, or closed - in records no window opens
	 * again: VS Code asks to save an untitled workspace as its window goes, and deletes one not saved; one saved
	 * opens under its file, with a record of its own. Those agents went with their windows (L12), and their
	 * records said they ran for good (N-63). One whose process runs on is left as it is; a record a window has,
	 * or closed a moment ago - reloading - is not touched.
	 */
	private endLeftBehind(): void {
		const root = path.dirname(this.table.dir);
		const isRunning = this.options.isRunning ?? isProcessRunning;
		let dirs: string[];
		try {
			dirs = fs.readdirSync(root).map(name => path.join(root, name)).filter(dir => !isEqualPath(dir, this.table.dir) && identityOf(dir)?.startsWith('untitled:'));
		} catch {
			return;
		}
		for (const dir of dirs) {
			const closed = closedByItsWindow(dir, isRunning);
			if (!closed) {
				continue;
			}
			try {
				// Its lock left as its window closed it, for that window, should it come back after all
				const table = AgentTable.open({ dir, isRunning, ...closed });
				try {
					for (const agent of [...table.state.agents.values()].filter(isLive)) {
						if (agent.processId !== undefined && isRunning(agent.processId)) {
							continue;
						}
						const end = cutBeforeLaunch(agent)
							? table.end(agent.id, 'failed', cutReason(agent, !!table.madeWorktree(agent.folder) && fs.existsSync(agent.folder), false))
							: agent.state === 'stopping'
								? table.end(agent.id, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}) })
								: table.end(agent.id, 'stopped', 'its window went');
						if (end) {
							this.log(`${describe(agent)} of the untitled workspace whose record is ${dir} ended (${end.kind}): ${end.reason}`);
						}
					}
				} finally {
					table.dispose('window');
				}
			} catch (err) {
				this.log(`The agents of the untitled workspace whose record is ${dir}, whose window went, could not be recorded as ended: ${messageOf(err)}`);
			}
		}
	}

	/**
	 * Records the end of an agent whose process was gone as Facade came back: one set out to be stopped was
	 * stopped; one the window saw end ended as it did - its tab closed by the person, or its CLI exited with
	 * its code (AGENT-LAUNCHER.md, L12: a known exit is recorded) - but one killed, which is no exit of its
	 * CLI's, is lost, its reason naming the signal (D11); any other went with its window, or is lost - failed,
	 * had it not started. Nobody is told: it ended while no window was there to see it.
	 */
	private endedUnseen(agent: LiveAgent, closedByThePerson: boolean): void {
		const end = this.ports.terminals.endOf?.(agent.id);
		if (cutBeforeLaunch(agent)) {
			const made = !!this.table.madeWorktree(agent.folder) && fs.existsSync(agent.folder);
			// Its setup goes with the window that went - not with an extension host that started again in this very
			// window, whose terminals are the person's, untouched (WIN-03)
			const hostOnly = !!this.table.lastClose?.thisWindow || this.sameWindow;
			if (made && !hostOnly) {
				this.ports.git.stopSetup(agent.folder);
			}
			this.ended(agent, 'failed', cutReason(agent, made, hostOnly), { quiet: true });
			return;
		}
		if (agent.state === 'stopping') {
			this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}) });
		} else if (end?.byThePerson) {
			this.ended(agent, 'stopped', end.reason === 'worktreeDeleted' ? 'its worktree was deleted' : 'its tab was closed', { by: 'human', quiet: true });
		} else if (end?.exitCode !== undefined && end.exitCode >= 0 && signalOf(end.exitCode) === undefined) {
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'exited', `its CLI ended with exit code ${end.exitCode} while Facade was away`, { exitCode: end.exitCode, quiet: true });
		} else if (end?.exitCode !== undefined) {
			// Killed, which Facade did not see - no exit of its CLI's own: lost, saying what is known (D11)
			const signal = signalOf(end.exitCode);
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', signal !== undefined ? `its CLI was killed (signal ${signal}) while Facade was away` : HOST_RESTARTED, { quiet: true });
		} else if (closedByThePerson) {
			// The whole window went: nobody is told, and the person's messages to it are no news to them (M8)
			this.ended(agent, 'stopped', 'its window went', { quiet: true, windowWent: true });
		} else {
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', 'its terminal was gone when Facade came back', { quiet: true });
		}
	}

	/** An agent found again as Facade came back: one set out to be stopped is stopped again; any other goes on as it was. */
	private goOn(agent: LiveAgent): void {
		if (agent.state === 'stopping') {
			this.background(`Stopping ${describe(agent)} again`, this.stopOne(agent, agent.stopping?.by, agent.stopping?.reason ?? 'with stop_agent'));
		} else {
			this.launcher.resume(agent);
		}
	}

	/**
	 * An agent the window has back, its process running, goes on. One whose record never got its process - the
	 * window went between making its terminal and Facade hearing of it - takes the process the window has: what
	 * goes by it, an end the window does not see among them, would never know it otherwise (N-79).
	 */
	private cameBackRunning(agent: LiveAgent): void {
		if (agent.processId === undefined) {
			const processId = this.ports.terminals.processIdOf?.(agent.id);
			if (processId !== undefined) {
				this.table.launched(agent.id, processId);
			}
		}
		// The window gave its terminal back knowing nothing of where its final screen goes (D6)
		this.background(`Telling the window where the final screen of ${describe(agent)} goes`, this.ports.terminals.register(agent.id, this.screens.finalScreenOf(agent)).then(found => {
			if (!found) {
				this.log(`${describe(agent)} came back, but the window could not be told where its final screen goes: it will not be kept.`);
			}
		}));
		const now = this.table.get(agent.id);
		this.goOn(isLive(now) ? now : agent);
	}

	/**
	 * Asks again, a while on, after the agents whose processes the window could not tell of as Facade came
	 * back (AGENT-LAUNCHER.md, L12): one found goes on as it was; one gone ended unseen - stopped, had Facade
	 * set out to stop it, else lost, or failed had it not started - and nobody is told; one still not told of
	 * is asked after again, a few times, and then left as it is, which the log says.
	 */
	private async findAgain(agents: readonly LiveAgent[]): Promise<void> {
		let left = [...agents];
		for (let tries = 0; left.length && tries < FIND_AGAIN_TRIES; tries++) {
			await timeout(FIND_AGAIN_MS);
			if (this.disposed) {
				return;
			}
			const still: LiveAgent[] = [];
			for (const each of left) {
				const agent = this.table.get(each.id);
				if (!isLive(agent)) {
					continue;
				}
				let alive: boolean;
				try {
					alive = await this.ports.terminals.isAlive(agent.id);
				} catch {
					still.push(agent);
					continue;
				}
				if (this.disposed) {
					return;
				}
				if (alive) {
					this.cameBackRunning(agent);
				} else {
					this.endedUnseen(agent, false);
				}
			}
			left = still;
		}
		for (const agent of left) {
			this.log(`Whether ${describe(agent)} still runs is not known: the window could not tell. It stays as it was; closing its tab, or stop_agent, ends it.`);
		}
	}

	/**
	 * Stops one agent, as closing its tab does: Facade records that it set out to stop it - by whom, and why -
	 * ends its process, or its start if it has no process yet, and records its end once its process has ended.
	 * A stop of one stopping already joins it. Rejects, the agent left stopping, where its process has not
	 * ended within the timeout.
	 */
	private async stopOne(agent: Agent, by: StoppedBy | undefined, reason: string): Promise<void> {
		const current = this.table.get(agent.id);
		if (!isLive(current)) {
			return;
		}
		// A stop of one stopping already joins it: who stops it, and why, are the first stop's (O5).
		const first = current.state === 'stopping' ? current.stopping : undefined;
		const stopBy = first ? first.by : by;
		const why = first?.reason ?? reason;
		if (!first) {
			this.table.stopping(agent.id, why, stopBy);
			this.launcher.ended(agent.id, `it was stopped ${why}`);
			// A start in its worktree's setup: the setup terminal is the start's, and goes with it (O4)
			if (current.phase === 'running_setup') {
				this.ports.git.stopSetup(current.folder);
			}
		}
		// Its time counts from the stop's acceptance - a launch it waits for included (X-15)
		const ms = this.timing().startTimeoutMs;
		const deadline = Date.now() + ms;
		const pending = (cause: string) => {
			this.log(`${describe(agent)} has not ended yet: ${cause}`);
			this.keepStopping(agent, stopBy, why);
			return new FacadeError('UNAVAILABLE', `${describe(agent)} is still stopping: its process has not ended within ${Math.round(ms / 1000)} seconds. Facade goes on stopping it; list_agents shows when it has ended.`, { outcome: 'pending', agent: agent.id });
		};
		// A launch under way opens its terminal first, or gives up seeing the stop: never one afterwards (O9).
		const over = new AbortController();
		const opened = await Promise.race([this.launcher.whenOpened(agent.id).then(() => true), timeout(Math.max(0, deadline - Date.now()), over.signal).then(() => false, () => true)]);
		over.abort();
		if (!opened) {
			throw pending('its terminal is still being opened');
		}
		let exitCode: number | undefined;
		for (; ;) {
			try {
				exitCode = (await this.ports.terminals.stop(agent.id)).exitCode;
				// The window says it is gone; its process says so too, or it is not (N-24)
				if (this.runningProcessOf(agent) !== undefined) {
					throw new Error('the window has no terminal for it, and its process still runs');
				}
				break;
			} catch (err) {
				// Its own process is gone, though the window cannot close a terminal of it - one of a window that
				// went, its terminal not taken back: it has ended, and so has its stop (run 4: WIN-03)
				if (this.processGone(agent)) {
					break;
				}
				if (Date.now() >= deadline || this.disposed) {
					throw pending(messageOf(err));
				}
				await timeout(500);
			}
		}
		const now = this.table.get(agent.id);
		if (isLive(now)) {
			// With its CLI's code, where it exited as it was stopped (N-19)
			this.ended(now, 'stopped', why, { ...(stopBy !== undefined ? { by: stopBy } : {}), ...(exitCode !== undefined ? { exitCode } : {}) });
		}
	}

	/**
	 * Ends an agent that came back with no terminal, its own process running on: termination, then a kill it
	 * cannot ignore; its end recorded, as one that ended unseen, once its process is gone - and not while it runs.
	 */
	private endCutOff(agent: LiveAgent, closedByThePerson: boolean): Promise<void> {
		return this.endOnceGone(agent, now => this.endedUnseen(now, closedByThePerson));
	}

	/**
	 * Ends an agent whose own process runs on though its terminal is gone: termination, then a kill it cannot
	 * ignore; `record` records its end once the process is gone, not before (N-24). One that runs on even so
	 * stays as it is.
	 */
	private async endOnceGone(agent: LiveAgent, record: (now: LiveAgent) => void): Promise<void> {
		for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
			const pid = this.runningProcessOf(agent);
			if (pid === undefined || await this.signalProcessOf(agent, pid, signal)) {
				break;
			}
		}
		if (this.runningProcessOf(agent) !== undefined) {
			this.log(`${describe(agent)} runs on, cut off from its terminal, even killed: it stays as it is.`);
			return;
		}
		const now = this.table.get(agent.id);
		if (isLive(now) && !this.disposed) {
			record(now);
		}
	}

	/** Sends the agent's own process `pid` `signal`, and answers whether it is gone a while on. */
	private async signalProcessOf(agent: Agent, pid: number, signal: StopSignal): Promise<boolean> {
		try {
			(this.options.killProcess ?? ((target, kill) => process.kill(target, kill)))(pid, signal);
		} catch {
			// Gone meanwhile
		}
		for (const until = Date.now() + PROCESS_END_WAIT_MS; this.runningProcessOf(agent) !== undefined && Date.now() < until;) {
			await timeout(200);
		}
		return this.runningProcessOf(agent) === undefined;
	}

	/**
	 * The process of `agent` where it still runs: its CLI's, by the id the record has, started as the record
	 * says it was launched - not one that got the id since. Undefined where it is gone, or the system cannot
	 * tell when it started.
	 */
	/**
	 * Whether `agent`'s own process is known to be gone: the id it was launched with runs no more, or runs a
	 * process started at another time - its id given again. Not where its id or start cannot be told.
	 */
	private processGone(agent: Agent): boolean {
		const now = this.table.get(agent.id) ?? agent;
		const pid = now.processId;
		if (pid === undefined || now.launchTime === undefined) {
			return false;
		}
		if (!(this.options.isRunning ?? isProcessRunning)(pid)) {
			return true;
		}
		const started = (this.options.processStartedAt ?? processStartedAt)(pid);
		return started !== undefined && Math.abs(started - now.launchTime) > PROCESS_START_SLACK_MS;
	}

	private runningProcessOf(agent: Agent): number | undefined {
		const now = this.table.get(agent.id) ?? agent;
		const pid = now.processId;
		if (pid === undefined || now.launchTime === undefined || !(this.options.isRunning ?? isProcessRunning)(pid)) {
			return undefined;
		}
		const started = (this.options.processStartedAt ?? processStartedAt)(pid);
		return started !== undefined && Math.abs(started - now.launchTime) <= PROCESS_START_SLACK_MS ? pid : undefined;
	}

	/**
	 * Goes on stopping an agent whose process outlived its stop's time, as its answer said it would (X-22):
	 * termination, then a kill it cannot ignore; its end recorded once its process is gone.
	 */
	private keepStopping(agent: Agent, by: StoppedBy | undefined, why: string): void {
		if (this.disposed) {
			return;
		}
		this.background(`Stopping ${describe(agent)}`, (async () => {
			await this.launcher.whenOpened(agent.id);
			for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
				if (this.disposed || !isLive(this.table.get(agent.id))) {
					return;
				}
				let windowSaysGone = false;
				let exitCode: number | undefined;
				try {
					exitCode = (await this.ports.terminals.stop(agent.id, signal)).exitCode;
					windowSaysGone = true;
				} catch {
					// Not yet: its process, then
				}
				// A process the window has no terminal for - or one that outlived its terminal's signal - is sent
				// the signal itself: it is the agent's own, started as the record says it was launched (N-24)
				const pid = this.runningProcessOf(agent);
				if (pid !== undefined) {
					if (!await this.signalProcessOf(agent, pid, signal)) {
						continue;
					}
				} else if (!windowSaysGone && !this.processGone(agent)) {
					continue;
				}
				const now = this.table.get(agent.id);
				if (isLive(now)) {
					this.ended(now, 'stopped', why, { ...(by !== undefined ? { by } : {}), ...(exitCode !== undefined ? { exitCode } : {}) });
				}
				return;
			}
			this.log(`${describe(agent)} has not ended, even killed: its terminal shows what holds it.`);
		})());
	}

	/**
	 * What deleting the worktree `folder` of `repository` would lose, as a refusal names it - besides what
	 * Facade put there and nobody changed, and with what someone changed of it, which git may not show;
	 * undefined where nothing would be lost.
	 */
	private async changesIn(folder: string, repository: DeletionTarget): Promise<string | undefined> {
		const named = (list: readonly string[]) => list.length > SHOWN_CHANGES ? `${list.slice(0, SHOWN_CHANGES).join(', ')} and ${list.length - SHOWN_CHANGES} more` : list.join(', ');
		// What a deletion left holds no git to ask: what of it the branch does not hold as it is, is work
		if (repository.leftover !== undefined) {
			const work = await this.ports.git.leftoverWorkIn(repository.main, repository.leftover, folder);
			return work.length ? `what a deletion left of it holds ${work.length} ${work.length === 1 ? 'file' : 'files'} its branch ${repository.leftover} does not hold as ${work.length === 1 ? 'it is' : 'they are'} (${named(work)})` : undefined;
		}
		const changes = await this.ports.git.changesIn(folder);
		const owned = (await this.ownFilesIn(folder, repository)).map(file => file.path);
		const files = [...new Set([...changes.files.filter(file => !owned.includes(file)), ...this.editedIn(folder)])];
		if (!files.length && !changes.unsaved.length && !changes.submodules.length) {
			return undefined;
		}
		return [
			...files.length ? [`${files.length} uncommitted or untracked ${files.length === 1 ? 'file' : 'files'} (${named(files)})`] : [],
			...changes.unsaved.length ? [`${changes.unsaved.length} unsaved ${changes.unsaved.length === 1 ? 'editor' : 'editors'} (${named(changes.unsaved)})`] : [],
			// Git keeps no copy of a submodule's commits in the repository: those not pushed go with it (X-14)
			...changes.submodules.length ? [`${changes.submodules.length} ${changes.submodules.length === 1 ? 'submodule' : 'submodules'} (${named(changes.submodules)}), with any of ${changes.submodules.length === 1 ? 'its' : 'their'} commits not pushed`] : []
		].join(' and ');
	}

	/**
	 * Another window's agents that use what Facade put into `folder` and may still run. Where its record cannot
	 * be read, nobody can tell: a deletion is refused rather than made blind.
	 */
	private othersUsing(folder: string): readonly InjectionUser[] {
		try {
			return this.injections.othersUsing(folder, this.table.dir);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `Whether agents of another window work in ${folder} cannot be told: what Facade put into folders could not be read (${messageOf(err)}). Nothing was stopped.`);
		}
	}

	/**
	 * The files Facade put into the worktree `folder` of `repository` that are no one's work, with their
	 * hashes: unchanged since Facade wrote them, and - one Facade merged its part into - what was there before
	 * is what the commit has, the change Facade's part alone (AGENT-ORCHESTRATION.md, O5). A file of the
	 * person's not committed, or changed before, is theirs (X-23). None where its record cannot be read.
	 */
	private async ownFilesIn(folder: string, repository: DeletionTarget): Promise<readonly OwnedFile[]> {
		let unchanged: readonly UnchangedFile[];
		try {
			unchanged = this.injections.ownedUnchanged(folder);
		} catch (err) {
			this.log(`What Facade put into ${folder} could not be read: ${messageOf(err)}`);
			return [];
		}
		const owned: OwnedFile[] = [];
		for (const file of unchanged) {
			if (file.theirs !== undefined) {
				let committed: string | undefined;
				try {
					committed = repository.head === undefined ? undefined : await this.ports.git.fileAt(repository.main, repository.head, file.path);
				} catch (err) {
					this.log(`What ${file.path} holds at ${repository.head} could not be read: ${messageOf(err)}`);
					committed = undefined;
				}
				if (committed === undefined || committed !== Buffer.from(file.theirs, 'base64').toString('utf8')) {
					continue;
				}
			}
			owned.push({ path: file.path, sha256: file.sha256 });
		}
		return owned;
	}

	/** The files Facade put into `folder` that someone changed since: work. Where its record cannot be read, nobody can tell. */
	private editedIn(folder: string): readonly string[] {
		try {
			return this.injections.editedSince(folder);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `What was changed of what Facade put into ${folder} cannot be told: what Facade put into folders could not be read (${messageOf(err)}). Nothing was stopped.`);
		}
	}

	/** Holds `branch` of the repository whose main checkout is `main` for a start, until disposed: once is enough. */
	private reserveBranch(main: string, branch: string): { dispose(): void } {
		const entry = { main, branch };
		this.branchesBeingMade.push(entry);
		return {
			dispose: () => {
				const at = this.branchesBeingMade.indexOf(entry);
				if (at >= 0) {
					this.branchesBeingMade.splice(at, 1);
				}
			}
		};
	}

	/** Refuses a start in a worktree being deleted. */
	private assertNotDeleting(folder: string): void {
		if (this.deletions.some(each => isEqualPath(each.folder, folder))) {
			throw new FacadeError('REFUSED', `${folder} is being deleted: no agent starts there.`);
		}
	}

	/**
	 * Where a child of the caller starts: a folder of the window - by its absolute path, or in the caller's own
	 * repository by the branch checked out there - the caller's own folder where none is named, or a new
	 * worktree of that folder's repository on the branch `name`. Refused before anything is made: what names
	 * no folder of the window, a branch checked out in two worktrees, a worktree being deleted, and a new
	 * worktree outside any repository, on a branch that is there or that git takes for no branch, or with no
	 * commit to start at.
	 */
	private async placeOf(caller: Caller, named: string | undefined, newWorktree: boolean, name: string): Promise<Place> {
		const own = this.agentOf(caller)?.folder;
		// The person's own is the folder on their screen (AGENT-ORCHESTRATION.md, O3).
		const here = own ?? (caller.id === undefined ? await this.ports.workspace.activeFolder() : undefined);
		const wanted = named?.trim();
		const folder = !wanted ? here : path.isAbsolute(wanted) ? await this.windowFolderAt(wanted) : await this.worktreeOnBranch(here, wanted);
		if (folder === undefined) {
			throw new FacadeError('INVALID', 'folder is required here: the person has no folder on screen. Name a folder of the window by its absolute path.');
		}
		this.assertNotDeleting(folder);
		if (!fs.existsSync(folder)) {
			throw new FacadeError('NOT_FOUND', `${folder} is not on the disk any more: no agent starts there. Name a folder of the window by its absolute path.`);
		}
		const repository = await this.ports.git.repositoryOf(folder);
		if (!newWorktree) {
			return { kind: 'folder', folder, worktree: repository?.worktree ?? path.basename(folder), main: repository?.main ?? folder, outsideGit: !repository };
		}
		if (!repository) {
			throw new FacadeError('REFUSED', `${folder} is in no git repository, so no worktree of it can be made: start the child in the folder itself, without new_worktree.`);
		}
		// At the caller's commit in its own repository - the person's checkout being the folder on their screen (O3;
		// N-06) - and in another at its main checkout's.
		const ownRepository = here === undefined || !fs.existsSync(here) ? undefined : await this.ports.git.repositoryOf(here);
		const from = ownRepository && isEqualPath(ownRepository.main, repository.main) ? { folder: here, head: ownRepository.head } : { folder: repository.main, head: (await this.ports.git.repositoryOf(repository.main))?.head };
		if (from.head === undefined) {
			throw new FacadeError('REFUSED', `${from.folder} has no commit for a new worktree to start at: it is on a branch with no commit yet, or one git cannot read.`);
		}
		let notABranch: string | undefined;
		try {
			notABranch = await this.ports.git.whyNotBranchName(repository.main, name);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `git did not say whether ${name} can be a branch: ${messageOf(err)}. Nothing was made; try again.`);
		}
		if (notABranch !== undefined) {
			throw new FacadeError('REFUSED', `${name} cannot be the branch of a new worktree: ${notABranch}. Give the child another name.`);
		}
		if (await this.ports.git.hasBranch(repository.main, name)) {
			throw new FacadeError('REFUSED', `${path.basename(repository.main)} has a branch called ${name} already, and a new worktree is on a new branch, named after the child: give the child another name, or start it in the worktree of ${name} by its folder.`);
		}
		if (this.branchesBeingMade.some(each => isEqualPath(each.main, repository.main) && each.branch === name)) {
			throw new FacadeError('REFUSED', `${path.basename(repository.main)} has a branch called ${name} being made already, for another start: give the child another name.`);
		}
		return { kind: 'new', repository, head: from.head, branch: name };
	}

	/**
	 * The folder of the window that is `folder`. Where none is, refused, naming the window's folders: a folder,
	 * or a file, that is there and that its window does not have, `REFUSED` - it exists, and is out of reach;
	 * one that is not there at all, `NOT_FOUND` (AGENT-ORCHESTRATION.md, O2).
	 */
	private async windowFolderAt(folder: string): Promise<string> {
		const folders = await this.windowFolders();
		const found = folders.find(each => isEqualPath(each.folder, folder));
		if (!found) {
			const listed = `Its folders: ${folders.map(each => each.folder).join(', ')}.`;
			if (this.ports.workspace.folders().some(each => isEqualPath(each, folder)) && !fs.existsSync(folder)) {
				throw new FacadeError('NOT_FOUND', `${folder} is a folder of this window that is not on the disk any more: no agent starts there. ${listed}`);
			}
			if (fs.existsSync(folder)) {
				throw new FacadeError('REFUSED', `${folder} is ${fs.statSync(folder).isDirectory() ? 'a folder' : 'a file'} this window does not have: an agent starts in a folder of the window, a worktree of one, or a new worktree. ${listed}`);
			}
			throw new FacadeError('NOT_FOUND', `${folder} is no folder of this window. ${listed}`);
		}
		return found.folder;
	}

	/**
	 * The worktree of the repository of the caller's folder `own` that has `branch` checked out; refused where
	 * the caller has no repository, no worktree has the branch, or git was forced to check it out in two.
	 */
	private async worktreeOnBranch(own: string | undefined, branch: string): Promise<string> {
		const repository = own === undefined ? undefined : await this.ports.git.repositoryOf(own);
		if (!repository) {
			throw new FacadeError('INVALID', `${branch} is no absolute path, and ${own === undefined ? 'the person has no folder on screen' : `${own} is in no repository`} for it to be a branch of. Name a folder of the window by its absolute path.`);
		}
		const listed = await this.ports.git.worktreesOf(repository.main);
		const on = listed.filter(each => each.branch === branch);
		if (on.length > 1) {
			throw new FacadeError('INVALID', `${branch} is checked out in ${on.length} worktrees of ${path.basename(repository.main)}: ${on.map(each => each.folder).join(', ')}. Name the one you mean by its folder.`);
		}
		if (!on.length) {
			throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} has ${branch} checked out. Its worktrees: ${listed.map(each => `${each.name} at ${each.folder}`).join(', ')}. A folder is named by its absolute path; a worktree on a detached HEAD, by its folder.`);
		}
		return on[0].folder;
	}

	/**
	 * An agent's process ended: the agent ended, unless it had already. One Facade set out to stop was
	 * stopped, by whom it says; closed with its tab by the person, it was stopped by them; else its CLI ended
	 * by itself - with its exit code, where it is known - or it did not start.
	 */
	private terminalEnded(id: number, end: TerminalEnd): void {
		const found = this.liveAgents().find(each => each.id === id);
		if (!found) {
			return;
		}
		// A closed terminal is a stop, the person's own, which finishes once the process has ended (AGENT-LAUNCHER.md:
		// "Terminal close is the human stop action"; O-stop): a CLI that ignores the hang-up is ended by its process
		if (this.runningProcessOf(found) !== undefined) {
			this.background(`Ending ${describe(found)}, its terminal closed`, this.endOnceGone(found, now => this.terminalEndRecorded(now, end)));
			return;
		}
		this.terminalEndRecorded(found, end);
	}

	/** Records the end of an agent whose terminal closed, its own process gone, as the window saw it end. */
	private terminalEndRecorded(agent: LiveAgent, end: TerminalEnd): void {
		try {
			if (agent.state === 'stopping') {
				this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}), ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}) });
			} else if (end.byThePerson) {
				this.ended(agent, 'stopped', end.reason === 'worktreeDeleted' ? 'its worktree was deleted' : 'its tab was closed', { by: 'human' });
			} else if (end.exitCode !== undefined && end.exitCode < 0) {
				// No exit code: no CLI exits -1, its process went with the terminal host (TM-17)
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', HOST_RESTARTED);
			} else {
				const reason = end.exitCode === undefined ? 'its terminal closed' : `its CLI ended with exit code ${end.exitCode}`;
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'exited', reason, end.exitCode !== undefined ? { exitCode: end.exitCode } : {});
			}
		} catch (err) {
			this.log(`Recording that ${describe(agent)} ended failed: ${messageOf(err)}`);
		}
	}

	/**
	 * Records how an agent ended - once - and takes back what was put into its folder once no agent runs
	 * there. The person hears of an agent they started that ended unexpectedly (AGENT-LAUNCHER.md, L6): its
	 * CLI exited with a code other than 0, or 130 from the keyboard - or one the window could not tell - or it
	 * was stopped other than by them;
	 * nothing of what they did, of a window that went, of a lost agent, or of a start of theirs that says it
	 * failed itself. The agents it started are not touched. Answers with its end; undefined for an agent that
	 * had ended already, or once the window closed.
	 */
	private ended(agent: Agent, kind: EndKind, reason: string, details: { readonly by?: StoppedBy; readonly exitCode?: number; readonly quiet?: boolean; readonly windowWent?: boolean } = {}): End | undefined {
		if (this.disposed) {
			return undefined;
		}
		// Read before the start that waits for it, if one does, hears of its end.
		const answered = this.launcher.answers(agent.id);
		const end = this.table.end(agent.id, kind, reason, { ...(details.by !== undefined ? { by: details.by } : {}), ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}) });
		if (!end) {
			return undefined;
		}
		this.log(`${describe(agent)} ended (${kind}): ${reason}`);
		this.launcher.ended(agent.id, reason);
		this.withdraw(agent);
		// A start that answers its caller says how it failed itself; what the person did is no news to them.
		const unexpected = (kind === 'exited' && details.exitCode !== 0 && details.exitCode !== INTERRUPTED)
			|| (kind === 'stopped' && typeof details.by === 'number')
			|| (kind === 'failed' && !answered);
		if (agent.creator === undefined && !details.quiet && unexpected) {
			this.ports.person.tell(endNotice(agent, end, this.table.whoIs(end.by)), agent.id, endSeverity(end));
		}
		// Its messages: those unread go back to their senders, and its creator, an agent, hears of its end (M6, M8)
		const notice: EndNotice = {
			how: howItEnded(end, this.table.whoIs(end.by)),
			// Every end, exit 0 too - but a stop it asked for, one its start answered it with, and the window going
			tell: agent.creator !== undefined && !details.windowWent && !answered && !(end.kind === 'stopped' && end.by === agent.creator),
			// Senders the end is no news to: the creator its start answered, and the person whose window went
			knownTo: [...answered ? [agent.creator ?? HUMAN] : [], ...details.windowWent ? [HUMAN] : []] as Recipient[]
		};
		if (this.settling) {
			this.settling.push([agent, notice]);
		} else {
			this.messagesOfEnded(agent, notice);
		}
		return end;
	}

	/** An agent ended: its unread messages go back, and its creator hears of it as `notice` says. */
	private messagesOfEnded(agent: Agent, notice: EndNotice): void {
		try {
			this.mail.ended(this.table.get(agent.id) ?? agent, notice.how, notice.tell, notice.knownTo);
		} catch (err) {
			this.log(`The unread messages of ${describe(agent)}, and its creator's notice, could not all be recorded: ${messageOf(err)}`);
		}
	}

	/** Ends an agent whose launch failed before it had a process: recorded as failed, and its terminal closed. */
	private async fail(agent: Agent, reason: string): Promise<void> {
		if (!this.ended(agent, 'failed', reason)) {
			return;
		}
		try {
			await this.ports.terminals.stop(agent.id);
		} catch (err) {
			this.log(`${describe(agent)}'s terminal could not be closed: ${messageOf(err)}`);
		}
	}

	/**
	 * Gives a CLI that keeps it in a file the person's trust in the folder it starts in, as its
	 * `launch.trust` says: in the file the CLI reads in `env`, the environment it starts with. The entry
	 * stays: the person's to take out. A file that cannot take it fails the start, which would otherwise
	 * wait at the CLI's question (AGENT-LAUNCHER.md, L11).
	 */
	private trust({ cli, config }: InstalledCli, trusted: TrustedFolder, env: Environment): void {
		let done: ReturnType<typeof writeTrust>;
		try {
			// Under a lock every window takes: two windows trusting folders at once each keep the other's.
			done = writeTrust(cli, config, trusted, withFileLock, env);
		} catch (err) {
			throw new FacadeError('FAILED', `${cli.displayName}'s trust in ${trusted.folder} could not be given: ${messageOf(err)}`);
		}
		if (done) {
			this.log(done.text);
			if (done.outcome === 'unreadable') {
				throw new FacadeError('FAILED', done.text);
			}
		}
	}

	/** Lets go of what Facade put into folders for an agent that ended: what no agent may still use is taken back. */
	private withdraw(agent: Agent): void {
		try {
			if (this.injections.release({ workspace: this.table.dir, id: agent.id })) {
				this.takeBackLater();
			}
		} catch (err) {
			this.log(`What Facade put into ${agent.folder} could not be taken back: ${messageOf(err)}`);
		}
	}

	/** Takes back what no agent may still use; answers whether something is left to take back later. */
	private sweep(): boolean {
		try {
			return this.injections.sweep();
		} catch (err) {
			this.log(`What agents that ended left in folders could not be taken back: ${messageOf(err)}. The next window tries again.`);
			return false;
		}
	}

	/**
	 * Whether an agent that uses what Facade put into a folder may still run: one of this workspace's has
	 * not ended, as the record says; another's process runs - or, before it was known, its window is open.
	 */
	private mayRun(user: InjectionUser): boolean {
		if (isEqualPath(user.workspace, this.table.dir)) {
			const agent = this.table.get(user.id);
			return agent !== undefined && isLive(agent);
		}
		const isRunning = this.options.isRunning ?? isProcessRunning;
		return user.processId !== undefined ? isRunning(user.processId) : isLedgerHeld(user.workspace, isRunning);
	}

	/**
	 * Tries again, a while on, to take back what could not be taken back yet - a file the disk refused, a
	 * folder a process of an ended agent had in use, its CLI's a moment from its end - while some is left:
	 * each time some is, for another {@link TAKE_BACK_TRIES} tries.
	 */
	private takeBackLater(): void {
		this.takeBackTriesLeft = TAKE_BACK_TRIES;
		if (this.disposed || this.takingBack) {
			return;
		}
		const tryAgain = () => {
			this.takingBack = setTimeout(() => {
				this.takingBack = undefined;
				if (this.sweep() && --this.takeBackTriesLeft > 0 && !this.disposed) {
					tryAgain();
				}
			}, TAKE_BACK_AGAIN_MS);
		};
		tryAgain();
	}

	/**
	 * The agent `id` names - a built-in by its id, or a custom agent by its name; with `custom`, only the
	 * custom agent - as the person has Facade start it, found as a terminal in `folder` would find it.
	 * Refused, saying why and what can be started: one turned off, one not on this machine, and one whose
	 * settings are wrong.
	 */
	private async startableHere(id: string, folder: string, custom = false): Promise<{ readonly installed: InstalledCli; readonly config: CliConfig }> {
		const found = this.cliOf(id, custom);
		const startable = () => this.startable().map(each => each.id).join(', ') || 'none';
		if (!found) {
			throw new FacadeError('INVALID', `${id} is neither a CLI Facade starts nor a custom agent of the person's. It starts: ${startable()}.`);
		}
		const { cli, config } = found;
		if (!config.enabled) {
			throw new FacadeError('UNAVAILABLE', `${cli.displayName} is turned off: ${cli.setting}.enabled. It starts: ${startable()}.`);
		}
		if (config.wrong) {
			throw new FacadeError('UNAVAILABLE', `Facade cannot start ${cli.displayName} until the person puts its settings right: ${config.wrong.join('; ')}. Show Agent Launch shows them.`);
		}
		const env = { ...await this.options.clis.environment(folder), ...config.launch.environment };
		this.stillOpen();
		// Found as its terminal will find it: in the environment a terminal there has.
		const installed = this.options.clis.locate(cli, config, env, folder);
		if (!installed) {
			throw new FacadeError('UNAVAILABLE', `Facade cannot start ${cli.displayName} in ${folder}: ${whyNotInstalled(cli, config, 'the PATH a terminal there has')}.`);
		}
		return { installed, config };
	}

	/**
	 * A built-in by its id, or a custom agent by its name - with `custom`, only the custom agent: one named as
	 * a built-in is, which its settings say is wrong - as the person has Facade start it now.
	 */
	private cliOf(id: string, custom = false): { readonly cli: AgentCli; readonly config: CliConfig } | undefined {
		const builtIn = custom ? undefined : this.options.clis.known.find(cli => cli.id === id);
		return builtIn ? { cli: builtIn, config: this.options.clis.configOf(builtIn) } : this.options.clis.custom().find(each => each.cli.id === id);
	}

	/** The YOLO an agent the caller starts gets: its own for an agent, the setting's for the person; refused where the setting is no switch. */
	private yolo(caller: Caller): boolean {
		const creator = this.agentOf(caller);
		if (creator) {
			return creator.yolo;
		}
		try {
			return this.options.clis.yolo();
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `Facade starts no agent until the person puts this setting right: ${messageOf(err)}.`);
		}
	}

	/** Whether `caller` reaches `agent` (O1): the person every agent; an agent with YOLO on every agent of the window, with it off its own tree, ended ones too. */
	private reaches(caller: Caller, agent: Agent): boolean {
		const self = this.agentOf(caller);
		if (caller.id === undefined) {
			return true;
		}
		return !!self && (self.yolo || self.root === agent.root);
	}

	private assertReaches(caller: Caller, agent: Agent): void {
		if (!this.reaches(caller, agent)) {
			// By the number the caller gave alone: what is out of its reach it does not learn of (X-54)
			throw new FacadeError('REFUSED', `${agentRef(agent.id)} is outside your tree: your YOLO is off, and you reach only your own tree - the agents that come from the agent the person started that you come from.`);
		}
	}

	/** The environment a CLI starts with in `folder`: the terminals' there, with what its launch sets in it. */
	private async environmentOf(installed: InstalledCli, folder: string): Promise<Environment> {
		return { ...await this.options.clis.environment(folder), ...installed.config.launch.environment };
	}

	/**
	 * The agent a tool names (O2): by its number, `#a7`, `#7`, `a7` or `7`; by `@name`, where one agent that
	 * has not ended and that the caller reaches has that name; or as Facade's words name it, `@name #a7`, the
	 * number that agent's. A number of another kind, the person, and a bare number an agent that has not ended
	 * is also called are refused: no agent is named on a guess. A name only ended agents have answers with
	 * their numbers.
	 */
	private agentNamed(target: string, caller: Caller): Agent {
		const reference = parseAgentReference(target);
		const reach = [...this.table.state.agents.values()].filter(agent => this.reaches(caller, agent));
		if (reference.kind === 'other') {
			throw new FacadeError('INVALID', `${reference.text} is not an agent's number${/^#m/i.test(reference.text) ? ' but a message\'s' : ''}: agents are numbered #a1, #a2 and on.`);
		}
		if (reference.kind === 'number') {
			if (reference.bare) {
				const named = AgentTable.liveNamedIn(reach, target.trim().toLowerCase());
				if (named.length) {
					throw new FacadeError('INVALID', `${target.trim()} could be ${agentRef(reference.id)} or the name of ${named.map(describe).join(', ')}: write ${agentRef(reference.id)}, or the name with its number.`);
				}
			}
			const agent = this.table.get(reference.id);
			if (!agent) {
				throw new FacadeError('NOT_FOUND', `No agent is ${agentRef(reference.id)}: list_agents with all lists every agent you reach.`);
			}
			// One out of reach is refused before its name could be said (X-54)
			this.assertReaches(caller, agent);
			if (reference.name !== undefined && reference.name !== agent.name) {
				// No agent is both: the one named is not there (O2)
				throw new FacadeError('NOT_FOUND', `No agent is both @${reference.name} and ${agentRef(agent.id)}: ${agentRef(agent.id)} is @${agent.name}. Name it by its number alone, or by its name.`);
			}
			return agent;
		}
		if (reference.name === PERSON.name) {
			throw new FacadeError('INVALID', `@${reference.name} is the person, not an agent: the tools that manage agents do not take them.`);
		}
		const named = AgentTable.liveNamedIn(reach, reference.name);
		if (named.length > 1) {
			throw new FacadeError('INVALID', `${named.length} agents that have not ended are called @${reference.name}: ${named.map(describe).join(', ')}. Name one by its number.`);
		}
		if (!named.length) {
			const ended = reach.filter(agent => agent.name === reference.name);
			throw new FacadeError('NOT_FOUND', ended.length
				? `Every agent called @${reference.name} has ended: ${ended.map(describe).join(', ')}. Name the one you mean by its number.`
				: `No agent you reach is called @${reference.name}: list_agents with all lists them.`);
		}
		return named[0];
	}

	private nameOf(text: string): string {
		try {
			return agentName(text);
		} catch (err) {
			throw new FacadeError('INVALID', messageOf(err));
		}
	}

	/** An agent as the tools describe it. */
	private factsOf(agent: Agent): AgentFacts {
		return {
			id: agent.id,
			name: agent.name,
			...(agent.creator !== undefined ? { creator: agent.creator } : {}),
			root: agent.root,
			cli: agent.cli,
			custom: agent.custom,
			...(agent.model !== undefined ? { model: agent.model } : {}),
			...(agent.effort !== undefined ? { effort: agent.effort } : {}),
			ignored: agent.ignored,
			yolo: agent.yolo,
			sandbox: agent.sandbox,
			integration: agent.integration,
			connected: this.isConnected(agent),
			worktree: agent.worktree,
			...(agent.outsideGit ? { outsideGit: true as const } : {}),
			folder: agent.folder,
			state: agent.state,
			...(agent.state === 'starting' ? { phase: agent.phase ?? (agent.processId !== undefined ? 'connecting' : 'launching_cli') } : {}),
			...(agent.state === 'stopping' && agent.stopping ? { stopping: agent.stopping } : {}),
			startTime: agent.startTime,
			...(this.table.state.mail.tasks.has(agent.id) ? { taskMessage: this.table.state.mail.tasks.get(agent.id) } : {}),
			...(agent.end ? { end: agent.end } : {})
		};
	}

	private liveAgents(): LiveAgent[] {
		return [...this.table.state.agents.values()].filter(isLive);
	}

	/** How long the core waits, as the person sets it now. */
	private timing(): Timing {
		return timingOf(this.options.timing);
	}

	/**
	 * An agent's first line, with its task (AGENT-MESSAGES.md, M7): who it is, who created it - a creator that
	 * left the list by its number - what it was told of its preparation, and its task's number.
	 */
	private firstLineOf(agent: Agent, task: number): string {
		const creator = agent.creator === undefined ? PERSON : this.table.get(agent.creator) ?? { id: agent.creator, name: this.table.state.identities.get(agent.creator)?.name ?? '' };
		return this.options.setup.firstLine({ id: agent.id, name: agent.name }, creator, task, this.launcher.startNoteOf(agent.id));
	}

	/**
	 * The delays of what is typed into an agent's terminal, as its start had them - its run's plan - whatever the
	 * settings say now; for one whose plan cannot be read, its CLI's now, or the longest of its CLIs'.
	 */
	private delaysOf(agent: Agent): LaunchDelays {
		let delays = this.delays.get(agent.id);
		if (!delays) {
			try {
				delays = delaysOf(this.table.launchFileOf(agent.id));
			} catch {
				const launch = this.cliOf(agent.cli, agent.custom)?.config.launch;
				delays = launch ? { enterDelay: launch.enterDelay, taskDelay: launch.taskDelay } : UNKNOWN_DELAYS;
			}
			this.delays.set(agent.id, delays);
		}
		return delays;
	}

	private background(what: string, work: Promise<unknown>): void {
		inBackground(what, work, message => this.log(message));
	}

	private log(message: string): void {
		this.options.log(message);
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw windowClosed();
		}
	}
}

/** A sandbox as Facade's words say it. */
export function sandboxText(sandbox: Sandbox): string {
	return sandbox === 'unavailable' ? 'no sandbox' : sandbox === 'unknown' ? 'sandbox unknown' : `sandbox ${sandbox}`;
}

/**
 * Whether an agent found as Facade came back had its start cut before its CLI was launched: making its worktree,
 * or setting it up. No terminal was ever its, and none will be (O4).
 */
/**
 * The signal an agent's CLI was ended by, as the window writes one - 128 and its number, as a shell does
 * (`processExitCode`); undefined for an exit code of its own, and on Windows, which has no signals.
 */
function signalOf(exitCode: number): number | undefined {
	return process.platform !== 'win32' && exitCode > 128 && exitCode <= 128 + 64 ? exitCode - 128 : undefined;
}

/** Why an agent whose process the window has no exit code for - its terminal host restarted, which says -1 - is lost (TM-17). */
const HOST_RESTARTED = 'the window\'s terminal host restarted, ending its process';

function cutBeforeLaunch(agent: LiveAgent): boolean {
	return agent.state === 'starting' && (agent.phase === 'creating_worktree' || agent.phase === 'running_setup');
}

/**
 * Why a start cut before its CLI was launched failed: as the window went, or - `hostOnly` - as Facade started
 * again in this very window; and where its worktree stays, where `made`.
 */
function cutReason(agent: LiveAgent, made: boolean, hostOnly: boolean): string {
	const cut = hostOnly ? 'as Facade started again in this window' : 'as the window went';
	const where = agent.phase === 'creating_worktree' ? 'as its worktree was made' : 'as its worktree was set up';
	const left = made ? `; its worktree stays, at ${agent.folder}${hostOnly && agent.phase === 'running_setup' ? ', its setup going on in its terminal' : ''}` : '';
	return `its start was cut ${cut}, ${where}, before its CLI was launched${left}`;
}

/**
 * How an agent ended, as Facade's messages say it (AGENT-MESSAGES.md, M6, M8): "stopped by @lead #a1 with
 * stop_agent", "it exited, with exit code 1", "it did not start: ...". `stopper` names who stopped it.
 */
function howItEnded(end: End, stopper: string): string {
	switch (end.kind) {
		case 'stopped':
			return end.by === undefined ? `stopped: ${end.reason}` : /^(with|as) /.test(end.reason) ? `stopped by ${stopper} ${end.reason}` : `stopped by ${stopper}: ${end.reason}`;
		case 'exited':
			return end.exitCode !== undefined ? `it exited, with exit code ${end.exitCode}` : `it ended: ${end.reason}`;
		case 'failed':
			return `it did not start: ${end.reason}`;
		case 'lost':
			return `it was lost: ${end.reason}`;
	}
}

/** What the person is told of an agent of theirs that ended unexpectedly: who, how, and why. */
/**
 * How much the end of the person's own agent that is news to them matters: an exit with a code and a start that
 * failed are failures; losing it is not as it should be; another agent's stop of it, news (UI-17).
 */
function endSeverity(end: End): Severity {
	switch (end.kind) {
		case 'exited':
		case 'failed':
			return 'error';
		case 'lost':
			return 'warning';
		case 'stopped':
			return 'information';
	}
}

function endNotice(agent: Agent, end: End, stopper: string): string {
	switch (end.kind) {
		case 'exited':
			return l10n.t("{0} exited: {1}.", describe(agent), end.reason);
		case 'failed':
			return l10n.t("{0} did not start: {1}.", describe(agent), end.reason);
		case 'lost':
			return l10n.t("{0} was lost: {1}.", describe(agent), end.reason);
		case 'stopped':
			return typeof end.by === 'number'
				? l10n.t("{0} was stopped by {1}.", describe(agent), stopper)
				: l10n.t("{0} was stopped: {1}.", describe(agent), end.reason);
	}
}
