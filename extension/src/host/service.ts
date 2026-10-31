/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { disposeAll } from '../base/lifecycle';
import { isDamagedWindowIdentity, isWindowIdentity, WINDOW_IDENTITY_COMMAND, WINDOW_TERMINALS_COMMAND } from '../base/windowIdentity';
import { AgentService } from '../core/agents';
import { PlanError, type LogPort, type RunFacts } from '../core/ports';
import { PANEL_VIEW } from '../ui/catalog';
import { worktreeProblemText } from '../ui/pickers/location';
import { reasonText } from '../ui/presentation';
import { registerUi } from '../ui/commands/index';
import { registerWorktreeCommands } from '../ui/commands/worktree';
import { AgentExecution } from './execution/agentExecution';
import { RECONCILE_MS } from './execution/executionSession';
import { AliasCounter } from '../record/aliases';
import { AgentLog } from '../record/log';
import { facadeHome } from '../record/paths';
import { RetainedFile } from '../record/retained';
import { nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { keepWindowKey, keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { HostClis } from './clis';
import { WorkspaceLaunchHistory } from './history';
import { WindowHuman } from './human';
import { createLocationService, createWorktreeService } from './locations/index';
import { yolo } from './settings';
import { WindowLifetime } from './windowLifetime';
import { KeptWorkspaceState } from './workspaceState';

/** Where the window's workspace keeps its key, for the window's reloads (ARCHITECTURE-2.2). */
const WORKSPACE_KEY = 'facade.workspaceKey';
/** The longest wait between attempts to list this window's runs: well within the five minutes they are kept for it (RULES-4.1). */
const MOST_RESTORE_WAIT_MS = 30_000;

/** Why this window's Facade could not start, in the person's words: shown as it is; `reloadHelps` where reloading tries again. */
export class ActivationError extends Error {
	constructor(message: string, readonly reloadHelps = true) {
		super(message);
	}
}

/**
 * A window whose Facade could not start says why where the person looks - a notification, with the reload that tries again where
 * one can help, and the panel in place of a progress that would never end - not only in the editor's log (UX-2.4).
 */
export function sayActivationFailed(context: vscode.ExtensionContext, err: unknown): void {
	const text = err instanceof ActivationError ? err.message : vscode.l10n.t("Could not start {0}: {1}.", 'Facade Code', messageOf(err));
	try {
		context.subscriptions.push(vscode.window.registerWebviewViewProvider(PANEL_VIEW, {
			resolveWebviewView: view => {
				view.webview.options = { enableScripts: false };
				const escaped = text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
				view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body><p style="padding: 0 8px; overflow-wrap: anywhere">${escaped}</p></body></html>`;
			}
		}));
	} catch {
		// The panel of the part that did start shows itself
	}
	if (err instanceof ActivationError && !err.reloadHelps) {
		void vscode.window.showErrorMessage(text);
		return;
	}
	const reload = vscode.l10n.t("Reload Window");
	void vscode.window.showErrorMessage(text, reload).then(choice => {
		if (choice === reload) {
			void vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

/** The workspace this window keeps its runs under: its workspace file, else its first folder (ARCHITECTURE-3.1). */
function workspaceUri(): string {
	return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString() ?? `untitled:${vscode.env.sessionId}`;
}

/**
 * The composition root (ARCHITECTURE-1.3): the core's ports wired to the editor, ptyd and the execution environment's Facade
 * directory. Returns what deactivation runs: the window detaches, and its agents' processes go on in ptyd (RULES-4.1).
 */
export async function activateFacade(context: vscode.ExtensionContext): Promise<() => Promise<void>> {
	const home = facadeHome();
	const session = vscode.env.sessionId;
	let identity: unknown;
	try {
		identity = await vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, session);
	} catch (error) {
		console.error('Could not request the local window handover identity.', error);
	}
	if (isDamagedWindowIdentity(identity, session)) {
		// No other identity is invented (ARCHITECTURE-2.2), and a reload reads the same record: another window has its own
		throw new ActivationError(vscode.l10n.t("This window's Facade Code record is damaged, so its agents cannot be restored here. Close this window and open its folder or workspace again, or restart {0}.", vscode.env.appName), false);
	}
	if (!isWindowIdentity(identity, session)) {
		throw new ActivationError(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
	}
	// Remote workspace transitions replace the session ID and workspace state. The local component carries the native window's
	// identity; a different window cannot acquire that identity merely by opening the same folders or a copied workspace file.
	const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString());
	const uri = workspaceUri();
	const kept = context.workspaceState.get<unknown>(WORKSPACE_KEY);
	const record = workspaceRecord(uri, home, kept, { token: identity.token, folders });
	const handedOver = record.handedOver;
	const claim = nextOwnerClaim(record.key, home);
	const terminalOwner = { session, claim };
	if (await vscode.commands.executeCommand(WINDOW_TERMINALS_COMMAND, { ...terminalOwner, kind: 'activate', handedOver: record.key === handedOver }) !== true) {
		throw new ActivationError(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
	}
	const agentLog = new AgentLog(record.dir);
	const log: LogPort = { event: text => agentLog.event(text) };
	// A proven handover or an exact-URI takeover uses the shared owner's state, including in a fresh profile. A stale
	// Memento at a previously visited destination cannot overwrite the current order and choices beside those runs.
	const carried = record.key === handedOver || record.binding.key === record.key;
	if (carried) {
		log.event(`This window claims its agents and saved workspace state again for ${uri}.`);
	}
	const writeIfOwned = (write: () => void) => writeAsOwner(claim, home, write);
	// The exact saved URI follows a proven handover; stale local state cannot overwrite a concurrent canonical move.
	writeIfOwned(() => keepWorkspaceUri(uri, record, home));
	const workspaceState = new KeptWorkspaceState(context.workspaceState, path.join(record.dir, 'workspace-state.json'), carried, text => log.event(text), writeIfOwned);
	try {
		writeIfOwned(() => keepWindowKey(identity.token, record.key, folders, home, Date.now(), uri));
	} catch (err) {
		log.event(`Could not note which agents this window claims: ${messageOf(err)}`);
	}
	if (workspaceState.get(WORKSPACE_KEY) !== record.key) {
		void Promise.resolve(workspaceState.update(WORKSPACE_KEY, record.key)).catch(err => log.event(`Could not keep the workspace's key: ${messageOf(err)}`));
	}
	const locations = createLocationService(workspaceState, log);
	const execution = new AgentExecution({
		owner: record.key,
		claim,
		ptydScript: vscode.Uri.joinPath(context.extensionUri, 'dist', 'ptyd.js').fsPath,
		home,
		media: vscode.Uri.joinPath(context.extensionUri, 'media'),
		log: line => agentLog.event(line),
		terminalOwner: { ...terminalOwner, remote: vscode.env.remoteName !== undefined }
	});
	const worktrees = createWorktreeService(locations, log);
	const clis = new HostClis({ log: line => log.event(line) });
	const history = new WorkspaceLaunchHistory(workspaceState, log);
	const human = new WindowHuman(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const agents = new AgentService({
		execution,
		planner: clis,
		locations,
		worktrees,
		history,
		human,
		retained: new RetainedFile<RunFacts>(record.dir, writeIfOwned),
		aliases: new AliasCounter(home),
		clock: { now: Date.now },
		log,
		lifetime: new WindowLifetime(),
		yolo,
		// Facade's own reasons in the person's language: a worktree's problem, a CLI's configuration (UX-2.4)
		describe: (err, english) => worktreeProblemText(err, err instanceof PlanError ? reasonText(err.said, english) : english),
		newRunId: () => `run-${crypto.randomBytes(16).toString('hex')}`
	});
	// Reattach first: the panel shows its progress until this window's runs are known (LIFECYCLE-3.5, PANEL-1.1). A window that
	// cannot list them yet - its ptyd not answering - keeps trying, as they end five minutes after no window claims them (RULES-4.1)
	let restoreRetry: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const restored = (async () => {
		for (let wait = RECONCILE_MS; await agents.restore() === undefined && !disposed; wait = Math.min(wait * 2, MOST_RESTORE_WAIT_MS)) {
			await new Promise<void>(resolve => { restoreRetry = setTimeout(resolve, wait); });
		}
	})();
	const ready = restored.then(() => execution.finishRestore()).catch(err => log.event(`Could not reconcile this window's agents: ${messageOf(err)}`));
	// Then a ptyd listing runs of this window that it shows no pair of - one of an earlier protocol found late, or a failed reattach -
	// restores again, one restore at a time: no started agent is left out (RULES-4.1, D83)
	let restoring: Promise<unknown> = ready;
	const found = execution.onDidFindRuns(() => {
		restoring = restoring.then(() => disposed ? undefined : agents.restore()).catch(err => log.event(`Could not show this window's agents again: ${messageOf(err)}`));
	});
	const disposables: vscode.Disposable[] = [
		...registerUi({
			agents,
			locations,
			clis,
			history,
			execution,
			worktrees,
			workspaceState,
			extensionUri: context.extensionUri,
			log,
			notifyError: (text, options) => human.error(text, options),
			ready,
			...(identity.remote ? { remote: identity.remote } : {})
		}),
		...registerWorktreeCommands({ locations, worktrees, agents, notifyError: (text, options) => human.error(text, options), log })
	];
	context.subscriptions.push(...disposables);
	return async () => {
		disposed = true;
		clearTimeout(restoreRetry);
		found.dispose();
		agents.dispose();
		// One that throws does not keep the rest open (ARCHITECTURE-2.4)
		disposeAll(disposables, err => log.event(`Could not dispose part of the window: ${messageOf(err)}`));
		locations.dispose();
		execution.dispose();
	};
}
