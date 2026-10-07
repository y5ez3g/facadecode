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
import { agentName, AgentTable } from '../record/agents';
import { Agent, agentRef, AgentState, Caller, describe, End, EndKind, isLive, LiveAgent, MadeWorktree, parseAgentReference, PERSON, StoppedBy, TaskDelivery } from '../record/events';
import { injectedFile } from '../record/paths';
import { FacadeError } from './errors';
import { Injections } from './injections';
import { Launcher } from './launch';
import { AgentSetup, CliCatalog, Disposable, Ports, Repository, TerminalEnd, Timing } from './ports';

/**
 * How often, and how many times, the folders Facade made that a process of an ended agent still had
 * in use are tried again: three minutes, past the two an MCP server of Facade's waits for its window
 * where the person sets nothing else. The next window to start tries too.
 */
const TAKE_BACK_AGAIN_MS = 15_000;
const TAKE_BACK_TRIES = 12;

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

/** What a caller asks `start_agent` for: the child's name, the CLI, its model and how hard it thinks, its task, and where it works. */
export interface StartRequest {
	/** Its name: a label, and with `newWorktree` its branch too. */
	readonly name: string;
	/** The CLI, by its id. */
	readonly cli: string;
	/** The model and the effort as the CLI takes them: Facade passes them on as they are, and no CLI checks them as it starts. */
	readonly model: string;
	readonly effort: string;
	/** Its task, if it is given one. */
	readonly task?: string;
	/**
	 * Where it works: a folder of the window, by its absolute path, or a worktree of the caller's own
	 * repository, by the branch checked out in it. Omitted: the caller's own folder, which the person has none of.
	 */
	readonly folder?: string;
	/** Whether it works in a new worktree of that folder's repository, on a new branch called `name`. */
	readonly newWorktree?: boolean;
}

/** What `start_agent` answers with: whether the child has started, who it is, and where it works. */
export interface Started {
	/** `started` (2.1.8); `unconfirmed` while it has not, the timeout over - it stays starting, and may start yet. */
	readonly status: 'started' | 'unconfirmed';
	/** Why its start is not confirmed, where it is not. */
	readonly why?: string;
	readonly id: number;
	readonly name: string;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	/** Whether its worktree was made for it, on the new branch `worktree`. */
	readonly newWorktree: boolean;
	/** How its task reached it. */
	readonly task: TaskDelivery;
}

/** A folder of the window an agent can start in, and the worktree it is. */
export interface WindowFolder {
	readonly folder: string;
	readonly worktree: string;
}

/** One line of `list_agents`: an agent as it is now. */
export interface AgentRow {
	readonly id: number;
	/** The agent that started it; none for the person. */
	readonly creator?: number;
	readonly name: string;
	readonly state: AgentState;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	readonly startTime: number;
	readonly task: TaskDelivery;
	readonly end?: End;
}

/** What `stop_agent` answers with: the agent, and how it ended. */
export interface Stopped {
	readonly id: number;
	readonly name: string;
	/** Whether it had ended before the call: then its end says how. */
	readonly alreadyEnded: boolean;
	readonly end: End;
}

/** Where a child starts: a folder there is, or a worktree to make. */
type Place =
	| { readonly kind: 'folder'; readonly folder: string; readonly worktree: string }
	| { readonly kind: 'new'; readonly repository: Repository; readonly head: string; readonly branch: string };

/**
 * Facade, the kernel of AGENT-FRAMEWORK.md: it starts agents, keeps their list, and stops them. An agent
 * has a number no other gets, a creator that never changes - the person, who has no number, or another
 * agent - and the agents it started. Facade knows what it did and what is certain - an agent started, its
 * MCP server said hello, its terminal ended - and never what an agent is doing: whether it works or waits
 * is its creator's to find out. Every caller comes through here - the contract
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
	/** When the folders a process had in use are tried again, while some are. */
	private takingBack: ReturnType<typeof setTimeout> | undefined;
	private takeBackTriesLeft = 0;
	private disposed = false;

	constructor(private readonly options: FacadeOptions) {
		this.table = options.table;
		this.ports = options.ports;
		this.injections = new Injections(options.injected ?? injectedFile(), this.table.dir, message => this.log(message), text => this.ports.person.tell(text, undefined));
		this.launcher = new Launcher({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			injections: this.injections,
			...(options.timing ? { timing: options.timing } : {}),
			terminalOf: agent => this.terminalOf(agent),
			fail: (agent, reason) => this.fail(agent, reason),
			log: message => this.log(message)
		});
		this.disposables.push(this.launcher, this.ports.terminals.onDidEnd((id, end) => this.terminalEnded(id, end)));
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
			const repository = await this.ports.git.repositoryOf(folder);
			add(folder, repository?.worktree ?? path.basename(folder));
			for (const listed of repository ? await this.ports.git.worktreesOf(repository.main) : []) {
				add(listed.folder, listed.name);
			}
		}
		return found;
	}

	/**
	 * Starts a child of the caller called `name`, in its own UI: in a folder of the window - the caller's own
	 * where none is named - or in a new worktree of that folder's repository, on a new branch named after the
	 * child, at the caller's commit in its own repository and at the main checkout's in another. A start
	 * refused leaves nothing behind. Answers once the child has started, or once the timeout runs out with it
	 * starting still - left as it is, for the caller to decide; a child whose process ends before it started
	 * fails the call. Once begun, a start is carried through: a caller that ends meanwhile leaves its child as
	 * it is. Its model and effort go to its CLI as they are: the CLI is the one that knows which it has.
	 */
	async startAgent(caller: Caller, request: StartRequest, progress?: (message: string) => void): Promise<Started> {
		const installed = this.installed(request.cli);
		const { displayName } = installed.cli;
		const name = this.nameOf(request.name);
		const model = request.model.trim();
		if (!model) {
			throw new FacadeError('INVALID', `model is required: one of ${displayName}'s models, as ${displayName} takes it.`);
		}
		const effort = request.effort.trim();
		if (!effort) {
			throw new FacadeError('INVALID', `effort is required: how hard the child thinks, as ${displayName} takes it - low, medium, high and so on.`);
		}
		// Everything that can refuse the call is asked before anything is made for it.
		const place = await this.placeOf(caller, request.folder, request.newWorktree === true, name);
		const home = place.kind === 'new' ? place.repository.main : place.folder;
		const env = await this.environmentOf(installed, home);
		this.stillOpen();
		this.launcher.check(installed, model, effort, home, request.task, env);

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
			this.table.recordWorktree({ name: worktree, folder, repository: place.repository.main, commit: place.head, ...(caller.id !== undefined ? { madeBy: caller.id } : {}) });
		} else {
			({ folder, worktree } = place);
		}

		// In a worktree Facade made, the CLI is given the person's trust in it, so that it does not stop to ask.
		const made = this.table.madeWorktree(folder);
		if (made) {
			this.trust(installed, made, env);
		}
		const { agent, status, why } = await this.launcher.launch(caller, installed, { name, model, effort, task: request.task, worktree, folder, trusted: !!made }, progress);
		return { status, ...(why !== undefined ? { why } : {}), id: agent.id, name: agent.name, cli: agent.cli, model: agent.model, effort, worktree: agent.worktree, folder: agent.folder, newWorktree: place.kind === 'new', task: agent.task };
	}

	/**
	 * The agents as the caller sees them: itself, its creator, and the agents it started, ended ones too;
	 * with `all`, every agent of the list. By number.
	 */
	listAgents(caller: Caller, all = false): AgentRow[] {
		const creator = this.agentOf(caller)?.creator;
		return [...this.table.state.agents.values()]
			.filter(agent => all
				|| agent.id === caller.id
				|| (creator !== undefined && agent.id === creator)
				|| agent.creator === caller.id)
			.sort((a, b) => a.id - b.id)
			.map(agent => ({
				id: agent.id,
				...(agent.creator !== undefined ? { creator: agent.creator } : {}),
				name: agent.name,
				state: agent.state,
				cli: agent.cli,
				model: agent.model,
				effort: agent.effort,
				worktree: agent.worktree,
				folder: agent.folder,
				startTime: agent.startTime,
				task: agent.task,
				...(agent.end ? { end: agent.end } : {})
			}));
	}

	/**
	 * Stops one of the caller's children: its CLI ends and its terminal closes; its folder stays as it is.
	 * The agents it started run on. The person stops any agent.
	 */
	async stopAgent(caller: Caller, target: string): Promise<Stopped> {
		this.stillOpen();
		const agent = this.agentNamed(target);
		if (caller.id !== undefined && agent.creator !== caller.id) {
			throw new FacadeError('REFUSED', `${describe(agent)} is not your child: an agent stops only its own children, and @human any. ${this.childrenOfText(caller)}`);
		}
		if (agent.end) {
			return { id: agent.id, name: agent.name, alreadyEnded: true, end: agent.end };
		}
		const end = this.ended(agent, 'stopped', 'with stop_agent', { by: caller.id ?? 'human' });
		// Only a window that closed records nothing for an agent that has not ended.
		if (!end) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
		// Recorded as stopped already: a terminal that would not close is the log's to say, not the call's.
		try {
			await this.ports.terminals.stop(agent.id);
		} catch (err) {
			this.log(`${this.terminalOf(agent)} could not be closed: ${messageOf(err)}`);
		}
		return { id: agent.id, name: agent.name, alreadyEnded: false, end };
	}

	/**
	 * As Facade comes back - after a reload, a restart, or turned on again - an agent whose terminal is
	 * gone has ended. When the window before was closed - the person quit Facade, closed the window, or
	 * opened another workspace in it - and none of its agents came back, they went with it: stopped as the
	 * window went, without a word to the person. After a reload, while Facade was off, after a crash, or
	 * beside others that came back, nothing saw one gone end: it is lost, or failed, if it had not started.
	 * One that was starting is waited for again, its MCP server's hello coming to this window; one whose
	 * task was not yet typed is told it now. What windows that closed left in folders is taken back, and a
	 * start of the window that is no reload begins a new list.
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
		const gone: LiveAgent[] = [];
		let cameBack = false;
		for (const agent of this.liveAgents()) {
			// One whose terminal the window does not answer for keeps neither the others nor Facade from coming back.
			try {
				if (await this.ports.terminals.isAlive(agent.id)) {
					cameBack = true;
					this.launcher.resume(agent);
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
		for (const agent of gone) {
			if (closedByThePerson) {
				this.ended(agent, 'stopped', 'its window went', { quiet: true });
			} else {
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', 'its terminal was gone when Facade came back');
			}
		}
		// What was put into a folder whose agents ended while no window was there to see it.
		for (const folder of this.injections.held()) {
			this.withdraw(folder);
		}
		// A start of the window that is no reload - nor this window's extension host starting again - begins
		// a new list: the agents that ended leave it, and the log keeps them.
		if (!reloaded && !last?.thisWindow && [...this.table.state.agents.values()].some(agent => !isLive(agent))) {
			this.table.clearList();
		}
	}

	/**
	 * Where a child of the caller starts: a folder of the window - by its absolute path, or in the caller's own
	 * repository by the branch checked out there - the caller's own folder where none is named, or a new
	 * worktree of that folder's repository on the branch `name`. Refused before anything is made: what names
	 * no folder of the window, a branch checked out in two worktrees, and a new worktree outside any repository,
	 * on a branch that is there, or with no commit to start at.
	 */
	private async placeOf(caller: Caller, named: string | undefined, newWorktree: boolean, name: string): Promise<Place> {
		const own = this.agentOf(caller)?.folder;
		const wanted = named?.trim();
		const folder = !wanted ? own : path.isAbsolute(wanted) ? await this.windowFolderAt(wanted) : await this.worktreeOnBranch(own, wanted);
		if (folder === undefined) {
			throw new FacadeError('INVALID', 'folder is required: the person has no folder of their own. Name a folder of the window by its absolute path.');
		}
		if (!newWorktree) {
			return { kind: 'folder', folder, worktree: await this.worktreeOf(folder) };
		}
		const repository = await this.ports.git.repositoryOf(folder);
		if (!repository) {
			throw new FacadeError('REFUSED', `${folder} is in no git repository, so no worktree of it can be made: start the child in the folder itself, without new_worktree.`);
		}
		// At the caller's commit in its own repository; in another - and for the person - at its main checkout's.
		const ownRepository = own === undefined ? undefined : await this.ports.git.repositoryOf(own);
		const from = ownRepository && isEqualPath(ownRepository.main, repository.main) ? { folder: own, head: ownRepository.head } : { folder: repository.main, head: (await this.ports.git.repositoryOf(repository.main))?.head };
		if (from.head === undefined) {
			throw new FacadeError('REFUSED', `${from.folder} has no commit for a new worktree to start at: it is on a branch with no commit yet, or one git cannot read.`);
		}
		if (await this.ports.git.hasBranch(repository.main, name)) {
			throw new FacadeError('REFUSED', `${path.basename(repository.main)} has a branch called ${name} already, and a new worktree is on a new branch, named after the child: give the child another name, or start it in the worktree of ${name} by its folder.`);
		}
		return { kind: 'new', repository, head: from.head, branch: name };
	}

	/** The folder of the window that is `folder`; refused, naming the window's folders, where none is. */
	private async windowFolderAt(folder: string): Promise<string> {
		const folders = await this.windowFolders();
		const found = folders.find(each => isEqualPath(each.folder, folder));
		if (!found) {
			throw new FacadeError('NOT_FOUND', `${folder} is no folder of this window. Its folders: ${folders.map(each => each.folder).join(', ')}.`);
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
			throw new FacadeError('INVALID', `${branch} is no absolute path, and ${own === undefined ? 'the person has no repository of their own' : `${own} is in no repository`} for it to be a branch of. Name a folder of the window by its absolute path.`);
		}
		const listed = await this.ports.git.worktreesOf(repository.main);
		const on = listed.filter(each => each.branch === branch);
		if (on.length > 1) {
			throw new FacadeError('INVALID', `${branch} is checked out in ${on.length} worktrees of ${path.basename(repository.main)}: ${on.map(each => each.folder).join(', ')}. Name the one you mean by its folder.`);
		}
		if (!on.length) {
			throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} has ${branch} checked out. Its worktrees: ${listed.map(each => `${each.name} at ${each.folder}`).join(', ')}.`);
		}
		return on[0].folder;
	}

	/**
	 * An agent's process ended: the agent ended, unless it had already. Closed with its tab by the person,
	 * it was stopped; else its CLI ended by itself - with its exit code, where it is known - or it did not start.
	 */
	private terminalEnded(id: number, end: TerminalEnd): void {
		const agent = this.liveAgents().find(each => each.id === id);
		if (!agent) {
			return;
		}
		try {
			if (end.byThePerson) {
				this.ended(agent, 'stopped', 'its tab was closed', { by: 'human' });
			} else {
				const reason = end.exitCode === undefined ? 'its terminal closed' : `its CLI ended with exit code ${end.exitCode}`;
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'exited', reason, end.exitCode !== undefined ? { exitCode: end.exitCode } : {});
			}
		} catch (err) {
			this.log(`Recording that ${this.terminalOf(agent)} ended failed: ${messageOf(err)}`);
		}
	}

	/**
	 * Records how an agent ended - once - and takes back what was put into its folder once no agent runs
	 * there. The person hears of an agent they started that ended without their doing; an agent creator
	 * sees it in `list_agents`. The agents it started are not touched. Answers with its end; undefined for
	 * an agent that had ended already, or once the window closed.
	 */
	private ended(agent: Agent, kind: EndKind, reason: string, details: { readonly by?: StoppedBy; readonly exitCode?: number; readonly quiet?: boolean } = {}): End | undefined {
		if (this.disposed) {
			return undefined;
		}
		const waiter = this.launcher.waiterOf(agent.id);
		const end = this.table.end(agent.id, kind, reason, { ...(details.by !== undefined ? { by: details.by } : {}), ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}) });
		if (!end) {
			return undefined;
		}
		this.log(`${this.terminalOf(agent)} ended (${kind}): ${reason}`);
		this.launcher.ended(agent.id, reason);
		this.withdraw(agent.folder);
		// A start of the person's tells them itself; what the person did, or a window that went, is no news to them.
		const startOfThePerson = waiter !== undefined && waiter.id === undefined;
		if (agent.creator === undefined && details.by !== 'human' && !details.quiet && !startOfThePerson) {
			this.ports.person.tell(endNotice(agent, end, this.table.whoIs(end.by)), undefined);
		}
		return end;
	}

	/** Ends an agent whose launch failed before it had a process: recorded as failed, and its terminal closed. */
	private async fail(agent: Agent, reason: string): Promise<void> {
		if (!this.ended(agent, 'failed', reason)) {
			return;
		}
		try {
			await this.ports.terminals.stop(agent.id);
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
	 * Tries again, a while on, to remove the folders Facade made that a process of an ended agent had in
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

	/** The environment a CLI starts with in `folder`: the terminals' there, with what its launch sets in it. */
	private async environmentOf(installed: InstalledCli, folder: string): Promise<Environment> {
		return { ...await this.options.clis.environment(folder), ...installed.config.launch.environment };
	}

	/**
	 * The agent a tool names: by its number, `#a7`, `#7`, `a7` or `7`; by `@name`, where one agent that
	 * has not ended has that name; or as Facade's words name it, `@name #a7`, the number that agent's. A
	 * number of another kind, the person, and a bare number an agent that has not ended is also called
	 * are refused: no agent is named on a guess.
	 */
	private agentNamed(target: string): Agent {
		const reference = parseAgentReference(target);
		if (reference.kind === 'other') {
			throw new FacadeError('INVALID', `${reference.text} is not an agent's number: agents are numbered #a1, #a2 and on.`);
		}
		if (reference.kind === 'number') {
			if (reference.bare) {
				const named = this.table.liveNamed(target.trim().toLowerCase());
				if (named.length) {
					throw new FacadeError('INVALID', `${target.trim()} could be ${agentRef(reference.id)} or the name of ${named.map(describe).join(', ')}: write ${agentRef(reference.id)}, or the name with its number.`);
				}
			}
			const agent = this.table.get(reference.id);
			if (!agent) {
				throw new FacadeError('NOT_FOUND', `No agent is ${agentRef(reference.id)}: list_agents with all lists every agent this workspace has had.`);
			}
			if (reference.name !== undefined && reference.name !== agent.name) {
				throw new FacadeError('INVALID', `${agentRef(agent.id)} is @${agent.name}, not @${reference.name}: name it by its number alone, or by its name.`);
			}
			return agent;
		}
		if (reference.name === PERSON.name) {
			throw new FacadeError('INVALID', `@${reference.name} is the person, not an agent.`);
		}
		const named = this.table.liveNamed(reference.name);
		if (named.length > 1) {
			throw new FacadeError('INVALID', `${named.length} running agents are called @${reference.name}: ${named.map(describe).join(', ')}. Name one by its number.`);
		}
		if (!named.length) {
			throw new FacadeError('NOT_FOUND', `No running agent is called @${reference.name}: name an ended one by its number, which list_agents with all lists.`);
		}
		return named[0];
	}

	/** Whom the caller can stop, for a refusal to name. */
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

	/** The name of the terminal an agent runs in, `@lint #a7 · Codex`: unique per agent, and the same after a reload. */
	private terminalOf(agent: Agent): string {
		return `${describe(agent)} · ${this.cliName(agent.cli)}`;
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

/** What the person is told of an agent of theirs that ended without their doing: who, how, and why. */
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
