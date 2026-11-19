/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, ConversationDiscoveryPort, ConversationEntry, ConversationKey, CliCatalogPort, Event, ExecutionPort, HumanPort, LaunchHistoryPort, LocationId, LocationPort, LogPort, RunId, WorktreePort } from '../../core/ports';
import type { Act, Outcome } from '../../webview/protocol';
import { CardWords } from '../cardView';
import { COMMANDS, PANEL_VIEW, TEST_COMMANDS } from '../catalog';
import { locationOfFilter, PanelModel } from '../model';
import { PanelView } from '../panel';
import { pickFilter } from '../pickers/filter';
import { goToAgent } from '../pickers/goToAgent';
import { environmentLabel } from '../pickers/location';
import { pickSession } from '../pickers/resume';
import { messageOf } from '../../base/errors';
import { newAgent } from '../pickers/newAgent';
import { createRustPickers, type RustPickerDeps } from '../pickers/orchestrator';
import { PanelPrefs } from '../order';
import { AgentActions, registerAgentCommands, registerRustAgentCommands, targetOf, type RustCardActions } from './agent';

/** Defined by the build: true only in the integration suite's build, whose test commands the shipped one has none of (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

/** What the panel, its commands and its pickers are given by the composition root. */
export interface UiDeps {
	readonly agents: Agents;
	/** Opens the editor's Settings at Facade Code's section (CONFIGURATION-1.2). */
	readonly openSettings: () => Promise<void>;
	/** `names` of the settings file, where it has them: what New Agent's suggested name is picked from (LIFECYCLE-2.1). */
	readonly names?: () => readonly string[] | undefined;
	/** The icon each CLI shows, by its API ID, from one reading of the settings file: what cards and pickers show (CONFIGURATION-2.4). */
	readonly icons?: () => (cli: string) => string;
	/** The settings file was saved, made or removed: the cards show their icons as it says them now (CONFIGURATION-2.4). */
	readonly settingsChanged?: vscode.Event<void>;
	readonly conversations?: ConversationDiscoveryPort;
	/** Whether Facade has a history reader for a CLI's conversations, so its runs' titles can come (PANEL-1.5, CLIS-2.4). */
	readonly readsTitles?: (cli: string) => boolean;
	readonly savedName: (key: ConversationKey) => string | undefined;
	readonly locations: LocationPort;
	readonly clis: CliCatalogPort;
	readonly history: LaunchHistoryPort;
	/** New worktrees through the editor's native Git (WORKTREES-2.1). */
	readonly worktrees: WorktreePort;
	readonly execution: Pick<ExecutionPort, 'reveal' | 'tabOpen' | 'onDidActivate'>;
	readonly workspaceState: Pick<vscode.Memento, 'get' | 'update'>;
	readonly extensionUri: vscode.Uri;
	readonly log: LogPort;
	/** A human-operation error, one neutralized line with only Show or Edit in facade.json (UX-1.2, RULES-1.8). */
	readonly notifyError: HumanPort['error'];
	/** Settles once this window's runs are reconciled; until then the view shows its own progress (PANEL-1.1). */
	readonly ready: Promise<unknown>;
	/** The window's remote authority, as the local window component sees it: how its environment is named (LIFECYCLE-1.1). */
	readonly remote?: string;
	/** The system's reduced-motion preference, as the panel's page says it, which the extension host cannot read (LIFECYCLE-2.2). */
	readonly motion?: (reduced: boolean) => void;
}

export interface OrchestratorUiDeps {
	readonly agents: Pick<Agents, 'list' | 'get' | 'onDidChange' | 'pins'> & RustCardActions;
	readonly pickers: Omit<RustPickerDeps, 'select' | 'locations' | 'media'>;
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
function cardWords(orchestrator = false): CardWords {
	return {
		...(orchestrator ? { orchestrator: {
			justDone: vscode.l10n.t('Just done'),
			waitingForYou: vscode.l10n.t('Waiting for you'),
			ended: vscode.l10n.t('Ended'),
			unknown: vscode.l10n.t('Unknown'),
			stateError: vscode.l10n.t('Error'),
			machine: (value: string) => vscode.l10n.t('Machine: {0}', value),
			address: (value: string) => vscode.l10n.t('Address: {0}', value)
		} } : {}),
		title: value => vscode.l10n.t("Title: {0}", value),
		// The details' first row where a run has no title: its CLI has not saved one yet; or Facade has no history reader for its CLI
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
		toolsConnecting: vscode.l10n.t("Facade tools not connected yet"),
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
			? vscode.l10n.t("Facade tools unavailable · replace .cmd with CLI in facade.json")
			: problem === 'conflict' && file
				// {0} is a file in the agent's folder that Facade will not overwrite, such as .agents/skills/facade/SKILL.md
				? vscode.l10n.t("Facade tools unavailable · move or rename {0}", file)
				: problem === 'variable' && file
					// {0} is an environment variable of the person's own that Facade could not read, such as OPENCODE_CONFIG_CONTENT
					? vscode.l10n.t("Facade tools unavailable · {0} unreadable", file)
					: problem === 'disconnected'
						// The agent's CLI stopped the Facade tools it had started with, or they ended on their own
						? vscode.l10n.t("Facade tools disconnected")
						: vscode.l10n.t("Facade tools unavailable · file creation failed"),
		// {0} the agent that sent it, with its window where that is another; {1} its text
		saidByAgent: (sender, line) => vscode.l10n.t("Last message from agent {0}: {1}", sender, line),
		saidByPerson: line => vscode.l10n.t("Last input: {0}", line),
		saidByFacade: line => vscode.l10n.t("Facade result: {0}", line)
	};
}

export function registerOrchestratorUi(deps: OrchestratorUiDeps): vscode.Disposable[] {
	const { agents, locations } = deps;
	const model = new PanelModel({
		agents, locations,
		prefs: new PanelPrefs(deps.workspaceState, deps.log, true),
		words: cardWords(true),
		remote: vscode.env.remoteName !== undefined,
		ready: deps.ready,
		orchestrator: true,
		icons: () => deps.pickers.icons
	});
	const pickers = createRustPickers({
		...deps.pickers, locations,
		media: vscode.Uri.joinPath(deps.extensionUri, 'media'),
		select: run => model.select(run)
	});
	const actions: RustCardActions = {
		open: async run => {
			const opened = await agents.open(run);
			if (opened) { model.select(run); }
			return opened;
		},
		hide: run => agents.hide(run),
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
					await pickers.newAgent(locationOfFilter(model.currentFilter(), locations.snapshot().locations));
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
		...registerRustAgentCommands({
			model, agents, actions, goToAgent: pickers.goToAgent,
			notifyError: (text, options) => {
				if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE) { console.error(text); }
				deps.notifyError(text, options);
			}
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
		ready: deps.ready,
		environmentLabel: environment => environmentLabel(environment, deps.remote),
		...deps.readsTitles ? { readsTitles: deps.readsTitles } : {},
		...deps.icons ? { icons: deps.icons } : {}
	});
	const agent = new AgentActions({ agents: deps.agents, model, execution: deps.execution, notifyError: deps.notifyError });
	const sessions = async () => {
		if (!deps.conversations) { return; }
		// Show the picker while the window prepares the saved sessions (UX-1.1).
		const prepared = (async () => {
			await deps.ready;
			await deps.locations.refresh().catch(err => deps.log.event(`Using known working locations: ${messageOf(err)}`));
			await deps.agents.refreshConversations();
		})();
		prepared.catch(() => undefined);
		try {
			await pickSession({
				kind: 'continue', conversations: deps.conversations, savedName: deps.savedName,
				continueSession: (entry: ConversationEntry) => deps.agents.resume(entry, { reveal: true }),
				locations: deps.locations, prepared, running: key => !!deps.agents.holding(key),
				reveal: run => agent.reveal(run), select: run => model.select(run),
				notifyError: deps.notifyError, media, language: vscode.env.language, ...deps.icons ? { icons: deps.icons } : {},
				...deps.clis.problems ? { settingsProblems: () => deps.clis.problems?.() ?? [] } : {} });
		} catch (err) { deps.notifyError(vscode.l10n.t("Could not read the saved sessions: {0}", messageOf(err)), {}); }
	};
	const flows = {
		newAgent: (startAt?: LocationId) => newAgent({
			agents: deps.agents, locations: deps.locations, clis: deps.clis, worktrees: deps.worktrees, history: deps.history,
			select: run => model.select(run), notifyError: deps.notifyError, log: deps.log, media,
			...deps.names ? { names: deps.names } : {}, ...deps.remote ? { remote: deps.remote } : {}
		}, startAt),
		goToAgent: () => goToAgent({
			model, agents: deps.agents, media, reveal: run => agent.reveal(run),
			copyReference: run => agent.copyReference(run), stop: run => agent.stop(run), dismiss: run => agent.dismiss(run),
			...deps.icons ? { icons: deps.icons } : {}
		})
	};
	/** What the page's actions do, their targets revalidated by run ID (PANEL-3.1). */
	const act = async (what: Act, target: string | undefined): Promise<Outcome['reason'] | undefined> => {
		switch (what) {
			case 'open':
				return target === undefined || !deps.agents.get(target) ? 'gone' : await agent.reveal(target) ? undefined : 'failed';
			case 'continueSession':
				await sessions();
				return undefined;
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
			case 'pin':
			case 'unpin':
				// The card's Pin button does what Pin Agent and Unpin Agent do (PANEL-1.3, LIFECYCLE-3.4)
				if (target === undefined || !deps.agents.get(target)) {
					return 'gone';
				}
				agent.pin(target, what === 'pin');
				return undefined;
		}
	};
	const view = new PanelView(deps.extensionUri, model, act, deps.log, deps.motion);
	return [
		model,
		...deps.settingsChanged ? [deps.settingsChanged(() => model.refresh())] : [],
		view,
		vscode.window.registerWebviewViewProvider(PANEL_VIEW, view),
		deps.execution.onDidActivate(run => model.activated(run)),
		vscode.commands.registerCommand(COMMANDS.continueSession, sessions),
		vscode.commands.registerCommand(COMMANDS.newAgent, () => flows.newAgent()),
		vscode.commands.registerCommand(COMMANDS.filter, () => pickFilter(model, deps.locations, deps.log)),
		// The same, its title button filled while a filter is on (UX-3.2)
		vscode.commands.registerCommand(COMMANDS.filterOn, () => pickFilter(model, deps.locations, deps.log)),
		// The selected card's details, for the keyboard: the view shown, the focus in them (PANEL-1.5, UX-2.3)
		vscode.commands.registerCommand(COMMANDS.showAgentDetails, (arg?: unknown) => {
			const run = targetOf(arg, model, deps.agents, true);
			return run === undefined ? undefined : view.showDetails(run);
		}),
		...registerAgentCommands({ agents: deps.agents, model, execution: deps.execution, notifyError: deps.notifyError }, agent, flows),
		// Open Settings: the editor's Settings at Facade Code's section, whose Edit in facade.json link opens the file (CONFIGURATION-1.2)
		vscode.commands.registerCommand(COMMANDS.openSettings, () => deps.openSettings()),
		...registerTestUi(model, view, deps.agents)
	];
}
