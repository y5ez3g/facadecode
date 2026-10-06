/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { installedClis, knownClis } from '../clis/registry';
import { facadeSkill, openingFor } from '../contract/prompts';
import { Contract } from '../contract/tools';
import { Facade } from '../core/facade';
import { Caller, isLive, PERSON } from '../record/events';
import { LedgerLockedError, lockWait } from '../record/ledger';
import { recordDir, workspaceDir, workspacesRoot } from '../record/paths';
import { ProcessTable } from '../record/processes';
import { PipeEndpoint } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { HostGit } from './git';
import { HostPerson } from './person';
import { configFor, timeoutMs } from './settings';
import { askStartAgent } from './startAgent';
import { agentTerminalRuns, HostTerminals, terminalEnvironment } from './terminals';
import { JsonFileState, StateStore } from './windowState';

const PIPE_ID_KEY = 'facade.agents.pipeId';
const WINDOW_STATE_FILE = 'window-state.json';
/** The workspace's record, kept in its `workspaceState`. */
const RECORD_KEY = 'facade.agents.record';
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
	private noCore: 'otherWindow' | 'noFolder' | undefined;
	private endpoint: PipeEndpoint<Caller> | undefined;
	/** Set once the service stopped: as the window goes, as Facade agents are turned off, or as another window took its agents. */
	private stopped = false;

	/** `workspaceState` keeps the record this workspace's agents are in, whatever becomes of its first folder. */
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
		// The record it started with, while its folder is in the workspace or an agent of it runs: moving
		// or removing a folder restarts the extension host, and its agents run on, their tokens and pipe in
		// that record. A folder gone from the workspace with its agents is its own window's again.
		const dir = recordDir(workspacesRoot(), this.workspaceState.get(RECORD_KEY), folders.map(folder => folder.uri.fsPath), kept => agentTerminalRuns(new JsonFileState(path.join(kept, WINDOW_STATE_FILE))));
		if (dir !== workspaceDir(workspacesRoot(), folders[0].uri.fsPath)) {
			this.log.info(`The workspace's first folder is now ${folders[0].uri.fsPath}; its agents stay in the record they started in, ${dir}.`);
		}
		await this.workspaceState.update(RECORD_KEY, dir);
		let table: ProcessTable | undefined;
		try {
			table = await this.openTable(dir, await this.owner());
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				void vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window has this workspace's agents. They stay in that window."));
				this.noCore = 'otherWindow';
				return;
			}
			throw err;
		}
		if (!table) {
			return;
		}
		this.disposables.push(table);

		// Next to the ledger rather than in the workspace storage, which a folder window becoming a
		// workspace replaces while agents keep running.
		const windowState = new JsonFileState(path.join(dir, WINDOW_STATE_FILE));
		const terminals = new HostTerminals(windowState, message => this.say(message));
		this.disposables.push(terminals);

		const facade = new Facade({
			table,
			ports: { terminals, git: new HostGit(), person: new HostPerson(terminals, message => this.say(message)) },
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
		}, [...table.state.processes.values()].some(isLive));
		if (!endpoint) {
			return;
		}
		this.disposables.push(endpoint);
		if (this.stopped) {
			this.dispose();
			return;
		}

		await facade.recover();
		if (this.stopped) {
			return;
		}
		this.facade = facade;
		this.log.info(`Facade agents are on for ${folders[0].uri.fsPath}. Record ${dir}; pipe ${endpoint.pipe}; CLIs: ${facade.clis().map(each => each.cli.id).join(', ') || 'none'}.`);
	}

	dispose(): void {
		this.stopped = true;
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
	}

	/** Facade: Start Agent. Answers with the new agent's PID and name, for a script that started it. */
	async startAgentCommand(rawArgs: unknown): Promise<{ readonly pid: number; readonly name: string } | undefined> {
		const facade = this.facade;
		if (!facade) {
			void vscode.window.showInformationMessage(this.noCore === 'otherWindow'
				? vscode.l10n.t("Another Facade window has this workspace's agents: start agents in that window.")
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
		const request = await askStartAgent(rawArgs, installed);
		if (!request) {
			return undefined;
		}
		try {
			const { pid, name } = await facade.spawn(PERSON, request);
			return { pid, name };
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
	private async openTable(dir: string, owner: string): Promise<ProcessTable | undefined> {
		const locked = lockWait(HANDOVER_MS);
		let told = false;
		return this.retried(() => ProcessTable.open({ dir, owner, onTaken: () => setImmediate(() => this.taken()) }), err => {
			if (err instanceof LedgerLockedError && !told) {
				told = true;
				this.log.info(`${err.message} Its lock is waited for while the window before lets go of it, or while nobody touches it.`);
			}
			return locked(err);
		});
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
