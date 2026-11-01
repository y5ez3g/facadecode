/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { displayLine } from '../base/text';
import { FacadeError, invalid } from './errors';
import { worktreeCreationEffects } from './locations/problems';
import { labelOf, normalizeName } from './names';
import { REQUEST_MS } from './requests';
import {
	ConversationEntry, ConversationKey, ConversationStore, Pin, PinStore, conversationId, LocationId,
	ActivityReport, Agents, AliasPort, CleanupResult, Clock, Disposable, Event, ExecutionPort, ExitReport, HumanPort, LaunchHistoryPort,
	LaunchPlan, LaunchPlanner, LaunchRequest, LiveRun, Location, LocationPort, LocationRemoval, LogPort, McpServerLaunch, PairFacts, PlanError,
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
	readonly tools?: (run: RunId) => McpServerLaunch | undefined;
	/** A failure in the person's language (UX-2.4): Facade's own reasons translated, any other its `english` as it is. */
	readonly describe?: (err: unknown, english: string) => string;
	/**
	 * Types what a run's start needs before its first turn into its CLI, ahead of any other automated input (COLLABORATION-2.2), and
	 * settles once that is done or given up; none, and nothing is typed.
	 */
	readonly warmUp?: (run: RunId, warmUp: NonNullable<LaunchPlan['warmUp']>) => Promise<void>;
	readonly newRunId: () => RunId;
}

interface Run {
	exactResume?: boolean;
	facts: RunFacts;
	/** Known startup creation effects, retained if later CLI planning or spawning fails. */
	worktree?: WorktreeCreationEffects;
	/** Whether an explicit close of this run was requested: its exit is then normal (RULES-3.3). */
	closing: boolean;
	/** Settles once its process started, its launch failed or it was closed first (MCP-2.3). */
	settled: Promise<void>;
	/** How its creation prompt goes in, once planned. */
	prompt?: LaunchPlan['prompt'];
	/** Settles once what its start types before its first turn is done or given up (COLLABORATION-2.2). */
	warm?: Promise<void>;
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
const RESTORE_CONCURRENCY = 2;

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
			deps.lifetime.onDidClose(() => void execution.endWindow())
		);
		if (execution.onDidIdentify) {
			this.subscriptions.push(execution.onDidIdentify(({ run, sessionId, cwd }) => this.identified(run, sessionId, cwd)));
		}
		if (execution.onDidPinTab) {
			this.subscriptions.push(execution.onDidPinTab(({ run, pinned }) => this.tabPinned(run, pinned)));
		}
		if (execution.onDidClosePair) {
			this.subscriptions.push(execution.onDidClosePair(run => void this.tabClosed(run)));
		}
		if (execution.onDidRenameTab) {
			this.subscriptions.push(execution.onDidRenameTab(({ run, name }) => this.tabRenamed(run, name)));
		}
		if (execution.onDidConnectTools) {
			this.subscriptions.push(execution.onDidConnectTools(run => this.toolsConnected(run)));
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
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.listeners.clear();
	}

	list(): readonly RunFacts[] {
		return [...this.runs.values()].map(run => run.facts);
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
	 * said in the log: cleanup never holds up showing this window's agents or answering an operation (RULES-4.1, D86).
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
		const liveIds = new Set(live.map(run => run.run));
		for (const kept of this.deps.retained.list()) {
			if (isRequestRun(kept)) {
				if (kept.createdAt <= this.deps.clock.now() - REQUEST_MS) {
					this.forgetRetained(kept.id);
				}
				continue;
			}
			if (!isRetainedRun(kept)) {
				this.deps.log.event('Ignored an invalid retained agent record.');
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
				this.runs.set(facts.id, { facts: { ...rest, ...pin ? { pin: pin.id } : {} }, closing: false, exactResume: facts.resumable, settled: Promise.resolve() });
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
			const facts: RunFacts = {
				...factsOf(each.run, each.meta),
				...this.restoredPin(each.meta) ? { pin: this.restoredPin(each.meta)!.id } : {},
				lifecycle: 'running',
				phase: 'running',
				pid: each.pid,
				startedAt: each.startedAt
			};
			const run: Run = { facts, closing: false, exactResume: each.meta.exactResume, settled: Promise.resolve() };
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
			this.emit({ run: each.run, kind: 'added' });
			if (this.deps.locations.removalOf(facts.location)) {
				// Its location went while the host restarted: removal closes it, as it would have (RULES-2.4)
				void this.close(each.run).catch(() => undefined);
			} else if (each.exited) {
				this.exited({ run: each.run, ...each.exited });
			}
		}
		this.settlePins();
		return elsewhere;
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
			throw invalid('ownership_lost', 'This workspace is now owned by another window. Reload this window to take ownership.');
		}
		return this.accept(request, this.validated(request));
	}

	async started(id: RunId): Promise<StartOutcome> {
		const run = this.runs.get(id);
		if (!run) {
			return { state: 'closed' };
		}
		await run.settled;
		const facts = this.runs.get(id) === run && !run.closing ? run.facts : undefined;
		const prompt = run.prompt ? { prompt: run.prompt } : {};
		if (!facts) {
			return { state: 'closed', ...prompt };
		}
		return facts.lifecycle === 'running' ? { state: 'running', ...prompt } : { state: 'failed', ...(facts.error ? { error: facts.error.reason } : {}), ...prompt };
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
			throw invalid(request.name === undefined || !request.cli || !request.location ? 'missing_argument' : 'invalid_argument', problems.join(' '));
		}
		return location;
	}

	private accept(request: LaunchRequest, location: Location, options: StartOptions = {}): RunId {
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
			// Every launch reads the setting; a child keeps its creator's tree, not its creator's YOLO (RULES-4.3)
			yolo: this.deps.yolo(),
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
			...(request.model !== undefined ? { model: request.model.trim() } : {}),
			...(request.effort !== undefined ? { effort: request.effort.trim() } : {}),
			tools: 'not_injected',
			...(promptLine ? { promptLine } : {})
		};
		if (options.pin) {
			for (const other of this.runs.values()) { if (other.facts.pin === options.pin) { this.losePin(other); } }
		}
		let settle!: () => void;
		const run: Run = { facts, closing: false, settled: new Promise(resolve => settle = resolve) };
		// Persist a request-bearing accepted run before creating its worktree or process, including starts interrupted by reload.
		this.rememberRequest(facts, true);
		if (options.restoring) { this.restoring.add(id); }
		this.runs.set(id, run);
		// The person's own launch shows its terminal; an agent's opens in the background, the person's focus kept (LIFECYCLE-2.2)
		this.deps.execution.openPair(pairOf(facts), { reveal: options.reveal !== false && !byAgent });
		if (options.pin) { this.deps.execution.pinTab?.(id, true); }
		this.emit({ run: id, kind: 'added' });
		this.deps.log.event(`Accepted ${facts.alias} ${JSON.stringify(facts.name)} (${facts.cli}) in ${facts.cwd} [${id}]${byAgent ? ` for agent ${byAgent.run}` : ''}`);
		void this.start(run, request, location, options).catch(err => this.deps.log.event(`The start of ${run.facts.alias} failed unexpectedly: ${messageOf(err)}`)).finally(settle);
		return id;
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
			return this.fail(run, `The working location ${run.facts.cwd} is no longer available.`, 'location');
		}
		let plan: LaunchPlan;
		try {
			const tools = this.deps.tools?.(run.facts.id);
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
		if (plan.prompt) {
			run.prompt = plan.prompt;
		}
		this.update(run, {
			displayName: plan.displayName, command: plan.command, cwd: plan.cwd, sessionId, resumable: false,
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
			const started = await this.deps.execution.spawn(run.facts.id, plan, meta);
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
			this.update(run, { tools: 'available' }, 'reported');
			if (run.facts.pid !== undefined) {
				this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
			}
		}
	}

	/** Whether the run is still wanted: closing it during startup prevents a later spawn (WORKTREES-2.5, RULES-5.2). */
	private live(run: Run): boolean {
		return !this.disposed && !this.ownershipLost && this.runs.get(run.facts.id) === run && !run.closing;
	}

	/** The launch failed: its pair kept red with why in the person's words, the English in the log (RULES-3.3, UX-2.4). */
	private fail(run: Run, english: string, source: string, err?: unknown): void {
		if (!this.live(run)) {
			return;
		}
		const at = this.deps.clock.now();
		const effects = run.worktree ? { worktree: run.worktree } : {};
		const reason = err !== undefined && this.deps.describe ? this.deps.describe(err, english) : english;
		this.update(run, { lifecycle: 'ended', end: { kind: 'failed', at }, error: { reason, source, at, ...effects } }, 'lifecycle');
		this.deps.execution.note(run.facts.id, reason);
		this.deps.log.event(`Could not start ${run.facts.alias}: ${english}`);
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
		run.closing = true;
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
			return 'already_ended';
		}
		if (run.facts.pid === undefined) {
			// Closed before its process started: it never starts; one already spawning is ended in the background (WORKTREES-2.5)
			this.deps.log.event(`Closed ${run.facts.alias} before its process started`);
			return 'not_started';
		}
		const result = await this.deps.execution.terminate(id).catch(err => {
			this.deps.log.event(`Could not end ${run.facts.alias}: ${messageOf(err)}`);
			return 'failed' as const;
		});
		this.deps.log.event(`Closed ${run.facts.alias}: ${result}`);
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
	 * The person closed a run's terminal tab, alone or with other editors (LIFECYCLE-3.1): a live agent ends only once they confirm it;
	 * kept, it goes on and its terminal opens again. A starting or ended one closes at once.
	 */
	private async tabClosed(id: RunId): Promise<void> {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		if (run.facts.lifecycle === 'running' && this.deps.human.confirmClose && !await this.deps.human.confirmClose({ run: id, label: labelOf(run.facts) })) {
			if (this.runs.get(id) === run) {
				this.deps.log.event(`Kept ${run.facts.alias} running: its terminal tab was closed and the person chose to keep it`);
				this.deps.execution.reopen?.(id);
			}
			return;
		}
		if (this.runs.get(id) === run) {
			await this.close(id).catch(() => undefined);
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
		const running = this.running(entry.key);
		if (running) {
			return { running };
		}
		if (entry.unavailable) {
			throw new FacadeError('INVALID', 'unsupported', entry.unavailable);
		}
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.'); }
		if (!entry.key.sessionId || entry.key.sessionId.includes('\0')) { throw invalid('invalid_argument', 'An exact conversation ID is required.'); }
		const meta = this.deps.conversations?.get(entry.key);
		if (entry.cwdChoices?.length && !meta?.cwd) { throw invalid('invalid_argument', 'Choose a working location before resuming this conversation.'); }
		const location = this.locationFor(meta?.location, meta?.cwd ?? entry.cwd);
		if (!location || location.environment !== entry.key.environment) {
			throw new FacadeError('INVALID', 'not_found', `The conversation's working location ${meta?.cwd ?? entry.cwd} is not available in this window.`);
		}
		// A name of its own, else its title, else a suggestion no agent here has (D57)
		const name = meta?.name ?? entry.title?.trim() ?? entry.key.cli;
		return this.accept(
			{ name, location: location.id, cli: entry.key.cli, origin: 'human' },
			location,
			{ reveal: options.reveal, resume: { key: entry.key }, remember: true, ...this.pinOf(entry.key) ? { pin: this.pinOf(entry.key)!.id } : {} }
		);
	}

	pin(id: RunId): void {
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.'); }
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const key = keyOf(run.facts);
		if (!run.facts.resumable || !key) {
			throw new FacadeError('INVALID', 'unsupported', `${run.facts.name}'s CLI cannot resume this exact conversation, so it cannot be pinned.`);
		}
		if (run.facts.pin) {
			return;
		}
		const pin: Pin = { id: (this.deps.newPinId?.() ?? `pin-${this.deps.newRunId()}`), conversation: key, location: run.facts.location, cwd: run.facts.cwd, name: run.facts.name };
		this.pinStore.save(pin);
		this.update(run, { pin: pin.id }, 'lifecycle');
		this.deps.execution.setMeta(id, metaOf(run.facts, run.exactResume));
		this.deps.execution.pinTab?.(id, true);
		this.deps.log.event(`Pinned ${run.facts.alias}`);
	}

	unpin(id: RunId): void {
		if (this.ownershipLost) { throw invalid('ownership_lost', 'Another window owns this workspace.'); }
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
		await this.refreshConversations().catch(err => this.deps.log.event(`Could not list running conversations before restoring Pins: ${messageOf(err)}`));
		if (this.ownershipLost || this.disposed) { return; }
		// A Pin a card already holds - running, or retained red after an abnormal exit or a failed restore - is not started again
		// on a reload: restoration happens once per opening, without a restart loop (RULES-4.2)
		const held = new Set([...this.runs.values()].map(run => run.facts.pin).filter(pin => pin !== undefined));
		const queue = this.pins().filter(pin => !held.has(pin.id) && !this.running(pin.conversation));
		// Kept as they failed: a card closed before the others finish still counts, without being looked up again
		const failed: { readonly id: RunId; readonly name: string; readonly reason: string }[] = [];
		const restoreOne = async (pin: Pin): Promise<void> => {
			if (!this.pins().some(saved => saved.id === pin.id) || this.running(pin.conversation)) { return; }
			const location = this.locationFor(pin.location, pin.cwd);
			if (!location || location.environment !== pin.conversation.environment) {
				const reason = `Its working location ${pin.cwd} is not available in this window.`;
				failed.push({ id: this.unrestorable(pin, reason), name: pin.name, reason });
				return;
			}
			const id = this.accept(
				{ name: pin.name, location: location.id, cli: pin.conversation.cli, origin: 'human' },
				location,
				{ resume: { key: pin.conversation }, reveal: false, remember: false, pin: pin.id, restoring: true }
			);
			await this.runs.get(id)?.settled;
			this.restoring.delete(id);
			const facts = this.runs.get(id)?.facts;
			if (facts?.end?.kind === 'failed') {
				failed.push({ id, name: facts.name, reason: facts.error?.reason ?? '' });
			}
		};
		const workers = Array.from({ length: Math.min(RESTORE_CONCURRENCY, queue.length) }, async () => {
			for (let pin = queue.shift(); pin && !this.ownershipLost && !this.disposed; pin = queue.shift()) {
				await restoreOne(pin);
			}
		});
		await Promise.all(workers);
		if (failed.length && !this.ownershipLost && !this.disposed) {
			// A known failure no agent is responsible for: one notification for this opening (RULES-1.8)
			const [first] = failed;
			this.deps.human.failed({ kind: 'restore', name: first.name, reason: first.reason, count: failed.length }, this.runs.has(first.id) ? { show: first.id } : {});
		}
	}

	/**
	 * A Pin that cannot start here keeps its own red card, holding the Pin, so the person sees why and can Close it, which
	 * Unpins (LIFECYCLE-3.4: failures retain their individual entries).
	 */
	private unrestorable(pin: Pin, reason: string): RunId {
		const id = this.deps.newRunId();
		const at = this.deps.clock.now();
		const facts: RunFacts = {
			id, root: id, origin: 'human', tools: 'not_injected', alias: this.deps.aliases.next(), name: pin.name, cli: pin.conversation.cli, displayName: pin.conversation.cli, command: pin.conversation.cli,
			location: pin.location, cwd: pin.cwd, environment: pin.conversation.environment, yolo: this.deps.yolo(),
			createdAt: at, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, resumable: true,
			sessionId: pin.conversation.sessionId, pin: pin.id, end: { kind: 'failed', at }, error: { reason, source: 'location', at }
		};
		const run: Run = { facts, closing: false, exactResume: true, settled: Promise.resolve() };
		this.runs.set(id, run);
		this.deps.execution.openPair(pairOf(facts), { reveal: false });
		this.deps.execution.note(id, reason);
		this.retain(run);
		this.emit({ run: id, kind: 'added' });
		this.deps.log.event(`Could not restore the pinned ${JSON.stringify(pin.name)}: ${reason}`);
		return id;
	}

	/** The run holding this exact conversation: in this window, or `elsewhere` in another window of this workspace. */
	holding(key: ConversationKey): RunId | 'elsewhere' | undefined {
		return this.running(key);
	}

	private running(key: ConversationKey): RunId | 'elsewhere' | undefined {
		for (const run of this.runs.values()) {
			if (run.facts.lifecycle !== 'ended' && run.facts.sessionId === key.sessionId && run.facts.cli === key.cli && run.facts.environment === key.environment) {
				return run.facts.id;
			}
		}
		return this.elsewhere.has(conversationId(key)) ? 'elsewhere' : undefined;
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
		return this.pins().find(pin => sameConversation(pin.conversation, key));
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
			} else if (run.facts.resumable) {
				this.pin(id);
			} else {
				this.deps.log.event(`${run.facts.alias}'s tab was pinned, but its CLI cannot resume this exact conversation; no restoration intent was saved`);
				this.deps.execution.pinTab?.(id, !!run.facts.pin);
			}
		} catch (err) {
			this.deps.log.event(`Could not save the native pin of ${run.facts.alias}: ${messageOf(err)}`);
			this.deps.execution.pinTab?.(id, !!run.facts.pin);
		}
	}

	/** A CLI changed its session (for example after /clear): the record and Pin follow once the new identity is known (LIFECYCLE-3.4). */
	private identified(id: RunId, sessionId: string | null, cwd?: string): void {
		if (this.disposed || this.ownershipLost) { return; }
		const run = this.runs.get(id);
		if (!run || run.facts.lifecycle === 'ended' || (run.facts.sessionId === sessionId && run.facts.resumable && (!cwd || cwd === run.facts.cwd))) {
			return;
		}
		// Keep the last saved key while a native new/home screen has no conversation. Its existing Pin stays associated across reload.
		this.update(run, { sessionId: sessionId ?? run.facts.sessionId, resumable: !!sessionId && run.exactResume, ...cwd ? { cwd } : {} }, 'lifecycle');
		const pin = run.facts.pin ? this.pins().find(each => each.id === run.facts.pin) : undefined;
		if (pin && sessionId) {
			try { this.pinStore.save({ ...pin, cwd: run.facts.cwd, conversation: keyOf(run.facts)! }); }
			catch (err) {
				const reason = messageOf(err);
				this.deps.log.event(`Could not update the Pin of ${run.facts.alias}: ${reason}`);
				this.deps.human.failed({ kind: 'pin', name: labelOf(run.facts), reason }, { show: id });
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
			...report.activity !== run.facts.activity ? { activitySince: this.deps.clock.now() } : {},
			reporting: report.reporting,
			awaitingActivity: report.awaitingActivity,
			activityReason: report.reason,
			blocker: report.blocker,
			title: report.title ?? run.facts.title
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
		// A signal's end is abnormal though its code be 0, as node-pty reports a process killed on Linux and macOS (RULES-3.3)
		const normal = (exit.code === 0 && !exit.signal) || run.closing || exit.interruptVerified;
		this.release(exit.run);
		if (normal) {
			// A normal exit removes the pair (RULES-3.3)
			try { this.unpinned(run); } catch (err) {
				const reason = messageOf(err), at = this.deps.clock.now();
				this.update(run, { lifecycle: 'ended', end: { kind: 'failed', at }, error: { reason, source: 'pin', at } }, 'lifecycle');
				this.retain(run);
				this.deps.execution.note(exit.run, reason);
				this.deps.log.event(`Could not remove the Pin of ${run.facts.alias}: ${reason}`);
				this.deps.human.failed({ kind: 'pin', name: labelOf(run.facts), reason }, { show: exit.run });
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
	}

	private locationsRemoved(removal: LocationRemoval): void {
		const removed = new Set(removal.ids);
		for (const pin of this.pins()) { if (removed.has(pin.location)) { this.pinStore.remove(pin.id); } }
		for (const run of [...this.runs.values()]) {
			if (removed.has(run.facts.location)) {
				this.deps.log.event(`Closing ${run.facts.alias}: its working location was ${removal.cause === 'folder' ? 'removed from the workspace' : 'deleted'}`);
				void this.close(run.facts.id).catch(() => undefined);
			}
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
		run.facts = next;
		if (kind === 'lifecycle') {
			this.rememberRequest(next);
		}
		this.emit({ run: run.facts.id, kind });
	}

	private emit(change: RunChange): void {
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
		['title', 'activityReason'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
		['pid', 'startedAt'].every(key => value[key] === undefined || typeof value[key] === 'number' && Number.isFinite(value[key])) &&
		(value.blocker === undefined || isJsonObject(value.blocker) && typeof value.blocker.kind === 'string' &&
			['permission', 'question', 'auth'].includes(value.blocker.kind) && (value.blocker.text === undefined || typeof value.blocker.text === 'string')) &&
		(value.end === undefined || isJsonObject(value.end) && ['failed', 'abnormal'].includes(value.end.kind as string) && typeof value.end.at === 'number' && Number.isFinite(value.end.at) &&
		(value.end.code === undefined || typeof value.end.code === 'number') && (value.end.signal === undefined || typeof value.end.signal === 'string')) &&
		(value.error === undefined || isJsonObject(value.error) && typeof value.error.reason === 'string' && typeof value.error.source === 'string' && typeof value.error.at === 'number' && Number.isFinite(value.error.at) &&
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
	return {
		...kept,
		root: typeof record.root === 'string' && record.root ? record.root : kept.id,
		origin: record.origin === 'agent' ? 'agent' : 'human',
		tools: record.tools === 'connecting' || record.tools === 'available' || record.tools === 'unavailable' ? record.tools : 'not_injected'
	};
}

function factsOf(id: RunId, meta: RunMeta): RunFacts {
	return {
		id,
		alias: meta.alias,
		...(meta.sessionId ? { sessionId: meta.sessionId, resumable: false } : {}),
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
		...(typeof meta.model === 'string' ? { model: meta.model } : {}),
		...(typeof meta.effort === 'string' ? { effort: meta.effort } : {}),
		...(typeof meta.version === 'string' ? { version: meta.version } : {}),
		tools: meta.tools === 'connecting' || meta.tools === 'available' || meta.tools === 'unavailable' ? meta.tools : 'not_injected',
		...(typeof meta.toolsReason === 'string' ? { toolsReason: meta.toolsReason } : {}),
		...(meta.toolsProblem === 'cmd' || meta.toolsProblem === 'files' || meta.toolsProblem === 'conflict' || meta.toolsProblem === 'variable' ? { toolsProblem: meta.toolsProblem } : {}),
		...(typeof meta.toolsFile === 'string' ? { toolsFile: meta.toolsFile } : {}),
		...(typeof meta.promptLine === 'string' ? { promptLine: meta.promptLine } : {}),
		...(typeof meta.inputAdapter === 'string' ? { inputAdapter: meta.inputAdapter } : {}),
		...(isCapability(meta.inputCapability) ? { inputCapability: meta.inputCapability } : {})
	};
}

export function metaOf(facts: RunFacts, exactResume = facts.resumable): RunMeta {
	return {
		alias: facts.alias,
		exactResume: !!exactResume,
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
		origin: facts.origin,
		...(facts.model !== undefined ? { model: facts.model } : {}),
		...(facts.effort !== undefined ? { effort: facts.effort } : {}),
		...(facts.version !== undefined ? { version: facts.version } : {}),
		tools: facts.tools,
		...(facts.toolsReason !== undefined ? { toolsReason: facts.toolsReason } : {}),
		...(facts.toolsProblem !== undefined ? { toolsProblem: facts.toolsProblem } : {}),
		...(facts.toolsFile !== undefined ? { toolsFile: facts.toolsFile } : {}),
		...(facts.promptLine !== undefined ? { promptLine: facts.promptLine } : {}),
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
