/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, CliCatalogPort, ExecutionPort, HumanPort, LaunchHistoryPort, LocationId, LocationPort, LogPort, WorktreePort } from '../../core/ports';
import type { Act, Outcome } from '../../webview/protocol';
import { CardWords } from '../cardView';
import { AGENT_SETTINGS, COMMANDS, PANEL_VIEW, TEST_COMMANDS } from '../catalog';
import { locationOfFilter, PanelModel } from '../model';
import { PanelView } from '../panel';
import { withWorktreeEffects } from '../presentation';
import { pickFilter } from '../pickers/filter';
import { goToAgent } from '../pickers/goToAgent';
import { environmentLabel } from '../pickers/location';
import { newAgent } from '../pickers/newAgent';
import { PanelPrefs } from '../order';
import { AgentActions, registerAgentCommands, targetOf } from './agent';

/** Defined by the build: true only in the integration suite's build, whose test commands the shipped one has none of (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

/** What the panel, its commands and its pickers are given by the composition root. */
export interface UiDeps {
	readonly agents: Agents;
	readonly locations: LocationPort;
	readonly clis: CliCatalogPort;
	readonly history: LaunchHistoryPort;
	/** New worktrees through the editor's native Git (WORKTREES-2.1). */
	readonly worktrees: WorktreePort;
	readonly execution: Pick<ExecutionPort, 'reveal' | 'onDidActivate'>;
	readonly workspaceState: vscode.Memento;
	readonly extensionUri: vscode.Uri;
	readonly log: LogPort;
	/** A human-operation error, one neutralized line with only Show or Configure Agents (UX-1.2, RULES-1.8). */
	readonly notifyError: HumanPort['error'];
	/** Settles once this window's runs are reconciled; until then the view shows its own progress (PANEL-1.1). */
	readonly ready: Promise<unknown>;
	/** This window's name: the hover says it with an agent's location (PANEL-1.5). */
	readonly window?: string;
	/** The window's remote authority, as the local window component sees it: how its environment is named (LIFECYCLE-1.1). */
	readonly remote?: string;
}

/** The words a card is said in, in the window's language (PANEL-1.4). */
function cardWords(): CardWords {
	return {
		worktreeFailure: withWorktreeEffects,
		starting: vscode.l10n.t("Starting"),
		// {0} is the CLI's name, such as Claude Code
		startingCli: cli => vscode.l10n.t("Starting {0}...", cli),
		creatingWorktree: vscode.l10n.t("Creating worktree..."),
		working: vscode.l10n.t("Working"),
		notWorking: vscode.l10n.t("Idle"),
		// {0} is why: the failure the agent ended with, or the error its CLI reported
		error: reason => vscode.l10n.t("Error: {0}", reason),
		activityUnavailable: vscode.l10n.t("Activity unavailable"),
		readyForInput: vscode.l10n.t("Ready for input"),
		needsPermission: vscode.l10n.t("Needs permission"),
		needsSignIn: vscode.l10n.t("Sign-in required"),
		hasQuestion: vscode.l10n.t("Waiting for an answer"),
		// {0} is the exit code of the agent's CLI
		exitedWithCode: code => vscode.l10n.t("Exited with code {0}", code),
		// {0} is the signal that ended the agent's CLI, such as SIGKILL
		endedBySignal: signal => vscode.l10n.t("Terminated by signal {0}", signal),
		// A run its supervisor no longer had: it ended, how is not known
		exitUnknown: vscode.l10n.t("Disconnected; exit cause unknown"),
		// {0} is the name of the editor window the agent is in
		window: label => vscode.l10n.t("Window: {0}", label),
		locale: vscode.env.language
	};
}

/**
 * The panel (PANEL), its commands (UX-3) and pickers (LIFECYCLE-1, 2): the view provider, every `facade.` command this extension owns
 * but New Worktree, and the context keys. Answers what the extension disposes as it deactivates.
 */
export function registerUi(deps: UiDeps): vscode.Disposable[] {
	const words = cardWords();
	const media = vscode.Uri.joinPath(deps.extensionUri, 'media');
	const model = new PanelModel({
		agents: deps.agents,
		locations: deps.locations,
		prefs: new PanelPrefs(deps.workspaceState, deps.log),
		words,
		remote: vscode.env.remoteName !== undefined,
		window: deps.window ?? vscode.workspace.name,
		ready: deps.ready,
		environmentLabel: environment => environmentLabel(environment, deps.remote)
	});
	const agent = new AgentActions({ agents: deps.agents, model, execution: deps.execution, notifyError: deps.notifyError });
	const flows = {
		newAgent: (startAt?: LocationId) => newAgent({ agents: deps.agents, locations: deps.locations, clis: deps.clis, worktrees: deps.worktrees, history: deps.history, select: run => model.select(run), notifyError: deps.notifyError, log: deps.log, media, ...(deps.remote ? { remote: deps.remote } : {}) }, startAt),
		goToAgent: () => goToAgent({ model, agents: deps.agents, words, media, reveal: run => agent.reveal(run), copyReference: run => agent.copyReference(run), close: run => agent.close(run) })
	};
	/** What the page's actions do, their targets revalidated by run ID (PANEL-3.1). */
	const act = async (what: Act, target: string | undefined): Promise<Outcome['reason'] | undefined> => {
		switch (what) {
			case 'open':
				return target === undefined || !deps.agents.get(target) ? 'gone' : await agent.reveal(target) ? undefined : 'failed';
			case 'new':
				// From the filtered empty panel, at the filtered location; from the other empty panel, where New Agent would (PANEL-1.2, LIFECYCLE-1.2)
				await flows.newAgent(locationOfFilter(model.currentFilter(), deps.locations.snapshot().locations));
				return undefined;
			case 'clearFilter':
				model.setFilter(undefined);
				return undefined;
			case 'openFolder':
				await vscode.commands.executeCommand('vscode.openFolder');
				return undefined;
			case 'rename':
				if (target === undefined || !deps.agents.get(target)) {
					return 'gone';
				}
				await agent.rename(target);
				// Back on the card F2 was pressed on, as a VS Code list has it: the editor gives a closed input box's focus to the editor
				void vscode.commands.executeCommand(`${PANEL_VIEW}.focus`);
				return undefined;
		}
	};
	const view = new PanelView(deps.extensionUri, model, act, deps.log);
	return [
		model,
		view,
		vscode.window.registerWebviewViewProvider(PANEL_VIEW, view),
		deps.execution.onDidActivate(run => model.activated(run)),
		vscode.commands.registerCommand(COMMANDS.newAgent, () => flows.newAgent()),
		vscode.commands.registerCommand(COMMANDS.filter, () => pickFilter(model, deps.locations, deps.log)),
		// The same, its title button filled while a filter is on (UX-3.2)
		vscode.commands.registerCommand(COMMANDS.filterOn, () => pickFilter(model, deps.locations, deps.log)),
		...registerAgentCommands({ agents: deps.agents, model, execution: deps.execution, notifyError: deps.notifyError }, agent, flows),
		// Configure Agents...: the editor's Settings showing this extension's settings alone (CLIS-1.1)
		vscode.commands.registerCommand(COMMANDS.configureAgents, () => vscode.commands.executeCommand('workbench.action.openSettings', AGENT_SETTINGS)),
		...(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? [
			vscode.commands.registerCommand(TEST_COMMANDS.state, () => model.state()),
			vscode.commands.registerCommand(TEST_COMMANDS.selectRow, (arg?: unknown) => {
				const run = targetOf(arg, model, deps.agents, false);
				if (run !== undefined) {
					model.select(run);
				}
			}),
			vscode.commands.registerCommand(TEST_COMMANDS.probe, (args: { readonly op: string; readonly selector: string; readonly index?: number }) => view.probe(args))
		] : [])
	];
}
