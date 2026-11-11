/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { untilAnswered } from '../base/async';
import { messageOf } from '../base/errors';
import { disposeAll } from '../base/lifecycle';
import { PLACEHOLDERS } from '../clis/describe';
import { VendorHistory } from '../clis/history';
import { ConversationFile } from '../record/conversations';
import { WorkspacePins } from './pins';
import { isDamagedWindowIdentity, isUnreadableWindowIdentity, WINDOW_TERMINALS_COMMAND } from '../base/windowIdentity';
import { createToolServices } from '../contract/tools';
import { deliveryReceipt } from '../contract/facts';
import { AgentService } from '../core/agents';
import { FacadeError } from '../core/errors';
import { AttentionNotices } from '../core/attention';
import type { MessageRecord } from '../core/messagePorts';
import { MessageService, STAGE_MS } from '../core/messages';
import { PlanError, type LogPort, type RetainedRun, type RunId } from '../core/ports';
import { COMMANDS, PANEL_VIEW } from '../ui/catalog';
import { worktreeProblemText } from '../ui/pickers/location';
import { openSettingsLabel, reasonText } from '../ui/presentation';
import { registerUi } from '../ui/commands/index';
import { registerWorktreeCommands } from '../ui/commands/worktree';
import { AgentExecution } from './execution/agentExecution';
import { RECONCILE_MS } from './execution/executionSession';
import { AgentLog } from '../record/log';
import { MessageFile } from '../record/messages';
import { facadeHome } from '../record/paths';
import { pruneResults, writeResult } from '../record/results';
import { instructionsFor, launchContextText } from '../schema/instructions';
import { RetainedFile } from '../record/retained';
import { nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { keepWindowKey, keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { allocateNumbers, environmentFloor } from '../record/windowRegistry';
import type { NetworkPort } from '../contract/network';
import { agentAliases, AliasPool, ClientNetwork, LOCAL_POOL, networkAddress, NO_AGENT_NUMBERS, NO_MESSAGE_NUMBERS, OutdatedComponent, publishAgents, REMOTE_POOL, serveRoutes } from './client';
import { registerAgentsLog } from './agentsLog';
import { HostClis } from './clis';
import { WindowContact } from './contact';
import { diagnosticsOf, DiagnosticsDeps } from './diagnostics';
import { WorkspaceLaunchHistory } from './history';
import { WindowHuman } from './human';
import { OrdinaryInput } from './input';
import { createLocationService, createWorktreeService } from './locations/index';
import { editorEnvironment } from './editorEnvironment';
import { namesOf, WAIT_SECONDS, yoloOf } from './settings';
import { FacadeSettings } from './facadeSettings';
import { homeReloadText, UnusableHome, unusableHomeText, useFacadeHome } from './home';
import { migratedText, notMadeText } from './settingsNotice';
import { showComponentMissing, waitForWindowIdentity } from './windowComponent';
import { registerShowLaunch, watchSettingsFile } from './showLaunch';
import { WindowLifetime } from './windowLifetime';
import { KeptWorkspaceState } from './workspaceState';

declare const FACADE_TEST_MODE: boolean;

/** Where the window's workspace keeps its key, for the window's reloads (ARCHITECTURE-2.2). */
const WORKSPACE_KEY = 'facade.workspaceKey';
/** The longest wait between attempts to list this window's runs: well within the five minutes they are kept for it (RULES-4.1). */
const MOST_RESTORE_WAIT_MS = 30_000;

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

/** The workspace this window keeps its runs under: its workspace file, else its first folder (ARCHITECTURE-3.1). */
function workspaceUri(): string {
	return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString() ?? `untitled:${vscode.env.sessionId}`;
}

/**
 * The composition root (ARCHITECTURE-1.3): the core's ports wired to the editor, ptyd and the execution environment's Facade
 * directory. Returns what deactivation runs: the window detaches, and its agents' processes go on in ptyd (RULES-4.1).
 */
export async function activateFacade(context: vscode.ExtensionContext): Promise<() => Promise<void>> {
	// The Facade home first, before anything reads it (ARCHITECTURE-3.1): one that is no path starts nothing, never another home
	try {
		useFacadeHome(context, { terminals: true, offerReload: true, reloadText: homeReloadText });
	} catch (err) {
		throw err instanceof UnusableHome ? new ActivationError(unusableHomeText(err.value), false, 'facade.home') : err;
	}
	const home = facadeHome();
	const session = vscode.env.sessionId;
	// The window component comes with Facade Code's extension pack, maybe after it: waited for a bounded time (ARCHITECTURE-4.3)
	const identity = await waitForWindowIdentity(session);
	if (isDamagedWindowIdentity(identity, session)) {
		// No other identity is invented (ARCHITECTURE-2.2), and a reload reads the same record: another window has its own
		throw new ActivationError(vscode.l10n.t("This window's Facade Code record is damaged, so its agents cannot be restored here. Close this window and open its folder or workspace again, or restart {0}.", vscode.env.appName), false);
	}
	if (isUnreadableWindowIdentity(identity, session)) {
		// Not read now - a lock, no file handles left - which a reload may not meet again: the component is there, and says so
		throw new ActivationError(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
	}
	if (!identity) {
		const missing = showComponentMissing(context, session);
		return async () => missing.dispose();
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
	let eventContext: Readonly<Record<string, unknown>> = {};
	const log: LogPort = { event: text => agentLog.event(text), fact: (event, fields) => agentLog.fact(event, { ...eventContext, ...fields }) };
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
		// ptyd is told whether the claiming window is local: a local window's runs end 90 seconds after it goes, a remote window's five
		// minutes after, unless a window of the workspace claims them first (RULES-4.1)
		claim: { ...claim, local: vscode.env.remoteName === undefined },
		ptydScript: vscode.Uri.joinPath(context.extensionUri, 'dist', 'ptyd.js').fsPath,
		version: String(context.extension.packageJSON.version),
		home,
		media: vscode.Uri.joinPath(context.extensionUri, 'media'),
		// Read when a tab opens, from the settings file as it is then (CONFIGURATION-2.4)
		icon: (cli: string): string => clis.icons()(cli),
		log: line => agentLog.event(line),
		terminalOwner: { ...terminalOwner, remote: vscode.env.remoteName !== undefined },
		shimScript: vscode.Uri.joinPath(context.extensionUri, 'dist', 'shim.js').fsPath
	});
	const worktrees = createWorktreeService(locations, log);
	// Facade's settings file (CONFIGURATION-1.1, 1.3): made now where it does not exist - from the editor's old Facade settings, said once
	// by the window that made it (CONFIGURATION-6.3) - and read on every use
	const settings = new FacadeSettings({
		legacy: name => vscode.workspace.getConfiguration().inspect(name)?.globalValue,
		log: line => log.event(line),
		migrated: (file, notes) => {
			const open = vscode.l10n.t("Open");
			void Promise.resolve(vscode.window.showInformationMessage(migratedText(settings.shown, notes), open)).then(choice => {
				if (choice === open) {
					return vscode.window.showTextDocument(vscode.Uri.file(file));
				}
				return undefined;
			}).catch(err => log.event(`Could not open ${settings.shown}: ${messageOf(err)}`));
		}
	});
	settings.snapshot();
	const yolo = yoloOf(settings);
	const names = namesOf(settings);
	const clis = new HostClis({ settings, log: line => log.event(line), fact: (event, fields) => log.fact?.(event, fields), home, version: String(context.extension.packageJSON.version),
		// The server a start would be given, as Show Agent Launch shows it: what only a start has named, never valued (CLIS-4.1)
		server: run => ({ ...execution.shimLaunch(run, '#aN', PLACEHOLDERS.context), instructions: PLACEHOLDERS.instructions }) });
	// This window on the client network, through its local component (COLLABORATION-1.1). One too old for it reaches no other window
	// and numbers nothing, so that this window starts and sends nothing until it is updated (ARCHITECTURE-4.3, RULES-2.2)
	const address = await networkAddress(session);
	const network: NetworkPort = address !== undefined ? new ClientNetwork(address, session) : new OutdatedComponent(`win-${crypto.randomBytes(8).toString('hex')}`);
	// Numbers come from this computer's counter alone (RULES-2.2): a local window shares this computer's Facade directory with its
	// component, and reads that counter itself where its pool runs dry; a remote window cannot, and asks for numbers past those its
	// environment's own counters gave - an earlier build's, which the component cannot read
	const local = vscode.env.remoteName === undefined;
	const direct = (kind: 'agent' | 'message') => local ? () => allocateNumbers(home, kind, 1).first : undefined;
	const floor = (kind: 'agent' | 'message') => local ? undefined : () => environmentFloor(home, kind);
	const agentNumbers = new AliasPool('agent', direct('agent'), line => log.event(line), session, local ? LOCAL_POOL : REMOTE_POOL, floor('agent'));
	const messageNumbers = new AliasPool('message', direct('message'), line => log.event(line), session, local ? LOCAL_POOL : REMOTE_POOL, floor('message'));
	if (address !== undefined && !(await agentNumbers.prime() && await messageNumbers.prime())) {
		log.event('This computer\'s alias counters could not be read yet: a start or send is refused while no number can be taken for it.');
	}
	if (address === undefined) {
		log.event('The Facade Code Window Component is too old for the client network: agents here reach this window\'s agents alone, and no agent can be started or message sent until it is updated.');
	}
	const history = new WorkspaceLaunchHistory(workspaceState, log);
	const human = new WindowHuman(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const conversations = new ConversationFile(home);
	// The CLIs' own conversation stores where they run - this extension runs where its window's CLIs do: Resume lists them, and each
	// run's card says its conversation's title from them (LIFECYCLE-3.2, CLIS-2.4). An added entry of a built-in's type keeps its
	// conversations in its built-in's store, those it started listed under it (CONFIGURATION-2.3, 3.4); a program has none
	const vendorHistory = new VendorHistory({
		knownCwd: key => conversations.get(key)?.cwd,
		arguments: () => clis.storeArguments(),
		builtIns: () => clis.storeBuiltIns(),
		environment: cwd => { const location = locations.conversationLocation(cwd); return location ? clis.storeEnvironments(location) : {}; },
		associated: (environment, store, sessionId) => conversations.associated(environment, store, sessionId),
		unavailable: (cli, cwd, store) => { const location = locations.conversationLocation(cwd); return location ? clis.resumeProblem(cli, location, store) : 'The original working directory is unavailable.'; }
	});
	const agents = new AgentService({
		execution,
		planner: clis,
		locations,
		worktrees,
		history,
		human,
		conversations,
		titles: vendorHistory,
		pinStore: new WorkspacePins(workspaceState, log),
		newPinId: () => `pin-${crypto.randomBytes(16).toString('hex')}`,
		retained: new RetainedFile<RetainedRun>(record.dir, writeIfOwned),
		aliases: address !== undefined ? agentAliases(agentNumbers) : NO_AGENT_NUMBERS,
		clock: { now: Date.now },
		log,
		lifetime: new WindowLifetime(),
		yolo,
		names,
		// Facade's own reasons in the person's language: a worktree's problem, a CLI's configuration, a working location (UX-2.4)
		describe: (err, english) => worktreeProblemText(err, err instanceof PlanError || err instanceof FacadeError ? reasonText(err.said, english) : english),
		// The run's own shim, where orchestration is on for this start (RULES-4.4, MCP-6.1)
		tools: (run, facts, location) => {
			const context = launchContextText({
				creator: { id: facts.creator ? /#a\d+$/.exec(facts.creatorLabel ?? '')?.[0] ?? facts.creator : '#human', label: facts.creatorLabel },
				window: window.label, windowId: window.id, locationId: location.id, logFile: agentLog.eventsFile, location,
				...(facts.promptId ? { initialMessage: facts.promptId.replace(/^m-/, '#m') } : {})
			});
			return { ...execution.shimLaunch(run, facts.alias, context), instructions: instructionsFor(facts.alias, context) };
		},
		// What a start types before its first turn goes ahead of every message to it (COLLABORATION-2.2); `input` exists by any launch
		warmUp: (run, warmUp): Promise<void> => input.warmUp(run, warmUp),
		newRunId: () => `run-${crypto.randomBytes(16).toString('hex')}`
	});
	// This window's address for the tools: it may change on reload, while its runs keep their IDs (ARCHITECTURE-2.2)
	// The name of a window that has no folder or workspace open, as agents and message headers name it
	const window = { id: network.self, label: vscode.workspace.name ?? vscode.l10n.t('Window') };
	const environment = editorEnvironment();
	eventContext = { window_id: window.id, window: window.label, environment };
	log.fact?.('window_attached', { workspace: uri });
	const contact = new WindowContact(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const input: OrdinaryInput = new OrdinaryInput({
		get: run => agents.get(run),
		inspectInput: (run, adapter) => execution.inspectInput(run, adapter),
		typeText: (run, text, enter, lead) => execution.typeText(run, text, enter, lead),
		pressKeys: (run, keys) => execution.pressKeys(run, keys),
		readScreen: (run, lines) => execution.readScreen(run, lines),
		log: text => log.event(text)
	});
	// Direct text and keys wait for a message's paste and Enter under way to the same terminal (RULES-1.10)
	const terminal = {
		readScreen: (run: RunId, lines: number) => execution.readScreen(run, lines),
		typeText: (run: RunId, text: string, enter: boolean) => input.inTurn(run, () => input.typeDirect(run, text, enter)),
		pressKeys: (run: RunId, keys: readonly string[]) => input.inTurn(run, () => input.pressDirect(run, keys))
	};
	const messages = new MessageService({
		agents,
		receipt: deliveryReceipt,
		input,
		human: contact,
		store: new MessageFile<MessageRecord>(home),
		ids: address !== undefined ? { next: () => messageNumbers.next() } : NO_MESSAGE_NUMBERS,
		sent: new MessageFile<MessageRecord>(home, Date.now, path.join('messages', 'sent')),
		results: {
			report: async (other, result) => {
				const response = await network.route(other, 'result', { to: result.to, text: result.text, about: result.about, ...result.result !== undefined ? { result: result.result } : {}, ...result.callId !== undefined ? { callId: result.callId } : {} }, STAGE_MS);
				return response.ok;
			}
		},
		clock: { now: Date.now },
		window,
		environment,
		workspace: record.key,
		log,
		said: (run, text, source) => agents.said(run, text, source)
	});
	// An agent another agent started, waiting on its CLI's own question, is reported to that creator (RULES-1.8)
	const attention = new AttentionNotices({ agents, messages, log: text => log.event(text) });
	// Reattach first: the panel shows its progress until this window's runs are known (LIFECYCLE-3.5, PANEL-1.1). A window that
	// cannot list them yet - its ptyd not answering - keeps trying, as they end five minutes after no window claims them (RULES-4.1)
	let restoreRetry: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const retry = { first: RECONCILE_MS, most: MOST_RESTORE_WAIT_MS, stopped: () => disposed, wait: (ms: number) => new Promise<void>(resolve => { restoreRetry = setTimeout(resolve, ms); }) };
	// A restore that fails outright is tried again as one whose listing failed: one failed write leaves no agent unseen (RULES-4.1)
	let restoreFailure: string | undefined;
	const restored = untilAnswered(() => agents.restore(), {
		...retry,
		failed: err => {
			if (messageOf(err) !== restoreFailure) {
				restoreFailure = messageOf(err);
				log.event(`Could not show this window's agents, trying again: ${restoreFailure}`);
			}
		}
	});
	const ready = restored.then(() => execution.finishRestore()).catch(err => log.event(`Could not reconcile this window's agents: ${messageOf(err)}`));
	// Then a ptyd listing runs of this window that it shows no pair of - one of an earlier protocol found late, or a failed reattach -
	// restores again, one restore at a time: no started agent is left out (RULES-4.1)
	void ready.then(async () => {
		try { await locations.refresh(); } catch (err) { log.event(`Could not refresh locations before restoring pins: ${messageOf(err)}`); }
		if (!disposed) { await agents.restorePins(); }
	}).catch(err => log.event(`Could not restore pinned agents: ${messageOf(err)}`));
	let restoring: Promise<unknown> = ready;
	const found = execution.onDidFindRuns(() => {
		restoring = restoring.then(() => disposed ? undefined : agents.restore()).catch(err => log.event(`Could not show this window's agents again: ${messageOf(err)}`))
			// Deliveries to the agents shown now go on, within their own deadlines (RULES-1.9)
			.then(() => disposed ? undefined : messages.resume()).catch(err => log.event(`Could not go on with this window's deliveries: ${messageOf(err)}`));
	});
	// The eight tools, for every run of this window whose shim calls in (MCP-1.1, 6.1)
	const services = createToolServices({
		window: { ...window, environment },
		agents,
		locations,
		clis,
		messages,
		terminal,
		home,
		writeResult,
		historyLog: agentLog.eventsFile,
		timeout: () => WAIT_SECONDS,
		yolo,
		settingsFile: settings.shown,
		input,
		clock: { now: Date.now },
		log: text => log.event(text),
		recordEvent: (event, fields) => log.fact?.(event, fields),
		// A call from a run this window is still reattaching waits for it (RULES-4.1)
		ready,
		network
	});
	const tools = execution.serveTools((call, receivedAt) => services.answer(call, receivedAt));
	// Deliveries this window's earlier opening began go on within their deadlines once its agents are known again (RULES-1.9)
	void ready.then(() => disposed ? undefined : messages.resume()).catch(err => log.event(`Could not go on with this window's deliveries: ${messageOf(err)}`));
	// Project files injected for runs that are gone everywhere in this environment are released (CLIS-2.2); old results expire
	void ready.then(() => execution.allRunIds()).then(alive => clis.reconcile(alive)).catch(err => log.event(`Could not release injected files of ended agents: ${messageOf(err)}`));
	try {
		pruneResults(home, Date.now());
	} catch (err) {
		log.event(`Could not remove expired result files: ${messageOf(err)}`);
	}
	// The settings file saved, made or removed, for the cards to show their icons as it says them now (CONFIGURATION-2.4)
	const settingsChanged = new vscode.EventEmitter<void>();
	// Reuse location/configuration events; unchanged scans are not repeated in history. No polling or CLI processes.
	let lastLocations = '';
	const scanLocations = () => {
		if (disposed) { return; }
		const catalog = locations.snapshot();
		const fields = { folders: catalog.folders.map(({ name, uri, path }) => ({ name, uri, path })),
			locations: catalog.locations.filter(each => !each.within).map(({ id, path, kind, branch, isMain }) => ({ location_id: id, path, kind, branch, is_main: isMain })), pending: catalog.pending };
		const signature = JSON.stringify(fields);
		if (signature !== lastLocations) { lastLocations = signature; log.fact?.('locations_scanned', fields); }
		for (const location of catalog.locations) {
			void clis.list(location).catch(err => log.fact?.('cli_scan_failed', { location_id: location.id, reason: messageOf(err) }));
		}
	};
	scanLocations();
	const diagnostics: DiagnosticsDeps = {
		agents,
		locations,
		clis,
		readScreen: (run, lines) => execution.readScreen(run, lines),
		inspect: run => input.inspect(run),
		logFile: agentLog.file,
		version: String(context.extension.packageJSON.version),
		...identity.component ? { component: identity.component } : {},
		home: os.homedir()
	};
	const disposables: vscode.Disposable[] = [
		human,
		locations.onDidChange(scanLocations),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminal.integrated')) { scanLocations(); }
		}),
		// The settings file saved, made or removed: the CLIs found again, and the cards' icons read again (CONFIGURATION-1.1, 2.4)
		settingsChanged,
		...watchSettingsFile(settings.file, () => { scanLocations(); settingsChanged.fire(); }),
		...registerUi({
			agents,
			// Open Settings and New Agent's gear: the editor's Settings at Facade Code's section, whose Edit in facade.json link opens the
			// file (CONFIGURATION-1.2)
			openSettings: async () => {
				await openSettingsOf(context.extension.id);
			},
			names,
			icons: () => clis.icons(),
			settingsChanged: settingsChanged.event,
			savedName: key => conversations.get(key)?.name,
			conversations: vendorHistory,
			readsTitles: cli => vendorHistory.readsTitles(cli),
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
			motion: reduced => execution.systemMotion(reduced),
			...(identity.remote ? { remote: identity.remote } : {})
		}),
		...registerWorktreeCommands({ locations, worktrees, agents, notifyError: (text, options) => human.error(text, options), log }),
		// The link of Facade's item in the editor's Settings: the settings file, made first where there is none (CONFIGURATION-1.2, 1.3)
		vscode.commands.registerCommand(COMMANDS.openSettingsFile, async () => {
			const generated = settings.ensure();
			if (generated.kind === 'failed') {
				void vscode.window.showErrorMessage(reasonText(generated.problem.said, generated.problem.text));
				return;
			}
			if (generated.kind === 'conflict') {
				void vscode.window.showErrorMessage(notMadeText(settings.shown, generated.problems));
				// The old values to fix are the editor's own settings: on this computer, or the remote machine's (CONFIGURATION-6.2)
				await vscode.commands.executeCommand(vscode.env.remoteName ? 'workbench.action.openRemoteSettingsFile' : 'workbench.action.openSettingsJson');
				return;
			}
			try {
				await vscode.window.showTextDocument(vscode.Uri.file(settings.file), { preview: false });
			} catch (err) {
				// A file the editor cannot open - a folder of its name, one it may not read - is said with why (CONFIGURATION-1.2)
				// {0} is the settings file; {1} the editor's reason
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} could not be opened: {1}", settings.shown, messageOf(err)));
			}
		}),
		registerShowLaunch(clis, locations, log, settings, identity.remote),
		registerAgentsLog(agentLog.file),
		contact,
		// The integration suite's own: what an agent's terminal shows, for a journey's diagnostics, and the diagnostics report,
		// without the system clipboard; compiled out of the shipped extension
		...typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? [
			vscode.commands.registerCommand('facade.screen', (run: string, lines = 40) => execution.readScreen(run, lines)),
			vscode.commands.registerCommand('facade.testPaste', (run: string, text: string, lead?: string) => execution.typeText(run, text, false, lead)),
			vscode.commands.registerCommand('facade.messageInput', async (run: string, own?: string, lead?: string) => {
				await agents.warmedUp(run);
				return input.inspect(run, own, lead);
			}),
			vscode.commands.registerCommand('facade.diagnostics', () => diagnosticsOf(diagnostics))
		] : [],
		serveRoutes(route => services.serve(route)),
		publishAgents(agents, window.label, line => log.event(line), session)
	];
	context.subscriptions.push(...disposables);
	return async () => {
		disposed = true;
		log.fact?.('window_detached', {});
		// Its state's changes waiting to be written together are written now, while this activation may own them
		workspaceState.flush();
		clearTimeout(restoreRetry);
		found.dispose();
		tools.dispose();
		attention.dispose();
		messages.dispose();
		agents.dispose();
		// One that throws does not keep the rest open (ARCHITECTURE-2.4)
		disposeAll(disposables, err => log.event(`Could not dispose part of the window: ${messageOf(err)}`));
		locations.dispose();
		execution.dispose();
	};
}

/**
 * Open Settings (CONFIGURATION-1.2): the editor's Settings at Facade Code's section. A person whose Settings open as JSON gets, in a
 * remote window, facade.json itself: the editor opens them the Remote tab as the remote settings.json, without the section or its
 * Edit in facade.json link. Locally the editor shows the section to them too.
 */
export function openSettingsOf(extensionId: string): Thenable<unknown> {
	if (vscode.env.remoteName !== undefined && vscode.workspace.getConfiguration('workbench.settings').get('editor') === 'json') {
		return vscode.commands.executeCommand(COMMANDS.openSettingsFile);
	}
	return openFacadeSettings(`@ext:${extensionId}`);
}

/**
 * The editor's Settings at `query`, on the tab of the machine whose settings Facade's are (CONFIGURATION-1.2): in a remote window the
 * remote's, as Facade's settings are machine settings, which the User tab of a remote window does not show.
 */
function openFacadeSettings(query: string): Thenable<unknown> {
	return vscode.env.remoteName !== undefined
		? vscode.commands.executeCommand('workbench.action.openRemoteSettings', { query })
		: vscode.commands.executeCommand('workbench.action.openSettings', query);
}
