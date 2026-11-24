/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { monotonic } from '../base/clock';
import { expiredRoute, RouteExpired, spendRouteTime, withinRoute } from '../base/routeBudget';
import {
	WINDOW_IDENTITY_COMMAND, WINDOW_LEGACY_INSTANCE_COMMAND, WINDOW_TERMINAL_OWNER_COMMAND, WINDOW_TERMINALS_COMMAND,
	type DamagedWindowIdentity, type LegacyWindowInstance, type UnreadableWindowIdentity, type WindowIdentity, type WindowTerminalIdentity
} from '../base/windowIdentity';
import {
	AGENTS_ROUTE_COMMAND, Allocation, Directory, isDirectoryAgent, isRouteRequest, PublishStatus, RouteResponse, ServedRoute, WINDOW_ALLOCATE_COMMAND,
	WINDOW_DIRECTORY_COMMAND, WINDOW_PUBLISH_COMMAND, WINDOW_ROUTE_COMMAND, WORKSPACE_REPUBLISH_COMMAND
} from '../base/windowNetwork';
import { facadeHome } from '../record/paths';
import { DamagedWindowRecord, windowToken } from '../record/windowIdentity';
import { editorEnvironment } from './editorEnvironment';
import { homeRecordOf, homeReloadText, rememberHome, UnusableHome, useFacadeHome, useRememberedHome } from './home';
import { NotServed, windowAddress, WindowNetwork } from './windowNetwork';
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

/** The local component's terminal registry and the entry to its legacy implementation window services. */
export function activate(context: vscode.ExtensionContext): void {
	const directory = context.logUri.fsPath;
	const here = (session: unknown) => session === vscode.env.sessionId;
	const log = (line: string) => console.error(line);
	const terminals = new WindowTerminals({ directory, log });
	let oldStarted: boolean | undefined;
	let token: string | undefined;
	let previousInstance: string | undefined;
	const handover = () => {
		if (!token) {
			const previous = fs.existsSync(path.join(directory, 'handover.json'));
			token = windowToken(directory);
			if (previous) { previousInstance = windowAddress(token); }
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
			oldStarted ??= startOldWindow(context, token);
			if (!oldStarted) { return undefined; }
			// Only the local host sees the Remote-SSH authority; the workspace's folders are file URIs there.
			const remote = vscode.env.remoteName === undefined ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri.authority || vscode.workspace.workspaceFile?.authority;
			return { ...id, token, ...(remote ? { remote } : {}), component: String(context.extension.packageJSON.version) };
		}),
	);
}

/** The legacy host asks for its window identity before it uses these services. */
function startOldWindow(context: vscode.ExtensionContext, token: string): boolean {
	// The Facade home first, before the window registry reads it (ARCHITECTURE-3.1): this computer's. A local window's workspace
	// extension shares this process, sets the same and says what is wrong with it; this component writes it down, now and as it changes.
	// In a remote window VS Code gives no extension this computer's Facade: Home - it keeps machine settings for the remote one - so its
	// component reads what the local windows wrote down, never the remote machine's value
	if (vscode.env.remoteName === undefined) {
		const record = homeRecordOf(context);
		const log = (line: string) => console.error(line);
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.home')) {
				rememberHome(record, log);
			}
		}));
		rememberHome(record, log);
		try {
			useFacadeHome(context, { terminals: false, offerReload: false, reloadText: homeReloadText });
		} catch (err) {
			if (!(err instanceof UnusableHome)) {
				throw err;
			}
			return false;
		}
	} else {
		useRememberedHome(context, homeReloadText);
	}
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
	// Its extension host may have restarted while the workspace extension went on: what the window holds is asked for again, so that
	// other windows find its agents without waiting for one of them to change (ARCHITECTURE-2.1). Unanswered while none runs yet.
	void started.then(() => vscode.commands.executeCommand(WORKSPACE_REPUBLISH_COMMAND, vscode.env.sessionId)).then(undefined, () => undefined);
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
			if (request.deadlineMs <= 0) { return expiredRoute(false); }
			const began = monotonic();
			try { await withinRoute(started, request.deadlineMs); }
			catch (err) { if (err instanceof RouteExpired) { return expiredRoute(false); } throw err; }
			return network.route(spendRouteTime(request, monotonic() - began));
		}),
		vscode.commands.registerCommand(WINDOW_PUBLISH_COMMAND, async (session: unknown, agents: unknown, label: unknown): Promise<PublishStatus | undefined> => {
			if (!here(session) || !Array.isArray(agents) || !agents.every(isDirectoryAgent)) {
				return undefined;
			}
			await started;
			network.publish(agents, typeof label === 'string' && label ? label : undefined);
			// Whether other windows can reach this one: where they cannot, the workspace extension's agents log says why
			return network.status();
		}),
		vscode.commands.registerCommand(WINDOW_ALLOCATE_COMMAND, (session: unknown, kind: unknown, count: unknown, floor: unknown): Allocation | undefined => {
			if (!here(session) || (kind !== 'agent' && kind !== 'message') || typeof count !== 'number') {
				return undefined;
			}
			return network.allocate(kind, count, typeof floor === 'number' ? floor : 0);
		}));
	return true;
}
