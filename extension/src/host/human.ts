/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { HumanFailure, HumanPort, RunId } from '../core/ports';
import { COMMANDS } from '../ui/catalog';
import { configureAgentsLabel, launchFailureText } from '../ui/presentation';
import { notificationText } from './notify';

/** Tabs the editor closes together - Close All, Close Others - arrive as separate closes within this; they are asked about once. */
const CLOSE_BATCH_MS = 100;

/**
 * The person in this window (RULES-1.8, UX-1.2): native error notifications for human-operation errors and known failures with
 * no responsible agent, offering only Show or Configure Agents - the same page as the command of that name. Dismissal changes nothing.
 */
export class WindowHuman implements HumanPort {
	/** The agents whose tabs closed together, gathered before they are asked about. */
	private closing: { readonly agents: { readonly run: RunId; readonly label: string }[]; readonly answer: Promise<boolean> } | undefined;

	constructor(private readonly show: (run: RunId) => Promise<unknown>) { }

	/**
	 * Whether the person confirms ending live agents whose tabs they closed (LIFECYCLE-3.1): one modal warning for tabs closed together.
	 * As the editor asks before terminating an editor terminal's processes, `terminal.integrated.confirmOnKill` set to `never` or `panel`
	 * ends them without asking.
	 */
	confirmClose(agent: { readonly run: RunId; readonly label: string }): Promise<boolean> {
		const setting = vscode.workspace.getConfiguration('terminal.integrated').get<unknown>('confirmOnKill') ?? 'editor';
		if (setting !== 'editor' && setting !== 'always') {
			return Promise.resolve(true);
		}
		if (this.closing) {
			this.closing.agents.push(agent);
			return this.closing.answer;
		}
		const agents = [agent];
		const answer = new Promise<void>(resolve => setTimeout(resolve, CLOSE_BATCH_MS)).then(() => {
			// Tabs closed while the question is up are asked about next
			this.closing = undefined;
			return this.askClose(agents);
		});
		this.closing = { agents, answer };
		return answer;
	}

	private async askClose(agents: readonly { readonly label: string }[]): Promise<boolean> {
		const one = agents.length === 1;
		const action = one ? vscode.l10n.t("Close Agent") : vscode.l10n.t("Close Agents");
		// {0} is the agent's name, or its #aN where it has none
		const message = one ? vscode.l10n.t("Close {0}?", agents[0].label) : vscode.l10n.t("Close {0} agents?", agents.length);
		const detail = one
			? vscode.l10n.t("Its process will end. Cancel keeps it running and opens its terminal again.")
			: `${agents.map(each => each.label).join(', ')}\n\n${vscode.l10n.t("Their processes will end. Cancel keeps them running and opens their terminals again.")}`;
		return await vscode.window.showWarningMessage(message, { modal: true, detail }, action) === action;
	}

	failed(failure: HumanFailure, options: { readonly show?: RunId; readonly configure?: boolean }): void {
		this.error(launchFailureText(failure.name, failure.reason, failure.worktree), options);
	}

	error(text: string, options: { readonly show?: RunId; readonly configure?: boolean }): void {
		const showLabel = vscode.l10n.t("Show");
		const configureLabel = configureAgentsLabel();
		const actions = [...options.show ? [showLabel] : [], ...options.configure ? [configureLabel] : []];
		void vscode.window.showErrorMessage(notificationText(text), ...actions).then(choice => {
			if (choice === showLabel && options.show) {
				void this.show(options.show);
			} else if (choice === configureLabel) {
				void vscode.commands.executeCommand(COMMANDS.configureAgents);
			}
		});
	}
}
