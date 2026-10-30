/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WINDOW_IDENTITY_COMMAND, WINDOW_TERMINALS_COMMAND, type WindowIdentity } from '../base/windowIdentity';
import { windowToken } from '../record/windowIdentity';
import { WindowTerminals } from './windowTerminals';

/** The local component has no exported API and no process ownership; its public command serves this window alone. */
export function activate(context: vscode.ExtensionContext): void {
	let token: string;
	try {
		token = windowToken(context.logUri.fsPath);
	} catch (error) {
		console.error('Could not read the local window handover record.', error);
		throw new Error(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
	}
	const terminals = new WindowTerminals({ directory: context.logUri.fsPath, log: line => console.error(line) });
	context.subscriptions.push(terminals,
		vscode.commands.registerCommand(WINDOW_TERMINALS_COMMAND, (request: unknown, terminal?: unknown) => terminals.request(request, terminal)),
		vscode.commands.registerCommand(WINDOW_IDENTITY_COMMAND, (session: unknown): WindowIdentity | undefined => {
		if (session !== vscode.env.sessionId) {
			return undefined;
		}
		// The workspace extension host has its folders as file: URIs; the remote host's name is the local window's alone
		const remote = vscode.env.remoteName === undefined ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri.authority || vscode.workspace.workspaceFile?.authority;
		return { version: 1, token, session: vscode.env.sessionId, ...(remote ? { remote } : {}) };
	}));
}
