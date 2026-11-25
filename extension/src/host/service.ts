/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { facadeRoot } from '../record/paths';
import { COMMANDS, PANEL_VIEW } from '../ui/catalog';
import { openSettingsLabel } from '../ui/presentation';
import { activateOrchestrator } from './framework/index';
import { openFacadeSettings } from './framework/settings';
import { DaemonError } from './framework/types';
import { homeReloadText, UnusableHome, unusableHomeText, useFacadeHome } from './home';
import { prepareFramework } from './implementation';
import { legacyPinMigration } from './legacyCutover';
import type { LegacyPredecessor } from './legacyPins';

/**
 * Why this window's Facade could not start, in the person's words: shown as it is; `reloadHelps` where reloading tries again, and
 * `opensSetting` where a setting is what to fix, offered as Open Settings at that setting.
 */
export class ActivationError extends Error {
	constructor(message: string, readonly reloadHelps = true, readonly opensSetting?: string) {
		super(message);
	}
}

/**
 * A window whose Facade could not start says why where the person looks - a notification, with the reload that tries again where
 * one can help, and the panel in place of a progress that would never end - not only in the editor's log (UX-2.4); and each of
 * Facade's commands says it again, rather than that the editor has no such command (ARCHITECTURE-4.3).
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
	const say = () => {
		if (err instanceof ActivationError && err.opensSetting !== undefined) {
			const setting = err.opensSetting;
			const open = openSettingsLabel();
			void vscode.window.showErrorMessage(text, open).then(choice => {
				if (choice === open) {
					void openFacadeSettings(`@id:${setting}`);
				}
			});
			return;
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
	};
	say();
	for (const id of Object.values(COMMANDS)) {
		try {
			context.subscriptions.push(vscode.commands.registerCommand(id, say));
		} catch {
			// Registered by the part that did start
		}
	}
}

/** Resolve the execution home before checking for a prior implementation (ARCHITECTURE-1.4). */
export async function activateFacade(context: vscode.ExtensionContext): Promise<() => Promise<void>> {
	try {
		useFacadeHome(context, { terminals: true, offerReload: true, reloadText: homeReloadText });
	} catch (error) {
		throw error instanceof UnusableHome ? new ActivationError(unusableHomeText(error.value), false, 'facade.home') : error;
	}
	const root = facadeRoot();
	const home = path.join(root, 'extension');
	let predecessor: LegacyPredecessor | undefined;
	const pending = await prepareFramework(context, home, prior => { predecessor = prior; });
	if (pending) { return async () => pending.dispose(); }

	await vscode.commands.executeCommand('setContext', 'facade.implementation', 'framework');
	try {
		return await activateOrchestrator(context, { root, home, legacy: { predecessor, pins: owner => legacyPinMigration(home, owner) } });
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (cause instanceof DaemonError && (cause.reason === 'protocol_incompatible' || cause.reason === 'refused')) {
			throw new ActivationError(cause.message);
		}
		throw error;
	}
}
