/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { COMMANDS } from '../ui/catalog';

const SCHEME = 'facade-agents-log';

/** The agents log as its document shows it: as it is, or `No agent events yet` where it is empty or cannot be read. */
export function agentsLogText(file: string): string {
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		text = '';
	}
	return text.trim() ? text : `${vscode.l10n.t("No agent events yet")}\n`;
}

/** Show Agents Log (ARCHITECTURE-3.3): a read-only document of this window's agents log, read again each time it is shown, with no toast. */
export function registerAgentsLog(file: string): vscode.Disposable {
	const changed = new vscode.EventEmitter<vscode.Uri>();
	const uri = vscode.Uri.from({ scheme: SCHEME, path: '/Agents Log' });
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, { onDidChange: changed.event, provideTextDocumentContent: () => agentsLogText(file) }),
		vscode.commands.registerCommand(COMMANDS.showAgentsLog, async () => {
			changed.fire(uri);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		})
	);
}
