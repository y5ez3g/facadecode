/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { whyNotInstalled } from '../clis/config';
import { launchDocument } from '../clis/describe';
import { launchTarget } from '../clis/executable';
import { installedClis, knownClis } from '../clis/registry';
import { configFor } from './settings';

/** Where the document Facade: Show Agent Launch shows lives: read-only, as a provider's documents are. */
const LAUNCH = vscode.Uri.from({ scheme: 'facade-agents', path: '/agent-launch.jsonc' });

/**
 * Facade: Show Agent Launch: a read-only document of what Facade starts each CLI with now, whether or
 * not its agents are on, which follows the person's settings as they change them, and is read again
 * each time the person asks for it: a CLI installed meanwhile shows.
 */
export function registerShowLaunch(): vscode.Disposable {
	const changed = new vscode.EventEmitter<vscode.Uri>();
	const provider: vscode.TextDocumentContentProvider = {
		onDidChange: changed.event,
		provideTextDocumentContent: () => {
			const installed = installedClis(configFor);
			return launchDocument(knownClis().map(cli => {
				const config = configFor(cli);
				const found = installed.find(each => each.cli.id === cli.id);
				return {
					cli,
					config,
					yours: vscode.workspace.getConfiguration(`facade.orchestration.${cli.section}`).get('launch'),
					program: found ? { target: launchTarget(found.executable) } : { missing: whyNotInstalled(cli, config) }
				};
			}));
		}
	};
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(LAUNCH.scheme, provider),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.orchestration')) {
				changed.fire(LAUNCH);
			}
		}),
		vscode.commands.registerCommand('facade.agents.showLaunch', async () => {
			// A document open already is read again.
			changed.fire(LAUNCH);
			const document = await vscode.workspace.openTextDocument(LAUNCH);
			await vscode.window.showTextDocument(await vscode.languages.setTextDocumentLanguage(document, 'jsonc'), { preview: false });
		})
	);
}
