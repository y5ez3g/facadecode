/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Core owns the records. This editor projects records of which its logical window is a member (ARCHITECTURE-1.3).

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { messageOf } from '../../base/errors';
import { folderKeyOf } from '../../base/files';
import { displayLine } from '../../base/text';
import type {
	AgentInfo, AgentListResult, AgentMachineState, AgentRef, AgentsChange, AgentsSnapshot, CliInfo, Message, MessagesChange, MessagesSnapshot, ResumeArgs, StartArgs, StartResult, StopResult, WindowInfo, WindowRef
} from '../../base/coreProtocol';
import { entrySetting } from '../../clis/entries';
import { FacadeError, invalid } from '../../core/errors';
import { isWithin } from '../../core/locations/catalog';
import type { MessageRecord } from '../../core/messagePorts';
import { keptName, labelOf, repeatedNames, suggestName } from '../../core/names';
import { conversationId } from '../../core/ports';
import { dotOf } from '../../core/status';
import type {
	ActivityUnknown, AgentCloseResult, Agents, ConversationEntry, ConversationKey, ConversationTitlePort, Disposable, Event, FacadeReason, HumanPort,
	LaunchHistoryPort, LaunchRequest, Location, LocationId, LocationPort, LogPort, OtherAgent, PairFacts, Pin, ResumeResult, RetainedConversation,
	RunChange, RunError, RunFacts, RunId, RustPin, RustPinStore, SaidSource, StartOutcome, TabPlace
} from '../../core/ports';
import type { ConversationFile } from '../../record/conversations';
import type { WindowContact } from '../contact';
import type { RemoteLaunchRequest } from '../../ui/pickers/machineLaunch';
import { reasonText } from '../../ui/presentation';
import { agentAddress, machineSelector, messageAddress } from './references';
import { DaemonError, type DaemonLink, type RustTerminals } from './types';

export interface RustAgentsDeps {
	readonly link: DaemonLink;
	readonly terminals: RustTerminals;
	readonly locations: LocationPort;
	readonly clis: (machine?: string) => readonly CliInfo[];
	/** The chosen history entry must still run its original CLI from this location. */
	readonly resumeProblem: (cli: string, location: Location, builtIn?: string) => string | undefined;
	readonly windows: () => readonly WindowInfo[];
	readonly onDidChangeWindows: Event<void>;
	readonly machineName: (machine: string) => string;
	readonly onDidChangeMachines: Event<void>;
	readonly environment: (location?: Location) => Record<string, string>;
	readonly pins: RustPinStore;
	readonly conversations: ConversationFile;
	readonly titles: ConversationTitlePort;
	readonly history: LaunchHistoryPort;
	readonly human: HumanPort;
	readonly contact: WindowContact;
	readonly describe: (err: DaemonError) => string;
	readonly log: LogPort;
	readonly dismissed?: DismissedAgents;
	/** A start's whole run ID, `start-<32 hex>`. */
	readonly newRunId: () => string;
	/** `names` of the settings file, where it has them: what a blank name is filled in from (LIFECYCLE-2.1); none, the built-in list. */
	readonly names?: () => readonly string[] | undefined;
	/** Where each agent's tab is, by its agent ID, kept across reloads: a reload opens a pinned agent's there (LIFECYCLE-3.5). */
	readonly places?: TabPlaces;
}

/** The window's record of where its agents' tabs are, by agent ID. */
export interface TabPlaces {
	get(agent: string): TabPlace | undefined;
	set(agent: string, place: TabPlace | undefined): void;
}

/** The workspace remembers which abnormal exits the person dismissed (LIFECYCLE-3.4). */
export interface DismissedAgents {
	has(agent: string): boolean;
	/** Submits to workspace storage. A refused sidecar write throws synchronously. */
	set(agent: string, dismissed: boolean): void;
	/** Reconciles a complete snapshot. A refused sidecar write throws synchronously. */
	retain(keep: (agent: string) => boolean): void;
}

/** What a start of this window is before core answers it, and how it went. */
interface Pending {
	readonly name: string;
	readonly cli: string;
	readonly location?: Location;
	readonly machine?: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly worktree: boolean;
	readonly sessionId?: string;
	readonly settled: Promise<StartOutcome>;
}

interface ResumeAttempt {
	readonly result: Promise<AgentInfo>;
	closing?: Promise<AgentCloseResult>;
}

interface StopAttempt {
	readonly info: AgentInfo;
	readonly result: Promise<AgentCloseResult>;
}

interface UnconfirmedStart {
	readonly cwd: string;
	readonly machine?: string;
	readonly conversation?: ConversationKey;
	readonly error: unknown;
}

interface Run {
	readonly id: RunId;
	/** Core's agent, once its start answered; at once for an agent the window found in the `agents` topic. */
	agent?: string;
	/** A start this window asked for, until core gives it an agent. */
	pending?: Pending;
	/** Stop Agent during launch answers once the launch and any resulting stop are settled. */
	closeAfterLaunch?: PromiseWithResolvers<AgentCloseResult>;
	/** A start or resume core refused: red until dismissal (UX-2.4). */
	failure?: RunError;
	/** Whether a saved session opened under the old or a new number (PANEL-1.4). */
	sessionOpening?: RunFacts['sessionOpening'];
	spinning?: boolean;
	/** Where its tab is (LIFECYCLE-3.5). */
	tab?: TabPlace;
	facts: RunFacts;
}

/** The size an agent starts with; its tab sends its own once it opens. */
const COLS = 120;
const ROWS = 30;

/** The most a card's second line keeps of a message sent: far more than any card shows (PANEL-1.4). */
const MOST_LINE = 1024;

const UNKNOWN: { readonly [reason: string]: ActivityUnknown } = { not_shown: 'not_reporting', asked: 'waiting', taken_back: 'cleared', unrecognized: 'screen_unrecognized' };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * `Agents` on core: core handles a start, a resume, a stop and a rename; the cards are core's records
 * of this window, a start this window asked for shown from its acceptance (LIFECYCLE-1.5). Pins and Recent's names stay the window's.
 */
export class RustAgents implements Agents, Disposable {
	get ready(): Promise<void> { return this.snapshotReady.promise; }

	readonly onDidChange: Event<RunChange> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	readonly onDidChangeOtherAgents: Event<void> = listener => {
		this.otherListeners.add(listener);
		return { dispose: () => this.otherListeners.delete(listener) };
	};

	private readonly listeners = new Set<(change: RunChange) => void>();
	private readonly otherListeners = new Set<() => void>();
	private readonly runs = new Map<RunId, Run>();
	private readonly byAgent = new Map<string, RunId>();
	/** Starts awaiting a number, including those whose cards were closed before core answered. */
	private readonly starting = new Map<RunId, Run>();
	/** The reply may have been lost after the process started. Keep this evidence even after Stop Agent removes the card. */
	private readonly unconfirmedStarts = new Map<RunId, UnconfirmedStart>();
	private readonly adopting = new Map<string, Promise<AgentInfo>>();
	private readonly resuming = new Map<string, ResumeAttempt>();
	private readonly unconfirmedResumes = new Map<string, { readonly before: AgentInfo; readonly error: unknown }>();
	private readonly stopping = new Map<string, StopAttempt>();
	/** The local records and subscribed remote records, keyed by their exact machine-qualified address. */
	private readonly all = new Map<string, AgentInfo>();
	private readonly candidates = new Map<string, AgentInfo>();
	private readonly removedAgents = new Set<string>();
	/** A close suppresses the card for that process. A later resume of the same agent may open it again. */
	private readonly closed = new Map<string, AgentInfo>();
	private readonly titles = new Map<string, { readonly session: string; readonly cwd: string; readonly title: string }>();
	private window: WindowRef;
	private generation = 0;
	private snapshotReady = deferred<void>();
	private complete = false;
	/** Messages already observed in this window, including its inbox snapshots (COLLABORATION-2.3). */
	private readonly told = new Map<string, MessageRecord>();
	private readonly subscriptions: Disposable[] = [];
	private pinsRequested = false;
	private pinRestore?: { readonly generation: number; readonly result: Promise<void> };
	private readonly checkedPins = new Set<string>();
	private readonly openedPins = new Set<string>();
	private disposed = false;

	constructor(private readonly deps: RustAgentsDeps) {
		const { link, terminals } = deps;
		this.window = link.window;
		this.subscriptions.push(
			link.onDidBind(window => this.bound(window)),
			deps.onDidChangeWindows(() => this.windowsChanged()),
			deps.onDidChangeMachines(() => this.machinesChanged()),
			link.watch<AgentsSnapshot, AgentsChange>('agents', {}, {
				disconnected: () => this.watchDisconnected(),
				snapshot: view => this.snapshot(view),
				change: change => {
					if (!this.complete) { return; }
					if (change.kind === 'updated') { this.updated(change.agent); }
					else if (change.kind === 'removed') { this.removed(change); }
					else if (change.kind === 'machine_state') { this.machineState(change.machine); }
				}
			}),
			// The person's inbox: what this window's agents send #human (0.1, COLLABORATION-2.3)
			link.watch<MessagesSnapshot, MessagesChange>('messages', {}, {
				snapshot: inbox => inbox.messages.forEach(message => this.message(message, false)),
				change: change => { if (change.kind === 'updated') { this.message(change.message, true); } }
			}),
			terminals.onDidClosePair?.(({ run, marked }) => this.tabClosed(run, marked)) ?? { dispose() { } },
			terminals.onDidPinTab?.(({ run, pinned }) => this.tabPinned(run, pinned)) ?? { dispose() { } },
			terminals.onDidRenameTab?.(({ run, name }) => { if (this.runs.has(run)) { this.rename(run, name); } }) ?? { dispose() { } },
			terminals.onDidPlaceTab?.(({ run, place }) => this.tabPlaced(run, place)) ?? { dispose() { } }
		);
	}

	dispose(): void {
		this.disposed = true;
		this.snapshotReady.resolve();
		this.subscriptions.forEach(each => each.dispose());
		this.listeners.clear();
		this.otherListeners.clear();
	}

	list(): readonly RunFacts[] {
		return [...this.runs.values()].map(run => run.facts);
	}

	get(run: RunId): RunFacts | undefined {
		return this.runs.get(run)?.facts;
	}

	requested(): RunFacts | undefined {
		return undefined;
	}

	async warmedUp(): Promise<void> { }

	pins(): readonly RustPin[] {
		return this.deps.pins.list().filter(pin => this.isPinHere(pin));
	}

	reorderPins(ids: readonly string[]): void {
		const saved = this.deps.pins.list();
		const local = new Set(saved.filter(pin => this.isPinHere(pin)).map(pin => pin.id));
		const ordered = [...new Set([...ids.filter(id => local.has(id)), ...local])];
		let next = 0;
		this.deps.pins.reorder(saved.map(pin => local.has(pin.id) ? ordered[next++] : pin.id));
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Starts

	launch(request: LaunchRequest): RunId {
		const location = request.location ? this.deps.locations.resolve(request.location) : undefined;
		if (!location) {
			throw invalid('invalid_argument', `The working location ${request.location} is not available in this window.`, { kind: 'location_gone', values: [] });
		}
		const cli = this.deps.clis().find(each => each.cli === request.cli);
		if (!cli?.available) {
			throw invalid('unavailable', cli?.problem ?? `${request.cli} is not a CLI this window can start.`);
		}
		return this.start({ name: request.name.trim(), cli: request.cli, location, reveal: true,
			...request.worktree ? { worktree: { branch: request.worktree.branch, base_ref: request.worktree.baseRef ?? 'HEAD' } } : {},
			...request.model !== undefined ? { model: request.model } : {}, ...request.effort !== undefined ? { effort: request.effort } : {} }).id;
	}

	preflightRemote(machine: string, request: RemoteLaunchRequest): Promise<void> {
		return this.deps.link.call('agent.start_preflight', this.remoteArgs(machine, request)).then(() => undefined);
	}

	launchRemote(machine: string, request: RemoteLaunchRequest): RunId {
		return this.start({ name: request.name, cli: request.cli, reveal: true, remote: { machine, request } }).id;
	}

	private remoteArgs(machine: string, request: RemoteLaunchRequest): StartArgs {
		return {
			command: [request.cli], machine: machineSelector(machine), window: this.window,
			cwd: request.location?.cwd ?? '', ...request.location ? {} : { cwd_is_default: true },
			...request.location?.source ? { location_source_window: request.location.source } : {},
			...request.name ? { name: request.name } : {}, cols: COLS, rows: ROWS
		};
	}

	async started(id: RunId): Promise<StartOutcome> {
		const pending = this.runs.get(id)?.pending;
		return pending ? pending.settled : { state: this.runs.has(id) ? 'running' : 'closed' };
	}

	/**
	 * New Agent opens its pair at acceptance (LIFECYCLE-1.5). Continue Session waits for the actual start.
	 */
	private start(options: {
		readonly name: string; readonly cli: string; readonly location?: Location; readonly reveal: boolean; readonly cwd?: string;
		readonly remote?: { readonly machine: string; readonly request: RemoteLaunchRequest };
		readonly worktree?: StartArgs['worktree']; readonly model?: string; readonly effort?: string; readonly session?: string;
	}): { readonly id: RunId; readonly result: Promise<RunId> } {
		const id = this.deps.newRunId();
		const window = this.window;
		const remote = options.remote;
		const cwd = remote?.request.location?.cwd ?? options.cwd ?? options.location?.path ?? '';
		const recent = options.session !== undefined;
		// A blank name is filled in at once, as the old engine fills it, and core starts the agent under it (LIFECYCLE-2.1)
		const name = remote ? options.name : options.name || suggestName(this.list().map(run => run.name), this.deps.names?.()) || '';
		const settled = deferred<StartOutcome>();
		const pending: Pending = { name, cli: options.cli, location: options.location, machine: remote?.machine, cwd, createdAt: Date.now(), worktree: !!options.worktree,
			sessionId: options.session, settled: settled.promise };
		const run: Run = { id, pending, ...recent ? { sessionOpening: 'continued' } : {}, facts: undefined! };
		const args: StartArgs = remote ? { ...this.remoteArgs(remote.machine, remote.request), request_id: id } : {
			command: [options.cli], cwd, window, location_source_window: window,
			env: this.deps.environment(options.location), cols: COLS, rows: ROWS, request_id: id,
			...name ? { name } : {},
			...options.worktree ? { worktree: options.worktree } : {},
			...options.model !== undefined ? { model: options.model } : {},
			...options.effort !== undefined ? { effort: options.effort } : {},
			...options.session !== undefined ? { session: options.session } : {}
		};
		this.starting.set(id, run);
		if (!recent) { this.addRun(run, options.reveal, false); }
		this.deps.log.event(`Asked core to start ${options.cli} in ${args.cwd} [${id}]`);
		const result = this.deps.link.call<StartResult>('agent.start', args).then(async ({ agent: reported }) => {
			await this.waitForSnapshot(window);
			const agent = agentAddress(reported);
			if (reported.machine_id !== (remote?.machine ?? window.machine_id)) { throw agentMissing(agent); }
			if (this.removedAgents.has(agent)) {
				run.closeAfterLaunch?.resolve('already_ended');
				this.drop(run, 'close');
				throw agentMissing(agent);
			}
			const info = this.all.get(agent) ?? reported;
			if (!this.isMember(info)) { throw agentMissing(agent); }
			if (run.closeAfterLaunch) {
				if (remote) {
					this.updated(info, false);
					run.agent = agent;
					run.pending = undefined;
					this.byAgent.set(agent, id);
					this.bindTerminal(run, info);
					this.project(info);
				} else {
					this.closed.set(agent, info);
					this.updated(info);
				}
				run.closeAfterLaunch.resolve(this.stopRecord(info));
				return id;
			}
			this.updated(info, false);
			run.agent = agent;
			run.pending = undefined;
			if (recent) {
				if (!this.cleanExit(info)) { this.addRun(run); }
			} else {
				this.byAgent.set(agent, id);
				this.bindTerminal(run, info);
				if (run.tab) { this.keepPlace(agent, run.tab); }
				this.project(info);
			}
			if (options.location) { this.deps.history.remember(options.location.id, options.cli); }
			this.deps.log.event(`Started ${this.agentLabel(info)} (${options.cli}) [${id}]`);
			if (recent && options.reveal && this.runs.has(id)) {
				await this.deps.terminals.reveal(id, { preserveFocus: false });
			}
			return id;
		}, (err: unknown) => {
			const refused = launchRefused(err);
			if (this.owns(window)) {
				if (!refused) {
					const kept = err instanceof DaemonError ? err.data.kept?.path : undefined;
					const conversation = options.session === undefined ? undefined
						: { environment: options.location?.environment ?? this.environmentOf(), cli: options.cli, sessionId: options.session };
					this.unconfirmedStarts.set(id, { cwd: kept ?? cwd, machine: remote?.machine, conversation, error: err });
				}
				if (run.closeAfterLaunch && remote && refused) { this.drop(run, 'close'); }
				else if ((!run.closeAfterLaunch || remote) && !recent) { this.fail(run, err, labelOf({ name, alias: options.cli })); }
			}
			if (refused) { run.closeAfterLaunch?.resolve('not_started'); }
			throw err;
		}).finally(() => {
			if (this.starting.get(id) === run) {
				this.starting.delete(id);
				this.projectAll();
			}
		});
		void result.then(
			() => settled.resolve({ state: run.closeAfterLaunch ? 'closed' : 'running' }),
			(err: unknown) => {
				run.closeAfterLaunch?.reject(err);
				settled.resolve(run.closeAfterLaunch || !this.owns(window) ? { state: 'closed' } : { state: 'failed', error: messageOf(err) });
			}
		);
		return { id, result };
	}

	/** Makes `run` red with why its start or resume was refused, said in its terminal and, where `told`, to the person (UX-2.4, RULES-1.8). */
	private fail(run: Run, err: unknown, told: string | undefined): void {
		const original = err instanceof ResumeSettingsError ? err.cause : err;
		const daemon = original instanceof DaemonError ? original : undefined;
		const english = messageOf(err);
		const reason = err instanceof ResumeSettingsError ? reasonText(err.said, english) : daemon ? this.deps.describe(daemon) : english;
		const kept = daemon?.data.kept;
		const worktree = kept && (kept.branch || kept.path) ? { ...kept.branch ? { branch: kept.branch } : {}, ...kept.path ? { folder: kept.path } : {} } : undefined;
		run.failure = { reason, ...reason !== english ? { english } : {}, source: daemon?.reason === 'worktree_failed' ? 'worktree' : 'launch', at: Date.now(), ...worktree ? { worktree } : {} };
		if (this.runs.get(run.id) === run) { this.refresh(run); } else { this.addRun(run); }
		this.deps.terminals.note(run.id, reason);
		this.deps.log.event(`Core refused the start of ${run.facts.alias || run.id}: ${english}`);
		if (told !== undefined) {
			const settingsFile = !!daemon && (!!daemon.data.entry || daemon.reason === 'configuration_invalid');
			this.deps.human.failed({ kind: 'start', name: told, reason, ...worktree ? { worktree } : {} }, { show: run.id, ...settingsFile ? { settingsFile } : {} });
		}
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Stop Agent, Dismiss Agent and Rename

	async stop(id: RunId): Promise<AgentCloseResult> {
		const run = this.runs.get(id);
		return run && this.endedHere(run) ? 'already_ended' : this.close(id);
	}

	async dismiss(id: RunId): Promise<void> {
		const run = this.runs.get(id);
		// close reaches only its ended branch after this check, with no asynchronous work in between.
		if (run && this.endedHere(run)) { await this.close(id); }
	}

	private endedHere(run: Run): boolean {
		if (run.agent) {
			const info = this.all.get(run.agent);
			return info !== undefined && this.confirmedEnd(info);
		}
		return !!run.failure && !this.unconfirmedStarts.has(run.id);
	}

	private confirmedEnd(info: AgentInfo): boolean {
		const agent = agentAddress(info);
		return this.hasSnapshot() && info.process === 'ended' && !info.unreachable
			&& !this.resuming.has(agent) && !this.unconfirmedResumes.has(agent);
	}

	async close(id: RunId, options?: { readonly forWorktreeDeletion: true }): Promise<AgentCloseResult> {
		const run = this.runs.get(id);
		if (!run) { throw agentMissing(id); }
		const uncertain = this.unconfirmedStarts.get(id);
		if (uncertain) { throw uncertain.error; }
		if (this.starting.has(id) && run.pending && !run.failure) { return this.closeStart(run); }
		const info = run.agent ? this.all.get(run.agent) : undefined;
		if (info) { return this.closeRecord(info, options?.forWorktreeDeletion); }
		this.drop(run, 'close');
		return 'already_ended';
	}

	private closeStart(run: Run): Promise<AgentCloseResult> {
		run.closeAfterLaunch ??= deferred<AgentCloseResult>();
		if (run.pending?.machine === undefined) { this.drop(run, 'close'); }
		return run.closeAfterLaunch.promise;
	}

	private async closeRecord(info: AgentInfo, forWorktreeDeletion = false): Promise<AgentCloseResult> {
		const agent = agentAddress(info);
		const resuming = this.resuming.get(agent);
		const uncertain = this.unconfirmedResumes.get(agent);
		// The exit before Resume does not establish the outcome of the new attempt.
		if (uncertain && !resuming && !(this.hasSnapshot() && isNewProcess(uncertain.before, info))) {
			throw uncertain.error;
		}
		if (forWorktreeDeletion && this.local(info)) {
			this.deps.pins.removeAgentPins(info.machine_id, info.agent_id);
		}
		const run = this.runOf(agent);
		if (run && !run.failure && !resuming && this.hasSnapshot() && info.process === 'ended' && !this.cleanExit(info)) {
			// Keep the card if the workspace refuses to save its dismissal (LIFECYCLE-3.4).
			this.deps.dismissed?.set(agent, true);
		}
		if (this.local(info) || info.process === 'ended' && !info.unreachable && !resuming) {
			if (this.isMember(info)) { this.closed.set(agent, info); }
			if (run) { this.drop(run, 'close'); }
		}
		if (resuming) {
			const window = this.window;
			resuming.closing ??= resuming.result.then(resumed => {
				if (!this.owns(window)) { throw bindingChanged(); }
				return this.removedAgents.has(agent) ? 'already_ended' : this.stopRecord(resumed);
			}, (err: unknown) => {
				if (this.owns(window) && this.removedAgents.has(agent)) { return 'already_ended'; }
				if (resumeRefused(info.agent_id, err)) { return 'not_started'; }
				throw err;
			});
			return resuming.closing;
		}
		if (this.hasSnapshot() && info.process === 'ended' && !info.unreachable) {
			this.remember(info);
			return 'already_ended';
		}
		return this.stopRecord(info);
	}

	worktreeAgents(path: string): number {
		const { records, starts, uncertain } = this.worktreeSelection(path);
		return records.length + starts.length + uncertain.length;
	}

	async closeWorktreeAgents(path: string): Promise<boolean> {
		const generation = this.generation;
		const checked = new Map<string, AgentInfo>();
		for (;;) {
			if (!this.hasSnapshot() || this.generation !== generation) { return false; }
			const { records, starts, uncertain } = this.worktreeSelection(path);
			const pending = starts.map(run => ({
				id: run.id, result: this.closeStart(run)
			}));
			for (const info of records) {
				const agent = agentAddress(info);
				const before = checked.get(agent);
				if (before && !this.resuming.has(agent) && !isNewProcess(before, info)) { continue; }
				checked.set(agent, info);
				pending.push({ id: this.agentLabel(info), result: this.closeRecord(info, true) });
			}
			for (const [id, start] of uncertain) {
				this.deps.log.event(`Could not close ${id} to delete its worktree: ${messageOf(start.error)}`);
			}
			if (!pending.length) { return !uncertain.length; }
			const ended = await Promise.all(pending.map(async ({ id, result }) => {
				try {
					const outcome = await result;
					this.deps.log.event(`Closed ${id} to delete its worktree: ${outcome}`);
					return outcome !== 'failed' && outcome !== 'unconfirmed';
				} catch (err) {
					this.deps.log.event(`Could not close ${id} to delete its worktree: ${messageOf(err)}`);
					return false;
				}
			}));
			if (uncertain.length || ended.some(result => !result)) { return false; }
			// Starts and resumes can have settled while an earlier stop was in flight.
		}
	}

	private worktreeSelection(path: string) {
		const key = folderKeyOf(path);
		const inside = (cwd: string) => isWithin(folderKeyOf(cwd), key);
		const records = this.hasSnapshot() ? [...this.all.values()].filter(info => info.location_source_window
			&& sameWindow(info.location_source_window, this.window) && inside(info.cwd)) : [];
		const starts = [...this.starting.values()].filter(run => run.pending && run.pending.machine === undefined && inside(run.pending.cwd));
		const uncertain = [...this.unconfirmedStarts].filter(([, start]) => start.machine === undefined && inside(start.cwd));
		return { records, starts, uncertain };
	}

	/** Keeps the agent's saved conversation and name for Recent (LIFECYCLE-3.2). */
	private remember(info: AgentInfo): void {
		if (!info.session || !this.local(info)) { return; }
		const location = this.deps.locations.resolve(info.location_id);
		try {
			this.deps.conversations.put({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session },
				{ ...location ? { location: location.id } : {}, cwd: info.cwd, name: keptName({ name: info.name, alias: `#${info.agent_id}` }) });
		} catch (err) {
			this.deps.log.event(`Could not keep #${info.agent_id}'s conversation for Recent: ${messageOf(err)}`);
		}
	}

	private stopRecord(info: AgentInfo): Promise<AgentCloseResult> {
		const agent = agentAddress(info);
		const stopping = this.stopping.get(agent);
		if (stopping && !isNewProcess(stopping.info, info)) { return stopping.result; }
		this.remember(info);
		const window = this.window;
		const local = this.local(info);
		const result = this.deps.link.call<StopResult>('agent.stop', { agent }).then((stopped): AgentCloseResult => {
			this.deps.log.event(`Ended ${this.agentLabel(info)}: ${stopped.already_ended ? 'already ended' : 'stopped'}`);
			const current = this.all.get(agent);
			if (!local && this.owns(window) && current && !isNewProcess(info, current)) {
				this.closed.set(agent, current);
				const run = this.runOf(agent);
				if (run) { this.drop(run, 'close'); }
			}
			return stopped.already_ended ? 'already_exited' : 'terminated';
		}, (err: unknown): AgentCloseResult => {
			if (this.stopping.get(agent)?.result === result) { this.stopping.delete(agent); }
			this.deps.log.event(`Could not stop ${this.agentLabel(info)} in core: ${messageOf(err)}`);
			if (local && stopRefused(err)) { return 'failed'; }
			throw err;
		});
		this.stopping.set(agent, { info, result });
		return result;
	}

	rename(id: RunId, name: string): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (!run.agent) {
			throw invalid('unavailable', `${labelOf(run.facts)} has not started yet.`);
		}
		const window = this.window;
		const before = this.all.get(run.agent);
		void this.deps.link.call<AgentInfo>('agent.rename', { agent: run.agent, name }).then(info => {
			if (this.owns(window) && this.complete && this.all.get(agentAddress(info)) === before) { this.updated(info); }
		}, (err: unknown) => {
			const reason = err instanceof DaemonError ? this.deps.describe(err) : messageOf(err);
			this.deps.human.error(vscode.l10n.t("Could not rename {0}: {1}", labelOf(run.facts), reason), { show: id });
		});
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Go to Agent and Resume (LIFECYCLE-2.3, 3.2, 3.3)

	otherAgents(): readonly OtherAgent[] {
		if (!this.hasSnapshot()) { return []; }
		return [...this.all.values()].filter(info => this.isOtherAgent(info)).map(info => this.otherAgent(info));
	}

	async queryOtherAgents(): Promise<readonly OtherAgent[]> {
		if (!this.deps.link.connected) { return []; }
		const window = this.window;
		const generation = this.generation;
		const result = await this.deps.link.call<AgentListResult>('agent.list', {});
		if (!this.owns(window) || this.generation !== generation) { throw bindingChanged(); }
		this.candidates.clear();
		const others: OtherAgent[] = [];
		for (const info of result.agents) {
			const key = agentAddress(info);
			if (!this.all.has(key) && !this.removedAgents.has(key) && this.isOtherAgent(info)) {
				this.candidates.set(key, info);
				others.push(this.otherAgent(info));
			}
		}
		return others;
	}

	private otherAgent(info: AgentInfo): OtherAgent {
		const windows = this.deps.windows();
		return {
			facts: this.factsOf({ id: agentAddress(info), facts: undefined! }, info),
			windows: (info.windows ?? []).map(ref => {
				const row = windows.find(window => window.machine_id === ref.machine_id && window.window_id === ref.window_id);
				if (row) { return { label: row.label || ref.window_id, connected: row.connected }; }
				return ref.machine_id === this.window.machine_id ? { label: ref.window_id, connected: false }
					: { label: ref.window_id };
			})
		};
	}

	async adoptAgent(agent: string): Promise<RunId> {
		const window = this.window;
		await this.adoptRecord(this.requireAgent(agent));
		if (!this.owns(window)) { throw bindingChanged(); }
		return (this.runOf(agent) ?? this.project(this.requireAgent(agent), undefined, true))?.id ?? agent;
	}

	async stopOtherAgent(agent: string): Promise<AgentCloseResult> {
		const info = this.requireAgent(agent);
		if (info.guest) { throw agentMissing(agent); }
		return this.confirmedEnd(info) ? 'already_ended' : this.closeRecord(info);
	}

	private adoptRecord(info: AgentInfo): Promise<AgentInfo> {
		const agent = agentAddress(info);
		const adopting = this.adopting.get(agent);
		if (adopting) { return adopting; }
		if (this.isMember(info)) { return Promise.resolve(info); }
		const result = this.adoptReply(info, this.window).finally(() => {
			if (this.adopting.get(agent) !== result) { return; }
			this.adopting.delete(agent);
			const current = this.all.get(agent);
			if (current && this.complete) { this.project(current, undefined, true); }
		});
		this.adopting.set(agent, result);
		return result;
	}

	private async adoptReply(info: AgentInfo, window: WindowRef): Promise<AgentInfo> {
		const agent = agentAddress(info);
		let response: AgentInfo;
		try {
			response = await this.deps.link.call<AgentInfo>('agent.adopt', { agent });
		} catch (err) {
			// Adoption's not_found refers to the record itself, unlike a failure to resume its CLI.
			if (this.owns(window) && this.local(info) && err instanceof DaemonError && err.reason === 'not_found') { this.removed(info); }
			throw err;
		}
		await this.waitForSnapshot(window);
		const current = this.requireAgent(agent);
		if (agentAddress(response) !== agent || !this.isMember(response)) { throw agentMissing(agent); }
		const adopted = current === info ? mergeWindows(response, current) : mergeWindows(current, response);
		this.updated(adopted, false);
		return adopted;
	}

	retainedConversations(): readonly RetainedConversation[] {
		if (!this.hasSnapshot()) { return []; }
		const retained: RetainedConversation[] = [];
		for (const info of this.all.values()) {
			if (!this.isMember(info) || !this.confirmedEnd(info) || !info.session) { continue; }
			const title = this.titleOf(info);
			retained.push({
				agent: agentAddress(info),
				alias: this.agentLabel(info),
				name: keptName({ name: info.name, alias: `#${info.agent_id}` }),
				entry: { key: this.conversationKey(info, info.session), cwd: info.cwd, title, activityAt: Date.parse(info.exit?.at ?? info.created_at) }
			});
		}
		return retained;
	}

	async resume(entry: ConversationEntry, options: { readonly reveal: boolean }): Promise<ResumeResult> {
		await this.waitForSnapshot(this.window);
		const running = this.holding(entry.key);
		if (running) {
			return { running };
		}
		const uncertain = this.uncertainConversation(entry.key);
		if (uncertain) { throw uncertain.error; }
		if (entry.unavailable) {
			throw new FacadeError('INVALID', 'unsupported', entry.unavailable);
		}
		if (!entry.key.sessionId || entry.key.sessionId.includes('\0')) { throw invalid('invalid_argument', 'An exact session ID is required.'); }
		const meta = this.deps.conversations.get(entry.key);
		if (entry.cwdChoices?.length && !meta?.cwd) {
			throw invalid('invalid_argument', 'Choose a working location before continuing this session.');
		}
		const cwd = meta?.cwd ?? entry.cwd;
		const location = this.locationFor(meta?.location, cwd);
		if (!location || location.environment !== entry.key.environment) {
			throw new FacadeError('INVALID', 'not_found', vscode.l10n.t("The working location {0} is not available in this window.", cwd));
		}
		const problem = this.deps.resumeProblem(entry.key.cli, location, entry.builtIn);
		if (problem !== undefined) { throw new FacadeError('INVALID', 'unsupported', problem); }
		return this.start({ name: meta?.name.trim() ?? '', cli: entry.key.cli, location, cwd, reveal: options.reveal, session: entry.key.sessionId }).result;
	}

	async resumeRetained(agent: string, options: { readonly reveal: boolean }): Promise<RunId> {
		const window = this.window;
		const info = this.requireAgent(agent);
		if (!this.isMember(info)) { throw agentMissing(agent); }
		let attempt = this.resuming.get(agent);
		if (!attempt && (info.process !== 'running' || !this.hasSnapshot())) {
			if (info.session) {
				const key = this.conversationKey(info, info.session);
				if (this.holding(key, agent)) {
					throw invalid('unavailable', vscode.l10n.t("{0} is already running in another window.", info.name || this.agentLabel(info)));
				}
				const uncertain = this.uncertainConversation(key, agent);
				if (uncertain) { throw uncertain.error; }
			}
			attempt = this.requestResume(info);
		}
		if (attempt) {
			const resumed = await attempt.result;
			if (!this.owns(window)) { throw bindingChanged(); }
			if (this.local(resumed)) { this.deps.history.remember(resumed.location_id, resumed.cli); }
		}
		const current = this.requireAgent(agent);
		const run = this.project(current, undefined, true);
		if (run && options.reveal) { await this.deps.terminals.reveal(run.id, { preserveFocus: false }); }
		return run?.id ?? agent;
	}

	/** Share one local attempt. Core serializes requests from separate windows under the same agent number. */
	private requestResume(info: AgentInfo): ResumeAttempt {
		const agent = agentAddress(info);
		const ongoing = this.resuming.get(agent);
		if (ongoing) { return ongoing; }
		const window = this.window;
		const args: ResumeArgs = {
			agent, cols: COLS, rows: ROWS,
			...this.local(info) ? { env: this.deps.environment(this.locationFor(info.location_id, info.cwd)) } : {}
		};
		const result = this.resumeReply(info, args, window).then(resumed => {
			if (!this.owns(window)) { throw bindingChanged(); }
			this.resuming.delete(agent);
			const current = this.requireAgent(agent);
			// A report can overtake the reply, including a quick exit of the newly installed process.
			const confirmed = isNewProcess(info, current) ? mergeWindows(current, resumed) : mergeWindows(resumed, current);
			this.unconfirmedResumes.delete(agent);
			if (attempt.closing && this.local(info)) {
				this.closed.set(agent, confirmed);
			} else {
				this.closed.delete(agent);
				this.clearDismissal(agent);
			}
			this.updated(confirmed, true, true);
			return confirmed;
		}, (err: unknown) => {
			if (this.owns(window)) {
				this.resuming.delete(agent);
				const current = this.all.get(agent);
				if (current && !attempt.closing) { this.project(current); }
			}
			throw err;
		});
		const attempt: ResumeAttempt = { result };
		this.resuming.set(agent, attempt);
		const run = this.runOf(agent);
		if (run) { this.refresh(run, 'lifecycle'); }
		return attempt;
	}

	/** A refusal can cross a report that the same record is already running in this window. */
	private async resumeReply(info: AgentInfo, args: ResumeArgs, window: WindowRef): Promise<AgentInfo> {
		const agent = agentAddress(info);
		let resumed: AgentInfo;
		try {
			resumed = await this.deps.link.call<AgentInfo>('agent.resume', args);
		} catch (err) {
			const current = this.owns(window) ? this.all.get(agent) : undefined;
			if (current && this.hasSnapshot() && this.isMember(current) && current.process === 'running') { return current; }
			if (current && !resumeRefused(info.agent_id, err) && !(this.hasSnapshot() && isNewProcess(info, current))) {
				this.unconfirmedResumes.set(agent, { before: info, error: err });
			}
			throw resumeSettingsError(err, info.cli);
		}
		await this.waitForSnapshot(window);
		if (agentAddress(resumed) !== agent || !this.isMember(resumed)) { throw agentMissing(agent); }
		return resumed;
	}

	holding(key: ConversationKey, except?: string): RunId | 'elsewhere' | undefined {
		for (const run of this.runs.values()) {
			if ((!except || run.agent !== except) && run.facts.lifecycle !== 'ended' && run.facts.sessionId === key.sessionId
				&& run.facts.cli === key.cli && run.facts.environment === key.environment) {
				return run.id;
			}
		}
		for (const run of this.starting.values()) {
			const pending = run.pending;
			if (pending?.sessionId === key.sessionId && pending.cli === key.cli && pending.location?.environment === key.environment) {
				return run.id;
			}
		}
		for (const info of this.all.values()) {
			if (agentAddress(info) !== except && (info.process === 'running' || this.resuming.has(agentAddress(info))) && this.matchesConversation(info, key)) {
				return 'elsewhere';
			}
		}
		return undefined;
	}

	private uncertainConversation(key: ConversationKey, except?: string): { readonly error: unknown } | undefined {
		const id = conversationId(key);
		for (const start of this.unconfirmedStarts.values()) {
			if (start.conversation && conversationId(start.conversation) === id) { return start; }
		}
		for (const [agent, resume] of this.unconfirmedResumes) {
			if (agent !== except && this.matchesConversation(resume.before, key)) { return resume; }
		}
		return undefined;
	}

	/** Reads the titles of this window's agents' conversations again (CLIS-2.4). */
	async refreshConversations(): Promise<void> {
		await Promise.all([...this.all.values()].filter(info => info.process === 'running' && this.isMember(info)).map(info => this.readTitle(info)));
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Pins (LIFECYCLE-3.4)

	pin(id: RunId): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const info = run.agent ? this.all.get(run.agent) : undefined;
		const { environment, cli, sessionId } = run.facts;
		if (!info || !this.local(info) || !run.facts.pinnable || !sessionId) {
			throw new FacadeError('INVALID', 'unsupported', `${run.facts.name}'s CLI has not named its session, so it cannot be pinned.`, { kind: 'pin_unsupported', values: [] });
		}
		this.deps.pins.pinAgent({
			id: `pin-${randomBytes(16).toString('hex')}`, conversation: { environment, cli, sessionId },
			location: run.facts.location, cwd: run.facts.cwd, name: keptName(run.facts), machine_id: info.machine_id, agent: info.agent_id
		});
		this.refresh(run, 'lifecycle');
		this.deps.terminals.pinTab?.(id, true);
	}

	unpin(id: RunId): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (run.facts.pin) {
			this.deps.pins.remove(run.facts.pin);
			this.refresh(run, 'lifecycle');
			this.deps.terminals.pinTab?.(id, false);
		}
	}

	/** Resumes eligible Pins under their saved agent numbers, then opens the pinned tabs in one sequence (LIFECYCLE-3.4, 3.5). */
	async restorePins(): Promise<void> {
		if (this.disposed) { return; }
		const first = !this.pinsRequested;
		this.pinsRequested = true;
		while (!this.complete && !this.disposed) { await this.ready; }
		if (this.disposed) { return; }
		if (first) {
			const legacy = this.deps.pins.list().filter(pin => pin.agent === undefined);
			if (legacy.length) {
				const conversations = legacy.map(pin => JSON.stringify(pin.conversation)).join(', ');
				this.deps.log.event(`Skipped ${legacy.length} session-only Pins for Rust restoration: ${conversations}`);
			}
		}
		await this.restoreVerifiedPins();
	}

	private restoreVerifiedPins(): Promise<void> {
		if (this.pinRestore?.generation === this.generation) { return this.pinRestore.result; }
		if (!this.hasSnapshot()) { return Promise.resolve(); }
		const generation = this.generation;
		const result = this.restoreWindowPins(this.window, generation);
		this.pinRestore = { generation, result };
		return result;
	}

	private async restoreWindowPins(window: WindowRef, generation: number): Promise<void> {
		const outcomes = await Promise.all(this.pins().map(pin => this.restorePin(pin, window, generation)));
		if (!this.owns(window)) { return; }
		if (this.generation === generation) { await this.openPinnedTabs(generation); }
		const failed = outcomes.filter(run => run && this.runs.get(run.id) === run && run.failure);
		const first = failed[0];
		if (first?.failure && !this.disposed) {
			this.deps.human.failed({ kind: 'restore', name: labelOf(first.facts), reason: first.failure.reason, count: failed.length }, {});
		}
	}

	/** Verify the membership before using the retained number to reopen a pinned conversation (LIFECYCLE-3.4). */
	private async restorePin(pin: RustPin, window: WindowRef, generation: number): Promise<Run | undefined> {
		const agent = agentAddress({ machine_id: pin.machine_id, agent_id: pin.agent });
		const before = this.all.get(agent);
		if (!before) { return undefined; }
		try {
			await this.adoptRecord(before);
		} catch (err) {
			this.deps.log.event(`Could not adopt ${agent} for its Pin: ${messageOf(err)}`);
			return undefined;
		}
		if (this.generation !== generation || !this.hasSnapshot()) { return undefined; }
		const info = this.all.get(agent);
		if (!info || !this.pinOf(info) || !this.isMember(info) || this.checkedPins.has(agent)) {
			return undefined;
		}
		this.checkedPins.add(agent);
		if (before.process === 'running' || info.process === 'running' || this.closed.has(agent)
			|| (!this.cleanExit(info) && !this.deps.dismissed?.has(agent))) {
			return undefined;
		}
		if (info.session) {
			const key = this.conversationKey(info, info.session);
			if (this.holding(key, agent) || this.uncertainConversation(key, agent)) { return undefined; }
		}
		try {
			await this.requestResume(info).result;
		} catch (err) {
			const current = this.owns(window) ? this.all.get(agent) : undefined;
			if (!current || !this.pinOf(current) || !this.isMember(current) || this.closed.has(agent)) { return undefined; }
			if (this.hasSnapshot() && current.process === 'running') {
				this.project(current, undefined, true);
				return undefined;
			}
			const run = this.runOf(agent) ?? this.recordRun(agent);
			run.sessionOpening = 'resumed';
			this.fail(run, err, undefined);
			return run;
		}
		return undefined;
	}

	/** Opens pinned agents' tabs one at a time, in the Pins' order, then lets the panel select the last (LIFECYCLE-3.5, PANEL-2.1). */
	private async openPinnedTabs(generation: number): Promise<void> {
		let opened = false;
		for (const pin of this.pins()) {
			if (!this.hasSnapshot() || generation !== this.generation) { return; }
			const run = this.runOf(agentAddress({ machine_id: pin.machine_id, agent_id: pin.agent }));
			if (!run || this.openedPins.has(pin.id) || run.facts.pin !== pin.id || run.failure || run.facts.lifecycle === 'starting') { continue; }
			this.openedPins.add(pin.id);
			await this.deps.terminals.openPinned?.(run.id).catch(err => this.deps.log.event(`Could not open ${run.id}'s pinned tab: ${messageOf(err)}`));
			opened = true;
		}
		if (opened && this.hasSnapshot() && this.generation === generation) { this.deps.terminals.pinnedOpened?.(); }
	}

	/** Where the run's tab is now, kept for a reload to bring a pinned agent's back there (LIFECYCLE-3.5). */
	private tabPlaced(id: RunId, place: TabPlace): void {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		run.tab = place;
		if (run.agent) { this.keepPlace(run.agent, place); }
	}

	private tabClosed(id: RunId, marked: boolean): void {
		if (marked && this.runs.get(id)?.facts.pin) {
			this.unpin(id);
		}
	}

	private tabPinned(id: RunId, pinned: boolean): void {
		const run = this.runs.get(id);
		if (!run || pinned === !!run.facts.pin) {
			return;
		}
		try {
			if (pinned) { this.pin(id); } else { this.unpin(id); }
		} catch (err) {
			this.deps.terminals.pinTab?.(id, !!run.facts.pin);
			this.deps.human.failed({ kind: pinned ? 'pin' : 'unpin', name: labelOf(run.facts), reason: messageOf(err) }, { show: id });
		}
	}

	private isPinHere(pin: Pin): pin is RustPin {
		return pin.machine_id === this.window.machine_id && typeof pin.agent === 'string' && /^a[1-9]\d*$/.test(pin.agent);
	}

	private pinOf(info: AgentRef): RustPin | undefined {
		return this.local(info) ? this.pins().find(pin => pin.agent === info.agent_id) : undefined;
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// The `agents` topic

	private bound(window: WindowRef): void {
		this.generation++;
		this.resetSnapshot();
		this.stopping.clear();
		if (!sameWindow(this.window, window)) {
			this.window = window;
			this.all.clear();
			this.candidates.clear();
			this.removedAgents.clear();
			this.closed.clear();
			this.starting.clear();
			this.adopting.clear();
			this.resuming.clear();
			this.unconfirmedStarts.clear();
			this.unconfirmedResumes.clear();
			this.titles.clear();
			this.told.clear();
			this.openedPins.clear();
			for (const run of this.runs.values()) { this.drop(run, 'transfer'); }
		}
		this.emitOtherAgents();
	}

	private resetSnapshot(): void {
		this.complete = false;
		this.snapshotReady.resolve();
		this.snapshotReady = deferred<void>();
	}

	private watchDisconnected(): void {
		if (this.disposed) { return; }
		if (this.complete) { this.resetSnapshot(); }
		for (const [agent, info] of this.all) {
			if (!this.local(info) && !info.unreachable) { this.all.set(agent, { ...info, unreachable: true }); }
			if (this.local(info) && info.process === 'ended') {
				const run = this.runOf(agent);
				if (run) { this.refresh(run); }
			}
		}
		this.machinesChanged();
	}

	private owns(window: WindowRef): boolean {
		return !this.disposed && this.window === window;
	}

	private hasSnapshot(): boolean {
		return this.complete && this.deps.link.connected && !this.disposed;
	}

	private async waitForSnapshot(window: WindowRef): Promise<void> {
		while (this.owns(window) && !this.complete) { await this.ready; }
		if (!this.owns(window)) { throw bindingChanged(); }
	}

	private requireAgent(agent: string): AgentInfo {
		const info = this.all.get(agent) ?? this.candidates.get(agent);
		if (!info) { throw agentMissing(agent); }
		return info;
	}

	private isMember(info: AgentInfo): boolean {
		return info.windows.some(window => sameWindow(window, this.window));
	}

	private isOtherAgent(info: AgentInfo): boolean {
		return !info.unreachable && !info.guest && info.process === 'running' && !this.isMember(info);
	}

	private local(info: AgentRef): boolean {
		return info.machine_id === this.window.machine_id;
	}

	private machinesChanged(): void {
		for (const run of this.runs.values()) {
			if (run.facts.remoteMachine !== undefined) { this.refresh(run); }
		}
		this.emitOtherAgents();
	}

	private windowsChanged(): void {
		if (this.hasSnapshot()) {
			for (const run of this.runs.values()) {
				const info = run.agent ? this.all.get(run.agent) : undefined;
				if (info && this.local(info) && !this.resuming.has(agentAddress(info)) && run.facts.environment !== this.environmentOf(info.location_id)) {
					this.refresh(run, 'reported');
				}
			}
		}
		this.emitOtherAgents();
	}

	private snapshot(view: AgentsSnapshot): void {
		if (this.disposed || !this.deps.link.connected) { return; }
		const before = new Map(this.all);
		this.all.clear();
		const complete = new Set([this.window.machine_id]);
		for (const info of view.agents) {
			if (this.local(info)) { this.all.set(agentAddress(info), info); }
		}
		for (const machine of view.machines) {
			if (machine.state === 'synced' && machine.agents && machine.machine_id !== this.window.machine_id) {
				complete.add(machine.machine_id);
				for (const info of machine.agents) {
					if (info.machine_id === machine.machine_id) { this.all.set(agentAddress(info), info); }
				}
			}
		}
		this.complete = true;
		for (const [id, info] of before) {
			if (!this.all.has(id)) {
				if (complete.has(info.machine_id)) { this.removed(info, false); }
				else { this.all.set(id, { ...info, unreachable: true }); }
			}
		}
		this.verifyPins();
		this.keepDismissals(complete);
		for (const info of this.all.values()) {
			this.reconcile(info, before.get(agentAddress(info)), true, false);
		}
		this.snapshotReady.resolve();
		this.emitOtherAgents();
		if (this.pinsRequested) {
			void this.restoreVerifiedPins().catch(err => this.deps.log.event(`Could not restore pinned agents: ${messageOf(err)}`));
		}
	}

	private machineState(machine: AgentMachineState): void {
		if (machine.machine_id === this.window.machine_id) { return; }
		const records = [...this.all.values()].filter(info => info.machine_id === machine.machine_id);
		if (machine.state !== 'synced' || !machine.agents) {
			for (const info of records) { this.updated({ ...info, unreachable: true }); }
			return;
		}
		const agents = machine.agents.filter(info => info.machine_id === machine.machine_id);
		const present = new Set(agents.map(agentAddress));
		for (const info of records) {
			if (!present.has(agentAddress(info))) { this.removed(info); }
		}
		for (const info of agents) { this.updated(info); }
		this.keepDismissals(new Set([machine.machine_id]));
	}

	private keepDismissals(complete: ReadonlySet<string>): void {
		const selectors = new Set([...complete].map(machineSelector));
		try {
			this.deps.dismissed?.retain(agent => this.all.has(agent) || !selectors.has(agent.slice(agent.indexOf('@') + 1)));
		} catch (err) {
			this.deps.log.event(`Could not reconcile dismissed agent cards: ${messageOf(err)}`);
		}
	}

	private updated(info: AgentInfo, project = true, resumed = false): void {
		const agent = agentAddress(info);
		if (this.disposed || this.removedAgents.has(agent)) { return; }
		const before = this.all.get(agent);
		this.all.set(agent, info);
		this.reconcile(info, before, project, resumed);
		if (this.isOtherAgent(info) || (before && this.isOtherAgent(before))) { this.emitOtherAgents(); }
	}

	private reconcile(info: AgentInfo, before: AgentInfo | undefined, project: boolean, resumed: boolean): void {
		const agent = agentAddress(info);
		const stopping = this.stopping.get(agent);
		if (stopping && (info.process === 'ended' || isNewProcess(stopping.info, info))) { this.stopping.delete(agent); }
		const closed = this.closed.get(agent);
		if (closed) {
			if (isNewProcess(closed, info)) { this.closed.delete(agent); }
			else if (info.process === 'ended') { this.closed.set(agent, info); }
		}
		const uncertain = this.unconfirmedResumes.get(agent);
		if (uncertain && isNewProcess(uncertain.before, info)) { this.unconfirmedResumes.delete(agent); }
		this.keepPin(info);
		const restarted = before && isNewProcess(before, info);
		if (restarted || (info.process === 'running' && before?.process !== 'running')) {
			this.clearDismissal(agent);
		}
		if (project) { this.project(info, before, resumed, resumed); }
		const turnEnded = before?.state === 'working' && (info.state === 'idle' || info.state === 'just_done');
		if (info.process === 'running' && (before?.session !== info.session || before?.process !== 'running'
			|| before?.cwd !== info.cwd || restarted || turnEnded)) {
			void this.readTitle(info);
		}
	}

	private project(info: AgentInfo, before?: AgentInfo, force = false, resumed = false): Run | undefined {
		const agent = agentAddress(info);
		const run = this.runOf(agent);
		if (!this.isMember(info)) {
			if (run) { this.drop(run, 'transfer'); }
			if (before?.process === 'running' && this.cleanExit(info)) { this.closed.set(agent, info); }
			return undefined;
		}
		if (this.adopting.has(agent) || this.resuming.has(agent) || this.closed.has(agent)) { return undefined; }
		const restarted = !!before && isNewProcess(before, info);
		if (run && (resumed || restarted || info.process === 'running')) { run.failure = undefined; }
		if (this.cleanExit(info) && !run?.failure) {
			if (!before || !this.isMember(before) || !this.cleanExit(before) || before.exit?.at !== info.exit?.at
				|| before.session !== info.session || before.name !== info.name || before.cwd !== info.cwd || before.location_id !== info.location_id) {
				this.remember(info);
			}
			if (run || before?.process === 'running' || resumed) { this.closed.set(agent, info); }
			if (run) { this.drop(run, 'exit'); }
			return undefined;
		}
		if (run) {
			if (resumed || restarted) { run.sessionOpening = 'resumed'; }
			this.refresh(run, undefined, restarted);
			return run;
		}
		if ((!force && this.starting.size && !info.creator) || (info.process === 'ended' && this.deps.dismissed?.has(agent))) { return undefined; }
		const added = this.recordRun(agent);
		if (resumed || restarted) { added.sessionOpening = 'resumed'; }
		this.addRun(added);
		return added;
	}

	/** Unbound starts defer projection of human starts until their own replies identify them (LIFECYCLE-2.2). */
	private projectAll(): void {
		if (!this.complete || this.disposed) { return; }
		for (const info of this.all.values()) {
			if (!this.byAgent.has(agentAddress(info)) && !this.cleanExit(info)) { this.project(info); }
		}
	}

	private runOf(agent: string): Run | undefined {
		const id = this.byAgent.get(agent);
		return id === undefined ? undefined : this.runs.get(id);
	}

	/** A complete snapshot of the bound machine proves which pinned records still exist. */
	private verifyPins(): void {
		for (const pin of this.pins()) {
			if (!this.all.has(agentAddress({ machine_id: pin.machine_id, agent_id: pin.agent }))) {
				this.clearPin(pin);
			}
		}
	}

	/** Updates the conversation details of this exact Pin (LIFECYCLE-3.4). */
	private keepPin(info: AgentInfo): void {
		const pin = this.pinOf(info);
		if (!pin) { return; }
		const name = keptName({ name: info.name, alias: `#${info.agent_id}` });
		const sessionId = info.session ?? pin.conversation.sessionId;
		if (pin.name === name && pin.location === info.location_id && pin.cwd === info.cwd && pin.conversation.sessionId === sessionId) { return; }
		try {
			this.deps.pins.updatePin(pin, { ...pin, name, location: info.location_id, cwd: info.cwd, conversation: { ...pin.conversation, sessionId } });
		} catch (err) {
			this.deps.log.event(`Could not update #${info.agent_id}'s Pin: ${messageOf(err)}`);
		}
	}

	private removed(ref: AgentRef, reported = true): void {
		if (this.disposed) { return; }
		const agent = agentAddress(ref);
		this.all.delete(agent);
		this.candidates.delete(agent);
		this.removedAgents.add(agent);
		this.closed.delete(agent);
		this.stopping.delete(agent);
		this.unconfirmedResumes.delete(agent);
		this.titles.delete(agent);
		const run = this.runOf(agent);
		if (run) { this.drop(run, 'close'); }
		if (reported) {
			const pin = this.pinOf(ref);
			if (pin) { this.clearPin(pin); }
			this.clearDismissal(agent);
			this.emitOtherAgents();
		}
		this.keepPlace(agent, undefined);
	}

	private clearPin(pin: Pin): void {
		try {
			this.deps.pins.remove(pin.id);
		} catch (err) {
			this.deps.log.event(`Could not clear #${pin.agent}'s Pin: ${messageOf(err)}`);
		}
	}

	private clearDismissal(agent: string): void {
		if (!this.deps.dismissed?.has(agent)) { return; }
		try {
			this.deps.dismissed.set(agent, false);
		} catch (err) {
			this.deps.log.event(`Could not clear ${agent}'s dismissed card: ${messageOf(err)}`);
		}
	}

	private keepPlace(agent: string, place: TabPlace | undefined): void {
		try {
			this.deps.places?.set(agent, place);
		} catch (err) {
			this.deps.log.event(`Could not keep ${agent}'s tab position: ${messageOf(err)}`);
		}
	}

	private recordRun(agent: string): Run {
		return { id: agent, agent, tab: this.deps.places?.get(agent), facts: undefined! };
	}

	private addRun(run: Run, reveal = false, hidden = true): void {
		run.facts = this.factsOf(run);
		this.runs.set(run.id, run);
		if (run.agent) { this.byAgent.set(run.agent, run.id); }
		this.openPair(run, reveal, hidden);
		this.emit({ run: run.id, kind: 'added' });
	}

	private openPair(run: Run, reveal: boolean, hidden: boolean): void {
		const { terminals } = this.deps;
		terminals.openPair(pairOf(run.facts), { reveal, hidden });
		const info = run.agent && this.all.get(run.agent);
		if (info) { this.bindTerminal(run, info); }
		if (run.facts.lifecycle === 'ended' && !run.failure) { terminals.exited(run.id, this.endText(run.facts)); }
	}

	private bindTerminal(run: Run, info: AgentInfo): void {
		this.deps.terminals.bind(run.id, agentAddress(info), this.local(info) ? undefined : { reachable: !info.unreachable });
	}

	/** Its card and tab go together (UX-2.2). */
	private drop(run: Run, cause: NonNullable<RunChange['cause']>): void {
		if (this.runs.get(run.id) !== run) { return; }
		this.runs.delete(run.id);
		if (run.agent) { this.byAgent.delete(run.agent); }
		this.deps.terminals.removePair(run.id);
		this.emit({ run: run.id, kind: 'removed', cause });
	}

	/** Recomputes `run`'s facts from its record, and tells what changed. */
	private refresh(run: Run, kind?: RunChange['kind'], restarted = false): void {
		const before = run.facts;
		const after = this.factsOf(run);
		run.facts = after;
		if (this.runs.get(run.id) !== run) { return; }
		if (restarted || before.lifecycle === 'ended' && after.lifecycle !== 'ended') {
			// The old pseudoterminal stopped taking input at exit. Bind a fresh one to the same agent.
			const hidden = !this.deps.terminals.tabOpen(run.id);
			this.deps.terminals.removePair(run.id);
			this.openPair(run, false, hidden);
		} else if (before.name !== after.name) {
			this.deps.terminals.rename(run.id, after.name);
		}
		if (after.remoteMachine !== undefined) {
			this.deps.terminals.setReachable(run.id, !after.disconnected);
		}
		if (!restarted && before.lifecycle !== 'ended' && after.lifecycle === 'ended' && !run.failure) {
			this.deps.terminals.exited(run.id, this.endText(after));
		}
		this.emit({ run: run.id, kind: kind ?? (before.name !== after.name ? 'renamed'
			: before.lifecycle !== after.lifecycle || before.error !== after.error || before.pin !== after.pin
				|| before.disconnected !== after.disconnected || before.endUnconfirmed !== after.endUnconfirmed || before.sessionOpening !== after.sessionOpening ? 'lifecycle' : 'reported') });
	}

	/**
	 * A zero exit or a Facade stop closes its card (RULES-3.3). Any other end keeps the red card until Dismiss Agent.
	 */
	private cleanExit(info: AgentInfo): boolean {
		return info.process === 'ended' && ((info.exit?.code === 0 && !info.exit.signal) || info.state_detail?.how === 'stopped');
	}

	/** What an ended agent's terminal says, in the card's words. */
	private endText(facts: RunFacts): string {
		const end = facts.end;
		return end?.signal ? vscode.l10n.t("Process terminated · {0}", end.signal)
			: end?.code !== undefined ? vscode.l10n.t("Process exited · code {0}", String(end.code)) : vscode.l10n.t("Process lost · reason unknown");
	}

	/** `RunFacts` from core's record, or from a start not answered yet. */
	private factsOf(run: Run, info = run.agent ? this.all.get(run.agent) : undefined): RunFacts {
		const pin = info && this.isMember(info) ? this.pinOf(info)?.id : undefined;
		const failure = run.failure;
		if (!info) {
			const pending = run.pending!;
			return {
				id: run.id, alias: '', name: pending.name, cli: pending.cli, displayName: this.displayName(pending.cli, pending.machine), command: pending.cli,
				location: pending.location?.id ?? pending.cwd, cwd: pending.cwd,
				environment: pending.machine ? `machine:${pending.machine}` : pending.location?.environment ?? this.environmentOf(), yolo: false,
				...pending.machine ? { remoteMachine: this.deps.machineName(pending.machine),
					...!this.deps.link.connected ? { disconnected: true } : {} } : {},
				createdAt: pending.createdAt, lifecycle: failure ? 'ended' : 'starting', phase: pending.worktree ? 'creating_worktree' : 'launching_cli',
				activity: 'unknown', reporting: false, root: run.id, origin: 'human', tools: 'not_injected',
				...pending.sessionId ? { sessionId: pending.sessionId, sessionOpening: run.sessionOpening } : {},
				...failure ? { error: failure, end: { kind: 'failed' as const, at: failure.at } } : {},
				...this.unconfirmedStarts.has(run.id) ? { endUnconfirmed: true as const } : {}
			};
		}
		const local = this.local(info);
		const root = agentAddress({ agent_id: info.root, machine_id: info.root_machine_id ?? info.machine_id });
		const facts: Mutable<RunFacts> = {
			id: run.id, alias: this.agentLabel(info), address: info.address ?? agentAddress(info), name: info.name, cli: info.cli,
			displayName: this.displayName(info.cli, local ? undefined : info.machine_id), command: info.cli,
			location: info.location_id, cwd: info.cwd, environment: this.agentEnvironment(info), yolo: info.yolo,
			...local ? {} : { remoteMachine: this.deps.machineName(info.machine_id) },
			...info.unreachable ? { disconnected: true } : {},
			createdAt: Date.parse(info.created_at), lifecycle: 'running', phase: 'running', activity: 'unknown', reporting: false,
			root: this.byAgent.get(root) ?? root, origin: info.creator ? 'agent' : 'human', tools: info.tools_state
		};
		if (info.pid !== undefined) { facts.pid = info.pid; }
		if (info.creator) {
			const creator = agentAddress({ agent_id: info.creator, machine_id: info.creator_machine_id ?? info.machine_id });
			facts.creator = this.byAgent.get(creator) ?? creator;
		}
		if (info.session) { facts.sessionId = info.session; facts.resumable = true; facts.pinnable = local; }
		if (info.tools_reason) { facts.toolsReason = info.tools_reason; }
		if (info.tools_reason === 'disconnected') { facts.toolsProblem = 'disconnected'; }
		if (info.said) {
			facts.said = displayLine(info.said.text, MOST_LINE);
			const source = saidSourceOf(info.said.from, info.said.from_name);
			if (source) { facts.saidSource = source; }
		}
		if (run.sessionOpening) { facts.sessionOpening = run.sessionOpening; }
		if (run.tab) { facts.tab = run.tab; }
		const title = this.titleOf(info);
		if (title) { facts.title = title; facts.titleSource = 'conversation'; }
		if (pin) { facts.pin = pin; }
		const detail = info.state_detail;
		if (failure) {
			facts.lifecycle = 'ended';
			facts.error = failure;
			facts.end = { kind: 'failed', at: failure.at };
		} else if (info.process === 'ended') {
			const at = Date.parse(info.exit?.at ?? '') || Date.now();
			facts.lifecycle = 'ended';
			facts.end = { kind: 'abnormal', at, ...info.exit?.code !== undefined ? { code: info.exit.code } : {}, ...info.exit?.signal ? { signal: info.exit.signal } : {} };
			facts.error = { reason: '', source: 'exit', at };
		} else {
			switch (info.state) {
				case 'working': facts.activity = 'working'; facts.reporting = true; break;
				case 'idle': case 'just_done': facts.activity = 'not_working'; facts.reporting = true; break;
				case 'waiting_for_you': facts.activity = 'not_working'; facts.reporting = true;
					facts.blocker = { kind: detail?.kind ?? 'unknown', ...detail?.text ? { text: detail.text } : {} }; break;
				case 'starting': facts.awaitingActivity = true; break;
				case 'error':
					if (detail?.reason === 'not_ready') { facts.notReady = true; }
					else if (detail?.reason !== 'tools_unavailable') { facts.error = { reason: detail?.text ?? '', source: 'cli', at: Date.now() }; }
					break;
				case 'unknown':
					if (detail?.reason && UNKNOWN[detail.reason]) { facts.activityUnknown = UNKNOWN[detail.reason]; }
					break;
			}
		}
		if (facts.lifecycle === 'ended' && !this.confirmedEnd(info)) { facts.endUnconfirmed = true; }
		// The same error object while it lasts, so a refresh says `reported` rather than `lifecycle`
		if (facts.error && run.facts?.error && JSON.stringify({ ...facts.error, at: 0 }) === JSON.stringify({ ...run.facts.error, at: 0 })) {
			facts.error = run.facts.error;
		}
		return facts;
	}

	private displayName(cli: string, machine?: string): string {
		return this.deps.clis(machine).find(each => each.cli === cli)?.display_name ?? cli;
	}

	private agentLabel(info: AgentInfo): string {
		return info.label ?? (this.local(info) ? `#${info.agent_id}` : agentAddress(info));
	}

	private agentEnvironment(info: AgentInfo): string {
		return this.local(info) ? this.environmentOf(info.location_id) : `machine:${info.machine_id}`;
	}

	/** A location's environment: `local` or the window's remote authority, the same for every location of the window. */
	private environmentOf(location?: LocationId): string {
		const local = (location === undefined ? undefined : this.deps.locations.resolve(location)) ?? this.deps.locations.snapshot().locations[0];
		if (local) { return local.environment; }
		return this.deps.windows().find(window => window.machine_id === this.window.machine_id && window.window_id === this.window.window_id)?.environment ?? 'local';
	}

	private conversationKey(info: AgentInfo, sessionId: string): ConversationKey {
		return { environment: this.agentEnvironment(info), cli: info.cli, sessionId };
	}

	private matchesConversation(info: AgentInfo, key: ConversationKey): boolean {
		return info.session === key.sessionId && info.cli === key.cli && this.agentEnvironment(info) === key.environment;
	}

	private locationFor(id: LocationId | undefined, cwd: string): Location | undefined {
		const known = id ? this.deps.locations.resolve(id) : undefined;
		if (known && known.path === cwd) {
			return known;
		}
		return this.deps.locations.snapshot().locations.find(each => each.path === cwd) ?? this.deps.locations.conversationLocation?.(cwd);
	}

	private titleOf(info: AgentInfo): string | undefined {
		const read = this.titles.get(agentAddress(info));
		return read?.session === info.session && read?.cwd === info.cwd ? read?.title : undefined;
	}

	/** Reads the CLI's own history for Go to Agent and the panel (CLIS-2.4, LIFECYCLE-2.3). */
	private async readTitle(info: AgentInfo): Promise<void> {
		const agent = agentAddress(info);
		const { cli, cwd, session } = info;
		if (!session || !this.local(info)) { return; }
		const window = this.window;
		const key = this.conversationKey(info, session);
		try {
			const title = await this.deps.titles.title(key, cwd, this.deps.titles.storeOf?.(cli, cwd));
			const current = this.owns(window) ? this.all.get(agent) : undefined;
			if (!title || !current || current.session !== session || current.cwd !== cwd || this.titleOf(current) === title) { return; }
			this.titles.set(agent, { session, cwd, title });
			const run = this.runOf(agent);
			if (run && !this.resuming.has(agent)) { this.refresh(run, 'reported'); }
			if (this.isOtherAgent(current)) { this.emitOtherAgents(); }
		} catch (err) {
			this.deps.log.event(`Could not read the title of ${this.agentLabel(info)}'s conversation: ${messageOf(err)}`);
		}
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// The person's inbox

	/** A snapshot supplies the saved message. A first live change can also notify this window (COLLABORATION-2.3). */
	private message(message: Message, live: boolean): void {
		if (this.disposed || message.to !== 'human' || !message.message_ref) { return; }
		const record = this.recordOf(message, message.message_ref);
		const seen = this.told.has(record.id);
		this.told.set(record.id, record);
		if (live && !seen) { this.deps.contact.contact(record, id => this.told.get(id)); }
	}

	private recordOf(message: Message, ref: NonNullable<Message['message_ref']>): MessageRecord {
		const sender = { agent_id: message.from, machine_id: message.from_machine_id ?? ref.machine_id };
		const address = agentAddress(sender);
		const info = this.all.get(address);
		const from = message.from === 'facade' ? { run: 'facade' as const }
			: { run: this.byAgent.get(address) ?? address, alias: info ? this.agentLabel(info) : this.local(sender) ? `#${message.from}` : address,
				...message.from_name ? { name: message.from_name } : {} };
		const environment = this.environmentOf();
		const delivery = message.delivery;
		const id = messageAddress(ref);
		return {
			id, alias: ref.machine_id === this.window.machine_id ? `#${ref.message_id}` : id,
			kind: message.from === 'facade' ? 'result' : 'message', from, to: { run: '@human' },
			window: this.window.window_id, environment, at: Date.parse(message.at) || Date.now(), text: message.text, length: [...message.text].length,
			...message.reply_to ? { replyTo: messageAddress({ message_id: message.reply_to, machine_id: message.reply_to_machine_id ?? ref.machine_id }) } : {},
			delivery: {
				status: delivery.status, ...delivery.reason ? { reason: delivery.reason } : {}, attempts: 1, via: 'notification',
				effects: { outcome: delivery.status === 'success' ? 'confirmed' : 'none', text_written: delivery.text_written },
				...delivery.delivered_at ? { deliveredAt: Date.parse(delivery.delivered_at) } : {}
			}
		};
	}

	private emitOtherAgents(): void {
		for (const listener of [...this.otherListeners]) { listener(); }
	}

	private emit(change: RunChange): void {
		const { terminals } = this.deps;
		// A name repeating among the window's cards shows their short IDs on their tabs (LIFECYCLE-2.2)
		if (change.kind === 'added' || change.kind === 'removed' || change.kind === 'renamed') {
			const facts = this.list();
			const repeated = repeatedNames(facts);
			for (const each of facts) {
				if (each.alias) { terminals.tabLabel?.(each.id, each.alias, !each.name.trim() || repeated.has(each.name.trim())); }
			}
		}
		// Its tab spins while its dot is green (LIFECYCLE-2.2)
		const run = this.runs.get(change.run);
		const busy = !!run && dotOf(run.facts) === 'working';
		if (run && busy !== !!run.spinning) {
			run.spinning = busy;
			terminals.spin?.(change.run, busy);
		}
		for (const listener of [...this.listeners]) {
			listener(change);
		}
	}
}

function sameWindow(left: WindowRef, right: WindowRef): boolean {
	return left.machine_id === right.machine_id && left.window_id === right.window_id;
}

/** Membership grows while the record exists. Keep later observations when a mutation reply crosses a topic update. */
function mergeWindows(info: AgentInfo, observed: AgentInfo): AgentInfo {
	const windows = [...(info.windows ?? [])];
	for (const ref of observed.windows ?? []) {
		if (!windows.some(window => sameWindow(window, ref))) { windows.push(ref); }
	}
	if (windows.length === info.windows?.length) { return info; }
	windows.sort((a, b) => a.machine_id.localeCompare(b.machine_id) || a.window_id.localeCompare(b.window_id));
	return { ...info, windows };
}

function isNewProcess(before: AgentInfo, after: AgentInfo): boolean {
	const differentPid = before.pid !== undefined && after.pid !== undefined && before.pid !== after.pid;
	const differentExit = before.exit !== undefined && after.exit !== undefined && before.exit.at !== after.exit.at;
	return differentPid || (before.process === 'ended' && (after.process === 'running' || differentExit));
}

function agentMissing(agent: string): FacadeError {
	return new FacadeError('NOT_FOUND', 'not_found', `No agent ${agent} in this window.`);
}

function bindingChanged(): DaemonError {
	return new DaemonError('The connection to Facade core was closed.', 'unavailable', { reason: 'unavailable' });
}

function deferred<T>(): PromiseWithResolvers<T> {
	let resolve!: PromiseWithResolvers<T>['resolve'];
	let reject!: PromiseWithResolvers<T>['reject'];
	const promise = new Promise<T>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}

/** A refusal known to have left the CLI unstarted. A missing answer carries its original reason. */
function launchRefused(err: unknown): boolean {
	if (err instanceof DaemonError && err.data.unavailable) { return err.data.unavailable.execution === 'not_executed'; }
	return err instanceof DaemonError && err.reason !== 'internal' && !(
		err.message.includes('the call may or may not have run') || err.message.includes('the outcome is unknown')
		|| err.message.startsWith('could not keep ') || err.message.includes(': its actor stopped')
	);
}

function resumeRefused(agent: string, err: unknown): boolean {
	return launchRefused(err) && !(err instanceof DaemonError && err.reason === 'unavailable'
		&& (err.message === `agent #${agent} is running or already resuming` || err.message === `agent #${agent} is running`));
}

/** A known refusal the editor can translate, with the daemon's original reason and fields still available. */
class ResumeSettingsError extends FacadeError {
	constructor(override readonly cause: DaemonError, said: FacadeReason) {
		super(cause.reason === 'unavailable' ? 'UNAVAILABLE' : 'INVALID', cause.reason, cause.message, said);
	}
}

/** Translate the two v2 settings refusals shared by Resume Agent and Pin restoration. */
function resumeSettingsError(err: unknown, cli: string): unknown {
	if (!(err instanceof DaemonError)) { return err; }
	const setting = entrySetting(cli);
	if (err.reason === 'unsupported' && err.data.entry === cli && err.message.startsWith(setting)) {
		const changed = /^ runs .+ now, but this conversation is (.+)'s; it cannot be resumed with it$/.exec(err.message.slice(setting.length));
		if (changed) {
			return new ResumeSettingsError(err, { kind: 'resume_type_changed', values: [setting, changed[1]] });
		}
	}
	if (err.reason === 'unavailable') {
		const quoted = JSON.stringify(cli);
		const start = `${quoted} is no longer in clis of `;
		const end = ', so this conversation cannot be resumed with it.';
		if (err.message.startsWith(start) && err.message.endsWith(end)) {
			const file = err.message.slice(start.length, -end.length);
			return new ResumeSettingsError(err, { kind: 'resume_entry_gone', values: [quoted, file] });
		}
	}
	return err;
}

/** Core uses `unavailable` for both refusals and unconfirmed stops. Only explicit refusals establish failure. */
function stopRefused(err: unknown): boolean {
	if (!(err instanceof DaemonError)) { return false; }
	switch (err.reason) {
		case 'invalid_argument': case 'not_found': case 'ambiguous_reference': case 'unsupported': case 'refused': case 'capacity_exceeded':
			return true;
		default:
			return err.message.endsWith('nothing was sent') || err.message.endsWith('was not stopped yet')
				|| err.message.startsWith('keeper request queue is full:') || err.message.includes('runs in a terminal of its own;');
	}
}

/** Who said a card's second line (PANEL-1.4): the person's own input has none. */
function saidSourceOf(from: string, name: string | undefined): SaidSource | undefined {
	if (from === 'human') {
		return undefined;
	}
	if (from === 'facade') {
		return { kind: 'facade' };
	}
	return { kind: 'agent', alias: `#${from}`, ...name ? { name } : {} };
}

function pairOf(facts: RunFacts): PairFacts {
	return { run: facts.id, name: facts.name, cli: facts.cli, displayName: facts.displayName, command: facts.command, cwd: facts.cwd,
		...facts.tab !== undefined ? { tab: facts.tab } : {}, ...facts.pin ? { pinned: true as const } : {} };
}
