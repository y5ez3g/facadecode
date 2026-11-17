/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This window's agents on the Rust engine: core keeps them, and the window shows its own - the `agents` topic's records whose
// `window_id` is this window's - as the panel's cards, through the same `Agents` the old engine gives the UI (ARCHITECTURE-1.3).

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { messageOf } from '../../base/errors';
import { displayLine } from '../../base/text';
import type { AgentInfo, AgentsChange, CliInfo, Message, MessagesChange, MessagesSnapshot, ResumeArgs, StartArgs, StartResult, StopResult } from '../../base/coreProtocol';
import { FacadeError, invalid } from '../../core/errors';
import type { MessageRecord } from '../../core/messagePorts';
import { keptName, labelOf, repeatedNames, suggestName } from '../../core/names';
import { dotOf } from '../../core/status';
import type {
	ActivityUnknown, Agents, CleanupResult, ConversationEntry, ConversationKey, ConversationTitlePort, Disposable, Event, HumanPort,
	LaunchHistoryPort, LaunchRequest, Location, LocationId, LocationPort, LogPort, PairFacts, Pin, PinStore, RunChange, RunError,
	RunFacts, RunId, SaidSource, StartOutcome, TabPlace
} from '../../core/ports';
import type { ConversationFile } from '../../record/conversations';
import { facadeRoot } from '../../record/paths';
import type { WindowContact } from '../contact';
import { DaemonError, type DaemonLink, type RustTerminals } from './types';

export interface RustAgentsDeps {
	readonly link: DaemonLink;
	readonly terminals: RustTerminals;
	readonly locations: LocationPort;
	readonly clis: () => readonly CliInfo[];
	readonly environment: (location: Location) => Record<string, string>;
	readonly pins: PinStore;
	readonly conversations: ConversationFile;
	readonly titles: ConversationTitlePort;
	readonly history: LaunchHistoryPort;
	readonly human: HumanPort;
	readonly contact: WindowContact;
	readonly describe: (err: DaemonError) => string;
	readonly log: LogPort;
	/** The exact Facade home used to connect to core. */
	readonly home?: string;
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
	retain(agents: ReadonlySet<string>): void;
}

type EndResult = CleanupResult | 'already_ended' | 'not_started';
type RustPin = Pin & { readonly agent: string };

/** What a start of this window is before core answers it, and how it went. */
interface Pending {
	readonly name: string;
	readonly cli: string;
	readonly location: Location;
	readonly createdAt: number;
	readonly worktree: boolean;
	readonly sessionId?: string;
	readonly settled: Promise<StartOutcome>;
}

interface Run {
	readonly id: RunId;
	/** Core's agent, once its start answered; at once for an agent the window found in the `agents` topic. */
	agent?: string;
	/** A start this window asked for, until core gives it an agent. */
	pending?: Pending;
	/** End Agent during launch answers once the launch and any resulting stop are settled. */
	closeAfterLaunch?: (result: EndResult | Promise<EndResult>) => void;
	/** A start or resume core refused: red until End Agent (UX-2.4). */
	failure?: RunError;
	/** The original error when core may have started a process despite the failed reply. */
	unconfirmedLaunch?: { readonly error: unknown; readonly before?: AgentInfo };
	/** A resume asked and not answered yet. */
	resuming?: boolean;
	/** It continues a session - Recent's, a Pin's, or its own resumed - rather than beginning one (PANEL-1.4). */
	resumed?: boolean;
	title?: string;
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
 * `Agents` on core: a start, a resume, End Agent and a rename are core's operations; the cards are core's records
 * of this window, a start this window asked for shown from its acceptance (LIFECYCLE-1.5). Pins and Recent's names stay the window's.
 */
export class RustAgents implements Agents, Disposable {
	readonly ready: Promise<void>;
	readonly onDidChange: Event<RunChange> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	private readonly listeners = new Set<(change: RunChange) => void>();
	private readonly runs = new Map<RunId, Run>();
	private readonly byAgent = new Map<string, RunId>();
	/** Starts awaiting a number, including those whose cards were closed before core answered. */
	private readonly starting = new Set<RunId>();
	/** Every agent the `agents` topic lists, of any window: a session running elsewhere is held there (LIFECYCLE-3.2). */
	private readonly all = new Map<string, AgentInfo>();
	/** Automatic resumes wait for core before showing a card (LIFECYCLE-3.4). */
	private readonly restoring = new Set<string>();
	/** Cards closed in this activation, including runs whose stop could not be confirmed. */
	private readonly closed = new Set<string>();
	private readonly home: string;
	/** Messages to the person already told (COLLABORATION-2.3). */
	private readonly told = new Map<string, MessageRecord>();
	private readonly subscriptions: Disposable[] = [];
	private pinsRestored = false;
	private disposed = false;

	constructor(private readonly deps: RustAgentsDeps) {
		const { link, terminals } = deps;
		this.home = deps.home ?? facadeRoot();
		let first!: () => void;
		this.ready = new Promise(resolve => first = resolve);
		this.subscriptions.push(
			link.watch<AgentInfo[], AgentsChange>('agents', {}, {
				snapshot: agents => {
					this.snapshot(agents);
					first();
				},
				change: change => change.kind === 'updated' ? this.updated(change.agent) : change.kind === 'removed' ? this.removed(change.agent_id) : undefined
			}),
			// The person's inbox: what this window's agents send #human (0.1, COLLABORATION-2.3)
			link.watch<MessagesSnapshot, MessagesChange>('messages', {}, {
				snapshot: inbox => inbox.messages.forEach(message => this.message(message)),
				change: change => { if (change.kind === 'updated') { this.message(change.message); } }
			}),
			terminals.onDidClosePair?.(({ run, marked }) => this.tabClosed(run, marked)) ?? { dispose() { } },
			terminals.onDidPinTab?.(({ run, pinned }) => this.tabPinned(run, pinned)) ?? { dispose() { } },
			terminals.onDidRenameTab?.(({ run, name }) => { if (this.runs.has(run)) { this.rename(run, name); } }) ?? { dispose() { } },
			terminals.onDidPlaceTab?.(({ run, place }) => this.tabPlaced(run, place)) ?? { dispose() { } }
		);
	}

	dispose(): void {
		this.disposed = true;
		this.subscriptions.forEach(each => each.dispose());
		this.listeners.clear();
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
			...request.model !== undefined ? { model: request.model } : {}, ...request.effort !== undefined ? { effort: request.effort } : {} });
	}

	async started(id: RunId): Promise<StartOutcome> {
		const pending = this.runs.get(id)?.pending;
		return pending ? pending.settled : { state: this.runs.has(id) ? 'running' : 'closed' };
	}

	/**
	 * A start this window asks for: its card and tab at once (LIFECYCLE-1.5), then `agent.start`, whose answer binds the run to its
	 * agent; a refusal makes it red with the reason's words (UX-2.4).
	 */
	private start(options: {
		readonly name: string; readonly cli: string; readonly location: Location; readonly reveal: boolean; readonly cwd?: string;
		readonly worktree?: StartArgs['worktree']; readonly model?: string; readonly effort?: string; readonly session?: string;
	}): RunId {
		const id = this.deps.newRunId();
		// A blank name is filled in at once, as the old engine fills it, and core starts the agent under it (LIFECYCLE-2.1)
		const name = options.name || suggestName(this.list().map(run => run.name), this.deps.names?.()) || '';
		let settle!: (outcome: StartOutcome) => void;
		const pending: Pending = { name, cli: options.cli, location: options.location, createdAt: Date.now(), worktree: !!options.worktree,
			...options.session !== undefined ? { sessionId: options.session } : {}, settled: new Promise(resolve => settle = resolve) };
		const run: Run = { id, pending, ...options.session ? { resumed: true } : {}, facts: undefined! };
		const args: StartArgs = {
			command: [options.cli], cwd: options.cwd ?? options.location.path, window_id: this.deps.link.windowId,
			env: this.deps.environment(options.location), cols: COLS, rows: ROWS, request_id: id,
			...name ? { name } : {},
			...options.worktree ? { worktree: options.worktree } : {},
			...options.model !== undefined ? { model: options.model } : {},
			...options.effort !== undefined ? { effort: options.effort } : {},
			...options.session !== undefined ? { session: options.session } : {}
		};
		this.starting.add(id);
		this.addRun(run, options.reveal, false);
		this.deps.log.event(`Asked core to start ${options.cli} in ${args.cwd} [${id}]`);
		this.deps.link.call<StartResult>('agent.start', args).then(result => {
			const agent = result.agent.agent_id;
			const info = this.all.get(agent) ?? result.agent;
			if (run.closeAfterLaunch) {
				this.closed.add(agent);
				this.updated(info, false);
				run.closeAfterLaunch(this.stop(info));
				return settle({ state: 'closed' });
			}
			run.agent = agent;
			run.pending = undefined;
			this.byAgent.set(agent, id);
			this.deps.terminals.bind(id, agent);
			if (run.tab) { this.deps.places?.set(agent, run.tab); }
			this.deps.history.remember(options.location.id, options.cli);
			this.deps.log.event(`Started #${agent} (${options.cli}) [${id}]`);
			this.updated(info);
			settle({ state: 'running' });
		}, (err: unknown) => {
			if (run.closeAfterLaunch) {
				run.closeAfterLaunch(launchRefused(err) ? 'not_started' : Promise.reject(err));
				return settle({ state: 'closed' });
			}
			const reason = this.fail(run, err, labelOf({ name, alias: options.cli }));
			settle({ state: 'failed', error: reason });
		}).finally(() => {
			this.starting.delete(id);
			this.adopt();
		});
		return id;
	}

	/** Makes `run` red with why its start or resume was refused, said in its terminal and, where `told`, to the person (UX-2.4, RULES-1.8). */
	private fail(run: Run, err: unknown, told: string | undefined, before?: AgentInfo): string {
		if (!launchRefused(err)) {
			run.unconfirmedLaunch = { error: err, before };
		}
		const daemon = err instanceof DaemonError ? err : undefined;
		const english = messageOf(err);
		const reason = daemon ? this.deps.describe(daemon) : english;
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
		return english;
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// End Agent and Rename

	async close(id: RunId, options?: { readonly forWorktreeDeletion: true }): Promise<EndResult> {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const agent = run.agent;
		const info = agent ? this.all.get(agent) : undefined;
		if (run.unconfirmedLaunch) {
			const { error, before } = run.unconfirmedLaunch;
			// The exit recorded before Resume cannot confirm that the resumed process ended.
			const resumedAndEnded = before && info?.process === 'ended'
				&& ((info.pid !== undefined && info.pid !== before.pid) || (info.exit && before.exit && info.exit.at !== before.exit.at));
			if (!resumedAndEnded) { throw error; }
		}
		if (options?.forWorktreeDeletion) { this.unpin(id); }
		if (run.resuming || (this.starting.has(id) && !run.failure)) {
			const closed = new Promise<EndResult>(resolve => { run.closeAfterLaunch = resolve; });
			if (agent) { this.closed.add(agent); }
			this.drop(run, 'close');
			return closed;
		}
		if (info?.process === 'ended' && !this.cleanExit(info) && !run.failure && this.deps.dismissed) {
			// Keep the card if the workspace refuses to save its dismissal (LIFECYCLE-3.4).
			this.deps.dismissed.set(info.agent_id, true);
		}
		if (agent) { this.closed.add(agent); }
		this.drop(run, 'close');
		if (!info || run.failure) { return 'already_ended'; }
		if (info.process === 'ended') {
			this.remember(info);
			return 'already_ended';
		}
		return this.stop(info);
	}

	/** Keeps the agent's saved conversation and name for Recent (LIFECYCLE-3.2). */
	private remember(info: AgentInfo): void {
		if (!info.session) { return; }
		const location = this.deps.locations.resolve(info.location_id);
		try {
			this.deps.conversations.put({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session },
				{ ...location ? { location: location.id } : {}, cwd: info.cwd, name: keptName({ name: info.name, alias: `#${info.agent_id}` }) });
		} catch (err) {
			this.deps.log.event(`Could not keep #${info.agent_id}'s conversation for Recent: ${messageOf(err)}`);
		}
	}

	private async stop(info: AgentInfo): Promise<EndResult> {
		const agent = info.agent_id;
		this.remember(info);
		try {
			const stopped = await this.deps.link.call<StopResult>('agent.stop', { agent });
			this.deps.log.event(`Ended #${agent}: ${stopped.already_ended ? 'already ended' : 'stopped'}`);
			return stopped.already_ended ? 'already_exited' : 'terminated';
		} catch (err) {
			this.deps.log.event(`Could not stop #${agent} in core: ${messageOf(err)}`);
			if (stopRefused(err)) { return 'failed'; }
			throw err;
		}
	}

	rename(id: RunId, name: string): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (!run.agent) {
			throw invalid('unavailable', `${labelOf(run.facts)} has not started yet.`);
		}
		this.deps.link.call<AgentInfo>('agent.rename', { agent: run.agent, name }).then(info => this.updated(info), (err: unknown) => {
			const reason = err instanceof DaemonError ? this.deps.describe(err) : messageOf(err);
			this.deps.human.error(vscode.l10n.t("Could not rename {0}: {1}", labelOf(run.facts), reason), { show: id });
		});
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Recent (LIFECYCLE-3.2, 3.3)

	resume(entry: ConversationEntry, options: { readonly reveal: boolean }): RunId | { readonly running: RunId | 'elsewhere' } {
		const running = this.holding(entry.key);
		if (running) {
			return { running };
		}
		if (entry.unavailable) {
			throw new FacadeError('INVALID', 'unsupported', entry.unavailable);
		}
		// The record can outlive its card. Resume this window's agent under its original number (RULES-4.2).
		const ended = [...this.all.values()].find(info => info.window_id === this.deps.link.windowId && info.process === 'ended'
			&& info.session === entry.key.sessionId && info.cli === entry.key.cli && this.environmentOf(info.location_id) === entry.key.environment);
		if (ended) {
			return this.resumeAgent(ended, options.reveal);
		}
		const meta = this.deps.conversations.get(entry.key);
		if (entry.cwdChoices?.length && !meta?.cwd) {
			throw invalid('invalid_argument', 'Choose a working location before resuming this conversation.');
		}
		const cwd = meta?.cwd ?? entry.cwd;
		const location = this.locationFor(meta?.location, cwd);
		if (!location) {
			throw new FacadeError('INVALID', 'not_found', vscode.l10n.t("The working location {0} is not available in this window.", cwd));
		}
		return this.start({ name: meta?.name.trim() ?? '', cli: entry.key.cli, location, cwd, reveal: options.reveal, session: entry.key.sessionId });
	}

	/** Manual Resume shows the accepted start immediately (LIFECYCLE-3.3). */
	private resumeAgent(info: AgentInfo, reveal: boolean): RunId {
		const agent = info.agent_id;
		this.closed.delete(agent);
		const existing = this.runOf(agent);
		const run = existing ?? this.recordRun(agent);
		run.resuming = true;
		run.resumed = true;
		run.failure = undefined;
		if (existing) { this.refresh(run); } else { this.addRun(run); }
		if (reveal) { void this.deps.terminals.reveal(run.id, { preserveFocus: false }); }
		void this.requestResume(info).then(resumed => {
			run.resuming = false;
			run.unconfirmedLaunch = undefined;
			if (run.closeAfterLaunch) {
				run.closeAfterLaunch(this.stop(resumed));
			} else if (this.runs.get(run.id) === run) {
				if (resumed.window_id === this.deps.link.windowId) {
					this.deps.history.remember(resumed.location_id, resumed.cli);
				}
				this.updated(resumed);
				void this.readTitle(run);
			}
		}, (err: unknown) => {
			run.resuming = false;
			const elsewhere = resumeElsewhere(agent, err);
			if (run.closeAfterLaunch) {
				run.closeAfterLaunch(!elsewhere && launchRefused(err) ? 'not_started' : Promise.reject(err));
			} else if (this.runs.get(run.id) === run) {
				if (elsewhere) {
					this.closed.add(agent);
					this.drop(run, 'transfer');
				} else {
					this.fail(run, err, labelOf(run.facts), info);
				}
			}
		});
		return run.id;
	}

	/** Core validates the record's cwd and session. Send this window's current launch environment (LIFECYCLE-3.3, 3.4). */
	private async requestResume(info: AgentInfo): Promise<AgentInfo> {
		const agent = info.agent_id;
		const location = this.locationFor(info.location_id, info.cwd);
		const args: ResumeArgs = { agent, env: location ? this.deps.environment(location) : {}, cols: COLS, rows: ROWS, window_id: this.deps.link.windowId };
		const resumed = await this.deps.link.call<AgentInfo>('agent.resume', args);
		if (!this.disposed) { this.clearDismissal(agent); }
		// A report about the new process can arrive before the answer, including a quick exit.
		const observed = this.all.get(agent);
		return observed && observed !== info && observed.pid === resumed.pid ? observed : resumed;
	}

	holding(key: ConversationKey): RunId | 'elsewhere' | undefined {
		for (const run of this.runs.values()) {
			if (run.facts.lifecycle !== 'ended' && run.facts.sessionId === key.sessionId && run.facts.cli === key.cli) {
				return run.id;
			}
		}
		for (const info of this.all.values()) {
			if ((info.process === 'running' || this.restoring.has(info.agent_id)) && info.session === key.sessionId && info.cli === key.cli) {
				return 'elsewhere';
			}
		}
		return undefined;
	}

	/** Reads the titles of this window's agents' conversations again (CLIS-2.4). */
	async refreshConversations(): Promise<void> {
		await Promise.all([...this.runs.values()].map(run => this.readTitle(run)));
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// Pins (LIFECYCLE-3.4)

	pin(id: RunId): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const agent = run.agent;
		const { environment, cli, sessionId } = run.facts;
		if (!agent || !run.facts.pinnable || !sessionId) {
			throw new FacadeError('INVALID', 'unsupported', `${run.facts.name}'s CLI has not named its conversation, so it cannot be pinned.`, { kind: 'pin_unsupported', values: [] });
		}
		if (run.facts.pin) {
			return;
		}
		const legacy = this.deps.pins.list().find(pin => pin.agent === undefined && pin.conversation.environment === environment
			&& pin.conversation.cli === cli && pin.conversation.sessionId === sessionId);
		const pin: Pin = {
			id: legacy?.id ?? `pin-${randomBytes(16).toString('hex')}`, conversation: { ...legacy?.conversation, environment, cli, sessionId },
			location: run.facts.location, cwd: run.facts.cwd, name: keptName(run.facts), home: this.home, agent
		};
		this.deps.pins.save(pin);
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
		if (this.pinsRestored || this.disposed) { return; }
		this.pinsRestored = true;
		await this.ready;
		if (this.disposed) { return; }
		const legacy = this.deps.pins.list().filter(pin => pin.home === undefined || pin.agent === undefined);
		if (legacy.length) {
			const conversations = legacy.map(pin => JSON.stringify(pin.conversation)).join(', ');
			this.deps.log.event(`Skipped ${legacy.length} stored Pins without an original home and agent number: ${conversations}`);
		}
		const attempts: Promise<Run | undefined>[] = [];
		for (const pin of this.pins()) {
			const info = this.all.get(pin.agent);
			if (!info || info.process === 'running' || this.closed.has(pin.agent) || this.restoring.has(pin.agent)
				|| (!this.cleanExit(info) && !this.deps.dismissed?.has(pin.agent))) {
				continue;
			}
			if (info.session && this.holding({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session })) {
				continue;
			}
			attempts.push(this.restoreAgent(info));
		}
		const outcomes = await Promise.all(attempts);
		if (this.disposed) { return; }
		await this.openPinnedTabs();
		const failed = outcomes.filter(run => run && this.runs.get(run.id) === run && run.failure);
		const first = failed[0];
		if (first?.failure && !this.disposed) {
			this.deps.human.failed({ kind: 'restore', name: labelOf(first.facts), reason: first.failure.reason, count: failed.length }, {});
		}
	}

	/** Automatic Resume only shows a card after core answers (LIFECYCLE-3.4). */
	private restoreAgent(info: AgentInfo): Promise<Run | undefined> {
		const agent = info.agent_id;
		this.restoring.add(agent);
		return this.requestResume(info).then(resumed => {
			if (!this.disposed && this.all.has(agent)) {
				this.updated(resumed, false);
				if (resumed.window_id === this.deps.link.windowId && !this.cleanExit(resumed)) {
					this.addRecord(resumed, true);
				}
			}
			return undefined;
		}, (err: unknown) => {
			if (this.disposed || !this.all.has(agent) || resumeElsewhere(agent, err)) { return undefined; }
			const run = this.recordRun(agent);
			run.resumed = true;
			this.fail(run, err, undefined, info);
			return run;
		}).finally(() => this.restoring.delete(agent));
	}

	/** Opens pinned agents' tabs one at a time, in the Pins' order, then lets the panel select the last (LIFECYCLE-3.5, PANEL-2.1). */
	private async openPinnedTabs(): Promise<void> {
		let opened = false;
		for (const pin of this.pins()) {
			const run = this.runOf(pin.agent);
			if (this.disposed || run?.facts.pin !== pin.id || run.failure || run.facts.lifecycle === 'starting') { continue; }
			await this.deps.terminals.openPinned?.(run.id).catch(err => this.deps.log.event(`Could not open ${run.id}'s pinned tab: ${messageOf(err)}`));
			opened = true;
		}
		if (opened && !this.disposed) { this.deps.terminals.pinnedOpened?.(); }
	}

	/** Where the run's tab is now, kept for a reload to bring a pinned agent's back there (LIFECYCLE-3.5). */
	private tabPlaced(id: RunId, place: TabPlace): void {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		run.tab = place;
		if (run.agent) { this.deps.places?.set(run.agent, place); }
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
		return pin.home === this.home && typeof pin.agent === 'string' && /^a[1-9]\d*$/.test(pin.agent);
	}

	private pinOf(agent: string): RustPin | undefined {
		return this.deps.pins.list().find((pin): pin is RustPin => pin.agent === agent && this.isPinHere(pin));
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// The `agents` topic

	private snapshot(agents: readonly AgentInfo[]): void {
		if (this.disposed) { return; }
		const listed = new Set(agents.map(each => each.agent_id));
		const known = new Set([...this.all.keys(), ...this.pins().map(pin => pin.agent)]);
		for (const id of known) {
			if (!listed.has(id)) { this.removed(id, false); }
		}
		try {
			this.deps.dismissed?.retain(listed);
		} catch (err) {
			this.deps.log.event(`Could not reconcile dismissed agent cards: ${messageOf(err)}`);
		}
		for (const info of agents) {
			this.updated(info, false);
		}
		this.adopt();
	}

	private updated(info: AgentInfo, adopt = true): void {
		if (this.disposed) { return; }
		const agent = info.agent_id;
		const before = this.all.get(agent);
		this.all.set(agent, info);
		if (info.process === 'running' && (!adopt || before?.process !== 'running' || before.pid !== info.pid)) {
			this.clearDismissal(agent);
		}
		const run = this.runOf(agent);
		if (info.window_id !== this.deps.link.windowId) {
			// A resume in progress still has to hear whether core gave it to this window.
			if (run && !run.resuming) { this.drop(run, 'transfer'); }
			return;
		}
		this.keepPin(info);
		if (!run) {
			if (this.cleanExit(info) && (!before || !this.cleanExit(before) || before.window_id !== info.window_id
				|| before.session !== info.session || before.name !== info.name || before.cwd !== info.cwd || before.location_id !== info.location_id)) {
				this.remember(info);
			}
			if (adopt) { this.adopt(); }
			return;
		}
		if (info.process === 'running') {
			run.failure = undefined;
			run.unconfirmedLaunch = undefined;
		}
		const turnEnded = before?.state === 'working' && (info.state === 'idle' || info.state === 'just_done');
		const sessionChanged = before?.session !== info.session;
		this.refresh(run);
		if (sessionChanged || turnEnded) { void this.readTitle(run); }
	}

	private runOf(agent: string): Run | undefined {
		const id = this.byAgent.get(agent);
		return id === undefined ? undefined : this.runs.get(id);
	}

	/** Updates the conversation details of this exact Pin (LIFECYCLE-3.4). */
	private keepPin(info: AgentInfo): void {
		const pin = this.pinOf(info.agent_id);
		if (!pin) { return; }
		const name = keptName({ name: info.name, alias: `#${info.agent_id}` });
		const sessionId = info.session ?? pin.conversation.sessionId;
		if (pin.name === name && pin.location === info.location_id && pin.cwd === info.cwd && pin.conversation.sessionId === sessionId) { return; }
		try {
			this.deps.pins.save({ ...pin, name, location: info.location_id, cwd: info.cwd, conversation: { ...pin.conversation, sessionId } });
		} catch (err) {
			this.deps.log.event(`Could not update #${info.agent_id}'s Pin: ${messageOf(err)}`);
		}
	}

	private removed(agent: string, reported = true): void {
		if (this.disposed) { return; }
		this.all.delete(agent);
		this.closed.delete(agent);
		const run = this.runOf(agent);
		if (run) { this.drop(run, 'close'); }
		const pin = this.pinOf(agent);
		if (pin) {
			try {
				this.deps.pins.remove(pin.id);
			} catch (err) {
				this.deps.log.event(`Could not clear #${agent}'s Pin: ${messageOf(err)}`);
			}
		}
		if (reported) { this.clearDismissal(agent); }
		this.deps.places?.set(agent, undefined);
	}

	private clearDismissal(agent: string): void {
		if (!this.deps.dismissed?.has(agent)) { return; }
		try {
			this.deps.dismissed.set(agent, false);
		} catch (err) {
			this.deps.log.event(`Could not clear #${agent}'s dismissed card: ${messageOf(err)}`);
		}
	}

	/**
	 * Shows this window's agents that have no card yet: one another agent started opens its card alone, its tab hidden (LIFECYCLE-2.2).
	 * While a start of this window waits for its answer, an agent the person started waits too: it is that start's.
	 */
	private adopt(): void {
		if (this.disposed) { return; }
		for (const info of this.all.values()) {
			const agent = info.agent_id;
			if (info.window_id !== this.deps.link.windowId || this.byAgent.has(agent) || this.closed.has(agent) || this.restoring.has(agent)
				|| (this.starting.size && !info.creator) || this.cleanExit(info)
				|| (info.process === 'ended' && this.deps.dismissed?.has(agent))) {
				continue;
			}
			this.addRecord(info);
		}
	}

	private recordRun(agent: string): Run {
		return { id: agent, agent, tab: this.deps.places?.get(agent), facts: undefined! };
	}

	private addRecord(info: AgentInfo, resumed = false): void {
		const run = this.recordRun(info.agent_id);
		run.resumed = resumed;
		this.addRun(run);
		void this.readTitle(run);
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
		if (run.agent) { terminals.bind(run.id, run.agent); }
		if (run.facts.lifecycle === 'ended' && !run.failure) { terminals.exited(run.id, this.endText(run.facts)); }
	}

	/** Its card and tab go: End Agent, a clean exit, its removal from core, or another window taking it (UX-2.2). */
	private drop(run: Run, cause: NonNullable<RunChange['cause']>): void {
		if (this.runs.get(run.id) !== run) { return; }
		this.runs.delete(run.id);
		if (run.agent) { this.byAgent.delete(run.agent); }
		this.deps.terminals.removePair(run.id);
		this.emit({ run: run.id, kind: 'removed', cause });
	}

	/** Recomputes `run`'s facts from its record, and tells what changed. */
	private refresh(run: Run, kind?: RunChange['kind']): void {
		const before = run.facts;
		const after = this.factsOf(run);
		run.facts = after;
		if (this.runs.get(run.id) !== run) { return; }
		if (before.lifecycle === 'ended' && after.lifecycle !== 'ended') {
			// The old pseudoterminal stopped taking input at exit. Bind a fresh one to the same agent.
			const hidden = !this.deps.terminals.tabOpen(run.id);
			this.deps.terminals.removePair(run.id);
			this.openPair(run, false, hidden);
		} else if (before.name !== after.name) {
			this.deps.terminals.rename(run.id, after.name);
		}
		if (before.lifecycle !== 'ended' && after.lifecycle === 'ended' && !run.failure) {
			const info = run.agent ? this.all.get(run.agent) : undefined;
			if (info && this.cleanExit(info)) {
				this.closed.add(info.agent_id);
				this.remember(info);
				this.drop(run, 'exit');
				return;
			}
			this.deps.terminals.exited(run.id, this.endText(after));
		}
		this.emit({ run: run.id, kind: kind ?? (before.name !== after.name ? 'renamed'
			: before.lifecycle !== after.lifecycle || before.error !== after.error || before.pin !== after.pin ? 'lifecycle' : 'reported') });
	}

	/**
	 * A zero exit or a Facade stop closes its card (RULES-3.3). Any other end keeps the red card until End Agent.
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
	private factsOf(run: Run): RunFacts {
		const info = run.agent ? this.all.get(run.agent) : undefined;
		const pin = info && this.pinOf(info.agent_id)?.id;
		const failure = run.failure;
		if (!info) {
			const pending = run.pending!;
			return {
				id: run.id, alias: '', name: pending.name, cli: pending.cli, displayName: this.displayName(pending.cli), command: pending.cli,
				location: pending.location.id, cwd: pending.location.path, environment: pending.location.environment, yolo: false,
				createdAt: pending.createdAt, lifecycle: failure ? 'ended' : 'starting', phase: pending.worktree ? 'creating_worktree' : 'launching_cli',
				activity: 'unknown', reporting: false, root: run.id, origin: 'human', tools: 'not_injected',
				...pending.sessionId ? { sessionId: pending.sessionId, resumed: true as const } : {},
				...failure ? { error: failure, end: { kind: 'failed' as const, at: failure.at } } : {}
			};
		}
		const facts: Mutable<RunFacts> = {
			id: run.id, alias: `#${info.agent_id}`, name: info.name, cli: info.cli, displayName: this.displayName(info.cli), command: info.cli,
			location: info.location_id, cwd: info.cwd, environment: this.environmentOf(info.location_id), yolo: info.yolo,
			createdAt: Date.parse(info.created_at), lifecycle: 'running', phase: 'running', activity: 'unknown', reporting: false,
			root: this.byAgent.get(info.root) ?? info.root, origin: info.creator ? 'agent' : 'human', tools: info.tools_state
		};
		if (info.pid !== undefined) { facts.pid = info.pid; }
		if (info.creator) { facts.creator = this.byAgent.get(info.creator) ?? info.creator; }
		if (info.session) { facts.sessionId = info.session; facts.resumable = true; facts.pinnable = true; }
		if (info.tools_reason) { facts.toolsReason = info.tools_reason; }
		if (info.tools_reason === 'disconnected') { facts.toolsProblem = 'disconnected'; }
		if (info.said) {
			facts.said = displayLine(info.said.text, MOST_LINE);
			const source = saidSourceOf(info.said.from, info.said.from_name);
			if (source) { facts.saidSource = source; }
		}
		if (run.resumed) { facts.resumed = true; }
		if (run.tab) { facts.tab = run.tab; }
		if (run.title) { facts.title = run.title; facts.titleSource = 'conversation'; }
		if (pin) { facts.pin = pin; }
		const detail = info.state_detail;
		if (failure) {
			facts.lifecycle = 'ended';
			facts.error = failure;
			facts.end = { kind: 'failed', at: failure.at };
		} else if (run.resuming) {
			facts.lifecycle = 'starting';
			facts.phase = 'launching_cli';
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
		// The same error object while it lasts, so a refresh says `reported` rather than `lifecycle`
		if (facts.error && run.facts?.error && JSON.stringify({ ...facts.error, at: 0 }) === JSON.stringify({ ...run.facts.error, at: 0 })) {
			facts.error = run.facts.error;
		}
		return facts;
	}

	private displayName(cli: string): string {
		return this.deps.clis().find(each => each.cli === cli)?.display_name ?? cli;
	}

	/** A location's environment: `local` or the window's remote authority, the same for every location of the window. */
	private environmentOf(location: LocationId): string {
		return (this.deps.locations.resolve(location) ?? this.deps.locations.snapshot().locations[0])?.environment ?? 'local';
	}

	private locationFor(id: LocationId | undefined, cwd: string): Location | undefined {
		const known = id ? this.deps.locations.resolve(id) : undefined;
		if (known && known.path === cwd) {
			return known;
		}
		return this.deps.locations.snapshot().locations.find(each => each.path === cwd) ?? this.deps.locations.conversationLocation?.(cwd);
	}

	/** Reads `run`'s conversation's title from its CLI's own history (CLIS-2.4); a read that fails is said in the log, never shown. */
	private async readTitle(run: Run): Promise<void> {
		const facts = run.facts;
		if (!facts.sessionId || facts.lifecycle === 'ended') {
			return;
		}
		const key = { environment: facts.environment, cli: facts.cli, sessionId: facts.sessionId };
		try {
			const title = await this.deps.titles.title(key, facts.cwd, this.deps.titles.storeOf?.(facts.cli, facts.cwd));
			if (title && title !== run.title && run.facts.sessionId === key.sessionId && this.runs.get(run.id) === run) {
				run.title = title;
				this.refresh(run, 'reported');
			}
		} catch (err) {
			this.deps.log.event(`Could not read the title of ${facts.alias}'s conversation: ${messageOf(err)}`);
		}
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// The person's inbox

	/** A message an agent of this window sent the person: told once, as the old engine tells one (COLLABORATION-2.3). */
	private message(message: Message): void {
		if (this.told.has(message.message_id) || message.to !== 'human') {
			return;
		}
		const record = this.recordOf(message);
		this.told.set(message.message_id, record);
		this.deps.contact.contact(record, id => this.told.get(id));
	}

	private recordOf(message: Message): MessageRecord {
		const from = message.from === 'facade' ? { run: 'facade' as const }
			: { run: this.byAgent.get(message.from) ?? message.from, alias: `#${message.from}`, ...message.from_name ? { name: message.from_name } : {} };
		const environment = this.deps.locations.snapshot().locations[0]?.environment ?? 'local';
		const delivery = message.delivery;
		return {
			id: message.message_id, alias: `#${message.message_id}`, kind: message.from === 'facade' ? 'result' : 'message', from, to: { run: '@human' },
			window: this.deps.link.windowId, environment, at: Date.parse(message.at) || Date.now(), text: message.text, length: [...message.text].length,
			...message.reply_to ? { replyTo: message.reply_to } : {},
			delivery: {
				status: delivery.status, ...delivery.reason ? { reason: delivery.reason } : {}, attempts: 1, via: 'notification',
				effects: { outcome: delivery.status === 'success' ? 'confirmed' : 'none', text_written: delivery.text_written },
				...delivery.delivered_at ? { deliveredAt: Date.parse(delivery.delivered_at) } : {}
			}
		};
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

/** A v1 refusal known to have left the CLI unstarted. A missing answer carries its original reason. */
function launchRefused(err: unknown): boolean {
	return err instanceof DaemonError && err.reason !== 'internal' && !(
		err.message.includes('the call may or may not have run') || err.message.includes('the outcome is unknown')
		|| err.message.startsWith('could not keep ') || err.message.includes(': its actor stopped')
	);
}

/** v1 uses `unavailable` for both refusals and unconfirmed stops. Only explicit refusals establish failure. */
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

function resumeElsewhere(agent: string, err: unknown): boolean {
	return err instanceof DaemonError && err.reason === 'unavailable' && err.message === `agent #${agent} is running or already resuming`;
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
