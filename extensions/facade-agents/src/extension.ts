/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentsService } from './host/service';

/**
 * Facade's agents: vendors' agent CLIs in their own UIs, in the worktrees of this window, with
 * Facade's MCP server (WORKTREE-AGENTS.md). The switch is `facade.orchestration.enabled`: off, this
 * extension starts nothing, writes nothing and launches nothing, and Facade is what L1 left it.
 */
export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t("Facade Agents"), { log: true });
	context.subscriptions.push(log, vscode.commands.registerCommand('facade.agents.showLog', () => log.show()));

	let service: AgentsService | undefined;
	let starting: Promise<void> = Promise.resolve();
	const sync = () => {
		starting = starting.then(async () => {
			const enabled = vscode.workspace.getConfiguration('facade.orchestration').get<boolean>('enabled', false);
			if (enabled && !service) {
				if (!context.storageUri) {
					log.info('Facade agents need a folder or workspace open; nothing started.');
					return;
				}
				const created = new AgentsService(log);
				try {
					await created.start();
					service = created;
				} catch (err) {
					created.dispose();
					log.error(`Facade agents could not start: ${(err as Error).stack ?? err}`);
					void vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start: {0}", (err as Error).message));
				}
			} else if (!enabled && service) {
				service.dispose();
				service = undefined;
				log.info('Facade agents are off.');
			}
		});
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('facade.agents.startAgent', (args?: unknown) => {
			if (!service) {
				void vscode.window.showInformationMessage(vscode.l10n.t("Facade agents are off. Turn on the setting facade.orchestration.enabled, in a window with a folder open."));
				return undefined;
			}
			return service.startAgentCommand(args);
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.orchestration.enabled')) {
				sync();
			}
		}),
		{ dispose: () => service?.dispose() }
	);
	sync();
}

export function deactivate(): void { }
