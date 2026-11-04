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
 * Tabs the editor closes together - Close All, Close Others - arrive as separate closes within this; they are asked about once. A
 * live agent's tab with no other tab closing within this of it was closed by itself, which closes the agent without asking.
 */
const CLOSE_BATCH_MS = 100;

/**
 * The person in this window (RULES-1.8, UX-1.2): native error notifications for human-operation errors and known failures with
 * no responsible agent, offering only Show or Configure Agents - the same page as the command of that name. Dismissal changes nothing.
 */
export class WindowHuman implements HumanPort, vscode.Disposable {
	/** The agents whose tabs closed together, gathered before they are asked about. */
	private closing: { readonly agents: { readonly run: RunId; readonly label: string }[]; readonly answer: Promise<boolean> } | undefined;
	/** When the editor's tabs of any kind closed lately, one time for each: what tells a tab closed by itself (LIFECYCLE-3.1). */
	private closedTabs: number[] = [];
	private readonly tabs: vscode.Disposable;

	constructor(private readonly show: (run: RunId) => Promise<unknown>) {
		this.tabs = vscode.window.tabGroups.onDidChangeTabs(event => {
			if (event.closed.length) {
				const now = Date.now();
				this.closedTabs = [...this.closedTabs.filter(at => now - at <= 2 * CLOSE_BATCH_MS), ...event.closed.map(() => now)];
			}
		});
	}

	dispose(): void {
		this.tabs.dispose();
	}

	/**
	 * Whether the person confirms ending live agents whose tabs closed (LIFECYCLE-3.1). A tab the person closed by itself - its close
	 * button, Close, Close Editor - ends its agent without asking (LIFECYCLE-3.1); tabs the editor closed together, an agent's with other tabs,
	 * are asked about once, in one modal warning. The editor does not say what closed a tab: one is closed by itself when no other tab
	 * closes within CLOSE_BATCH_MS of it. As the editor asks before terminating an editor terminal's processes,
	 * `terminal.integrated.confirmOnKill` set to `never` or `panel` ends them without asking.
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
		const since = Date.now() - CLOSE_BATCH_MS;
		const answer = new Promise<void>(resolve => setTimeout(resolve, CLOSE_BATCH_MS)).then(() => {
			// Tabs closed while the question is up are asked about next
			this.closing = undefined;
			if (agents.length === 1 && this.closedTabs.filter(at => at >= since).length <= 1) {
				return true;
			}
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
