/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout, untilAnswered } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { displayLine } from '../base/text';
import { FacadeError, invalid, OWNERSHIP_LOST } from './errors';
import { worktreeCreationEffects } from './locations/problems';
import { labelOf, normalizeName, suggestName } from './names';
import { REQUEST_MS } from './requests';
import { dotOf } from './status';
import {
	ConversationEntry, ConversationKey, ConversationStore, Pin, PinStore, conversationId, LocationId,
	ActivityReport, Agents, AliasPort, CleanupResult, Clock, Disposable, Event, ExecutionPort, ExitReport, HumanPort, LaunchHistoryPort,
	FacadeReason, LaunchPlan, LaunchPlanner, LaunchRequest, LiveRun, Location, LocationPort, LocationRemoval, LogPort, McpServerLaunch, PairFacts, PlanError,
	RetainedStore, RunChange, RunFacts, RunId, RunMeta, StartOutcome, WindowLifetimePort, WorktreeCreationEffects, WorktreeError, WorktreePort
} from './ports';

export interface AgentServiceDeps {
	readonly execution: ExecutionPort;
	readonly conversations?: ConversationStore;
	readonly pinStore?: PinStore;
	readonly newPinId?: () => string;
	readonly planner: LaunchPlanner;
	readonly locations: LocationPort;
	readonly worktrees: WorktreePort;
	readonly history: LaunchHistoryPort;
	readonly human: HumanPort;
	readonly retained: RetainedStore;
	readonly aliases: AliasPort;
	readonly clock: Clock;
	readonly log: LogPort;
	readonly lifetime: WindowLifetimePort;
	/** The destination's current `facade.yolo`, read when each launch is accepted (RULES-4.3). */
	readonly yolo: () => boolean;
	/** The run's MCP shim where `facade.collaboration.enabled` is on when its launch is planned; none injects nothing (RULES-4.4). */
	readonly tools?: (run: RunId, facts: RunFacts, location: Location) => McpServerLaunch | undefined;
	/** A failure in the person's language (UX-2.4): Facade's own reasons translated, any other its `english` as it is. */
	readonly describe?: (err: unknown, english: string) => string;
	/**
	 * Types what a run's start needs before its first turn into its CLI, ahead of any other automated input (COLLABORATION-2.2), and
	 * settles once that is done or given up; none, and nothing is typed.
	 */
	readonly warmUp?: (run: RunId, warmUp: NonNullable<LaunchPlan['warmUp']>) => Promise<void>;
	readonly newRunId: () => RunId;
	/** Waits `ms` before a listing that failed is asked again; the service's own timer where none is given. */
	readonly wait?: (ms: number) => Promise<void>;
}

interface Run {
	exactResume?: boolean;
	facts: RunFacts;
	/** Known startup creation effects, retained if later CLI planning or spawning fails. */
	worktree?: WorktreeCreationEffects;
	/** Settles once its process started, its launch failed or it was closed first (MCP-2.3). */
	settled: Promise<void>;
	/** Whether its process was asked for and the answer is not in yet: a close then cannot say none started (WORKTREES-3.2). */
	spawning?: boolean;
	/** How its creation prompt goes in, once planned. */
	prompt?: LaunchPlan['prompt'];
	/** Settles once what its start types before its first turn is done or given up (COLLABORATION-2.2). */
	warm?: Promise<void>;
	/**
	 * Whether its creation prompt goes after its start and is neither delivered nor given up yet: its input is held for it, its
	 * preparation included, and a message sent meanwhile goes after it (RULES-1.10, COLLABORATION-2.2).
	 */
	creationPending?: boolean;
	/** Whether its grace ended it and the end is not confirmed: red, holding its conversation, never reattached (LIFECYCLE-3.5). */
	uncertain?: boolean;
	/** Whether its tab was told to spin: while its dot is green (LIFECYCLE-2.2). */
	spinning?: boolean;
}

interface StartOptions {
	readonly reveal?: boolean;
	readonly resume?: { readonly key: ConversationKey };
	readonly remember?: boolean;
	readonly pin?: string;
	readonly restoring?: boolean;
}

function keyOf(facts: RunFacts): ConversationKey | undefined {
	return facts.sessionId ? { environment: facts.environment, cli: facts.cli, sessionId: facts.sessionId } : undefined;
}
function sameConversation(a: ConversationKey, b: ConversationKey): boolean { return conversationId(a) === conversationId(b); }
/** The conversation a Pin restores, where its CLI named one (LIFECYCLE-3.4). */
function pinKey(pin: Pin): ConversationKey | undefined {
	const { sessionId } = pin.conversation;
	return sessionId ? { ...pin.conversation, sessionId } : undefined;
}
function pinsConversation(pin: Pin, key: ConversationKey): boolean {
	const pinned = pinKey(pin);
	return !!pinned && sameConversation(pinned, key);
}
/**
 * Whether a run can be pinned (LIFECYCLE-3.4): its conversation is known to be saved, or, not ended, its CLI names the conversation
 * it holds - also before it has one, where the Pin takes the one it names later (LIFECYCLE-3.4).
 */
function pinnableOf(facts: RunFacts, exactResume: boolean | undefined): boolean {
	return !!facts.resumable || (!!exactResume && facts.lifecycle !== 'ended');
}
const RESTORE_CONCURRENCY = 2;
/** The most a card's second line keeps of a message sent: far more than any card shows (PANEL-1.4). */
const MOST_LINE = 1024;
/** How long a failed listing of the running conversations waits before it is asked again, at first and at most. */
const CONVERSATIONS_RETRY_MS = 2_000;
const MOST_CONVERSATIONS_RETRY_MS = 30_000;
/**
 * A working location gone, or not in this window, as the person is told it: in their language, never by its ID (UX-2.4). The UI words
 * these; the English messages stay for agents and the log.
 */
const LOCATION_GONE: FacadeReason = { kind: 'location_gone', values: [] };
const locationNotHere = (path: string): FacadeReason => ({ kind: 'location_not_here', values: [path] });
/** How often a run whose grace end is not confirmed is looked for again, until its exit is heard (LIFECYCLE-3.5). */
const UNCERTAIN_CHECK_MS = 5_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The one launch service and run record for every origin (LIFECYCLE-4.1): an accepted launch creates its card and terminal at
 * once (LIFECYCLE-1.5), close removes them at once with cleanup in the background (LIFECYCLE-3.1), exits are classified
 * independently of who caused them (RULES-3.3), and confirmed location removal closes the affected agents (RULES-2.4).
 */
export class AgentService implements Agents, Disposable {
	private readonly runs = new Map<RunId, Run>();
	private readonly listeners = new Set<(change: RunChange) => void>();
	private readonly subscriptions: Disposable[] = [];
	private ownershipLost = false;
	private disposed = false;
	/** Whether runs whose grace end was not confirmed are being looked for again (LIFECYCLE-3.5). */
	private watchingUncertain = false;
	/** Aborted as the service is disposed: what waits on a timer stops waiting. */
	private readonly stopping = new AbortController();
	private readonly elsewhere = new Set<string>();
	private readonly restoring = new Set<RunId>();
	private pinsRestored = false;
	private get pinStore(): PinStore {
		if (!this.deps.pinStore) { throw new Error('Pin storage is unavailable.'); }
		return this.deps.pinStore;
	}
	pins(): readonly Pin[] { return this.deps.pinStore?.list() ?? []; }
	reorderPins(ids: readonly string[]): void { this.pinStore.reorder(ids); }
	async refreshConversations(): Promise<void> {
		if (!this.deps.execution.conversations) { return; }
		const keys = await this.deps.execution.conversations();
		this.elsewhere.clear();
		for (const key of keys) { this.elsewhere.add(conversationId(key)); }
	}
	/** Runs this window closed or saw end: a listing still holding one, its cleanup not done, never brings it back (LIFECYCLE-3.1). */
	private readonly released = new Set<RunId>();
	/** Why the last listing of this window's runs failed, said once until it changes. */
	private listingFailure: string | undefined;
	/** Whether an invalid retained record was said in the log already. */
	private ignoredRecord = false;

	readonly onDidChange: Event<RunChange> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	constructor(private readonly deps: AgentServiceDeps) {
		const { execution } = deps;
		this.subscriptions.push(
			execution.onDidReport(report => this.reported(report)),
			execution.onDidExit(exit => this.exited(exit)),
			deps.locations.onDidRemove(removal => this.locationsRemoved(removal)),
			deps.lifetime.onDidClose(() => { deps.log.fact?.('window_closed', {}); void execution.endWindow(); })
		);
		if (execution.onDidIdentify) {
			this.subscriptions.push(execution.onDidIdentify(({ run, sessionId, cwd }) => this.identified(run, sessionId, cwd)));
		}
		if (execution.onDidPinTab) {
			this.subscriptions.push(execution.onDidPinTab(({ run, pinned }) => this.tabPinned(run, pinned)));
		}
		if (execution.onDidSubmit) {
			this.subscriptions.push(execution.onDidSubmit(({ run, text }) => this.said(run, text)));
		}
		if (execution.onDidClosePair) {
			this.subscriptions.push(execution.onDidClosePair(({ run, marked }) => this.tabClosed(run, marked)));
		}
		if (execution.onDidRenameTab) {
			this.subscriptions.push(execution.onDidRenameTab(({ run, name }) => this.tabRenamed(run, name)));
		}
		if (execution.onDidConnectTools) {
			this.subscriptions.push(execution.onDidConnectTools(run => this.toolsConnected(run)));
		}
		if (execution.onDidDisconnectTools) {
			this.subscriptions.push(execution.onDidDisconnectTools(run => this.toolsDisconnected(run)));
		}
		if (execution.onDidLoseOwnership) {
			this.subscriptions.push(execution.onDidLoseOwnership(() => {
				this.ownershipLost = true;
				for (const id of [...this.runs.keys()]) {
					this.runs.delete(id);
					this.emit({ run: id, kind: 'removed', cause: 'transfer' });
				}
			}));
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stopping.abort();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.listeners.clear();
	}

	list(): readonly RunFacts[] {
		return [...this.runs.values()].map(run => run.facts);
	}

	owned(): boolean {
		return !this.ownershipLost;
	}

	get(run: RunId): RunFacts | undefined {
		return this.runs.get(run)?.facts;
	}

	requested(from: RunId, requestId: string): RunFacts | undefined {
		const cutoff = this.deps.clock.now() - REQUEST_MS;
		const kept = this.deps.retained.list().filter(record => isRetainedRun(record) || isRequestRun(record));
		for (const record of kept) {
			if (record.requestOnly && record.createdAt <= cutoff) {
				this.forgetRetained(record.id);
			}
		}
		return [...this.list(), ...kept].find(run => run.creator === from && run.requestId === requestId && run.createdAt > cutoff);
	}

	/** Keep the existing run metadata, not a second request ledger. Closed pairs are never restored by this record. */
	private rememberRequest(facts: RunFacts, required = false): boolean {
		if (facts.requestId !== undefined && facts.createdAt > this.deps.clock.now() - REQUEST_MS) {
			try {
				this.deps.retained.put({ ...facts, requestOnly: true });
				return true;
			} catch (err) {
				if (required) {
					throw err;
				}
				this.deps.log.event(`Could not update the request-bearing metadata of ${facts.alias}: ${messageOf(err)}`);
			}
		}
		return false;
	}

	/**
	 * Removes a retained record. One the store cannot remove now - a lock not let go, a file the system holds - stays for a later try,
	 * said in the log: cleanup never holds up showing this window's agents or answering an operation (RULES-4.1).
	 */
	private forgetRetained(id: RunId): void {
		try {
			this.deps.retained.remove(id);
		} catch (err) {
			this.deps.log.event(`Could not remove the kept record of ${id}: ${messageOf(err)}`);
		}
	}

	/**
	 * Finds this window's runs again after a reload, and the failed launches it retained (LIFECYCLE-3.5, 1.5). Answers how many live
	 * runs the execution owner reports as held elsewhere, or undefined where they could not be listed - its supervisor not answering
	 * yet - for the caller to try again: a temporary failure loses no agent (LIFECYCLE-3.5). Actual process records take precedence
	 * over a retained failed-start observation. Ownership is acquired before any retained pair is shown.
	 */
	async restore(): Promise<number | undefined> {
		if (this.ownershipLost) {
			return 0;
		}
		let live: readonly LiveRun[];
		try {
			live = await this.deps.execution.live();
		} catch (err) {
			const failure = messageOf(err);
			if (failure !== this.listingFailure) {
				this.listingFailure = failure;
				this.deps.log.event(`Could not list the agents still running for this window, trying again: ${failure}`);
			}
			return this.ownershipLost ? 0 : undefined;
		}
		if (this.listingFailure !== undefined) {
			this.listingFailure = undefined;
			this.deps.log.event('Listed the agents still running for this window.');
		}
		if (this.ownershipLost) {
			return 0;
		}
		this.unpinRemoved();
		const liveIds = new Set(live.map(run => run.run));
		for (const kept of this.deps.retained.list()) {
			if (isRequestRun(kept)) {
				if (kept.createdAt <= this.deps.clock.now() - REQUEST_MS) {
					this.forgetRetained(kept.id);
				}
				continue;
			}
			if (!isRetainedRun(kept)) {
				// Said once a window, not at each restore (ARCHITECTURE-4.2)
				if (!this.ignoredRecord) {
					this.ignoredRecord = true;
					this.deps.log.event('Ignored an invalid retained agent record.');
				}
				continue;
			}
			const facts = retainedFacts(kept);
			// Its location removed while no window showed it: closed as the removal would have closed it (RULES-2.4)
			if (liveIds.has(facts.id) || this.deps.locations.removalOf(facts.location)) {
				this.forgetRetained(facts.id);
				continue;
			}
			if (!this.runs.has(facts.id) && !this.released.has(facts.id)) {
				const pin = facts.pin && this.pins().find(pin => pin.id === facts.pin);
				const { pin: _previousPin, ...rest } = facts;
				this.runs.set(facts.id, { facts: { ...rest, ...pin ? { pin: pin.id } : {} }, exactResume: facts.resumable, settled: Promise.resolve() });
				this.deps.execution.openPair(pairOf(facts), { reveal: false });
				if (facts.error) {
					this.deps.execution.note(facts.id, facts.error.reason);
				}
				this.emit({ run: facts.id, kind: 'added' });
			}
		}
		let elsewhere = 0;
		for (const each of live) {
			if (this.ownershipLost) {
				return 0;
			}
			if (this.runs.has(each.run) || this.released.has(each.run)) {
				continue;
			}
			if (each.claimedElsewhere) {
				elsewhere++;
				continue;
			}
			if (each.uncertain) {
				this.showUncertain(each);
				continue;
			}
			const facts: RunFacts = {
				...factsOf(each.run, each.meta),
				...this.restoredPin(each.meta) ? { pin: this.restoredPin(each.meta)!.id } : {},
				...each.meta.exactResume || each.meta.resumable ? { pinnable: true } : {},
				lifecycle: 'running',
				phase: 'running',
				pid: each.pid,
				startedAt: each.startedAt
			};
			const run: Run = { facts, exactResume: each.meta.exactResume, settled: Promise.resolve() };
			this.runs.set(each.run, run);
			try {
				await this.deps.execution.attach(each, pairOf(facts));
			} catch (err) {
				if (this.runs.get(each.run) === run) {
					this.runs.delete(each.run);
				}
				this.deps.log.event(`Could not reattach ${facts.alias}: ${messageOf(err)}`);
				continue;
			}
			if (this.runs.get(each.run) !== run) {
				// Ended normally or closed as it was reattached: already removed, never announced afterwards (RULES-3.3)
				continue;
			}
			this.emit({ run: each.run, kind: 'added' });
			if (this.deps.locations.removalOf(facts.location)) {
				// Its location went while the host restarted: removal closes it, as it would have (RULES-2.4)
				void this.close(each.run).catch(() => undefined);
			} else if (each.exited) {
				this.exited({ run: each.run, ...each.exited });
			}
		}
		this.settlePins();
		this.watchUncertain();
		return elsewhere;
	}

	/**
	 * A run its grace ended without that end confirmed (LIFECYCLE-3.5): a red card that says so, holding its conversation and Pin -
	 * its Pin is not restored beside it - and never reattached. Close Agent ends it again.
	 */
	private showUncertain(each: LiveRun): void {
		const english = 'Could not confirm that it stopped';
		const reason = this.deps.describe?.(new FacadeError('FAILED', 'termination_unconfirmed', english, { kind: 'end_unconfirmed', values: [] }), english) ?? english;
		const pin = this.restoredPin(each.meta);
		const facts: RunFacts = {
			...factsOf(each.run, each.meta),
			...pin ? { pin: pin.id } : {},
			...each.meta.exactResume || each.meta.resumable ? { pinnable: true } : {},
			lifecycle: 'running',
			phase: 'running',
			pid: each.pid,
			startedAt: each.startedAt,
			error: { reason, ...reason !== english ? { english } : {}, source: 'cleanup', at: this.deps.clock.now() }
		};
		this.runs.set(each.run, { facts, exactResume: each.meta.exactResume, settled: Promise.resolve(), uncertain: true });
		this.deps.execution.openPair(pairOf(facts), { reveal: false });
		this.deps.execution.note(each.run, reason);
		this.emit({ run: each.run, kind: 'added' });
	}

	/**
	 * Looks again, every few seconds, for the runs whose grace end was not confirmed: one no longer listed has ended - its card goes,
	 * and its Pin is restored as an ended run's (LIFECYCLE-3.5).
	 */
	private watchUncertain(): void {
		if (this.watchingUncertain || ![...this.runs.values()].some(run => run.uncertain)) {
			return;
		}
		this.watchingUncertain = true;
		const wait = this.deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
		void (async () => {
			try {
				while (!this.disposed && !this.ownershipLost && [...this.runs.values()].some(run => run.uncertain)) {
					await wait(UNCERTAIN_CHECK_MS);
					let listed: Set<RunId>;
					try {
						listed = new Set((await this.deps.execution.live()).filter(each => each.uncertain).map(each => each.run));
					} catch {
						continue;
					}
					const freed = new Set<string>();
					for (const [id, run] of [...this.runs]) {
						if (run.uncertain && !listed.has(id) && !this.disposed) {
							this.runs.delete(id);
							this.released.add(id);
							this.deps.execution.removePair(id);
							this.emit({ run: id, kind: 'removed', cause: 'exit' });
							this.deps.log.event(`${run.facts.alias}, whose end was not confirmed, has ended`);
							if (run.facts.pin) { freed.add(run.facts.pin); }
						}
					}
					// Its Pin is restored now, as an ended run's - the opening's own restoration is done already
					if (freed.size && !this.disposed) {
						await this.restoreHeldBy(freed);
					}
				}
			} finally {
				this.watchingUncertain = false;
			}
		})().catch(err => this.deps.log.event(`Could not look again for agents whose end was not confirmed: ${messageOf(err)}`));
	}

	/**
	 * Unpins the Pins whose location this session reported removed: a removal found as the extensions restart - removing the first
	 * folder restarts them - is reported before this service hears it, and unpins as one heard does (RULES-2.4, 4.2).
	 */
	private unpinRemoved(): void {
		this.unpinGone(this.pins().filter(pin => this.deps.locations.removalOf(pin.location)));
	}

	/** Unpins `pins`, whose location was removed, each on its own: one the store cannot remove now is said, and holds up no other. */
	private unpinGone(pins: readonly Pin[]): void {
		for (const pin of pins) {
			try {
				this.pinStore.remove(pin.id);
				this.deps.log.event(`Unpinned ${JSON.stringify(pin.name)}: its working location was removed`);
			} catch (err) {
				this.deps.log.event(`Could not unpin ${JSON.stringify(pin.name)}, whose working location was removed: ${messageOf(err)}`);
			}
		}
	}

	private settlePins(): void {
		const holders = new Map<string, Run[]>();
		for (const run of this.runs.values()) {
			if (run.facts.pin) {
				holders.set(run.facts.pin, [...holders.get(run.facts.pin) ?? [], run]);
			}
		}
		for (const runs of holders.values()) {
			const [keeper, ...others] = runs.sort((a, b) => Number(a.facts.lifecycle === 'ended') - Number(b.facts.lifecycle === 'ended') || b.facts.createdAt - a.facts.createdAt);
			others.forEach(other => this.losePin(other));
			this.deps.execution.pinTab?.(keeper.facts.id, true);
		}
	}

	/** The run no longer holds its Pin, which another card of the same conversation took (LIFECYCLE-3.4). */
	private losePin(run: Run): void {
		this.update(run, { pin: undefined }, 'lifecycle');
		if (run.facts.end?.kind === 'failed') {
			this.retain(run);
		}
		this.deps.execution.pinTab?.(run.facts.id, false);
	}

	private remember(run: Run): void {
		const key = keyOf(run.facts);
		if (key) {
			try { this.deps.conversations?.put(key, { location: run.facts.location, cwd: run.facts.cwd, name: run.facts.name }); }
			catch (err) { this.deps.log.event(`Could not keep conversation metadata: ${messageOf(err)}`); }
		}
	}

	launch(request: LaunchRequest): RunId {
		if (this.ownershipLost) {
			throw invalid('ownership_lost', 'This workspace is now owned by another window. Reload this window to take ownership.', OWNERSHIP_LOST);
		}
		return this.accept(request, this.validated(request));
	}

	async started(id: RunId): Promise<StartOutcome> {
		const run = this.runs.get(id);
		if (!run) {
			return { state: 'closed' };
		}
		await run.settled;
		const facts = this.runs.get(id) === run ? run.facts : undefined;
		const prompt = run.prompt ? { prompt: run.prompt } : {};
		const worktree = run.worktree?.folder ? { worktreeCreated: run.worktree.folder } : {};
		if (!facts) {
			return { state: 'closed', ...prompt, ...worktree };
		}
		return facts.lifecycle === 'running' ? { state: 'running', ...prompt, ...worktree } : { state: 'failed', ...(facts.error ? { error: facts.error.english ?? facts.error.reason } : {}), ...prompt, ...worktree };
	}

	/** Whether `id`'s post-start creation prompt, its preparation included, is still to be delivered or given up (RULES-1.10). */
	creationPending(id: RunId): boolean {
		return this.runs.get(id)?.creationPending === true;
	}

	/** Its post-start creation prompt was delivered or given up: its input is no longer held for it (RULES-1.10). */
	creationSettled(id: RunId): void {
		const run = this.runs.get(id);
		if (run) {
			run.creationPending = false;
		}
	}

	async warmedUp(id: RunId): Promise<void> {
		const run = this.runs.get(id);
		if (run) {
			await run.settled;
			await run.warm;
		}
	}

	/** Reports every problem of a request together before any effect (RULES-5.1, MCP-1.1). */
	private validated(request: LaunchRequest): Location {
		const problems: string[] = [];
		if (typeof request.name !== 'string') {
			problems.push('The name must be a string.');
		}
		if (request.origin === 'agent' && !request.creator) {
			problems.push('An agent start needs its calling agent.');
		}
		for (const field of ['model', 'effort'] as const) {
			const value = request[field];
			if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
				problems.push(`The ${field} must be a nonempty string where given.`);
			}
		}
		const location = request.location ? this.deps.locations.resolve(request.location) : undefined;
		if (!request.location) {
			problems.push('A working location is required.');
		} else if (!location) {
			problems.push(`The working location ${request.location} is not available in this window.`);
		}
		if (!request.cli) {
			problems.push('A CLI is required.');
		}
		if (request.worktree && !request.worktree.branch?.trim()) {
			problems.push('A new worktree needs a branch.');
		}
		if (problems.length || !location) {
			// Where its working location alone is the problem, the person is told that, not its ID (UX-2.4)
			const said = problems.length === 1 && request.location && !location ? LOCATION_GONE : undefined;
			throw new FacadeError('INVALID', request.name === undefined || !request.cli || !request.location ? 'missing_argument' : 'invalid_argument', problems.join(' '), said);
		}
		return location;
	}

	private accept(request: LaunchRequest, location: Location, options: StartOptions = {}): RunId {
		// Every launch reads the setting, before it takes a number: a wrong one refuses it with no effect (RULES-4.3, UX-4.1)
		const yolo = this.deps.yolo();
		const id = this.deps.newRunId();
		const now = this.deps.clock.now();
		const byAgent = request.origin === 'agent' && request.creator ? request.creator : undefined;
		const promptLine = request.promptLine ?? firstLine(request.prompt);
		const facts: RunFacts = {
			id,
			alias: this.deps.aliases.next(),
			name: normalizeName(request.name),
			cli: request.cli,
			displayName: request.cli,
			command: request.cli,
			location: location.id,
			cwd: location.path,
			environment: location.environment,
			// A child keeps its creator's tree, not its creator's YOLO (RULES-4.3)
			yolo,
			createdAt: now,
			lifecycle: 'starting',
			phase: request.worktree ? 'creating_worktree' : 'launching_cli',
			activity: 'unknown',
			reporting: false,
			...(options.resume ? { sessionId: options.resume.key.sessionId } : {}),
			...(options.pin ? { pin: options.pin } : {}),
			root: byAgent?.root ?? id,
			...(byAgent ? { creator: byAgent.run } : {}),
			...(byAgent?.label ? { creatorLabel: byAgent.label } : {}),
			origin: byAgent ? 'agent' : 'human',
			...(byAgent && request.requestId !== undefined ? { requestId: request.requestId } : {}),
			...(byAgent && request.promptId !== undefined ? { promptId: request.promptId } : {}),
			...(byAgent && request.startCallId !== undefined ? { startCallId: request.startCallId } : {}),
			...(byAgent && request.resultMessageId !== undefined ? { resultMessageId: request.resultMessageId } : {}),
			...(request.model !== undefined ? { model: request.model.trim() } : {}),
			...(request.effort !== undefined ? { effort: request.effort.trim() } : {}),
			tools: 'not_injected',
			...(promptLine ? { promptLine } : {})
		};
		if (options.pin) {
			for (const other of this.runs.values()) { if (other.facts.pin === options.pin) { this.losePin(other); } }
		}
		let settle!: () => void;
		const run: Run = { facts, settled: new Promise(resolve => settle = resolve) };
		// Persist a request-bearing accepted run before creating its worktree or process, including starts interrupted by reload.
		this.rememberRequest(facts, true);
		if (options.restoring) { this.restoring.add(id); }
		this.runs.set(id, run);
		// The person's own launch shows its terminal; an agent another agent starts has its card alone, its tab opening only as the
		// person opens it - covering nothing, taking no focus (LIFECYCLE-2.2)
		this.deps.execution.openPair(pairOf(facts), byAgent ? { reveal: false, hidden: true } : { reveal: options.reveal !== false });
		if (options.pin) { this.deps.execution.pinTab?.(id, true); }
		this.emit({ run: id, kind: 'added' });
		this.deps.log.event(`Accepted ${facts.alias} ${JSON.stringify(facts.name)} (${facts.cli}) in ${facts.cwd} [${id}]${byAgent ? ` for agent ${byAgent.run}` : ''}`);
		this.recordFact('agent_start_requested', facts);
		void this.start(run, request, location, options).catch(err => this.deps.log.event(`The start of ${run.facts.alias} failed unexpectedly: ${messageOf(err)}`)).finally(settle);
		return id;
	}

	private recordFact(event: string, facts: RunFacts, extra: Readonly<Record<string, unknown>> = {}): void {
		this.deps.log.fact?.(event, { agent_id: facts.id, alias: facts.alias, cli: facts.cli, location_id: facts.location,
			path: facts.cwd, origin: facts.origin, creator: facts.creator, request_id: facts.requestId, call_id: facts.startCallId,
			requested_model: facts.model, requested_effort: facts.effort, ...extra });
	}

	private async start(run: Run, request: LaunchRequest, source: Location, options: StartOptions): Promise<void> {
		let location: Location | undefined = source;
		if (request.worktree) {
			try {
				const plan = await this.deps.worktrees.plan(source.id, request.worktree.branch, request.worktree.baseRef);
				location = await this.deps.worktrees.create(plan, () => this.live(run));
				run.worktree = { branch: plan.branch, folder: location.path };
			} catch (err) {
				run.worktree = err instanceof WorktreeError ? worktreeCreationEffects(request.worktree.branch, err.effects) : undefined;
				return this.fail(run, messageOf(err), 'worktree', err);
			}
			if (!this.live(run)) {
				return;
			}
			this.update(run, { location: location.id, cwd: location.path, phase: 'launching_cli' }, 'lifecycle');
		} else {
			location = options.resume ? this.locationFor(run.facts.location, run.facts.cwd) : this.deps.locations.resolve(run.facts.location);
		}
		if (!location) {
			const english = `The working location ${run.facts.cwd} is no longer available.`;
			return this.fail(run, english, 'location', new FacadeError('UNAVAILABLE', 'not_found', english, LOCATION_GONE));
		}
		let plan: LaunchPlan;
		try {
			const tools = this.deps.tools?.(run.facts.id, run.facts, location);
			plan = await this.deps.planner.plan({
				run: run.facts.id, alias: run.facts.alias, name: run.facts.name, cli: request.cli, location, yolo: run.facts.yolo,
				...(run.facts.model !== undefined ? { model: run.facts.model } : {}),
				...(run.facts.effort !== undefined ? { effort: run.facts.effort } : {}),
				...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
				...(options.resume ? { resume: { sessionId: options.resume.key.sessionId } } : {}),
				...(tools ? { tools } : {})
			});
		} catch (err) {
			this.fail(run, err instanceof PlanError || err instanceof FacadeError ? err.message : messageOf(err), 'launch', err);
			return this.release(run.facts.id);
		}
		if (!this.live(run)) {
			// Closed while it planned: what the plan injected goes again, after the close's own release (CLIS-2.2)
			return this.release(run.facts.id);
		}
		run.exactResume = plan.exactResume;
		const sessionId = plan.sessionId ?? run.facts.sessionId;
		// A conversation it resumes is saved already: it can be pinned from the start, its Pin following its CLI should that name
		// another (LIFECYCLE-3.4). A new one, an ID given it or not, waits for its CLI to name it.
		const resumed = !!options.resume && !!plan.exactResume && sessionId === options.resume.key.sessionId;
		if (plan.prompt) {
			run.prompt = plan.prompt;
			run.creationPending = plan.prompt?.path === 'post_start';
		}
		this.update(run, {
			displayName: plan.displayName, command: plan.command, cwd: plan.cwd, sessionId, resumable: resumed,
			...(plan.version !== undefined ? { version: plan.version } : {}),
			tools: plan.tools.state === 'injected' ? 'connecting' : plan.tools.state === 'unavailable' ? 'unavailable' : 'not_injected',
			...(plan.tools.state === 'unavailable' && plan.tools.reason ? { toolsReason: plan.tools.reason } : {}),
			...(plan.tools.state === 'unavailable' && plan.tools.problem ? { toolsProblem: plan.tools.problem } : {}),
			...(plan.tools.state === 'unavailable' && plan.tools.file ? { toolsFile: plan.tools.file } : {}),
			...(plan.input.adapter !== undefined ? { inputAdapter: plan.input.adapter } : {}),
			inputCapability: plan.input.capability
		}, 'lifecycle');
		try {
			const meta = metaOf(run.facts, run.exactResume);
			run.spawning = true;
			const started = await this.deps.execution.spawn(run.facts.id, plan, meta).finally(() => { run.spawning = false; });
			if (!this.live(run)) {
				return;
			}
			// Its exit can be heard before its start is answered: an ended run stays ended, its process known (RULES-3.1, 3.3)
			this.update(run, run.facts.lifecycle === 'ended'
				? { pid: started.pid, startedAt: started.startedAt }
				: { lifecycle: 'running', phase: 'running', pid: started.pid, startedAt: started.startedAt }, 'lifecycle');
			// A rename while it started is kept with its process too, as a later one is: a reload shows it (LIFECYCLE-2.1, 3.5)
			if (run.facts.name !== meta.name || run.facts.sessionId !== meta.sessionId) {
				this.deps.execution.setMeta(run.facts.id, metaOf(run.facts, run.exactResume));
			}
			this.remember(run);
			if (options.resume) { this.deps.locations.rememberLocation?.(run.facts.cwd); }
			if (run.facts.lifecycle !== 'ended' && plan.warmUp && this.deps.warmUp) {
				// Ahead of its creation prompt and any message: its first turn can use the tools then (COLLABORATION-2.2)
				const alias = run.facts.alias;
				run.warm = this.deps.warmUp(run.facts.id, plan.warmUp).catch(err => this.deps.log.event(`Could not prepare ${alias}'s tools before its first turn: ${messageOf(err)}`));
			}
			if (run.facts.origin === 'human' && options.remember !== false) {
				// The person's last successful launch alone is remembered (LIFECYCLE-1.2)
				this.deps.history.remember(run.facts.location, run.facts.cli);
			}
			// The arguments may hold a prompt or a credential: never logged (ARCHITECTURE-3.3, CLIS-4.2)
			this.recordFact('agent_started', run.facts, { pid: started.pid, started_at: new Date(started.startedAt).toISOString() });
			this.deps.log.event(`Started ${run.facts.alias} (${plan.cli}) pid ${started.pid}: ${plan.executable} with ${plan.args.length} argument${plan.args.length === 1 ? '' : 's'}`);
		} catch (err) {
			this.fail(run, messageOf(err), 'launch', err);
			this.release(run.facts.id);
		}
	}

	/** The run's injected files and project references go once it ends or is closed (CLIS-2.2). */
	private release(id: RunId): void {
		void this.deps.planner.release(id).catch(err => this.deps.log.event(`Could not release ${id}'s injected files: ${messageOf(err)}`));
	}

	/** Its MCP shim said hello: its tools are there (CLIS-2.2), kept across a reload in what ptyd keeps of it. */
	private toolsConnected(id: RunId): void {
		const run = this.runs.get(id);
		if (run && run.facts.lifecycle !== 'ended' && run.facts.tools !== 'available') {
			this.update(run, { tools: 'available', toolsProblem: undefined, toolsReason: undefined }, 'reported');
			if (run.facts.pid !== undefined) {
				this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
			}
		}
	}

	/** Its MCP shim went, none other connected: its tools, once there, are unavailable, and the card says so (RULES-3.1, PANEL-1.4). */
	private toolsDisconnected(id: RunId): void {
		const run = this.runs.get(id);
		if (run && run.facts.lifecycle !== 'ended' && run.facts.tools === 'available') {
			this.update(run, { tools: 'unavailable', toolsProblem: 'disconnected', toolsReason: 'its Facade MCP server disconnected' }, 'reported');
			if (run.facts.pid !== undefined) {
				this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
			}
		}
	}

	/** Whether the run is still wanted: closing it during startup prevents a later spawn (WORKTREES-2.5, RULES-5.2). */
	private live(run: Run): boolean {
		return !this.disposed && !this.ownershipLost && this.runs.get(run.facts.id) === run;
	}

	/** `err` as the person is told it (UX-2.4): Facade's own reasons in their language, any other error's words as they are. */
	private wording(err: unknown): string {
		const english = messageOf(err);
		return this.deps.describe ? this.deps.describe(err, english) : english;
	}

	/** The launch failed: its pair kept red with why in the person's words, the English in the log (RULES-3.3, UX-2.4). */
	private fail(run: Run, english: string, source: string, err?: unknown): void {
		if (!this.live(run)) {
			return;
		}
		const at = this.deps.clock.now();
		const effects = run.worktree ? { worktree: run.worktree } : {};
		const reason = err !== undefined && this.deps.describe ? this.deps.describe(err, english) : english;
		this.update(run, { lifecycle: 'ended', end: { kind: 'failed', at }, error: { reason, ...reason !== english ? { english } : {}, source, at, ...effects } }, 'lifecycle');
		this.deps.execution.note(run.facts.id, reason);
		this.deps.log.event(`Could not start ${run.facts.alias}: ${english}`);
		this.recordFact('agent_start_failed', run.facts, { source, reason: english });
		if (run.facts.origin === 'human' && !this.restoring.has(run.facts.id)) {
			// An agent's start reports its failure to that agent, never as the person's popup (RULES-1.8)
			this.deps.human.failed({ kind: 'start', name: labelOf(run.facts), reason, ...effects }, { show: run.facts.id, configure: source === 'launch' });
		}
		this.retain(run);
	}

	/** Keeps a failed start's pair for a reload; one that cannot be written stays red in this window alone, said in the log. */
	private retain(run: Run): void {
		try {
			this.deps.retained.put(run.facts);
		} catch (err) {
			this.deps.log.event(`Could not keep the failed start of ${run.facts.alias} for a reload: ${messageOf(err)}`);
		}
	}

	async close(id: RunId): Promise<CleanupResult | 'already_ended' | 'not_started'> {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		this.unpinned(run);
		return this.closeRun(run);
	}

	/** Removes `run`'s pair at once and ends its process in the background (LIFECYCLE-3.1), its Pin already seen to. */
	private async closeRun(run: Run): Promise<CleanupResult | 'already_ended' | 'not_started'> {
		const id = run.facts.id;
		const kept = this.rememberRequest({ ...run.facts, lifecycle: 'ended' });
		this.runs.delete(id);
		this.released.add(id);
		const key = keyOf(run.facts);
		if (key) { this.elsewhere.delete(conversationId(key)); }
		this.deps.execution.removePair(id);
		this.emit({ run: id, kind: 'removed', cause: 'close' });
		this.release(id);
		// Its card and terminal are gone first: a record the store cannot remove now holds up neither, nor its process's end (RULES-4.1)
		if (!kept) {
			this.forgetRetained(id);
		}
		if (run.facts.lifecycle === 'ended') {
			this.deps.log.event(`Closed ${run.facts.alias}`);
			this.recordFact('agent_closed', run.facts, { cleanup: 'already_ended' });
			return 'already_ended';
		}
		if (run.facts.pid === undefined && !run.spawning) {
			// Closed before its process was asked for: it never starts (WORKTREES-2.5)
			this.deps.log.event(`Closed ${run.facts.alias} before its process started`);
			this.recordFact('agent_closed', run.facts, { cleanup: 'not_started' });
			return 'not_started';
		}
		// A process asked for may be starting now: ended as it starts, the close answers how that went - never that none started, for a
		// deletion that waits for every process of a worktree to end (WORKTREES-3.2, LIFECYCLE-4.2)
		const result = await this.deps.execution.terminate(id).catch(err => {
			this.deps.log.event(`Could not end ${run.facts.alias}: ${messageOf(err)}`);
			return 'failed' as const;
		});
		this.deps.log.event(`Closed ${run.facts.alias}: ${result}`);
		this.recordFact('agent_closed', run.facts, { cleanup: result });
		return result;
	}

	rename(id: RunId, raw: string): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const name = normalizeName(raw);
		if (name === run.facts.name) {
			return;
		}
		this.update(run, { name }, 'renamed');
		this.deps.execution.rename(id, name);
		const pin = this.pins().find(each => each.id === run.facts.pin);
		if (pin) { this.pinStore.save({ ...pin, name }); }
		this.remember(run);
		if (run.facts.pid !== undefined) {
			// ptyd keeps an exited run's record too: a renamed red card keeps its name across a reload
			this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
		}
		if (run.facts.lifecycle === 'ended' && run.facts.end?.kind === 'failed') {
			this.retain(run);
		}
	}

	/**
	 * The person closed a run's terminal tab (LIFECYCLE-2.2, 3.1): it is hidden, the agent going on, and its card opens it again - no
	 * question, whatever closed it. A close of a tab that showed its pin mark Unpins as well; an Unpin that cannot be saved opens the
	 * tab again, pinned, and says so (3.4, RULES-1.8).
	 */
	private tabClosed(id: RunId, marked: boolean): void {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		this.deps.log.event(`Hid ${run.facts.alias}'s tab: the person closed it`);
		if (!marked || !run.facts.pin) {
			return;
		}
		try {
			this.unpin(id);
		} catch (err) {
			this.deps.log.event(`Could not unpin ${run.facts.alias} as its tab was closed: ${messageOf(err)}`);
			this.deps.execution.pinTab?.(id, true);
			this.deps.execution.reopen?.(id);
			this.deps.human.failed({ kind: 'unpin', name: labelOf(run.facts), reason: this.wording(err) }, { show: id });
		}
	}

	/**
	 * The person renamed a run's terminal tab (LIFECYCLE-2.2): rename the label as Rename Agent does, including to an empty string.
	 */
	private tabRenamed(id: RunId, name: string): void {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		this.rename(id, name);
	}

	resume(entry: ConversationEntry, options: { readonly reveal: boolean }): RunId | { readonly running: RunId | 'elsewhere' } {
		const running = this.holding(entry.key);
		if (running) {
			return { running };
		}
		if (entry.unavailable) {
			throw new FacadeError('INVALID', 'unsupported', entry.unavailable);
		}
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST); }
		if (!entry.key.sessionId || entry.key.sessionId.includes('\0')) { throw invalid('invalid_argument', 'An exact conversation ID is required.'); }
		const meta = this.deps.conversations?.get(entry.key);
		if (entry.cwdChoices?.length && !meta?.cwd) { throw invalid('invalid_argument', 'Choose a working location before resuming this conversation.'); }
		const location = this.locationFor(meta?.location, meta?.cwd ?? entry.cwd);
		if (!location || location.environment !== entry.key.environment) {
			const cwd = meta?.cwd ?? entry.cwd;
			throw new FacadeError('INVALID', 'not_found', `The conversation's working location ${cwd} is not available in this window.`, locationNotHere(cwd));
		}
		// Manual Resume names an unnamed conversation only now, without turning its title into an agent name (LIFECYCLE-2.3).
		const name = meta?.name.trim() || suggestName(this.list().map(run => run.name));
		return this.accept(
			{ name, location: location.id, cli: entry.key.cli, origin: 'human' },
			location,
			{ reveal: options.reveal, resume: { key: entry.key }, remember: true, ...this.pinOf(entry.key) ? { pin: this.pinOf(entry.key)!.id } : {} }
		);
	}

	/**
	 * A message sent to the run: what its CLI took from its input after the person's Enter, or a message Facade delivered. Its card's
	 * second line says the last one, its CLI's title no more (PANEL-1.4); kept with its process across a reload.
	 */
	said(id: RunId, text: string): void {
		const run = this.runs.get(id);
		const said = displayLine(text, MOST_LINE);
		if (!run || run.facts.lifecycle === 'ended' || !said || said === run.facts.said) {
			return;
		}
		this.update(run, { said }, 'reported');
		if (run.facts.pid !== undefined) {
			this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
		}
	}

	pin(id: RunId): void {
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST); }
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (!run.facts.pinnable) {
			throw new FacadeError('INVALID', 'unsupported', `${run.facts.name}'s CLI cannot resume this exact conversation, so it cannot be pinned.`, { kind: 'pin_unsupported', values: [] });
		}
		if (run.facts.pin) {
			return;
		}
		// Pinned before its CLI named a conversation, it has none yet: the Pin takes the one the CLI names, and restores a new one of
		// the same CLI, name and location until then (LIFECYCLE-3.4)
		const key = run.facts.resumable ? keyOf(run.facts) : undefined;
		// One Pin a conversation (RULES-4.2): one its CLI resumed by itself may be pinned already - that Pin is this card's now, rather
		// than a second one an Unpin would leave behind to restore
		const earlier = key && this.pinOf(key);
		const conversation = key ?? { environment: run.facts.environment, cli: run.facts.cli };
		const pin: Pin = { id: earlier ? earlier.id : this.deps.newPinId?.() ?? `pin-${this.deps.newRunId()}`, conversation, location: run.facts.location, cwd: run.facts.cwd, name: run.facts.name };
		this.pinStore.save(pin);
		if (earlier) {
			// Pin moves it last among the Pins (PANEL-2.1), as a new Pin goes; where that order cannot be saved, the Pin still is
			try {
				this.pinStore.reorder([...this.pins().map(each => each.id).filter(each => each !== pin.id), pin.id]);
			} catch (err) {
				this.deps.log.event(`Could not move the Pin of ${run.facts.alias} last among the Pins: ${messageOf(err)}`);
			}
		}
		for (const other of this.runs.values()) { if (other !== run && other.facts.pin === pin.id) { this.losePin(other); } }
		this.update(run, { pin: pin.id }, 'lifecycle');
		this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
		this.deps.execution.pinTab?.(id, true);
		this.deps.log.event(`Pinned ${run.facts.alias}`);
	}

	unpin(id: RunId): void {
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST); }
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		if (run.facts.pin) {
			this.unpinned(run);
			this.update(run, { pin: undefined }, 'lifecycle');
			this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
			if (run.facts.end?.kind === 'failed') { this.retain(run); }
			this.deps.execution.pinTab?.(id, false);
			this.deps.log.event(`Unpinned ${run.facts.alias}`);
		}
	}

	async restorePins(): Promise<void> {
		if (this.pinsRestored || this.ownershipLost || this.disposed) { return; }
		this.pinsRestored = true;
		await this.restoreHeldBy();
	}

	/**
	 * Restores the Pins no run holds: every one at an opening, or `only` those a run held until now - one whose grace end was not
	 * confirmed, its exit heard since (LIFECYCLE-3.5) - telling of these alone.
	 */
	private async restoreHeldBy(only?: ReadonlySet<string>): Promise<void> {
		// The conversations running in every ptyd of this environment first: one that does not answer - an earlier protocol's, whose runs
		// a first restore may not have shown - is asked again, never guessed, as a Pin started meanwhile runs one twice (LIFECYCLE-3.5)
		let failure: string | undefined;
		const listed = await untilAnswered(() => this.refreshConversations().then(() => true as const), {
			first: CONVERSATIONS_RETRY_MS,
			most: MOST_CONVERSATIONS_RETRY_MS,
			stopped: () => this.ownershipLost || this.disposed,
			failed: err => {
				if (messageOf(err) !== failure) {
					failure = messageOf(err);
					this.deps.log.event(`Could not list the conversations running in this environment; the Pins are restored once they are known: ${failure}`);
				}
			},
			wait: ms => this.deps.wait?.(ms) ?? timeout(ms, this.stopping.signal).catch(() => undefined)
		});
		if (!listed || this.ownershipLost || this.disposed) { return; }
		this.unpinRemoved();
		// A Pin a card already holds - running, or retained red after an abnormal exit or a failed restore - is not started again
		// on a reload: restoration happens once per opening, without a restart loop (RULES-4.2)
		const held = new Set([...this.runs.values()].map(run => run.facts.pin).filter(pin => pin !== undefined));
		const queue = this.pins().filter(pin => !held.has(pin.id) && !this.holdingPin(pin) && (!only || only.has(pin.id)));
		// Kept as they failed: a card closed before the others finish still counts, without being looked up again
		const failed: { readonly id?: RunId; readonly name: string; readonly reason: string }[] = [];
		// A Pin refused before any card - a facade.yolo neither true nor false, no number to give (UX-4.1, RULES-2.2) - fails as
		// itself, kept for the next opening, and the others are restored all the same (LIFECYCLE-3.4)
		const restoreOne = async (pin: Pin): Promise<void> => {
			try {
				await restoring(pin);
			} catch (err) {
				this.deps.log.event(`Could not restore the Pin of ${pin.name || pin.conversation.cli}: ${messageOf(err)}`);
				failed.push({ name: pin.name || pin.conversation.cli, reason: this.wording(err) });
			}
		};
		const restoring = async (pin: Pin): Promise<void> => {
			// One whose location was removed is no failure to show: its removal unpins it, even where that write failed (RULES-2.4)
			if (!this.pins().some(saved => saved.id === pin.id) || this.holdingPin(pin) || this.deps.locations.removalOf(pin.location)) { return; }
			const location = this.locationFor(pin.location, pin.cwd);
			if (!location || location.environment !== pin.conversation.environment) {
				const english = `Its working location ${pin.cwd} is not available in this window.`;
				const reason = this.deps.describe?.(new FacadeError('UNAVAILABLE', 'not_found', english, locationNotHere(pin.cwd)), english) ?? english;
				const id = this.unrestorable(pin, reason, english);
				failed.push({ id, name: labelOf(this.runs.get(id)?.facts ?? { name: pin.name, alias: '' }), reason });
				return;
			}
			// One pinned before its CLI named a conversation starts a new one, which its Pin takes once named (LIFECYCLE-3.4)
			const key = pinKey(pin);
			const id = this.accept(
				{ name: pin.name, location: location.id, cli: pin.conversation.cli, origin: 'human' },
				location,
				{ ...key ? { resume: { key } } : {}, reveal: false, remember: false, pin: pin.id, restoring: true }
			);
			await this.runs.get(id)?.settled;
			this.restoring.delete(id);
			const facts = this.runs.get(id)?.facts;
			if (facts?.end?.kind === 'failed') {
				failed.push({ id, name: labelOf(facts), reason: facts.error?.reason ?? '' });
			}
		};
		const workers = Array.from({ length: Math.min(RESTORE_CONCURRENCY, queue.length) }, async () => {
			for (let pin = queue.shift(); pin && !this.ownershipLost && !this.disposed; pin = queue.shift()) {
				await restoreOne(pin);
			}
		});
		await Promise.all(workers);
		if (failed.length && !this.ownershipLost && !this.disposed) {
			// A known failure no agent is responsible for: one notification for this opening (RULES-1.8). A Pin refused before any card
			// has no card to show why, and its reason - the window's numbers, its facade.yolo - holds for the others: it is the one told
			const cardless = failed.find(each => !each.id);
			const told = cardless ?? failed[0];
			this.deps.human.failed({ kind: 'restore', name: told.name, reason: told.reason, count: cardless ? 1 : failed.length }, told.id && this.runs.has(told.id) ? { show: told.id } : {});
		}
	}

	/**
	 * A Pin that cannot start here keeps its own red card, holding the Pin, so the person sees why and can Close it, which
	 * Unpins (LIFECYCLE-3.4: failures retain their individual entries).
	 */
	private unrestorable(pin: Pin, reason: string, english = reason): RunId {
		const yolo = this.deps.yolo();
		const id = this.deps.newRunId();
		const at = this.deps.clock.now();
		const facts: RunFacts = {
			id, root: id, origin: 'human', tools: 'not_injected', alias: this.deps.aliases.next(), name: pin.name, cli: pin.conversation.cli, displayName: pin.conversation.cli, command: pin.conversation.cli,
			location: pin.location, cwd: pin.cwd, environment: pin.conversation.environment, yolo,
			createdAt: at, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false,
			...pin.conversation.sessionId ? { sessionId: pin.conversation.sessionId, resumable: true, pinnable: true } : {},
			pin: pin.id, end: { kind: 'failed', at }, error: { reason, ...reason !== english ? { english } : {}, source: 'location', at }
		};
		const run: Run = { facts, exactResume: true, settled: Promise.resolve() };
		this.runs.set(id, run);
		this.deps.execution.openPair(pairOf(facts), { reveal: false });
		this.deps.execution.note(id, reason);
		this.retain(run);
		this.emit({ run: id, kind: 'added' });
		this.deps.log.event(`Could not restore the pinned ${JSON.stringify(pin.name)}: ${english}`);
		return id;
	}

	/** The run holding this exact conversation: in this window, or `elsewhere` - a process another window's run holds it in. */
	holding(key: ConversationKey): RunId | 'elsewhere' | undefined {
		for (const run of this.runs.values()) {
			if (run.facts.lifecycle !== 'ended' && run.facts.sessionId === key.sessionId && run.facts.cli === key.cli && run.facts.environment === key.environment) {
				return run.facts.id;
			}
		}
		return this.elsewhere.has(conversationId(key)) ? 'elsewhere' : undefined;
	}

	/** The run holding the conversation a Pin restores; none for a Pin whose CLI named none yet, which only its own card holds (LIFECYCLE-3.4). */
	private holdingPin(pin: Pin): RunId | 'elsewhere' | undefined {
		const key = pinKey(pin);
		return key && this.holding(key);
	}

	private locationFor(id: LocationId | undefined, cwd: string): Location | undefined {
		const known = id ? this.deps.locations.resolve(id) : undefined;
		if (known && known.path === cwd) {
			return known;
		}
		const byPath = this.deps.locations.snapshot().locations.find(each => each.path === cwd);
		if (byPath) {
			return byPath;
		}
		return this.deps.locations.conversationLocation?.(cwd);
	}

	private restoredPin(meta: RunMeta): Pin | undefined {
		return this.pins().find(pin => pin.id === meta.pin) ?? (meta.sessionId ? this.pinOf({ environment: meta.environment, cli: meta.cli, sessionId: meta.sessionId }) : undefined);
	}

	private pinOf(key: ConversationKey): Pin | undefined {
		return this.pins().find(pin => pinsConversation(pin, key));
	}

	private unpinned(run: Run): void {
		const pin = run.facts.pin;
		if (pin && ![...this.runs.values()].some(other => other !== run && other.facts.pin === pin)) {
			this.pinStore.remove(pin);
		}
	}

	private tabPinned(id: RunId, pinned: boolean): void {
		const run = this.runs.get(id);
		if (!run || pinned === !!run.facts.pin) {
			return;
		}
		try {
			if (!pinned) {
				this.unpin(id);
			} else if (run.facts.pinnable) {
				this.pin(id);
			} else {
				this.deps.log.event(`${run.facts.alias}'s tab was pinned, but its CLI cannot resume this exact conversation; no restoration intent was saved`);
				this.deps.execution.pinTab?.(id, !!run.facts.pin);
			}
		} catch (err) {
			this.deps.log.event(`Could not save the native pin of ${run.facts.alias}: ${messageOf(err)}`);
			// Undone on its tab, and the person who pinned or unpinned it is told, as from its card (LIFECYCLE-3.4, RULES-1.8)
			this.deps.execution.pinTab?.(id, !!run.facts.pin);
			this.deps.human.failed({ kind: pinned ? 'pin' : 'unpin', name: labelOf(run.facts), reason: this.wording(err) }, { show: id });
		}
	}

	/** A CLI changed its session (for example after /clear): the record and Pin follow once the new identity is known (LIFECYCLE-3.4). */
	private identified(id: RunId, sessionId: string | null, cwd?: string): void {
		if (this.disposed || this.ownershipLost) { return; }
		const run = this.runs.get(id);
		// Nothing to follow where the record, and its Pin, name this session already: a Pin whose update failed earlier still follows
		const pinned = run?.facts.pin ? this.pins().find(each => each.id === run.facts.pin) : undefined;
		if (!run || run.facts.lifecycle === 'ended' || (run.facts.sessionId === sessionId && run.facts.resumable && (!cwd || cwd === run.facts.cwd)
			&& (!pinned || pinned.conversation.sessionId === sessionId))) {
			return;
		}
		// Keep the last saved key while a native new/home screen has no conversation. Its existing Pin stays associated across reload.
		this.update(run, { sessionId: sessionId ?? run.facts.sessionId, resumable: !!sessionId && run.exactResume, ...cwd ? { cwd } : {} }, 'lifecycle');
		const pin = run.facts.pin ? this.pins().find(each => each.id === run.facts.pin) : undefined;
		if (pin && sessionId) {
			try {
				const key = keyOf(run.facts)!;
				this.pinStore.save({ ...pin, cwd: run.facts.cwd, conversation: key });
				// One Pin a conversation (RULES-4.2): another Pin of the one it switched to goes, as this card's names it now
				for (const other of this.pins().filter(each => each.id !== pin.id && pinsConversation(each, key))) {
					this.pinStore.remove(other.id);
					for (const holder of this.runs.values()) { if (holder.facts.pin === other.id) { this.losePin(holder); } }
				}
			} catch (err) {
				this.deps.log.event(`Could not update the Pin of ${run.facts.alias}: ${messageOf(err)}`);
				this.deps.human.failed({ kind: 'pin', name: labelOf(run.facts), reason: this.wording(err) }, { show: id });
			}
		}
		this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
		this.remember(run);
	}

	private reported(report: ActivityReport): void {
		const run = this.runs.get(report.run);
		if (!run || run.facts.lifecycle === 'ended') {
			return;
		}
		const changes: Partial<Mutable<RunFacts>> = {
			activity: report.activity,
			activitySince: report.disconnected ? run.facts.activitySince
				: report.observedAt !== undefined && Number.isFinite(report.observedAt) && report.observedAt >= 0 ? report.observedAt : undefined,
			disconnected: report.disconnected || undefined,
			reporting: report.reporting,
			awaitingActivity: report.awaitingActivity,
			notReady: report.notReady,
			activityReason: report.reason,
			blocker: report.blocker,
			title: report.title === '' ? undefined : report.title ?? run.facts.title
		};
		let kind: RunChange['kind'] = 'reported';
		if (report.disconnected && report.reason && !run.facts.error) {
			changes.error = { reason: report.reason, source: 'connection', at: this.deps.clock.now() };
			kind = 'lifecycle';
		} else if (!report.disconnected && run.facts.error?.source === 'connection') {
			changes.error = undefined;
			kind = 'lifecycle';
		}
		if (report.error) {
			if (run.facts.error?.source !== 'cli' || run.facts.error.reason !== report.error) {
				changes.error = { reason: report.error, source: 'cli', at: this.deps.clock.now() };
				kind = 'lifecycle';
			}
		} else if (!report.disconnected && run.facts.error?.source === 'cli') {
			// Recovery clears only the corresponding error (RULES-3.2)
			changes.error = undefined;
			kind = 'lifecycle';
		}
		this.update(run, changes, kind);
	}

	private exited(exit: ExitReport): void {
		const run = this.runs.get(exit.run);
		if (!run) {
			return;
		}
		// A signal's end is abnormal though its code be 0, as node-pty reports a process killed on Linux and macOS (RULES-3.3). A run
		// explicitly closed - a completed stop, normal - is no longer here, so its exit is never classified
		const normal = (exit.code === 0 && !exit.signal) || exit.interruptVerified;
		this.release(exit.run);
		if (normal) {
			// A normal exit removes the pair (RULES-3.3)
			try { this.unpinned(run); } catch (err) {
				const reason = this.wording(err), english = messageOf(err), at = this.deps.clock.now();
				this.update(run, { lifecycle: 'ended', end: { kind: 'failed', at }, error: { reason, ...reason !== english ? { english } : {}, source: 'pin', at } }, 'lifecycle');
				this.retain(run);
				this.deps.execution.note(exit.run, reason);
				this.deps.log.event(`Could not remove the Pin of ${run.facts.alias}: ${messageOf(err)}`);
				this.deps.human.failed({ kind: 'unpin', name: labelOf(run.facts), reason }, { show: exit.run });
				return;
			}
			this.rememberRequest({ ...run.facts, lifecycle: 'ended' });
			this.runs.delete(exit.run);
			this.released.add(exit.run);
			const key = keyOf(run.facts);
			if (key) { this.elsewhere.delete(conversationId(key)); }
			this.deps.execution.removePair(exit.run);
			this.emit({ run: exit.run, kind: 'removed', cause: 'exit' });
			this.deps.log.event(`${run.facts.alias} exited${exit.code !== undefined ? ` with code ${exit.code}` : ''}`);
			this.recordFact('agent_exited', run.facts, { code: exit.code, signal: exit.signal });
			return;
		}
		const at = this.deps.clock.now();
		const how = exit.signal ? `Ended by signal ${exit.signal}` : `Exited with code ${exit.code ?? 'unknown'}`;
		// An abnormal exit keeps the red pair, without a restart loop (RULES-3.3)
		this.update(run, {
			lifecycle: 'ended',
			end: { kind: 'abnormal', at, ...(exit.code !== undefined ? { code: exit.code } : {}), ...(exit.signal ? { signal: exit.signal } : {}) },
			error: { reason: how, source: 'exit', at }
		}, 'lifecycle');
		this.deps.log.event(`${run.facts.alias} ${how.toLowerCase()}`);
		this.recordFact('agent_exited', run.facts, { code: exit.code, signal: exit.signal });
	}

	private locationsRemoved(removal: LocationRemoval): void {
		const removed = new Set(removal.ids);
		const closing = [...this.runs.values()].filter(run => removed.has(run.facts.location));
		this.unpinGone(this.pins().filter(pin => removed.has(pin.location) || closing.some(run => run.facts.pin === pin.id)));
		for (const run of closing) {
			this.deps.log.event(`Closing ${run.facts.alias}: its working location was ${removal.cause === 'folder' ? 'removed from the workspace' : 'deleted'}`);
			// Whatever became of its Pin, said above: its process may be writing in a folder that is gone (RULES-2.4)
			void this.closeRun(run).catch(err => this.deps.log.event(`Could not close ${run.facts.alias}: ${messageOf(err)}`));
		}
	}

	private update(run: Run, changes: Partial<Mutable<RunFacts>>, kind: RunChange['kind']): void {
		const next = { ...run.facts } as Mutable<RunFacts>;
		for (const [key, value] of Object.entries(changes) as [keyof RunFacts, unknown][]) {
			if (value === undefined) {
				delete next[key];
			} else {
				(next as Record<string, unknown>)[key] = value;
			}
		}
		if (pinnableOf(next, run.exactResume)) {
			next.pinnable = true;
		} else {
			delete next.pinnable;
		}
		run.facts = next;
		if (kind === 'lifecycle') {
			this.rememberRequest(next);
		}
		this.emit({ run: run.facts.id, kind });
	}

	private emit(change: RunChange): void {
		// Its tab spins while its dot is green, by the same rule (LIFECYCLE-2.2)
		const run = this.runs.get(change.run);
		const busy = !!run && dotOf(run.facts) === 'working';
		if (run && busy !== !!run.spinning) {
			run.spinning = busy;
			this.deps.execution.spin?.(change.run, busy);
		}
		for (const listener of [...this.listeners]) {
			listener(change);
		}
	}
}

/** Disk records are observations, not typed objects: validate them before returning facts or opening any UI. */
function isRunRecord(value: unknown): value is RunFacts {
	if (!isJsonObject(value)) {
		return false;
	}
	const strings = ['id', 'alias', 'name', 'cli', 'displayName', 'command', 'location', 'cwd', 'environment'];
	return strings.every(key => typeof value[key] === 'string') && typeof value.yolo === 'boolean' &&
		typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) &&
		typeof value.lifecycle === 'string' && ['starting', 'running', 'ended'].includes(value.lifecycle) &&
		typeof value.phase === 'string' && ['creating_worktree', 'launching_cli', 'running'].includes(value.phase) &&
		typeof value.activity === 'string' && ['working', 'not_working', 'unknown'].includes(value.activity) && typeof value.reporting === 'boolean' &&
		['title', 'activityReason', 'said'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
		['pid', 'startedAt'].every(key => value[key] === undefined || typeof value[key] === 'number' && Number.isFinite(value[key])) &&
		(value.blocker === undefined || isJsonObject(value.blocker) && typeof value.blocker.kind === 'string' &&
			['permission', 'question', 'auth', 'unknown'].includes(value.blocker.kind) && (value.blocker.text === undefined || typeof value.blocker.text === 'string')) &&
		(value.end === undefined || isJsonObject(value.end) && ['failed', 'abnormal'].includes(value.end.kind as string) && typeof value.end.at === 'number' && Number.isFinite(value.end.at) &&
		(value.end.code === undefined || typeof value.end.code === 'number') && (value.end.signal === undefined || typeof value.end.signal === 'string')) &&
		(value.error === undefined || isJsonObject(value.error) && typeof value.error.reason === 'string' && (value.error.english === undefined || typeof value.error.english === 'string') && typeof value.error.source === 'string' && typeof value.error.at === 'number' && Number.isFinite(value.error.at) &&
		(value.error.worktree === undefined || (isJsonObject(value.error.worktree) &&
			(value.error.worktree.branch === undefined || (typeof value.error.worktree.branch === 'string' && !!value.error.worktree.branch)) &&
			(value.error.worktree.folder === undefined || (typeof value.error.worktree.folder === 'string' && !!value.error.worktree.folder)) &&
			(value.error.worktree.branch !== undefined || value.error.worktree.folder !== undefined))));
}

function isRetainedRun(value: unknown): value is RunFacts {
	return isRunRecord(value) && !('requestOnly' in value) && value.lifecycle === 'ended' && value.end?.kind === 'failed' && value.error !== undefined;
}

function isRequestRun(value: unknown): value is RunFacts & { readonly requestOnly: true } {
	return isRunRecord(value) && 'requestOnly' in value && value.requestOnly === true &&
		typeof value.creator === 'string' && !!value.creator && typeof value.requestId === 'string' && !!value.requestId &&
		typeof value.root === 'string' && !!value.root;
}

/** A retained record as this build keeps runs: one an earlier build wrote is a root of its own, without tools (ARCHITECTURE-4.2). */
function retainedFacts(kept: RunFacts): RunFacts {
	const record = kept as RunFacts & { readonly [key: string]: unknown };
	// Ended, it can be pinned where its conversation is saved (LIFECYCLE-3.4)
	const { pinnable: _pinnable, ...facts } = kept;
	return {
		...facts,
		...kept.resumable ? { pinnable: true } : {},
		root: typeof record.root === 'string' && record.root ? record.root : kept.id,
		origin: record.origin === 'agent' ? 'agent' : 'human',
		tools: record.tools === 'connecting' || record.tools === 'available' || record.tools === 'unavailable' ? record.tools : 'not_injected'
	};
}

function factsOf(id: RunId, meta: RunMeta): RunFacts {
	return {
		id,
		alias: meta.alias,
		...(meta.sessionId ? { sessionId: meta.sessionId, resumable: !!meta.resumable && !!meta.exactResume } : {}),
		name: meta.name,
		cli: meta.cli,
		displayName: meta.displayName,
		command: meta.command,
		location: meta.location,
		cwd: meta.cwd,
		environment: meta.environment,
		yolo: meta.yolo,
		createdAt: meta.createdAt,
		lifecycle: 'running',
		phase: 'running',
		activity: 'unknown',
		reporting: false,
		// A run an earlier build started is a root of its own, its tools unknown to this one (ARCHITECTURE-4.2)
		root: typeof meta.root === 'string' && meta.root ? meta.root : id,
		...(typeof meta.creator === 'string' && meta.creator ? { creator: meta.creator } : {}),
		...(typeof meta.creatorLabel === 'string' && meta.creatorLabel ? { creatorLabel: meta.creatorLabel } : {}),
		origin: meta.origin === 'agent' ? 'agent' : 'human',
		...(typeof meta.requestId === 'string' && meta.requestId ? { requestId: meta.requestId } : {}),
		...(typeof meta.promptId === 'string' && /^m-\d+$/.test(meta.promptId) ? { promptId: meta.promptId } : {}),
		...(typeof meta.startCallId === 'string' ? { startCallId: meta.startCallId } : {}),
		...(typeof meta.resultMessageId === 'string' ? { resultMessageId: meta.resultMessageId } : {}),
		...(typeof meta.model === 'string' ? { model: meta.model } : {}),
		...(typeof meta.effort === 'string' ? { effort: meta.effort } : {}),
		...(typeof meta.version === 'string' ? { version: meta.version } : {}),
		tools: meta.tools === 'connecting' || meta.tools === 'available' || meta.tools === 'unavailable' ? meta.tools : 'not_injected',
		...(typeof meta.toolsReason === 'string' ? { toolsReason: meta.toolsReason } : {}),
		...(meta.toolsProblem === 'cmd' || meta.toolsProblem === 'files' || meta.toolsProblem === 'conflict' || meta.toolsProblem === 'variable' || meta.toolsProblem === 'disconnected' ? { toolsProblem: meta.toolsProblem } : {}),
		...(typeof meta.toolsFile === 'string' ? { toolsFile: meta.toolsFile } : {}),
		...(typeof meta.promptLine === 'string' ? { promptLine: meta.promptLine } : {}),
		...(typeof meta.said === 'string' && meta.said ? { said: meta.said } : {}),
		...(typeof meta.inputAdapter === 'string' ? { inputAdapter: meta.inputAdapter } : {}),
		...(isCapability(meta.inputCapability) ? { inputCapability: meta.inputCapability } : {})
	};
}

export function metaOf(facts: RunFacts, exactResume = facts.resumable): RunMeta {
	return {
		alias: facts.alias,
		exactResume: !!exactResume,
		...facts.resumable ? { resumable: true } : {},
		...facts.pin ? { pin: facts.pin } : {},
		...(facts.sessionId ? { sessionId: facts.sessionId } : {}),
		name: facts.name,
		cli: facts.cli,
		displayName: facts.displayName,
		command: facts.command,
		location: facts.location,
		cwd: facts.cwd,
		environment: facts.environment,
		yolo: facts.yolo,
		createdAt: facts.createdAt,
		root: facts.root,
		...(facts.creator !== undefined ? { creator: facts.creator } : {}),
		...(facts.creatorLabel !== undefined ? { creatorLabel: facts.creatorLabel } : {}),
		...(facts.requestId !== undefined ? { requestId: facts.requestId } : {}),
		...(facts.promptId !== undefined ? { promptId: facts.promptId } : {}),
		...(facts.startCallId !== undefined ? { startCallId: facts.startCallId } : {}),
		...(facts.resultMessageId !== undefined ? { resultMessageId: facts.resultMessageId } : {}),
		origin: facts.origin,
		...(facts.model !== undefined ? { model: facts.model } : {}),
		...(facts.effort !== undefined ? { effort: facts.effort } : {}),
		...(facts.version !== undefined ? { version: facts.version } : {}),
		tools: facts.tools,
		...(facts.toolsReason !== undefined ? { toolsReason: facts.toolsReason } : {}),
		...(facts.toolsProblem !== undefined ? { toolsProblem: facts.toolsProblem } : {}),
		...(facts.toolsFile !== undefined ? { toolsFile: facts.toolsFile } : {}),
		...(facts.promptLine !== undefined ? { promptLine: facts.promptLine } : {}),
		...(facts.said !== undefined ? { said: facts.said } : {}),
		...(facts.inputAdapter !== undefined ? { inputAdapter: facts.inputAdapter } : {}),
		...(facts.inputCapability !== undefined ? { inputCapability: facts.inputCapability } : {})
	};
}

function isCapability(value: unknown): value is NonNullable<RunMeta['inputCapability']> {
	return isJsonObject(value) && typeof value.reason === 'string' && (value.state === 'supported' || value.state === 'unavailable' || value.state === 'unverified');
}

/** The first line of a creation prompt as a card's hover shows it: one trimmed line, or none. */
function firstLine(prompt: string | undefined): string | undefined {
	const line = prompt?.split(/\r?\n/).map(each => each.trim()).find(each => !!each);
	return line ? displayLine(line, 300) : undefined;
}

export function pairOf(facts: RunFacts): PairFacts {
	return { run: facts.id, name: facts.name, cli: facts.cli, displayName: facts.displayName, command: facts.command, cwd: facts.cwd };
}
