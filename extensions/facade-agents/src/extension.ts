/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { messageOf, stackOf } from './base/errors';
import { agentsLogOf, AgentsService } from './host/service';
import { registerShowLaunch } from './host/showLaunch';

/**
 * Facade's agents: vendors' agent CLIs and the person's own in their own UIs, in the folders and worktrees
 * of this window, starting, listing and ending each other through Facade's MCP server. The agent
 * framework's switch, `facade.orchestration.enabled`, takes away only what agents do to agents: off, the
 * person's agents start, run and end as ever, without Facade's tools (AGENT-LAUNCHER.md, L1).
 */
export function activate(context: vscode.ExtensionContext): void {
	// What the layers under the host tell the person goes through @vscode/l10n: in the window's language.
	if (vscode.l10n.bundle) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
	const log = vscode.window.createOutputChannel(vscode.l10n.t("Facade Agents"), { log: true });
	context.subscriptions.push(log, vscode.commands.registerCommand('facade.agents.showLog', () => showAgentsLog(context.workspaceState)), registerShowLaunch());

	let service: AgentsService | undefined;
	/** The service while it starts: the extension host can go meanwhile, as a folder window becomes a workspace. */
	let creating: AgentsService | undefined;
	/** Why there is no service, for the person who asks for one: no folder open, or a start that failed. */
	let none: 'noFolder' | 'failed' | undefined;
	let deactivated = false;
	const start = async () => {
		if (!context.storageUri) {
			log.info('Facade agents need a folder or workspace open; nothing started.');
			none = 'noFolder';
			return;
		}
		const created = creating = new AgentsService(log, context.workspaceState);
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
			log.error(`Facade agents could not start: ${stackOf(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start: {0}", messageOf(err)));
		} finally {
			creating = undefined;
		}
	};
	// Settles once the service has started, or could not: it rejects nothing.
	const ready = start();
	context.subscriptions.push(
		vscode.commands.registerCommand('facade.agents.startAgent', async (args?: unknown) => {
			// The first start can come as the extension comes up - the person trusted the workspace from the
			// agent menu, which activated it - and waits for it rather than asking them to try again.
			await ready;
			if (!service) {
				void vscode.window.showInformationMessage(none === 'failed'
					? vscode.l10n.t("Facade agents could not start in this window: the Facade Agents output says why.")
					: vscode.l10n.t("Open a folder on this machine to start an agent in it."));
				return undefined;
			}
			return service.startAgentCommand(args);
		}),
		{
			dispose: () => {
				deactivated = true;
				service?.dispose();
				creating?.dispose();
			}
		}
	);
}

/**
 * Facade: Show Agents Log: opens the person's history of this workspace's agents, each start and each
 * end, whether Facade runs now or not.
 */
async function showAgentsLog(workspaceState: vscode.Memento): Promise<void> {
	const file = agentsLogOf(workspaceState);
	if (!file || !fs.existsSync(file)) {
		void vscode.window.showInformationMessage(vscode.l10n.t("No agent has started in this workspace yet."));
		return;
	}
	await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
}

/** Nothing to do: what `activate` started goes with the extension's subscriptions. */
export function deactivate(): void { }
