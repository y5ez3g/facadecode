/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { disposeAll } from '../base/lifecycle';
import { isJsonObject } from '../base/json';
import { InstalledCli } from '../clis/cli';
import { installedClis, knownClis, locateCli } from '../clis/registry';
import { facadeSkill, firstLineFor } from '../contract/prompts';
import { Contract } from '../contract/tools';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { AgentTable, countOnFrom, numberedUpTo } from '../record/agents';
import { Caller, isLive } from '../record/events';
import { earlierRecordOf, identityOf, isSameWorkspace, isWorkspaceId, recordDirOf, recordFor } from '../record/identity';
import { ClosedBy, LedgerLockedError, LedgerUnreadableError, lockStateOf, lockWait } from '../record/ledger';
import { AGENTS_LOG } from '../record/log';
import { workspacesRoot } from '../record/paths';
import { PipeEndpoint } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { HostGit } from './git';
import { HostPerson } from './person';
import { confirmDeleteRooms, pickRoom } from './rooms';
import { ScreenDocuments } from './screenDocuments';
import { configFor, customAgents, frameworkOn, settingsProblems, timeoutMs, yolo } from './settings';
import { folderOnScreen, OfferedAgent, pickAgent } from './startAgent';
import { agentProcessesRun, HostTerminals, terminalEnvironment } from './terminals';
import { JsonFileState, StateStore } from './windowState';

const PIPE_ID_KEY = 'facade.agents.pipeId';
const WINDOW_STATE_FILE = 'window-state.json';
/** The workspace's id, which names its record: kept in its `workspaceState`, which VS Code carries over as the workspace is saved under another name. */
const WORKSPACE_ID_KEY = 'facade.agents.workspaceId';
/** Where a build before workspace ids kept the path of the workspace's record, in its `workspaceState`. */
const EARLIER_RECORD_KEY = 'facade.agents.record';
/** Who this workspace's window is to its ledger, the same through its reloads: kept in its `workspaceState`. */
const OWNER_KEY = 'facade.agents.owner';
/**
 * When a folder window becomes a workspace, its extension host starts again while the one before can
 * still be letting go of the ledger and the pipe: this long, what it holds is waited for.
 */
const HANDOVER_MS = 10_000;
/**
 * How long the ledger stays open, as the window goes, for the calls under way to record what they did -
 * a worktree git finished making: within the five seconds the extension host gives its extensions to stop.
 */
const CLOSE_WAIT_MS = 3_000;
/** How often what another extension host holds is looked at, while it is waited for. */
const HANDOVER_POLL_MS = 250;

/**
 * Facade's agents, and the one place the layers are put together: the workspace's record under
 * ~/.facade/workspaces, the core with the window as its ports, the contract behind the pipe, and the agents
 * still running after a reload found again. The agent framework's switch, `facade.orchestration.enabled`,
 * takes away only what agents do to agents: off, the tools answer that it is, and new launches get none of
 * its integration, while the person's agents start, run and end as ever (AGENT-LAUNCHER.md, L13).
 */
export class AgentsService implements vscode.Disposable {

	private readonly disposables: { dispose(): void }[] = [];
	private facade: Facade | undefined;
	/** Why there is no core once the service started: another window has the workspace's agents, or no folder is on this machine. */
	private noCore: 'otherWindow' | 'noFolder' | 'unreadable' | undefined;
	private endpoint: PipeEndpoint<Caller> | undefined;
	/** The workspace's record, open in this window. */
	private table: AgentTable | undefined;
	/** Set once the service stopped: as the window goes, as Facade agents are turned off, or as another window took its agents. */
	private stopped = false;
	/** How it stopped first: as the window went, or as Facade let go of its agents. */
	private stoppedBy: ClosedBy | undefined;
	/** The calls under way - an agent's tool call, the person's start - which the ledger stays open for as the service stops. */
	private readonly underWay = new Set<Promise<unknown>>();
	/** Settles once the service stopped and its ledger is closed. */
	private closed: Promise<void> | undefined;

	/** Where Facade's notices go, and the last screens of agents that ended. */
	private person: HostPerson | undefined;

	/**
	 * `workspaceState` keeps the id of the record this workspace's agents are in, as its folders come and go;
	 * `screenDocuments` opens their last screens, as it does with the agent framework off.
	 */
	constructor(private readonly log: vscode.LogOutputChannel, private readonly workspaceState: vscode.Memento, private readonly screenDocuments: ScreenDocuments) { }

	/** The folder of the workspace's record this window has, once it is known: where its `agents.log` is (X-67). */
	private recordDir: string | undefined;

	/** The person's history of this window's agents: its record's `agents.log`; undefined until the record is known. */
	get agentsLog(): string | undefined {
		return this.recordDir !== undefined ? path.join(this.recordDir, AGENTS_LOG) : undefined;
	}

	/**
	 * Opens the workspace's record, listens for its agents, and finds again those still running. Without
	 * a folder on this machine, or while another window has the workspace's agents, there is no core, and
	 * Start Agent says why. Stopped meanwhile, it lets go of what it took and returns.
	 */
	async start(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		if (!folders.length) {
			this.log.info('Facade agents need a folder on this machine in the workspace; nothing started.');
			this.noCore = 'noFolder';
			return;
		}
		// The record this very window had, as the window remembers it, goes first: its extension host started
		// again under it - its folder window became a workspace, it was saved under another name, the extension
		// host was restarted or crashed - and VS Code gave this one the new workspace's storage, which knows
		// nothing of it, while the window's agents run on (AGENT-LAUNCHER.md, L12). Otherwise the record the
		// workspace's storage names, while it names this workspace; any other workspace gets one of its own.
		const load = await windowLoad();
		const fromWindow = load.record;
		const workspace = (vscode.workspace.workspaceFile ?? folders[0].uri).toString();
		const storedId = fromWindow?.id ?? this.workspaceState.get(WORKSPACE_ID_KEY);
		if (isWorkspaceId(storedId)) {
			await this.handedOver(recordDirOf(workspacesRoot(), storedId), workspace);
		}
		const windowsOwn = (kept: string) => (fromWindow !== undefined && kept === recordDirOf(workspacesRoot(), fromWindow.id)) || (load.id !== undefined && lockStateOf(kept).closedIn === load.id);
		const { id, dir, isNew } = recordFor(workspacesRoot(), storedId, workspace, windowsOwn);
		this.recordDir = dir;
		await this.workspaceState.update(WORKSPACE_ID_KEY, id);
		if (isNew) {
			this.log.info(`The workspace ${workspace} has a new record, ${dir}.`);
			// The record a build before workspace ids kept of it: its agents' numbers are never given again
			// (AGENT-LAUNCHER.md, L2; X-49)
			const earlier = earlierRecordOf(workspacesRoot(), this.workspaceState.get(EARLIER_RECORD_KEY), folders[0].uri.fsPath);
			// - nor its messages' (AGENT-MESSAGES.md, M10)
			const reached = earlier === undefined ? undefined : numberedUpTo(earlier);
			if (earlier !== undefined && reached && (reached.agents > 0 || reached.messages > 0)) {
				countOnFrom(dir, reached);
				this.log.info(`${earlier}, the record an earlier build kept of the workspace, numbered its agents up to #a${reached.agents} and its messages up to #m${reached.messages}: this record's go on from #a${reached.agents + 1} and #m${reached.messages + 1}.`);
			}
		}
		// The same window, its extension host started again: who it is to its ledger goes on too, and the
		// agents that ended stay in its list - it is no fresh start.
		const sameWindow = fromWindow?.id === id;
		const owner = sameWindow ? await this.keepOwner(fromWindow.owner) : await this.owner();
		await rememberWindowRecord(id, owner);
		// A ledger Facade cannot read is moved aside only at a start of the window that is no reload, with
		// none of its agents' processes in a terminal of the window: the history is in the log.
		let table: AgentTable | undefined;
		try {
			table = await this.openTable(dir, owner, load.id, () => false).catch(async err => {
				if (err instanceof LedgerUnreadableError && !load.reloaded && !await agentProcessesRun(id)) {
					// Reported, not dropped quietly: only a last line a crash cut short is (L12; N-31)
					return this.openTable(dir, owner, load.id, () => true, (why, keptAs) => {
						const history = path.join(dir, AGENTS_LOG);
						this.log.error(`${why}. It is kept as ${keptAs}, and a new list of agents begins; agents.log keeps their history, and their numbers go on.`);
						// What happened, and what the person is to do about it - nothing, but where to look (L12; N-31)
						void vscode.window.showErrorMessage(vscode.l10n.t("Facade could not read this workspace's record of its agents ({0}), so it began a new list. Nothing needs doing: agents start as before, and their numbers go on. Their history is in {1}; the unreadable record is kept as {2} - delete it once you no longer need it.", why, history, keptAs));
					});
				}
				throw err;
			});
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				// One actionable error (L12; N-32): where the agents are, and how to have them here instead
				void vscode.window.showErrorMessage(vscode.l10n.t("Another Facade window has this workspace's agents, and keeps them. Use that window; or close it, then reload this one to have them here."));
				this.noCore = 'otherWindow';
				return;
			}
			if (err instanceof LedgerUnreadableError) {
				this.log.error(err.message);
				void vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's record: {0}", err.message));
				this.noCore = 'unreadable';
				return;
			}
			throw err;
		}
		if (!table) {
			return;
		}
		// Closed last, saying how Facade stopped
		this.table = table;
		if (this.stopped) {
			this.dispose();
			return;
		}

		// The pipe's id, next to the ledger rather than in the workspace storage, which a folder window
		// becoming a workspace replaces while agents keep running.
		const windowState = new JsonFileState(path.join(dir, WINDOW_STATE_FILE));
		const terminals = new HostTerminals(id, message => this.say(message));
		this.disposables.push(terminals);

		// The CLIs this machine has, as a terminal finds them: Facade's own PATH until they are looked for there (X-39)
		let installedNow = installedClis(configFor);
		const facade = new Facade({
			table,
			ports: {
				terminals,
				git: new HostGit(id),
				workspace: {
					folders: () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
					activeFolder: folderOnScreen
				},
				person: this.person = new HostPerson(terminals, this.screenDocuments, agent => this.facade?.endedAgent(agent), message => this.say(message))
			},
			clis: {
				known: knownClis(),
				custom: customAgents,
				installed: () => installedNow,
				refresh: async () => {
					const folder = await folderOnScreen() ?? vscode.workspace.workspaceFolders?.find(each => each.uri.scheme === 'file')?.uri.fsPath;
					installedNow = installedClis(configFor, folder === undefined ? process.env : await terminalEnvironment(folder), folder);
				},
				locate: (cli, config, env, folder) => locateCli(cli, config, env, folder),
				yolo,
				framework: frameworkOn,
				configOf: configFor,
				environment: terminalEnvironment
			},
			// No agent starts before the endpoint below listens: their MCP servers call it.
			setup: {
				connection: tokenFile => this.listening().connection(tokenFile, timeoutMs(), dir),
				sharedMcpServer: () => this.listening().sharedMcpServer(),
				agentEnv: tokenFile => this.listening().agentEnv(tokenFile, timeoutMs()),
				skills: () => [facadeSkill()],
				firstLine: firstLineFor
			},
			timing: () => ({ startTimeoutMs: timeoutMs() }),
			settingsProblems,
			log: message => this.say(message)
		});
		this.disposables.push(facade);

		const contract = new Contract(facade);
		// The endpoint listens before the record is reconciled - an agent's MCP server says hello as it comes
		// back - but a tool call waits for it: answered before, `list_agents` would show agents gone with the
		// window as running, and a stop would race the reconciliation (L12).
		let reconciled = () => { };
		const reconciliation = new Promise<void>(resolve => reconciled = resolve);
		const endpoint = this.endpoint = await this.listen(windowState, dir, {
			authenticate: token => table.authenticate(token),
			hello: (caller, server) => contract.hello(caller, server),
			call: (caller, tool, args, progress, whenWritten) => this.whileUnderWay(reconciliation.then(() => contract.call(caller, tool, args, progress, whenWritten))),
			log: message => this.log.error(message)
		}, [...table.state.agents.values()].some(isLive), windowState.unreadable);
		if (!endpoint) {
			return;
		}
		this.disposables.push(endpoint);
		// What of the person's settings Facade does not take as set is said as Facade starts, and as they change (X-59)
		const sayProblems = () => settingsProblems().forEach(problem => this.say(`${problem}.`));
		sayProblems();
		// The window counts the agents that are live - starting, running, stopping - as the record says, not by its
		// terminals' icons: one making its worktree has no terminal yet, one ended keeps its tab (X-51)
		let pushing: ReturnType<typeof setTimeout> | undefined;
		const pushLive = () => {
			pushing ??= setTimeout(() => {
				pushing = undefined;
				const live = [...table.state.agents.values()].filter(isLive).map(agent => agent.id);
				void vscode.commands.executeCommand('_facade.agents.live', id, live).then(undefined, () => undefined);
			}, 100);
		};
		const changes = table.onDidChange(pushLive);
		this.disposables.push({ dispose: () => { changes.dispose(); clearTimeout(pushing); } });
		pushLive();
		// The CLIs looked for where a terminal finds them, as Facade starts and as what decides it changes (X-39)
		void facade.refreshClis();
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.agents') || event.affectsConfiguration('terminal.integrated.env')) {
				void facade.refreshClis();
			}
		}));
		// The switch goes into window.json as it changes: an agent's MCP server finds it there while the window is away.
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.orchestration.enabled') || event.affectsConfiguration('facade.agents.timeout')) {
				sayProblems();
			}
			if (event.affectsConfiguration('facade.orchestration.enabled')) {
				try {
					endpoint.setEnabled(frameworkOn());
					// Doorbells stop or start again with the switch (AGENT-MESSAGES.md, M10)
					facade.frameworkChanged();
				} catch (err) {
					this.say(`Could not record in window.json that the agent framework is ${frameworkOn() ? 'on' : 'off'}: ${messageOf(err)}`);
				}
			}
		}));
		if (this.stopped) {
			this.dispose();
			return;
		}

		try {
			await facade.recover(load.reloaded || sameWindow, sameWindow);
		} finally {
			reconciled();
		}
		if (this.stopped) {
			return;
		}
		this.facade = facade;
		this.log.info(`Facade agents are ready for ${folders[0].uri.fsPath}. Record ${dir}; pipe ${endpoint.pipe}; agents: ${facade.startable().map(each => each.id).join(', ') || 'none'}; the agent framework ${frameworkOn() ? 'on' : 'off'}.`);
	}

	/**
	 * Stops: as the window goes, or as Facade lets go of its agents while the window stays - a start that
	 * failed - which the workspace's ledger records for the next window to know.
	 */
	dispose(by: ClosedBy = 'window'): Promise<void> {
		this.stopped = true;
		this.stoppedBy ??= by;
		this.facade = undefined;
		this.person = undefined;
		this.endpoint = undefined;
		disposeAll(this.disposables.reverse(), err => this.warn(`Stopping Facade agents: ${messageOf(err)}`));
		this.disposables.length = 0;
		// The core does nothing more, but what a call under way already did - a worktree git finished making -
		// is recorded before the ledger closes, so that the next window knows of it (AGENT-LAUNCHER.md, L12).
		const table = this.table;
		this.table = undefined;
		if (!table) {
			return this.closed ?? Promise.resolve();
		}
		const close = () => {
			try {
				table.dispose(this.stoppedBy);
			} catch (err) {
				this.warn(`Stopping Facade agents: ${messageOf(err)}`);
			}
		};
		if (!this.underWay.size) {
			close();
			return this.closed = Promise.resolve();
		}
		return this.closed = Promise.race([Promise.allSettled([...this.underWay]), timeout(CLOSE_WAIT_MS)]).then(close);
	}

	/** `work`, a call the ledger stays open for while the service stops. */
	private whileUnderWay<T>(work: Promise<T>): Promise<T> {
		this.underWay.add(work);
		const done = () => { this.underWay.delete(work); };
		work.then(done, done);
		return work;
	}

	/**
	 * Agents: Start Agent..., and the agent menu's items: the agent chosen starts at once in the folder on
	 * screen, asking nothing more (AGENT-LAUNCHER.md, L3). Answers with the new agent's number and name, for a
	 * script that started it; the person is told why a start was refused.
	 */
	/** What would refuse a start of `installed` in `folder` as things are, as Show Agent Launch shows it (X-38). */
	async launchProblems(installed: InstalledCli, folder: string): Promise<readonly string[]> {
		return await this.facade?.launchProblems(installed, folder) ?? [];
	}

	/** The person is deleting the worktree `folder` in the window: its agents still starting are stopped first (N-34). */
	async worktreeDeleting(folder: string): Promise<void> {
		await this.facade?.worktreeDeleting(folder);
	}

	async startAgentCommand(rawArgs: unknown): Promise<{ readonly id: number; readonly name: string } | undefined> {
		const facade = this.facade;
		if (!facade) {
			// A record that cannot be read is a failure, another window's agents a start refused (UI-17)
			void (this.noCore === 'otherWindow'
				? vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window has this workspace's agents: start agents in that window."))
				: this.noCore === 'unreadable'
					? vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's record while an agent of it may still run: the Facade Agents output says why."))
					: vscode.window.showInformationMessage(vscode.l10n.t("Open a folder on this machine to start an agent in it.")));
			return undefined;
		}
		const offered: OfferedAgent[] = [
			...facade.startable().filter(each => !each.custom).map(each => ({ id: each.id, label: each.displayName, custom: false })),
			// Listed as the person wrote them, found or not: a start says what is wrong.
			...customAgents().map(({ cli }) => ({ id: cli.id, label: cli.displayName, custom: true }))
		];
		const picked = await pickAgent(rawArgs, offered);
		if (!picked) {
			return undefined;
		}
		const local = (vscode.workspace.workspaceFolders ?? []).filter(each => each.uri.scheme === 'file');
		// The folder on screen as the person chose, where the menu sent it: not the one they went to since (PS-15)
		const folder = picked.folder ?? await folderOnScreen() ?? local.at(0)?.uri.fsPath;
		if (folder === undefined) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open a folder on this machine to start an agent in it."));
			return undefined;
		}
		try {
			const started = await this.whileUnderWay(facade.startForPerson(picked.id, folder, picked.custom));
			return { id: started.id, name: started.name };
		} catch (err) {
			this.log.error(`Starting ${picked.id} failed: ${stackOf(err)}`);
			// Its Show goes to what its CLI showed as it ended, where it had a terminal (AGENT-DEBUGGING.md, D6)
			const agent = err instanceof FacadeError ? err.outcome?.agent : undefined;
			const ended = agent === undefined ? undefined : facade.endedAgent(agent);
			if (this.person) {
				this.person.tellNotStarted(messageOf(err), ended);
			} else {
				void vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", messageOf(err)));
			}
			return undefined;
		}
	}

	/** Agents: Open Chat Room... (AGENT-MESSAGES.md, M9). */
	async openChatRoomCommand(): Promise<void> {
		const facade = this.facade;
		if (!facade) {
			this.tellNoCore(vscode.l10n.t("Another Facade window has this workspace's agents: open their chat rooms in that window."));
			return;
		}
		await pickRoom(facade.mail.rooms.list());
	}

	/** Agents: Delete Chat Rooms...: once the person said so, the rooms and the files of long messages are gone for good (M9). */
	async deleteChatRoomsCommand(): Promise<void> {
		if (!this.facade) {
			this.tellNoCore(vscode.l10n.t("Another Facade window has this workspace's agents: delete their chat rooms in that window."));
			return;
		}
		if (!await confirmDeleteRooms()) {
			return;
		}
		try {
			// The window may have gone meanwhile
			if (!this.facade) {
				throw new Error(vscode.l10n.t("Facade agents stopped in this window."));
			}
			this.facade.mail.deleteRooms();
		} catch (err) {
			this.log.error(`Deleting the chat rooms failed: ${stackOf(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("The chat rooms could not all be deleted: {0}", messageOf(err)));
		}
	}

	/** Tells the person why a command finds no agents here: another window has them - `otherWindow` - or there is no record of them here. */
	private tellNoCore(otherWindow: string): void {
		void (this.noCore === 'otherWindow'
			? vscode.window.showWarningMessage(otherWindow)
			: this.noCore === 'unreadable'
				? vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's record while an agent of it may still run: the Facade Agents output says why."))
				: vscode.window.showInformationMessage(vscode.l10n.t("Open a folder on this machine to have agents in it.")));
	}

	/** Keeps `owner` as who this workspace's window is to its ledger: the window's own, carried into a new workspace's storage. */
	private async keepOwner(owner: string): Promise<string> {
		await this.workspaceState.update(OWNER_KEY, owner);
		return owner;
	}

	/** Who this workspace's window is to its ledger: made once, and the same through its reloads. */
	private async owner(): Promise<string> {
		const kept = this.workspaceState.get(OWNER_KEY);
		if (typeof kept === 'string' && kept) {
			return kept;
		}
		const owner = crypto.randomBytes(8).toString('hex');
		await this.workspaceState.update(OWNER_KEY, owner);
		return owner;
	}

	/**
	 * The workspace's ledger, open in this window; undefined once the service stopped meanwhile. Its lock
	 * is waited for as `lockWait` says: one a window that runs keeps touching is that window's,
	 * `LedgerLockedError`.
	 */
	private async openTable(dir: string, owner: string, session: string | undefined, mayMoveAside: () => boolean, onMovedAside?: (why: string, keptAs: string) => void): Promise<AgentTable | undefined> {
		const locked = lockWait(HANDOVER_MS);
		let told = false;
		return this.retried(() => AgentTable.open({ dir, owner, session, mayMoveAside, onMovedAside, onTaken: () => setImmediate(() => this.taken()) }), err => {
			if (err instanceof LedgerLockedError && !told) {
				told = true;
				this.log.info(`${err.message} Its lock is waited for while the window before lets go of it, or while nobody touches it.`);
			}
			return locked(err);
		});
	}

	/**
	 * Waits, for a while at most, until the extension host before lets go of the record in `dir`, where
	 * that record names a workspace other than `workspace`: this window's own, as its folder window became a
	 * workspace and the extension host started again, closes it only as it goes.
	 */
	private async handedOver(dir: string, workspace: string): Promise<void> {
		const named = identityOf(dir);
		if (named === undefined || isSameWorkspace(named, workspace)) {
			return;
		}
		const deadline = Date.now() + HANDOVER_MS;
		while (!this.stopped && lockStateOf(dir).held && Date.now() < deadline) {
			await timeout(HANDOVER_POLL_MS);
		}
	}

	/** Another window took the workspace's agents, this one standing still too long: it lets go of everything, and says so once. */
	private taken(): void {
		if (this.stopped) {
			return;
		}
		this.log.warn('Another Facade window took this workspace\'s agents, this one standing still too long: they are that window\'s now.');
		void vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window took this workspace's agents: they are that window's now."));
		this.noCore = 'otherWindow';
		this.dispose();
	}

	/** The endpoint the agents' MCP servers call, once it listens. */
	private listening(): PipeEndpoint<Caller> {
		if (!this.endpoint) {
			throw new Error('Facade does not listen for its agents in this window.');
		}
		return this.endpoint;
	}

	/**
	 * A line of the core's in Facade's log. One that comes as the window goes - a call to it under way
	 * fails once the window has closed the log - has nowhere to go, and is dropped.
	 */
	private say(message: string): void {
		try {
			this.log.info(message);
		} catch {
			// The log is closed: the window went.
		}
	}

	/** As `say`, for what went wrong. */
	private warn(message: string): void {
		try {
			this.log.error(message);
		} catch {
			// The log is closed: the window went.
		}
	}

	/**
	 * The endpoint on the pipe the agents still running call, which only that pipe reaches; undefined
	 * once the service stopped meanwhile. The extension host before is waited for while it lets go of
	 * it - while agents run, as long as their MCP servers wait for the window - and only then is a new pipe
	 * taken, the person told that the agents still running lost Facade's tools.
	 */
	private async listen(windowState: StateStore, dir: string, handlers: PipeHandlers<Caller>, agentsRun: boolean, unreadable?: string): Promise<PipeEndpoint<Caller> | undefined> {
		const kept = windowState.get(PIPE_ID_KEY);
		// The file that names the pipe could not be read: the agents running call a pipe this window cannot know -
		// said once, loud, not lost quietly (C-REC-19)
		if (unreadable !== undefined) {
			this.log.error(`${path.join(dir, WINDOW_STATE_FILE)} could not be read (${unreadable}): Facade listens on a new pipe.`);
			if (agentsRun) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Facade could not read {0}, which names the pipe its agents call: the agents still running from before cannot use Facade's tools any more. Agents started from now on can.", path.join(dir, WINDOW_STATE_FILE)));
			}
		}
		if (typeof kept === 'string' && /^[0-9a-f]{16}$/.test(kept)) {
			// No shorter than the extension host before takes to let go of it, however short the person set it.
			const deadline = Date.now() + (agentsRun ? Math.max(timeoutMs(), HANDOVER_MS) : HANDOVER_MS);
			try {
				return await this.retried(() => PipeEndpoint.start(pipePath(kept), dir, handlers, frameworkOn()), err => codeOf(err) === 'EADDRINUSE' && Date.now() < deadline);
			} catch (err) {
				if (codeOf(err) !== 'EADDRINUSE') {
					throw err;
				}
			}
			this.log.warn(`The pipe ${pipePath(kept)} is still taken; Facade listens on a new one.`);
			if (agentsRun) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Facade could not take back the pipe its agents call: the agents still running from before cannot use Facade's tools any more. Agents started from now on can."));
			}
		}
		const pipeId = crypto.randomBytes(8).toString('hex');
		await windowState.update(PIPE_ID_KEY, pipeId);
		return this.stopped ? undefined : PipeEndpoint.start(pipePath(pipeId), dir, handlers, frameworkOn());
	}

	/** What `attempt` makes, tried again while `again` says so of what it failed with; undefined once the service stopped meanwhile. */
	private async retried<T>(attempt: () => T | Promise<T>, again: (err: unknown) => boolean): Promise<T | undefined> {
		while (!this.stopped) {
			try {
				return await attempt();
			} catch (err) {
				if (!again(err)) {
					throw err;
				}
			}
			await timeout(HANDOVER_POLL_MS);
		}
		return undefined;
	}
}

/**
 * The person's history of the agents of the workspace whose storage is `workspaceState`: its record's
 * `agents.log`, whether Facade runs now or not; undefined for a workspace Facade never had a record for.
 */
export function agentsLogOf(workspaceState: vscode.Memento): string | undefined {
	const id = workspaceState.get(WORKSPACE_ID_KEY);
	const folder = (vscode.workspace.workspaceFolders ?? []).find(candidate => candidate.uri.scheme === 'file');
	const workspace = (vscode.workspace.workspaceFile ?? folder?.uri)?.toString();
	if (!isWorkspaceId(id) || workspace === undefined) {
		return undefined;
	}
	// The record the storage names only while it names this workspace: the storage of another one - the
	// old file after Save As - can have come with it (X-67)
	const dir = recordDirOf(workspacesRoot(), id);
	const named = identityOf(dir);
	return named !== undefined && isSameWorkspace(named, workspace) ? path.join(dir, AGENTS_LOG) : undefined;
}

/**
 * How the window was loaded, as Facade's workbench says: an id of this load's own - the same through the
 * extension host's restarts, another after a reload - and whether a reload of the window before loaded it.
 * Without Facade's workbench neither is known: no id, and taken for no reload.
 */
async function windowLoad(): Promise<{ readonly id: string | undefined; readonly reloaded: boolean; readonly record?: { readonly id: string; readonly owner: string } }> {
	if (!(await vscode.commands.getCommands()).includes('_facade.window.loaded')) {
		return { id: undefined, reloaded: false };
	}
	const load = await vscode.commands.executeCommand<unknown>('_facade.window.loaded');
	const { id, reloaded, record } = isJsonObject(load) ? load : {};
	const kept = isJsonObject(record) && isWorkspaceId(record.id) && typeof record.owner === 'string' && record.owner ? { id: record.id, owner: record.owner } : undefined;
	return { id: typeof id === 'string' && /^[0-9a-f-]+$/i.test(id) ? id : undefined, reloaded: reloaded === true, ...(kept ? { record: kept } : {}) };
}

/** Tells the window which record it has now, for an extension host that starts again under it (`windowLoad`). */
async function rememberWindowRecord(id: string, owner: string): Promise<void> {
	if ((await vscode.commands.getCommands()).includes('_facade.window.record')) {
		await vscode.commands.executeCommand('_facade.window.record', { id, owner });
	}
}
