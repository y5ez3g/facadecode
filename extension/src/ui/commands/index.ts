/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, Event, HumanPort, LocationPort, LogPort, RunId } from '../../core/ports';
import type { Act, Outcome } from '../../webview/protocol';
import { CardWords } from '../cardView';
import { COMMANDS, PANEL_VIEW, TEST_COMMANDS } from '../catalog';
import { directoryOfFilter, locationOfFilter, PanelModel } from '../model';
import { PanelView } from '../panel';
import { pickFilter } from '../pickers/filter';
import { createFrameworkPickers, type FrameworkPickerDeps } from '../pickers/framework';
import { PanelPrefs } from '../order';
import { registerFrameworkAgentCommands, targetOf, type FrameworkCardActions } from './agent';

/** Defined by the build: true only in the integration suite's build, whose test commands the shipped one has none of (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

export interface FrameworkUiDeps {
	readonly agents: Pick<Agents, 'list' | 'get' | 'onDidChange' | 'pins' | 'reorderPins'> & FrameworkCardActions;
	readonly pickers: Omit<FrameworkPickerDeps, 'select' | 'locations' | 'media'>;
	readonly locations: LocationPort;
	readonly workspaceState: ConstructorParameters<typeof PanelPrefs>[0];
	readonly onDidActivate: Event<RunId | undefined>;
	readonly openSettings: () => Promise<void>;
	readonly extensionUri: vscode.Uri;
	readonly log: LogPort;
	readonly notifyError: HumanPort['error'];
	readonly ready: Promise<unknown>;
	readonly motion: (reduced: boolean) => void;
}

/** The words a card is said in, in the window's language (PANEL-1.4). */
function cardWords(): CardWords {
	return {
		framework: {
			justDone: vscode.l10n.t('Just done'),
			waitingForYou: vscode.l10n.t('Waiting for you'),
			ended: vscode.l10n.t('Ended'),
			unknown: vscode.l10n.t('Unknown'),
			stateError: vscode.l10n.t('Error'),
			toolsError: vscode.l10n.t('Facade Code Framework tools unavailable'),
			address: (value: string) => vscode.l10n.t('Agent reference: {0}', value),
			session: (value: string) => vscode.l10n.t('Session: {0}', value),
			name: (value: string) => vscode.l10n.t('Name: {0}', value)
		},
		title: value => vscode.l10n.t("Title: {0}", value),
		// The details' first row where a run has no title: its CLI has not saved one yet; or Facade Code Extension has no history reader for its CLI
		untitledPending: vscode.l10n.t("No title yet"),
		untitledUnreadable: vscode.l10n.t("Title unavailable"),
		location: value => vscode.l10n.t("Location: {0}", value),
		path: value => vscode.l10n.t("Path: {0}", value),
		pinned: vscode.l10n.t("Pinned"),
		runningOn: machine => vscode.l10n.t("Running on {0}", machine),
		connectionLost: vscode.l10n.t("Connection lost · reconnecting"),
		starting: vscode.l10n.t("Starting"),
		// {0} is the CLI's name, such as Claude Code
		startingCli: cli => vscode.l10n.t("Starting {0}…", cli),
		creatingWorktree: vscode.l10n.t("Creating worktree…"),
		// A card's opening before any message (PANEL-1.4).
		started: vscode.l10n.t("New session started"),
		resumed: vscode.l10n.t("Agent resumed"),
		continued: vscode.l10n.t("Session continued"),
		working: vscode.l10n.t("Working"),
		notWorking: vscode.l10n.t("Idle"),
		// {0} is why: the failure the agent ended with, or the error its CLI reported
		error: reason => vscode.l10n.t("Error · {0}", reason),
		activityUnavailable: vscode.l10n.t("State unavailable · check terminal"),
		// Why its activity is unknown: no report yet since its start, none ever, one taken back, a screen not recognized, or a terminal reset
		activityUnknown: why => why === 'waiting' ? vscode.l10n.t("No initial state · check terminal")
			: why === 'not_reporting' ? vscode.l10n.t("No state from CLI · check terminal")
				: why === 'cleared' ? vscode.l10n.t("State cleared · check terminal")
					: why === 'screen_unrecognized' ? vscode.l10n.t("State unrecognized · check terminal")
						: vscode.l10n.t("State reset · check terminal"),
		needsAttention: vscode.l10n.t("Attention needed"),
		toolsConnecting: vscode.l10n.t("Facade Code Framework tools not connected yet"),
		needsPermission: vscode.l10n.t("Permission needed"),
		needsSignIn: vscode.l10n.t("Sign-in needed"),
		hasQuestion: vscode.l10n.t("Answer needed"),
		// {0} is the exit code of the agent's CLI
		exitedWithCode: code => vscode.l10n.t("Process exited · code {0}", code),
		// {0} is the signal that ended the agent's CLI, such as SIGKILL
		endedBySignal: signal => vscode.l10n.t("Process terminated · {0}", signal),
		// A run its supervisor no longer had: it ended, how is not known
		exitUnknown: vscode.l10n.t("Process lost · reason unknown"),
		// {0} is why its start failed, without its closing period, such as: claude was not found on PATH
		startFailed: reason => vscode.l10n.t("Start failed · {0}", reason),
		// {0} is why its new worktree could not be created, without its closing period
		worktreeFailed: reason => vscode.l10n.t("Worktree failed · {0}", reason),
		toolsUnavailable: (problem, file) => problem === 'cmd'
			? vscode.l10n.t("Facade Code Framework tools unavailable · replace .cmd with CLI in facade.json")
			: problem === 'conflict' && file
				// {0} is a file in the agent's folder that Facade Code Extension will not overwrite, such as .agents/skills/facade/SKILL.md
				? vscode.l10n.t("Facade Code Framework tools unavailable · move or rename {0}", file)
				: problem === 'variable' && file
					// {0} is an environment variable of the person's own that Facade Code Extension could not read, such as OPENCODE_CONFIG_CONTENT
					? vscode.l10n.t("Facade Code Framework tools unavailable · {0} unreadable", file)
					: problem === 'disconnected'
						// The agent's CLI stopped the Facade Code Framework tools it had started with, or they ended on their own
						? vscode.l10n.t("Facade Code Framework tools disconnected")
						: vscode.l10n.t("Facade Code Framework tools unavailable · file creation failed"),
		// {0} the agent that sent it, with its window where that is another; {1} its text
		saidByAgent: (sender, line) => vscode.l10n.t("Last message from agent {0}: {1}", sender, line),
		saidByPerson: line => vscode.l10n.t("Last input: {0}", line),
		saidByFacade: line => vscode.l10n.t("Facade Code Framework result: {0}", line)
	};
}

export function registerFrameworkUi(deps: FrameworkUiDeps): vscode.Disposable[] {
	const { agents, locations } = deps;
	const model = new PanelModel({
		agents, locations,
		prefs: new PanelPrefs(deps.workspaceState, deps.log, true),
		words: cardWords(),
		remote: vscode.env.remoteName !== undefined,
		ready: deps.ready,
		framework: true,
		icons: () => deps.pickers.icons
	});
	const pickers = createFrameworkPickers({
		...deps.pickers, locations,
		media: vscode.Uri.joinPath(deps.extensionUri, 'media'),
		select: run => model.select(run)
	});
	const actions: FrameworkCardActions = {
		open: async run => {
			const opened = await agents.open(run);
			if (opened) { model.select(run); }
			return opened;
		},
		stop: run => agents.stop(run),
		remove: run => agents.remove(run),
		setPinned: (run, pinned) => agents.setPinned(run, pinned),
		rename: (run, name) => agents.rename(run, name)
	};
	const act = async (what: Act, run: string | undefined): Promise<Outcome['reason'] | undefined> => {
		try {
			switch (what) {
				case 'open':
					if (run === undefined || !agents.get(run)) { return 'gone'; }
					return await actions.open(run) ? undefined : 'failed';
				case 'new':
					await pickers.newAgent(locationOfFilter(model.currentFilter(), locations.snapshot().locations)
						?? directoryOfFilter(model.currentFilter()));
					return undefined;
				case 'continueSession':
					await pickers.resumeAgent();
					return undefined;
				case 'clearFilter':
					model.setFilter(undefined);
					return undefined;
				case 'openFolder':
					await vscode.commands.executeCommand('vscode.openFolder');
					return undefined;
				case 'rename':
					if (run === undefined || !agents.get(run)) { return 'gone'; }
					await vscode.commands.executeCommand(COMMANDS.renameAgent, { webview: PANEL_VIEW, webviewSection: 'agent', run_id: run, preventDefaultContextMenuItems: true });
					void vscode.commands.executeCommand(`${PANEL_VIEW}.focus`);
					return undefined;
				case 'pin':
				case 'unpin':
					if (run === undefined || !agents.get(run)) { return 'gone'; }
					await actions.setPinned(run, what === 'pin');
					return undefined;
			}
		} catch (error) {
			deps.pickers.notifyError(error);
			return 'failed';
		}
	};
	const view = new PanelView(deps.extensionUri, model, act, deps.log, deps.motion);
	return [
		model, view,
		vscode.window.registerWebviewViewProvider(PANEL_VIEW, view),
		deps.onDidActivate(run => model.activated(run)),
		vscode.commands.registerCommand(COMMANDS.newAgent, () => pickers.newAgent()),
		vscode.commands.registerCommand(COMMANDS.resumeAgent, () => pickers.resumeAgent()),
		vscode.commands.registerCommand(COMMANDS.filter, () => pickFilter(model, locations, deps.log)),
		vscode.commands.registerCommand(COMMANDS.filterOn, () => pickFilter(model, locations, deps.log)),
		vscode.commands.registerCommand(COMMANDS.openSettings, () => deps.openSettings()),
		vscode.commands.registerCommand(COMMANDS.showAgentDetails, (arg?: unknown) => {
			const run = targetOf(arg, model, agents, true);
			return run === undefined ? undefined : view.showDetails(run);
		}),
		...registerFrameworkAgentCommands({
			model, agents, actions, notifyError: deps.notifyError, stopAgent: pickers.stopAgent
		}),
		...registerTestUi(model, view, agents)
	];
}

function registerTestUi(model: PanelModel, view: PanelView, agents: Pick<Agents, 'get'>): vscode.Disposable[] {
	return typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? [
		vscode.commands.registerCommand(TEST_COMMANDS.state, () => model.state()),
		vscode.commands.registerCommand(TEST_COMMANDS.selectRow, (arg?: unknown) => {
			const run = targetOf(arg, model, agents, false);
			if (run !== undefined) { model.select(run); }
		}),
		vscode.commands.registerCommand(TEST_COMMANDS.probe, (args: { readonly op: string; readonly selector: string; readonly index?: number }) => view.probe(args))
	] : [];
}
