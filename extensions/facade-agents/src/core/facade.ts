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
import { Agent, agentRef, AgentState, Caller, describe, End, EndKind, Ignored, isLive, LiveAgent, parseAgentReference, PERSON, SetupState, StartPhase, StoppedBy, WorktreeRemoval } from '../record/events';
import { closedByItsWindow, isLedgerHeld } from '../record/ledger';
import { injectedFile } from '../record/paths';
import { screensDir } from '../record/screens';
import { LaunchDelays } from './doorbell';
import { ErrorOutcome, FacadeError } from './errors';
import { Injections, InjectionUser, UnchangedFile } from './injections';
import { delaysOf, inBackground, Launched, Launcher, LaunchProgress, notConnectedNotice, Prepared, timingOf, windowClosed } from './launch';
import { Mail, Mailbox } from './mail';
import { AgentSetup, CliCatalog, Disposable, EndedAgent, EndTold, MadeWorktreeFolder, OwnedFile, Ports, Repository, SetupProgress, Severity, StopSignal, TerminalEnd, TerminalsInside, Timing, WORKTREES_SETTING } from './ports';
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
/** How long after one of the person's agents ended unexpectedly the next's end joins its notification (M11). */
const ENDS_GATHERED_MS = 2_000;
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
	/** The platform agents' programs run on: this machine's unless a test says. */
	readonly platform?: NodeJS.Platform;
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
	/**
	 * What was asked for and is not known to be applied: left out, its launch having no group for it - or, an effort given
	 * with a model whose name may carry one of its own, passed on, the model's perhaps applying instead (O3, O6).
	 */
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
	/** How the setup of the worktree made for it went, once its start went on to its CLI (O11). */
	readonly setup?: SetupState;
	/** Who set out to stop it, and why, while it is stopping. */
	readonly stopping?: { readonly by?: StoppedBy; readonly reason: string };
	/**
	 * The removal of its folder's worktree with stop_agent, where one is under way or the last one failed - who asked for
	 * it, and why it failed - until one succeeds or the folder is gone (O5, O11; OR-15).
	 */
	readonly worktreeRemoval?: { readonly state: 'pending' } | { readonly state: 'failed'; readonly by?: StoppedBy; readonly reason?: string };
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
	/** Where its start is not confirmed as its worktree's setup runs: that setup's line running and its terminal's last lines, as they were then (O3). */
	readonly settingUp?: SetupProgress;
}

/**
 * How an agent ended, for its messages (AGENT-MESSAGES.md, M6, M8): `how`, as Facade's messages say it - "stopped
 * by @human", "it exited, with exit code 1"; and whether its creator, an agent, is told. Its unread messages go
 * back to every live sender, the person whose window went among them: M8 spares only the notice of an end (M6).
 */
interface EndNotice {
	/** How it ended, as a returned message says it (M6). */
	readonly how: string;
	/** How it ended, as its creator's notice says it: with its CLI's exit code where the window saw one (M8). */
	readonly told: string;
	readonly tell: boolean;
}

/**
 * How Facade's tools go for an agent with YOLO off, as Facade knew it at its launch (AGENT-LAUNCHER.md, L4, rule 4):
 * a setting of the person's that refuses them, which wins over the launch; the groups of Facade's launch that let
 * them through which the person changed; a custom agent's launch, all of it the person's. None of these: Facade's
 * own launch lets them through, never asked about.
 */
export interface ToolsExemption {
	/** The setting of the person's that refuses Facade's tools, in words: where, and the rule. */
	readonly refused?: string;
	readonly changed: readonly ('yoloOff' | 'connect')[];
	readonly custom: boolean;
}

/** That the person changed the groups of Facade's launch that let its server through, `changed`, as a clause (L4, rule 4). */
export function exemptionChangedText(changed: ToolsExemption['changed']): string {
	return `the launch's ${changed.join(' and ')} ${changed.length > 1 ? 'groups differ' : 'group differs'} from Facade's defaults for allowing tools without approval`;
}

/**
 * What a deletion waiting for agents still stopping did, as its error's data carries it - and its text says it:
 * the agents in the worktree it stopped, and those still stopping (AGENT-ORCHESTRATION.md, O2, O5).
 */
interface PendingDeletion extends ErrorOutcome {
	readonly outcome: 'pending';
	readonly agent: number;
	readonly stopped: readonly number[];
	readonly stopping: readonly number[];
}

/** The refusal of a deletion of `folder` that would lose `changes`, before anything is stopped (AGENT-ORCHESTRATION.md, O5). */
function lossRefusal(folder: string, changes: string): FacadeError {
	return new FacadeError('REFUSED', `Cannot delete ${folder} without losing work: ${changes}. Nothing was stopped. Commit work you need to keep, or retry with discard_changes:true to discard it.`);
}

/**
 * What the window's Delete Worktree stopped for a deletion with stop_agent, once it had moved off the worktree and taken
 * it out of the workspace (WORKTREE.md WT-8, step 6): nothing before it began.
 */
interface DeletionStops {
	began: boolean;
	readonly stopped: number[];
	readonly stopping: number[];
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
	/**
	 * Where the start of the agent the call named was when it was stopped, before its CLI had a terminal: its worktree
	 * being made - git may finish it - or set up (AGENT-ORCHESTRATION.md, O4; OR-05).
	 */
	readonly startStopped?: 'creating_worktree' | 'running_setup';
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
	/** The worktree's branch, as git has it now. */
	readonly branch?: string;
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
 * Who asks for a place to start, and how, on which what to do next after a refusal depends: the caller, whether it asks
 * for a new worktree, and whether worktree management was on as the start was accepted (AGENT-ORCHESTRATION.md, O3;
 * WORKTREE.md WT-9.3).
 */
interface PlaceRequest {
	readonly caller: Caller;
	readonly newWorktree: boolean;
	readonly managed: boolean;
}

/**
 * What a start's `folder` names that is no place to start: a folder - not the window's, or gone from the disk - a branch
 * that no listed worktree has checked out, or that cannot be looked up, a branch two have, or no repository to look in.
 */
type PlaceProblem = 'folder' | 'branch' | 'branches' | 'repository';

/**
 * What a start refused for `problem` says to do next, as `request` asks: while worktree management is on, an agent's child
 * goes in a worktree created by Facade, a new worktree is made of a Git repository folder, and the person may start in any
 * folder of the window; with it off, a folder the window knows is the one choice (AGENT-ORCHESTRATION.md, O3; WORKTREE.md
 * WT-9.3). A folder that is no place to start is answered with the window's `folders` - or, where it has none, with who can
 * add one, never with an empty list to choose from.
 */
function placeRecovery(request: PlaceRequest, problem: PlaceProblem, folders: readonly string[] = []): string {
	const byAgent = request.caller.id !== undefined;
	const { newWorktree, managed } = request;
	const listed = problem === 'folder';
	if (listed && !folders.length) {
		return managed && (byAgent || newWorktree)
			? 'No Git repository folder is available in this window. Ask the person to add a Git repository folder.'
			: 'No launch folder is available in this window. Ask the person to add a folder.';
	}
	let next: string;
	if (!managed) {
		next = 'Set folder to the absolute path of an existing window folder or a recorded agent launch folder.';
	} else if (problem === 'branches') {
		next = byAgent && !newWorktree
			? 'Set folder to the absolute path of one created by Facade, or set new_worktree:true and choose a Git repository folder in this window.'
			: 'Select a worktree by its absolute folder path.';
	} else if (newWorktree) {
		next = 'Keep new_worktree:true and set folder to the absolute path of a Git repository folder in this window.';
	} else if (byAgent) {
		next = problem === 'branch'
			? 'Set folder to the absolute path of a worktree created by Facade; a detached HEAD must be selected by path. To create a worktree, set new_worktree:true and folder to a Git repository folder in this window.'
			: 'Set folder to the absolute path of a worktree created by Facade, or set new_worktree:true and folder to a Git repository folder in this window.';
	} else {
		next = listed ? 'Set folder to an absolute path from this list.' : 'Set folder to the absolute path of a folder in this window; a detached HEAD must be selected by path.';
	}
	return listed ? `${next} ${managed ? 'Window' : 'Known'} folders: ${folders.join(', ')}.` : next;
}

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
	/** The new branches starts are making worktrees on, by their repositories' main checkouts: a second start on one is refused. */
	private readonly branchesBeingMade: { readonly main: string; readonly branch: string }[] = [];
	/**
	 * The deletions of worktrees under way with stop_agent: no agent starts there meanwhile, and a second deletion joins
	 * the first. Each with who asked for it, and what the window's Delete Worktree stopped for it (WORKTREE.md WT-8, step 6).
	 */
	private readonly deletions: { readonly folder: string; readonly done: Promise<Stopped>; readonly by: StoppedBy; readonly stops: DeletionStops }[] = [];
	/**
	 * The worktrees the person is deleting in the window: no agent starts there either, until the window says the deletion
	 * is done or failed - or, should it never say, a while on (WORKTREE.md WT-8, step 3; OR-10).
	 */
	private readonly personDeletions: { readonly folder: string; readonly timer: ReturnType<typeof setTimeout> }[] = [];
	/** The person's agents' ends told together: those that came within {@link ENDS_GATHERED_MS} of each other. */
	private endsTold: { readonly batch: string; readonly ends: EndTold[]; last: number } | undefined;
	/**
	 * The worktrees made for starts, by the agent's number, from when git is asked: the folder git made, or none where
	 * it made none - where a start stopped as git made it has its worktree, which its record does not say (O4).
	 */
	private readonly worktreesMaking = new Map<number, Promise<string | undefined>>();
	/** The processes of the agents' MCP servers, as each said in its hello, by number: every one that did. */
	private readonly servers = new Map<number, Set<number>>();
	/** How Facade's tools go for each agent with YOLO off, as its launch had it, by number: what it is told as it connects (L4, rule 4). */
	private readonly exemptions = new Map<number, ToolsExemption>();
	/**
	 * The agents stopped while a start waited for them, by number: that start answered its caller with the stop, so
	 * their end, however it is recorded after, is no news to their creator (AGENT-MESSAGES.md, M8).
	 */
	private readonly stoppedWhileAnswered = new Set<number>();
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
			...(options.platform ? { platform: options.platform } : {}),
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
		disposeAll(this.disposables.splice(0), err => this.log(`Error while shutting down Facade agents: ${messageOf(err)}`));
		clearTimeout(this.takingBack);
		this.takingBack = undefined;
		this.personDeletions.splice(0).forEach(each => clearTimeout(each.timer));
	}

	/** The agent numbered `id`, ended or not. */
	agent(id: number): Agent | undefined {
		return this.table.get(id);
	}

	/** The agent numbered `id` as the tools describe it, ended or not: what a start that failed answers with too (O3). */
	facts(id: number): AgentFacts | undefined {
		const agent = this.table.get(id);
		return agent && this.factsOf(agent);
	}

	/** Who started or stopped an agent, as Facade's words name them: `@lead #a1`, `@human`; a number alone for one the list no longer has. */
	whoIs(who: StoppedBy | undefined): string {
		return this.table.whoIs(who);
	}

	/** Tells the person of an unexpected end of an agent of theirs, in one notification with those just before it (M11). */
	private tellEnded(end: EndTold): void {
		const now = Date.now();
		if (!this.endsTold || now - this.endsTold.last > ENDS_GATHERED_MS) {
			this.endsTold = { batch: `${now}`, ends: [], last: now };
		}
		this.endsTold.ends.push(end);
		this.endsTold.last = now;
		this.ports.person.tellEnded(this.endsTold.batch, [...this.endsTold.ends]);
	}

	/** The agent a caller is; undefined for the person. */
	agentOf(caller: Caller): Agent | undefined {
		return caller.id === undefined ? undefined : this.table.get(caller.id);
	}

	/** What an agent must know of its start's preparation: its worktree's setup, sent with no word of how it went (O4). */
	startNoteOf(id: number): string | undefined {
		return this.launcher.startNoteOf(id);
	}

	/** A CLI's name for people, by its id: a custom agent's is its name. */
	cliName(id: string): string {
		return this.cliOf(id)?.cli.displayName ?? id;
	}

	/**
	 * Whether a CLI's model names may carry an effort of their own, by its id, where its launch through `start_agent` takes
	 * an effort: an effort given with a model is passed on, and may not be the one it runs at (N-64; OR-01).
	 */
	modelCarriesEffort(id: string): boolean {
		const found = this.cliOf(id);
		return !!found?.cli.modelCarriesEffort && capabilitiesOf(found.cli, launchFor(found.config, true)).effort;
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
			this.log(`Could not refresh available CLIs; keeping the last result: ${messageOf(err)}`);
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
	 * The folders of the window an agent can start in: its workspace's, and the worktrees Facade made of their
	 * repositories - those the workspace bar lists - each once, with the worktree it is. For one an agent starts, Facade's
	 * worktrees alone: while worktree management is on, an agent's child works in one, never in the person's checkout, a
	 * folder or another tool's worktree (AGENT-ORCHESTRATION.md, O3; WORKTREE.md WT-1.3). With worktree management off,
	 * git is not asked for worktrees: the workspace's folders, and those agents of its list were started in (WT-9.3).
	 */
	async windowFolders(forAgent = false): Promise<readonly WindowFolder[]> {
		const found: WindowFolder[] = [];
		const add = (folder: string, worktree: string) => {
			if ((!forAgent || this.ports.git.isFacadeWorktree(folder)) && !found.some(each => isEqualPath(each.folder, folder))) {
				found.push({ folder, worktree });
			}
		};
		const managed = this.ports.workspace.worktreesManaged();
		for (const folder of this.ports.workspace.folders()) {
			// One gone from the disk is no folder an agent can start in, and git cannot be asked about it (X-37)
			if (!fs.existsSync(folder)) {
				continue;
			}
			const repository = await this.ports.git.repositoryOf(folder);
			add(folder, repository?.worktree ?? path.basename(folder));
			for (const listed of repository && managed ? await this.ports.git.worktreesOf(repository.main) : []) {
				if (this.ports.git.isFacadeWorktree(listed.folder)) {
					add(listed.folder, listed.name);
				}
			}
		}
		if (!managed) {
			for (const agent of this.table.state.agents.values()) {
				if (fs.existsSync(agent.folder)) {
					add(agent.folder, agent.worktree);
				}
			}
		}
		return found;
	}

	/**
	 * How Facade's tools go with YOLO off for agent `id`, as Facade knew it at its launch (AGENT-LAUNCHER.md, L4, rule 4);
	 * undefined for one with YOLO on, which nothing asks, and for one this load of Facade did not launch.
	 */
	exemptionOf(id: number): ToolsExemption | undefined {
		return this.exemptions.get(id);
	}

	/**
	 * How Facade's tools go for a launch of `installed` in `folder` with YOLO off, as things are as it is made: a rule
	 * of the person's that refuses them, a group of Facade's launch that carries their exemption changed, a custom
	 * agent's launch, all of it the person's (AGENT-LAUNCHER.md, L4, rule 4). None with YOLO on, which asks nothing.
	 */
	private exemptionFor(installed: InstalledCli, yolo: boolean, unattended: boolean, env: Environment, folder: string): ToolsExemption | undefined {
		if (yolo) {
			return undefined;
		}
		const refused = installed.cli.exemptionOverride?.(launchFor(installed.config, unattended), env, folder);
		return { ...refused !== undefined ? { refused } : {}, changed: exemptionGroupsChanged(installed.cli, installed.config, unattended), custom: !!installed.cli.custom };
	}

	/**
	 * What its start says of `exemption`, where the person's settings take away what lets Facade's server through
	 * unasked: a deny rule of theirs, or a group of Facade's launch that carries it changed - never that it works
	 * (AGENT-LAUNCHER.md, L4, rule 4: the launch diagnostics; X-38; YO-09).
	 */
	private exemptionNotes(installed: InstalledCli, exemption: ToolsExemption | undefined): string[] {
		if (!exemption) {
			return [];
		}
		// A rule of the person's that refuses Facade's tools, and a group of Facade's launch changed: the first
		// refuses them, the second may have them asked for - each said as it is (N-45)
		const { refused, changed } = exemption;
		return [
			...refused !== undefined ? [`With YOLO off, ${installed.cli.displayName} denies Facade tools: ${refused}.`] : [],
			...changed.length ? [`With YOLO off, ${installed.cli.displayName} may require approval to use Facade tools: ${exemptionChangedText(changed)}.`] : []
		];
	}

	/**
	 * What a launch tells once it has recorded the agent: it files `exemption` under the agent's number - before its CLI
	 * can connect and be told it (L4, rule 4) - then tells `onRecorded`.
	 */
	private filingExemption(exemption: ToolsExemption | undefined, onRecorded?: (agent: number) => void): (agent: number) => void {
		return agent => {
			if (exemption) {
				this.exemptions.set(agent, exemption);
			}
			onRecorded?.(agent);
		};
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
			const key = message.replace(/\. Supported variables: [^]*$/, '');
			if (!problems.has(key)) {
				problems.set(key, message);
			}
		};
		try {
			const repository = await this.ports.git.repositoryOf(folder);
			// An agent's start, through start_agent, and the person's, from the UI, each with its own launch (L4)
			const envs = { unattended: await this.environmentOf(installed, folder, true), theirs: await this.environmentOf(installed, folder, false) };
			const can = capabilitiesOf(installed.cli, launchFor(installed.config, true));
			const integration = this.options.clis.framework() && can.integration;
			const theirs = this.options.clis.framework() && capabilitiesOf(installed.cli, launchFor(installed.config, false)).integration;
			const given = { ...(integration && can.task ? { task: 'A task.' } : {}), ...(can.model ? { model: 'model' } : {}), ...(can.effort ? { effort: 'high' } : {}) };
			for (const yolo of [true, false]) {
				const run = { ignored: [], folder, repository: repository?.main ?? folder, yolo };
				for (const [each, env] of [[{ ...run, ...given, home: homeOf(envs.unattended), integration, unattended: true }, envs.unattended], [{ ...run, home: homeOf(envs.theirs), integration: theirs, unattended: false }, envs.theirs]] as const) {
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
		const env = await this.environmentOf(installed, folder, false);
		this.stillOpen();
		// The person's own, from the UI: it runs as its CLI usually does (L4)
		const exemption = this.exemptionFor(installed, yolo, false, env, folder);
		const run = { ignored: [], folder, repository: repository?.main ?? folder, home: homeOf(env), env, yolo, unattended: false, integration, notes: this.exemptionNotes(installed, exemption) };
		const files = this.launcher.check(installed, run, env);
		this.launcher.checkFiles(installed, files, folder);
		this.stillOpen();
		// Asked again as it is recorded: a deletion of its folder that began meanwhile keeps it out (O5)
		this.assertNotDeleting(folder);
		this.trust(installed, { folder, repository: run.repository }, env);
		const { agent } = await this.launcher.launch(PERSON, installed, { ...run, name, worktree, outsideGit: !repository }, { wait: false, onRecorded: this.filingExemption(exemption) });
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
	 * they are, where given: the CLI is the one that knows which it has. Until the child is recorded, the start
	 * is `validating` (AGENT-ORCHESTRATION.md, O4): the caller is told so, and an error then says it - no run
	 * was made for it (O2; OR-18).
	 */
	async startAgent(caller: Caller, request: StartRequest, progress?: LaunchProgress): Promise<Started> {
		let recorded = false;
		try {
			return await this.startChecked(caller, request, progress, () => {
				recorded = true;
			});
		} catch (err) {
			if (recorded || !(err instanceof FacadeError) || err.outcome?.agent !== undefined) {
				throw err;
			}
			throw new FacadeError(err.code, err.message, { ...err.outcome, phase: 'validating' });
		}
	}

	/** `startAgent`, which tells `onRecorded` once the child is recorded. */
	private async startChecked(caller: Caller, request: StartRequest, progress: LaunchProgress | undefined, onRecorded: () => void): Promise<Started> {
		// Its time counts from now, when it is accepted, whatever it waits for after (O9).
		const acceptedAt = Date.now();
		this.stillOpen();
		// Facade makes no worktree with worktree management off: the call is refused whole, before anything is made for it
		// (WORKTREE.md WT-9.3; O3)
		if (request.newWorktree === true && !this.ports.workspace.worktreesManaged()) {
			throw new FacadeError('UNAVAILABLE', `Cannot use new_worktree:true: worktree management is turned off by the setting ${WORKTREES_SETTING}. Nothing was started. Set new_worktree:false to use an existing window folder or recorded agent launch folder, or ask the person to enable the setting.`);
		}
		// The person's settings are read once, as the call is accepted: a change applies to the next start.
		const yolo = this.yolo(caller);
		const name = this.nameOf(request.name);
		// Nothing is made for it while it is checked, which can take a while - git asked, its CLI looked for (O4)
		progress?.(`Validating @${name}; no run has been recorded yet.`);
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
			const { installed, config } = await this.startableHere(request.cli, home, false, true);
			// Through start_agent, where nobody may be watching: its launch's unattended part (L4)
			const launch = launchFor(config, true);
			const capabilities = capabilitiesOf(installed.cli, launch);
			const integration = this.options.clis.framework() && capabilities.integration;
			if (task !== undefined && !(integration && capabilities.task)) {
				// Its cause named: the framework off, or the person's launch without the group a task needs (X-55)
				const name = installed.cli.custom ? installed.cli.id : installed.cli.displayName;
				throw new FacadeError('REFUSED', !this.options.clis.framework()
					? `Cannot assign a task to ${name} while the agent framework is disabled.`
					: `Cannot assign a task to ${name}: ${installed.cli.setting}.launch has ${capabilities.integration ? 'no task group' : 'no connect group, so the agent cannot read Facade messages'}. Start without a task, or ask the person to configure the missing group.`);
			}
			// What its launch has no group for is left out, and recorded unknown (O3)
			const withheld: Ignored[] = [...model !== undefined && !capabilities.model ? ['model' as const] : [], ...effort !== undefined && !capabilities.effort ? ['effort' as const] : []];
			// An effort given with a model whose name may carry one of its own - Antigravity's - is given all the same, as
			// every value is passed through, and recorded unknown: the model's may apply instead (O3, O6; N-64; OR-01)
			const effortOfModel = effort !== undefined && capabilities.effort && model !== undefined && capabilities.model && !!installed.cli.modelCarriesEffort;
			const ignored: Ignored[] = [...withheld, ...effortOfModel ? ['effort' as const] : []];
			// What cannot reach the CLI as it is - read as an option of its own, or no text at all - is refused before
			// anything is made, not rewritten (AGENT-LAUNCHER.md, L10; X-08, N-10)
			for (const [what, value] of [['model', model], ['effort', effort]] as const) {
				if (value === undefined || withheld.includes(what)) {
					continue;
				}
				if (value.includes('\0') || LONE_SURROGATE.test(value)) {
					throw new FacadeError('INVALID', `The ${what} contains a NUL character or an unpaired UTF-16 surrogate, which cannot be passed intact to the CLI. Provide valid plain text.`);
				}
				if (value.startsWith('-') && (launch.launch.arguments[what] ?? []).includes(`\${${what}}`)) {
					throw new FacadeError('INVALID', `The ${what} '${value}' starts with a dash, so ${installed.cli.displayName} would treat it as an option instead of the ${what}. Remove the leading dash.`);
				}
			}
			const env = await this.environmentOf(installed, home, true);
			this.stillOpen();
			// Recorded as asked for; given to the CLI only where its launch has a group for it.
			const repository = place.kind === 'new' ? place.repository.main : place.main;
			const exemption = this.exemptionFor(installed, yolo, true, env, home);
			const whenRecorded = this.filingExemption(exemption, onRecorded);
			// The project's MCP servers its launch runs without, where its folder is there to read them; a new worktree's, once made
			const serversOff = place.kind === 'new' ? [] : serversOffNotes(installed, { folder: place.folder, repository }, homeOf(env), yolo);
			const run = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ignored, task, folder: home, repository, home: homeOf(env), env, yolo, unattended: true, integration, notes: [...this.exemptionNotes(installed, exemption), ...serversOff] };
			const files = this.launcher.check(installed, run, env);
			this.launcher.checkFiles(installed, files, place.kind === 'new' ? undefined : place.folder);
			this.stillOpen();

			// Wherever it starts, the CLI is given the person's trust in its folder's repository - or in the folder,
			// outside any - so that it does not stop to ask; what would keep that from being given refuses the start
			// before anything is made for it, a new worktree included (X-30).
			if (place.kind !== 'new') {
				// Asked again as it is recorded: a deletion of its folder that began while it was checked keeps it out (O5)
				this.assertNotDeleting(place.folder);
				try {
					this.trust(installed, { folder: place.folder, repository }, env);
				} catch (err) {
					throw new FacadeError('FAILED', messageOf(err));
				}
				const launched = await this.launcher.launch(caller, installed, { ...run, name, worktree: place.worktree, outsideGit: place.outsideGit, folder: place.folder }, { wait: true, acceptedAt, ...(progress ? { progress } : {}), onRecorded: whenRecorded });
				return this.startedOf(caller, launched, false);
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
				progress?.(`Creating worktree ${place.branch} for ${describe(agent)}.`);
				let worktree: MadeWorktreeFolder;
				// Where git makes it is known once it has: a stop that deletes it meanwhile waits for that (O4)
				const making = new DeferredPromise<string | undefined>();
				this.worktreesMaking.set(agent.id, making.p);
				try {
					worktree = await this.ports.git.makeWorktree(place.repository.main, place.branch, place.head);
				} catch (err) {
					making.complete(undefined);
					throw new FacadeError('FAILED', `Could not create worktree ${place.branch}: ${messageOf(err)}`, { outcome: 'failed', agent: agent.id });
				} finally {
					// Made, git has the branch; not made, it is free again
					reserved?.dispose();
				}
				const folder = made = worktree.folder;
				// Recorded even where the window closed or the agent was stopped meanwhile: it was made, and stays.
				this.table.recordWorktree({ name: place.branch, folder, repository: place.repository.main, commit: place.head, ...(caller.id !== undefined ? { madeBy: caller.id } : {}) });
				making.complete(folder);
				if (!this.isStarting(agent)) {
					// Its run is where git made the worktree, not at the folder planned for it - taken, maybe (O4; OR-05)
					this.table.recordWorktreeFolder(agent.id, folder);
					this.ports.git.stopSetup(folder);
					throw new Error('startup was stopped during worktree creation');
				}
				this.table.phase(agent.id, 'running_setup', folder);
				const notes = [
					// The branch is the name asked for; the folder, where its own was taken, gets a suffix - said, not silent (WT-2.3; O3)
					...!isEqualPath(folder, planned) ? [`Worktree created at ${folder}: ${planned} was already in use.`] : [],
					...worktree.copyFailures.length ? [`Some files listed in .worktreeinclude could not be copied into the worktree: ${worktree.copyFailures.join(', ')}.`] : [],
					...worktree.hookFailure ? [`A Git hook failed during worktree creation: ${worktree.hookFailure}`] : [],
					...serversOffNotes(installed, { folder, repository }, homeOf(env), yolo)
				];
				progress?.(`Running setup for worktree ${place.branch}.`);
				const setup = await this.ports.git.setupOutcome(folder);
				if (!this.isStarting(agent)) {
					throw new Error('startup was stopped during worktree setup');
				}
				let startNote: string | undefined;
				switch (setup.kind) {
					case 'failed':
						throw new FacadeError('FAILED', `worktree setup failed: \`${setup.line}\` exited with code ${setup.exitCode}${setup.output ? `: ${setup.output.trim()}` : ''}`, { outcome: 'failed', agent: agent.id });
					case 'stopped':
						throw new FacadeError('FAILED', 'worktree setup was interrupted when its terminal closed', { outcome: 'failed', agent: agent.id });
					case 'succeeded':
						notes.push('Worktree setup completed successfully.');
						break;
					case 'submitted':
						notes.push('Worktree setup was submitted without shell integration; its completion and result are unknown.');
						startNote = 'Worktree setup was submitted without shell integration. Its completion and result are unknown; check the setup before relying on it.';
						break;
					case 'invalid':
						notes.push('The repository\'s .facade/worktrees.json could not be read; no setup ran.');
						break;
				}
				try {
					this.trust(installed, { folder, repository }, env);
				} catch (err) {
					throw new FacadeError('FAILED', messageOf(err), { outcome: 'failed', agent: agent.id });
				}
				return { folder, notes, ...(startNote ? { startNote } : {}), setup: setup.kind };
			};
			try {
				const launched = await this.launcher.launch(caller, installed, { ...run, name, worktree: place.branch, folder: planned }, { wait: true, acceptedAt, prepare, ...(progress ? { progress } : {}), onRecorded: whenRecorded });
				return this.startedOf(caller, launched, true);
			} catch (err) {
				// A worktree made for a start that fails stays, its branch with it: the answer says where (O4).
				if (made !== undefined && err instanceof FacadeError && err.code === 'FAILED') {
					throw new FacadeError(err.code, `${err.message}\nWorktree ${place.branch} was created at ${made}; the worktree and branch have been kept. To reuse it, start an agent with folder set to this path. Delete it only if it is no longer needed.`, { ...err.outcome ?? { outcome: 'failed' }, worktree: made });
				}
				throw err;
			}
		} finally {
			reserved?.dispose();
		}
	}

	/** A start's answer: the agent's facts, how its start went, and what its preparation came to. */
	private startedOf(caller: Caller, launched: Launched, newWorktree: boolean): Started {
		const { agent, status, why, screen, settingUp } = launched;
		// The person's script started it, whom its answer tells: the person, who may not be watching that script, is
		// told as of a start of theirs from the window - an agent's start tells its creator alone (L5)
		if (caller.id === undefined && status === 'unconfirmed') {
			this.tellUnconfirmed(agent, why ?? '');
		}
		// What of the person's settings was not taken as set goes with the start it changed (X-59)
		const notes = [...(this.options.settingsProblems?.() ?? []).map(problem => `${problem}.`), ...launched.notes];
		return { status, ...(why !== undefined ? { why } : {}), ...this.factsOf(this.table.get(agent.id) ?? agent), newWorktree, ...(notes.length ? { notes } : {}), ...(screen ? { screen } : {}), ...(settingUp ? { settingUp } : {}) };
	}

	/**
	 * Tells the person, once, that their agent's start is not confirmed (AGENT-LAUNCHER.md, L5): its CLI open but not
	 * connected, as the person's own start from the window says it - or, its CLI not launched yet, why - in the notice
	 * that its connection, or its end, closes. Not of one stopped meanwhile.
	 */
	private tellUnconfirmed(agent: Agent, why: string): void {
		const now = this.table.get(agent.id);
		if (this.disposed || now?.state !== 'starting') {
			return;
		}
		this.launcher.tellUnconfirmed(now, now.phase === 'connecting'
			? notConnectedNotice(now)
			: l10n.t("Facade could not confirm that {0} started: {1}.", describe(now), why));
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
	 * The window deleted the worktree `folder`: one Facade made is its no more - said by the window once git is done,
	 * where the extension host that asked for it may have started again meanwhile (O5, O11).
	 */
	worktreeDeleted(folder: string): void {
		this.deletionOver(folder);
		if (this.table.madeWorktree(folder) && !fs.existsSync(folder)) {
			this.table.forgetWorktree(folder);
			this.log(`Deleted worktree ${folder}.`);
		}
	}

	/** The person's deletion of the worktree `folder` failed in the window: agents can start there again (O5; OR-10). */
	worktreeDeleteFailed(folder: string): void {
		if (this.deletionOver(folder)) {
			this.log(`Worktree ${folder} was not deleted. Agents can start there again.`);
		}
	}

	/** The person's deletion of the worktree `folder` is over, however it went: answers whether one was under way. */
	private deletionOver(folder: string): boolean {
		const at = this.personDeletions.findIndex(each => isEqualPath(each.folder, folder));
		if (at < 0) {
			return false;
		}
		clearTimeout(this.personDeletions[at].timer);
		this.personDeletions.splice(at, 1);
		return true;
	}

	/**
	 * The person decided to delete the worktree `folder` in the window: no agent starts in it until the window says how
	 * the deletion went (WORKTREE.md WT-8, step 3; OR-10). Its agents are stopped later, once the window is off it and it
	 * is out of the workspace (`worktreeStopping`).
	 */
	worktreeDeleting(folder: string): void {
		// One rule for the person's deletion and an agent's: a deletion the window never says the end of lets starts in
		// again after the person's timeout
		this.deletionOver(folder);
		this.personDeletions.push({ folder, timer: setTimeout(() => this.deletionOver(folder), this.timing().startTimeoutMs) });
	}

	/**
	 * The window's Delete Worktree is at its step 6 for the worktree `folder`, which it has moved off and taken out of the
	 * workspace: every agent working in it - started there, or gone there since; one starting, its start cancelled and
	 * its setup with it - is stopped by whoever decided on the deletion, an agent's call or the person, and waited for
	 * (WORKTREE.md WT-8, step 6; AGENT-LAUNCHER.md, L6; N-34). Answers those still stopping once the stop timeout is over,
	 * which keeps git from deleting it - and, for a call, why, in its words (AGENT-ORCHESTRATION.md, O5).
	 */
	async worktreeStopping(folder: string): Promise<{ readonly stopping: readonly string[]; readonly why?: string }> {
		const call = this.deletions.find(each => isEqualPath(each.folder, folder));
		const { inside } = await this.workingIn(folder);
		if (call) {
			call.stops.began = true;
		} else {
			// The person's deletion stays theirs while its agents stop: the window's timeout counts from here
			this.worktreeDeleting(folder);
		}
		const results = await Promise.allSettled(inside.map(agent => call
			? this.stopOne(agent, call.by, 'with stop_agent to delete its worktree')
			: this.stopOne(agent, 'human', 'as its worktree was being deleted')));
		const stopped = inside.filter((_, i) => results[i].status === 'fulfilled').map(each => each.id);
		const stopping = inside.filter((_, i) => results[i].status === 'rejected').map(each => each.id);
		if (!call) {
			results.forEach((result, i) => {
				if (result.status === 'rejected') {
					this.log(`Could not stop ${describe(inside[i])} during worktree deletion: ${messageOf(result.reason)}`);
				}
			});
			return { stopping: stopping.map(id => this.whoIs(id)) };
		}
		call.stops.stopped.push(...stopped);
		call.stops.stopping.push(...stopping);
		if (!stopping.length) {
			return { stopping: [] };
		}
		return { stopping: stopping.map(id => this.whoIs(id)), why: this.pendingDeletionText(folder, call.stops) };
	}

	/**
	 * Stops one agent the caller reaches - a child, a sibling, its creator, itself, one the person started -
	 * and, with `deleteWorktree`, the other agents in its worktree and then the worktree, its branch kept
	 * (AGENT-ORCHESTRATION.md, O5). A worktree with work in it that would be lost is not deleted, and nothing
	 * is stopped, unless the call says to discard it. Answers once everything is done; a process that has not
	 * ended in time answers pending, and its worktree stays.
	 */
	async stopAgent(caller: Caller, target: string, options: { readonly deleteWorktree?: boolean; readonly discardChanges?: boolean } = {}): Promise<Stopped> {
		this.stillOpen();
		if (options.discardChanges && !options.deleteWorktree) {
			throw new FacadeError('INVALID', 'discard_changes:true requires delete_worktree:true; it controls whether worktree deletion may discard changes.');
		}
		// Nor does it delete one: the call is refused whole, its agent left running - not turned into a stop alone, a main
		// checkout's and a folder's outside git included (WORKTREE.md WT-9.3; O5)
		if (options.deleteWorktree && !this.ports.workspace.worktreesManaged()) {
			throw new FacadeError('UNAVAILABLE', `Cannot use delete_worktree:true: worktree management is turned off by the setting ${WORKTREES_SETTING}. Nothing was stopped or deleted. Call stop_agent without delete_worktree to stop only the agent, or ask the person to enable the setting.`);
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
			// Read before it is stopped: one with no terminal yet has its start stopped, nothing closed (OR-05)
			const startStopped = agent.state === 'starting' && (agent.phase === 'creating_worktree' || agent.phase === 'running_setup') ? agent.phase : undefined;
			await this.stopOne(agent, by, 'with stop_agent');
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded: false, stopped: [this.factsOf(this.table.get(agent.id) ?? agent)], ...(startStopped ? { startStopped } : {}) };
		}

		// Its worktree still being made: its start is stopped, and git - which may finish - waited for as long as a
		// start is; then the worktree it made is the one deleted, not the folder planned for it (O4)
		let folder = agent.folder;
		let ended = alreadyEnded;
		const making = this.worktreesMaking.get(agent.id);
		// One still making its worktree - starting, or stopping by an earlier call - or ended as git made it
		if (making && (alreadyEnded || agent.phase === 'creating_worktree')) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
				ended = true;
			}
			// Git's answer, or none once the wait is over - its timer cleared as soon as git answers
			const over = new AbortController();
			const made = await Promise.race([making.then(result => ({ folder: result })), timeout(this.timing().startTimeoutMs, over.signal).then(() => undefined, () => undefined)]);
			over.abort();
			if (!made) {
				throw new FacadeError('UNAVAILABLE', `${describe(agent)} ${ended && !alreadyEnded ? 'was stopped, but its' : 'ended, and its'} worktree ${agent.worktree} is still being created. It was not deleted. Git may finish creating it; the worktree and branch will be kept. Call stop_agent again with delete_worktree:true after creation ends.`, { outcome: 'pending', agent: agent.id });
			}
			if (made.folder === undefined) {
				// Git made none: nothing of its to delete - never the folder that was planned for it, which may be another's
				const now = this.factsOf(this.table.get(agent.id) ?? agent);
				return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: 'Git did not create a worktree, so there is nothing to delete' } };
			}
			folder = made.folder;
		}
		const stoppedFirst = ended && !alreadyEnded ? [this.factsOf(this.table.get(agent.id) ?? agent)] : [];
		if (stoppedFirst.length) {
			const deleted = await this.deleteMade(caller, agent, folder, by, options);
			return { ...deleted, alreadyEnded: false, stopped: [...stoppedFirst, ...deleted.stopped.filter(each => each.id !== agent.id)] };
		}
		return this.deleteMade(caller, agent, folder, by, options, alreadyEnded);
	}

	/** Deletes the worktree `folder` of `agent` - stopped already, or `alreadyEnded` not - with the agents in it (O5). */
	private async deleteMade(caller: Caller, agent: Agent, folder: string, by: StoppedBy, options: { readonly discardChanges?: boolean }, alreadyEnded = true): Promise<Stopped> {
		// A worktree whose folder is gone already - deleted by hand - has nothing left to delete: the agent alone is
		// stopped, and the answer says so, rather than what git says of a folder that is not there (X-37).
		if (!fs.existsSync(folder)) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			if (this.table.madeWorktree(folder)) {
				this.table.forgetWorktree(folder);
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: 'the folder no longer exists, so there is nothing to delete' } };
		}
		// A main checkout - or a folder in one - or a folder outside git, is never deleted: the agent alone is stopped.
		// What a deletion left of a worktree Facade made - a folder git no longer lists, whose files could not all
		// be deleted then - is no repository, and a retry finishes it (AGENT-ORCHESTRATION.md, O5).
		const repository = await this.ports.git.repositoryOf(folder);
		const leftover = repository ? undefined : this.table.madeWorktree(folder) ?? this.leftoverOfRemoval(folder);
		if ((!repository && !leftover) || repository?.mainCheckout) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: repository ? 'it is the repository\'s main checkout, which cannot be deleted' : 'the folder is not in a Git repository, so there is no worktree to delete' } };
		}
		// An agent's folder inside a worktree is not the worktree: the worktree is what is deleted, its top level - with
		// every agent in it, by the same preflight (AGENT-ORCHESTRATION.md, O5; OR-09)
		const root = repository ? await this.ports.git.worktreeRootOf(folder) : undefined;
		if (root !== undefined && !isEqualPath(root, folder)) {
			folder = root;
		}
		// Nor one another tool made: Facade takes it for a folder, and deletes no worktree but its own (WORKTREE.md WT-1.3)
		if (repository && !this.ports.git.isFacadeWorktree(folder)) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: 'this worktree was not created by Facade' } };
		}
		// A worktree that is one of the window's folders, the one the window is on too - its first, or its only - is
		// deleted as any other, by the same preflight: the window moves off it to its repository's folder, or back to
		// the one the person was on before (AGENT-ORCHESTRATION.md, O5). A window of that folder alone becomes another
		// workspace, which starts Facade's extension host again: this call may be cut then, and the record says what
		// came of it (O8)
		// One deletion of a folder at a time: a second joins the first, and answers as it does (X-10). Registered
		// before anything is awaited, so that two that come at once cannot both go.
		const underWay = this.deletions.find(each => isEqualPath(each.folder, folder));
		if (underWay) {
			const joined = await underWay.done;
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped: [], ...(joined.worktree ? { worktree: joined.worktree } : {}) };
		}
		const deleting = new DeferredPromise<Stopped>();
		deleting.p.catch(() => undefined);
		const entry = { folder, done: deleting.p, by, stops: { began: false, stopped: [], stopping: [] } };
		this.deletions.push(entry);
		try {
			const target: DeletionTarget = repository ? { main: repository.main, branch: repository.worktree, ...(repository.head !== undefined ? { head: repository.head } : {}) } : { main: leftover!.repository, leftover: leftover!.name };
			const stopped = await this.deleteWorktreeOf(caller, agent, folder, target, by, alreadyEnded, options, entry.stops);
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
	 * or it has work deleting it would lose; else the window's Delete Worktree, which stops every agent working in it
	 * once it is off it and it is out of the workspace, looks again, and deletes it, its branch kept (WORKTREE.md WT-8;
	 * AGENT-ORCHESTRATION.md, O5). What it stopped is in `stops`.
	 */
	private async deleteWorktreeOf(caller: Caller, agent: Agent, folder: string, target: DeletionTarget, by: StoppedBy, alreadyEnded: boolean, options: { readonly discardChanges?: boolean }, stops: DeletionStops): Promise<Stopped> {
		const { inside, terminals } = await this.workingIn(folder);
		// One the window holds for another record is no agent of this list to stop
		if (terminals.others) {
			throw new FacadeError('REFUSED', `Cannot delete ${folder}: ${terminals.others === 1 ? 'an agent' : `${terminals.others} agents`} working there ${terminals.others === 1 ? 'is' : 'are'} missing from this window's agent list. Deleting the worktree would end ${terminals.others === 1 ? 'it' : 'them'} without an explicit stop. Nothing was stopped. Stop the unlisted agents first.`);
		}
		// Another window's agents there are its to stop: the window sees their terminals - the pty host holds every
		// window's - and what Facade put there for them says so too. Refused before anything is stopped (X-10; N-53).
		const elsewhere = terminals.elsewhere.length ? terminals.elsewhere : this.othersUsing(folder).map(user => `#a${user.id} in that window's agent list`);
		if (elsewhere.length) {
			throw new FacadeError('REFUSED', `Cannot delete ${folder}: it is in use by ${elsewhere.length === 1 ? 'an agent' : `${elsewhere.length} agents`} from another window (${elsewhere.join(', ')}). This call cannot stop ${elsewhere.length === 1 ? 'it' : 'them'}. Nothing was stopped. Stop the agents in their own window first.`);
		}
		const outOfReach = inside.filter(each => !this.reaches(caller, each));
		if (outOfReach.length) {
			throw new FacadeError('REFUSED', `Cannot delete ${folder}: agents working there are outside your tree: ${outOfReach.map(each => `${describe(each)}${isEqualPath(each.folder, folder) ? '' : ` (started in ${each.folder})`}`).join(', ')}. With YOLO off, you can reach only your own tree. Nothing was stopped.`);
		}
		// The terminals the deletion may close: those of the agents it stops, the ones started elsewhere included
		const agents = [...new Set([...inside.map(each => each.id), ...terminals.agents])];
		// The shared Delete Worktree's own preflight, before any agent is stopped: what it would refuse - an unsaved editor
		// of any kind among it, where the extension host sees text and notebooks alone - refuses it here, all left running
		// (O5; O8; OR-19; OR-04)
		const changes = options.discardChanges ? undefined : await this.lossIn(folder, target, agents);
		if (changes) {
			throw lossRefusal(folder, changes);
		}
		const stoppedNow = () => stops.stopped.flatMap(id => {
			const stopped = this.table.get(id);
			return stopped ? [this.factsOf(stopped)] : [];
		});
		try {
			// Nothing is stopped ahead of it: the window stops them once it is off the worktree and the worktree is out of
			// the workspace, and looks again before git deletes it (WT-8, steps 5 and 6)
			await this.ports.git.deleteWorktree(folder, {
				discardChanges: !!options.discardChanges,
				ownFiles: target.leftover === undefined ? await this.ownFilesIn(folder, target) : [],
				main: target.main,
				agents,
				...(target.leftover !== undefined ? { leftover: true } : {})
			});
		} catch (err) {
			// Its agents not all ended in time: what happened all the same, said and given as the same facts - the agents it
			// stopped, and those whose stops answered pending, still stopping (O2)
			if (stops.stopping.length) {
				const facts: PendingDeletion = { outcome: 'pending', agent: agent.id, stopped: stops.stopped, stopping: stops.stopping };
				throw new FacadeError('UNAVAILABLE', messageOf(err), facts);
			}
			// Refused, or failed, before anything was stopped: work that came since the preflight refuses it as the preflight
			// does; else the window says how far it came, and a call again starts over
			if (!stops.began) {
				const since = options.discardChanges ? undefined : await this.lossIn(folder, target, agents).catch(() => undefined);
				throw since ? lossRefusal(folder, since) : new FacadeError('FAILED', `${messageOf(err)}\nNothing was stopped.`);
			}
			this.stillOpen();
			// Refused as its last look found work that came meanwhile - an edit a CLI finished as it ended, a build's output
			// - which is not deleted unasked: as an error, with what happened all the same (X-23)
			const since = options.discardChanges ? undefined : await this.lossIn(folder, target, agents).catch(() => undefined);
			if (since) {
				throw new FacadeError('REFUSED', `${messageOf(err)}\nAgents already stopped: ${stoppedNow().map(each => describe(each)).join(', ')}. Commit work you need to keep, or retry with discard_changes:true to discard it.`, { agent: agent.id, worktree: folder, stopped: stops.stopped });
			}
			// Said in the log as well as to the caller, and kept in the record - the ledger and the person's history - where
			// the caller and the person can read what came of the removal, a call cut as it went too (O5, O11; OR-15)
			this.log(`Failed to delete ${folder} through stop_agent requested by ${this.whoIs(by)}: ${messageOf(err)}`);
			// With what a retry needs to finish what is left once git forgot the worktree, whoever made it (OR-08)
			const branch = target.leftover ?? target.branch;
			this.recordRemoval({ folder, by, deleted: false, reason: messageOf(err), main: target.main, ...(branch !== undefined ? { branch } : {}) });
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped: stoppedNow(), worktree: { folder, deleted: false, why: messageOf(err) } };
		}
		this.recordRemoval({ folder, by, deleted: true });
		this.table.forgetWorktree(folder);
		this.log(`Deleted ${folder} through stop_agent requested by ${this.whoIs(by)}.`);
		return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped: stoppedNow(), worktree: { folder, deleted: true } };
	}

	/**
	 * The agents of this window's list working in `folder` - started there, or gone there since: a CLI that cd'd into
	 * it - wherever they were started, with the window's terminals inside it, whose agents go with it (O5; X-74).
	 */
	private async workingIn(folder: string): Promise<{ readonly inside: LiveAgent[]; readonly terminals: TerminalsInside }> {
		const terminals = await this.ports.terminals.inside(folder);
		const live = this.liveAgents();
		// Its terminal the window cannot see go there - the CLI itself, or a shell it runs, cd'd - its processes say
		const startedElsewhere = live.filter(each => !isEqualPath(each.folder, folder) && !isInsideFolder(each.folder, folder) && !terminals.agents.includes(each.id) && each.processId !== undefined);
		const working = startedElsewhere.length ? await (this.options.workingFolders ?? workingFoldersOf)(startedElsewhere.map(each => each.processId!)) : new Map<number, readonly string[]>();
		// The system names a process's folder by its real path
		const real = canonicalFolder(folder);
		const wentThere = (agent: Agent) => (working.get(agent.processId!) ?? []).some(each => [folder, real].some(at => isEqualPath(each, at) || isInsideFolder(each, at)));
		const inside = live.filter(each => isEqualPath(each.folder, folder) || isInsideFolder(each.folder, folder) || terminals.agents.includes(each.id) || (each.processId !== undefined && wentThere(each)));
		return { inside, terminals };
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
				this.log(`Could not recover ${describe(agent)}: ${messageOf(alive.reason)}. Facade will check again later.`);
				untold.push(agent);
			}
		});
		if (untold.length) {
			this.background('Rechecking agents whose process state is unknown', this.findAgain(untold));
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
					this.background(`Ending ${describe(agent)} after losing its terminal`, this.endCutOff(agent, closedByThePerson));
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
								: table.end(agent.id, 'stopped', 'its window closed');
						if (end) {
							this.log(`Recorded ${describe(agent)} as ended (${end.kind}) in the untitled workspace record ${dir}: ${end.reason}`);
						}
					}
				} finally {
					table.dispose('window');
				}
			} catch (err) {
				this.log(`Could not record agents as ended after their untitled workspace's window closed (record ${dir}): ${messageOf(err)}`);
			}
		}
	}

	/**
	 * Records the end of an agent whose process was gone as Facade came back: one set out to be stopped was
	 * stopped; one the window saw end ended as it did - its tab closed, or its folder removed, by the person, its
	 * folder gone from the disk, or its CLI exited with its code (AGENT-LAUNCHER.md, L12: a known exit is
	 * recorded) - but one killed, which is no exit of its CLI's, is lost, its reason naming the signal (D11); any
	 * other went with its window, or is lost - failed, had it not started. The person hears of what L6 tells them -
	 * a nonzero exit, a stop they did not ask for - as when Facade sees it, unless they closed the window, which
	 * ended its session: nothing of that is news to them, nor is a loss nobody saw.
	 */
	private endedUnseen(agent: LiveAgent, closedByThePerson: boolean): void {
		const end = this.ports.terminals.endOf?.(agent.id);
		// Cut before its CLI ran: in its worktree's preparation, or as its CLI was being launched - no process recorded,
		// and no terminal the window saw end - a pre-launch run that is definitely absent (O11; OR-14)
		if (cutBeforeLaunch(agent) || (agent.state === 'starting' && agent.phase === 'launching_cli' && agent.processId === undefined && end === undefined)) {
			const made = !!this.table.madeWorktree(agent.folder) && fs.existsSync(agent.folder);
			// Its setup goes with the window that went - not with an extension host that started again in this very
			// window, whose terminals are the person's, untouched (WIN-03)
			const hostOnly = !!this.table.lastClose?.thisWindow || this.sameWindow;
			if (made && !hostOnly && agent.phase === 'running_setup') {
				this.ports.git.stopSetup(agent.folder);
			}
			this.ended(agent, 'failed', cutReason(agent, made, hostOnly), { quiet: true });
			return;
		}
		if (agent.state === 'stopping') {
			// A stop under way as the whole window went: of a session that is gone, and no news (L6; M8)
			this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}), ...(closedByThePerson ? { quiet: true, windowWent: true } : {}) });
		} else if (end?.byThePerson || end?.reason === 'folderGone') {
			this.ended(agent, 'stopped', closedBecause(end), { ...(end.byThePerson ? { by: 'human' as const } : {}), ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}), quiet: end.byThePerson || closedByThePerson });
		} else if (end?.exitCode !== undefined && end.exitCode >= 0 && signalOf(end.exitCode) === undefined) {
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'exited', `${exitedWith(end.exitCode)} while Facade was not running`, { exitCode: end.exitCode, quiet: closedByThePerson });
		} else if (end?.exitCode !== undefined) {
			// Killed, which Facade did not see - no exit of its CLI's own: lost, saying what is known (D11)
			const signal = signalOf(end.exitCode);
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', signal !== undefined ? `its CLI was killed by signal ${signal} while Facade was not running` : HOST_RESTARTED, { quiet: true });
		} else if (closedByThePerson) {
			// The whole window went: nobody is told of the end (M8) - what it had not fetched goes back all the same (M6)
			this.ended(agent, 'stopped', 'its window closed', { quiet: true, windowWent: true });
		} else {
			this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', 'its terminal was missing when Facade restarted', { quiet: true });
		}
	}

	/** An agent found again as Facade came back: one set out to be stopped is stopped again; any other goes on as it was. */
	private goOn(agent: LiveAgent): void {
		if (agent.state === 'stopping') {
			this.background(`Resuming the stop of ${describe(agent)}`, this.stopOne(agent, agent.stopping?.by, agent.stopping?.reason ?? 'with stop_agent'));
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
		this.background(`Registering the final-screen save location for ${describe(agent)}`, this.ports.terminals.register(agent.id, this.screens.finalScreenOf(agent)).then(found => {
			if (!found) {
				this.log(`Recovered ${describe(agent)}, but could not register its final-screen save location. Its final screen will not be saved.`);
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
			// The window watches it still, and says its end once it can tell (LB-05)
			this.log(`The window could not determine whether ${describe(agent)} is still running. Its recorded state is unchanged; Facade will record its end when the window reports it.`);
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
			// A start that waits for it answers its caller with the stop: read before that start hears of it, for the
			// end that follows, whichever way it is recorded, to be no second word to its creator (M8)
			if (this.launcher.answers(agent.id)) {
				this.stoppedWhileAnswered.add(agent.id);
			}
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
			return new FacadeError('UNAVAILABLE', `${describe(agent)} is still stopping: its process has not exited after ${Math.round(ms / 1000)} seconds. Facade will continue trying to stop it; list_agents shows whether it has ended.`, { outcome: 'pending', agent: agent.id });
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
					throw new Error('the window cannot find its terminal, but its process is still running');
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
			this.log(`${describe(agent)} is still running without its terminal after termination and kill attempts. Its recorded state is unchanged.`);
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
			this.log(`${describe(agent)} is still running after termination and kill attempts. Inspect its terminal for the cause.`);
		})());
	}

	/**
	 * What a removal with stop_agent that failed left of the worktree `folder` - git forgot it, its folder stayed - as a
	 * worktree Facade made is named: its repository's main checkout and its branch; undefined where none failed there.
	 * A worktree of the person's is finished by a retry as one of Facade's is (AGENT-ORCHESTRATION.md, O5; OR-08).
	 */
	private leftoverOfRemoval(folder: string): { readonly repository: string; readonly name: string } | undefined {
		const failed = this.table.failedRemoval(folder);
		return failed?.main !== undefined && failed.branch !== undefined ? { repository: failed.main, name: failed.branch } : undefined;
	}

	/** Records how a removal went (O11); what cannot be recorded is said in the log, the removal's outcome unchanged. */
	private recordRemoval(removal: WorktreeRemoval): void {
		try {
			this.table.recordWorktreeRemoval(removal);
		} catch (err) {
			this.log(`Could not record the removal outcome for ${removal.folder}: ${messageOf(err)}`);
		}
	}

	/** What the deletion of `folder` that waits for agents still stopping says: the facts its data carries, in words (O2, O5). */
	private pendingDeletionText(folder: string, facts: Pick<PendingDeletion, 'stopped' | 'stopping'>): string {
		const named = (ids: readonly number[]) => ids.map(id => this.whoIs(id)).join(', ');
		const one = facts.stopping.length === 1;
		return `${folder} was not deleted: ${named(facts.stopping)} ${one ? 'is' : 'are'} still stopping${facts.stopped.length ? `; ${named(facts.stopped)} stopped` : ''}. Once ${one ? 'it has' : 'they have'} ended, call stop_agent again with delete_worktree:true.`;
	}

	/**
	 * What deleting the worktree `folder` of `repository` - closing the terminals of `agents` - would lose, as a refusal
	 * names it; undefined where nothing would be lost. What the shared Delete Worktree's own preflight finds, what Facade
	 * put there and nobody changed applied as for the deletion - its check alone, nothing stopped, closed or removed
	 * (AGENT-ORCHESTRATION.md, O5, O8; OR-04) - each as it words it; and beside it what only Facade knows: what of
	 * its own someone changed since, which git may not show, a worktree's submodules, and what a deletion left of it
	 * holds that its branch does not.
	 */
	private async lossIn(folder: string, repository: DeletionTarget, agents: readonly number[]): Promise<string | undefined> {
		const named = (list: readonly string[]) => list.length > SHOWN_CHANGES ? `${list.slice(0, SHOWN_CHANGES).join(', ')} and ${list.length - SHOWN_CHANGES} more` : list.join(', ');
		const leftover = repository.leftover;
		let shared: readonly string[];
		try {
			shared = await this.ports.git.deletionLoss(folder, { discardChanges: false, ownFiles: leftover === undefined ? await this.ownFilesIn(folder, repository) : [], main: repository.main, agents, ...(leftover !== undefined ? { leftover: true } : {}) });
		} catch (err) {
			throw new FacadeError('FAILED', `Could not check ${folder} for work that deletion would lose. Nothing was stopped. Reason: ${messageOf(err)}`);
		}
		// What a deletion left holds no git to ask: what of it the branch does not hold as it is, is work
		const work = leftover !== undefined ? await this.ports.git.leftoverWorkIn(repository.main, leftover, folder) : [];
		// What of Facade's own someone changed, once each: the window names it too where git shows it - by itself, or in a
		// folder git ignores whole - in its words, a word on what it is after it
		const listed = (file: string) => shared.some(each => {
			const shown = each.replace(/ \([^)]*\)$/, '');
			return shown === file || (shown.endsWith('/') && file.startsWith(shown));
		});
		const changes = leftover === undefined ? [...shared, ...this.editedIn(folder).filter(file => !listed(file))] : shared;
		// Git keeps no copy of a submodule's commits in the repository: those not pushed go with it (X-14) - which the
		// window's check names in no list
		const submodules = leftover === undefined ? (await this.ports.git.changesIn(folder)).submodules : [];
		if (!changes.length && !work.length && !submodules.length) {
			return undefined;
		}
		return [
			...changes.length ? [named(changes)] : [],
			...work.length ? [`${work.length} ${work.length === 1 ? 'file' : 'files'} remaining after an earlier deletion (${named(work)}); branch ${leftover} does not preserve ${work.length === 1 ? 'it in its current state' : 'them in their current states'}`] : [],
			...submodules.length ? [`${submodules.length} ${submodules.length === 1 ? 'submodule' : 'submodules'} (${named(submodules)}), including any unpushed commits in ${submodules.length === 1 ? 'it' : 'them'}`] : []
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
			throw new FacadeError('UNAVAILABLE', `Cannot determine whether agents from another window use ${folder}: Facade's record of injected files could not be read (${messageOf(err)}). Nothing was stopped.`);
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
			this.log(`Could not read Facade's injected-file record for ${folder}: ${messageOf(err)}`);
			return [];
		}
		const owned: OwnedFile[] = [];
		for (const file of unchanged) {
			if (file.theirs !== undefined) {
				let committed: string | undefined;
				try {
					committed = repository.head === undefined ? undefined : await this.ports.git.fileAt(repository.main, repository.head, file.path);
				} catch (err) {
					this.log(`Could not read ${file.path} at commit ${repository.head}: ${messageOf(err)}`);
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
			throw new FacadeError('UNAVAILABLE', `Cannot determine whether Facade's injected files in ${folder} were edited: their record could not be read (${messageOf(err)}). Nothing was stopped.`);
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

	/** Refuses a start in a worktree being deleted: by an agent's `stop_agent`, or by the person in the window. */
	private assertNotDeleting(folder: string): void {
		if ([...this.deletions, ...this.personDeletions].some(each => isEqualPath(each.folder, folder))) {
			throw new FacadeError('REFUSED', `Cannot start an agent in ${folder} while the folder is being deleted.`);
		}
	}

	/**
	 * Where a child of the caller starts: a folder of the window - by its absolute path, or in the caller's own
	 * repository by the branch checked out there - the caller's own folder where none is named, or a new
	 * worktree of that folder's repository on the branch `name`. Refused before anything is made, saying what to
	 * do next as the caller and its request call for: what names no folder of the window, a branch checked out in
	 * two worktrees, a worktree being deleted, an agent's child anywhere but in a worktree Facade made while
	 * worktree management is on, and a new worktree outside any repository, on a branch that is there or that git
	 * takes for no branch, or with no commit to start at.
	 */
	private async placeOf(caller: Caller, named: string | undefined, newWorktree: boolean, name: string): Promise<Place> {
		// Worktree management as the start is accepted, as new_worktree's refusal read it (WORKTREE.md WT-9.3)
		const request: PlaceRequest = { caller, newWorktree, managed: this.ports.workspace.worktreesManaged() };
		const own = this.agentOf(caller)?.folder;
		// The person's own is the folder on their screen (AGENT-ORCHESTRATION.md, O3).
		const here = own ?? (caller.id === undefined ? await this.ports.workspace.activeFolder() : undefined);
		const wanted = named?.trim();
		const folder = !wanted ? here : path.isAbsolute(wanted) ? await this.windowFolderAt(wanted, request) : await this.worktreeOnBranch(here, wanted, request);
		if (folder === undefined) {
			throw new FacadeError('INVALID', 'Argument \'folder\' is required because the person has no selected folder. Provide the absolute path of a folder in this window.');
		}
		this.assertNotDeleting(folder);
		if (!fs.existsSync(folder)) {
			const folders = (await this.windowFolders()).map(each => each.folder);
			throw new FacadeError('NOT_FOUND', `Cannot start an agent in ${folder}: it no longer exists on disk. Nothing was started. ${placeRecovery(request, 'folder', folders)}`);
		}
		const repository = await this.ports.git.repositoryOf(folder);
		// O3: while worktree management is on, an agent's child works in one of Facade's worktrees - a new one, or one that
		// is there, its own among them. A folder outside Git has none to make either: a new one is made of a folder of a Git
		// repository. With management off, it starts in any folder the window knows, as the person's does (WT-9.3)
		if (caller.id !== undefined && request.managed && (!repository || (!newWorktree && (repository.mainCheckout || !this.ports.git.isFacadeWorktree(folder))))) {
			const worktrees = (await this.windowFolders(true)).map(each => each.folder).join(', ');
			// What to do next: one of the worktrees Facade made in the window - where there are none, it says so - or a new one
			const reuse = `folder to one of these worktrees created by Facade: ${worktrees}.`;
			const none = 'No worktrees created by Facade are available in this window.';
			const fromRepository = 'Set new_worktree:true and folder to a Git repository folder in this window';
			throw new FacadeError('REFUSED', !repository
				? `Cannot ${newWorktree ? 'create a worktree from' : 'start a child in'} ${folder}: it is not in a Git repository. Nothing was started. ${worktrees ? `${fromRepository}, or set new_worktree:false and ${reuse}` : `${none} ${fromRepository}.`}`
				: `Cannot start a child in ${folder}: it is ${repository.mainCheckout ? 'a main checkout' : 'not a worktree created by Facade'}. Nothing was started. ${worktrees ? `Set new_worktree:true to create a worktree in this repository, or set ${reuse}` : `${none} Set new_worktree:true to create one in this repository.`}`);
		}
		if (!newWorktree) {
			return { kind: 'folder', folder, worktree: repository?.worktree ?? path.basename(folder), main: repository?.main ?? folder, outsideGit: !repository };
		}
		if (!repository) {
			throw new FacadeError('REFUSED', `Cannot create a worktree from ${folder}: it is not in a Git repository. Start the child in this folder without new_worktree:true.`);
		}
		// At the caller's commit in its own repository - the person's checkout being the folder on their screen (O3;
		// N-06) - and in another at its main checkout's.
		const ownRepository = here === undefined || !fs.existsSync(here) ? undefined : await this.ports.git.repositoryOf(here);
		const from = ownRepository && isEqualPath(ownRepository.main, repository.main) ? { folder: here, head: ownRepository.head } : { folder: repository.main, head: (await this.ports.git.repositoryOf(repository.main))?.head };
		if (from.head === undefined) {
			throw new FacadeError('REFUSED', `Cannot create a worktree from ${from.folder}: its branch has no commit yet, or Git cannot read its commit.`);
		}
		let notABranch: string | undefined;
		try {
			notABranch = await this.ports.git.whyNotBranchName(repository.main, name);
		} catch (err) {
			throw new FacadeError('UNAVAILABLE', `Git could not check whether '${name}' is a valid branch name. Nothing was created; retry the request. Reason: ${messageOf(err)}`);
		}
		if (notABranch !== undefined) {
			throw new FacadeError('REFUSED', `Cannot use '${name}' for the new worktree's branch: ${notABranch}. Choose another agent name.`);
		}
		if (await this.ports.git.hasBranch(repository.main, name)) {
			// An agent's child goes in an existing worktree only without new_worktree, and only in one Facade created (O3)
			throw new FacadeError('REFUSED', `Branch '${name}' already exists in ${path.basename(repository.main)}. A new worktree needs a new branch named after the child. ${caller.id !== undefined
				? 'Choose another agent name. To reuse an existing worktree created by Facade, set new_worktree:false and folder to its absolute path or checked-out branch.'
				: `Choose another agent name, or use folder to start in the existing worktree for '${name}'.`}`);
		}
		if (this.branchesBeingMade.some(each => isEqualPath(each.main, repository.main) && each.branch === name)) {
			throw new FacadeError('REFUSED', `Branch '${name}' is already being created in ${path.basename(repository.main)} for another start. Choose another agent name.`);
		}
		return { kind: 'new', repository, head: from.head, branch: name };
	}

	/**
	 * The folder of the window that is `folder`. Where none is, refused, saying what to do next as `request` asks, with
	 * the window's folders: a folder, or a file, that is there and that its window does not have, `REFUSED` - it exists,
	 * and is out of reach; one that is not there at all, `NOT_FOUND` (AGENT-ORCHESTRATION.md, O2).
	 */
	private async windowFolderAt(folder: string, request: PlaceRequest): Promise<string> {
		const folders = await this.windowFolders();
		const found = folders.find(each => isEqualPath(each.folder, folder));
		if (!found) {
			const next = placeRecovery(request, 'folder', folders.map(each => each.folder));
			if (this.ports.workspace.folders().some(each => isEqualPath(each, folder)) && !fs.existsSync(folder)) {
				throw new FacadeError('NOT_FOUND', `Cannot start an agent in ${folder}: this window's folder no longer exists on disk. Nothing was started. ${next}`);
			}
			// A worktree the window does not have, with worktree management off, is none git is asked for (WT-9.3)
			if (fs.existsSync(folder) && !request.managed) {
				throw new FacadeError('REFUSED', `${folder} is outside this window, and worktree management is turned off by the setting ${WORKTREES_SETTING}. Nothing was started. ${next}`);
			}
			if (fs.existsSync(folder)) {
				throw new FacadeError('REFUSED', `${folder} is ${fs.statSync(folder).isDirectory() ? 'a folder' : 'a file'} outside this window. Nothing was started. ${next}`);
			}
			throw new FacadeError('NOT_FOUND', `${folder} does not identify a folder in this window. Nothing was started. ${next}`);
		}
		return found.folder;
	}

	/**
	 * The worktree of the repository of the caller's folder `own` that has `branch` checked out; refused where
	 * the caller has no repository, no worktree has the branch, or git was forced to check it out in two - saying
	 * what to do next as `request` asks.
	 */
	private async worktreeOnBranch(own: string | undefined, branch: string, request: PlaceRequest): Promise<string> {
		const repository = own === undefined ? undefined : await this.ports.git.repositoryOf(own);
		if (!repository) {
			throw new FacadeError('INVALID', `'${branch}' cannot be resolved as a branch because ${own === undefined ? 'the person has no selected folder' : `${own} is not in a repository`}. ${placeRecovery(request, 'repository')}`);
		}
		// Finding the worktree of a branch asks git for them, which worktree management off does not (WT-9.3; O3)
		if (!request.managed) {
			throw new FacadeError('UNAVAILABLE', `'${branch}' is not an absolute path, and branches cannot be resolved to worktrees while worktree management is turned off by the setting ${WORKTREES_SETTING}. ${placeRecovery(request, 'branch')}`);
		}
		// The main checkout and Facade's worktrees: another tool's is a folder, which no branch names (WT-1.3; O3)
		const listed = (await this.ports.git.worktreesOf(repository.main)).filter(each => isEqualPath(each.folder, repository.main) || this.ports.git.isFacadeWorktree(each.folder));
		const on = listed.filter(each => each.branch === branch);
		if (on.length > 1) {
			throw new FacadeError('INVALID', `Branch '${branch}' is checked out in ${on.length} worktrees of ${path.basename(repository.main)}: ${on.map(each => each.folder).join(', ')}. ${placeRecovery(request, 'branches')}`);
		}
		if (!on.length) {
			throw new FacadeError('NOT_FOUND', `No listed worktree of ${path.basename(repository.main)} has branch '${branch}' checked out. Known worktrees: ${listed.map(each => `${each.name} at ${each.folder}`).join(', ')}. ${placeRecovery(request, 'branch')}`);
		}
		return on[0].folder;
	}

	/**
	 * An agent's process ended: the agent ended, unless it had already. One Facade set out to stop was
	 * stopped, by whom it says; closed with its tab by the person - or with its worktree, or its folder - it was
	 * stopped by them; closed as its folder went from the disk, by no one Facade knows; else its CLI ended by
	 * itself - with its exit code, where it is known - or it did not start.
	 */
	private terminalEnded(id: number, end: TerminalEnd): void {
		const found = this.liveAgents().find(each => each.id === id);
		if (!found) {
			return;
		}
		// A closed terminal is a stop, the person's own, which finishes once the process has ended (AGENT-LAUNCHER.md:
		// "Terminal close is the human stop action"; O-stop): a CLI that ignores the hang-up is ended by its process
		if (this.runningProcessOf(found) !== undefined) {
			this.background(`Recording the end of ${describe(found)} after its terminal closed`, this.endOnceGone(found, now => this.terminalEndRecorded(now, end)));
			return;
		}
		this.terminalEndRecorded(found, end);
	}

	/** Records the end of an agent whose terminal closed, its own process gone, as the window saw it end. */
	private terminalEndRecorded(agent: LiveAgent, end: TerminalEnd): void {
		try {
			if (agent.state === 'stopping') {
				this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}), ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}) });
			} else if (end.byThePerson || end.reason === 'folderGone') {
				// A stop the person did, or - its folder gone - one nobody they know did: not asked for by them (L6). With
				// the exit code the window saw, for its creator's notice (M8)
				this.ended(agent, 'stopped', closedBecause(end), { ...(end.byThePerson ? { by: 'human' as const } : {}), ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}) });
			} else if (end.exitCode !== undefined && end.exitCode < 0) {
				// No exit code: no CLI exits -1, its process went with the terminal host (TM-17)
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', HOST_RESTARTED);
			} else {
				// An exit code 130 just after an agent pressed Ctrl+C there is its doing, and said so (L6)
				const interrupter = end.exitCode === INTERRUPTED ? this.screens.interruptedBy(agent.id) : undefined;
				const reason = end.exitCode === undefined ? 'its terminal closed' : `${exitedWith(end.exitCode)}${interrupter !== undefined ? `, after ${this.whoIs(interrupter)} sent Ctrl+C to its terminal` : ''}`;
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'exited', reason, { ...end.exitCode !== undefined ? { exitCode: end.exitCode } : {}, ...interrupter !== undefined ? { interruptedByAgent: true } : {} });
			}
		} catch (err) {
			this.log(`Could not record the end of ${describe(agent)}: ${messageOf(err)}`);
		}
	}

	/**
	 * Records how an agent ended - once - and takes back what was put into its folder once no agent runs
	 * there. The person hears of an agent they started that ended unexpectedly (AGENT-LAUNCHER.md, L6): its
	 * CLI exited with a code other than 0, or 130 from the keyboard - or one the window could not tell - also
	 * as it started; or it was stopped other than by them - by an agent, or by no one Facade knows; nothing of
	 * what they did, of a window that went, of a lost agent, or of a start from the window that says it failed
	 * itself. A start of their script's says it to the script, and to them (L5). The agents it started are not
	 * touched. Answers with its end; undefined for an agent that had ended already, or once the window closed.
	 */
	private ended(agent: Agent, kind: EndKind, reason: string, details: { readonly by?: StoppedBy; readonly exitCode?: number; readonly quiet?: boolean; readonly windowWent?: boolean; readonly interruptedByAgent?: boolean } = {}): End | undefined {
		if (this.disposed) {
			return undefined;
		}
		// Read before the start that waits for it, if one does, hears of its end - or, stopped as one waited, as that
		// start answered its caller with the stop (M8)
		const stoppedAnswered = this.stoppedWhileAnswered.delete(agent.id);
		const answered = stoppedAnswered || this.launcher.answers(agent.id);
		const end = this.table.end(agent.id, kind, reason, { ...(details.by !== undefined ? { by: details.by } : {}), ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}) });
		if (!end) {
			return undefined;
		}
		this.log(`${describe(agent)} ended (${kind}): ${reason}`);
		this.launcher.ended(agent.id, reason);
		this.withdraw(agent);
		// A start from the window that answers says how it failed itself; one of the person's script's, whom nobody may
		// be watching, is told them too (L5). Their CLI's normal exit is no news to them - nor what they did: an exit
		// 130 no agent is known to have caused is their own Ctrl+C - whether or not it had started (L6)
		const asUsual = details.exitCode === 0 || (details.exitCode === INTERRUPTED && !details.interruptedByAgent);
		const unexpected = ((kind === 'exited' || (kind === 'failed' && (!answered || !!agent.unattended))) && !asUsual)
			|| (kind === 'stopped' && details.by !== 'human');
		if (agent.creator === undefined && !details.quiet && unexpected) {
			this.tellEnded({ text: endNotice(agent, end, this.table.whoIs(end.by)), agent: agent.id, severity: endSeverity(end) });
		}
		// Its messages: those unread go back to their senders, and its creator, an agent, hears of its end (M6, M8)
		const notice: EndNotice = {
			how: howItEnded(end, this.table.whoIs(end.by)),
			told: howItEnded(end, this.table.whoIs(end.by), true),
			// Every end, exit 0 too - but a stop it asked for, one its start answered it with, and the window going
			tell: agent.creator !== undefined && !details.windowWent && !answered && !(end.kind === 'stopped' && end.by === agent.creator)
		};
		if (this.settling) {
			this.settling.push([agent, notice]);
		} else {
			this.messagesOfEnded(agent, notice);
		}
		return end;
	}

	/**
	 * An agent ended: its unread messages go back - to every live sender, the person whose window went too, and a
	 * creator its start answered with the failure, its task among them: M8 spares only the notice of an end (M6) -
	 * and its creator hears of it as `notice` says.
	 */
	private messagesOfEnded(agent: Agent, notice: EndNotice): void {
		try {
			this.mail.ended(this.table.get(agent.id) ?? agent, notice.how, notice.tell, notice.told);
		} catch (err) {
			this.log(`Could not record all returned unread messages and the creator's end notice for ${describe(agent)}: ${messageOf(err)}`);
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
			this.log(`Could not close ${describe(agent)}'s terminal: ${messageOf(err)}`);
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
			throw new FacadeError('FAILED', `Could not configure ${cli.displayName} to trust ${trusted.folder}: ${messageOf(err)}`);
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
			this.log(`Could not remove Facade's injected files and entries from ${agent.folder}: ${messageOf(err)}`);
		}
	}

	/** Takes back what no agent may still use; answers whether something is left to take back later. */
	private sweep(): boolean {
		try {
			return this.injections.sweep();
		} catch (err) {
			this.log(`Could not finish removing injected files and entries left by ended agents. Cleanup will retry when the next window opens. Reason: ${messageOf(err)}`);
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
	private async startableHere(id: string, folder: string, custom = false, unattended = false): Promise<{ readonly installed: InstalledCli; readonly config: CliConfig }> {
		const found = this.cliOf(id, custom);
		const startable = () => this.startable().map(each => each.id).join(', ') || 'none';
		if (!found) {
			throw new FacadeError('INVALID', `Unknown CLI or custom agent '${id}'. Available to start: ${startable()}.`);
		}
		const { cli, config } = found;
		if (!config.enabled) {
			throw new FacadeError('UNAVAILABLE', `${cli.displayName} is disabled by ${cli.setting}.enabled. Available to start: ${startable()}.`);
		}
		if (config.wrong) {
			throw new FacadeError('UNAVAILABLE', `Cannot start ${cli.displayName} until the person corrects its settings: ${config.wrong.join('; ')}. Open Show Agent Launch to inspect them.`);
		}
		const env = { ...await this.options.clis.environment(folder), ...launchFor(config, unattended).launch.environment };
		this.stillOpen();
		// Found as its terminal will find it: in the environment a terminal there has, with its starter's launch's (L10).
		const installed = this.options.clis.locate(cli, config, env, folder);
		if (!installed) {
			throw new FacadeError('UNAVAILABLE', `Cannot start ${cli.displayName} in ${folder}: ${whyNotInstalled(cli, config, 'the PATH used by a terminal in that folder')}.`);
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
			throw new FacadeError('UNAVAILABLE', `Cannot start an agent until the person corrects this setting: ${messageOf(err)}`);
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
			throw new FacadeError('REFUSED', `${agentRef(agent.id)} is outside your tree. With YOLO off, you can reach only your tree: your human-started root and all its descendants.`);
		}
	}

	/**
	 * The environment a CLI starts with in `folder`: the terminals' there, with what its launch sets in it - for one
	 * started through `start_agent`, `unattended`, its launch's unattended part too - where its trust and its
	 * configuration are found (AGENT-LAUNCHER.md, L10).
	 */
	private async environmentOf(installed: InstalledCli, folder: string, unattended: boolean): Promise<Environment> {
		return { ...await this.options.clis.environment(folder), ...launchFor(installed.config, unattended).launch.environment };
	}

	/**
	 * The agent a tool names (O2): by its number, `#a7`, `#7`, `a7` or `7`; by `@name`, where one agent that
	 * has not ended and that the caller reaches has that name; or as Facade's words name it, `@name #a7`, the
	 * number that agent's. A number of another kind, and a bare number an agent that has not ended is also
	 * called, are refused: no agent is named on a guess. The person is refused too, one way for every tool that
	 * takes an agent: they exist, and have no run to stop, read or type into (O2; D2). A name only ended agents
	 * have answers with their numbers.
	 */
	private agentNamed(target: string, caller: Caller): Agent {
		const reference = parseAgentReference(target);
		const reach = [...this.table.state.agents.values()].filter(agent => this.reaches(caller, agent));
		if (reference.kind === 'other') {
			throw new FacadeError('INVALID', `'${reference.text}' is not an agent ID${/^#m/i.test(reference.text) ? '; it is a message ID' : ''}. Use an agent ID such as #a1 or #a2.`);
		}
		if (reference.kind === 'number') {
			if (reference.bare) {
				const named = AgentTable.liveNamedIn(reach, target.trim().toLowerCase());
				if (named.length) {
					throw new FacadeError('INVALID', `'${target.trim()}' is ambiguous: it may mean ${agentRef(reference.id)} or the name of ${named.map(describe).join(', ')}. Use ${agentRef(reference.id)} for the ID, or a name followed by its ID.`);
				}
			}
			const agent = this.table.get(reference.id);
			if (!agent) {
				throw new FacadeError('NOT_FOUND', `No agent has ID ${agentRef(reference.id)}. Call list_agents with all:true to see every reachable run.`);
			}
			// One out of reach is refused before its name could be said (X-54)
			this.assertReaches(caller, agent);
			if (reference.name !== undefined && reference.name !== agent.name) {
				// No agent is both: the one named is not there (O2)
				throw new FacadeError('NOT_FOUND', `Name and ID do not match: @${reference.name} is not ${agentRef(agent.id)}; ${agentRef(agent.id)} is @${agent.name}. Use the ID alone or the correct name.`);
			}
			return agent;
		}
		if (reference.name === PERSON.name) {
			throw new FacadeError('REFUSED', `${describe(PERSON)} is the person and has no agent run to stop, read, or type into. Use send_message to contact them.`);
		}
		const named = AgentTable.liveNamedIn(reach, reference.name);
		if (named.length > 1) {
			throw new FacadeError('INVALID', `${named.length} active runs are named @${reference.name}: ${named.map(describe).join(', ')}. Select one by its agent ID.`);
		}
		if (!named.length) {
			const ended = reach.filter(agent => agent.name === reference.name);
			throw new FacadeError('NOT_FOUND', ended.length
				? `All runs named @${reference.name} have ended: ${ended.map(describe).join(', ')}. Select one by its agent ID.`
				: `No reachable agent is named @${reference.name}. Call list_agents with all:true to see reachable runs.`);
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
			...(agent.setup !== undefined ? { setup: agent.setup } : {}),
			...(agent.state === 'stopping' && agent.stopping ? { stopping: agent.stopping } : {}),
			...this.removalOf(agent.folder),
			startTime: agent.startTime,
			...(this.table.state.mail.tasks.has(agent.id) ? { taskMessage: this.table.state.mail.tasks.get(agent.id) } : {}),
			...(agent.end ? { end: agent.end } : {})
		};
	}

	/** The removal of the worktree `folder` with stop_agent, as an agent there is described: under way, or the last one failed (O11). */
	private removalOf(folder: string): Pick<AgentFacts, 'worktreeRemoval'> {
		if (this.deletions.some(each => isEqualPath(each.folder, folder))) {
			return { worktreeRemoval: { state: 'pending' } };
		}
		const failed = this.table.failedRemoval(folder);
		return failed && fs.existsSync(folder) ? { worktreeRemoval: { state: 'failed', ...(failed.by !== undefined ? { by: failed.by } : {}), ...(failed.reason !== undefined ? { reason: failed.reason } : {}) } } : {};
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

/**
 * What a start of `installed` through `start_agent` in `place` says of the servers of its folder's project MCP configuration
 * its launch runs without: with YOLO off, Claude Code's, those the person has not approved for the project, which it would
 * stop to ask about (AGENT-LAUNCHER.md, L4, rule 3; LV-02). None where there are none.
 */
function serversOffNotes(installed: InstalledCli, place: { readonly folder: string; readonly repository: string }, home: string, yolo: boolean): string[] {
	const off = installed.cli.projectServersOff?.(launchFor(installed.config, true), place, home, yolo, true) ?? [];
	return off.length ? [`With YOLO off, ${installed.cli.displayName} skips project MCP servers in ${place.folder} that the person has not approved, avoiding a blocking approval prompt: ${off.join(', ')}.`] : [];
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
const HOST_RESTARTED = 'the window\'s terminal host restarted and ended the agent\'s process';

/** Why an agent ended whose CLI exited with `exitCode`, where nothing more is known of it. */
function exitedWith(exitCode: number): string {
	return `its CLI ended with exit code ${exitCode}`;
}

/**
 * Why an agent's terminal was closed, where its CLI did not exit by itself (AGENT-LAUNCHER.md, L6): its tab closed,
 * its worktree deleted or its folder removed from the workspace, by the person; or its folder gone from the disk - a
 * worktree removed outside Facade - by no one Facade knows.
 */
function closedBecause(end: TerminalEnd): string {
	switch (end.reason) {
		case 'worktreeDeleted': return 'its worktree was deleted';
		case 'folderRemoved': return 'its folder was removed from the workspace';
		case 'folderGone': return 'its folder no longer exists on disk';
		default: return 'its terminal tab was closed';
	}
}

function cutBeforeLaunch(agent: LiveAgent): boolean {
	return agent.state === 'starting' && (agent.phase === 'creating_worktree' || agent.phase === 'running_setup');
}

/**
 * Why a start cut before its CLI was launched - or ran, cut as it was being launched - failed: as the window went, or -
 * `hostOnly` - as Facade started again in this very window; and where its worktree stays, where `made` (O11; OR-14).
 */
function cutReason(agent: LiveAgent, made: boolean, hostOnly: boolean): string {
	const cut = hostOnly ? 'when Facade restarted in this window' : 'when the window closed';
	const where = agent.phase === 'creating_worktree' ? 'during worktree creation' : agent.phase === 'running_setup' ? 'during worktree setup' : 'during CLI launch';
	const left = made ? `; its worktree remains at ${agent.folder}${hostOnly && agent.phase === 'running_setup' ? ', and setup continues in its terminal' : ''}` : '';
	return `startup was interrupted ${cut}, ${where}, before its CLI ${agent.phase === 'launching_cli' ? 'ran' : 'was launched'}${left}`;
}

/**
 * How an agent ended, as Facade's messages say it (AGENT-MESSAGES.md, M6, M8): "stopped by @lead #a1 with
 * stop_agent", "it exited, with exit code 1", "it exited: its CLI ended with exit code 130, after @x #a5 pressed
 * Ctrl+C there", "it did not start: ...". `stopper` names who stopped it.
 */
function howItEnded(end: End, stopper: string, withExitCode = false): string {
	switch (end.kind) {
		case 'stopped': {
			// Its exit code where the window saw one, for the notice of its end (AGENT-MESSAGES.md, M8)
			const code = withExitCode && end.exitCode !== undefined ? `, with CLI exit code ${end.exitCode}` : '';
			return end.by === undefined ? `stopped: ${end.reason}${code}` : /^(with|as) /.test(end.reason) ? `stopped by ${stopper} ${end.reason}${code}` : `stopped by ${stopper}: ${end.reason}${code}`;
		}
		case 'exited':
			// Its reason, where it says more than its code: which agent pressed Ctrl+C there, Facade away (M8; L6)
			return end.exitCode === undefined ? `it ended: ${end.reason}` : end.reason === exitedWith(end.exitCode) ? `it exited with code ${end.exitCode}` : `it exited: ${end.reason}`;
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
			return l10n.t("{0} failed to start: {1}.", describe(agent), end.reason);
		case 'lost':
			return l10n.t("{0} ended unexpectedly: {1}.", describe(agent), end.reason);
		case 'stopped':
			return typeof end.by === 'number'
				? l10n.t("{0} was stopped by {1}.", describe(agent), stopper)
				: l10n.t("{0} was stopped: {1}.", describe(agent), end.reason);
	}
}
