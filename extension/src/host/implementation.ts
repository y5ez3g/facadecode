/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { withLongFileLock } from '../base/lock';
import { isJsonObject } from '../base/json';
import { isOwnerClaim } from '../base/ownership';
import { isWindowIdentity, WINDOW_IDENTITY_COMMAND, WINDOW_LEGACY_HANDOFF_COMMAND } from '../base/windowIdentity';
import { workspaceRecord } from '../record/workspace';
import { COMMANDS, PANEL_VIEW } from '../ui/catalog';
import { FACADE_PROGRAM } from './framework/daemonTypes';
import { approveLegacyCutover, checkLegacyCutover, cutoverPlanIdentity, type CutoverState, type LegacyCutoverScope } from './legacyCutover';
import { isLegacyWorkspaceKey, type LegacyPredecessor } from './legacyPins';

const CHECK_MS = 2_000;

async function resolvePredecessor(home: string): Promise<
	{ readonly predecessor: LegacyPredecessor; readonly scope: LegacyCutoverScope } | undefined
> {
	const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString());
	const session = vscode.env.sessionId;
	const uri = (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString() ?? `untitled:${session}`;
	const identify = async (command: string, ...args: string[]): Promise<unknown> => {
		try { return await vscode.commands.executeCommand(command, session, ...args); }
		catch { return undefined; }
	};
	const reply = await identify(WINDOW_IDENTITY_COMMAND);
	const window = isWindowIdentity(reply, session) ? reply : undefined;
	const record = workspaceRecord(uri, home, undefined,
		window ? { token: window.token, folders } : undefined);
	const owner = record.handedOver ?? record.binding.key ?? (window && !folders.length
		? folderlessOwner(home, window.token, uri) : undefined);
	if (!owner) { return undefined; }
	const handoff = window && window.remote === undefined && vscode.env.remoteName === undefined
		? await identify(WINDOW_LEGACY_HANDOFF_COMMAND, owner) : undefined;
	const retired = isJsonObject(handoff) && handoff.version === 1 && handoff.session === session && handoff.token === window?.token
		&& isOwnerClaim(handoff.claim) && handoff.claim.owner === owner ? handoff.claim : undefined;
	return { predecessor: { owner, window }, scope: { owner, retired } };
}

function folderlessOwner(home: string, token: string, uri: string): string | undefined {
	const key = createHash('sha256').update(token).digest('hex').slice(0, 16);
	try {
		const prior: unknown = JSON.parse(fs.readFileSync(path.join(home, 'windows', `${key}.json`), 'utf8'));
		const normalized = uri.replace(/\/+$/, '');
		const expected = process.platform === 'linux' ? normalized : normalized.toLowerCase();
		if (isJsonObject(prior) && isLegacyWorkspaceKey(prior.key) && Array.isArray(prior.folders) && !prior.folders.length
			&& typeof prior.uri === 'string' && (prior.uri === expected
				|| prior.uri.startsWith('untitled:') && expected.startsWith('untitled:'))) {
			return prior.key;
		}
	} catch { /* No verified native predecessor. */ }
	return undefined;
}

function status(state: CutoverState): string {
	if (state.unavailable.length) {
		return vscode.l10n.t('Could not verify legacy agent processes. Facade Code will check again. {0}', state.unavailable.join('; '));
	}
	// Ask for consent before suggesting a stop in another window. That stop can remove the source Pin.
	if (state.plan) {
		return vscode.l10n.t('Switch to Facade Code Framework to recover the saved Pins.');
	}
	if (state.waitingForOwner > 0) {
		return vscode.l10n.t('Waiting for {0} legacy agents in their owning workspaces to exit. You can stop them in those windows.', state.waitingForOwner);
	}
	const waiting = vscode.l10n.t('Waiting to confirm that {0} legacy agent processes have exited.', state.unconfirmed);
	return [waiting, ...state.pendingExits ?? []].join(' ');
}

/** ARCHITECTURE-1.4. A pending cutover owns the consent notice for this workspace. */
export async function prepareFramework(context: vscode.ExtensionContext, home: string,
	resolved?: (prior: LegacyPredecessor | undefined) => void): Promise<vscode.Disposable | undefined> {
	if (!fs.existsSync(path.join(context.extensionPath, FACADE_PROGRAM))) {
		throw new Error(vscode.l10n.t('The Facade Code Framework program is missing from this extension.'));
	}

	const prior = await resolvePredecessor(home);
	resolved?.(prior?.predecessor);
	const scope = prior?.scope;
	const initial = await checkLegacyCutover(home, scope).catch((error): CutoverState => ({
		ready: false, unavailable: [messageOf(error)], unconfirmed: 0, waitingForOwner: 0
	}));
	if (initial.ready) { return undefined; }

	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let checking = false;
	let prompting = false;
	let offered: string | undefined;
	let view: vscode.WebviewView | undefined;
	let current = initial;
	let description = status(current);
	let cancelNotice: (() => void) | undefined;
	const panel = vscode.window.registerWebviewViewProvider(PANEL_VIEW, {
		resolveWebviewView: opened => {
			view = opened;
			render();
		}
	});
	const commands = Object.values(COMMANDS).map(id => vscode.commands.registerCommand(id, () => {
		offered = undefined;
		if (current.plan && !prompting) { offer(); }
		else { void vscode.window.showInformationMessage(description); }
	}));
	const pending = vscode.Disposable.from(panel, ...commands, { dispose() {
		disposed = true;
		clearTimeout(timer);
		cancelNotice?.();
	} });
	context.subscriptions.push(pending);

	function render(): void {
		if (!view || disposed) { return; }
		view.webview.options = { enableScripts: false };
		const escaped = description.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
		view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body><p style="padding: 0 8px; overflow-wrap: anywhere">${escaped}</p></body></html>`;
	}

	function offer(): void {
		const plan = current.plan;
		if (prompting || !plan || !scope || disposed) { return; }
		if (offered === cutoverPlanIdentity(plan)) { return; }
		prompting = true;
		// Only the windows that share this verified owner serialize their notices.
		void withLongFileLock(path.join(home, 'claims', `legacy-cutover-notice-${scope.owner}`), async () => {
			if (disposed || !current.plan) { return; }
			const visible = await resolvePredecessor(home);
			if (visible?.scope.owner !== scope.owner) { return; }
			const latest = await checkLegacyCutover(home, visible.scope);
			if (!latest.plan || disposed) { return; }
			offered = cutoverPlanIdentity(latest.plan);
			const pins = Object.values(latest.plan.snapshots).reduce((sum, each) => sum + each.pins.length + each.unrecognized.length, 0);
			const action = vscode.l10n.t('Switch and Resume Pins');
			const cancel = new Promise<undefined>(resolve => { cancelNotice = () => resolve(undefined); });
			const chosen = await Promise.race([vscode.window.showWarningMessage(vscode.l10n.t(
				'Switch to Facade Code Framework? This authorizes stopping {0} legacy agents and recovering {1} saved Pins. Agents claimed by another window must exit there.',
				latest.plan.runs.length, pins
			), action), cancel]);
			cancelNotice = undefined;
			if (chosen !== action || disposed) { return; }
			const verified = await resolvePredecessor(home);
			if (verified?.scope.owner !== scope.owner || !await approveLegacyCutover(home, verified.scope, latest.plan)) {
				offered = undefined;
			}
		}, 0).catch(error => {
			// Another open window may be presenting the notice. Recheck its result on the next poll.
			if (offered && !disposed) {
				description = vscode.l10n.t('Could not prepare the legacy cutover. {0}', messageOf(error));
				render();
			}
		}).finally(() => { prompting = false; });
	}

	async function poll(): Promise<void> {
		if (disposed || checking) { return; }
		checking = true;
		try {
			const verified = await resolvePredecessor(home);
			if (disposed) { return; }
			const latestScope = verified?.scope;
			current = await checkLegacyCutover(home, scope && (latestScope?.owner === scope.owner ? latestScope : { owner: scope.owner }));
			if (disposed) { return; }
			if (current.ready) {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
				return;
			}
			description = status(current);
			render();
			offer();
		} catch (error) {
			description = vscode.l10n.t('Could not verify legacy agent processes. Facade Code will check again. {0}', messageOf(error));
			render();
		} finally {
			checking = false;
			if (!disposed && !current.ready) {
				timer = setTimeout(() => void poll(), CHECK_MS);
				timer.unref?.();
			}
		}
	}

	offer();
	void poll();
	return pending;
}
