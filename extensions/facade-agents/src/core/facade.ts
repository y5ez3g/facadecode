/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isEqualPath } from '../base/files';
import { withFileLock } from '../base/lock';
import { isProcessRunning } from '../base/system';
import { AgentCli, capabilitiesOf, CliConfig, Environment, InstalledCli, Sandbox } from '../clis/cli';
import { whyNotInstalled } from '../clis/config';
import { TrustedFolder, writeTrust } from '../clis/trust';
import { agentName, AgentTable } from '../record/agents';
import { Agent, agentRef, AgentState, Caller, describe, End, EndKind, Ignored, isLive, LiveAgent, parseAgentReference, PERSON, StoppedBy, TaskDelivery } from '../record/events';
import { isLedgerHeld } from '../record/ledger';
import { injectedFile } from '../record/paths';
import { FacadeError } from './errors';
import { InjectionUser, Injections } from './injections';
import { Launcher, START_TIMEOUT_MS } from './launch';
import { AgentSetup, CliCatalog, Disposable, Ports, Repository, TerminalEnd, Timing } from './ports';

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
	/** Its task, if it is given one: kept as a message, whose notice reaches it. */
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
	readonly folder: string;
	readonly state: AgentState;
	readonly startTime: number;
	readonly taskMessage?: number;
	readonly task: TaskDelivery;
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

/**
 * Where a child starts: a folder there is - with the main checkout of its repository, or the folder itself
 * outside any, which its CLI is given trust in - or a worktree to make.
 */
type Place =
	| { readonly kind: 'folder'; readonly folder: string; readonly worktree: string; readonly main: string }
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
	/** The worktrees being deleted: no agent starts in one meanwhile. */
	private readonly deleting = new Set<string>();
	/** When the folders a process had in use are tried again, while some are. */
	private takingBack: ReturnType<typeof setTimeout> | undefined;
	private takeBackTriesLeft = 0;
	private disposed = false;

	constructor(private readonly options: FacadeOptions) {
		this.table = options.table;
		this.ports = options.ports;
		this.injections = new Injections(options.injected ?? injectedFile(), message => this.log(message), text => this.ports.person.tell(text, undefined), user => this.mayRun(user));
		this.launcher = new Launcher({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			injections: this.injections,
			...(options.timing ? { timing: options.timing } : {}),
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

	/** A CLI's name for people, by its id: a custom agent's is its name. */
	cliName(id: string): string {
		return this.cliOf(id)?.cli.displayName ?? id;
	}

	/** Whether the agent framework is on: Facade's tools answer only while it is. */
	frameworkOn(): boolean {
		return this.options.clis.framework();
	}

	/** The agents an agent can start: the built-ins this machine has and the person offers, then the person's custom agents, each with what its launch takes. */
	startable(): readonly StartableCli[] {
		const each = (cli: AgentCli, config: CliConfig): StartableCli => ({ id: cli.id, displayName: cli.displayName, custom: !!cli.custom, ...capabilitiesOf(cli, config) });
		return [
			...this.options.clis.installed().map(({ cli, config }) => each(cli, config)),
			...this.options.clis.custom().filter(({ config }) => !config.wrong).map(({ cli, config }) => each(cli, config))
		];
	}

	/**
	 * An agent's MCP server said hello to Facade: it is connected, and one told of its task in its terminal
	 * is told now; then it is running.
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
	 * Starts the agent the person chose from the agent menu or Start Agent: in `folder`, the one on screen,
	 * named after its CLI's id or the custom agent's name, given no model, effort or task, its YOLO the
	 * setting's (AGENT-LAUNCHER.md, L3). Its terminal comes up in front, focused; the call answers once it
	 * runs, the agent starting until it connects. A start refused leaves nothing behind.
	 */
	async startForPerson(cli: string, folder: string): Promise<AgentFacts> {
		const { installed, config } = await this.startableHere(cli, folder);
		const yolo = this.yolo(PERSON);
		const integration = this.options.clis.framework() && capabilitiesOf(installed.cli, config).integration;
		const name = this.nameOf(installed.cli.id);
		const repository = await this.ports.git.repositoryOf(folder);
		const worktree = repository?.worktree ?? path.basename(folder);
		const env = await this.environmentOf(installed, folder);
		this.stillOpen();
		const files = this.launcher.check(installed, { folder, yolo, integration, ignored: [] }, env);
		this.launcher.checkFiles(installed, files, folder);
		this.stillOpen();
		this.trust(installed, { folder, repository: repository?.main ?? folder }, env);
		const { agent } = await this.launcher.launch(PERSON, installed, { name, ignored: [], worktree, folder, yolo, integration }, { wait: false });
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
	async startAgent(caller: Caller, request: StartRequest, progress?: (message: string) => void): Promise<Started> {
		this.stillOpen();
		// The person's settings are read once, as the call is accepted: a change applies to the next start.
		const yolo = this.yolo(caller);
		const name = this.nameOf(request.name);
		const model = request.model?.trim() || undefined;
		const effort = request.effort?.trim() || undefined;
		const task = request.task?.trim() ? request.task : undefined;
		// Everything that can refuse the call is asked before anything is made for it.
		const place = await this.placeOf(caller, request.folder, request.newWorktree === true, name);
		const home = place.kind === 'new' ? place.repository.main : place.folder;
		const { installed, config } = await this.startableHere(request.cli, home);
		const capabilities = capabilitiesOf(installed.cli, config);
		const integration = this.options.clis.framework() && capabilities.integration;
		if (task !== undefined && !(integration && capabilities.task)) {
			throw new FacadeError('REFUSED', installed.cli.custom
				? `${installed.cli.id} cannot be given a task: its launch in ${installed.cli.setting}.launch has ${capabilities.integration ? 'no task group' : 'no connect group, so it cannot read Facade\'s messages'}. Start it without a task, or ask the person to fill that in.`
				: `${installed.cli.displayName} cannot be given a task while the agent framework is off.`);
		}
		const ignored: Ignored[] = [...model !== undefined && !capabilities.model ? ['model' as const] : [], ...effort !== undefined && !capabilities.effort ? ['effort' as const] : []];
		const env = await this.environmentOf(installed, home);
		this.stillOpen();
		// Recorded as asked for; given to the CLI only where its launch has a group for it.
		const run = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ignored, task, folder: home, yolo, integration };
		const files = this.launcher.check(installed, run, env);
		this.launcher.checkFiles(installed, files, place.kind === 'new' ? undefined : place.folder);
		this.stillOpen();

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

		// Wherever it starts, the CLI is given the person's trust in its folder's repository - or in the folder,
		// outside any - so that it does not stop to ask.
		try {
			this.trust(installed, { folder, repository: place.kind === 'new' ? place.repository.main : place.main }, env);
		} catch (err) {
			throw new FacadeError('FAILED', `${messageOf(err)}${place.kind === 'new' ? ` The worktree ${worktree} was made, at ${folder}: start the child there by its folder once that is put right.` : ''}`);
		}
		const { agent, status, why } = await this.launcher.launch(caller, installed, { ...run, name, worktree, folder }, { wait: true, ...(progress ? { progress } : {}) });
		return { status, ...(why !== undefined ? { why } : {}), ...this.factsOf(agent), newWorktree: place.kind === 'new' };
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
			.map(agent => this.factsOf(agent));
		return { ...(self ? { yolo: self.yolo } : {}), agents, clis: this.startable() };
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

		// A main checkout, or a folder outside git, is never deleted: the agent alone is stopped.
		const folder = agent.folder;
		const repository = await this.ports.git.repositoryOf(folder);
		if (!repository || isEqualPath(repository.main, folder)) {
			if (!alreadyEnded) {
				await this.stopOne(agent, by, 'with stop_agent');
			}
			const now = this.factsOf(this.table.get(agent.id) ?? agent);
			return { agent: now, alreadyEnded, stopped: alreadyEnded ? [] : [now], worktree: { folder, deleted: false, why: repository ? 'it is its repository\'s main checkout, which is never deleted' : 'it is in no git repository: there is no worktree to delete' } };
		}
		const inside = this.liveAgents().filter(each => isEqualPath(each.folder, folder));
		const outOfReach = inside.filter(each => !this.reaches(caller, each));
		if (outOfReach.length) {
			throw new FacadeError('REFUSED', `${folder} has ${outOfReach.map(describe).join(', ')} in it, outside your tree: your YOLO is off, and you reach only your own tree. Nothing was stopped.`);
		}
		const changes = await this.changesIn(folder);
		if (changes && !options.discardChanges) {
			throw new FacadeError('REFUSED', `${folder} has work that deleting it would lose: ${changes}. Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`);
		}
		this.deleting.add(folder);
		try {
			const results = await Promise.allSettled(inside.map(each => this.stopOne(each, by, 'with stop_agent, its worktree being deleted')));
			const pending = results.some(result => result.status === 'rejected');
			const stopped = inside.map(each => this.factsOf(this.table.get(each.id) ?? each));
			if (pending) {
				throw new FacadeError('UNAVAILABLE', `Not every agent in ${folder} has ended yet, so it was not deleted: ${stopped.filter(each => each.state !== 'ended').map(each => describe(each)).join(', ')} ${stopped.filter(each => each.state !== 'ended').length === 1 ? 'is' : 'are'} still stopping. Call stop_agent with delete_worktree again once it has ended.`, { outcome: 'pending', agent: agent.id });
			}
			this.stillOpen();
			try {
				await this.ports.git.deleteWorktree(folder);
			} catch (err) {
				return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped, worktree: { folder, deleted: false, why: messageOf(err) } };
			}
			this.table.forgetWorktree(folder);
			this.log(`${folder} was deleted with stop_agent by ${this.whoIs(by)}.`);
			return { agent: this.factsOf(this.table.get(agent.id) ?? agent), alreadyEnded, stopped, worktree: { folder, deleted: true } };
		} finally {
			this.deleting.delete(folder);
		}
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
					if (agent.state === 'stopping') {
						// Set out to be stopped before the reload: stopped again.
						this.background(`Stopping ${describe(agent)} again`, this.stopOne(agent, agent.stopping?.by, agent.stopping?.reason ?? 'with stop_agent'));
					} else {
						this.launcher.resume(agent);
					}
				} else {
					gone.push(agent);
				}
			} catch (err) {
				this.log(`Coming back to ${describe(agent)} failed: ${messageOf(err)}`);
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
			if (agent.state === 'stopping') {
				this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}) });
			} else if (closedByThePerson) {
				this.ended(agent, 'stopped', 'its window went', { quiet: true });
			} else {
				this.ended(agent, agent.state === 'starting' ? 'failed' : 'lost', 'its terminal was gone when Facade came back', { quiet: true });
			}
		}
		// What was put into folders for agents that ended while no window was there to see it.
		if (this.sweep()) {
			this.takeBackLater();
		}
		// A start of the window that is no reload - nor this window's extension host starting again - begins
		// a new list: the agents that ended leave it, and the log keeps them.
		if (!reloaded && !last?.thisWindow && [...this.table.state.agents.values()].some(agent => !isLive(agent))) {
			this.table.clearList();
		}
	}

	/**
	 * Stops one agent, as closing its tab does: Facade records that it set out to stop it - by whom, and why -
	 * ends its process, or its start if it has no process yet, and records its end once its process has ended.
	 * A stop of one stopping already joins it. Rejects, the agent left stopping, where its process has not
	 * ended within the timeout.
	 */
	private async stopOne(agent: Agent, by: StoppedBy | undefined, reason: string): Promise<void> {
		if (!isLive(this.table.get(agent.id))) {
			return;
		}
		this.table.stopping(agent.id, reason, by);
		this.launcher.ended(agent.id, `it was stopped ${reason}`);
		const ms = this.timing().startTimeoutMs;
		const deadline = Date.now() + ms;
		for (; ;) {
			try {
				await this.ports.terminals.stop(agent.id);
				break;
			} catch (err) {
				if (Date.now() >= deadline || this.disposed) {
					this.log(`${describe(agent)} has not ended yet: ${messageOf(err)}`);
					throw new FacadeError('UNAVAILABLE', `${describe(agent)} is still stopping: its process has not ended within ${Math.round(ms / 1000)} seconds. Facade goes on stopping it; list_agents shows when it has ended.`, { outcome: 'pending', agent: agent.id });
				}
				await timeout(500);
			}
		}
		const now = this.table.get(agent.id);
		if (isLive(now)) {
			this.ended(now, 'stopped', reason, { ...(by !== undefined ? { by } : {}) });
		}
	}

	/** What deleting `folder` would lose, as a refusal names it - besides what Facade put there and nobody changed; undefined where nothing would be lost. */
	private async changesIn(folder: string): Promise<string | undefined> {
		const changes = await this.ports.git.changesIn(folder);
		let owned: readonly string[] = [];
		try {
			owned = this.injections.ownedUnchanged(folder);
		} catch (err) {
			this.log(`What Facade put into ${folder} could not be read: ${messageOf(err)}`);
		}
		const files = changes.files.filter(file => !owned.includes(file));
		if (!files.length && !changes.unsaved.length) {
			return undefined;
		}
		const named = (list: readonly string[]) => list.length > SHOWN_CHANGES ? `${list.slice(0, SHOWN_CHANGES).join(', ')} and ${list.length - SHOWN_CHANGES} more` : list.join(', ');
		return [
			...files.length ? [`${files.length} uncommitted or untracked ${files.length === 1 ? 'file' : 'files'} (${named(files)})`] : [],
			...changes.unsaved.length ? [`${changes.unsaved.length} unsaved ${changes.unsaved.length === 1 ? 'editor' : 'editors'} (${named(changes.unsaved)})`] : []
		].join(' and ');
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
		if ([...this.deleting].some(each => isEqualPath(each, folder))) {
			throw new FacadeError('REFUSED', `${folder} is being deleted: no agent starts there.`);
		}
		const repository = await this.ports.git.repositoryOf(folder);
		if (!newWorktree) {
			return { kind: 'folder', folder, worktree: repository?.worktree ?? path.basename(folder), main: repository?.main ?? folder };
		}
		if (!repository) {
			throw new FacadeError('REFUSED', `${folder} is in no git repository, so no worktree of it can be made: start the child in the folder itself, without new_worktree.`);
		}
		// At the caller's commit in its own repository; in another - and for the person - at its main checkout's.
		const ownRepository = own === undefined ? undefined : await this.ports.git.repositoryOf(own);
		const from = ownRepository && isEqualPath(ownRepository.main, repository.main) ? { folder: own, head: ownRepository.head } : { folder: repository.main, head: (await this.ports.git.repositoryOf(repository.main))?.head };
		if (from.head === undefined) {
			throw new FacadeError('REFUSED', `${from.folder} has no commit for a new worktree to start at: it is on a branch with no commit yet, or one git cannot read.`);
		}
		const notABranch = await this.ports.git.whyNotBranchName(repository.main, name);
		if (notABranch !== undefined) {
			throw new FacadeError('REFUSED', `${name} cannot be the branch of a new worktree: ${notABranch}. Give the child another name.`);
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
			throw new FacadeError('INVALID', `${branch} is no absolute path, and ${own === undefined ? 'the person has no folder on screen' : `${own} is in no repository`} for it to be a branch of. Name a folder of the window by its absolute path.`);
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
	 * An agent's process ended: the agent ended, unless it had already. One Facade set out to stop was
	 * stopped, by whom it says; closed with its tab by the person, it was stopped by them; else its CLI ended
	 * by itself - with its exit code, where it is known - or it did not start.
	 */
	private terminalEnded(id: number, end: TerminalEnd): void {
		const agent = this.liveAgents().find(each => each.id === id);
		if (!agent) {
			return;
		}
		try {
			if (agent.state === 'stopping') {
				this.ended(agent, 'stopped', agent.stopping?.reason ?? 'with stop_agent', { ...(agent.stopping?.by !== undefined ? { by: agent.stopping.by } : {}) });
			} else if (end.byThePerson) {
				this.ended(agent, 'stopped', 'its tab was closed', { by: 'human' });
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
	private ended(agent: Agent, kind: EndKind, reason: string, details: { readonly by?: StoppedBy; readonly exitCode?: number; readonly quiet?: boolean } = {}): End | undefined {
		if (this.disposed) {
			return undefined;
		}
		const waiter = this.launcher.waiterOf(agent.id);
		const end = this.table.end(agent.id, kind, reason, { ...(details.by !== undefined ? { by: details.by } : {}), ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}) });
		if (!end) {
			return undefined;
		}
		this.log(`${describe(agent)} ended (${kind}): ${reason}`);
		this.launcher.ended(agent.id, reason);
		this.withdraw(agent);
		// A start that waits for it says how it failed itself; what the person did is no news to them.
		const unexpected = (kind === 'exited' && details.exitCode !== 0 && details.exitCode !== INTERRUPTED)
			|| (kind === 'stopped' && typeof details.by === 'number')
			|| (kind === 'failed' && waiter === undefined);
		if (agent.creator === undefined && !details.quiet && unexpected) {
			this.ports.person.tell(endNotice(agent, end, this.table.whoIs(end.by)), agent.id);
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
	 * The agent `id` names - a built-in by its id, or a custom agent by its name - as the person has Facade
	 * start it, found as a terminal in `folder` would find it. Refused, saying why and what can be started:
	 * one turned off, one not on this machine, and one whose settings are wrong.
	 */
	private async startableHere(id: string, folder: string): Promise<{ readonly installed: InstalledCli; readonly config: CliConfig }> {
		const found = this.cliOf(id);
		const startable = () => this.startable().map(each => each.id).join(', ') || 'none';
		if (!found) {
			throw new FacadeError('NOT_FOUND', `${id} is neither a CLI Facade starts nor a custom agent of the person's. It starts: ${startable()}.`);
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
		const installed = this.options.clis.locate(cli, config, env);
		if (!installed) {
			throw new FacadeError('UNAVAILABLE', `Facade cannot start ${cli.displayName} in ${folder}: ${whyNotInstalled(cli, config, 'the PATH a terminal there has')}.`);
		}
		return { installed, config };
	}

	/** A built-in by its id, or a custom agent by its name, as the person has Facade start it now. */
	private cliOf(id: string): { readonly cli: AgentCli; readonly config: CliConfig } | undefined {
		const builtIn = this.options.clis.known.find(cli => cli.id === id);
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
			throw new FacadeError('REFUSED', `${describe(agent)} is outside your tree: your YOLO is off, and you reach only your own tree - the agents that come from the agent the person started that you come from.`);
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
			if (reference.name !== undefined && reference.name !== agent.name) {
				throw new FacadeError('INVALID', `${agentRef(agent.id)} is @${agent.name}, not @${reference.name}: name it by its number alone, or by its name.`);
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
			connected: agent.connected,
			worktree: agent.worktree,
			folder: agent.folder,
			state: agent.state,
			startTime: agent.startTime,
			...(agent.taskMessage !== undefined ? { taskMessage: agent.taskMessage } : {}),
			task: agent.task,
			...(agent.end ? { end: agent.end } : {})
		};
	}

	private liveAgents(): LiveAgent[] {
		return [...this.table.state.agents.values()].filter(isLive);
	}

	/** How long the core waits, as the person sets it now. */
	private timing(): Timing {
		return this.options.timing?.() ?? { startTimeoutMs: START_TIMEOUT_MS };
	}

	/** Runs `work` on its own: should it fail, the log says what failed and why. */
	private background(what: string, work: Promise<unknown>): void {
		work.catch(err => this.log(`${what} failed: ${messageOf(err)}`));
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

/** A sandbox as Facade's words say it. */
export function sandboxText(sandbox: Sandbox): string {
	return sandbox === 'unavailable' ? 'no sandbox' : sandbox === 'unknown' ? 'sandbox unknown' : `sandbox ${sandbox}`;
}

/** What the person is told of an agent of theirs that ended unexpectedly: who, how, and why. */
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
