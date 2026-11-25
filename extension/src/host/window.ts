/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import {
	WINDOW_IDENTITY_COMMAND, WINDOW_LEGACY_INSTANCE_COMMAND, WINDOW_TERMINAL_OWNER_COMMAND, WINDOW_TERMINALS_COMMAND,
	type DamagedWindowIdentity, type LegacyWindowInstance, type UnreadableWindowIdentity, type WindowIdentity, type WindowTerminalIdentity
} from '../base/windowIdentity';
import { DamagedWindowRecord, windowToken } from '../record/windowIdentity';
import { homeRecordOf, homeReloadText, rememberHome, UnusableHome, useFacadeHome, useRememberedHome } from './home';
import { WindowTerminals } from './windowTerminals';

/** Provide session-scoped identity and native terminal handles from the local UI host. */
export function activate(context: vscode.ExtensionContext): void {
	const directory = context.logUri.fsPath;
	const here = (session: unknown) => session === vscode.env.sessionId;
	const log = (line: string) => console.error(line);
	const terminals = new WindowTerminals({ directory, log });
	let token: string | undefined;
	let hasHome: boolean | undefined;
	let previousInstance: string | undefined;
	const handover = () => {
		if (!token) {
			const previous = fs.existsSync(path.join(directory, 'handover.json'));
			token = windowToken(directory);
			if (previous) {
				previousInstance = 'win-' + createHash('sha256').update('facade-window:' + token).digest('hex').slice(0, 16);
			}
		}
		return token;
	};
	context.subscriptions.push(
		terminals,
		vscode.commands.registerCommand(WINDOW_TERMINALS_COMMAND, (request: unknown, terminal?: unknown) => terminals.request(request, terminal)),
		vscode.commands.registerCommand(WINDOW_TERMINAL_OWNER_COMMAND, (session: unknown): WindowTerminalIdentity | undefined => {
			if (!here(session)) { return undefined; }
			return { version: 1, token: handover(), session: vscode.env.sessionId };
		}),
		vscode.commands.registerCommand(WINDOW_LEGACY_INSTANCE_COMMAND, (session: unknown): LegacyWindowInstance | undefined => {
			if (!here(session)) { return undefined; }
			if (!token && fs.existsSync(path.join(directory, 'handover.json'))) { handover(); }
			return token && previousInstance ? { version: 1, token, session: vscode.env.sessionId, instanceId: previousInstance } : undefined;
		}),
		vscode.commands.registerCommand(WINDOW_IDENTITY_COMMAND, (session: unknown): WindowIdentity | DamagedWindowIdentity | UnreadableWindowIdentity | undefined => {
			if (!here(session)) { return undefined; }
			const id = { version: 1 as const, session: vscode.env.sessionId };
			let token: string;
			try {
				token = handover();
			} catch (error) {
				console.error('Could not read the local window handover record.', error);
				return error instanceof DamagedWindowRecord ? { ...id, damaged: true } : { ...id, unreadable: messageOf(error) };
			}
			hasHome ??= useWindowHome(context);
			if (!hasHome) { return undefined; }
			// Only the local host sees the Remote-SSH authority; the workspace's folders are file URIs there.
			const remote = vscode.env.remoteName === undefined ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri.authority || vscode.workspace.workspaceFile?.authority;
			return { ...id, token, ...(remote ? { remote } : {}), component: String(context.extension.packageJSON.version) };
		}),
	);
}

/** Preserve the local component's Facade Home settings and native reload offer. */
function useWindowHome(context: vscode.ExtensionContext): boolean {
	if (vscode.env.remoteName !== undefined) {
		useRememberedHome(context, homeReloadText);
		return true;
	}
	const record = homeRecordOf(context);
	const log = (line: string) => console.error(line);
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('facade.home')) { rememberHome(record, log); }
	}));
	rememberHome(record, log);
	try {
		useFacadeHome(context, { terminals: false, offerReload: false, reloadText: homeReloadText });
		return true;
	} catch (error) {
		if (error instanceof UnusableHome) { return false; }
		throw error;
	}
}
