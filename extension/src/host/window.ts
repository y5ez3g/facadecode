/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { WINDOW_IDENTITY_COMMAND, WINDOW_TERMINALS_COMMAND, type DamagedWindowIdentity, type WindowIdentity } from '../base/windowIdentity';
import {
	AGENTS_ROUTE_COMMAND, Allocation, Directory, isDirectoryAgent, isRouteRequest, RouteResponse, ServedRoute, WINDOW_ALLOCATE_COMMAND,
	WINDOW_DIRECTORY_COMMAND, WINDOW_PUBLISH_COMMAND, WINDOW_ROUTE_COMMAND
} from '../base/windowNetwork';
import { facadeHome } from '../record/paths';
import { DamagedWindowRecord, windowToken } from '../record/windowIdentity';
import { editorEnvironment } from './editorEnvironment';
import { NotServed, WindowNetwork } from './windowNetwork';
import { WindowTerminals } from './windowTerminals';

/** Serves a request another window routed here through this window's workspace extension, within the request's own time. */
async function serveHere(request: ServedRoute): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(vscode.commands.executeCommand(AGENTS_ROUTE_COMMAND, request)).catch(err => {
				// The editor's own words for a command no extension registered: no workspace extension serves this window now
				throw messageOf(err).includes(`'${AGENTS_ROUTE_COMMAND}' not found`) ? new NotServed() : err;
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`This Facade window did not answer within ${Math.round(request.deadlineMs / 100) / 10} seconds; whether the request took effect is not known.`)), Math.max(0, request.deadlineMs));
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The local component has no exported API and no process ownership; its public command serves this window alone. */
export function activate(context: vscode.ExtensionContext): void {
	let token: string;
	try {
		token = windowToken(context.logUri.fsPath);
	} catch (error) {
		console.error('Could not read the local window handover record.', error);
		if (!(error instanceof DamagedWindowRecord)) {
			// Not read or written now - a lock, no file handles left - which a reload may not meet again
			throw new Error(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
		}
		// Damaged: no other identity is invented (ARCHITECTURE-2.2). The workspace component asks, and says what helps: not a reload,
		// which reads this record again
		context.subscriptions.push(vscode.commands.registerCommand(WINDOW_IDENTITY_COMMAND, (session: unknown): DamagedWindowIdentity | undefined =>
			session === vscode.env.sessionId ? { version: 1, session, damaged: true } : undefined));
		return;
	}
	const terminals = new WindowTerminals({ directory: context.logUri.fsPath, log: line => console.error(line) });
	// This window on the client network: registered on this computer, reachable by the others (ARCHITECTURE-2.1)
	const network = new WindowNetwork({
		home: facadeHome(),
		token,
		label: () => vscode.workspace.name ?? vscode.l10n.t('Window'),
		environment: editorEnvironment(),
		serve: serveHere,
		log: line => console.error(line)
	});
	const started = network.start().catch(err => console.error(`Could not join the Facade network: ${messageOf(err)}`));
	const here = (session: unknown) => session === vscode.env.sessionId;
	context.subscriptions.push({ dispose: () => network.dispose() },
		vscode.commands.registerCommand(WINDOW_DIRECTORY_COMMAND, async (session: unknown): Promise<Directory | undefined> => {
			if (!here(session)) {
				return undefined;
			}
			await started;
			return network.directory();
		}),
		vscode.commands.registerCommand(WINDOW_ROUTE_COMMAND, async (session: unknown, request: unknown): Promise<RouteResponse | undefined> => {
			if (!here(session) || !isRouteRequest(request)) {
				return undefined;
			}
			await started;
			return network.route(request);
		}),
		vscode.commands.registerCommand(WINDOW_PUBLISH_COMMAND, (session: unknown, agents: unknown, label: unknown) => {
			if (here(session) && Array.isArray(agents) && agents.every(isDirectoryAgent)) {
				void started.then(() => network.publish(agents, typeof label === 'string' && label ? label : undefined));
			}
		}),
		vscode.commands.registerCommand(WINDOW_ALLOCATE_COMMAND, (session: unknown, kind: unknown, count: unknown, floor: unknown): Allocation | undefined => {
			if (!here(session) || (kind !== 'agent' && kind !== 'message') || typeof count !== 'number') {
				return undefined;
			}
			return network.allocate(kind, count, typeof floor === 'number' ? floor : 0);
		}),
		terminals,
		vscode.commands.registerCommand(WINDOW_TERMINALS_COMMAND, (request: unknown, terminal?: unknown) => terminals.request(request, terminal)),
		vscode.commands.registerCommand(WINDOW_IDENTITY_COMMAND, (session: unknown): WindowIdentity | undefined => {
		if (session !== vscode.env.sessionId) {
			return undefined;
		}
		// The workspace extension host has its folders as file: URIs; the remote host's name is the local window's alone
		const remote = vscode.env.remoteName === undefined ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri.authority || vscode.workspace.workspaceFile?.authority;
		return { version: 1, token, session: vscode.env.sessionId, ...(remote ? { remote } : {}), component: String(context.extension.packageJSON.version) };
	}));
}
