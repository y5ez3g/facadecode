/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { disposeAll } from '../base/lifecycle';
import { isJsonObject } from '../base/json';
import { InstalledCli } from '../clis/cli';
import { installedClis, knownClis, locateCli, turnedOffClis } from '../clis/registry';
import { facadeSkill, firstLineFor } from '../contract/prompts';
import { Contract, toolDefinitions } from '../contract/tools';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { AgentTable, countOnFrom, numberedUpTo } from '../record/agents';
import { agentRef, Caller, isLive, PERSON } from '../record/events';
import { earlierRecordOf, identityOf, isSameWorkspace, isWorkspaceId, recordDirOf, recordFor } from '../record/identity';
import { ClosedBy, LedgerLockedError, LedgerUnreadableError, liveHolderOf, lockStateOf, lockWait } from '../record/ledger';
import { AGENTS_LOG } from '../record/log';
import { workspacesRoot } from '../record/paths';
import { PipeEndpoint } from '../transport/endpoint';
import { PipeHandlers, pipePath } from '../transport/pipe';
import { releaseEarlierHost } from './takeover';
import { WAS_AWAY_COMMAND, windowWasAway } from './windowAway';
import { HostGit } from './git';
import { HostPerson } from './person';
import { confirmDeleteRooms, pickRoom } from './rooms';
import { ScreenDocuments } from './screenDocuments';
import { configFor, customAgents, frameworkOn, settingsProblems, timeoutMs, worktreesManaged, yolo } from './settings';
import { folderOnScreen, OfferedAgent, pickAgent, terminalPlace } from './startAgent';
import { agentProcessesRun, HostTerminals, terminalEnvironment } from './terminals';
import { JsonFileState, StateStore } from './windowState';
import { TicketRegistry } from '../core/tickets';

const PIPE_ID_KEY = 'facade.agents.pipeId';
const WINDOW_STATE_FILE = 'window-state.json';
/** When the window was last heard from - a window call answered, a ticket claimed - in the record's `window-state.json`, for the notice of agents that ended while it was away (REMOTE.md R4). */
const LAST_HEARD_KEY = 'facade.agents.lastHeard';
/** How often the last time heard from the window is written to the record at most: every 15 seconds (REMOTE.md RM-08). */
const HEARD_WRITE_MS = 15_000;
/** How often a remote window is pinged while connected: every 20 seconds, so the record stays within a minute (REMOTE.md RM-08). */
const WINDOW_PING_MS = 20_000;
/** The workspace's id, which names its record: kept in its `workspaceState`, which VS Code carries over as the workspace is saved under another name. */
const WORKSPACE_ID_KEY = 'facade.agents.workspaceId';
/** Where a build before workspace ids kept the path of the workspace's record, in its `workspaceState`. */
const EARLIER_RECORD_KEY = 'facade.agents.record';
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
	private endpoint: PipeEndpoint<Caller> | undefined;
	/** The workspace's record, open in this window. */
	private table: AgentTable | undefined;
	/** The tickets of the operations asked of the window, claimed as it would act. */
	private tickets: TicketRegistry | undefined;
	/** The window's terminals: told whenever the window answers a ping or a ticket's claim, as its own calls tell it. */
	private terminals: HostTerminals | undefined;
	/** The record's `window-state.json`: the pipe's id, and when the window was last heard from. */
	private windowState: JsonFileState | undefined;
	/** When the last time heard from the window was last written to the record. */
	private heardWritten = 0;
	/** How often the window is pinged in a remote window; none elsewhere, or once stopped. */
	private ping: ReturnType<typeof setInterval> | undefined;
	/** Whether a ping waits for the window's answer: none is sent meanwhile. */
	private pinging = false;
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
		if (!folders.length) {
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
			const earlier = earlierRecordOf(workspacesRoot(), this.workspaceState.get(EARLIER_RECORD_KEY), folders[0].uri.fsPath);
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
		// Its own earlier extension host's live lock is not waited out: it is asked to let go at once (REMOTE.md R4)
		const holder = liveHolderOf(dir);
		if (holder !== undefined && holder.owner === owner) {
			this.log.info(`This window's earlier extension host (process ${holder.pid}) holds the workspace's agents; taking over at once.`);
			const took = await releaseEarlierHost(dir, holder.pid, owner, {
				info: message => this.log.info(message),
				warn: message => this.log.warn(message),
				stopped: () => this.stopped
			});
			if (took === 'newer-holder') {
				// A newer extension host of this window holds the record: this stale one gives up quietly (L5)
				this.log.info(`This window's newer extension host (process ${holder.pid}) holds the workspace's agents; this one gives up.`);
				this.dispose();
				return;
			}
			if (took !== 'taken') {
				this.ownEarlierHostLocked(holder.pid);
				return;
			}
		}
		let tryTakeover = true;
		while (table === undefined) {
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
				if (err instanceof LedgerLockedError && tryTakeover && err.pid !== undefined && err.owner === owner) {
					tryTakeover = false;
					// Its own earlier extension host is not another window: asked to let go, else ended (REMOTE.md R4)
					const took = await releaseEarlierHost(dir, err.pid, owner, {
						info: message => this.log.info(message),
						warn: message => this.log.warn(message),
						stopped: () => this.stopped
					});
					if (took === 'taken') {
						continue;
					}
					if (took === 'newer-holder') {
						// A newer extension host of this window holds the record: this stale one gives up quietly (L5)
						this.log.info(`This window's newer extension host (process ${err.pid}) holds the workspace's agents; this one gives up.`);
						this.dispose();
						return;
					}
				}
				if (err instanceof LedgerLockedError) {
					this.log.warn(err.message);
					if (err.owner === owner && err.pid !== undefined) {
						this.ownEarlierHostLocked(err.pid);
					} else {
						// One actionable error (L12; N-32): where the agents are, and how to have them here instead
						void vscode.window.showErrorMessage(vscode.l10n.t("Another Facade window manages this workspace's agents. Use that window, or close it and reload this window to manage them here."));
						this.noCore = 'otherWindow';
					}
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
			if (table === undefined) {
				return;
			}
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
		this.windowState = windowState;
		// When the earlier extension host last heard from its window, read before this one hears anything
		// itself: for the notice of the agents that ended while the window was away (REMOTE.md R4)
		const lastHeard = windowState.get(LAST_HEARD_KEY);
		const tickets = new TicketRegistry(number => {
			const state = table.state.agents.get(number);
			return !isLive(state) ? 'gone' : state.state === 'stopping' ? 'stopping' : 'live';
		});
		this.tickets = tickets;
		const terminals = new HostTerminals(id, message => this.say(message), tickets, () => this.heard());
		this.terminals = terminals;
		this.disposables.push(terminals);

		// The CLIs this machine has, as a terminal finds them: Facade's own PATH until they are looked for there (X-39)
		this.installed = installedClis(configFor);
		const facade = new Facade({
			table,
			ports: {
				terminals,
				git: new HostGit(id, tickets),
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
			settingsProblems,
			log: message => this.say(message)
		});
		this.disposables.push(facade);

		const contract = new Contract(facade);
		// The endpoint listens before the record is reconciled - an agent's MCP server says hello as it comes
		// back - but a tool call waits for it: answered before, `list_agents` would show agents gone with the
		// window as running, and a stop would race the reconciliation (L12).
		let reconciled = () => { };
		const reconciliation = new Promise<void>(resolve => reconciled = resolve);
		const endpoint = this.endpoint = await this.listen(windowState, dir, {
			authenticate: token => table.authenticate(token),
			hello: (caller, server) => contract.hello(caller, server),
			call: (caller, tool, args, progress, whenWritten) => this.whileUnderWay(reconciliation.then(() => contract.call(caller, tool, args, progress, whenWritten))),
			log: message => this.log.error(message),
			release: () => this.releaseForTakeover()
		}, [...table.state.agents.values()].some(isLive), windowState.unreadable);
		if (!endpoint) {
			return;
		}
		this.disposables.push(endpoint);
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
				void vscode.commands.executeCommand('_facade.agents.live', id, agents.map(agent => agent.id), preparing).then(undefined, () => undefined);
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

		// In a remote window only: whether its previous session ended while it could not reach its remote -
		// asked once, one-shot per window load (M1)
		const wasAway = vscode.env.remoteName === undefined ? false : await windowWasAway(() => Promise.resolve(vscode.commands.getCommands()), async () => vscode.commands.executeCommand(WAS_AWAY_COMMAND));
		if (wasAway === undefined) {
			this.log.warn('Could not tell whether this window was away from its host: no agent is taken to have ended with the window, and none is named as having ended while it was away.');
		}
		try {
			await facade.recover(load.reloaded || sameWindow, sameWindow, { away: wasAway ?? 'unknown', lastHeard });
		} finally {
			reconciled();
		}
		if (this.stopped) {
			return;
		}
		this.facade = facade;
		this.log.info(`Facade agents are ready for ${folders[0].uri.fsPath}. Record: ${dir}; pipe: ${endpoint.pipe}; available CLIs: ${facade.startable().map(each => each.id).join(', ') || 'none'}; agent framework: ${frameworkOn() ? 'on' : 'off'}.`);
		this.startWindowPing();
	}

	/**
	 * Stops: as the window goes, or as Facade lets go of its agents while the window stays - a start that
	 * failed - which the workspace's ledger records for the next window to know.
	 */
	dispose(by: ClosedBy = 'window'): Promise<void> {
		this.stopped = true;
		clearInterval(this.ping);
		this.ping = undefined;
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
		if (!await confirmDeleteRooms()) {
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
		return this.retried(() => AgentTable.open({ dir, owner, session, mayMoveAside, onMovedAside, onTaken: () => setImmediate(() => this.taken()) }), err => {
			if (err instanceof LedgerLockedError && !told) {
				told = true;
				this.log.info(`${err.message} Waiting for the previous window to release the ledger lock or for an untouched lock to expire.`);
			}
			return locked(err);
		});
	}

	/**
	 * Lets go for this window's new extension host, which asked through `/release`: the pipe takes nothing
	 * new from now on, what is under way is recorded, and everything stops (REMOTE.md R4).
	 */
	private releaseForTakeover(): void {
		this.log.info('This window\'s new extension host asked this one to let go of the workspace\'s agents; letting go.');
		void this.dispose('window');
	}

	/** Tells the person their own earlier extension host keeps the workspace's agents, and gives up this window's claim. */
	private ownEarlierHostLocked(pid: number): void {
		// Its own earlier extension host, which would not let go and could not be stopped: named, not another window
		void vscode.window.showErrorMessage(vscode.l10n.t("This window's earlier extension host (process {0}) still manages this workspace's agents, and Facade could not stop it. End that process and reload this window to manage them here.", pid));
		this.noCore = 'otherWindow';
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
	private listening(): PipeEndpoint<Caller> {
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

	/**
	 * Whether the window may act on the operation with `ticket` now: granted while its caller still
	 * waits, refused after that - and where there is no core to want anything (REMOTE.md R4, R7).
	 */
	claimTicket(ticket: unknown): { readonly granted: boolean } {
		if (this.stopped) {
			return { granted: false };
		}
		this.noteHeard();
		return { granted: typeof ticket === 'string' && (this.tickets?.claim(ticket) ?? false) };
	}

	/**
	 * The window answered something the terminals did not ask - a ping, a ticket's claim: its time
	 * kept for what a timeout says, and in the record as when the window was last heard from.
	 */
	private noteHeard(): void {
		if (this.terminals) {
			this.terminals.noteHeard();
		} else {
			this.heard();
		}
	}

	/**
	 * The window was heard from - one of its calls answered, a ticket claimed: kept in the record as
	 * when it was last heard from, about once a minute at most, for the notice of agents that ended
	 * while it was away (REMOTE.md R4).
	 */
	private heard(): void {
		const windowState = this.windowState;
		const now = Date.now();
		if (!windowState || this.stopped || now - this.heardWritten < HEARD_WRITE_MS) {
			return;
		}
		this.heardWritten = now;
		windowState.update(LAST_HEARD_KEY, now).catch(err => this.warn(`Could not note when the window was last heard from: ${messageOf(err)}`));
	}

	/**
	 * Pings the window about once a minute, in a remote window: its answers heard keep the record's
	 * last-heard time within about a minute, though agents work for hours with no window call (REMOTE.md R4).
	 */
	private startWindowPing(): void {
		if (vscode.env.remoteName === undefined || this.ping !== undefined) {
			return;
		}
		this.ping = setInterval(() => {
			if (this.stopped || this.pinging) {
				return;
			}
			this.pinging = true;
			vscode.commands.executeCommand('_facade.window.ping').then(
				() => { this.pinging = false; this.noteHeard(); },
				() => { this.pinging = false; });
		}, WINDOW_PING_MS);
		this.ping.unref?.();
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
	private async listen(windowState: StateStore, dir: string, handlers: PipeHandlers<Caller>, agentsRun: boolean, unreadable?: string): Promise<PipeEndpoint<Caller> | undefined> {
		const kept = windowState.get(PIPE_ID_KEY);
		// The file that names the pipe could not be read: the agents running call a pipe this window cannot know -
		// said once, loud, not lost quietly (C-REC-19)
		if (unreadable !== undefined) {
			this.log.error(`Could not read ${path.join(dir, WINDOW_STATE_FILE)} (${unreadable}). Facade is opening a new pipe.`);
			if (agentsRun) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Facade could not read {0}, which tells running agents how to reach this window. Agents that were already running can no longer use Facade tools; agents started from now on can.", path.join(dir, WINDOW_STATE_FILE)));
			}
		}
		// On a remote the pipe is never in a login session's folder, which goes with it (REMOTE.md R4)
		const remote = vscode.env.remoteName !== undefined;
		if (typeof kept === 'string' && /^[0-9a-f]{16}$/.test(kept)) {
			// No shorter than the extension host before takes to let go of it, however short the person set it.
			const deadline = Date.now() + (agentsRun ? Math.max(timeoutMs(), HANDOVER_MS) : HANDOVER_MS);
			try {
				return await this.retried(() => PipeEndpoint.start(pipePath(kept, undefined, remote), dir, handlers, frameworkOn(), toolDefinitions()), err => codeOf(err) === 'EADDRINUSE' && Date.now() < deadline);
			} catch (err) {
				if (codeOf(err) !== 'EADDRINUSE') {
					throw err;
				}
			}
			this.log.warn(`Pipe ${pipePath(kept, undefined, remote)} is still in use. Facade is opening a new pipe.`);
			if (agentsRun) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Could not reconnect to the agents that were already running. They cannot use Facade tools, but agents started from now on work normally."));
			}
		}
		const pipeId = crypto.randomBytes(8).toString('hex');
		await windowState.update(PIPE_ID_KEY, pipeId);
		return this.stopped ? undefined : PipeEndpoint.start(pipePath(pipeId, undefined, remote), dir, handlers, frameworkOn(), toolDefinitions());
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
