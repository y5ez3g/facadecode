/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { processStartTimeAsync } from '../base/system';
import { disposeAll } from '../base/lifecycle';
import { isJsonObject } from '../base/json';
import { InstalledCli } from '../clis/cli';
import { installedClis, knownClis, locateCli, turnedOffClis } from '../clis/registry';
import { facadeSkill, firstLineFor } from '../contract/prompts';
import { Contract, toolDefinitions, WindowWorkbench } from '../contract/tools';
import { FacadeError } from '../core/errors';
import { CallerIdentity, callerOfRequest, Machine, SILENT_WAIT_MS, WINDOW_REQUESTS } from '../core/machine';
import { Facade, workOf } from '../core/facade';
import { AgentTable, countOnFrom, numberedUpTo } from '../record/agents';
import { MachineCounters } from '../record/counters';
import { agentRef, Caller, foreignRef, isLive, PERSON } from '../record/events';
import { earlierRecordOf, identityOf, isSameWorkspace, isWorkspaceId, recordDirOf, recordFor } from '../record/identity';
import { ClosedBy, LedgerLockedError, LedgerUnreadableError, lockStateOf, lockWait } from '../record/ledger';
import { AGENTS_LOG } from '../record/log';
import { noticesFor } from '../record/outbox';
import { countersFile, deletionsRoot, outboxRoot, repositoryLocksRoot, roomsRoot, windowKeyFile, workspacesRoot } from '../record/paths';
import { PipeEndpoint, WindowFacts } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { labelOf, WindowLink } from '../transport/windows';
import { HostGit } from './git';
import { HostMachine } from './machine';
import { HostPerson } from './person';
import { confirmDeleteRooms, pickRoom } from './rooms';
import { ScreenDocuments } from './screenDocuments';
import { configFor, customAgents, frameworkOn, settingsProblems, timeoutMs, worktreesManaged, yolo } from './settings';
import { folderOnScreen, OfferedAgent, pickAgent, terminalPlace } from './startAgent';
import { agentProcessesRun, HostTerminals, terminalEnvironment } from './terminals';
import { JsonFileState, StateStore } from './windowState';

const PIPE_ID_KEY = 'facade.agents.pipeId';
/** Another window of the machine, as the pipe knows a caller that holds the machine's key (AGENT-ORCHESTRATION.md, O8). */
const WINDOW_CALLER = 'window';
/** Who calls on the pipe: an agent of this window, the person's script, or another window. */
type PipeCaller = Caller | typeof WINDOW_CALLER;
const WINDOW_STATE_FILE = 'window-state.json';
/** The workspace's id, which names its record: kept in its `workspaceState`, which VS Code carries over as the workspace is saved under another name. */
const WORKSPACE_ID_KEY = 'facade.agents.workspaceId';
/** Where a build before workspace ids kept the path of the workspace's record, in its `workspaceState`. */
const EARLIER_RECORD_KEY = 'facade.agents.record';
/** What the other workspaces of the machine have in a folder a deletion asks of (O5; WT-8): by workspace, those silent, and windows of another version, which are not asked. */
export interface WorkElsewhere {
	readonly workspaces: readonly { readonly record: string; readonly label: string; readonly agents: readonly string[]; readonly runs: readonly number[]; readonly terminals: readonly string[]; readonly editors: readonly string[] }[];
	readonly silent: readonly string[];
	readonly otherVersions: readonly string[];
}

/** Who this workspace's window is to its ledger, the same through its reloads: kept in its `workspaceState`. */
const OWNER_KEY = 'facade.agents.owner';
/**
 * When a folder window becomes a workspace, its extension host starts again while the one before can
 * still be letting go of the ledger and the pipe: this long, what it holds is waited for.
 */
const HANDOVER_MS = 10_000;
/**
 * How long the ledger stays open, as the window goes, for the calls under way to record what they did -
 * a worktree git finished making: within the five seconds the extension host gives its extensions to stop.
 */
const CLOSE_WAIT_MS = 3_000;
/** How often what another extension host holds is looked at, while it is waited for. */
const HANDOVER_POLL_MS = 250;

/**
 * Facade's agents, and the one place the layers are put together: the workspace's record under
 * ~/.facade/workspaces, the core with the window as its ports, the contract behind the pipe, and the agents
 * still running after a reload found again. The agent framework's switch, `facade.orchestration.enabled`,
 * takes away only what agents do to agents: off, the tools answer that it is, and new launches get none of
 * its integration, while the person's agents start, run and end as ever (AGENT-LAUNCHER.md, L13).
 */
export class AgentsService implements vscode.Disposable {

	private readonly disposables: { dispose(): void }[] = [];
	private facade: Facade | undefined;
	/** Why there is no core once the service started: another window has the workspace's agents, or no folder is on this machine. */
	private noCore: 'otherWindow' | 'noFolder' | 'unreadable' | undefined;
	private endpoint: PipeEndpoint<PipeCaller> | undefined;
	/** The other windows of the machine, as this one reaches them (AGENT-ORCHESTRATION.md, O8). */
	private machine: HostMachine | undefined;
	/** Set once the window closed - closing, quitting or replacing its workspace - and its runs ended with it (AGENT-LAUNCHER.md, L6). */
	private closing = false;
	/** The workspace's record, open in this window. */
	private table: AgentTable | undefined;
	/** That record's id, as the window's commands name it. */
	private recordId: string | undefined;
	/** Set once the service stopped: as the window goes, as Facade agents are turned off, or as another window took its agents. */
	private stopped = false;
	/** How it stopped first: as the window went, or as Facade let go of its agents. */
	private stoppedBy: ClosedBy | undefined;
	/** The calls under way - an agent's tool call, the person's start - which the ledger stays open for as the service stops. */
	private readonly underWay = new Set<Promise<unknown>>();
	/** Settles once the service stopped and its ledger is closed. */
	private closed: Promise<void> | undefined;

	/** Where Facade's notices go, and the last screens of agents that ended. */
	private person: HostPerson | undefined;
	/** The built-ins this machine has and the person offers - their settings wrong too - as a terminal found them when last looked for (X-39). */
	private installed: readonly InstalledCli[] = [];

	/**
	 * `workspaceState` keeps the id of the record this workspace's agents are in, as its folders come and go;
	 * `screenDocuments` opens their last screens, as it does with the agent framework off.
	 */
	constructor(private readonly log: vscode.LogOutputChannel, private readonly workspaceState: vscode.Memento, private readonly screenDocuments: ScreenDocuments) { }

	/** The folder of the workspace's record this window has, once it is known: where its `agents.log` is (X-67). */
	private recordDir: string | undefined;

	/** The person's history of this window's agents: its record's `agents.log`; undefined until the record is known. */
	get agentsLog(): string | undefined {
		return this.recordDir !== undefined ? path.join(this.recordDir, AGENTS_LOG) : undefined;
	}

	/**
	 * Opens the workspace's record, listens for its agents, and finds again those still running. Without
	 * a folder on this machine, or while another window has the workspace's agents, there is no core, and
	 * Start Agent says why. Stopped meanwhile, it lets go of what it took and returns.
	 */
	async start(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		if (!folders.length && !await keepsAgentsWithoutFolder(this.workspaceState)) {
			this.log.info('Facade agents require a local folder in the workspace. Nothing was started.');
			this.noCore = 'noFolder';
			return;
		}
		// The record this very window had, as the window remembers it, goes first: its extension host started
		// again under it - its folder window became a workspace, it was saved under another name, the extension
		// host was restarted or crashed - and VS Code gave this one the new workspace's storage, which knows
		// nothing of it, while the window's agents run on (AGENT-LAUNCHER.md, L12). Otherwise the record the
		// workspace's storage names, while it names this workspace; any other workspace gets one of its own.
		const load = await windowLoad();
		const fromWindow = load.record;
		// With no folder, the workspace file: a window keeps its agents without one only as a workspace
		const workspace = (vscode.workspace.workspaceFile ?? folders[0].uri).toString();
		const storedId = fromWindow?.id ?? this.workspaceState.get(WORKSPACE_ID_KEY);
		if (isWorkspaceId(storedId)) {
			await this.handedOver(recordDirOf(workspacesRoot(), storedId), workspace);
		}
		const windowsOwn = (kept: string) => (fromWindow !== undefined && kept === recordDirOf(workspacesRoot(), fromWindow.id)) || (load.id !== undefined && lockStateOf(kept).closedIn === load.id);
		const { id, dir, isNew } = recordFor(workspacesRoot(), storedId, workspace, windowsOwn);
		this.recordDir = dir;
		await this.workspaceState.update(WORKSPACE_ID_KEY, id);
		if (isNew) {
			this.log.info(`Created a new record for workspace ${workspace} at ${dir}.`);
			// The record a build before workspace ids kept of it: its agents' numbers are never given again
			// (AGENT-LAUNCHER.md, L2; X-49)
			const earlier = folders.length ? earlierRecordOf(workspacesRoot(), this.workspaceState.get(EARLIER_RECORD_KEY), folders[0].uri.fsPath) : undefined;
			// - nor its messages' (AGENT-MESSAGES.md, M10)
			const reached = earlier === undefined ? undefined : numberedUpTo(earlier);
			if (earlier !== undefined && reached && (reached.agents > 0 || reached.messages > 0)) {
				countOnFrom(dir, reached);
				this.log.info(`Previous-build record ${earlier} used agent IDs through #a${reached.agents} and message IDs through #m${reached.messages}. This record continues from #a${reached.agents + 1} and #m${reached.messages + 1}.`);
			}
		}
		// The same window, its extension host started again: who it is to its ledger goes on too, and the
		// agents that ended stay in its list - it is no fresh start.
		const sameWindow = fromWindow?.id === id;
		const owner = sameWindow ? await this.keepOwner(fromWindow.owner) : await this.owner();
		await rememberWindowRecord(id, owner);
		// A ledger Facade cannot read is moved aside only at a start of the window that is no reload, with
		// none of its agents' processes in a terminal of the window: the history is in the log.
		let table: AgentTable | undefined;
		try {
			table = await this.openTable(dir, owner, load.id, () => false).catch(async err => {
				if (err instanceof LedgerUnreadableError && !load.reloaded && !await agentProcessesRun(id)) {
					// Reported, not dropped quietly: only a last line a crash cut short is (L12; N-31)
					return this.openTable(dir, owner, load.id, () => true, (why, keptAs) => {
						const history = path.join(dir, AGENTS_LOG);
						this.log.error(`${why}. Preserved the previous record as ${keptAs} and started a new agent list. agents.log retains the history; agent IDs continue without reuse.`);
						// What happened, and what the person is to do about it - nothing, but where to look (L12; N-31)
						void vscode.window.showErrorMessage(vscode.l10n.t("Facade could not read this workspace's agent record ({0}), so it started a new one. No action is needed: agents start as before, and their numbering continues. Their history is in {1}; the unreadable record is kept as {2}. Delete it once you no longer need it.", why, history, keptAs));
					});
				}
				throw err;
			});
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				// One actionable error (L12; N-32): where the agents are, and how to have them here instead
				void vscode.window.showErrorMessage(vscode.l10n.t("Another Facade window manages this workspace's agents. Use that window, or close it and reload this window to manage them here."));
				this.noCore = 'otherWindow';
				return;
			}
			if (err instanceof LedgerUnreadableError) {
				this.log.error(err.message);
				void vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's agent record: {0}", err.message));
				this.noCore = 'unreadable';
				return;
			}
			throw err;
		}
		if (!table) {
			return;
		}
		// Closed last, saying how Facade stopped
		this.table = table;
		this.recordId = id;
		if (this.stopped) {
			this.dispose();
			return;
		}

		// The pipe's id, next to the ledger rather than in the workspace storage, which a folder window
		// becoming a workspace replaces while agents keep running.
		const windowState = new JsonFileState(path.join(dir, WINDOW_STATE_FILE));
		const terminals = new HostTerminals(id, message => this.say(message));
		this.disposables.push(terminals);

		// The CLIs this machine has, as a terminal finds them: Facade's own PATH until they are looked for there (X-39)
		this.installed = installedClis(configFor);
		// The other windows of the machine, and what this one says of itself to them (AGENT-ORCHESTRATION.md, O1, O8)
		const product = productOf();
		// The application instance is the extension host's parent, the main process: by its id and start, it tells a
		// workspace whose app crashed from one that reloads or hangs (O8)
		const instanceStart = await processStartTimeAsync(process.ppid);
		const facts: WindowFacts = {
			record: id,
			...(vscode.workspace.name ? { workspace: vscode.workspace.name } : {}),
			...(folders.length ? { folder: folders[0].uri.fsPath } : {}),
			...(product.version ? { version: product.version } : {}),
			...(product.commit ? { commit: product.commit } : {}),
			load: crypto.randomUUID(),
			instance: { pid: process.ppid, ...(instanceStart !== undefined ? { start: instanceStart } : {}) }
		};
		const link = new WindowLink(windowKeyFile());
		const machine = new HostMachine(link, workspacesRoot(), outboxRoot(), deletionsRoot(), { record: id, label: labelOf(facts as WindowFacts & { record: string }), ...(facts.load ? { load: facts.load } : {}), ...(facts.version ? { version: facts.version } : {}), ...(facts.commit ? { commit: facts.commit } : {}) }, timeoutMs, message => this.say(message));
		// What another workspace's deletion asks of this window's workbench: its terminals and unsaved editors in a folder,
		// and to stop and discard them (O5; WT-8)
		const texts = (value: unknown) => Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
		const workbench: WindowWorkbench = {
			workIn: async folder => {
				// A window that cannot say what it has there says so: the deletion asking is refused, not told of nothing (O5)
				const found = await vscode.commands.executeCommand<unknown>('_facade.work.in', vscode.Uri.file(folder)) as { terminals?: unknown; editors?: unknown } | undefined;
				return { terminals: texts(found?.terminals), editors: texts(found?.editors) };
			},
			workRelease: async (folder, discard) => texts(await vscode.commands.executeCommand<unknown>('_facade.work.release', vscode.Uri.file(folder), discard).then(undefined, err => [messageOf(err)]))
		};
		this.machine = machine;
		const facade = new Facade({
			machine,
			table,
			ports: {
				terminals,
				git: new HostGit(id),
				workspace: {
					folders: () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
					activeFolder: folderOnScreen,
					worktreesManaged
				},
				person: this.person = new HostPerson(terminals, this.screenDocuments, agent => this.facade?.endedAgent(agent), message => this.say(message))
			},
			clis: {
				known: knownClis(),
				custom: customAgents,
				installed: () => this.installed,
				refresh: async () => {
					const { folder, env } = await terminalPlace();
					this.installed = installedClis(configFor, env, folder);
				},
				locate: (cli, config, env, folder) => locateCli(cli, config, env, folder),
				yolo,
				framework: frameworkOn,
				configOf: configFor,
				environment: terminalEnvironment
			},
			// No agent starts before the endpoint below listens: their MCP servers call it.
			setup: {
				connection: tokenFile => this.listening().connection(tokenFile, timeoutMs(), dir),
				sharedMcpServer: () => this.listening().sharedMcpServer(),
				agentEnv: tokenFile => this.listening().agentEnv(tokenFile, timeoutMs()),
				skills: () => [facadeSkill()],
				firstLine: firstLineFor
			},
			timing: () => ({ startTimeoutMs: timeoutMs() }),
			notices: () => noticesFor(outboxRoot(), id),
			roomsFolder: roomsRoot(),
			repositoryLocks: repositoryLocksRoot(),
			settingsProblems,
			log: message => this.say(message)
		});
		this.disposables.push(facade);

		const contract = new Contract(facade);
		// The endpoint listens before the record is reconciled - an agent's MCP server says hello as it comes
		// back - but a tool call waits for it: answered before, `list_agents` would show agents gone with the
		// window as running, and a stop would race the reconciliation (L12). Another window of the machine calls
		// it too, with the machine's key (AGENT-ORCHESTRATION.md, O8).
		let reconciled = () => { };
		const reconciliation = new Promise<void>(resolve => reconciled = resolve);
		const endpoint = this.endpoint = await this.listen(windowState, dir, {
			// Never an empty key: a request that sends none is no window of the machine (O8)
			authenticate: token => token && token === link.windowKey ? WINDOW_CALLER : table.authenticate(token),
			hello: (caller, server) => caller === WINDOW_CALLER ? contract.windowHello(facts) : contract.hello(caller, server),
			call: (caller, tool, args, progress, whenWritten) => this.whileUnderWay(reconciliation.then(() => caller === WINDOW_CALLER
				? contract.windowCall(tool, args, progress, whenWritten, workbench)
				: contract.call(caller, tool, args, progress, whenWritten))),
			mayExceed: caller => caller === WINDOW_CALLER,
			log: message => this.log.error(message)
		}, [...table.state.agents.values()].some(isLive), windowState.unreadable, facts);
		if (!endpoint) {
			return;
		}
		// Its record stays through a reload, for the other workspaces to wait for it; it goes as the window closes (O8)
		this.disposables.push({ dispose: () => endpoint.dispose(this.closing) });
		// What of the person's settings Facade does not take as set is said as Facade starts, and as they change (X-59)
		const sayProblems = () => settingsProblems().forEach(problem => this.say(`${problem}.`));
		sayProblems();
		// The window counts the agents that are live - starting, running, stopping - as the record says, not by its
		// terminals' icons: one making its worktree has no terminal yet, one ended keeps its tab (X-51)
		let pushing: ReturnType<typeof setTimeout> | undefined;
		const pushLive = () => {
			pushing ??= setTimeout(() => {
				pushing = undefined;
				const agents = [...table.state.agents.values()].filter(isLive);
				// Those with no terminal yet - their worktrees being made or set up - listed by the window with the rest (L3)
				const preparing = agents
					.filter(agent => agent.state === 'starting' && (agent.phase === 'creating_worktree' || agent.phase === 'running_setup'))
					.map(agent => ({ id: agent.id, name: agent.name, phase: agent.phase, ...(agent.phase === 'running_setup' ? { folder: agent.folder } : {}) }));
				// Those another workspace's agent started, with that creator: closing the window ends them, which it says (L3; W11)
				const creators = agents.filter(agent => agent.creatorAfar).map(agent => ({ id: agent.id, creator: foreignRef(agent.creatorAfar!) }));
				void vscode.commands.executeCommand('_facade.agents.live', id, agents.map(agent => agent.id), preparing, creators).then(undefined, () => undefined);
			}, 100);
		};
		const changes = table.onDidChange(pushLive);
		this.disposables.push({ dispose: () => { changes.dispose(); clearTimeout(pushing); } });
		pushLive();
		// The CLIs looked for where a terminal finds them, as Facade starts and as what decides it changes (X-39)
		void facade.refreshClis();
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.agents') || event.affectsConfiguration('terminal.integrated.env')) {
				void facade.refreshClis();
			}
		}));
		// The switch goes into window.json as it changes: an agent's MCP server finds it there while the window is away.
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.orchestration.enabled') || event.affectsConfiguration('facade.agents.timeout')) {
				sayProblems();
			}
			if (event.affectsConfiguration('facade.orchestration.enabled')) {
				try {
					endpoint.setEnabled(frameworkOn());
				} catch (err) {
					this.say(`Could not record in window.json that the agent framework is ${frameworkOn() ? 'on' : 'off'}: ${messageOf(err)}`);
				}
				// Doorbells stop or start again with the switch, whatever became of window.json (AGENT-MESSAGES.md, M10)
				try {
					facade.frameworkChanged();
				} catch (err) {
					this.say(`Could not ${frameworkOn() ? 'resume' : 'pause'} agent doorbells after the framework setting changed: ${messageOf(err)}`);
				}
			}
		}));
		if (this.stopped) {
			this.dispose();
			return;
		}

		try {
			await facade.recover(load.reloaded || sameWindow, sameWindow);
		} finally {
			reconciled();
		}
		if (this.stopped) {
			return;
		}
		this.facade = facade;
		this.log.info(`Facade agents are ready for ${folders.length ? folders[0].uri.fsPath : workspace}. Record: ${dir}; pipe: ${endpoint.pipe}; available CLIs: ${facade.startable().map(each => each.id).join(', ') || 'none'}; agent framework: ${frameworkOn() ? 'on' : 'off'}.`);
	}

	/**
	 * Stops: as the window goes, or as Facade lets go of its agents while the window stays - a start that
	 * failed - which the workspace's ledger records for the next window to know.
	 */
	dispose(by: ClosedBy = 'window'): Promise<void> {
		return this.release(by);
	}

	/**
	 * The window shuts down, past every question that could cancel it, and says why - closing, quitting, replacing its
	 * workspace, or reloading - before its extension host stops (AGENT-LAUNCHER.md, L6). A reload ends nothing. A close, in
	 * order: the window's record says it closes, so that the other workspaces take it as gone and send it nothing more; its
	 * runs end, their unread mail goes back and creators elsewhere hear of their children's ends, as notices in the other
	 * workspaces' outboxes; those workspaces are rung, with no wait for their answers, so the window closes no later for
	 * them; and the record goes.
	 */
	windowClosing(reason: 'close' | 'quit' | 'load' | 'reload' | undefined): void {
		const facade = this.facade;
		const endpoint = this.endpoint;
		if (reason === undefined || reason === 'reload' || !facade || !endpoint || this.stopped || this.closing) {
			return;
		}
		this.closing = true;
		try {
			endpoint.markClosing();
		} catch (err) {
			this.warn(`Could not record in window.json that this window is closing: ${messageOf(err)}`);
		}
		try {
			facade.windowClosing();
		} catch (err) {
			this.warn(`Could not record the end of this window's agents as it closed: ${messageOf(err)}`);
		}
	}

	/**
	 * The window's deletion of `folder` asks every other window of the machine for its agents and unsaved editors there, and
	 * has them hold new starts there until it lets go (AGENT-ORCHESTRATION.md, O5; WORKTREE.md WT-8, steps 2 and 6).
	 */
	async workIn(folder: string, by?: CallerIdentity): Promise<WorkElsewhere> {
		if (!this.machineToAsk()) {
			return { workspaces: [], silent: [], otherVersions: [] };
		}
		// Every workspace answers what protects work in it, its framework on or off - for an agent's deletion, which of its
		// agents that agent reaches (O1, O5, O8)
		const [{ answers, silent }, otherVersions] = await Promise.all([this.machineToAsk()!.askEvery(WINDOW_REQUESTS.workIn, { folder, ...(by ? { caller: by } : {}) }, SILENT_WAIT_MS), this.machineToAsk()!.otherVersions()]);
		return {
			workspaces: answers.map(({ record, label, answer }) => {
				const work = workOf(answer);
				return {
					record, label, agents: work.agents.map(each => each.agent), runs: work.agents.flatMap(each => each.id !== undefined ? [each.id] : []),
					unreached: work.agents.filter(each => !each.reached).map(each => each.agent), terminals: work.terminals, editors: work.editors
				};
			}).filter(each => each.agents.length || each.terminals.length || each.editors.length),
			// A workspace whose framework is off answers this too: one that does not is silent (O8)
			silent: silent.filter(each => each.reason === 'not answering').map(each => each.label),
			otherVersions
		};
	}

	/**
	 * The window's deletion of `folder` was authorized - `place` - or settled: its deletion mark placed, refused where another
	 * workspace's stands, or removed (WT-8, step 3).
	 */
	async workMark(folder: string, place: boolean): Promise<{ readonly placed: boolean; readonly by?: string }> {
		const machine = this.machineToAsk();
		if (!machine) {
			return { placed: true };
		}
		if (!place) {
			await machine.unmark(folder);
			return { placed: false };
		}
		return machine.mark(folder);
	}

	/**
	 * The window's deletion of `folder` is at its step 6: every other workspace stops its agents and terminals working there
	 * and, `discard`, discards its unsaved editors there. Answers what is left, by workspace, and the workspaces that did not answer.
	 */
	async workRelease(folder: string, discard: boolean, by?: CallerIdentity): Promise<{ readonly left: readonly string[]; readonly silent: readonly string[]; readonly unknown: readonly string[] }> {
		const machine = this.machineToAsk();
		if (!machine) {
			return { left: [], silent: [], unknown: [] };
		}
		// Each workspace stops its work there once - never sent again once taken - for the caller the window carried through
		// the deletion, if an agent deletes it: an agent there that the caller does not reach stays, and is left (O1, O5, O8)
		const { answers, silent, unknown, refused } = await machine.callEvery(WINDOW_REQUESTS.workRelease, { folder, discard, ...(by ? { caller: by } : {}) });
		// Refused before it ran there, said with why - and those whose outcome is unknown with it: no workspace that refuses is
		// taken for one that may answer shortly
		if (refused?.length) {
			const unsure = unknown?.length ? `; whether ${unknown.map(each => `workspace ${each.label}`).join(', ')} stopped its work there is unknown` : '';
			throw new Error(`${refused.map(each => `workspace ${each.label}: ${each.why}`).join('; ')}${unsure}`);
		}
		const left: string[] = [];
		for (const { label, answer } of answers) {
			const { stopping, left: there } = (answer ?? {}) as { stopping?: unknown; left?: unknown };
			const texts = (value: unknown) => Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
			left.push(...[...texts(stopping), ...texts(there)].map(each => `${each} (workspace ${label})`));
		}
		return { left, silent: silent.filter(each => each.reason === 'not answering').map(each => each.label), unknown: (unknown ?? []).map(each => each.label) };
	}

	/**
	 * The machine to ask what protects work in a folder of this window: none where there is nothing to ask for - no
	 * local folder. Throws where it should be there and is not - Facade did not start here, or another window has this
	 * workspace's record - so that the deletion asking is refused rather than told of nothing (O5).
	 */
	private machineToAsk(): Machine | undefined {
		if (this.machine) {
			return this.machine;
		}
		if (this.noCore === undefined || this.noCore === 'noFolder') {
			return undefined;
		}
		throw new Error(this.noCore === 'otherWindow'
			? vscode.l10n.t("Another Facade window manages this workspace's agents. Use that window, or close it and reload this window to manage them here.")
			: vscode.l10n.t("Facade cannot read this workspace's agent record: {0}", this.recordDir ?? ''));
	}

	private release(by: ClosedBy): Promise<void> {
		this.stopped = true;
		this.stoppedBy ??= by;
		this.facade = undefined;
		this.person = undefined;
		this.endpoint = undefined;
		disposeAll(this.disposables.reverse(), err => this.warn(`Error while shutting down Facade agents: ${messageOf(err)}`));
		this.disposables.length = 0;
		// The core does nothing more, but what a call under way already did - a worktree git finished making -
		// is recorded before the ledger closes, so that the next window knows of it (AGENT-LAUNCHER.md, L12).
		const table = this.table;
		this.table = undefined;
		if (!table) {
			return this.closed ?? Promise.resolve();
		}
		const close = () => {
			try {
				table.dispose(this.stoppedBy);
			} catch (err) {
				this.warn(`Error while shutting down Facade agents: ${messageOf(err)}`);
			}
		};
		if (!this.underWay.size) {
			close();
			return this.closed = Promise.resolve();
		}
		return this.closed = Promise.race([Promise.allSettled([...this.underWay]), timeout(CLOSE_WAIT_MS)]).then(close);
	}

	/** `work`, a call the ledger stays open for while the service stops. */
	private whileUnderWay<T>(work: Promise<T>): Promise<T> {
		this.underWay.add(work);
		const done = () => { this.underWay.delete(work); };
		work.then(done, done);
		return work;
	}

	/**
	 * Agents: Start Agent..., and the agent menu's items: the agent chosen starts at once in the folder on
	 * screen, asking nothing more (AGENT-LAUNCHER.md, L3). Answers with the new agent's number and name, for a
	 * script that started it; the person is told why a start was refused.
	 */
	/** What would refuse a start of `installed` in `folder` as things are, as Show Agent Launch shows it (X-38). */
	async launchProblems(installed: InstalledCli, folder: string): Promise<readonly string[]> {
		return await this.facade?.launchProblems(installed, folder) ?? [];
	}

	/** The person stops agent `id` of the record `workspace` from the window - one with no terminal yet, from Show Active Agents (L3). */
	async stopFromWindow(workspace: string, id: number): Promise<void> {
		if (this.facade && workspace === this.recordId) {
			try {
				await this.facade.stopAgent(PERSON, agentRef(id));
			} catch (err) {
				this.say(`Failed to stop ${agentRef(id)}: ${messageOf(err)}`);
			}
		}
	}

	/** The window deleted the worktree `folder` (O5, O11). */
	worktreeDeleted(folder: string): void {
		this.facade?.worktreeDeleted(folder);
	}

	/** The person's deletion of the worktree `folder` failed in the window (O5; OR-10). */
	worktreeDeleteFailed(folder: string): void {
		this.facade?.worktreeDeleteFailed(folder);
	}

	/** The person decided to delete the worktree `folder` in the window: no agent starts there until it is over (OR-10). */
	worktreeDeleting(folder: string): void {
		this.facade?.worktreeDeleting(folder);
	}

	/**
	 * The window's deletion of the worktree `folder` is at stopping what goes with it: its agents stop, and are waited for
	 * (WORKTREE.md WT-8, step 6). Answers those still stopping when the stop timeout was over.
	 */
	async worktreeStopping(folder: string): Promise<{ readonly stopping: readonly string[]; readonly why?: string }> {
		return await this.facade?.worktreeStopping(folder) ?? { stopping: [] };
	}

	async startAgentCommand(rawArgs: unknown): Promise<{ readonly id: number; readonly name: string } | undefined> {
		const facade = this.facade;
		if (!facade) {
			// A record that cannot be read is a failure, another window's agents a start refused (UI-17)
			void (this.noCore === 'otherWindow'
				? vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window manages this workspace's agents. Start agents in that window."))
				: this.noCore === 'unreadable'
					? vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's agent record while one of its agents may still be running. See the Facade Agents output for details."))
					: vscode.window.showInformationMessage(vscode.l10n.t("Open a local folder to start an agent.")));
			return undefined;
		}
		const picked = await pickAgent(rawArgs, async (): Promise<OfferedAgent[]> => {
			// What a terminal finds now, as the agent menu does as it opens: a CLI installed since is offered, one gone is not (L3)
			await facade.refreshClis();
			return [
				// Each the person offers that is found, its settings wrong too: choosing it says what is wrong, as the menu does (L5)
				...this.installed.map(({ cli }) => ({ id: cli.id, label: cli.displayName, custom: false })),
				// Listed as the person wrote them, found or not: a start says what is wrong.
				...customAgents().map(({ cli }) => ({ id: cli.id, label: cli.displayName, custom: true }))
			];
		}, async () => {
			const { folder, env } = await terminalPlace();
			return turnedOffClis(configFor, env, folder).map(cli => cli.displayName);
		});
		if (!picked) {
			return undefined;
		}
		const local = (vscode.workspace.workspaceFolders ?? []).filter(each => each.uri.scheme === 'file');
		// The folder on screen as the person chose, where the menu sent it: not the one they went to since (PS-15)
		const folder = picked.folder ?? await folderOnScreen() ?? local.at(0)?.uri.fsPath;
		if (folder === undefined) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open a local folder to start an agent."));
			return undefined;
		}
		try {
			const started = await this.whileUnderWay(facade.startForPerson(picked.id, folder, picked.custom));
			return { id: started.id, name: started.name };
		} catch (err) {
			this.log.error(`Failed to start ${picked.id}: ${stackOf(err)}`);
			// Its Show goes to what its CLI showed as it ended, where it had a terminal (AGENT-DEBUGGING.md, D6)
			const agent = err instanceof FacadeError ? err.outcome?.agent : undefined;
			const ended = agent === undefined ? undefined : facade.endedAgent(agent);
			if (this.person) {
				this.person.tellNotStarted(messageOf(err), ended);
			} else {
				void vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", messageOf(err)));
			}
			return undefined;
		}
	}

	/** Agents: Open Chat Room... (AGENT-MESSAGES.md, M9). */
	async openChatRoomCommand(): Promise<void> {
		const facade = this.facade;
		if (!facade) {
			this.tellNoCore(vscode.l10n.t("Agents for this workspace are managed in another window. Open chat rooms in that window."));
			return;
		}
		await pickRoom(facade.mail.rooms.list());
	}

	/** Agents: Delete Chat Rooms...: once the person said so, the rooms and the files of long messages are gone for good (M9). */
	async deleteChatRoomsCommand(): Promise<void> {
		if (!this.facade) {
			this.tellNoCore(vscode.l10n.t("Agents for this workspace are managed in another window. Delete chat rooms in that window."));
			return;
		}
		if (!await confirmDeleteRooms(this.facade.mail.rooms.list())) {
			return;
		}
		try {
			// The window may have gone meanwhile
			if (!this.facade) {
				throw new Error(vscode.l10n.t("Facade Agents stopped in this window."));
			}
			this.facade.mail.deleteRooms();
		} catch (err) {
			this.log.error(`Failed to delete chat rooms: ${stackOf(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not delete all chat rooms: {0}", messageOf(err)));
		}
	}

	/** Tells the person why a command finds no agents here: another window has them - `otherWindow` - or there is no record of them here. */
	private tellNoCore(otherWindow: string): void {
		void (this.noCore === 'otherWindow'
			? vscode.window.showWarningMessage(otherWindow)
			: this.noCore === 'unreadable'
				? vscode.window.showErrorMessage(vscode.l10n.t("Facade cannot read this workspace's agent record while one of its agents may still be running. See the Facade Agents output for details."))
				: vscode.window.showInformationMessage(vscode.l10n.t("Open a local folder to start an agent.")));
	}

	/** Keeps `owner` as who this workspace's window is to its ledger: the window's own, carried into a new workspace's storage. */
	private async keepOwner(owner: string): Promise<string> {
		await this.workspaceState.update(OWNER_KEY, owner);
		return owner;
	}

	/** Who this workspace's window is to its ledger: made once, and the same through its reloads. */
	private async owner(): Promise<string> {
		const kept = this.workspaceState.get(OWNER_KEY);
		if (typeof kept === 'string' && kept) {
			return kept;
		}
		const owner = crypto.randomBytes(8).toString('hex');
		await this.workspaceState.update(OWNER_KEY, owner);
		return owner;
	}

	/**
	 * The workspace's ledger, open in this window; undefined once the service stopped meanwhile. Its lock
	 * is waited for as `lockWait` says: one a window that runs keeps touching is that window's,
	 * `LedgerLockedError`.
	 */
	private async openTable(dir: string, owner: string, session: string | undefined, mayMoveAside: () => boolean, onMovedAside?: (why: string, keptAs: string) => void): Promise<AgentTable | undefined> {
		const locked = lockWait(HANDOVER_MS);
		let told = false;
		const counters = new MachineCounters(countersFile(), workspacesRoot());
		// The record joins the counters as it opens, under their lock: waited for first without holding up the extension host (L12)
		await counters.ready();
		return this.retried(() => AgentTable.open({ dir, owner, session, mayMoveAside, onMovedAside, onTaken: () => setImmediate(() => this.taken()), counters }), err => {
			if (err instanceof LedgerLockedError && !told) {
				told = true;
				this.log.info(`${err.message} Waiting for the previous window to release the ledger lock or for an untouched lock to expire.`);
			}
			return locked(err);
		});
	}

	/**
	 * Waits, for a while at most, until the extension host before lets go of the record in `dir`, where
	 * that record names a workspace other than `workspace`: this window's own, as its folder window became a
	 * workspace and the extension host started again, closes it only as it goes.
	 */
	private async handedOver(dir: string, workspace: string): Promise<void> {
		const named = identityOf(dir);
		if (named === undefined || isSameWorkspace(named, workspace)) {
			return;
		}
		const deadline = Date.now() + HANDOVER_MS;
		while (!this.stopped && lockStateOf(dir).held && Date.now() < deadline) {
			await timeout(HANDOVER_POLL_MS);
		}
	}

	/** Another window took the workspace's agents, this one standing still too long: it lets go of everything, and says so once. */
	private taken(): void {
		if (this.stopped) {
			return;
		}
		this.log.warn('Another Facade window took over this workspace\'s agents after this window stopped responding for too long. That window now manages them.');
		void vscode.window.showWarningMessage(vscode.l10n.t("Agent management for this workspace has been transferred to another Facade window."));
		this.noCore = 'otherWindow';
		this.dispose();
	}

	/** The endpoint the agents' MCP servers call, once it listens. */
	private listening(): PipeEndpoint<PipeCaller> {
		if (!this.endpoint) {
			throw new Error('The Facade agent service is not listening in this window.');
		}
		return this.endpoint;
	}

	/**
	 * A line of the core's in Facade's log. One that comes as the window goes - a call to it under way
	 * fails once the window has closed the log - has nowhere to go, and is dropped.
	 */
	private say(message: string): void {
		try {
			this.log.info(message);
		} catch {
			// The log is closed: the window went.
		}
	}

	/** As `say`, for what went wrong. */
	private warn(message: string): void {
		try {
			this.log.error(message);
		} catch {
			// The log is closed: the window went.
		}
	}

	/**
	 * The endpoint on the pipe the agents still running call, which only that pipe reaches; undefined
	 * once the service stopped meanwhile. The extension host before is waited for while it lets go of
	 * it - while agents run, as long as their MCP servers wait for the window - and only then is a new pipe
	 * taken, the person told that the agents still running lost Facade's tools. The tools it serves go into
	 * the record with it: an agent's MCP server lists them while the window does not answer (L1; O8).
	 */
	private async listen(windowState: StateStore, dir: string, handlers: PipeHandlers<PipeCaller>, agentsRun: boolean, unreadable: string | undefined, facts: WindowFacts): Promise<PipeEndpoint<PipeCaller> | undefined> {
		const kept = windowState.get(PIPE_ID_KEY);
		// The file that names the pipe could not be read: the agents running call a pipe this window cannot know -
		// said once, loud, not lost quietly (C-REC-19)
		if (unreadable !== undefined) {
			this.log.error(`Could not read ${path.join(dir, WINDOW_STATE_FILE)} (${unreadable}). Facade is opening a new pipe.`);
			if (agentsRun) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Facade could not read {0}, which tells running agents how to reach this window. Agents that were already running can no longer use Facade tools; agents started from now on can.", path.join(dir, WINDOW_STATE_FILE)));
			}
		}
		if (typeof kept === 'string' && /^[0-9a-f]{16}$/.test(kept)) {
			// No shorter than the extension host before takes to let go of it, however short the person set it.
			const deadline = Date.now() + (agentsRun ? Math.max(timeoutMs(), HANDOVER_MS) : HANDOVER_MS);
			try {
				return await this.retried(() => PipeEndpoint.start(pipePath(kept), dir, handlers, frameworkOn(), toolDefinitions(), facts), err => codeOf(err) === 'EADDRINUSE' && Date.now() < deadline);
			} catch (err) {
				if (codeOf(err) !== 'EADDRINUSE') {
					throw err;
				}
			}
			this.log.warn(`Pipe ${pipePath(kept)} is still in use. Facade is opening a new pipe.`);
			if (agentsRun) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Could not reconnect to the agents that were already running. They cannot use Facade tools, but agents started from now on work normally."));
			}
		}
		const pipeId = crypto.randomBytes(8).toString('hex');
		await windowState.update(PIPE_ID_KEY, pipeId);
		return this.stopped ? undefined : PipeEndpoint.start(pipePath(pipeId), dir, handlers, frameworkOn(), toolDefinitions(), facts);
	}

	/** What `attempt` makes, tried again while `again` says so of what it failed with; undefined once the service stopped meanwhile. */
	private async retried<T>(attempt: () => T | Promise<T>, again: (err: unknown) => boolean): Promise<T | undefined> {
		while (!this.stopped) {
			try {
				return await attempt();
			} catch (err) {
				if (!again(err)) {
					throw err;
				}
			}
			await timeout(HANDOVER_POLL_MS);
		}
		return undefined;
	}
}

/** Facade's version and commit, as the product it runs in says: what the windows of one machine must share to call each other (O1). */
function productOf(): { readonly version?: string; readonly commit?: string } {
	try {
		const product: unknown = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
		if (!isJsonObject(product)) {
			return {};
		}
		const version = typeof product.facadeVersion === 'string' ? product.facadeVersion : typeof product.version === 'string' ? product.version : undefined;
		const commit = typeof product.commit === 'string' ? product.commit : undefined;
		return { ...(version ? { version } : {}), ...(commit ? { commit } : {}) };
	} catch {
		return {};
	}
}

/** Who deletes a folder, as the window carries it through the deletion: a caller of a workspace, each field checked (O5). */
export function identityIn(value: unknown): CallerIdentity | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	// One that names nobody it can tell is no deletion's to carry out as the person's: refused (O5)
	const caller = callerOfRequest(value);
	if (!caller?.from) {
		throw new Error(vscode.l10n.t("The deletion names a caller that Facade could not read."));
	}
	return { ...(caller.id !== undefined ? { id: caller.id } : {}), name: caller.name, from: caller.from };
}

/**
 * Whether the window, with no folder on this machine, still runs agents of its record in its terminals: a workspace
 * whose last folder left while they ran, reloaded, which stays their workspace (AGENT-ORCHESTRATION.md, O1; WORKSPACE.md W9.6).
 */
export async function keepsAgentsWithoutFolder(workspaceState: vscode.Memento): Promise<boolean> {
	const id = workspaceState.get(WORKSPACE_ID_KEY);
	// A workspace file, saved or untitled: a folder window with no folder is no window at all
	return vscode.workspace.workspaceFile !== undefined && isWorkspaceId(id) && await agentProcessesRun(id);
}

/**
 * The person's history of the agents of the workspace whose storage is `workspaceState`: its record's
 * `agents.log`, whether Facade runs now or not; undefined for a workspace Facade never had a record for.
 */
export function agentsLogOf(workspaceState: vscode.Memento): string | undefined {
	const id = workspaceState.get(WORKSPACE_ID_KEY);
	const folder = (vscode.workspace.workspaceFolders ?? []).find(candidate => candidate.uri.scheme === 'file');
	const workspace = (vscode.workspace.workspaceFile ?? folder?.uri)?.toString();
	if (!isWorkspaceId(id) || workspace === undefined) {
		return undefined;
	}
	// The record the storage names only while it names this workspace: the storage of another one - the
	// old file after Save As - can have come with it (X-67)
	const dir = recordDirOf(workspacesRoot(), id);
	const named = identityOf(dir);
	return named !== undefined && isSameWorkspace(named, workspace) ? path.join(dir, AGENTS_LOG) : undefined;
}

/**
 * How the window was loaded, as Facade's workbench says: an id of this load's own - the same through the
 * extension host's restarts, another after a reload - and whether a reload of the window before loaded it.
 * Without Facade's workbench neither is known: no id, and taken for no reload.
 */
async function windowLoad(): Promise<{ readonly id: string | undefined; readonly reloaded: boolean; readonly record?: { readonly id: string; readonly owner: string } }> {
	if (!(await vscode.commands.getCommands()).includes('_facade.window.loaded')) {
		return { id: undefined, reloaded: false };
	}
	const load = await vscode.commands.executeCommand<unknown>('_facade.window.loaded');
	const { id, reloaded, record } = isJsonObject(load) ? load : {};
	const kept = isJsonObject(record) && isWorkspaceId(record.id) && typeof record.owner === 'string' && record.owner ? { id: record.id, owner: record.owner } : undefined;
	return { id: typeof id === 'string' && /^[0-9a-f-]+$/i.test(id) ? id : undefined, reloaded: reloaded === true, ...(kept ? { record: kept } : {}) };
}

/** Tells the window which record it has now, for an extension host that starts again under it (`windowLoad`). */
async function rememberWindowRecord(id: string, owner: string): Promise<void> {
	if ((await vscode.commands.getCommands()).includes('_facade.window.record')) {
		await vscode.commands.executeCommand('_facade.window.record', { id, owner });
	}
}
