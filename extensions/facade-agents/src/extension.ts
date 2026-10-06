/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { messageOf, stackOf } from './base/errors';
import { AgentsService } from './host/service';

/**
 * Facade's agents: vendors' agent CLIs in their own UIs, in the worktrees of this window, run as
 * processes with Facade's MCP server. The switch is `facade.orchestration.enabled`: off, this extension
 * starts nothing, writes nothing and launches nothing.
 */
export function activate(context: vscode.ExtensionContext): void {
	// What the layers under the host tell the person goes through @vscode/l10n: in the window's language.
	if (vscode.l10n.bundle) {
		l10n.config({ contents: vscode.l10n.bundle });
	}
	const log = vscode.window.createOutputChannel(vscode.l10n.t("Facade Agents"), { log: true });
	context.subscriptions.push(log, vscode.commands.registerCommand('facade.agents.showLog', () => log.show()));

	let service: AgentsService | undefined;
	/** The service while it starts: the extension host can go meanwhile, as a folder window becomes a workspace. */
	let creating: AgentsService | undefined;
	/** Why there is no service, for the person who asks for one: the setting off, no folder open, or a start that failed. */
	let none: 'off' | 'noFolder' | 'failed' = 'off';
	let deactivated = false;
	let starting: Promise<void> = Promise.resolve();
	const sync = () => {
		starting = starting.then(async () => {
			const enabled = vscode.workspace.getConfiguration('facade.orchestration').get<boolean>('enabled', false);
			if (enabled && !service) {
				if (!context.storageUri) {
					log.info('Facade agents need a folder or workspace open; nothing started.');
					none = 'noFolder';
					return;
				}
				const created = creating = new AgentsService(log, context.globalState, context.workspaceState);
				try {
					await created.start();
					// Deactivated while it started: what it took since - the ledger's lock, the pipe - goes at once.
					if (deactivated) {
						created.dispose();
						return;
					}
					service = created;
				} catch (err) {
					created.dispose();
					none = 'failed';
					log.error(`Facade agents could not start: ${stackOf(err)}`);
					void vscode.window.showErrorMessage(vscode.l10n.t("Facade agents could not start: {0}", messageOf(err)));
				} finally {
					creating = undefined;
				}
			} else if (!enabled && service) {
				service.dispose();
				service = undefined;
				log.info('Facade agents are off.');
			}
			if (!enabled) {
				none = 'off';
			}
		});
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('facade.agents.startAgent', (args?: unknown) => {
			if (!service) {
				void vscode.window.showInformationMessage(creating
					? vscode.l10n.t("Facade agents are starting in this window, finding the agents that ran here: try again in a moment.")
					: none === 'failed'
						? vscode.l10n.t("Facade agents could not start in this window: Facade: Show Agents Log says why.")
						: none === 'noFolder'
							? vscode.l10n.t("Facade agents need a folder or workspace open in this window.")
							: vscode.l10n.t("Facade agents are off. Turn on the setting facade.orchestration.enabled, in a window with a folder open."));
				return undefined;
			}
			return service.startAgentCommand(args);
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.orchestration.enabled')) {
				sync();
			}
		}),
		{
			dispose: () => {
				deactivated = true;
				service?.dispose();
				creating?.dispose();
			}
		}
	);
	sync();
}

/** Nothing to do: what `activate` started goes with the extension's subscriptions. */
export function deactivate(): void { }
