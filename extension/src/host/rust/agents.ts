/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This window's agents on the Rust engine: core keeps them, and the window shows its own - the `agents` topic's records whose
// `window_id` is this window's - as the panel's cards, through the same `Agents` the old engine gives the UI (ARCHITECTURE-1.3).

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { messageOf } from '../../base/errors';
import { displayLine } from '../../base/text';
import type { AgentInfo, AgentsChange, CliInfo, Message, MessagesChange, MessagesSnapshot, ResumeArgs, StartArgs, StartResult } from '../../base/coreProtocol';
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
	/** A start this window asked for, until its card goes. */
	pending?: Pending;
	/** A start or resume core refused, or a Pin that cannot start here: red until End Agent (UX-2.4). */
	failure?: RunError;
	/** A resume asked and not answered yet. */
	resuming?: boolean;
	/** It continues a session - Recent's, a Pin's, or its own resumed - rather than beginning one (PANEL-1.4). */
	resumed?: boolean;
	/** The Pin it holds before its CLI named a session, which the Pin takes once it does (LIFECYCLE-3.4). */
	pin?: string;
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
 * `Agents` on core (freeze-extension 0): a start, a resume, End Agent and a rename are core's operations; the cards are core's records
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
	/** Every agent the `agents` topic lists, of any window: a session running elsewhere is held there (LIFECYCLE-3.2). */
	private readonly all = new Map<string, AgentInfo>();
	/** Agents of this window this window removes or saw go: their card is gone, whatever the topic says until `removed`. */
	private readonly gone = new Set<string>();
	/** Messages to the person already told (COLLABORATION-2.3). */
	private readonly told = new Map<string, MessageRecord>();
	private readonly subscriptions: Disposable[] = [];
	private pinsRestored = false;
	private disposed = false;

	constructor(private readonly deps: RustAgentsDeps) {
		const { link, terminals } = deps;
		let first!: () => void;
		this.ready = new Promise(resolve => first = resolve);
		let snapshots = 0;
		this.subscriptions.push(
			link.watch<AgentInfo[], AgentsChange>('agents', {}, {
				snapshot: agents => {
					this.snapshot(agents);
					if (snapshots++ === 0) {
						void this.openPinnedTabs([...this.runs.values()].filter(run => run.facts.pin).map(run => run.id)).finally(first);
					}
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

	pins(): readonly Pin[] {
		return this.deps.pins.list();
	}

	reorderPins(ids: readonly string[]): void {
		this.deps.pins.reorder(ids);
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
		readonly worktree?: StartArgs['worktree']; readonly model?: string; readonly effort?: string; readonly session?: string; readonly pin?: string;
	}): RunId {
		const id = this.deps.newRunId();
		// A blank name is filled in at once, as the old engine fills it, and core starts the agent under it (LIFECYCLE-2.1)
		const name = options.name || suggestName(this.list().map(run => run.name), this.deps.names?.()) || '';
		let settle!: (outcome: StartOutcome) => void;
		const pending: Pending = { name, cli: options.cli, location: options.location, createdAt: Date.now(), worktree: !!options.worktree,
			...options.session !== undefined ? { sessionId: options.session } : {}, settled: new Promise(resolve => settle = resolve) };
		const run: Run = { id, pending, ...options.pin ? { pin: options.pin } : {}, ...options.session ? { resumed: true } : {}, facts: undefined! };
		run.facts = this.factsOf(run);
		this.runs.set(id, run);
		// A restored Pin's tab opens in its turn (LIFECYCLE-3.4)
		this.deps.terminals.openPair(pairOf(run.facts), options.pin ? { reveal: false, hidden: true } : { reveal: options.reveal });
		if (options.pin) { this.deps.terminals.pinTab?.(id, true); }
		this.emit({ run: id, kind: 'added' });
		const args: StartArgs = {
			command: [options.cli], cwd: options.cwd ?? options.location.path, window_id: this.deps.link.windowId,
			env: this.deps.environment(options.location), cols: COLS, rows: ROWS, request_id: id,
			...name ? { name } : {},
			...options.worktree ? { worktree: options.worktree } : {},
			...options.model !== undefined ? { model: options.model } : {},
			...options.effort !== undefined ? { effort: options.effort } : {},
			...options.session !== undefined ? { session: options.session } : {}
		};
		this.deps.log.event(`Asked core to start ${options.cli} in ${args.cwd} [${id}]`);
		this.deps.link.call<StartResult>('agent.start', args).then(result => {
			const agent = result.agent.agent_id;
			if (this.runs.get(id) !== run) {
				// End Agent came first: the agent goes as it would have then
				this.deps.log.event(`Removing #${agent}: its card was closed before it started`);
				void this.remove(agent, result.agent);
				return settle({ state: 'closed' });
			}
			run.agent = agent;
			run.pending = undefined;
			this.byAgent.set(agent, id);
			this.all.set(agent, this.all.get(agent) ?? result.agent);
			this.deps.terminals.bind(id, agent);
			if (run.tab) { this.deps.places?.set(agent, run.tab); }
			if (!options.pin) { this.deps.history.remember(options.location.id, options.cli); }
			this.deps.log.event(`Started #${agent} (${options.cli}) [${id}]`);
			this.refresh(run);
			settle({ state: 'running' });
		}, (err: unknown) => {
			if (this.runs.get(id) !== run) {
				return settle({ state: 'closed' });
			}
			const reason = this.fail(run, err, options.pin ? undefined : labelOf({ name, alias: options.cli }));
			settle({ state: 'failed', error: reason });
		}).finally(() => this.adopt());
		return id;
	}

	/** Makes `run` red with why its start or resume was refused, said in its terminal and, where `told`, to the person (UX-2.4, RULES-1.8). */
	private fail(run: Run, err: unknown, told: string | undefined): string {
		const daemon = err instanceof DaemonError ? err : undefined;
		const english = messageOf(err);
		const reason = daemon ? this.deps.describe(daemon) : english;
		const kept = daemon?.data.kept;
		const worktree = kept && (kept.branch || kept.path) ? { ...kept.branch ? { branch: kept.branch } : {}, ...kept.path ? { folder: kept.path } : {} } : undefined;
		run.failure = { reason, ...reason !== english ? { english } : {}, source: daemon?.reason === 'worktree_failed' ? 'worktree' : 'launch', at: Date.now(), ...worktree ? { worktree } : {} };
		this.refresh(run);
		this.deps.terminals.note(run.id, reason);
		this.deps.log.event(`Core refused the start of ${run.facts.alias || run.id}: ${english}`);
		if (told !== undefined) {
			const settingsFile = !!daemon && (!!daemon.data.entry || daemon.reason === 'configuration_invalid');
			this.deps.human.failed({ kind: 'start', name: told, reason, ...worktree ? { worktree } : {} }, { show: run.id, ...settingsFile ? { settingsFile } : {} });
		}
		return english;
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
		// Its agent of this window ended, its card still here: resumed as that agent, the same #aN (RULES-2.2)
		const ended = [...this.runs.values()].find(run => run.agent && run.facts.lifecycle === 'ended' && !run.resuming
			&& run.facts.sessionId === entry.key.sessionId && run.facts.cli === entry.key.cli);
		if (ended) {
			this.resumeAgent(ended);
			if (options.reveal) { void this.deps.terminals.reveal(ended.id, { preserveFocus: false }); }
			return ended.id;
		}
		const meta = this.deps.conversations.get(entry.key);
		if (entry.cwdChoices?.length && !meta?.cwd) {
			throw invalid('invalid_argument', 'Choose a working location before resuming this conversation.');
		}
		const cwd = meta?.cwd ?? entry.cwd;
		const location = this.locationFor(meta?.location, cwd);
		if (!location) {
			throw new FacadeError('INVALID', 'not_found', `The conversation's working location ${cwd} is not available in this window.`, { kind: 'location_not_here', values: [cwd] });
		}
		return this.start({ name: meta?.name.trim() ?? '', cli: entry.key.cli, location, cwd, reveal: options.reveal, session: entry.key.sessionId,
			...this.pinOf(entry.key) ? { pin: this.pinOf(entry.key)!.id } : {} });
	}

	/** `agent.resume` of an ended agent of this window: its card starting again, a refusal leaving it ended and said (UX-2.4). */
	private resumeAgent(run: Run): void {
		const location = this.deps.locations.resolve(run.facts.location);
		run.resuming = true;
		run.resumed = true;
		run.failure = undefined;
		this.refresh(run);
		const args: ResumeArgs = { agent: run.agent!, env: location ? this.deps.environment(location) : {}, cols: COLS, rows: ROWS, window_id: this.deps.link.windowId };
		this.deps.link.call<AgentInfo>('agent.resume', args).then(info => {
			run.resuming = false;
			this.all.set(info.agent_id, info);
			this.refresh(run);
		}, (err: unknown) => {
			run.resuming = false;
			if (this.runs.get(run.id) === run) { this.fail(run, err, labelOf(run.facts)); }
		});
	}

	holding(key: ConversationKey): RunId | 'elsewhere' | undefined {
		for (const run of this.runs.values()) {
			if (run.facts.lifecycle !== 'ended' && run.facts.sessionId === key.sessionId && run.facts.cli === key.cli) {
				return run.id;
			}
		}
		for (const info of this.all.values()) {
			if (info.process === 'running' && info.session === key.sessionId && info.cli === key.cli && info.window_id !== this.deps.link.windowId) {
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
	// End Agent and Rename

	async close(id: RunId): Promise<CleanupResult | 'already_ended' | 'not_started'> {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const pin = run.facts.pin;
		if (pin) { this.deps.pins.remove(pin); }
		const ended = run.facts.lifecycle === 'ended';
		this.drop(run, 'close');
		// A start not answered yet is removed once its answer comes; a failed one has no agent in core
		if (!run.agent) {
			return ended ? 'already_ended' : 'terminated';
		}
		const info = this.all.get(run.agent);
		const removed = await this.remove(run.agent, info);
		this.deps.log.event(`Ended #${run.agent}: ${removed ? 'removed' : 'not removed'}`);
		return !removed ? 'failed' : ended ? 'already_ended' : 'terminated';
	}

	/**
	 * Records the agent's conversation and name for Recent, then `agent.remove`: core keeps no record or screen log of it (0.1, RULES-3.3).
	 * Whether core removed it.
	 */
	private async remove(agent: string, info: AgentInfo | undefined): Promise<boolean> {
		this.gone.add(agent);
		if (info?.session) {
			const location = this.deps.locations.resolve(info.location_id);
			try {
				this.deps.conversations.put({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session },
					{ ...location ? { location: location.id } : {}, cwd: info.cwd, name: keptName({ name: info.name, alias: `#${agent}` }) });
			} catch (err) {
				this.deps.log.event(`Could not keep #${agent}'s conversation for Recent: ${messageOf(err)}`);
			}
		}
		try {
			await this.deps.link.call('agent.remove', { agent });
			return true;
		} catch (err) {
			this.deps.log.event(`Could not remove #${agent} from core: ${messageOf(err)}`);
			return false;
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
	// Pins (LIFECYCLE-3.4)

	pin(id: RunId): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (!run.facts.pinnable || !run.facts.sessionId) {
			throw new FacadeError('INVALID', 'unsupported', `${run.facts.name}'s CLI has not named its conversation, so it cannot be pinned.`, { kind: 'pin_unsupported', values: [] });
		}
		if (run.facts.pin) {
			return;
		}
		const pin: Pin = {
			id: `pin-${randomBytes(16).toString('hex')}`, conversation: { environment: run.facts.environment, cli: run.facts.cli, sessionId: run.facts.sessionId },
			location: run.facts.location, cwd: run.facts.cwd, name: keptName(run.facts)
		};
		this.deps.pins.save(pin);
		run.pin = pin.id;
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
			run.pin = undefined;
			this.refresh(run, 'lifecycle');
			this.deps.terminals.pinTab?.(id, false);
		}
	}

	/** Starts each Pin no running agent holds, continuing its session, its tab opening in the Pins' order (LIFECYCLE-3.4). */
	async restorePins(): Promise<void> {
		if (this.pinsRestored || this.disposed) { return; }
		this.pinsRestored = true;
		await this.ready;
		const failed: { readonly name: string; readonly reason: string }[] = [];
		const restored: RunId[] = [];
		for (const pin of this.pins()) {
			const { sessionId, cli } = pin.conversation;
			if ([...this.runs.values()].some(run => run.facts.pin === pin.id) || (sessionId && this.holding({ ...pin.conversation, sessionId }))) {
				continue;
			}
			const location = this.locationFor(pin.location, pin.cwd);
			if (!location) {
				failed.push({ name: pin.name || cli, reason: this.unrestorable(pin) });
				continue;
			}
			restored.push(this.start({ name: pin.name, cli, location, cwd: pin.cwd, reveal: false, pin: pin.id, ...sessionId ? { session: sessionId } : {} }));
		}
		await Promise.all(restored.map(id => this.started(id)));
		for (const id of restored) {
			const run = this.runs.get(id);
			if (run?.failure) { failed.push({ name: labelOf(run.facts), reason: run.failure.reason }); }
		}
		await this.openPinnedTabs(restored.filter(id => this.runs.get(id)?.facts.lifecycle === 'running'));
		if (failed.length) {
			// One notification for this opening (RULES-1.8)
			this.deps.human.failed({ kind: 'restore', name: failed[0].name, reason: failed[0].reason, count: failed.length }, {});
		}
	}

	/** A Pin that cannot start here keeps a red card holding it, so End Agent can Unpin it (LIFECYCLE-3.4); why, in the person's words. */
	private unrestorable(pin: Pin): string {
		const english = `The working location ${pin.cwd} is not available in this window.`;
		const id = this.deps.newRunId();
		const location = { id: pin.location, path: pin.cwd, environment: pin.conversation.environment } as Location;
		const reason = vscode.l10n.t("The working location {0} is not available in this window.", pin.cwd);
		const run: Run = { id, pin: pin.id, pending: { name: pin.name, cli: pin.conversation.cli, location, createdAt: Date.now(), worktree: false,
			...pin.conversation.sessionId ? { sessionId: pin.conversation.sessionId } : {}, settled: Promise.resolve({ state: 'failed', error: english }) },
			failure: { reason, ...reason !== english ? { english } : {}, source: 'location', at: Date.now() }, facts: undefined! };
		run.facts = this.factsOf(run);
		this.runs.set(id, run);
		this.deps.terminals.openPair(pairOf(run.facts), { reveal: false, hidden: true });
		this.deps.terminals.note(id, reason);
		this.emit({ run: id, kind: 'added' });
		return reason;
	}

	/** Opens pinned agents' tabs one at a time, in the Pins' order, then lets the panel select the last (LIFECYCLE-3.5, PANEL-2.1). */
	private async openPinnedTabs(ids: readonly RunId[]): Promise<void> {
		const order = this.pins().map(pin => pin.id);
		const sorted = [...ids].sort((a, b) => order.indexOf(this.runs.get(a)?.facts.pin ?? '') - order.indexOf(this.runs.get(b)?.facts.pin ?? ''));
		for (const id of sorted) {
			await this.deps.terminals.openPinned?.(id).catch(err => this.deps.log.event(`Could not open ${id}'s pinned tab: ${messageOf(err)}`));
		}
		if (sorted.length) { this.deps.terminals.pinnedOpened?.(); }
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

	private pinOf(key: ConversationKey): Pin | undefined {
		return this.pins().find(pin => pin.conversation.sessionId === key.sessionId && pin.conversation.cli === key.cli);
	}

	// -----------------------------------------------------------------------------------------------------------------------------
	// The `agents` topic

	private snapshot(agents: readonly AgentInfo[]): void {
		const listed = new Set(agents.map(each => each.agent_id));
		for (const id of [...this.all.keys()]) {
			if (!listed.has(id)) { this.removed(id); }
		}
		for (const info of agents) {
			this.updated(info);
		}
	}

	private updated(info: AgentInfo): void {
		if (this.disposed) { return; }
		const before = this.all.get(info.agent_id);
		this.all.set(info.agent_id, info);
		const id = this.byAgent.get(info.agent_id);
		const run = id !== undefined ? this.runs.get(id) : undefined;
		if (run && info.window_id !== this.deps.link.windowId) {
			// Taken over by another window
			this.drop(run, 'transfer');
			return;
		}
		if (!run) {
			if (info.window_id === this.deps.link.windowId) { this.adopt(); }
			return;
		}
		const turnEnded = before?.state === 'working' && (info.state === 'idle' || info.state === 'just_done');
		const sessionChanged = before?.session !== info.session;
		this.refresh(run);
		if (sessionChanged || turnEnded) { void this.readTitle(run); }
	}

	private removed(agent: string): void {
		this.all.delete(agent);
		this.gone.delete(agent);
		const id = this.byAgent.get(agent);
		const run = id !== undefined ? this.runs.get(id) : undefined;
		if (run) { this.drop(run, 'close'); }
	}

	/**
	 * Shows this window's agents that have no card yet: one another agent started opens its card alone, its tab hidden (LIFECYCLE-2.2).
	 * While a start of this window waits for its answer, an agent the person started waits too: it is that start's.
	 */
	private adopt(): void {
		const waiting = [...this.runs.values()].some(run => run.pending && !run.failure);
		for (const info of this.all.values()) {
			if (info.window_id !== this.deps.link.windowId || this.byAgent.has(info.agent_id) || this.gone.has(info.agent_id) || (waiting && !info.creator)) {
				continue;
			}
			if (this.cleanExit(info)) {
				// Ended with code 0, or stopped by Facade, before this window had it - a closed window's grace over, or taken over ended:
				// recorded and removed, its Pin kept for restorePins to start again (0.1, RULES-4.1, LIFECYCLE-3.5)
				void this.remove(info.agent_id, info);
				continue;
			}
			const id = info.agent_id;
			const pin = this.pinOf({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session ?? '' });
			const tab = this.deps.places?.get(id);
			const run: Run = { id, agent: id, facts: undefined!, ...pin && info.session ? { pin: pin.id } : {}, ...tab ? { tab } : {} };
			run.facts = this.factsOf(run);
			this.runs.set(id, run);
			this.byAgent.set(id, id);
			this.deps.terminals.openPair(pairOf(run.facts), { reveal: false, hidden: true });
			this.deps.terminals.bind(id, id);
			if (run.facts.lifecycle === 'ended') { this.deps.terminals.exited(id, this.endText(run.facts)); }
			this.emit({ run: id, kind: 'added' });
			void this.readTitle(run);
		}
	}

	/** Its card and tab go: End Agent, a clean exit, its removal from core, or another window taking it (UX-2.2). */
	private drop(run: Run, cause: NonNullable<RunChange['cause']>): void {
		if (this.runs.get(run.id) !== run) { return; }
		this.runs.delete(run.id);
		if (run.agent) {
			this.byAgent.delete(run.agent);
			if (cause !== 'transfer') { this.gone.add(run.agent); this.deps.places?.set(run.agent, undefined); }
		}
		this.deps.terminals.removePair(run.id);
		this.emit({ run: run.id, kind: 'removed', cause });
	}

	/** Recomputes `run`'s facts from its record, and tells what changed. */
	private refresh(run: Run, kind?: RunChange['kind']): void {
		const before = run.facts;
		const after = this.factsOf(run);
		run.facts = after;
		if (this.runs.get(run.id) !== run) { return; }
		if (before.name !== after.name) {
			this.deps.terminals.rename(run.id, after.name);
			const pin = after.pin ? this.pins().find(each => each.id === after.pin) : undefined;
			if (pin) { this.deps.pins.save({ ...pin, name: keptName(after) }); }
		}
		// Its CLI named its session: a Pin it held before takes it (LIFECYCLE-3.4)
		if (run.pin && after.sessionId) {
			const pin = this.pins().find(each => each.id === run.pin);
			if (pin && pin.conversation.sessionId !== after.sessionId) {
				this.deps.pins.save({ ...pin, cwd: after.cwd, conversation: { ...pin.conversation, sessionId: after.sessionId } });
			}
		}
		if (before.lifecycle !== 'ended' && after.lifecycle === 'ended' && !run.failure) {
			const info = run.agent ? this.all.get(run.agent) : undefined;
			if (info && this.cleanExit(info)) {
				// Seen ending here, it is ended as End Agent ends it: its conversation recorded, its Pin and card gone (0.1, RULES-3.3)
				if (after.pin) { this.deps.pins.remove(after.pin); }
				this.drop(run, 'exit');
				void this.remove(info.agent_id, info);
				return;
			}
			this.deps.terminals.exited(run.id, this.endText(after));
		}
		this.emit({ run: run.id, kind: kind ?? (before.name !== after.name ? 'renamed'
			: before.lifecycle !== after.lifecycle || before.error !== after.error || before.pin !== after.pin ? 'lifecycle' : 'reported') });
	}

	/**
	 * Whether an ended agent goes as End Agent ends it, no card left (0.1, RULES-3.3, 4.1): its CLI exited with code 0, or Facade stopped
	 * it - its window's grace over, `stop_agent`, its location gone. Any other end keeps its red card until End Agent.
	 */
	private cleanExit(info: AgentInfo): boolean {
		return info.process === 'ended' && ((info.exit?.code === 0 && !info.exit.signal) || this.stopped(info));
	}

	private stopped(info: AgentInfo): boolean {
		return info.state_detail?.how === 'stopped';
	}

	/** What an ended agent's terminal says, in the card's words. */
	private endText(facts: RunFacts): string {
		const end = facts.end;
		return end?.signal ? vscode.l10n.t("Process terminated · {0}", end.signal)
			: end?.code !== undefined ? vscode.l10n.t("Process exited · code {0}", String(end.code)) : vscode.l10n.t("Process lost · reason unknown");
	}

	/** `RunFacts` from core's record (freeze-extension 0.2), or from a start not answered yet. */
	private factsOf(run: Run): RunFacts {
		const info = run.agent ? this.all.get(run.agent) : undefined;
		const pin = run.pin ?? (info?.session ? this.pinOf({ environment: this.environmentOf(info.location_id), cli: info.cli, sessionId: info.session })?.id : undefined);
		const failure = run.failure;
		if (!info) {
			const pending = run.pending!;
			return {
				id: run.id, alias: '', name: pending.name, cli: pending.cli, displayName: this.displayName(pending.cli), command: pending.cli,
				location: pending.location.id, cwd: pending.location.path, environment: pending.location.environment, yolo: false,
				createdAt: pending.createdAt, lifecycle: failure ? 'ended' : 'starting', phase: pending.worktree ? 'creating_worktree' : 'launching_cli',
				activity: 'unknown', reporting: false, root: run.id, origin: 'human', tools: 'not_injected',
				...pending.sessionId ? { sessionId: pending.sessionId, resumed: true as const } : {},
				...failure ? { error: failure, end: { kind: 'failed' as const, at: failure.at } } : {},
				...pin ? { pin } : {}
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
		if (run.resuming) {
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
		if (failure) {
			facts.lifecycle = 'ended';
			facts.error = failure;
			facts.end ??= { kind: 'failed', at: failure.at };
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
