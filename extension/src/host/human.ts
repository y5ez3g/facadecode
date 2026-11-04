/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import type { HumanFailure, HumanPort, RunId } from '../core/ports';
import { COMMANDS } from '../ui/catalog';
import { configureAgentsLabel, launchFailureText } from '../ui/presentation';
import { notificationText } from './notify';

/**
 * The person in this window (RULES-1.8, UX-1.2): native error notifications for human-operation errors and known failures with
 * no responsible agent, offering only Show or Configure Agents - the same page as the command of that name. Dismissal changes nothing.
 */
export class WindowHuman implements HumanPort, vscode.Disposable {
	constructor(private readonly show: (run: RunId) => Promise<unknown>) { }

	dispose(): void { }

	failed(failure: HumanFailure, options: { readonly show?: RunId; readonly configure?: boolean }): void {
		const text = failure.kind === 'terminate' ? vscode.l10n.t("{0} was closed, but its process could not be terminated.", failure.name)
			: failure.kind === 'pin' ? vscode.l10n.t("Could not pin {0}: {1}", failure.name, failure.reason)
			: failure.kind === 'unpin' ? vscode.l10n.t("Could not unpin {0}: {1}", failure.name, failure.reason) : failure.kind === 'restore'
			? (failure.count > 1 ? vscode.l10n.t("Could not restore {0} pinned agents. Their cards show why.", failure.count) : vscode.l10n.t("Could not restore {0}: {1}", failure.name, failure.reason))
			: launchFailureText(failure.name, failure.reason, failure.worktree);
		this.error(text, options);
	}

	error(text: string, options: { readonly show?: RunId; readonly configure?: boolean }): void {
		const showLabel = vscode.l10n.t("Show");
		const configureLabel = configureAgentsLabel();
		const actions = [...options.show ? [showLabel] : [], ...options.configure ? [configureLabel] : []];
		void vscode.window.showErrorMessage(notificationText(text), ...actions).then(choice => {
			// What an action opens failing to open is no unhandled failure of the window's
			if (choice === showLabel && options.show) {
				this.show(options.show).catch(err => console.error(`Could not show the agent: ${messageOf(err)}`));
			} else if (choice === configureLabel) {
				Promise.resolve(vscode.commands.executeCommand(COMMANDS.configureAgents)).catch(err => console.error(`Could not open the agent settings: ${messageOf(err)}`));
			}
		});
	}
}
