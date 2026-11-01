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
import { VendorHistory } from '../clis/history';
import { ConversationFile } from '../record/conversations';
import { WorkspacePins } from './pins';
import { isDamagedWindowIdentity, isUnreadableWindowIdentity, WINDOW_TERMINALS_COMMAND } from '../base/windowIdentity';
import { createToolServices } from '../contract/tools';
import { AgentService } from '../core/agents';
import { AttentionNotices } from '../core/attention';
import type { MessageRecord } from '../core/messagePorts';
import { MessageService, STAGE_MS } from '../core/messages';
import { PlanError, type LogPort, type RetainedRun, type RunId } from '../core/ports';
import { PANEL_VIEW } from '../ui/catalog';
import { worktreeProblemText } from '../ui/pickers/location';
import { reasonText } from '../ui/presentation';
import { registerUi } from '../ui/commands/index';
import { registerWorktreeCommands } from '../ui/commands/worktree';
import { AgentExecution } from './execution/agentExecution';
import { RECONCILE_MS } from './execution/executionSession';
import { AliasCounter } from '../record/aliases';
import { ChoiceStore } from '../record/choices';
import { AgentLog } from '../record/log';
import { MessageCounter, MessageFile } from '../record/messages';
import { facadeHome } from '../record/paths';
import { pruneResults, writeResult } from '../record/results';
import { RetainedFile } from '../record/retained';
import { nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { keepWindowKey, keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { allocateNumbers } from '../record/windowRegistry';
import { agentAliases, AliasPool, ClientNetwork, LOCAL_POOL, networkAddress, publishAgents, REMOTE_POOL, serveRoutes } from './client';
import { registerAgentsLog } from './agentsLog';
import { HostClis } from './clis';
import { WindowContact } from './contact';
import { diagnosticsOf, DiagnosticsDeps, registerDiagnostics } from './diagnostics';
import { WorkspaceLaunchHistory } from './history';
import { WindowHuman } from './human';
import { OrdinaryInput } from './input';
import { createLocationService, createWorktreeService } from './locations/index';
import { editorEnvironment } from './editorEnvironment';
import { registerMessageHistory } from './messageHistory';
import { readSetting, waitSeconds, yolo } from './settings';
import { showComponentMissing, waitForWindowIdentity } from './windowComponent';
import { registerShowLaunch } from './showLaunch';
import { WindowLifetime } from './windowLifetime';
import { KeptWorkspaceState } from './workspaceState';

declare const FACADE_TEST_MODE: boolean;

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
	// The window component comes with Facade Code's extension pack, maybe after it: waited for a bounded time (ARCHITECTURE-4.3, D94)
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
		terminalOwner: { ...terminalOwner, remote: vscode.env.remoteName !== undefined },
		shimScript: vscode.Uri.joinPath(context.extensionUri, 'dist', 'shim.js').fsPath
	});
	const worktrees = createWorktreeService(locations, log);
	const clis = new HostClis({ log: line => log.event(line), home });
	// This window on the client network, through its local component: without it, the tools reach this window alone (COLLABORATION-1.1)
	const address = await networkAddress(session);
	const network = address !== undefined ? new ClientNetwork(address, session) : undefined;
	const localAliases = new AliasCounter(home);
	const localMessages = new MessageCounter(home);
	// A local window shares this computer's Facade directory with its component: its fallback is the computer's own counter
	const local = vscode.env.remoteName === undefined;
	const fallback = (kind: 'agent' | 'message', environment: () => number) => local ? () => allocateNumbers(home, kind, 1).first : environment;
	const agentNumbers = new AliasPool('agent', fallback('agent', () => Number(localAliases.next().slice(2))), line => log.event(line), session, local ? LOCAL_POOL : REMOTE_POOL);
	const messageNumbers = new AliasPool('message', fallback('message', () => localMessages.next()), line => log.event(line), session, local ? LOCAL_POOL : REMOTE_POOL);
	if (network && !(await agentNumbers.prime() && await messageNumbers.prime())) {
		log.event('This computer\'s alias counters could not be read; aliases come from this environment\'s counters, and may repeat in other windows.');
	}
	if (!network) {
		log.event('The Facade Code Window Component cannot carry requests between windows: agents here reach this window\'s agents alone.');
	}
	const history = new WorkspaceLaunchHistory(workspaceState, log);
	const human = new WindowHuman(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const conversations = new ConversationFile(home);
	const agents = new AgentService({
		execution,
		planner: clis,
		locations,
		worktrees,
		history,
		human,
		conversations,
		pinStore: new WorkspacePins(workspaceState, log),
		newPinId: () => `pin-${crypto.randomBytes(16).toString('hex')}`,
		retained: new RetainedFile<RetainedRun>(record.dir, writeIfOwned),
		aliases: network ? agentAliases(agentNumbers) : localAliases,
		clock: { now: Date.now },
		log,
		lifetime: new WindowLifetime(),
		yolo,
		// Facade's own reasons in the person's language: a worktree's problem, a CLI's configuration (UX-2.4)
		describe: (err, english) => worktreeProblemText(err, err instanceof PlanError ? reasonText(err.said, english) : english),
		// The run's own shim, where orchestration is on for this start (RULES-4.4, MCP-6.1)
		tools: run => clis.collaborationEnabled() ? execution.shimLaunch(run) : undefined,
		// What a start types before its first turn goes ahead of every message to it (COLLABORATION-2.2); `input` exists by any launch
		warmUp: (run, warmUp): Promise<void> => input.warmUp(run, warmUp),
		newRunId: () => `run-${crypto.randomBytes(16).toString('hex')}`
	});
	// This window's address for the tools: it may change on reload, while its runs keep their IDs (ARCHITECTURE-2.2)
	// The name of a window that has no folder or workspace open, as agents and message headers name it
	const window = { id: address ?? `win-${crypto.randomBytes(8).toString('hex')}`, label: vscode.workspace.name ?? vscode.l10n.t('Window') };
	const environment = editorEnvironment();
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
		input,
		human: contact,
		store: new MessageFile<MessageRecord>(home),
		ids: network ? { next: () => messageNumbers.next() } : localMessages,
		sent: new MessageFile<MessageRecord>(home, Date.now, path.join('messages', 'sent')),
		results: {
			report: async (other, result) => {
				const response = await (network?.route(other, 'result', { to: result.to, text: result.text, about: result.about, ...result.callId !== undefined ? { callId: result.callId } : {} }, STAGE_MS)
					?? Promise.resolve({ ok: false as const, reason: 'window_unavailable' as const, message: 'No network', effects: 'none' as const }));
				return response.ok;
			}
		},
		clock: { now: Date.now },
		window,
		environment,
		workspace: record.key,
		log
	});
	// An agent another agent started, waiting on its CLI's own question, is reported to that creator (RULES-1.8, D109)
	const attention = new AttentionNotices({ agents, messages, log: text => log.event(text) });
	// Reattach first: the panel shows its progress until this window's runs are known (LIFECYCLE-3.5, PANEL-1.1). A window that
	// cannot list them yet - its ptyd not answering - keeps trying, as they end five minutes after no window claims them (RULES-4.1)
	let restoreRetry: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const retry = { first: RECONCILE_MS, most: MOST_RESTORE_WAIT_MS, stopped: () => disposed, wait: (ms: number) => new Promise<void>(resolve => { restoreRetry = setTimeout(resolve, ms); }) };
	// A restore that fails outright is tried again as one whose listing failed: one failed write leaves no agent unseen (RULES-4.1, D86)
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
	// restores again, one restore at a time: no started agent is left out (RULES-4.1, D86)
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
	// The nine tools, for every run of this window whose shim calls in (MCP-1.1, 6.1)
	const services = createToolServices({
		window: { ...window, environment },
		agents,
		locations,
		clis,
		messages,
		terminal,
		home,
		writeResult,
		choices: new ChoiceStore(home),
		timeout: () => waitSeconds(readSetting, text => log.event(text)),
		yolo,
		input,
		clock: { now: Date.now },
		log: text => log.event(text),
		// A call from a run this window is still reattaching waits for it (RULES-4.1)
		ready,
		...network ? { network } : {}
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
		...registerUi({
			agents,
			conversations: new VendorHistory({
				knownCwd: key => conversations.get(key)?.cwd,
				arguments: () => clis.storeArguments(),
				environment: cwd => { const location = locations.conversationLocation(cwd); return location ? clis.storeEnvironments(location) : {}; },
				unavailable: (cli, cwd) => { const location = locations.conversationLocation(cwd); return location ? clis.resumeProblem(cli, location) : 'The original working directory is unavailable.'; }
			}),
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
		...registerWorktreeCommands({ locations, worktrees, agents, notifyError: (text, options) => human.error(text, options), log }),
		registerShowLaunch(clis, locations, log, identity.remote),
		registerAgentsLog(agentLog.file),
		contact,
		...registerMessageHistory({ messages }),
		...registerDiagnostics(diagnostics),
		// The integration suite's own: what an agent's terminal shows, for a journey's diagnostics, and what Copy Diagnostics would copy,
		// without the system clipboard; compiled out of the shipped extension
		...typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? [
			vscode.commands.registerCommand('facade.screen', (run: string, lines = 40) => execution.readScreen(run, lines)),
			vscode.commands.registerCommand('facade.diagnostics', () => diagnosticsOf(diagnostics))
		] : [],
		serveRoutes(route => services.serve(route)),
		publishAgents(agents, window.label, line => log.event(line), session)
	];
	context.subscriptions.push(...disposables);
	return async () => {
		disposed = true;
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
