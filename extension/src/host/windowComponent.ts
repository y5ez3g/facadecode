/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The local window component, as the workspace extension waits for it (ARCHITECTURE-4.3, D94). The editor installs it through the
// extension pack and may activate it after this extension - in a remote window it installs it locally only after the remote one -
// so activation waits a bounded time for its command. Without it Facade cannot tell this window from another, and says so plainly.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { isDamagedWindowIdentity, isWindowIdentity, WINDOW_IDENTITY_COMMAND, type DamagedWindowIdentity, type WindowIdentity } from '../base/windowIdentity';
import { PANEL_VIEW } from '../ui/catalog';

/** The window component's extension ID. */
export const WINDOW_COMPONENT = 'facade.facadecode-window';

/** How long activation waits for the window component to answer (ARCHITECTURE-4.3). */
export const COMPONENT_WAIT_MS = 60_000;

/** How often its command is tried again while nothing tells that extensions changed. */
const RETRY_MS = 500;

/**
 * This window's identity from its local component, as soon as it answers: at once, or once the editor installs or activates it,
 * within {@link COMPONENT_WAIT_MS}. None where it never answers, or answers for another window.
 */
export async function waitForWindowIdentity(session: string, waitMs = COMPONENT_WAIT_MS): Promise<WindowIdentity | DamagedWindowIdentity | undefined> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		let identity: unknown;
		let answered = false;
		try {
			identity = await vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, session);
			answered = true;
		} catch {
			// Not registered yet: the component is not installed, enabled or activated
		}
		if (answered) {
			return isWindowIdentity(identity, session) || isDamagedWindowIdentity(identity, session) ? identity : undefined;
		}
		const left = deadline - Date.now();
		if (left <= 0) {
			return undefined;
		}
		await new Promise<void>(resolve => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let changed: vscode.Disposable | undefined;
			let finished = false;
			function done() {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				changed?.dispose();
				resolve();
			}
			changed = vscode.extensions.onDidChange(done);
			if (finished) {
				changed.dispose();
			} else {
				timer = setTimeout(done, Math.min(RETRY_MS, left));
			}
		});
	}
}

/**
 * Facade Code without its window component (ARCHITECTURE-4.3): the agents already running go on, nothing new starts, and the panel
 * and one notification say what to do, with an action that shows the component in the Extensions view. Once the editor has it, a
 * reload is offered. Answers what deactivation disposes.
 */
export function showComponentMissing(context: vscode.ExtensionContext, session: string): vscode.Disposable {
	const show = vscode.l10n.t("Show Window Component");
	const explanation = vscode.l10n.t("Facade Code needs its Window Component on this computer. Install and enable \"Facade Code Window Component\", then reload the window. Agents that are already running keep running.");
	const open = () => void vscode.commands.executeCommand('extension.open', WINDOW_COMPONENT);
	const view = vscode.window.registerWebviewViewProvider(PANEL_VIEW, {
		resolveWebviewView: webviewView => {
			const nonce = crypto.randomBytes(16).toString('base64');
			webviewView.webview.options = { enableScripts: true, enableCommandUris: false };
			webviewView.webview.html = missingHtml(nonce, webviewView.webview.cspSource, explanation, show);
			webviewView.webview.onDidReceiveMessage(message => {
				if (message === 'show') {
					open();
				}
			});
		}
	});
	void vscode.window.showWarningMessage(explanation, show).then(choice => {
		if (choice === show) {
			open();
		}
	});
	let offered = false;
	// Its command answering is what says it is there now, in whichever extension host the editor runs it
	const installed = vscode.extensions.onDidChange(async () => {
		if (offered) {
			return;
		}
		try {
			await vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, session);
		} catch {
			return;
		}
		if (offered) {
			return;
		}
		offered = true;
		const reload = vscode.l10n.t("Reload Window");
		void vscode.window.showInformationMessage(vscode.l10n.t("The Facade Code Window Component is installed. Reload the window to start Facade Code."), reload).then(choice => {
			if (choice === reload) {
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	});
	const disposable = vscode.Disposable.from(view, installed);
	context.subscriptions.push(disposable);
	return disposable;
}

/** The panel's page without the component: the explanation and one button, in the editor's own colors, with no remote content. */
function missingHtml(nonce: string, cspSource: string, explanation: string, show: string): string {
	const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
	return `<!DOCTYPE html>
<html lang="${escape(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
body { padding: 12px 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
button { margin-top: 12px; padding: 4px 12px; border: none; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>
</head>
<body>
<p role="status">${escape(explanation)}</p>
<button type="button" id="show">${escape(show)}</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('show').addEventListener('click', () => vscode.postMessage('show'));
</script>
</body>
</html>`;
}
