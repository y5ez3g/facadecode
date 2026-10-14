/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { messageOf, stackOf } from './base/errors';
import { ScreenDocuments } from './host/screenDocuments';
import { agentsLogOf, AgentsService } from './host/service';
import { registerShowLaunch } from './host/showLaunch';

/** Stops Facade's agents as the extension stops; settles once the workspace's ledger is closed. */
let stopAgents: (() => Promise<void>) | undefined;

/**
 * Facade's agents: vendors' agent CLIs and the person's own in their own UIs, in the folders and worktrees
 * of this window, starting, listing and ending each other, messaging each other and the person, and looking
 * into each other's terminals through Facade's MCP server. The agent framework's switch,
 * `facade.orchestration.enabled`, takes away only what agents do to agents: off, the person's agents start,
 * run and end as ever, without Facade's tools (AGENT-LAUNCHER.md, L1).
 */
export function activate(context: vscode.ExtensionContext): void {
	// What the layers under the host tell the person goes through @vscode/l10n: in the window's language.
	if (vscode.l10n.bundle) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
	const log = vscode.window.createOutputChannel(vscode.l10n.t("Facade Agents"), { log: true });
	// The agents' last screens open with the agent framework off too: a notice's Show still goes to one (D6)
	const screens = ScreenDocuments.register();
	context.subscriptions.push(screens.registration);
	let service: AgentsService | undefined;
	/** The service while it starts: the extension host can go meanwhile, as a folder window becomes a workspace. */
	let creating: AgentsService | undefined;
	/** Why there is no service, for the person who asks for one: no folder open, or a start that failed. */
	let none: 'noFolder' | 'failed' | undefined;
	let deactivated = false;
	const start = async () => {
		if (!context.storageUri) {
			log.info('Facade agents require an open folder or workspace. Nothing was started.');
			none = 'noFolder';
			return;
		}
		const created = creating = new AgentsService(log, context.workspaceState, screens.documents);
		try {
			await created.start();
			// Deactivated while it started: what it took since - the ledger's lock, the pipe - goes at once.
			if (deactivated) {
				created.dispose();
				return;
			}
			service = created;
		} catch (err) {
			created.dispose('facade');
			none = 'failed';
			log.error(`Could not start Facade agents: ${stackOf(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start: {0}", messageOf(err)));
		} finally {
			creating = undefined;
		}
	};
	// Settles once the service has started, or could not: it rejects nothing.
	const ready = start();
	// The record this window has, as its service knows it - which follows the window through its folder
	// becoming a workspace - and else the one this workspace's storage names (X-67)
	context.subscriptions.push(vscode.commands.registerCommand('facade.agents.showLog', () => showAgentsLog(service?.agentsLog ?? creating?.agentsLog ?? agentsLogOf(context.workspaceState))), registerShowLaunch(async (installed, folder) => {
		// What would refuse a start, as the window's core checks it once it has started
		await ready;
		return await service?.launchProblems(installed, folder) ?? [];
	}));
	context.subscriptions.push(
		// `(folder)`: the person is deleting that worktree in the window - Facade's word first on its agents still starting (N-34)
		vscode.commands.registerCommand('_facade.agents.worktreeDeleting', async (folder?: unknown) => {
			if (folder instanceof vscode.Uri && folder.scheme === 'file') {
				await service?.worktreeDeleting(folder.fsPath);
			}
		}),
		// `(workspace, id)`: the person stops that agent from the window - one with no terminal yet (L3)
		vscode.commands.registerCommand('_facade.agents.stopAgent', async (workspace?: unknown, id?: unknown) => {
			await ready;
			if (typeof workspace === 'string' && typeof id === 'number') {
				await service?.stopFromWindow(workspace, id);
			}
		}),
		// `(folder)`: the window deleted that worktree - git is done - which its record says, the host that asked for it
		// started again meanwhile or not (O5)
		vscode.commands.registerCommand('_facade.agents.worktreeDeleted', async (folder?: unknown) => {
			await ready;
			if (folder instanceof vscode.Uri && folder.scheme === 'file') {
				service?.worktreeDeleted(folder.fsPath);
			}
		}),
		// `(folder)`: the person's deletion of that worktree failed in the window - agents can start there again (O5; OR-10)
		vscode.commands.registerCommand('_facade.agents.worktreeDeleteFailed', async (folder?: unknown) => {
			await ready;
			if (folder instanceof vscode.Uri && folder.scheme === 'file') {
				service?.worktreeDeleteFailed(folder.fsPath);
			}
		}),
		vscode.commands.registerCommand('facade.agents.startAgent', async (args?: unknown) => {
			// The first start can come as the extension comes up - the person trusted the workspace from the
			// agent menu, which activated it - and waits for it rather than asking them to try again.
			await ready;
			if (!service) {
				// A failure as one (UI-17); a folder to open, as news
				void (none === 'failed'
					? vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start in this window: the Facade Agents output says why."))
					: vscode.window.showInformationMessage(vscode.l10n.t("Open a folder on this machine to start an agent in it.")));
				return undefined;
			}
			return service.startAgentCommand(args);
		}),
		vscode.commands.registerCommand('facade.agents.openChatRoom', () => withService(running => running.openChatRoomCommand())),
		vscode.commands.registerCommand('facade.agents.deleteChatRooms', () => withService(running => running.deleteChatRoomsCommand())),
		{ dispose: () => void stopAgents?.() }
	);
	/** Runs a command of the service's once it has started, or tells the person why there is none. */
	async function withService(command: (running: AgentsService) => Promise<void>): Promise<void> {
		await ready;
		if (!service) {
			void (none === 'failed'
				? vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start in this window: the Facade Agents output says why."))
				: vscode.window.showInformationMessage(vscode.l10n.t("Open a folder on this machine to have agents in it.")));
			return;
		}
		await command(service);
	}
	// Once, by `deactivate` - which the extension host waits for, a while - or else with the subscriptions.
	// ⚠️ The log goes last: the service writes to it until its ledger is closed, which waits for the calls
	// under way.
	let stopping: Promise<void> | undefined;
	stopAgents = () => stopping ??= (async () => {
		deactivated = true;
		creating?.dispose();
		await service?.dispose();
		log.dispose();
	})();
}

/**
 * Facade: Show Agents Log: opens the person's history of this workspace's agents, each start and each
 * end, whether Facade runs now or not.
 */
async function showAgentsLog(file: string | undefined): Promise<void> {
	if (!file || !fs.existsSync(file)) {
		void vscode.window.showInformationMessage(vscode.l10n.t("No agent has started in this workspace yet."));
		return;
	}
	await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
}

/**
 * Stops Facade's agents: settles once the workspace's ledger is closed, after the calls under way recorded
 * what they did - which the extension host waits for, a few seconds at most.
 */
export function deactivate(): Promise<void> | undefined {
	return stopAgents?.();
}
