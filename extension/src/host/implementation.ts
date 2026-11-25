/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { withLongFileLock } from '../base/lock';
import { isWindowIdentity, WINDOW_IDENTITY_COMMAND } from '../base/windowIdentity';
import { workspaceRecord } from '../record/workspace';
import { COMMANDS, PANEL_VIEW } from '../ui/catalog';
import { FACADE_PROGRAM } from './framework/daemonTypes';
import { approveLegacyCutover, checkLegacyCutover, LegacyCustody, type CutoverPlan, type CutoverState } from './legacyCutover';

const CHECK_MS = 2_000;

interface CustodyLease {
	readonly owner: string;
	readonly controller: AbortController;
	custody?: LegacyCustody;
}

function planIdentity(plan: CutoverPlan): string {
	return JSON.stringify(plan.runs.map(run => [run.socket, run.owner, run.run]));
}

async function legacyOwner(context: vscode.ExtensionContext, home: string): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const uri = (vscode.workspace.workspaceFile ?? folders[0]?.uri)?.toString();
	if (!uri) { return undefined; }
	const session = vscode.env.sessionId;
	const identity: unknown = await Promise.resolve(vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, session)).catch(() => undefined);
	const record = workspaceRecord(uri, home, context.workspaceState.get('facade.workspaceKey'),
		isWindowIdentity(identity, session) ? { token: identity.token, folders: folders.map(folder => folder.uri.toString()) } : undefined);
	return record.key === record.binding.key || record.key === record.handedOver ? record.key : undefined;
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

/** ARCHITECTURE-1.4. A pending cutover owns only its notice and observation. Framework starts after a fresh exit check. */
export async function prepareFramework(context: vscode.ExtensionContext, home: string): Promise<vscode.Disposable | undefined> {
	if (!fs.existsSync(path.join(context.extensionPath, FACADE_PROGRAM))) {
		throw new Error(vscode.l10n.t('The Facade Code Framework program is missing from this extension.'));
	}

	const local = vscode.env.remoteName === undefined;
	const initial = await checkLegacyCutover(home).catch((error): CutoverState => ({
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
	let lease: CustodyLease | undefined;
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
		lease?.controller.abort();
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
		if (prompting || !plan || disposed) { return; }
		if (offered === planIdentity(plan)) { return; }
		prompting = true;
		// Only one window presents consent for this execution home while the notice is open.
		void withLongFileLock(path.join(home, 'legacy-cutover-notice'), async () => {
			if (disposed || !current.plan) { return; }
			const latest = await checkLegacyCutover(home);
			if (!latest.plan || disposed) { return; }
			offered = planIdentity(latest.plan);
			const pins = Object.values(latest.plan.snapshots).reduce((sum, each) => sum + each.pins.length + each.unrecognized.length, 0);
			const action = vscode.l10n.t('Switch and Resume Pins');
			const cancel = new Promise<undefined>(resolve => { cancelNotice = () => resolve(undefined); });
			const chosen = await Promise.race([vscode.window.showWarningMessage(vscode.l10n.t(
				'Switch to Facade Code Framework? This authorizes stopping {0} legacy agents and recovering {1} saved Pins. Agents claimed by another window must exit there.',
				latest.plan.runs.length, pins
			), action), cancel]);
			cancelNotice = undefined;
			if (chosen !== action || disposed) { return; }
			if (!await approveLegacyCutover(home, latest.plan)) {
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

	function keepCustody(owner: string | undefined): LegacyCustody | undefined {
		if (!owner || lease?.owner !== owner) {
			lease?.controller.abort();
			lease = undefined;
		}
		if (!owner || lease) { return lease?.custody; }
		const attempt: CustodyLease = { owner, controller: new AbortController() };
		lease = attempt;
		void withLongFileLock(path.join(home, 'claims', `legacy-cutover-${owner}`), async () => {
			const { signal } = attempt.controller;
			if (signal.aborted) { return; }
			attempt.custody = new LegacyCustody(home, owner, local);
			await new Promise<void>(resolve => signal.addEventListener('abort', () => {
				attempt.custody?.dispose();
				resolve();
			}, { once: true }));
		}, 0).catch(() => {
			// Another activation of the workspace holds temporary custody or the lock is presently unavailable.
		}).finally(() => {
			if (lease === attempt) { lease = undefined; }
		});
		return attempt.custody;
	}

	async function poll(): Promise<void> {
		if (disposed || checking) { return; }
		checking = true;
		try {
			const owner = await legacyOwner(context, home);
			if (disposed) { return; }
			current = await checkLegacyCutover(home, keepCustody(owner));
			if (disposed) { return; }
			if (current.ready) {
				lease?.controller.abort();
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
