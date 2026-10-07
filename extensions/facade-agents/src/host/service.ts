/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { installedClis, knownClis } from '../clis/registry';
import { facadeSkill, openingFor } from '../contract/prompts';
import { Contract } from '../contract/tools';
import { Facade, StartRequest } from '../core/facade';
import { AgentTable } from '../record/agents';
import { Caller, describe, isLive, PERSON } from '../record/events';
import { identityOf, isWorkspaceId, recordDirOf, recordFor } from '../record/identity';
import { ClosedBy, LedgerLockedError, LedgerUnreadableError, lockStateOf, lockWait } from '../record/ledger';
import { AGENTS_LOG } from '../record/log';
import { workspacesRoot } from '../record/paths';
import { PipeEndpoint } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { HostGit } from './git';
import { HostPerson } from './person';
import { configFor, timeoutMs } from './settings';
import { askStartAgent } from './startAgent';
import { agentProcessesRun, HostTerminals, terminalEnvironment } from './terminals';
import { JsonFileState, StateStore } from './windowState';

const PIPE_ID_KEY = 'facade.agents.pipeId';
const WINDOW_STATE_FILE = 'window-state.json';
/** The workspace's id, which names its record: kept in its `workspaceState`, which VS Code carries over as the workspace is saved under another name. */
const WORKSPACE_ID_KEY = 'facade.agents.workspaceId';
/** Who this workspace's window is to its ledger, the same through its reloads: kept in its `workspaceState`. */
const OWNER_KEY = 'facade.agents.owner';
/**
 * When a folder window becomes a workspace, its extension host starts again while the one before can
 * still be letting go of the ledger and the pipe: this long, what it holds is waited for.
 */
const HANDOVER_MS = 10_000;
/** How often what another extension host holds is looked at, while it is waited for. */
const HANDOVER_POLL_MS = 250;

/**
 * Facade's agents while `facade.orchestration.enabled` is on, and the one place the layers are put
 * together: the workspace's record under ~/.facade/workspaces, the core with the window as its ports,
 * the contract behind the pipe, and the agents still running after a reload found again. Off, none of
 * it exists.
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

	/** `workspaceState` keeps the id of the record this workspace's agents are in, as its folders come and go. */
	constructor(private readonly log: vscode.LogOutputChannel, private readonly workspaceState: vscode.Memento) { }

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
		// The record the workspace's storage names, while it names this workspace: one this very window had
		// under another name - its folder window became a workspace, or it was saved as another - goes with it,
		// its agents running on; any other workspace gets a record of its own.
		const load = await windowLoad();
		const workspace = (vscode.workspace.workspaceFile ?? folders[0].uri).toString();
		const storedId = this.workspaceState.get(WORKSPACE_ID_KEY);
		if (isWorkspaceId(storedId)) {
			await this.handedOver(recordDirOf(workspacesRoot(), storedId), workspace);
		}
		const { id, dir, isNew } = recordFor(workspacesRoot(), storedId, workspace, kept => load.id !== undefined && lockStateOf(kept).closedIn === load.id);
		await this.workspaceState.update(WORKSPACE_ID_KEY, id);
		if (isNew) {
			this.log.info(`The workspace ${workspace} has a new record, ${dir}.`);
		}
		// A ledger Facade cannot read is moved aside only at a start of the window that is no reload, with
		// none of its agents' processes in a terminal of the window: the history is in the log.
		const owner = await this.owner();
		let table: AgentTable | undefined;
		try {
			table = await this.openTable(dir, owner, load.id, () => false).catch(async err => {
				if (err instanceof LedgerUnreadableError && !load.reloaded && !await agentProcessesRun(id)) {
					return this.openTable(dir, owner, load.id, () => true);
				}
				throw err;
			});
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				void vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window has this workspace's agents. They stay in that window."));
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

		const facade = new Facade({
			table,
			ports: {
				terminals,
				git: new HostGit(),
				workspace: { folders: () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) },
				person: new HostPerson(terminals, message => this.say(message))
			},
			clis: {
				known: knownClis(),
				installed: () => installedClis(configFor),
				configOf: configFor,
				environment: terminalEnvironment
			},
			// No agent starts before the endpoint below listens: their MCP servers call it.
			setup: {
				mcpServer: tokenFile => this.listening().mcpServer(tokenFile, timeoutMs()),
				sharedMcpServer: () => this.listening().sharedMcpServer(),
				agentEnv: token => this.listening().agentEnv(token, timeoutMs()),
				skills: () => [facadeSkill(installedClis(configFor).map(({ cli }) => ({ id: cli.id, displayName: cli.displayName })))],
				opening: openingFor
			},
			timing: () => ({ startTimeoutMs: timeoutMs() }),
			log: message => this.say(message)
		});
		this.disposables.push(facade);

		const contract = new Contract(facade);
		const endpoint = this.endpoint = await this.listen(windowState, dir, {
			authenticate: token => table.authenticate(token),
			hello: caller => contract.hello(caller),
			call: (caller, tool, args, progress) => contract.call(caller, tool, args, progress),
			log: message => this.log.error(message)
		}, [...table.state.agents.values()].some(isLive));
		if (!endpoint) {
			return;
		}
		this.disposables.push(endpoint);
		if (this.stopped) {
			this.dispose();
			return;
		}

		await facade.recover(load.reloaded);
		if (this.stopped) {
			return;
		}
		this.facade = facade;
		this.log.info(`Facade agents are on for ${folders[0].uri.fsPath}. Record ${dir}; pipe ${endpoint.pipe}; CLIs: ${facade.clis().map(each => each.cli.id).join(', ') || 'none'}.`);
	}

	/**
	 * Stops: as the window goes, or as Facade lets go of its agents while the window stays - turned off, or
	 * a start that failed - which the workspace's ledger records for the next window to know.
	 */
	dispose(by: ClosedBy = 'window'): void {
		this.stopped = true;
		this.stoppedBy ??= by;
		this.facade = undefined;
		this.endpoint = undefined;
		for (const disposable of this.disposables.reverse()) {
			try {
				disposable.dispose();
			} catch (err) {
				this.log.error(`Stopping Facade agents: ${messageOf(err)}`);
			}
		}
		this.disposables.length = 0;
		try {
			this.table?.dispose(this.stoppedBy);
		} catch (err) {
			this.log.error(`Stopping Facade agents: ${messageOf(err)}`);
		}
		this.table = undefined;
	}

	/**
	 * Facade: Start Agent. Answers with the new agent's number and name, and whether it has started, for a
	 * script that started it; the person is told where its start is not confirmed.
	 */
	async startAgentCommand(rawArgs: unknown): Promise<{ readonly id: number; readonly name: string; readonly status: 'started' | 'unconfirmed' } | undefined> {
		const facade = this.facade;
		if (!facade) {
			void vscode.window.showInformationMessage(this.noCore === 'otherWindow'
				? vscode.l10n.t("Another Facade window has this workspace's agents: start agents in that window.")
				: this.noCore === 'unreadable'
					? vscode.l10n.t("Facade cannot read this workspace's record while an agent of it may still run: the Facade Agents output says why.")
					: vscode.l10n.t("Facade agents need a folder on this machine in the workspace."));
			return undefined;
		}
		const installed = facade.clis();
		// A CLI whose path setting names nothing is not offered: the person is told why, each time they look.
		for (const cli of knownClis()) {
			const { path: setPath } = configFor(cli);
			if (setPath && !installed.some(each => each.cli.id === cli.id)) {
				void vscode.window.showWarningMessage(vscode.l10n.t("{0} is not offered: the setting facade.orchestration.{1}.path is {2}, which is no file, nor a command on PATH.", cli.displayName, cli.section, setPath));
			}
		}
		let request: StartRequest | undefined;
		try {
			request = await askStartAgent(rawArgs, installed, await facade.windowFolders());
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", messageOf(err)));
			return undefined;
		}
		if (!request) {
			return undefined;
		}
		try {
			const started = await facade.startAgent(PERSON, request);
			if (started.status === 'unconfirmed') {
				void vscode.window.showWarningMessage(vscode.l10n.t("{0} is not confirmed to have started: {1}. It stays starting; its tab shows what it waits for.", describe(started), started.why ?? ''));
			}
			return { id: started.id, name: started.name, status: started.status };
		} catch (err) {
			this.log.error(`Starting an agent failed: ${stackOf(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", messageOf(err)));
			return undefined;
		}
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
	private async openTable(dir: string, owner: string, session: string | undefined, mayMoveAside: () => boolean): Promise<AgentTable | undefined> {
		const locked = lockWait(HANDOVER_MS);
		let told = false;
		return this.retried(() => AgentTable.open({ dir, owner, session, mayMoveAside, onTaken: () => setImmediate(() => this.taken()) }), err => {
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
		if (named === undefined || named === workspace) {
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

	/**
	 * The endpoint on the pipe the agents still running call, which only that pipe reaches; undefined
	 * once the service stopped meanwhile. The extension host before is waited for while it lets go of
	 * it - while agents run, as long as their MCP servers wait for the window - and only then is a new pipe
	 * taken, the person told that the agents still running lost Facade's tools.
	 */
	private async listen(windowState: StateStore, dir: string, handlers: PipeHandlers<Caller>, agentsRun: boolean): Promise<PipeEndpoint<Caller> | undefined> {
		const kept = windowState.get(PIPE_ID_KEY);
		if (typeof kept === 'string' && /^[0-9a-f]{16}$/.test(kept)) {
			// No shorter than the extension host before takes to let go of it, however short the person set it.
			const deadline = Date.now() + (agentsRun ? Math.max(timeoutMs(), HANDOVER_MS) : HANDOVER_MS);
			try {
				return await this.retried(() => PipeEndpoint.start(pipePath(kept), dir, handlers), err => codeOf(err) === 'EADDRINUSE' && Date.now() < deadline);
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
		return this.stopped ? undefined : PipeEndpoint.start(pipePath(pipeId), dir, handlers);
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
	return isWorkspaceId(id) ? path.join(recordDirOf(workspacesRoot(), id), AGENTS_LOG) : undefined;
}

/**
 * How the window was loaded, as Facade's workbench says: an id of this load's own - the same through the
 * extension host's restarts, another after a reload - and whether a reload of the window before loaded it.
 * Without Facade's workbench neither is known: no id, and taken for no reload.
 */
async function windowLoad(): Promise<{ readonly id: string | undefined; readonly reloaded: boolean }> {
	if (!(await vscode.commands.getCommands()).includes('_facade.window.loaded')) {
		return { id: undefined, reloaded: false };
	}
	const load = await vscode.commands.executeCommand<unknown>('_facade.window.loaded');
	const { id, reloaded } = isJsonObject(load) ? load : {};
	return { id: typeof id === 'string' && /^[0-9a-f-]+$/i.test(id) ? id : undefined, reloaded: reloaded === true };
}
