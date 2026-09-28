/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WorkspaceService } from './host/workspaceService';

/*
 * Facade Code: the person and the agents in a workspace, working together through a small set of
 * primitives (L2-PLAN, milestone 1). The switch is `facade.orchestration.enabled`: off, this extension
 * starts nothing, writes nothing and launches nothing, and Facade is what L1 left it.
 */

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t("Facade Agents"), { log: true });
	context.subscriptions.push(log, vscode.commands.registerCommand('facade.agents.showLog', () => log.show()));

	let service: WorkspaceService | undefined;
	let starting: Promise<void> = Promise.resolve();
	const sync = () => {
		starting = starting.then(async () => {
			const enabled = vscode.workspace.getConfiguration('facade.orchestration').get<boolean>('enabled', false);
			if (enabled && !service) {
				if (!context.storageUri) {
					log.info('Facade agents need a folder or workspace open; nothing started.');
					return;
				}
				const created = new WorkspaceService(context, log);
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
