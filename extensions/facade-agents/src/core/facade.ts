/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { messageOf } from '../base/errors';
import { isEqualPath } from '../base/files';
import { withFileLock } from '../base/lock';
import { AgentCli, Environment, InstalledCli } from '../clis/cli';
import { whyNotInstalled } from '../clis/config';
import { writeTrust } from '../clis/trust';
import { agentName, AgentTable, nameOfWorktree } from '../record/agents';
import { Agent, AgentState, Caller, describe, Exit, ExitKind, isLive, LiveAgent, MadeWorktree, PERSON } from '../record/events';
import { HUMAN, Recipient } from '../record/messages';
import { injectedFile } from '../record/paths';
import { screensDir } from '../record/screens';
import { FacadeError } from './errors';
import { Injections } from './injections';
import { Launcher, START_TIMEOUT_MS } from './launch';
import { agentText, Mail } from './mail';
import { AgentSetup, CliCatalog, Disposable, EndedAgent, Ports, Repository, TerminalEnd, Timing } from './ports';
import { Screens } from './screens';

/**
 * How often, and how many times, the folders Facade made that a process of an exited agent still had
 * in use are tried again: three minutes, past the two an MCP server of Facade's waits for its window
 * where the person sets nothing else. The next window to start tries too.
 */
const TAKE_BACK_AGAIN_MS = 15_000;
const TAKE_BACK_TRIES = 12;
/** An agent's number, as a tool is given it: `#a7`, `a7`, `#7` or `7`. */
const NUMBER = /^#?a?(?<id>\d+)$/i;
/** An agent as Facade's words name it: `@name #a7`, or `@name #7`. */
const NAMED_NUMBER = /^@(?<name>\S+)\s+#a?(?<id>\d+)$/i;
/** A message's number, given where an agent is asked for. */
const MESSAGE_NUMBER = /^#?m\d+$/i;

/** What the core is made with: the record, the window's ports, the CLIs, and what agents are given. */
export interface FacadeOptions {
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	readonly log: (message: string) => void;
	/** The record of the files Facade put into folders, which every window shares: by default `~/.facade/injected.json`. */
	readonly injected?: string;
	/** How long the core waits, as the person sets it; where left out, two minutes for a new agent to come up. */
	readonly timing?: () => Timing;
}

/** What a caller asks `spawn` for: the CLI, its model and how hard it thinks, the task, where the child works, and its name. */
export interface SpawnRequest {
	/** The CLI, by its id. */
	readonly cli: string;
	/** The model and the effort as the CLI takes them: Facade passes them on as they are, and no CLI checks them as it starts. */
	readonly model: string;
	readonly effort: string;
	/** Its task, if it is given one. */
	readonly prompt?: string;
	/** Omitted: the caller's folder; `new`: a new worktree on the branch `name`; else a worktree of the caller's repository, by name. */
	readonly worktree?: string;
	readonly name?: string;
	/** The folder the person starts an agent in, the one on screen: the person has none of their own. */
	readonly folder?: string;
}

/** What `spawn` answers with: the agent started, and where it works. */
export interface Spawned {
	readonly id: number;
	readonly name: string;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	/** Whether its worktree was made for it, on the new branch `worktree`. */
	readonly newWorktree: boolean;
	/** The number of its task, a message from the caller, which it fetches itself. */
	readonly task?: number;
}

/** One line of `ps`: an agent as it is now. */
export interface AgentRow {
	readonly id: number;
	/** Its parent now: the agent that started it while that one runs; none, the person, else. */
	readonly parent?: number;
	readonly name: string;
	readonly state: AgentState;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	readonly startTime: number;
	readonly exit?: Exit;
}

/** What `kill` answers with: the agent, and how it exited. */
export interface Killed {
	readonly id: number;
	readonly name: string;
	/** Whether it had exited before the call: then its exit says how. */
	readonly alreadyExited: boolean;
	readonly exit: Exit;
}

/** How an agent ended, as its record and its messages say it. */
interface End {
	readonly kind: ExitKind;
	/** Why, as the record has it. */
	readonly reason: string;
	/** How, as Facade's messages say it: "stopped by @you", "it exited, with exit code 1". */
	readonly how: string;
	/**
	 * Whether its creator is told (AGENT-MESSAGES.md M8): an agent creator of any end but a stop it asked
	 * for, a start that failed which the start waiting for it said, and its window closing; the person, of
	 * an agent they started, of an exit code other than 0, or a stop by an agent, but where a start
	 * waiting for it said so.
	 */
	readonly tell: boolean;
	/**
	 * Whose messages to the agent are noted in its chat room rather than sent back (AGENT-LAUNCHER.md L6):
	 * the creator whose start said it failed, which its task going back would say again, and the person
	 * when its window closed, as no notice comes of a shutdown.
	 */
	readonly knownTo?: readonly Recipient[];
}

/** Where a child starts: a folder there is, or a worktree to make. */
type Place =
	| { readonly kind: 'folder'; readonly folder: string; readonly worktree: string }
	| { readonly kind: 'new'; readonly repository: Repository; readonly head: string; readonly branch: string };

/**
 * Facade, the kernel of AGENT-FRAMEWORK.md: it starts agents, keeps their table, and ends them, as an
 * operating system does its processes. An agent has a number no other gets, a parent, and children; the
 * person, who has no number, takes in the orphans. Facade knows what it did and what is certain - an
 * agent started, its MCP server said hello, its terminal ended - and never what an agent is doing:
 * whether it works or waits is its parent's to find out. Every caller comes through here - the contract
 * for an agent's tool calls, Start Agent for the person - and it reaches the window only through its
 * ports.
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
	/** The agents' screens: read, typed into, and kept as their terminals end. */
	readonly screens: Screens;
	/** When the folders a process had in use are tried again, while some are. */
	private takingBack: ReturnType<typeof setTimeout> | undefined;
	private takeBackTriesLeft = 0;
	private disposed = false;

	constructor(private readonly options: FacadeOptions) {
		this.table = options.table;
		this.ports = options.ports;
		this.injections = new Injections(options.injected ?? injectedFile(), this.table.dir, message => this.log(message), text => this.ports.person.tell(text, undefined));
		this.screens = new Screens({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			dir: screensDir(this.table.dir),
			timing: () => this.timing(),
			cliOf: id => this.cliOf(id),
			agentNamed: (target, within) => this.agentNamed(target, within),
			inReach: (caller, id) => this.mail.inReach(caller, id),
			terminalOf: agent => this.terminalOf(agent),
			log: message => this.log(message)
		});
		this.launcher = new Launcher({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			injections: this.injections,
			timing: () => this.timing(),
			terminalOf: agent => this.terminalOf(agent),
			finalScreenOf: agent => this.screens.finalScreenOf(agent),
			excerptOf: agent => this.screens.excerptOf(agent),
			fail: (agent, reason) => this.fail(agent, reason),
			sendTask: (caller, agent, task) => this.mail.sendTask(caller, agent, task),
			firstRing: (agent, task) => this.mail.firstRing(agent, task),
			running: agent => this.mail.running(agent),
			log: message => this.log(message)
		});
		this.mail = new Mail({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			timing: () => this.timing(),
			agentNamed: (text, within) => this.agentNamed(text, within),
			terminalOf: agent => this.terminalOf(agent),
			endedAgent: id => this.endedAgent(id),
			excerptOf: agent => this.screens.excerptOf(agent),
			log: message => this.log(message)
		});
		this.disposables.push(this.launcher, this.mail, this.ports.terminals.onDidEnd((terminal, end) => this.terminalEnded(terminal, end)));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		clearTimeout(this.takingBack);
		this.takingBack = undefined;
	}

	/** The agent numbered `id`, exited or not. */
	agent(id: number): Agent | undefined {
		return this.table.get(id);
	}

	/** The agent a caller is; undefined for the person. */
	agentOf(caller: Caller): Agent | undefined {
		return caller.id === undefined ? undefined : this.table.get(caller.id);
	}

	/** The agent numbered `id` once it ended, as a notice about it shows it: where its last screen is; undefined while it runs. */
	endedAgent(id: number): EndedAgent | undefined {
		const agent = this.table.get(id);
		return agent?.exit && { id, name: agent.name, terminal: this.terminalOf(agent), finalScreen: this.screens.finalScreenOf(agent), ending: `${agent.exit.kind}: ${agent.exit.reason}` };
	}

	/** A CLI's name for people, by its id. */
	cliName(id: string): string {
		return this.cliOf(id)?.displayName ?? id;
	}

	/** The CLIs Facade can start on this machine. */
	clis(): readonly InstalledCli[] {
		return this.options.clis.installed();
	}

	/**
	 * An agent's MCP server said hello to Facade: it is running. One told of its task in its terminal is
	 * told now; then it is up.
	 */
	connected(caller: Caller): void {
		const agent = this.agentOf(caller);
		if (!this.disposed && agent?.state === 'starting') {
			this.launcher.hello(agent);
		}
	}

	/**
	 * Starts a child of the caller in its own UI: beside it, in a worktree of its repository, or in a new
	 * worktree on the branch `name`, at the caller's HEAD. Answers once the child is up, with its number;
	 * a child that exits before fails the call. Once begun, a spawn is carried through: a caller that exits
	 * meanwhile leaves its child to the person. Its model and effort go to its CLI as they are: the CLI is
	 * the one that knows which it has.
	 */
	async spawn(caller: Caller, request: SpawnRequest, progress?: (message: string) => void): Promise<Spawned> {
		const installed = this.installed(request.cli);
		const { displayName } = installed.cli;
		const model = request.model.trim();
		if (!model) {
			throw new FacadeError('INVALID', `model is required: one of ${displayName}'s models, as ${displayName} takes it.`);
		}
		const effort = request.effort.trim();
		if (!effort) {
			throw new FacadeError('INVALID', `effort is required: how hard the child thinks, as ${displayName} takes it - low, medium, high and so on.`);
		}
		const name = request.name === undefined ? undefined : this.nameOf(request.name);
		const home = this.agentOf(caller)?.folder ?? request.folder;
		if (home === undefined) {
			throw new FacadeError('INVALID', 'The person has no folder of their own: start an agent with Facade: Start Agent, in the folder on screen.');
		}
		// Everything that can refuse the call is asked before anything is made for it.
		const place = await this.placeOf(caller, home, request.worktree, name);
		this.stillOpen();
		const env = this.environmentOf(installed);
		this.launcher.check(installed, model, effort, home, caller, env);

		let folder: string;
		let worktree: string;
		if (place.kind === 'new') {
			progress?.(`Making the worktree ${place.branch}.`);
			try {
				folder = await this.ports.git.makeWorktree(place.repository.main, place.branch, place.head);
			} catch (err) {
				throw new FacadeError('FAILED', `The worktree ${place.branch} could not be made: ${messageOf(err)}`);
			}
			this.stillOpen();
			worktree = place.branch;
			this.table.recordWorktree({ name: worktree, folder, repository: place.repository.main, parentWorktree: place.repository.worktree, ...(caller.id !== undefined ? { madeBy: caller.id } : {}) });
		} else {
			({ folder, worktree } = place);
		}

		// In a worktree Facade made, the CLI is given the person's trust in it, so that it does not stop to ask.
		const made = this.table.madeWorktree(folder);
		if (made) {
			this.trust(installed, made, env);
		}
		const { agent, task } = await this.launcher.launch(caller, installed, { name: name ?? nameOfWorktree(worktree), model, effort, prompt: request.prompt, worktree, folder, trusted: !!made }, progress);
		return { id: agent.id, name: agent.name, cli: agent.cli, model: agent.model, effort, worktree: agent.worktree, folder: agent.folder, newWorktree: place.kind === 'new', ...(task !== undefined ? { task } : {}) };
	}

	/**
	 * The agents as the caller sees them: itself, its parent, and its children - those it started, exited
	 * ones too, and those that are its own now; with `all`, every agent the workspace has had. By number.
	 */
	ps(caller: Caller, all = false): AgentRow[] {
		const self = this.agentOf(caller);
		const ownParent = self && this.table.parentOf(self);
		return [...this.table.state.agents.values()]
			.filter(agent => all
				|| agent.id === caller.id
				|| agent.id === ownParent
				|| agent.parent === caller.id
				|| (isLive(agent) && this.table.parentOf(agent) === caller.id))
			.sort((a, b) => a.id - b.id)
			.map(agent => {
				const parent = this.table.parentOf(agent);
				return {
					id: agent.id,
					...(parent !== undefined ? { parent } : {}),
					name: agent.name,
					state: agent.state,
					cli: agent.cli,
					model: agent.model,
					effort: agent.effort,
					worktree: agent.worktree,
					folder: agent.folder,
					startTime: agent.startTime,
					...(agent.exit ? { exit: agent.exit } : {})
				};
			});
	}

	/**
	 * Ends one of the caller's children: its CLI ends and its terminal closes; its folder stays as it is.
	 * Its own children run on, and are the person's now. The person ends any agent.
	 */
	async kill(caller: Caller, target: string): Promise<Killed> {
		this.stillOpen();
		const agent = this.agentNamed(target);
		if (caller.id !== undefined && this.table.parentOf(agent) !== caller.id) {
			throw new FacadeError('REFUSED', `${describe(agent)} is not your child: an agent kills only its own children, and the person any. ${this.childrenOfText(caller)}`);
		}
		if (agent.exit) {
			return { id: agent.id, name: agent.name, alreadyExited: true, exit: agent.exit };
		}
		const exit = this.exited(agent, {
			kind: 'killed',
			reason: `killed by ${describe(caller)}`,
			how: `stopped by ${messageText(caller)}`,
			tell: agent.parent === undefined ? caller.id !== undefined : agent.parent !== caller.id
		});
		// Only a window that closed records nothing for an agent that has not exited.
		if (!exit) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
		// Recorded as killed already: a terminal that would not close is the log's to say, not the call's.
		try {
			await this.ports.terminals.stop(this.terminalOf(agent));
		} catch (err) {
			this.log(`${this.terminalOf(agent)} could not be closed: ${messageOf(err)}`);
		}
		return { id: agent.id, name: agent.name, alreadyExited: false, exit };
	}

	/**
	 * As Facade comes back - after a reload, a restart, or turned on again - an agent whose terminal is
	 * gone has exited. When the window before was closed - the person quit Facade, closed the window, or
	 * opened another workspace in it - and none of its agents came back, they went with it: killed by the
	 * person, as a terminal they close is, without a word to them. After a reload, while Facade was off,
	 * after a crash, or beside others that came back, one gone ended by itself. One that was starting is
	 * waited for again, its MCP server's hello coming to this window; one not yet told of its task is told
	 * now. What windows that closed left in folders is taken back. A start of the window that is not a
	 * reload clears the list: the mailboxes of the agents that ended are emptied.
	 *
	 * @param reloaded Whether a reload of the window before loaded this one.
	 */
	async recover(reloaded = false): Promise<void> {
		if (this.sweep()) {
			this.takeBackLater();
		}
		// A worktree Facade made that is gone - deleted by the person, or by git - is its no more.
		for (const made of [...this.table.state.worktrees.values()]) {
			if (!fs.existsSync(made.folder)) {
				this.table.forgetWorktree(made.folder);
			}
		}
		const endedBefore = new Set([...this.table.state.agents.values()].filter(agent => !isLive(agent)).map(agent => agent.id));
		const gone: LiveAgent[] = [];
		let cameBack = false;
		for (const agent of this.liveAgents()) {
			// One whose terminal the window does not answer for keeps neither the others nor Facade from coming back.
			try {
				if (await this.ports.terminals.isAlive(this.terminalOf(agent))) {
					cameBack = true;
					this.launcher.resume(agent);
					// The window gave its terminal back knowing nothing of it: where its final screen goes, among others
					if (!await this.ports.terminals.register(this.terminalOf(agent), agent.id, this.screens.finalScreenOf(agent))) {
						this.log(`${this.terminalOf(agent)} came back, but the window could not be told it is an agent's: its final screen will not be kept.`);
					}
				} else {
					gone.push(agent);
				}
			} catch (err) {
				this.log(`Coming back to ${this.terminalOf(agent)} failed: ${messageOf(err)}`);
			}
			if (this.disposed) {
				return;
			}
		}
		// The window before was closed: another workspace's, or this workspace's and not reloaded - not this
		// very window, whose extension host started again, and not Facade letting go of its agents
		const last = this.table.lastClose;
		const windowClosed = last?.by === 'window' && !last.thisWindow && (!last.ownWindow || !reloaded);
		const closedByThePerson = windowClosed && !cameBack;
		// A fresh start: the screens of agents that ended before it are let go of with them
		if (windowClosed) {
			this.screens.discard(endedBefore);
		}
		// Children before their parents: a parent's exit then leaves no child that went with it to tell of as the person's
		const ended: [Agent, End][] = [];
		for (const agent of gone.sort((a, b) => b.id - a.id)) {
			const reason = closedByThePerson ? 'the person closed its window' : 'its terminal was gone when Facade came back';
			// A child lost is told of - its start's answer, if it was starting, went with the window before -
			// one the person started is not
			const end: End = closedByThePerson
				? { kind: 'killed', reason, how: 'its window closed', tell: false, knownTo: [HUMAN] }
				: { kind: agent.state === 'starting' ? 'failed' : 'exited', reason, how: `it was lost: ${reason}`, tell: agent.parent !== undefined };
			if (this.exited(agent, end, false)) {
				ended.push([agent, end]);
			}
			// The window may have started a shell in its tab, under its name: no agent's, and closed as its terminal would be
			try {
				await this.ports.terminals.closeRevived(this.terminalOf(agent));
			} catch (err) {
				this.log(`What came back under the name of ${this.terminalOf(agent)} could not be closed: ${messageOf(err)}`);
			}
		}
		// They ended together: none's unread messages go back to another of them
		for (const [agent, end] of ended) {
			this.messagesOfEnded(agent, end);
		}
		// What was put into a folder whose agents exited while no window was there to see it.
		for (const folder of this.injections.held()) {
			this.withdraw(folder);
		}
		// Not this window's extension host starting again, nor Facade turned on again within it
		const fresh = !reloaded && !last?.thisWindow;
		if (fresh && this.table.state.mail.mailboxes.size) {
			try {
				this.table.clearList();
			} catch (err) {
				this.log(`The list could not be cleared: ${messageOf(err)}`);
			}
		}
		this.mail.recover(fresh, last?.by === 'facade');
	}

	/** Where a child of the caller starts: in `home`, a worktree of its repository, or a new worktree to make. */
	private async placeOf(caller: Caller, home: string, worktree: string | undefined, name: string | undefined): Promise<Place> {
		if (worktree === undefined) {
			return { kind: 'folder', folder: home, worktree: this.agentOf(caller)?.worktree ?? await this.worktreeOf(home) };
		}
		if (worktree === 'new' && name === undefined) {
			throw new FacadeError('INVALID', 'name is required with worktree "new": the new worktree\'s branch is named after the child.');
		}
		const repository = await this.ports.git.repositoryOf(home);
		if (!repository) {
			throw new FacadeError('REFUSED', `${home} is in no git repository, so it has no worktrees: start the child there, without worktree.`);
		}
		if (worktree === 'new' && name !== undefined) {
			if (repository.head === undefined) {
				throw new FacadeError('REFUSED', `${home} is on a branch with no commit yet, or one git cannot read: a new worktree starts at a commit.`);
			}
			return { kind: 'new', repository, head: repository.head, branch: name };
		}
		const listed = await this.ports.git.worktreesOf(repository.main);
		const found = listed.find(each => each.name === worktree);
		if (!found) {
			throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} is called ${worktree}. Its worktrees: ${listed.map(each => each.name).join(', ')}.`);
		}
		return { kind: 'folder', folder: found.folder, worktree: found.name };
	}

	/** An agent's terminal ended: the agent exited, unless it had already. Its CLI's exit code is said where it is not 0. */
	private terminalEnded(terminal: string, end: TerminalEnd): void {
		const agent = this.liveAgents().find(each => this.terminalOf(each) === terminal);
		if (!agent) {
			return;
		}
		// One that ended starting failed to start, which the start waiting for it, if one does, says
		const reported = agent.state === 'starting' && this.launcher.isWaited(agent.id);
		const creator = agent.parent ?? HUMAN;
		try {
			if (end.byThePerson) {
				this.exited(agent, { kind: 'killed', reason: 'the person closed its terminal', how: `stopped by ${messageText(PERSON)}`, tell: agent.parent !== undefined && !reported, ...(reported ? { knownTo: [creator] } : {}) });
			} else {
				const reason = end.exitCode === undefined ? 'its terminal closed' : end.exitCode === 0 ? 'its CLI ended' : `its CLI ended with exit code ${end.exitCode}`;
				const how = end.exitCode === undefined ? 'its terminal closed' : `it exited, with exit code ${end.exitCode}`;
				this.exited(agent, {
					kind: agent.state === 'starting' ? 'failed' : 'exited',
					reason,
					how,
					tell: !reported && (agent.parent !== undefined || (end.exitCode !== undefined && end.exitCode !== 0)),
					...(reported ? { knownTo: [creator] } : {})
				});
			}
		} catch (err) {
			this.log(`Recording that ${terminal} ended failed: ${messageOf(err)}`);
		}
	}

	/**
	 * Records how an agent exited - once - and takes back what was put into its folder once no agent runs
	 * there. Its unread messages go back to their senders, and its creator hears of its end as `end` says
	 * - unless `messages` is false, for agents that ended together, whose messages are settled once all of
	 * them are recorded. The person hears of the children that are theirs now. Answers with its exit;
	 * undefined for an agent that had exited already, or once the window closed.
	 */
	private exited(agent: Agent, end: End, messages = true): Exit | undefined {
		if (this.disposed) {
			return undefined;
		}
		const orphans = this.table.childrenOf(agent.id);
		const exit = this.table.setExited(agent.id, end.kind, end.reason);
		if (!exit) {
			return undefined;
		}
		this.log(`${this.terminalOf(agent)} exited (${end.kind}): ${end.reason}`);
		this.launcher.ended(agent.id, end.reason);
		this.withdraw(agent.folder);
		if (messages) {
			this.messagesOfEnded(agent, end);
		}
		if (orphans.length) {
			this.ports.person.tell(l10n.t("@{0} #a{1} ended, and its children are yours now: {2}.", agent.name, agent.id, orphans.map(describe).join(', ')), this.terminalOf(orphans[0]));
		}
		return exit;
	}

	/** An agent ended: its unread messages go back, and its creator hears of it as `end` says. */
	private messagesOfEnded(agent: Agent, end: End): void {
		try {
			this.mail.ended(agent, end.how, end.tell, end.knownTo);
		} catch (err) {
			this.log(`The unread messages of ${this.terminalOf(agent)}, and its creator's notice, could not all be recorded: ${messageOf(err)}`);
		}
	}

	/**
	 * Ends an agent that did not come up: recorded as failed, and its terminal closed. Its creator is told
	 * where no start waits for it to say so: one found starting after a reload.
	 */
	private async fail(agent: Agent, reason: string): Promise<void> {
		const reported = this.launcher.isWaited(agent.id);
		if (!this.exited(agent, { kind: 'failed', reason, how: `it did not start: ${reason}`, tell: !reported, ...(reported ? { knownTo: [agent.parent ?? HUMAN] } : {}) })) {
			return;
		}
		try {
			await this.ports.terminals.stop(this.terminalOf(agent));
		} catch (err) {
			this.log(`${this.terminalOf(agent)} could not be closed: ${messageOf(err)}`);
		}
	}

	/**
	 * Gives a CLI that keeps it in a file the person's trust in a worktree Facade made, as its
	 * `launch.trust` says: in the file the CLI reads in `env`, the environment it starts with.
	 */
	private trust({ cli, config }: InstalledCli, made: MadeWorktree, env: Environment): void {
		try {
			// Under a lock every window takes: two windows trusting worktrees at once each keep the other's.
			const done = writeTrust(cli, config, { folder: made.folder, repository: made.repository }, withFileLock, env);
			if (done) {
				this.log(done);
			}
		} catch (err) {
			// It asks on its own screen instead, where the person answers.
			this.log(`${cli.displayName}'s trust in ${made.folder} could not be written: ${messageOf(err)}`);
		}
	}

	/** Takes back what Facade put into a folder for this window's agents, once none of them runs there. */
	private withdraw(folder: string): void {
		if (this.liveAgents().some(agent => isEqualPath(agent.folder, folder))) {
			return;
		}
		try {
			if (this.injections.release(folder)) {
				this.takeBackLater();
			}
		} catch (err) {
			this.log(`What Facade put into ${folder} could not be taken back: ${messageOf(err)}`);
		}
	}

	/** Takes back what only windows that closed hold; answers whether folders a process had in use are left. */
	private sweep(): boolean {
		try {
			return this.injections.sweep();
		} catch (err) {
			this.log(`What windows that closed left in folders could not be taken back: ${messageOf(err)}. The next window tries again.`);
			return false;
		}
	}

	/**
	 * Tries again, a while on, to remove the folders Facade made that a process of an exited agent had in
	 * use - its CLI's, a moment from its end - while some are left: each time some are left in use, for
	 * another {@link TAKE_BACK_TRIES} tries.
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

	/** The CLI with the id `id` on this machine; where it has none, why, and the CLIs it has. */
	private installed(id: string): InstalledCli {
		const installed = this.options.clis.installed();
		const found = installed.find(each => each.cli.id === id);
		if (!found) {
			const known = this.cliOf(id);
			const why = known ? `: ${whyNotInstalled(known, this.options.clis.configOf(known))}` : '';
			throw new FacadeError('UNAVAILABLE', installed.length
				? `Facade cannot start ${id} here${why}. It starts: ${installed.map(each => each.cli.id).join(', ')}.`
				: `Facade cannot start ${id} here${why}. None of the CLIs it starts is on this machine.`);
		}
		return found;
	}

	/** The environment a CLI starts with: the terminals', with what its launch sets in it. */
	private environmentOf(installed: InstalledCli): Environment {
		return { ...this.options.clis.environment(), ...installed.config.launch.environment };
	}

	/**
	 * The agent a tool names: by its number, `#a7`; by `@name`, where one agent that has not exited has
	 * that name - one `within` the caller's reach, where several have it; or as Facade's words name it,
	 * `@name #a7`, the number that agent's.
	 */
	private agentNamed(target: string, within?: (agent: Agent) => boolean): Agent {
		const text = target.trim();
		if (MESSAGE_NUMBER.test(text)) {
			throw new FacadeError('INVALID', `${text} is a message, not an agent: name an agent by its number, as #a7, or by its @name.`);
		}
		const numbered = NAMED_NUMBER.exec(text)?.groups ?? NUMBER.exec(text)?.groups;
		if (numbered) {
			const id = Number(numbered.id);
			const agent = this.table.get(id);
			if (!agent) {
				throw new FacadeError('NOT_FOUND', `No agent is #a${id}: ps with all lists every agent this workspace has had.`);
			}
			if (numbered.name !== undefined && numbered.name.toLowerCase() !== agent.name) {
				throw new FacadeError('INVALID', `#a${id} is @${agent.name}, not @${numbered.name}: name it by its number alone, or by its name.`);
			}
			return agent;
		}
		const name = text.replace(/^@/, '').toLowerCase();
		if (name === PERSON.name) {
			throw new FacadeError('REFUSED', `@${name} is the person, whom no agent ends.`);
		}
		let named = this.table.liveNamed(name);
		if (named.length > 1 && within && named.some(within)) {
			named = named.filter(within);
		}
		if (named.length > 1) {
			throw new FacadeError('INVALID', `${named.length} running agents are called @${name}: ${named.map(describe).join(', ')}. Name one by its number.`);
		}
		if (!named.length) {
			const ended = [...this.table.state.agents.values()].filter(agent => !isLive(agent) && agent.name === name);
			throw new FacadeError('NOT_FOUND', ended.length
				? `No running agent is called @${name}; ${ended.map(describe).join(', ')} ${ended.length === 1 ? 'has' : 'have'} exited: name one by its number.`
				: `No running agent is called @${name}: name an exited one by its number, which ps with all lists.`);
		}
		return named[0];
	}

	/** Whom the caller can kill, for a refusal to name. */
	private childrenOfText(caller: Caller): string {
		const children = this.table.childrenOf(caller.id).map(describe);
		return children.length ? `Your running children: ${children.join(', ')}.` : 'You have no running children.';
	}

	private nameOf(text: string): string {
		try {
			return agentName(text);
		} catch (err) {
			throw new FacadeError('INVALID', messageOf(err));
		}
	}

	/** The name of the worktree `folder` is: `main`, its branch, or the folder's own name outside a repository. */
	private async worktreeOf(folder: string): Promise<string> {
		return (await this.ports.git.repositoryOf(folder))?.worktree ?? path.basename(folder);
	}

	/** A CLI Facade knows, by its id. */
	private cliOf(id: string): AgentCli | undefined {
		return this.options.clis.known.find(cli => cli.id === id);
	}

	/** How long the core waits, as the person sets it now. */
	private timing(): Timing {
		return this.options.timing?.() ?? { startTimeoutMs: START_TIMEOUT_MS };
	}

	/** The name of the terminal an agent runs in: unique per agent, and the same after a reload. */
	private terminalOf(agent: Agent): string {
		return `@${agent.name} #${agent.id} · ${this.cliName(agent.cli)}`;
	}

	private liveAgents(): LiveAgent[] {
		return [...this.table.state.agents.values()].filter(isLive);
	}

	private log(message: string): void {
		this.options.log(message);
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
	}
}

/** An agent or the person, as Facade's messages name them: `@name #a7`, or the person by their name. */
function messageText(who: Caller): string {
	return who.id === undefined ? `@${who.name}` : agentText({ id: who.id, name: who.name });
}
