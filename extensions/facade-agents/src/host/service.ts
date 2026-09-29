/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { installedClis } from '../clis';
import { Contract } from '../contract/tools';
import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import { LedgerLockedError } from '../record/ledger';
import { workspaceDir, workspacesRoot } from '../record/paths';
import { AgentRegistry, PERSON } from '../record/registry';
import { JsonFileState, StateStore } from '../record/windowState';
import { PipeEndpoint } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { HostGit } from './git';
import { HostIde } from './ide';
import { askStartAgent } from './startAgent';
import { HostTerminals } from './terminals';

const PIPE_ID_KEY = 'facade.agents.pipeId';
const WINDOW_STATE_FILE = 'window-state.json';
/**
 * When a folder window becomes a workspace, its extension host starts again while the one before can
 * still be letting go of the ledger and the pipe: this long, what it holds is waited for (WA-10.2).
 */
const HANDOVER_MS = 10_000;

/**
 * Facade's agents while `facade.orchestration.enabled` is on, and the one place the layers are put
 * together (WORKTREE-AGENTS.md, section 18): the workspace's record under ~/.facade/workspaces, the
 * core with the window as its ports, the contract behind the pipe, and the agents still running after
 * a reload found again. Off, none of it exists.
 */
export class AgentsService implements vscode.Disposable {

	private readonly disposables: { dispose(): void }[] = [];
	private facade: Facade | undefined;
	private endpoint: PipeEndpoint<Caller> | undefined;

	constructor(private readonly log: vscode.LogOutputChannel) { }

	async start(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		if (!folders.length) {
			this.log.info('Facade agents need a folder on this machine in the workspace; nothing started.');
			return;
		}
		const dir = workspaceDir(workspacesRoot(), folders[0].uri.fsPath);
		let registry: AgentRegistry;
		try {
			registry = await whenFree(() => AgentRegistry.open({ dir }), err => err instanceof LedgerLockedError);
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				void vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window has this workspace's agents. They stay in that window."));
				return;
			}
			throw err;
		}
		this.disposables.push(registry);

		// Next to the ledger rather than in the workspace storage, which a folder window becoming a
		// workspace replaces while agents keep running (WA-10.1).
		const windowState = new JsonFileState(path.join(dir, WINDOW_STATE_FILE));
		const terminals = new HostTerminals(windowState, message => this.log.info(message));
		this.disposables.push(terminals);

		const facade = new Facade({
			registry,
			ports: { terminals, ide: new HostIde(), git: new HostGit() },
			clis: () => installedClis(),
			// No agent starts before the endpoint below listens: their MCP servers call it.
			mcpServer: tokenFile => this.endpoint!.mcpServer(tokenFile),
			log: message => this.log.info(message)
		});
		this.disposables.push(facade);

		const contract = new Contract(facade);
		const endpoint = this.endpoint = await this.listen(windowState, dir, {
			authenticate: token => registry.authenticate(token),
			hello: caller => contract.hello(caller),
			call: (caller, tool, args) => contract.call(caller, tool, args)
		});
		this.disposables.push(endpoint);

		await facade.recover();
		this.facade = facade;
		this.log.info(`Facade agents are on for ${folders[0].uri.fsPath}. Record ${dir}; pipe ${endpoint.pipe}; CLIs: ${facade.clis().map(each => each.cli.id).join(', ') || 'none'}.`);
	}

	dispose(): void {
		this.facade = undefined;
		this.endpoint = undefined;
		for (const disposable of this.disposables.reverse()) {
			try {
				disposable.dispose();
			} catch (err) {
				this.log.error(`Stopping Facade agents: ${(err as Error).message}`);
			}
		}
		this.disposables.length = 0;
	}

	/** Facade: Start Agent. Answers with the new agent's name, for a script that started it. */
	async startAgentCommand(rawArgs: unknown): Promise<string | undefined> {
		const facade = this.facade;
		if (!facade) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Facade agents need a folder on this machine in the workspace."));
			return undefined;
		}
		const request = await askStartAgent(rawArgs, facade.clis());
		if (!request) {
			return undefined;
		}
		try {
			return (await facade.startAgent(PERSON, request)).name;
		} catch (err) {
			this.log.error(`Starting an agent failed: ${(err as Error).stack ?? err}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", (err as Error).message));
			return undefined;
		}
	}

	/** The endpoint on the same pipe as before, which the agents still running call; a new one if it is taken. */
	private async listen(windowState: StateStore, dir: string, handlers: PipeHandlers<Caller>): Promise<PipeEndpoint<Caller>> {
		let pipeId = windowState.get<string | undefined>(PIPE_ID_KEY, undefined) ?? crypto.randomBytes(8).toString('hex');
		await windowState.update(PIPE_ID_KEY, pipeId);
		const inUse = (err: unknown) => (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
		try {
			return await whenFree(() => PipeEndpoint.start(pipePath(pipeId), dir, handlers), inUse);
		} catch (err) {
			if (!inUse(err)) {
				throw err;
			}
			this.log.warn(`The pipe ${pipePath(pipeId)} is taken; using a new one.`);
			pipeId = crypto.randomBytes(8).toString('hex');
			await windowState.update(PIPE_ID_KEY, pipeId);
			return PipeEndpoint.start(pipePath(pipeId), dir, handlers);
		}
	}
}

/** What `attempt` makes, tried again while `busy` says what it needs is still held, for {@link HANDOVER_MS} at most. */
async function whenFree<T>(attempt: () => T | Promise<T>, busy: (err: unknown) => boolean): Promise<T> {
	const deadline = Date.now() + HANDOVER_MS;
	for (; ;) {
		try {
			return await attempt();
		} catch (err) {
			if (!busy(err) || Date.now() >= deadline) {
				throw err;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}
