/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AgentService, TITLE_READS_MS } from '../core/agents';
import { cardOf, statusOf, type CardWords } from '../ui/cardView';
import { agentOf } from '../contract/facts';
import { FacadeError, OWNERSHIP_LOST } from '../core/errors';
import { SUGGESTED_NAMES } from '../core/names';
import {
	ActivityReport, CleanupResult, Disposable, Event, ExecutionPort, ExitReport, LaunchPlan, LiveRun, Location, LocationPort,
	ConversationEntry, ConversationMeta, ConversationKey, ConversationTitlePort, Pin, PinStore,
	HumanFailure, LocationRemoval, PairFacts, PlanError, PlanRequest, RetainedRun, RunChange, RunFacts, RunId, RunMeta, TabPlace, WorktreeError, WorktreePlan
} from '../core/ports';

class Emitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event: Event<T> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) } as Disposable;
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
}

const LOCATION: Location = {
	id: 'loc-1', path: '/work/app', uri: 'file:///work/app', environment: 'local', label: 'app', kind: 'folder', opened: true, git: 'none',
	folders: [{ index: 0, name: 'app', uri: 'file:///work/app', path: '/work/app' }]
};

class FakeExecution implements ExecutionPort {
	readonly pairs = new Map<RunId, PairFacts>();
	readonly removed: RunId[] = [];
	readonly terminated: RunId[] = [];
	readonly notes: { run: RunId; text: string }[] = [];
	readonly spawned: { run: RunId; plan: LaunchPlan; meta: RunMeta }[] = [];
	readonly reports = new Emitter<ActivityReport>();
	readonly exits = new Emitter<ExitReport>();
	readonly activations = new Emitter<RunId | undefined>();
	readonly tabCloses = new Emitter<{ readonly run: RunId; readonly marked: boolean }>();
	readonly tabRenames = new Emitter<{ readonly run: RunId; readonly name: string }>();
	readonly identities = new Emitter<{ readonly run: RunId; readonly sessionId: string | null; readonly cwd?: string }>();
	readonly tabPins = new Emitter<{ readonly run: RunId; readonly pinned: boolean }>();
	readonly pinnedTabs: { run: RunId; pinned: boolean }[] = [];
	readonly onDidIdentify = this.identities.event;
	readonly onDidPinTab = this.tabPins.event;
	elsewhere: ConversationKey[] = [];
	async conversations(): Promise<readonly ConversationKey[]> { return this.elsewhere; }
	pinTab(run: RunId, pinned: boolean): void { this.pinnedTabs.push({ run, pinned }); }
	readonly spins: { run: RunId; busy: boolean }[] = [];
	spin(run: RunId, busy: boolean): void { this.spins.push({ run, busy }); }
	failSpawnFor?: (plan: LaunchPlan) => boolean;
	readonly transfers = new Emitter<void>();
	readonly toolConnections = new Emitter<RunId>();
	readonly toolDisconnections = new Emitter<RunId>();
	readonly reveals = new Map<RunId, boolean>();
	readonly reopened: RunId[] = [];
	liveRuns: LiveRun[] = [];
	spawnError: Error | undefined;
	spawnGate: Promise<void> = Promise.resolve();
	cleanup: CleanupResult = 'terminated';
	endedWindow = false;
	readonly onDidReport = this.reports.event;
	readonly onDidExit = this.exits.event;
	readonly onDidActivate = this.activations.event;
	readonly onDidClosePair = this.tabCloses.event;
	readonly placements = new Emitter<{ readonly run: RunId; readonly place: TabPlace }>();
	readonly onDidPlaceTab = this.placements.event;
	readonly onDidRenameTab = this.tabRenames.event;
	readonly onDidLoseOwnership = this.transfers.event;
	readonly onDidConnectTools = this.toolConnections.event;
	readonly onDidDisconnectTools = this.toolDisconnections.event;
	readonly hidden = new Set<RunId>();
	openPair(facts: PairFacts, options: { reveal: boolean; hidden?: boolean }): void { this.pairs.set(facts.run, facts); this.reveals.set(facts.run, options.reveal); if (options.hidden) { this.hidden.add(facts.run); } }
	note(run: RunId, text: string): void { this.notes.push({ run, text }); }
	async spawn(run: RunId, plan: LaunchPlan, meta: RunMeta): Promise<{ pid: number; startedAt: number }> {
		await this.spawnGate;
		if (this.failSpawnFor?.(plan)) { throw new Error('the CLI could not start'); }
		if (this.spawnError) {
			throw this.spawnError;
		}
		this.spawned.push({ run, plan, meta });
		if (this.namesAtSpawn && plan.exactResume && plan.sessionId) { this.identities.fire({ run, sessionId: plan.sessionId }); }
		return { pid: 4242, startedAt: 1000 };
	}
	readonly attachedRuns: RunId[] = [];
	async attach(live: LiveRun, facts: PairFacts): Promise<void> { this.attachedRuns.push(live.run); this.pairs.set(live.run, facts); }
	/** Each pinned tab opened in its turn and marked, by its run, and `selected` once a reload's or a restart's are all open. */
	readonly turns: string[] = [];
	async openPinned(run: RunId): Promise<void> {
		this.turns.push(`open ${run}`);
		// Its terminal opens and its mark goes on a moment later: another tab opening meanwhile would show here
		await new Promise(resolve => setTimeout(resolve, 5));
		this.turns.push(`marked ${run}`);
	}
	pinnedOpened(): void { this.turns.push('selected'); }
	/** What the turns were each time the activation's pinned sequence was said to be over. */
	readonly sequenceOver: string[][] = [];
	async pinnedSequenceOver(): Promise<void> { this.sequenceOver.push([...this.turns]); }
	async terminate(run: RunId): Promise<CleanupResult> { this.terminated.push(run); return this.cleanup; }
	removePair(run: RunId): void { this.pairs.delete(run); this.removed.push(run); }
	async reveal(): Promise<boolean> { return true; }
	tabOpen(run: RunId): boolean { return this.pairs.has(run) && !this.hidden.has(run); }
	reopen(run: RunId): void { this.reopened.push(run); }
	rename(run: RunId, name: string): void { const pair = this.pairs.get(run); if (pair) { this.pairs.set(run, { ...pair, name }); } }
	readonly metas = new Map<RunId, RunMeta>();
	/** Whether a started CLI names its session at once; a real one does at its first turn. */
	namesAtSpawn = true;
	setMeta(run: RunId, meta: RunMeta): void { this.metas.set(run, meta); }
	async live(): Promise<readonly LiveRun[]> { return this.liveRuns; }
	async endWindow(): Promise<void> { this.endedWindow = true; }
}

const WORKTREE: Location = { ...LOCATION, id: 'loc-wt', path: '/work/app.worktrees/fix', uri: 'file:///work/app.worktrees/fix', label: 'fix', kind: 'checkout', branch: 'fix', opened: false, git: 'ok' };

function setUp(options: {
	sessions?: boolean; failSpawnFor?: (plan: LaunchPlan) => boolean; planError?: PlanError; worktreeError?: WorktreeError; worktreeGate?: Promise<void>; removedWhileAway?: readonly string[];
	describe?: (err: unknown, english: string) => string;
	/** What each plan adds to the test's plain one: its tools, input reader, prompt path, version. */
	plan?: Partial<LaunchPlan>;
	/** Orchestration on: each start is given its own shim. */
	tools?: boolean;
	/** What the window does with a start's typing before its first turn: recorded, and settled as the test says. */
	warmUp?: (run: RunId, warmUp: NonNullable<LaunchPlan['warmUp']>) => Promise<void>;
	/** How the service waits before it looks again: the test's own, released as it says. */
	wait?: (ms: number) => Promise<void>;
	/** The conversations' titles, as the CLIs' own histories keep them (CLIS-2.4). */
	titles?: ConversationTitlePort;
	/** The service's timer: the test's own, fired as it says. */
	after?: (ms: number, fn: () => void) => Disposable;
} = {}) {
	const execution = new FakeExecution();
	execution.failSpawnFor = options.failSpawnFor;
	let pins: Pin[] = [];
	let pinId = 0;
	const conversations = new Map<string, ConversationMeta>();
	const removals = new Emitter<LocationRemoval>();
	const closes = new Emitter<void>();
	const locations: LocationPort = {
		snapshot: () => ({ locations: [LOCATION], folders: LOCATION.folders, pending: false }),
		resolve: id => id === LOCATION.id ? LOCATION : id === WORKTREE.id ? WORKTREE : undefined,
		refresh: async () => undefined,
		onDidChange: new Emitter<void>().event,
		onDidRemove: removals.event,
		removalOf: id => options.removedWhileAway?.includes(id) ? 'folder' : undefined,
		rememberLocation: cwd => { remembered.push({ location: cwd, cli: '(location)' }); return LOCATION.id; }
	};
	const created: WorktreePlan[] = [];
	const plans: PlanRequest[] = [];
	const errors: { text: string; show?: RunId }[] = [];
	const failures: HumanFailure[] = [];
	const remembered: { location: string; cli: string }[] = [];
	const retained = new Map<RunId, RetainedRun>();
	const released: RunId[] = [];
	const shims: RunId[] = [];
	const shimInputs: { run: RunId; facts: RunFacts; location: Location }[] = [];
	const log: string[] = [];
	const events: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
	let next = 0;
	let alias = 0;
	let now = 10_000;
	const agents = new AgentService({
		conversations: { get: key => conversations.get(key.sessionId), put: (key, meta) => conversations.set(key.sessionId, meta) },
		pinStore: { list: () => pins, save: pin => { pins = pins.some(each => each.id === pin.id) ? pins.map(each => each.id === pin.id ? pin : each) : [...pins, pin]; },
			remove: id => { pins = pins.filter(pin => pin.id !== id); }, reorder: ids => { pins = ids.map(id => pins.find(pin => pin.id === id)!).filter(Boolean); } },
		newPinId: () => `pin-${++pinId}`,
		execution,
		planner: {
			plan: async (request: PlanRequest) => {
				plans.push(request);
				if (options.planError) {
					throw options.planError;
				}
				return {
					...(options.sessions ? { exactResume: request.cli === 'claude', sessionId: request.resume?.sessionId ?? `session-${request.run}` } : {}), cli: request.cli, displayName: 'Claude Code', command: 'claude', executable: '/bin/claude', args: [], env: {}, cwd: request.location.path,
					tools: { state: 'not_injected' }, input: { capability: { state: 'unavailable', reason: 'no input reader in this test' } }, ...options.plan
				};
			},
			release: async run => void released.push(run),
			reconcile: async () => undefined
		},
		locations,
		worktrees: {
			availability: async () => ({ available: true }),
			plan: async (source, branch, baseRef) => {
				if (branch === 'bad name') {
					throw new WorktreeError('bad name is not a valid branch name.', 'invalid_argument');
				}
				return { source, branch, baseRef: baseRef ?? 'HEAD', baseCommit: 'abc', destination: WORKTREE.path };
			},
			create: async plan => {
				await options.worktreeGate;
				if (options.worktreeError) { throw options.worktreeError; }
				created.push(plan);
				return WORKTREE;
			},
			remove: async () => { throw new Error('the core never deletes'); }
		},
		history: { last: () => ({}), remember: (location, cli) => remembered.push({ location, cli }) },
		human: {
			failed: (failure, opts) => { failures.push(failure); errors.push({
				text: `Could not ${failure.kind} ${failure.name}: ${failure.reason}`,
				...(opts.show ? { show: opts.show } : {})
			}); },
			error: (text, opts) => errors.push({ text, ...(opts.show ? { show: opts.show } : {}) })
		},
		retained: { list: () => [...retained.values()], put: run => retained.set(run.id, run), remove: run => retained.delete(run) },
		aliases: { next: () => `#a${++alias}` },
		clock: { now: () => ++now },
		log: { event: text => log.push(text), fact: (event, fields) => events.push({ event, fields }) },
		lifetime: { onDidClose: closes.event },
		yolo: () => true,
		...(options.tools ? { tools: (run: RunId, facts: RunFacts, location: Location) => {
			shims.push(run);
			shimInputs.push({ run, facts: { ...facts }, location });
			return { command: '/runtime', args: ['/ext/dist/shim.js'], env: { FACADE_RUN: run } };
		} } : {}),
		...(options.describe ? { describe: options.describe } : {}),
		...(options.warmUp ? { warmUp: options.warmUp } : {}),
		...(options.wait ? { wait: options.wait } : {}),
		...(options.titles ? { titles: options.titles } : {}),
		...(options.after ? { after: options.after } : {}),
		newRunId: () => `run-${(++next).toString(16).padStart(32, '0')}`
	});
	const changes: RunChange[] = [];
	agents.onDidChange(change => changes.push(change));
	return { pins: () => pins, conversations, agents, execution, removals, closes, errors, failures, remembered, retained, released, shims, shimInputs, log, events, changes, created, plans, advance: (ms: number) => { now += ms; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Settles once `check` holds, looking again after each turn of the event loop. */
const until = async (check: () => boolean): Promise<void> => {
	for (let turns = 0; !check(); turns++) {
		if (turns > 1_000) { throw new Error('Timed out waiting.'); }
		await settle();
	}
};


suite('Structured lifecycle facts', () => {
	for (const outcome of ['exit', 'failed', 'close'] as const) {
		test(`${outcome} correlates the requested settings without logging prompt text`, async () => {
			const world = setUp();
			if (outcome === 'failed') { world.execution.spawnError = new Error('Spawn unavailable'); }
			const id = world.agents.launch({ name: 'Example', location: 'loc-1', cli: 'claude', origin: 'human', model: 'example-model', effort: 'high', prompt: 'PRIVATE PROMPT' });
			await world.agents.started(id);
			if (outcome === 'exit') { world.execution.exits.fire({ run: id, code: 0, interruptVerified: false }); }
			if (outcome === 'close') { world.execution.cleanup = 'failed'; await world.agents.close(id); }
			const request = world.events.find(each => each.event === 'agent_start_requested')!;
			assert.deepStrictEqual([request.fields.agent_id, request.fields.requested_model, request.fields.requested_effort], [id, 'example-model', 'high']);
			assert.strictEqual(world.events.some(each => each.event === 'agent_started'), outcome !== 'failed');
			const last = world.events.at(-1)!;
			assert.strictEqual(last.fields.agent_id, id);
			assert.strictEqual(last.event, { exit: 'agent_exited', failed: 'agent_start_failed', close: 'agent_closed' }[outcome]);
			if (outcome === 'close') { assert.strictEqual(last.fields.cleanup, 'failed', 'closing the pair is not confirmed process termination'); }
			assert.ok(!JSON.stringify(world.events).includes('PRIVATE PROMPT'));
			world.agents.dispose();
		});
	}
});

suite('Start request metadata survives the run (MCP-1.1)', () => {
	const creator = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	const request = { name: 'Child', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: creator, root: creator }, requestId: 'start-once', promptId: 'm-7', startCallId: 'original-call', resultMessageId: 'm-8' } as const;

	for (const end of ['close', 'exit', 'failed'] as const) {
		test(`${end}: the first request survives removal and reload without restoring a closed pair`, async () => {
			const world = setUp();
			if (end === 'failed') {
				world.execution.spawnError = new Error('could not start');
			}
			const id = world.agents.launch(request);
			await world.agents.started(id);
			if (end === 'exit') {
				world.execution.exits.fire({ run: id, code: 0, interruptVerified: false });
			} else {
				await world.agents.close(id);
			}
			const facts = world.agents.requested(creator, request.requestId)!;
			assert.deepStrictEqual([facts.id, facts.lifecycle, facts.end?.kind], [id, 'ended', end === 'failed' ? 'failed' : undefined]);
			assert.strictEqual(world.agents.get(id), undefined);
			assert.strictEqual(world.agents.requested('another-caller', request.requestId), undefined);
			const reload = setUp();
			reload.retained.set(id, world.retained.get(id)!);
			await reload.agents.restore();
			assert.deepStrictEqual([reload.agents.list(), [...reload.execution.pairs]], [[], []]);
			assert.strictEqual(reload.agents.requested(creator, request.requestId)?.id, id);
			assert.strictEqual(reload.agents.requested(creator, request.requestId)?.promptId, 'm-7');
			assert.strictEqual(reload.agents.requested(creator, request.requestId)?.startCallId, 'original-call');
			assert.strictEqual(reload.agents.requested(creator, request.requestId)?.resultMessageId, 'm-8');
			reload.advance(60 * 60_000);
			assert.strictEqual(reload.agents.requested(creator, request.requestId), undefined);
			assert.strictEqual(reload.retained.size, 0, 'expired metadata is removed');
		});
	}

	test('a request is recorded before asynchronous planning, even when a reload interrupts startup', async () => {
		const world = setUp();
		const id = world.agents.launch(request);
		assert.strictEqual(world.execution.spawned.length, 0);
		const saved = world.retained.get(id)!;
		assert.deepStrictEqual([saved.lifecycle, saved.requestOnly], ['starting', true]);
		const reload = setUp();
		reload.retained.set(id, saved);
		await reload.agents.restore();
		assert.strictEqual(reload.agents.requested(creator, request.requestId)?.lifecycle, 'starting');
		assert.strictEqual(reload.agents.requested(creator, request.requestId)?.resultMessageId, 'm-8');
		assert.deepStrictEqual([reload.agents.list(), reload.execution.spawned], [[], []]);
		await world.agents.close(id);
		await world.agents.started(id);
	});

	test('closing a failed launch after the request expires removes its retained card too', async () => {
		const world = setUp();
		world.execution.spawnError = new Error('could not start');
		const id = world.agents.launch(request);
		await world.agents.started(id);
		world.advance(60 * 60_000);
		await world.agents.close(id);
		await world.agents.restore();
		assert.deepStrictEqual([world.retained.size, world.agents.list()], [0, []]);
	});

	test('damaged request metadata is neither returned nor restored as a card', async () => {
		const world = setUp();
		world.retained.set('bad', { id: 'bad', requestOnly: true, creator, requestId: request.requestId, createdAt: 10_000 } as RetainedRun);
		assert.strictEqual(world.agents.requested(creator, request.requestId), undefined);
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs], world.log], [[], [], ['Ignored an invalid retained agent record.']]);
	});
});

suite('A start\'s typing before the first turn (COLLABORATION-2.2)', () => {
	const WARM_UP = { text: '/mcp', typed: '^> /mcp\\s*$', ready: '✓\\s+facade_facade\\b', opened: '^MCP Servers\\s*$', close: 'Escape' };

	test('a running start whose plan has it is handed to the window once its process started; warmedUp settles after it, at once for any other', async () => {
		const asked: [RunId, unknown][] = [];
		let finish!: () => void;
		const world = setUp({ plan: { warmUp: WARM_UP }, warmUp: async (run, warmUp) => { asked.push([run, warmUp]); await new Promise<void>(resolve => finish = resolve); } });
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'agy', origin: 'human' });
		await world.agents.started(id);
		assert.deepStrictEqual(asked, [[id, WARM_UP]]);
		let warmed = false;
		const waiting = world.agents.warmedUp(id).then(() => warmed = true);
		await settle();
		assert.strictEqual(warmed, false, 'not before the window is done');
		finish();
		await waiting;
		await world.agents.warmedUp('run-unknown');
		const plain = setUp({ warmUp: async () => { throw new Error('never asked'); } });
		const other = plain.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'human' });
		await plain.agents.started(other);
		await plain.agents.warmedUp(other);
	});

	test('a post-start creation prompt holds its run\'s input from its plan until it is settled; a native one never does (RULES-1.10)', async () => {
		const world = setUp({ plan: { warmUp: WARM_UP, prompt: { path: 'post_start', capability: { state: 'unavailable', reason: 'none' } } }, warmUp: async () => undefined });
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'agy', origin: 'agent', creator: { run: 'run-lead' as RunId, root: 'run-lead' as RunId, label: 'lead' }, promptId: 'm-1', prompt: 'Go.', promptLine: 'Go.' });
		await world.agents.started(id);
		assert.strictEqual(world.agents.creationPending(id), true);
		world.agents.creationSettled(id);
		assert.strictEqual(world.agents.creationPending(id), false);
		const native = setUp({ plan: { prompt: { path: 'native', capability: { state: 'supported', reason: 'verified' } } } });
		const other = native.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: 'run-lead' as RunId, root: 'run-lead' as RunId, label: 'lead' }, promptId: 'm-2', prompt: 'Go.', promptLine: 'Go.' });
		await native.agents.started(other);
		assert.strictEqual(native.agents.creationPending(other), false);
	});

	test('one the window could not do is logged and settles: the run goes on', async () => {
		const world = setUp({ plan: { warmUp: WARM_UP }, warmUp: async () => { throw new Error('ptyd went away'); } });
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'agy', origin: 'human' });
		await world.agents.started(id);
		await world.agents.warmedUp(id);
		assert.ok(world.log.some(line => /Could not prepare #a1's tools before its first turn: ptyd went away/.test(line)), world.log.join('\n'));
		assert.strictEqual(world.agents.get(id)?.lifecycle, 'running');
	});
});

suite('Agent lifecycle: one launch service (LIFECYCLE-1.5, 3.1; RULES-3.3)', () => {
	test('ownership transfer drops cards and pending starts without closing or forgetting the transferred processes', async () => {
		const world = setUp();
		const live = world.agents.launch({ name: 'Live', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.spawnError = new Error('retain me');
		const failed = world.agents.launch({ name: 'Failed', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.spawnError = undefined;
		const pending = world.agents.launch({ name: 'Pending', location: 'loc-1', cli: 'claude', origin: 'human' });
		world.execution.transfers.fire();
		await settle();
		await world.agents.restore();
		assert.deepStrictEqual({
			runs: world.agents.list(), terminated: world.execution.terminated, removed: world.execution.removed,
			retained: [...world.retained.keys()], started: world.execution.spawned.map(each => each.run),
			transferred: world.changes.filter(each => each.cause === 'transfer').map(each => each.run)
		}, { runs: [], terminated: [], removed: [], retained: [failed], started: [live], transferred: [live, failed, pending] });
		assert.throws(() => world.agents.launch({ name: 'Stale', location: 'loc-1', cli: 'claude', origin: 'human' }),
			(err: unknown) => err instanceof FacadeError && err.reason === 'ownership_lost' && /owned by another window/.test(err.message));
	});

	test('a retained record that cannot be removed - the store refuses the write - never keeps the live agents from being shown again (RULES-4.1)', async () => {
		const world = setUp();
		const creator = 'run-' + 'c'.repeat(32);
		const expired = 'run-' + '1'.repeat(32);
		world.retained.set(expired, { id: expired, origin: 'agent', root: creator, creator, requestId: 'old', requestOnly: true, tools: 'not_injected', alias: '#a1', name: 'Old', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'running', activity: 'unknown', reporting: false });
		world.retained.delete = () => { throw new Error('EBUSY: resource busy or locked, unlink retained.json'); };
		const live = 'run-' + '2'.repeat(32);
		world.execution.liveRuns = [{ run: live, meta: { alias: '#a2', name: 'Live', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 5 }, pid: 22, startedAt: 6, claimedElsewhere: false }];
		world.advance(2 * 60 * 60_000);
		assert.strictEqual(await world.agents.restore(), 0);
		assert.deepStrictEqual(world.agents.list().map(run => run.id), [live], 'the live agent is shown again');
		assert.ok(world.log.some(line => /Could not remove the kept record of run-1+: EBUSY/.test(line)), 'the failed cleanup is said in the log');
		assert.strictEqual(world.agents.requested(creator, 'old'), undefined, 'a request lookup is not failed by the same cleanup');
	});

	test('a run its grace ended without that end confirmed is a red card that says so, holding its Pin and never reattached; once it is no longer listed it goes and its Pin is restored (LIFECYCLE-3.5)', async () => {
		const looks: (() => void)[] = [];
		const world = setUp({ sessions: true, wait: () => new Promise<void>(resolve => looks.push(resolve)) });
		const uncertain = 'run-' + '9'.repeat(32);
		const meta = { alias: '#a9', name: 'Stuck', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 5, sessionId: 's-stuck', exactResume: true, pin: 'pin-stuck' };
		(world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore.save({ id: 'pin-stuck', conversation: { environment: 'local', cli: 'claude', sessionId: 's-stuck' }, location: 'loc-1', cwd: '/work/app', name: 'Stuck' });
		world.execution.liveRuns = [{ run: uncertain, meta, pid: 99, startedAt: 6, claimedElsewhere: false, uncertain: true }];
		await world.agents.restore();
		await world.agents.restorePins();
		assert.deepStrictEqual([world.agents.get(uncertain)?.pin, world.agents.list().length], ['pin-stuck', 1], 'its Pin is held, not restored beside it');
		const card = world.agents.get(uncertain);
		assert.deepStrictEqual([card?.lifecycle, card?.error?.reason, card?.error?.source, world.execution.notes.map(note => note.text)],
			['running', 'Could not confirm that it stopped', 'cleanup', ['Could not confirm that it stopped']]);
		assert.ok(!world.execution.attachedRuns.includes(uncertain), 'never reattached');
		// Still listed: it stays
		await until(() => looks.length === 1);
		looks.shift()!();
		await until(() => looks.length === 1);
		assert.ok(world.agents.get(uncertain));
		// No longer listed: its exit was heard, and it goes
		world.execution.liveRuns = [];
		looks.shift()!();
		await until(() => !world.agents.get(uncertain));
		assert.deepStrictEqual([world.execution.removed.includes(uncertain), world.changes.some(change => change.run === uncertain && change.kind === 'removed' && change.cause === 'exit')], [true, true]);
		// Its Pin is restored then, its exact conversation in a new run
		await until(() => world.agents.list().some(run => run.pin === 'pin-stuck'));
		assert.deepStrictEqual(world.agents.list().map(run => [run.sessionId, run.pin, run.id === uncertain]), [['s-stuck', 'pin-stuck', false]]);
	});

	test('a damaged retained record is ignored without stopping restoration, said once however often the window restores (ARCHITECTURE-4.2)', async () => {
		const world = setUp();
		world.retained.set('bad', { id: 'bad', alias: '#a1', name: 'Incomplete' } as RunFacts);
		await world.agents.restore();
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs], world.log], [[], [], ['Ignored an invalid retained agent record.']]);
	});

	test('a run that ends normally while it is reattached is never announced afterwards as added (RULES-3.3, LIFECYCLE-3.5)', async () => {
		const world = setUp();
		const run = 'run-' + '7'.repeat(32);
		world.execution.liveRuns = [{ run, meta: { alias: '#a7', name: 'Done', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 5 }, pid: 77, startedAt: 6, claimedElsewhere: false }];
		world.execution.attach = async live => { world.execution.exits.fire({ run: live.run, code: 0, interruptVerified: false }); };
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list(), world.changes.map(change => change.kind)], [[], ['removed']]);
	});

	test('an accepted launch creates its pair at once, before the process, and keeps the same run through startup (J01, LIFECYCLE-1.5)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: '  Ada Lovelace ', location: 'loc-1', cli: 'claude', origin: 'human' });
		assert.ok(world.execution.pairs.has(id), 'the terminal exists before the process');
		assert.deepStrictEqual(world.agents.get(id)?.lifecycle, 'starting');
		assert.strictEqual(world.agents.get(id)?.name, 'Ada Lovelace');
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.lifecycle, facts.phase, facts.pid, facts.displayName], ['running', 'running', 4242, 'Claude Code']);
		assert.strictEqual(world.execution.spawned.length, 1);
		assert.deepStrictEqual(world.remembered, [{ location: 'loc-1', cli: 'claude' }], 'a human launch remembers its CLI and location once the process starts');
		assert.strictEqual(world.execution.reveals.get(id), true, 'a human New Agent shows its terminal');
		assert.strictEqual(world.execution.hidden.has(id), false);
	});

	test('a name repeating among the window\'s cards shows each one\'s short ID on its tab, an empty name its ID alone; a duplicate going takes it away (LIFECYCLE-2.2)', async () => {
		const world = setUp();
		const labels = new Map<RunId, [string, boolean]>();
		(world.execution as unknown as { tabLabel: (run: RunId, alias: string, shown: boolean) => void }).tabLabel = (run, alias, shown) => labels.set(run, [alias, shown]);
		const first = world.agents.launch({ name: 'reviewer', location: 'loc-1', cli: 'claude', origin: 'human' });
		assert.deepStrictEqual(labels.get(first)?.[1], false);
		const second = world.agents.launch({ name: 'reviewer', location: 'loc-1', cli: 'claude', origin: 'human' });
		const empty = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual([labels.get(first), labels.get(second), labels.get(empty)?.[1]], [['#a1', true], ['#a2', true], true]);
		world.agents.rename(second, 'auditor');
		assert.deepStrictEqual([labels.get(first)?.[1], labels.get(second)?.[1]], [false, false]);
	});

	test('where a run\'s tab is goes with its process for a reload, which hands each run its record and opens no unpinned one\'s tab; a run with no record has none (LIFECYCLE-3.5)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.placements.fire({ run: id, place: { column: 2 } });
		assert.deepStrictEqual(world.execution.metas.get(id)?.tab, { column: 2 });
		world.execution.placements.fire({ run: id, place: 'hidden' });
		assert.strictEqual(world.execution.metas.get(id)?.tab, 'hidden');
		const reload = setUp();
		const meta = (alias: string, tab?: TabPlace) => ({ alias, name: alias, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 5, ...tab ? { tab } : {} });
		const run = (n: number) => `run-${String(n).repeat(32)}`;
		reload.execution.liveRuns = [
			{ run: run(1), meta: meta('#a1', { column: 1, activeAt: 30 } as TabPlace), pid: 1, startedAt: 1, claimedElsewhere: false },
			{ run: run(2), meta: meta('#a2', { column: 1, activeAt: 10 } as TabPlace), pid: 2, startedAt: 2, claimedElsewhere: false },
			{ run: run(3), meta: meta('#a3'), pid: 3, startedAt: 3, claimedElsewhere: false }
		];
		await reload.agents.restore();
		// Reattached as listed, the order they were last active in no longer an order of tabs: none of theirs opens
		assert.deepStrictEqual([reload.execution.attachedRuns, reload.execution.turns], [[run(1), run(2), run(3)], []]);
		assert.deepStrictEqual([reload.execution.pairs.get(run(1))?.tab, reload.execution.pairs.get(run(3))?.tab], [{ column: 1 }, undefined]);
	});

	test('a reload opens only the pinned agents\' tabs - a retained failure\'s with a Pin among them - one at a time in the Pins\' order, each marked before the next opens; every other tab stays hidden, even one its group\'s front before the reload, and the selection then goes to the last opened (LIFECYCLE-3.5, PANEL-2.1)', async () => {
		const reload = setUp();
		const pinStore = (reload.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		// The Pins' order: Cargo, the failed one, Quark, Laser - not the order the runs are listed or were last active in
		for (const session of ['s-cargo', 's-failed', 's-quark', 's-laser']) {
			pinStore.save({ id: `pin-${session}`, conversation: { environment: 'local', cli: 'claude', sessionId: session }, location: 'loc-1', cwd: '/work/app', name: session });
		}
		const meta = (alias: string, tab: TabPlace, sessionId?: string) => ({ alias, name: alias, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
			environment: 'local' as const, yolo: true, createdAt: 1, tab, ...sessionId ? { sessionId, exactResume: true } : {} });
		const run = (n: number) => `run-${String(n).repeat(32)}`;
		reload.execution.liveRuns = [
			{ run: run(1), meta: meta('#a1', { column: 1, activeAt: 50, front: true } as TabPlace), pid: 1, startedAt: 1, claimedElsewhere: false },
			{ run: run(2), meta: meta('#a2', { column: 1, activeAt: 40 } as TabPlace, 's-quark'), pid: 2, startedAt: 2, claimedElsewhere: false },
			{ run: run(3), meta: meta('#a3', { column: 2, activeAt: 10, front: true } as TabPlace), pid: 3, startedAt: 3, claimedElsewhere: false },
			{ run: run(4), meta: meta('#a4', { column: 1, activeAt: 20 } as TabPlace, 's-laser'), pid: 4, startedAt: 4, claimedElsewhere: false },
			{ run: run(6), meta: meta('#a6', { column: 2, activeAt: 5, front: true } as TabPlace, 's-cargo'), pid: 6, startedAt: 6, claimedElsewhere: false }
		];
		// Two red cards kept from before: one holding a Pin, one not - its tab open in front of group 1 then
		const retained = (n: number, tab: TabPlace, pin?: string): RetainedRun => ({ id: run(n), origin: 'human', root: run(n), tools: 'not_injected', alias: `#a${n}`, name: `Failed ${n}`, cli: 'claude',
			displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown',
			reporting: false, tab, ...pin ? { pin, resumable: true, sessionId: pin.slice(4) } : {}, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
		reload.retained.set(run(7), retained(7, { column: 1, front: true } as TabPlace));
		reload.retained.set(run(8), retained(8, 'hidden', 'pin-s-failed'));
		await reload.agents.restore();
		// Every card back, every process reattached as listed, the red cards' tabs hidden at first
		assert.deepStrictEqual([reload.agents.list().length, reload.execution.attachedRuns, [run(7), run(8)].map(id => reload.execution.hidden.has(id))],
			[7, [run(1), run(2), run(3), run(4), run(6)], [true, true]]);
		// Then the pinned ones' tabs in the Pins' order, each marked before the next opens, the selection on the last; no other tab opens
		const opened = [`open ${run(6)}`, `marked ${run(6)}`, `open ${run(8)}`, `marked ${run(8)}`, `open ${run(2)}`, `marked ${run(2)}`, `open ${run(4)}`, `marked ${run(4)}`, 'selected'];
		assert.deepStrictEqual(reload.execution.turns, opened);
		// Pin restoration has nothing to add: no tab again, no second selection
		await reload.agents.restorePins();
		assert.deepStrictEqual(reload.execution.turns, opened);
		// A reload without a pinned agent opens no tab and leaves the selection as it was
		const unpinned = setUp();
		unpinned.execution.liveRuns = [{ run: run(1), meta: meta('#a1', { column: 1, front: true } as TabPlace), pid: 1, startedAt: 1, claimedElsewhere: false }];
		await unpinned.agents.restore();
		assert.deepStrictEqual([unpinned.agents.list().length, unpinned.execution.turns], [1, []]);
	});

	test('LIFECYCLE-3.5: an activation opens its reattached and restored Pins\' tabs in one sequence in the saved order - a Pin that needs a process before or after one that survived, a retained failure and a failed start among them - and finalizes the selection once', async () => {
		const sequence = async (order: readonly string[]) => {
			const world = setUp();
			const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
			for (const name of order) {
				pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
			}
			const run = (n: number) => `run-${String(n).repeat(32)}`;
			// The survivor's process runs on; the failure kept red with its Pin from before; the others need their processes started
			world.execution.liveRuns = [{ run: run(2), meta: { alias: '#a2', name: 'Survivor', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
				environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: 's-Survivor', exactResume: true }, pid: 2, startedAt: 2, claimedElsewhere: false }];
			world.retained.set(run(8), { id: run(8), origin: 'human', root: run(8), tools: 'not_injected', alias: '#a8', name: 'Kept', cli: 'claude', displayName: 'Claude Code', command: 'claude',
				location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, tab: 'hidden',
				pin: 'pin-Kept', resumable: true, sessionId: 's-Kept', end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
			const spawn = world.execution.spawn.bind(world.execution);
			world.execution.spawn = async (id, plan, meta) => {
				await settle();
				if (meta.name === 'Broken') { throw new Error('the CLI could not start'); }
				return spawn(id, plan, meta);
			};
			await world.agents.restore();
			const before = [...world.execution.turns];
			await world.agents.restorePins();
			const name = (entry: string) => entry === 'selected' ? entry : `${entry.split(' ')[0]} ${world.agents.get(entry.split(' ')[1] as RunId)?.name}`;
			return [before.map(name), world.execution.turns.map(name), world.errors.length];
		};
		const opened = (names: readonly string[]) => [...names.flatMap(each => [`open ${each}`, `marked ${each}`]), 'selected'];
		assert.deepStrictEqual(await sequence(['Restarted', 'Survivor', 'Kept', 'Broken']), [[], opened(['Restarted', 'Survivor', 'Kept']), 1]);
		// A survivor before any Pin that needs a process opens at once; its selection still comes once, at the end
		assert.deepStrictEqual(await sequence(['Survivor', 'Broken', 'Kept', 'Restarted']), [['open Survivor', 'marked Survivor'], opened(['Survivor', 'Kept', 'Restarted']), 1]);
	});

	test('ARCHITECTURE-2.2: the activation\'s pinned sequence is said to be over once, after its last tab and its selection - whichever path ends it - and not while a Pin\'s tab is still to open', async () => {
		const pinsOf = (world: ReturnType<typeof setUp>) => (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		const pinned = (world: ReturnType<typeof setUp>, names: readonly string[]) => names.forEach(name => pinsOf(world).save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name }));
		const live = (name: string, n: number) => ({ run: `run-${String(n).repeat(32)}`, meta: { alias: `#a${n}`, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
			environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true }, pid: n, startedAt: 1, claimedElsewhere: false });
		// No Pin: over as reattachment ends
		const none = setUp();
		await none.agents.restore();
		assert.deepStrictEqual(none.execution.sequenceOver, [[]], 'with no listing asked yet');
		await none.agents.restorePins();
		assert.deepStrictEqual(none.execution.sequenceOver, [[]]);
		// Every Pin held: over after their tabs and selection, and Pin restoration says it no second time
		const held = setUp();
		pinned(held, ['Alpha']);
		held.execution.liveRuns = [live('Alpha', 1)];
		await held.agents.restore();
		const run1 = live('Alpha', 1).run;
		assert.deepStrictEqual(held.execution.sequenceOver, [[`open ${run1}`, `marked ${run1}`, 'selected']], 'with no listing asked yet');
		await held.agents.restorePins();
		assert.deepStrictEqual(held.execution.sequenceOver, [[`open ${run1}`, `marked ${run1}`, 'selected']]);
		// A Pin to restore: not over as reattachment ends, nor before the tabs behind it have opened
		const restoring = setUp();
		pinned(restoring, ['Missing', 'Alpha']);
		restoring.execution.liveRuns = [live('Alpha', 1)];
		await restoring.agents.restore();
		const before = restoring.execution.sequenceOver.length;
		await restoring.agents.restorePins();
		assert.deepStrictEqual([before, restoring.execution.sequenceOver.length, restoring.execution.sequenceOver[0].at(-1), restoring.execution.sequenceOver[0].includes(`marked ${run1}`)], [0, 1, 'selected', true]);
	});

	test('ARCHITECTURE-2.2: a later restoration that brings runs back says its pinned sequence over too, so that their old tabs are released; one that brings none says nothing, nor does one before the activation\'s sequence is over', async () => {
		const live = (name: string, n: number) => ({ run: `run-${String(n).repeat(32)}`, meta: { alias: `#a${n}`, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
			environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true }, pid: n, startedAt: 1, claimedElsewhere: false });
		const world = setUp();
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		pinStore.save({ id: 'pin-Missing', conversation: { environment: 'local', cli: 'claude', sessionId: 's-Missing' }, location: 'loc-1', cwd: '/work/app', name: 'Missing' });
		await world.agents.restore();
		// The activation's Pin still starting: a run found meanwhile is taken in by its end, which comes once
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const pins = world.agents.restorePins();
		await settle();
		world.execution.liveRuns = [live('Found', 2)];
		await world.agents.restore();
		const during = world.execution.sequenceOver.length;
		release();
		await pins;
		const ended = world.execution.sequenceOver.length;
		// Later: an earlier ptyd found late brings an unpinned run back, its tab hidden
		world.execution.liveRuns = [live('Found', 2), live('Late', 3)];
		await world.agents.restore();
		const late = world.execution.sequenceOver.length;
		// Nothing new: nothing said
		await world.agents.restore();
		assert.deepStrictEqual([during, ended, late, world.execution.sequenceOver.length, world.agents.list().some(run => run.name === 'Late')], [0, 1, 2, 2, true]);
		// A later restoration bringing back only an uncertain run's card, then one bringing back only a retained card: each says it, once
		world.execution.liveRuns = [live('Found', 2), live('Late', 3), { ...live('Unsure', 4), uncertain: true }];
		await world.agents.restore();
		const uncertain = world.execution.sequenceOver.length;
		const elsewhere = setUp();
		elsewhere.execution.spawnError = new Error('could not start');
		const failed = elsewhere.agents.launch({ name: 'Kept', location: 'loc-1', cli: 'claude', origin: 'human' });
		await elsewhere.agents.started(failed);
		const kept = 'run-' + 'c'.repeat(32);
		world.retained.set(kept, { ...elsewhere.retained.get(failed)!, id: kept });
		await world.agents.restore();
		const shown = ['Unsure', 'Kept'].map(name => world.agents.list().some(run => run.name === name));
		// The uncertain card's watch stops with the service
		world.agents.dispose(); elsewhere.agents.dispose();
		assert.deepStrictEqual([uncertain, world.execution.sequenceOver.length, shown], [3, 4, [true, true]]);
	});

	test('ARCHITECTURE-2.2, RULES-1.8: a release the window refuses does not stop restoration: reattachment and Pin restoration complete, a failed Pin is still told, and the log says why', async () => {
		const live = (name: string, n: number) => ({ run: `run-${String(n).repeat(32)}`, meta: { alias: `#a${n}`, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
			environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true }, pid: n, startedAt: 1, claimedElsewhere: false });
		const refusing = (world: ReturnType<typeof setUp>) => {
			let once = true;
			world.execution.pinnedSequenceOver = async () => {
				if (once) { once = false; throw new Error('the window component refused'); }
			};
		};
		const pinOf = (world: ReturnType<typeof setUp>, name: string) => (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore
			.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		const said = (world: ReturnType<typeof setUp>) => world.log.filter(line => line === 'Could not finish this window\'s restoration: the window component refused').length;
		// Every Pin held: the activation's sequence ends in its restore, which still resolves
		const held = setUp();
		pinOf(held, 'Alpha');
		held.execution.liveRuns = [live('Alpha', 1)];
		refusing(held);
		const reattached = await held.agents.restore().then(() => held.agents.list().map(run => run.name), err => `rejected: ${err}`);
		// A Pin to restore whose start fails: its failure is still told once the sequence ends
		const restoring = setUp();
		pinOf(restoring, 'Broken');
		restoring.execution.spawnError = new Error('could not start');
		refusing(restoring);
		await restoring.agents.restore();
		const restored = await restoring.agents.restorePins().then(() => 'resolved', err => `rejected: ${err}`);
		held.agents.dispose(); restoring.agents.dispose();
		assert.deepStrictEqual([reattached, said(held), restored, restoring.failures.map(failure => [failure.kind, failure.name]), said(restoring)],
			[['Alpha'], 1, 'resolved', [['restore', 'Broken']], 1]);
	});

	test('LIFECYCLE-3.5: a pinned run found after Pin restoration opens in a sequence of its own, in the Pins\' order and with its own selection, though a saved Pin has no run here', async () => {
		const world = setUp();
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		for (const name of ['Elsewhere', 'Xenon', 'Yarrow']) {
			pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		}
		// Each held by some ptyd, none shown yet: Pin restoration starts none of them
		world.execution.conversations = async () => ['Elsewhere', 'Xenon', 'Yarrow'].map(name => ({ environment: 'local', cli: 'claude', sessionId: `s-${name}` }));
		await world.agents.restore();
		await world.agents.restorePins();
		assert.deepStrictEqual([world.agents.list().length, world.execution.turns], [0, []]);
		// Then a ptyd that answered late: its runs listed against the Pins' order
		const meta = (alias: string, name: string) => ({ alias, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true });
		const [yarrow, xenon] = ['run-' + '7'.repeat(32), 'run-' + '6'.repeat(32)];
		world.execution.liveRuns = [{ run: yarrow, meta: meta('#a7', 'Yarrow'), pid: 7, startedAt: 1, claimedElsewhere: false }, { run: xenon, meta: meta('#a6', 'Xenon'), pid: 6, startedAt: 1, claimedElsewhere: false }];
		await world.agents.restore();
		assert.deepStrictEqual(world.execution.turns, [`open ${xenon}`, `marked ${xenon}`, `open ${yarrow}`, `marked ${yarrow}`, 'selected']);
	});

	test('LIFECYCLE-3.5: a run unpinned before its turn drops out of the tab opening, its card kept, while an earlier turn is still opening', async () => {
		const world = setUp();
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		for (const name of ['Alpha', 'Beta']) {
			pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		}
		const meta = (alias: string, name: string) => ({ alias, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true });
		const [alpha, beta] = ['run-' + '1'.repeat(32), 'run-' + '2'.repeat(32)];
		world.execution.liveRuns = [{ run: alpha, meta: meta('#a1', 'Alpha'), pid: 1, startedAt: 1, claimedElsewhere: false }, { run: beta, meta: meta('#a2', 'Beta'), pid: 2, startedAt: 1, claimedElsewhere: false }];
		const restoring = world.agents.restore();
		await until(() => world.execution.turns.includes(`open ${alpha}`));
		world.agents.unpin(beta);
		await restoring;
		assert.deepStrictEqual([world.execution.turns, world.agents.get(beta)?.pin, !!world.agents.get(beta)], [[`open ${alpha}`, `marked ${alpha}`, 'selected'], undefined, true]);
	});

	test('LIFECYCLE-3.5: an uncertain run\'s freed Pin, restored before Pin restoration, opens alone: the reattached tabs waiting for the activation\'s sequence stay waiting for it', async () => {
		const looks: (() => void)[] = [];
		const world = setUp({ sessions: true, wait: () => new Promise<void>(resolve => looks.push(resolve)) });
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		for (const name of ['Missing', 'Survivor', 'Stuck']) {
			pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		}
		const meta = (alias: string, name: string) => ({ alias, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true });
		const [survivor, stuck] = ['run-' + '2'.repeat(32), 'run-' + '9'.repeat(32)];
		const live = { run: survivor, meta: meta('#a2', 'Survivor'), pid: 2, startedAt: 1, claimedElsewhere: false };
		world.execution.liveRuns = [live, { run: stuck, meta: meta('#a9', 'Stuck'), pid: 9, startedAt: 1, claimedElsewhere: false, uncertain: true }];
		await world.agents.restore();
		assert.deepStrictEqual(world.execution.turns, []);
		// Its end heard: its Pin restored and its tab opened alone
		world.execution.liveRuns = [live];
		await until(() => looks.length === 1);
		looks.shift()!();
		await until(() => world.execution.turns.includes('selected'));
		const named = () => world.execution.turns.map(entry => entry === 'selected' ? entry : `${entry.split(' ')[0]} ${world.agents.get(entry.split(' ')[1] as RunId)?.name}`);
		const alone = named();
		// The activation's own sequence, the Pins' order, the survivor among them
		await world.agents.restorePins();
		assert.deepStrictEqual([alone, named().slice(alone.length)], [['open Stuck', 'marked Stuck', 'selected'], ['open Missing', 'marked Missing', 'open Survivor', 'marked Survivor', 'selected']]);
	});

	test('LIFECYCLE-3.5: surviving pinned tabs wait for no listing of the running conversations - all held, they open in order with one selection though it never answers; only those after a Pin no run holds wait, for Pin restoration to decide on it', async () => {
		const live = (world: ReturnType<typeof setUp>, names: readonly string[]) => {
			world.execution.liveRuns = names.map((name, i) => ({ run: `run-${String(i + 1).repeat(32)}`, meta: { alias: `#a${i + 1}`, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app',
				environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true }, pid: i + 1, startedAt: 1, claimedElsewhere: false }));
		};
		const saved = (world: ReturnType<typeof setUp>, names: readonly string[]) => {
			const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
			for (const name of names) {
				pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
			}
		};
		const named = (world: ReturnType<typeof setUp>) => world.execution.turns.map(entry => entry === 'selected' ? entry : `${entry.split(' ')[0]} ${world.agents.get(entry.split(' ')[1] as RunId)?.name}`);
		// Every saved Pin held: a ptyd that never answers its listing holds up no tab
		const held = setUp();
		saved(held, ['Beta', 'Alpha']);
		live(held, ['Alpha', 'Beta']);
		held.execution.conversations = () => new Promise(() => undefined);
		await held.agents.restore();
		void held.agents.restorePins();
		await settle();
		assert.deepStrictEqual(named(held), ['open Beta', 'marked Beta', 'open Alpha', 'marked Alpha', 'selected']);
		// A Pin no run holds in the middle: those before it open, those after it wait, in one sequence with one selection
		const partial = setUp();
		saved(partial, ['First', 'Missing', 'Last']);
		live(partial, ['Last', 'First']);
		let answer!: (keys: readonly ConversationKey[]) => void;
		partial.execution.conversations = () => new Promise(resolve => { answer = resolve; });
		await partial.agents.restore();
		const restoring = partial.agents.restorePins();
		await settle();
		const before = named(partial);
		answer([]);
		await restoring;
		assert.deepStrictEqual([before, named(partial)], [['open First', 'marked First'],
			['open First', 'marked First', 'open Missing', 'marked Missing', 'open Last', 'marked Last', 'selected']]);
	});

	test('a restart opens the restored Pins\' tabs in the Pins\' order, each once its process started and the earlier Pins\' tabs opened and took their marks - the second\'s process starting first - while the processes start two at a time; one whose start fails drops out, its tab hidden and its red card keeping its Pin (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const store = (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore;
		for (const name of ['First', 'Second', 'Broken', 'Third']) {
			store.save({ id: `pin-${name}`, conversation: { ...ENTRY.key, sessionId: name.toLowerCase() }, location: 'loc-1', cwd: ENTRY.cwd, name });
		}
		// The first Pin's process starts only when the test says, the broken one's not at all; every other's at once
		let releaseFirst!: () => void;
		const first = new Promise<void>(resolve => { releaseFirst = resolve; });
		const spawn = world.execution.spawn.bind(world.execution);
		let starting = 0;
		let most = 0;
		world.execution.spawn = async (run, plan, meta) => {
			most = Math.max(most, ++starting);
			try {
				if (meta.name === 'First') { await first; }
				await settle();
				if (meta.name === 'Broken') { throw new Error('the CLI could not start'); }
				return await spawn(run, plan, meta);
			} finally {
				starting--;
			}
		};
		const restoring = world.agents.restorePins();
		const idOf = (name: string) => world.agents.list().find(run => run.name === name)?.id;
		await until(() => world.agents.list().length === 4 && world.agents.list().every(run => run.name === 'First' || world.agents.get(run.id)?.lifecycle !== 'starting'));
		// The second and the third started, the broken one failed, while the first is still starting: no tab opened, the first's turn first
		assert.deepStrictEqual([world.execution.turns, world.agents.get(idOf('Broken')!)?.end?.kind, most], [[], 'failed', 2]);
		releaseFirst();
		await restoring;
		const [one, two, three, broken] = ['First', 'Second', 'Third', 'Broken'].map(name => idOf(name)!);
		assert.deepStrictEqual(world.execution.turns, [`open ${one}`, `marked ${one}`, `open ${two}`, `marked ${two}`, `open ${three}`, `marked ${three}`, 'selected']);
		// Each restored card's tab hidden until its turn, focus kept; the broken one's never opens, its red card keeping its Pin
		assert.deepStrictEqual([one, two, three, broken].map(id => [world.execution.hidden.has(id), world.execution.reveals.get(id)]), [[true, false], [true, false], [true, false], [true, false]]);
		assert.deepStrictEqual([world.agents.get(broken)?.pin, world.errors.map(error => error.text)], ['pin-Broken', ['Could not restore Broken: the CLI could not start']]);
	});

	test('an agent another agent starts has its card alone: its tab is not opened, and it covers nothing and takes no focus (LIFECYCLE-2.2)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Child', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: 'run-lead' as RunId, root: 'run-lead' as RunId, label: 'lead' } });
		await settle();
		assert.deepStrictEqual([world.execution.pairs.has(id), world.execution.hidden.has(id), world.execution.reveals.get(id), world.agents.get(id)?.lifecycle, world.execution.spawned[0]?.meta?.tab], [true, true, false, 'running', 'hidden']);
	});

	test('names are labels: empty strings, spaces, duplicates and human are accepted with distinct run IDs (LIFECYCLE-2.1)', () => {
		const world = setUp();
		const names = ['Ada Lovelace', 'Ada Lovelace', 'human', '@Human', '', '   '];
		const ids = names.map(name => world.agents.launch({ name, location: 'loc-1', cli: 'claude', origin: 'human' }));
		assert.strictEqual(new Set(ids).size, names.length);
		assert.deepStrictEqual(ids.map(id => world.agents.get(id)?.name), names.map(name => name.trim()));
		assert.strictEqual(world.execution.pairs.size, names.length);
	});

	test('missing fields are reported together before any effect (RULES-5.1, M02)', () => {
		const world = setUp();
		assert.throws(() => world.agents.launch({ name: undefined as unknown as string, location: '', cli: '', origin: 'human' }), (err: unknown) =>
			err instanceof FacadeError && /name must be a string/.test(err.message) && /working location is required/.test(err.message) && /CLI is required/.test(err.message));
		assert.strictEqual(world.execution.pairs.size, 0);
	});

	test('a launch that cannot be planned keeps its pair red, retained, and tells the person who started it (J04, RULES-1.8)', async () => {
		const world = setUp({ planError: new PlanError('claude is not installed in this environment.', 'not_found') });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.lifecycle, facts.end?.kind, facts.error?.reason], ['ended', 'failed', 'claude is not installed in this environment.']);
		assert.ok(world.execution.pairs.has(id), 'the failed pair is kept until closed');
		assert.ok(world.retained.has(id));
		assert.deepStrictEqual(world.errors, [{ text: 'Could not start Ada: claude is not installed in this environment.', show: id }]);
		assert.deepStrictEqual(world.remembered, [], 'a failed launch is not remembered (LIFECYCLE-1.2)');
	});

	test('a failed launch whose record cannot be written - a full disk - still tells the person who started it and keeps its red pair here (RULES-1.8, LIFECYCLE-1.5)', async () => {
		const world = setUp({ planError: new PlanError('claude is not installed in this environment.', 'not_found') });
		world.retained.set = () => { throw new Error('ENOSPC: no space left on device'); };
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.end?.kind, world.errors, world.log.filter(line => /Could not keep|ENOSPC/.test(line))], [
			'failed',
			[{ text: 'Could not start Ada: claude is not installed in this environment.', show: id }],
			['Could not keep the failed start of #a1 for a reload: ENOSPC: no space left on device']
		]);
	});

	test('a restore whose listing fails answers undefined and shows nothing; tried again once ptyd answers, it shows the live and retained agents, never one this window closed meanwhile (LIFECYCLE-3.5, 3.1, PANEL-1.1)', async () => {
		const world = setUp();
		const failed = 'run-' + '9'.repeat(32);
		world.retained.set(failed, { id: failed, origin: 'human', root: failed, tools: 'not_injected', alias: '#a9', name: 'Failed', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
		const meta = (name: string): RunMeta => ({ alias: '#a7', name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 5 });
		const kept = 'run-' + '7'.repeat(32);
		let answering = false;
		world.execution.live = async () => {
			if (!answering) {
				throw new Error('ptyd did not answer hello within 5000 ms.');
			}
			return [
				{ run: kept, meta: meta('Kept'), pid: 77, startedAt: 6, claimedElsewhere: false },
				{ run: closed, meta: meta('Closed'), pid: 4242, startedAt: 7, claimedElsewhere: false }
			];
		};
		assert.strictEqual(await world.agents.restore(), undefined);
		assert.strictEqual(await world.agents.restore(), undefined);
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs.keys()]], [[], []], 'nothing shown before ownership is known');
		// Meanwhile the person launched and closed an agent: its process's cleanup is not done when the listing answers
		const closed = world.agents.launch({ name: 'Closed', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		await world.agents.close(closed);
		answering = true;
		assert.strictEqual(await world.agents.restore(), 0);
		assert.deepStrictEqual(world.agents.list().map(run => run.id).sort(), [failed, kept].sort());
		assert.deepStrictEqual(world.log.filter(line => /list the agents|Listed the agents/.test(line)), [
			'Could not list the agents still running for this window, trying again: ptyd did not answer hello within 5000 ms.',
			'Listed the agents still running for this window.'
		], 'the same failure said once');
	});

	test('a failed card of a location removed while no window showed it is not brought back after the restart (RULES-2.4)', async () => {
		const world = setUp({ removedWhileAway: ['loc-gone'] });
		const id = 'run-' + '8'.repeat(32);
		world.retained.set(id, { id, origin: 'human', root: id, tools: 'not_injected', alias: '#a8', name: 'Gone', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-gone', cwd: '/work/gone', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list().map(run => run.id), world.execution.pairs.has(id), world.retained.has(id)], [[], false, false]);
	});

	test('explicit close removes card and terminal at once and cleans up in the background (J07, LIFECYCLE-3.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const closing = world.agents.close(id);
		assert.strictEqual(world.agents.get(id), undefined, 'gone from the record at once');
		assert.deepStrictEqual(world.execution.removed, [id], 'its terminal is gone at once');
		assert.strictEqual(await closing, 'terminated');
		world.execution.exits.fire({ run: id, code: 143, interruptVerified: false });
		assert.strictEqual(world.agents.get(id), undefined, 'its later exit does not bring it back');
	});

	test('a close removes the card and terminal at once even where its kept record cannot be removed - the store refuses the write (LIFECYCLE-3.1)', async () => {
		const world = setUp({ planError: new PlanError('claude is not installed in this environment.', 'not_found') });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.ok(world.retained.has(id), 'its failed start is kept for a reload');
		world.retained.delete = () => { throw new Error('Timed out after 5 seconds waiting for another window to release the lock'); };
		assert.strictEqual(await world.agents.close(id), 'already_ended');
		assert.deepStrictEqual([world.agents.get(id), world.execution.removed, world.changes.filter(change => change.kind === 'removed').map(change => change.run)], [undefined, [id], [id]]);
		assert.ok(world.log.some(line => /Could not remove the kept record of run-.*: Timed out/.test(line)));
	});

	test('closing during startup prevents the later spawn; one already asked for is ended, and the close says how it went, never that nothing started - a worktree is deleted only once its processes ended (WORKTREES-2.5, 3.2, RULES-5.2)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => release = resolve);
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.cleanup = 'unconfirmed';
		assert.strictEqual(await world.agents.close(id), 'unconfirmed');
		assert.deepStrictEqual(world.execution.terminated, [id]);
		release();
		await settle();
		assert.strictEqual(world.agents.get(id), undefined);
		assert.deepStrictEqual(world.remembered, []);
	});

	test('exit 0 or a verified interrupt removes the pair; an unexplained nonzero exit keeps it red with its code and no popup (J06, RULES-3.3)', async () => {
		const world = setUp();
		const normal = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		const interrupted = world.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'human' });
		const crashed = world.agents.launch({ name: 'C', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.exits.fire({ run: normal, code: 0, interruptVerified: false });
		world.execution.exits.fire({ run: interrupted, code: 130, interruptVerified: true });
		world.execution.exits.fire({ run: crashed, code: 3, interruptVerified: false });
		assert.strictEqual(world.agents.get(normal), undefined);
		assert.strictEqual(world.agents.get(interrupted), undefined);
		const facts = world.agents.get(crashed)!;
		assert.deepStrictEqual([facts.lifecycle, facts.end?.kind, facts.end?.code, facts.error?.reason], ['ended', 'abnormal', 3, 'Exited with code 3']);
		assert.deepStrictEqual(world.errors, [], 'an unknown cause is not guessed in a popup');
		assert.ok(world.execution.pairs.has(crashed));
	});

	test('an exit heard before its start is answered leaves the run ended; closing its tab then hides it, its red card staying (RULES-3.1, 3.3, LIFECYCLE-2.2)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.exits.fire({ run: id, code: 1, interruptVerified: false });
		release();
		await settle();
		world.execution.tabCloses.fire({ run: id, marked: false });
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.lifecycle, facts.end?.kind, facts.pid, world.execution.terminated], ['ended', 'abnormal', 4242, []]);
	});

	test('a rename while the CLI starts is kept with its process, as a later one is: a reloaded window shows it (LIFECYCLE-2.1, 3.5)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.rename(id, 'Grace');
		release();
		await settle();
		assert.strictEqual(world.execution.metas.get(id)?.name, 'Grace');
	});

	test('its tab opened and what was typed in while its CLI starts are kept with its process too: a reload shows the tab where it is and the line (LIFECYCLE-3.5, PANEL-1.4)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.placements.fire({ run: id, place: { column: 2 } });
		world.agents.said(id, 'check the build');
		release();
		await settle();
		const kept = world.execution.metas.get(id);
		assert.deepStrictEqual([kept?.tab, kept?.said], [{ column: 2 }, 'check the build']);
	});

	test('a CLI a signal ended is abnormal though its code is 0 - as node-pty reports a process killed on Linux and macOS - and keeps its red pair; the person\'s own close is not (RULES-3.3)', async () => {
		const world = setUp();
		const killed = world.agents.launch({ name: 'K', location: 'loc-1', cli: 'claude', origin: 'human' });
		const closed = world.agents.launch({ name: 'C', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.exits.fire({ run: killed, code: 0, signal: 'SIGKILL', interruptVerified: false });
		const closing = world.agents.close(closed);
		world.execution.exits.fire({ run: closed, code: 0, signal: 'SIGHUP', interruptVerified: false });
		await closing;
		const facts = world.agents.get(killed)!;
		assert.deepStrictEqual([facts.lifecycle, facts.end?.kind, facts.end?.signal, facts.error?.reason], ['ended', 'abnormal', 'SIGKILL', 'Ended by signal SIGKILL']);
		assert.ok(world.execution.pairs.has(killed));
		assert.strictEqual(world.agents.get(closed), undefined);
	});

	test('activity reports set the facts - never a title or a name; a reported error clears only when the CLI recovers (RULES-3.2, CLIS-2.3)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, observedAt: 1234 });
		assert.deepStrictEqual([world.agents.get(id)?.activity, world.agents.get(id)?.title], ['working', undefined]);
		world.execution.reports.fire({ run: id, activity: 'not_working', reporting: true, observedAt: 2345, error: 'API overloaded' });
		assert.strictEqual(world.agents.get(id)?.error?.reason, 'API overloaded');
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, observedAt: 1234 });
		assert.strictEqual(world.agents.get(id)?.error, undefined);
		// When its CLI reported its current activity: the same report again keeps that time, another activity takes its own
		const since = world.agents.get(id)!.activitySince;
		assert.strictEqual(since, 1234);
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, observedAt: 1234 });
		assert.strictEqual(world.agents.get(id)!.activitySince, since);
		assert.strictEqual(world.agents.get(id)!.name, 'A', 'reports never replace the creation name (RULES-3.2)');
		world.agents.rename(id, 'Ada');
		world.execution.reports.fire({ run: id, activity: 'not_working', reporting: true, observedAt: 2345 });
		assert.strictEqual(world.agents.get(id)!.activitySince, 2345);
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, observedAt: 1234 });
		assert.deepStrictEqual([world.agents.get(id)!.name, world.agents.get(id)!.title], ['Ada', undefined], 'later reports preserve an explicit rename too');
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, disconnected: true, reason: 'Lost' });
		assert.strictEqual(world.agents.get(id)!.activitySince, 1234);
		assert.strictEqual(world.agents.get(id)!.disconnected, true);
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true });
		assert.strictEqual(world.agents.get(id)!.activitySince, undefined, 'missing source time is not invented');
		assert.strictEqual(world.agents.get(id)!.disconnected, undefined);
	});

	test('a run is awaiting its CLI\'s activity while its reports say so, and no longer once one does not (CLIS-2.3)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, awaitingActivity: true });
		assert.deepStrictEqual([world.agents.get(id)?.lifecycle, world.agents.get(id)?.awaitingActivity, world.agents.get(id)?.activityReason], ['running', true, undefined]);
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, reason: "CLI has not reported activity", unknown: 'not_reporting' });
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual(['awaitingActivity' in facts, facts.activityReason, facts.activityUnknown], [false, "CLI has not reported activity", 'not_reporting']);
	});

	test('MCP-3.1, PANEL-1.4: why activity is unknown stays English for agents, as its report gives it, while the card words its reason in the person\'s language', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, notReady: true, reason: 'Waiting for first CLI activity report', unknown: 'waiting' });
		const facts = world.agents.get(id)!;
		const agent = agentOf(facts, { id: 'w', label: 'Workspace', environment: 'local' }, 10);
		const card = statusOf(facts, { ...WORDS, activityUnknown: why => why === 'waiting' ? '尚无初始状态 · 请查看终端' : why });
		assert.deepStrictEqual([agent.activity_reason, card.line], ['Waiting for first CLI activity report', '尚无初始状态 · 请查看终端']);
	});

	test('confirmed location removal closes the agents there; other locations continue (W05, RULES-2.4)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.removals.fire({ ids: ['loc-other'], cause: 'deleted' });
		assert.ok(world.agents.get(id));
		world.removals.fire({ ids: ['loc-1'], cause: 'folder' });
		await settle();
		assert.strictEqual(world.agents.get(id), undefined);
		assert.deepStrictEqual(world.execution.terminated, [id]);
	});

	test('a removed location\'s agents close and its Pins go, one by one, where the Pin store refuses a write - which is said (RULES-2.4, 4.2)', async () => {
		const world = continuitySetup();
		const [first, second] = ['A', 'B'].map(name => world.agents.launch({ name, location: 'loc-1', cli: 'claude', origin: 'human' }));
		await settle();
		world.agents.pin(first);
		world.agents.pin(second);
		const store = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		store.remove = () => { throw new Error('disk full'); };
		world.removals.fire({ ids: ['loc-1'], cause: 'folder' });
		await settle();
		assert.deepStrictEqual([world.agents.list(), world.execution.terminated.sort()], [[], [first, second].sort()]);
		assert.ok(world.log.some(line => /Could not unpin "A", whose working location was removed: disk full/.test(line)));
	});

	test('LIFECYCLE-2.2, 3.1: a tab the person closed is hidden - no question, no close, no cleanup - whatever its agent\'s state; its card stays and opens it again', async () => {
		const world = continuitySetup();
		const live = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const starting = world.agents.launch({ name: 'S', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		for (const run of [live, starting]) { world.execution.tabCloses.fire({ run, marked: false }); }
		await settle();
		release();
		await settle();
		assert.deepStrictEqual([!!world.agents.get(live), world.agents.get(starting)?.lifecycle, world.execution.terminated, world.failures], [true, 'running', [], []]);
	});

	test('LIFECYCLE-3.4: the person\'s close of a tab showing its pin mark Unpins it and hides it; a pinned agent\'s tab whose mark is still to follow is hidden alone, its Pin kept', async () => {
		const world = continuitySetup();
		const marked = world.agents.launch({ name: 'M', location: 'loc-1', cli: 'claude', origin: 'human' });
		const unmarked = world.agents.launch({ name: 'U', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.pin(marked);
		world.agents.pin(unmarked);
		world.execution.tabCloses.fire({ run: marked, marked: true });
		world.execution.tabCloses.fire({ run: unmarked, marked: false });
		await settle();
		assert.deepStrictEqual([world.agents.get(marked)?.pin, world.agents.get(unmarked)?.pin !== undefined, world.execution.terminated], [undefined, true, []]);
	});

	test('a marked tab\'s close whose Unpin could not be saved opens the tab again, pinned, and tells the person it could not unpin it (LIFECYCLE-3.4, RULES-1.8)', async () => {
		const world = continuitySetup();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.pin(id);
		(world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore.remove = () => { throw new Error('disk full'); };
		world.execution.tabCloses.fire({ run: id, marked: true });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.pin !== undefined, world.execution.reopened, world.execution.pinnedTabs.at(-1), world.failures.map(failure => [failure.kind, failure.reason])],
			[true, [id], { run: id, pinned: true }, [['unpin', 'disk full']]]);
	});

	test('a failure says Facade\'s own reason in the person\'s words and an empty name by its #aN, while the log keeps the English (UX-2.4, LIFECYCLE-2.1)', async () => {
		const world = setUp({ planError: new PlanError('facade.claude.path is "x", which was not found', 'not_found', { kind: 'path_not_on_path', values: ['facade.claude', '"x"', '/work/app'] }),
			describe: (err, english) => err instanceof PlanError && err.said ? `translated ${err.said.kind}` : english });
		const id = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual({ reason: world.agents.get(id)?.error?.reason, failure: world.failures.map(each => [each.name, each.reason]), log: world.log.filter(line => line.startsWith('Could not start')) },
			{ reason: 'translated path_not_on_path', failure: [['#a1', 'translated path_not_on_path']], log: ['Could not start #a1: facade.claude.path is "x", which was not found'] });
	});

	test('a facade.yolo neither true nor false refuses a launch before it takes a number: nothing is numbered, shown or recorded (UX-4.1, RULES-4.3)', () => {
		const world = setUp();
		const wrong = new FacadeError('UNAVAILABLE', 'configuration_invalid', 'facade.yolo must be true or false; received "yes"', { kind: 'yolo_type', values: ['"yes"'] });
		const deps = (world.agents as unknown as { deps: { yolo(): boolean; aliases: { next(): string } } }).deps;
		let numbered = 0;
		const next = deps.aliases.next;
		deps.aliases.next = () => { numbered++; return next(); };
		deps.yolo = () => { throw wrong; };
		assert.throws(() => world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' }), (err: unknown) => err === wrong);
		assert.deepStrictEqual([numbered, world.agents.list(), [...world.execution.pairs], world.retained.size, world.changes], [0, [], [], 0, []]);
	});

	test('a launch this window can take no agent number for is refused before any effect: no card, terminal or record (RULES-2.2)', () => {
		const world = setUp();
		const none = new FacadeError('UNAVAILABLE', 'unavailable', 'No agent number could be taken from this computer\'s counter.', { kind: 'numbers_unavailable', values: [] });
		(world.agents as unknown as { deps: { aliases: { next(): string } } }).deps.aliases.next = () => { throw none; };
		assert.throws(() => world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' }), (err: unknown) => err === none);
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs], world.retained.size, world.changes, world.plans], [[], [], 0, [], []]);
	});

	test('a working location gone before or after its launch is accepted is said in the person\'s words, never by its ID; agents and the log keep the English (UX-2.4)', async () => {
		const world = setUp({ describe: (err, english) => err instanceof FacadeError && err.said ? `translated ${[err.said.kind, ...err.said.values].join(' ')}` : english });
		let refused: unknown;
		try { world.agents.launch({ name: 'A', location: 'loc-gone', cli: 'claude', origin: 'human' }); } catch (err) { refused = err; }
		assert.ok(refused instanceof FacadeError);
		assert.deepStrictEqual([refused.code, refused.reason, refused.said, refused.message],
			['INVALID', 'invalid_argument', { kind: 'location_gone', values: [] }, 'The working location loc-gone is not available in this window.']);
		// Gone once its launch was accepted, before its start resolved it
		let asked = 0;
		(world.agents as unknown as { deps: { locations: LocationPort } }).deps.locations.resolve = id => ++asked === 1 && id === LOCATION.id ? LOCATION : undefined;
		const id = world.agents.launch({ name: 'B', location: LOCATION.id, cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual({ reason: world.agents.get(id)?.error?.reason, failure: world.failures.map(each => each.reason), log: world.log.filter(line => line.startsWith('Could not start')) },
			{ reason: 'translated location_gone', failure: ['translated location_gone'], log: ['Could not start #a1: The working location /work/app is no longer available.'] });
		// Agents read the English: its start's outcome and its kept error (list_agents, MCP-1.2)
		assert.deepStrictEqual([(await world.agents.started(id)).error, world.agents.get(id)?.error?.english],
			['The working location /work/app is no longer available.', 'The working location /work/app is no longer available.']);
	});

	test('after a reload, live runs not claimed by another window are reattached without a second launch, and failed launches return red (J09, LIFECYCLE-3.5)', async () => {
		const world = setUp();
		const meta: RunMeta = { alias: '#a7', name: 'Kept', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: false, createdAt: 5 };
		world.execution.liveRuns = [
			{ run: 'run-' + '7'.repeat(32), meta, pid: 77, startedAt: 6, claimedElsewhere: false },
			{ run: 'run-' + '8'.repeat(32), meta: { ...meta, alias: '#a8' }, pid: 88, startedAt: 7, claimedElsewhere: true }
		];
		const failed: RunFacts = { ...world.agents.list()[0] ?? {}, id: 'run-' + '9'.repeat(32), alias: '#a9', name: 'Failed', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } };
		world.retained.set(failed.id, failed);
		const actual = world.execution.liveRuns[0];
		world.retained.set(actual.run, { ...failed, id: actual.run, name: 'Stale failed-start observation' });
		await world.agents.restore();
		assert.deepStrictEqual(world.agents.list().map(run => run.alias).sort(), ['#a7', '#a9']);
		assert.strictEqual(world.agents.get('run-' + '7'.repeat(32))?.yolo, false, 'the original YOLO is kept');
		assert.strictEqual(world.execution.spawned.length, 0, 'nothing is launched again');
		assert.strictEqual(world.retained.has(actual.run), false, 'the actual process supersedes an uncertain old failed-start record');
	});

	test('a run the previous extension host still claims is counted and not shown; restored again once it lets go, it is reattached once, never launched (J09, ARCHITECTURE-2.2)', async () => {
		const world = setUp();
		const meta: RunMeta = { alias: '#a7', name: 'Kept', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 5 };
		const shown = 'run-' + '7'.repeat(32);
		const held = 'run-' + '8'.repeat(32);
		world.execution.liveRuns = [
			{ run: shown, meta, pid: 77, startedAt: 6, claimedElsewhere: false },
			{ run: held, meta: { ...meta, alias: '#a8' }, pid: 88, startedAt: 7, claimedElsewhere: true }
		];
		assert.strictEqual(await world.agents.restore(), 1);
		assert.deepStrictEqual(world.agents.list().map(run => run.alias), ['#a7']);
		// Its previous extension host gone: ptyd lists it unclaimed
		world.execution.liveRuns = world.execution.liveRuns.map(each => ({ ...each, claimedElsewhere: false }));
		assert.strictEqual(await world.agents.restore(), 0);
		assert.deepStrictEqual([world.agents.list().map(run => run.alias).sort(), [...world.execution.pairs.keys()].sort(), world.execution.spawned.length], [['#a7', '#a8'], [shown, held], 0]);
		assert.strictEqual(await world.agents.restore(), 0, 'again finds nothing new');
		assert.strictEqual(world.agents.list().length, 2);
	});

	test('a live run whose folder was removed while the extensions restarted - as removing the first folder restarts them - is closed as it is found again (RULES-2.4, WORKTREES-3.3)', async () => {
		const world = setUp({ removedWhileAway: ['loc-gone'] });
		const meta: RunMeta = { alias: '#a7', name: 'Kept', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 5 };
		const kept = 'run-' + '7'.repeat(32);
		const gone = 'run-' + '6'.repeat(32);
		world.execution.liveRuns = [
			{ run: kept, meta, pid: 77, startedAt: 6, claimedElsewhere: false },
			{ run: gone, meta: { ...meta, alias: '#a6', location: 'loc-gone', cwd: '/work/gone' }, pid: 66, startedAt: 6, claimedElsewhere: false }
		];
		await world.agents.restore();
		await settle();
		assert.deepStrictEqual([world.agents.list().map(run => run.id), world.execution.terminated], [[kept], [gone]]);
	});

	test('window closure evidence ends this window\'s runs; nothing else does (RULES-4.1)', () => {
		const world = setUp();
		world.closes.fire();
		assert.strictEqual(world.execution.endedWindow, true);
	});

	test('rename keeps the run identity with human or an empty label (LIFECYCLE-2.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.rename(id, '  Grace Hopper ');
		assert.strictEqual(world.agents.get(id)?.name, 'Grace Hopper');
		assert.strictEqual(world.execution.pairs.get(id)?.name, 'Grace Hopper');
		for (const name of ['human', '']) {
			world.agents.rename(id, name);
			assert.deepStrictEqual([world.agents.get(id)?.id, world.agents.get(id)?.name, world.execution.pairs.get(id)?.name], [id, name, name]);
		}
	});

	test('a person\'s rename of an agent\'s tab renames the agent as Rename Agent does: its card and reference, the record its process keeps and its tab (LIFECYCLE-2.2)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.tabRenames.fire({ run: id, name: '  Grace Hopper ' });
		assert.deepStrictEqual([world.agents.get(id)?.name, world.execution.pairs.get(id)?.name, world.execution.metas.get(id)?.name], ['Grace Hopper', 'Grace Hopper', 'Grace Hopper']);
		assert.ok(world.changes.some(change => change.run === id && change.kind === 'renamed'), 'its card is renamed');
		assert.deepStrictEqual(world.errors, []);
		// A failed launch's red card keeps a tab rename across a reload too
		world.execution.spawnError = new Error('boom');
		const failed = world.agents.launch({ name: 'Bea', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.tabRenames.fire({ run: failed, name: 'Cy' });
		assert.strictEqual(world.retained.get(failed)?.name, 'Cy');
	});

	test('a tab can be renamed to human or an empty string; a run no longer here is left alone (LIFECYCLE-2.1, 2.2, RULES-1.8)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.tabRenames.fire({ run: id, name: '@Human' });
		world.execution.tabRenames.fire({ run: id, name: '   ' });
		world.execution.tabRenames.fire({ run: 'run-gone', name: 'Bea' });
		assert.deepStrictEqual([world.agents.get(id)?.name, world.execution.pairs.get(id)?.name, world.execution.metas.get(id)?.name], ['', '', '']);
		assert.deepStrictEqual(world.changes.filter(change => change.kind === 'renamed').map(change => change.run), [id, id]);
		assert.deepStrictEqual(world.errors, []);
	});
});

suite('Agent launches into new worktrees (WORKTREES-2)', () => {
	test('private initialization uses the completed worktree and this run\'s creator and first message, before planning', async () => {
		let release!: () => void;
		const world = setUp({ tools: true, worktreeGate: new Promise(resolve => release = resolve) });
		const creator = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const id = world.agents.launch({ name: 'Ada', location: LOCATION.id, cli: 'claude', origin: 'agent',
			creator: { run: creator, root: creator, label: 'Ben #a42' }, promptId: 'm-10', worktree: { branch: 'fix' } });
		await settle();
		assert.strictEqual(world.shimInputs.length, 0, 'no stale parent-checkout context while creation is pending');
		release();
		await world.agents.started(id);
		const first = world.shimInputs[0];
		assert.strictEqual(first.run, id);
		assert.deepStrictEqual(first.location, WORKTREE);
		assert.deepStrictEqual([first.facts.creator, first.facts.creatorLabel, first.facts.promptId], [creator, 'Ben #a42', 'm-10']);
		const other = world.agents.launch({ name: 'Ada', location: LOCATION.id, cli: 'claude', origin: 'human' });
		await world.agents.started(other);
		assert.deepStrictEqual([world.shimInputs[1].run, world.shimInputs[1].location, world.shimInputs[1].facts.creator, world.shimInputs[1].facts.promptId], [other, LOCATION, undefined, undefined]);
		assert.strictEqual(world.shimInputs[0].facts.promptId, 'm-10', 'a later launch never replaces another run\'s context');
	});

	test('partial Git failures retain only confirmed effects and carry them through notifications and reload', async () => {
		for (const effects of [{}, { branchCreated: true }, { destinationCreated: WORKTREE.path }, { branchCreated: true, destinationCreated: WORKTREE.path }]) {
			const world = setUp({ worktreeError: new WorktreeError('disk full', 'creation_failed', effects) });
			const id = world.agents.launch({ name: '', location: LOCATION.id, cli: 'claude', origin: 'human', worktree: { branch: 'fix' } });
			await settle();
			const expected = effects.branchCreated || effects.destinationCreated
				? { ...(effects.branchCreated ? { branch: 'fix' } : {}), ...(effects.destinationCreated ? { folder: WORKTREE.path } : {}) } : undefined;
			assert.deepStrictEqual(world.agents.get(id)?.error?.worktree, expected);
			assert.deepStrictEqual(world.failures[0]?.worktree, expected);
			assert.strictEqual(world.agents.get(id)?.error?.reason, 'disk full');
			assert.strictEqual(world.execution.spawned.length, 0);
			const reloaded = setUp();
			reloaded.retained.set(id, world.retained.get(id)!);
			await reloaded.agents.restore();
			assert.deepStrictEqual(reloaded.agents.get(id)?.error?.worktree, expected);
			world.agents.dispose(); reloaded.agents.dispose();
		}
	});

	test('CLI planning and spawn failures after worktree creation retain its branch and folder', async () => {
		for (const stage of ['plan', 'spawn']) {
			const world = setUp(stage === 'plan' ? { planError: new PlanError('CLI missing', 'not_found') } : {});
			if (stage === 'spawn') { world.execution.spawnError = new Error('spawn refused'); }
			const id = world.agents.launch({ name: 'Ada', location: LOCATION.id, cli: 'claude', origin: 'human', worktree: { branch: 'fix' } });
			await settle();
			const expected = { branch: 'fix', folder: WORKTREE.path };
			assert.strictEqual(world.created.length, 1);
			assert.deepStrictEqual(world.agents.get(id)?.error?.worktree, expected);
			assert.deepStrictEqual(world.failures[0]?.worktree, expected);
			assert.deepStrictEqual(world.remembered, []);
			world.agents.dispose();
		}
	});
	test('closing a run before its process started says so, rather than that it had ended; a renamed red card keeps its name in ptyd (LIFECYCLE-2.1, 3.1)', async () => {
		let release!: () => void;
		const world = setUp({ worktreeGate: new Promise(resolve => release = resolve) });
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human', worktree: { branch: 'fix' } });
		assert.strictEqual(await world.agents.close(id), 'not_started');
		release();
		const crashed = world.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.exits.fire({ run: crashed, code: 3, interruptVerified: false });
		world.agents.rename(crashed, 'Bea');
		assert.strictEqual(world.execution.metas.get(crashed)?.name, 'Bea');
	});

	test('a launch with a new worktree creates it first, then starts the CLI there; closing during creation prevents the spawn and keeps the worktree (W03, WORKTREES-2.5)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human', worktree: { branch: 'fix' } });
		assert.strictEqual(world.agents.get(id)?.phase, 'creating_worktree');
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.location, world.agents.get(id)?.cwd, world.agents.get(id)?.phase], ['loc-wt', WORKTREE.path, 'running']);

		let release!: () => void;
		const gated = setUp({ worktreeGate: new Promise(resolve => release = resolve) });
		const closing = gated.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'human', worktree: { branch: 'fix' } });
		const completed = gated.agents.started(closing);
		await gated.agents.close(closing);
		release();
		await settle();
		assert.strictEqual(gated.created.length, 1, 'the worktree was still made');
		assert.strictEqual(gated.execution.spawned.length, 0, 'its CLI never starts');
		assert.deepStrictEqual(await completed, { state: 'closed', worktreeCreated: WORKTREE.path });
	});

	test('a worktree that cannot be made keeps the pair red with the actual reason (J04, WORKTREES-2.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human', worktree: { branch: 'bad name' } });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.end?.kind, world.agents.get(id)?.error?.reason], ['failed', 'bad name is not a valid branch name.']);
	});
});

const continuitySetup = (options: Parameters<typeof setUp>[0] = {}) => setUp({ ...options, sessions: true });
const ENTRY: ConversationEntry = { key: { environment: 'local', cli: 'claude', sessionId: 'sess-1' }, cwd: '/work/app', title: 'Saved work' };
suite('Agent continuity: Resume, Pin and new worktrees (LIFECYCLE-3.2–3.4, RULES-4.2, WORKTREES-2)', () => {
	const setUp = (options: Parameters<typeof continuitySetup>[0] = {}) => continuitySetup(options);
	test('LIFECYCLE-2.3: manual Resume generates and saves only missing/empty names; existing names, even a title, stay literal', async () => {
		for (const saved of [undefined, '', '   ', 'Saved work', 'Reviewer']) {
			const world = setUp();
			world.agents.launch({ name: 'Bolt', location: 'loc-1', cli: 'claude', origin: 'human' });
			if (saved !== undefined) { world.conversations.set('sess-1', { cwd: ENTRY.cwd, location: 'loc-1', name: saved }); }
			const id = world.agents.resume(ENTRY, { reveal: true }) as RunId;
			await world.agents.started(id);
			const name = world.agents.get(id)!.name;
			if (saved?.trim()) {
				assert.strictEqual(name, saved);
			} else {
				assert.ok(SUGGESTED_NAMES.includes(name), name);
				assert.notStrictEqual(name, 'Bolt', 'use an available suggestion');
			}
			assert.strictEqual(world.conversations.get('sess-1')?.name, name);
			await world.agents.close(id);
			const again = world.agents.resume(ENTRY, { reveal: true }) as RunId;
			await world.agents.started(again);
			assert.strictEqual(world.agents.get(again)?.name, name, 'subsequent Resume keeps the saved name');
		}
	});

	test('Resume starts the exact conversation in a new run, keeps its name, and never runs it twice (J11, LIFECYCLE-3.3)', async () => {
		const world = setUp();
		world.conversations.set('sess-1', { location: 'loc-1', cwd: '/work/app', name: 'Reviewer' });
		const id = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.name, facts.sessionId, facts.resumable], ['Reviewer', 'sess-1', true]);
		assert.deepStrictEqual(world.plans.at(-1)?.resume, { sessionId: 'sess-1' }, 'the planner is asked for the exact session, never a folder\'s latest');
		assert.deepStrictEqual(world.agents.resume(ENTRY, { reveal: true }), { running: id }, 'an exact conversation already running is not started again');
		assert.ok(world.remembered.some(each => each.location === 'loc-1' && each.cli === 'claude'), 'a human Resume updates the launch history on process start');
		assert.ok(world.remembered.some(each => each.cli === '(location)'), 'its cwd is registered as a known location (WORKTREES-1.2)');
	});

	test('LIFECYCLE-3.2: a resumed conversation is held by its run - one whose CLI cannot pin a run as its own too - until the run is closed', async () => {
		const world = setUp();
		const codex = { ...ENTRY, key: { ...ENTRY.key, cli: 'codex', sessionId: 'codex-1' } };
		const id = world.agents.resume(codex, { reveal: false }) as RunId;
		await settle();
		const held = [world.agents.holding(codex.key), world.agents.holding(ENTRY.key)];
		await world.agents.close(id);
		assert.deepStrictEqual([...held, world.agents.holding(codex.key)], [id, undefined, undefined]);
	});

	test('an unavailable conversation is refused before any effect', async () => {
		const world = setUp();
		assert.throws(() => world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'other' }, unavailable: 'Qwen Code cannot resume an exact session.' }, { reveal: false }),
			(err: unknown) => err instanceof FacadeError && err.code === 'INVALID');
		assert.deepStrictEqual(world.agents.list(), []);
	});

	test('Pin needs an exact resumable conversation; Pin and Unpin keep the native tab in step both ways (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		assert.throws(() => world.agents.pin(id), (err: unknown) => err instanceof FacadeError && err.code === 'INVALID', 'not before its session is known');
		await settle();
		world.agents.pin(id);
		const pin = world.pins()[0];
		assert.deepStrictEqual([pin.name, pin.conversation.sessionId, world.agents.get(id)?.pin], ['A', world.agents.get(id)?.sessionId, pin.id]);
		assert.deepStrictEqual(world.execution.pinnedTabs, [{ run: id, pinned: true }]);
		world.execution.tabPins.fire({ run: id, pinned: false });
		assert.deepStrictEqual(world.pins(), [], 'unpinning the tab unpins the agent');
		world.execution.tabPins.fire({ run: id, pinned: true });
		assert.strictEqual(world.pins().length, 1, 'pinning the tab pins the agent');
	});

	test('LIFECYCLE-3.4: a native tab Pin or Unpin that cannot be saved is undone on its tab and said to the person; a native pin of an agent that cannot be pinned is undone', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const store = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		const { save, remove } = store;
		const tabsAfter = (before: number) => world.execution.pinnedTabs.slice(before);
		let before = world.execution.pinnedTabs.length;
		store.save = () => { throw new Error('disk full'); };
		world.execution.tabPins.fire({ run: id, pinned: true });
		const pinning = [world.agents.get(id)?.pin, world.pins().length, tabsAfter(before)];
		store.save = save;
		world.agents.pin(id);
		before = world.execution.pinnedTabs.length;
		store.remove = () => { throw new Error('disk full'); };
		world.execution.tabPins.fire({ run: id, pinned: false });
		const unpinning = [world.agents.get(id)?.pin !== undefined, world.pins().length, tabsAfter(before)];
		store.remove = remove;
		assert.deepStrictEqual([pinning, unpinning, world.errors], [
			[undefined, 0, [{ run: id, pinned: false }]],
			[true, 1, [{ run: id, pinned: true }]],
			[{ text: 'Could not pin A: disk full', show: id }, { text: 'Could not unpin A: disk full', show: id }]
		]);
		// One whose CLI cannot resume its exact conversation: its tab's pin is undone, with nothing saved or said
		const codex = world.agents.launch({ name: 'B', location: 'loc-1', cli: 'codex', origin: 'human' });
		await settle();
		before = world.execution.pinnedTabs.length;
		world.execution.tabPins.fire({ run: codex, pinned: true });
		assert.deepStrictEqual([world.agents.get(codex)?.pin, world.pins().length, tabsAfter(before), world.errors.length], [undefined, 1, [{ run: codex, pinned: false }], 2]);
	});

	test('explicit close, normal exit and location removal Unpin; an abnormal exit keeps the Pin (RULES-4.2, EXPERIENCE-2.6)', async () => {
		const world = setUp();
		const [closed, normal, crashed, removed] = ['A', 'B', 'C', 'D'].map(name => world.agents.launch({ name, location: 'loc-1', cli: 'claude', origin: 'human' }));
		await settle();
		for (const id of [closed, normal, crashed, removed]) {
			world.agents.pin(id);
		}
		await world.agents.close(closed);
		world.execution.exits.fire({ run: normal, code: 0, interruptVerified: false });
		world.execution.exits.fire({ run: crashed, code: 9, interruptVerified: false });
		assert.deepStrictEqual(world.pins().map(pin => pin.name).sort(), ['C', 'D']);
		world.removals.fire({ ids: ['loc-1'], cause: 'deleted' });
		await settle();
		assert.deepStrictEqual(world.pins().map(pin => pin.name), [], 'location removal closes and Unpins (the crashed one is closed too)');
	});

	test('Pins restore once in saved order in the background, two at a time, skipping running sessions; failures are told once (LIFECYCLE-3.4)', async () => {
		const world = setUp({ failSpawnFor: plan => plan.sessionId === 'broken' });
		const pin = (sessionId: string, name: string): Pin => ({ id: `pin-${sessionId}`, conversation: { environment: 'local', cli: 'claude', sessionId }, location: 'loc-1', cwd: '/work/app', name });
		const running = world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'live' } }, { reveal: false }) as RunId;
		await settle();
		const saved = [pin('one', 'One'), pin('live', 'Live'), pin('broken', 'Broken'), pin('two', 'Two')];
		for (const each of [...saved].reverse()) {
			(world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save(each);
		}
		const before = world.remembered.length;
		await world.agents.restorePins();
		const restored = world.agents.list().filter(run => run.id !== running);
		assert.deepStrictEqual(restored.map(run => run.name).sort(), ['Broken', 'One', 'Two']);
		assert.ok(restored.every(run => world.execution.reveals.get(run.id) === false), 'restoration preserves focus');
		assert.ok(restored.every(run => run.pin), 'restored runs keep their Pin');
		assert.strictEqual(world.remembered.filter(each => each.cli === 'claude').length, world.remembered.slice(0, before).filter(each => each.cli === 'claude').length, 'restoration does not change the launch history');
		assert.deepStrictEqual(world.errors.map(error => error.text), ['Could not restore Broken: the CLI could not start'], 'one notification for the opening');
		assert.ok(world.pins().some(each => each.name === 'Broken'), 'a failed restoration keeps its Pin, with no restart loop');
	});

	test('restoration admits at most two starts; disposal prevents queued starts and concurrent restore calls do not duplicate', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise<void>(resolve => release = resolve);
		const store = (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore;
		for (const sessionId of ['a', 'b', 'c']) {
			store.save({ id: `pin-${sessionId}`, conversation: { ...ENTRY.key, sessionId }, location: 'loc-1', cwd: ENTRY.cwd, name: sessionId });
		}
		const started = world.agents.restorePins();
		await world.agents.restorePins();
		await settle();
		assert.strictEqual(world.plans.length, 2);
		world.agents.dispose();
		release(); await started;
		assert.strictEqual(world.plans.length, 2, 'queued third Pin never starts after disposal');
	});

	test('Pins are restored only once the running conversations are known in every ptyd: a listing that fails is asked again, never guessed (LIFECYCLE-3.5, RULES-4.2)', async () => {
		const world = setUp();
		const deps = (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void }; wait?: (ms: number) => Promise<void> } }).deps;
		// One runs in a ptyd of an earlier protocol that is not answering yet; the other runs nowhere
		deps.pinStore.save({ id: 'pin-held', conversation: { ...ENTRY.key, sessionId: 'held' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Held' });
		deps.pinStore.save({ id: 'pin-free', conversation: { ...ENTRY.key, sessionId: 'free' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Free' });
		let asked = 0;
		world.execution.conversations = async () => {
			if (++asked < 3) {
				throw new Error('The ptyd of protocol 9 took no connection now.');
			}
			return [{ ...ENTRY.key, sessionId: 'held' }];
		};
		const waits: number[] = [];
		deps.wait = async ms => { waits.push(ms); assert.deepStrictEqual(world.plans, [], 'nothing starts while the listing is incomplete'); };
		await world.agents.restorePins();
		assert.deepStrictEqual([asked, waits.length, world.plans.map(plan => plan.resume?.sessionId)], [3, 2, ['free']]);
		assert.strictEqual(world.log.filter(line => /Could not list the conversations running/.test(line)).length, 1, 'the same failure said once');
	});

	test('WORKTREES-1.2: a Resume in a cwd within a location keeps that anchor from its acceptance - before its process starts, and kept red and across a reload after a failed start - remembering the cwd only once its process started', async () => {
		const world = setUp();
		const locations = (world.agents as unknown as { deps: { locations: { conversationLocation?: (cwd: string) => Location | undefined } } }).deps.locations;
		const nested: Location = { ...LOCATION, id: 'loc-docs', path: '/work/app/docs', label: 'docs', kind: 'folder', git: 'none', opened: false, within: LOCATION.id };
		locations.conversationLocation = cwd => cwd === nested.path ? nested : undefined;
		const entry = { ...ENTRY, cwd: nested.path };
		world.execution.spawnError = new Error('could not start');
		const failed = world.agents.resume(entry, { reveal: true }) as RunId;
		const accepted = [world.agents.get(failed)?.location, world.agents.get(failed)?.within, world.remembered.filter(each => each.cli === '(location)').length];
		await world.agents.started(failed);
		const again = setUp();
		again.retained.set(failed, world.retained.get(failed)!);
		await again.agents.restore();
		assert.deepStrictEqual([accepted, world.agents.get(failed)?.lifecycle, world.agents.get(failed)?.within, world.remembered.filter(each => each.cli === '(location)').length, again.agents.get(failed)?.within],
			[['loc-docs', LOCATION.id, 0], 'ended', LOCATION.id, 0, LOCATION.id]);
		// A Resume in the location itself has none
		world.execution.spawnError = undefined;
		const plain = world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'sess-plain' } }, { reveal: true }) as RunId;
		assert.strictEqual(world.agents.get(plain)?.within, undefined);
	});

	test('RULES-2.4, WORKTREES-1.2: removing a location closes the runs in a Resume cwd within it the catalog has no record of - a failed start and one still starting - and leaves one in a folder of its own', async () => {
		const world = setUp();
		const locations = (world.agents as unknown as { deps: { locations: { conversationLocation?: (cwd: string) => Location | undefined; resolve: (id: string) => Location | undefined } } }).deps.locations;
		const nested: Location = { ...LOCATION, id: 'loc-docs', path: '/work/app/docs', label: 'docs', kind: 'folder', git: 'none', opened: false, within: LOCATION.id };
		const own: Location = { ...LOCATION, id: 'loc-own', path: '/work/app/own', label: 'own', kind: 'folder', git: 'none', opened: true };
		locations.conversationLocation = cwd => cwd === nested.path ? nested : cwd === own.path ? { ...own, within: LOCATION.id } : undefined;
		const resolve = locations.resolve;
		// The folder of its own added since: the catalog has it, with no `within`
		locations.resolve = id => id === own.id ? own : resolve(id);
		world.execution.spawnError = new Error('could not start');
		const failed = world.agents.resume({ ...ENTRY, cwd: nested.path }, { reveal: true }) as RunId;
		await world.agents.started(failed);
		world.execution.spawnError = undefined;
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const starting = world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'sess-2' }, cwd: nested.path }, { reveal: true }) as RunId;
		const kept = world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'sess-3' }, cwd: own.path }, { reveal: true }) as RunId;
		await settle();
		const before = [failed, starting, kept].map(id => world.agents.get(id)?.within);
		world.removals.fire({ ids: [LOCATION.id], cause: 'folder' });
		release();
		await settle();
		assert.deepStrictEqual([before, [failed, starting, kept].map(id => !!world.agents.get(id))], [[LOCATION.id, LOCATION.id, LOCATION.id], [false, false, true]]);
	});

	test('UX-2.4, MCP-3.1: what agents read of a lost connection and of an error its CLI reported without words is English; the card says it in the person\'s words', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await world.agents.started(id);
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, disconnected: true, reason: 'Connection to agent process lost; reconnecting', reasonWords: 'Verbindung verloren · Verbindung wird wiederhergestellt' });
		const lost = world.agents.get(id)!;
		const lostView = [agentOf(lost, { id: 'w', label: 'W', environment: 'local' }, 10), statusOf(lost, WORDS).line];
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, error: 'CLI reported an error', errorWords: 'CLI hat einen Fehler gemeldet' });
		const erred = world.agents.get(id)!;
		const agent = agentOf(erred, { id: 'w', label: 'W', environment: 'local' }, 10);
		// The same report again changes nothing
		const changes = world.changes.length;
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, error: 'CLI reported an error', errorWords: 'CLI hat einen Fehler gemeldet' });
		assert.deepStrictEqual([
			(lostView[0] as { activity_reason: string; error: { reason: string } }).activity_reason, (lostView[0] as { error: { reason: string } }).error.reason, lostView[1],
			(agent as { error: { reason: string } }).error.reason, statusOf(erred, WORDS).line, world.changes.slice(changes).filter(change => change.kind === 'lifecycle').length
		], ['Connection to agent process lost; reconnecting', 'Connection to agent process lost; reconnecting', 'Verbindung verloren · Verbindung wird wiederhergestellt', 'CLI reported an error', 'CLI hat einen Fehler gemeldet', 0]);
	});

	test('LIFECYCLE-3.4: a restored Pin whose start fails, and one that cannot start here, keep their tab hidden on record: an Unpin of either opens nothing', async () => {
		const world = setUp();
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		pinStore.save({ id: 'pin-fails', conversation: { environment: 'local', cli: 'claude', sessionId: 's-fails' }, location: 'loc-1', cwd: '/work/app', name: 'Fails' });
		pinStore.save({ id: 'pin-away', conversation: { environment: 'local', cli: 'claude', sessionId: 's-away' }, location: 'loc-gone', cwd: '/elsewhere', name: 'Away' });
		world.execution.spawnError = new Error('could not start');
		await world.agents.restore();
		await world.agents.restorePins();
		const cards = world.agents.list().map(run => [run.name, run.lifecycle, run.tab]);
		assert.deepStrictEqual(cards.sort(), [['Away', 'ended', 'hidden'], ['Fails', 'ended', 'hidden']]);
	});

	test('LIFECYCLE-3.5: a sequence of turns already taken alone - a survivor, then a Pin another window holds - still finalizes its selection, once', async () => {
		const world = setUp();
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		for (const name of ['Survivor', 'Elsewhere']) {
			pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		}
		const run1 = 'run-' + '1'.repeat(32);
		world.execution.liveRuns = [{ run: run1, meta: { alias: '#a1', name: 'Survivor', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: 's-Survivor', exactResume: true }, pid: 1, startedAt: 1, claimedElsewhere: false }];
		world.execution.conversations = async () => [{ environment: 'local', cli: 'claude', sessionId: 's-Elsewhere' }];
		await world.agents.restore();
		const before = [...world.execution.turns];
		await world.agents.restorePins();
		assert.deepStrictEqual([before, world.execution.turns, world.execution.sequenceOver.length], [[`open ${run1}`, `marked ${run1}`], [`open ${run1}`, `marked ${run1}`, 'selected'], 1]);
	});

	test('ARCHITECTURE-2.2: a freed Pin\'s restoration before the activation\'s says nothing of the activation\'s sequence being over: that comes once, after the activation\'s own', async () => {
		const looks: (() => void)[] = [];
		const world = setUp({ sessions: true, wait: () => new Promise<void>(resolve => looks.push(resolve)) });
		const pinStore = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		for (const name of ['Survivor', 'Missing', 'Stuck']) {
			pinStore.save({ id: `pin-${name}`, conversation: { environment: 'local', cli: 'claude', sessionId: `s-${name}` }, location: 'loc-1', cwd: '/work/app', name });
		}
		const meta = (alias: string, name: string) => ({ alias, name, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local' as const, yolo: true, createdAt: 1, tab: { column: 1 }, sessionId: `s-${name}`, exactResume: true });
		const live = { run: 'run-' + '2'.repeat(32), meta: meta('#a2', 'Survivor'), pid: 2, startedAt: 1, claimedElsewhere: false };
		world.execution.liveRuns = [live, { run: 'run-' + '9'.repeat(32), meta: meta('#a9', 'Stuck'), pid: 9, startedAt: 1, claimedElsewhere: false, uncertain: true }];
		await world.agents.restore();
		world.execution.liveRuns = [live];
		await until(() => looks.length === 1);
		looks.shift()!();
		await until(() => world.agents.list().some(run => run.name === 'Stuck' && run.lifecycle === 'running'));
		await settle();
		const freed = world.execution.sequenceOver.length;
		await world.agents.restorePins();
		assert.deepStrictEqual([freed, world.execution.sequenceOver.length, world.execution.sequenceOver[0]?.some(each => each.startsWith('marked') && world.agents.get(each.split(' ')[1] as RunId)?.name === 'Missing')], [0, 1, true]);
	});

	test('manual Resume after an explicit Unpin does not restore that Pin', async () => {
		const world = setUp();
		const first = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await settle();
		world.agents.pin(first);
		world.agents.unpin(first);
		world.execution.exits.fire({ run: first, code: 9, interruptVerified: false });
		const next = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await settle();
		assert.deepStrictEqual([world.agents.get(next)?.pin, world.pins()], [undefined, []]);
	});

	test('LIFECYCLE-3.4: a Pin refused before any card is told with the others and kept, the next Pins restored all the same; an empty-named one is told by its #aN', async () => {
		const world = setUp();
		const deps = (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void }; yolo: () => boolean } }).deps;
		deps.pinStore.save({ id: 'pin-refused', conversation: { environment: 'local', cli: 'claude', sessionId: 'refused' }, location: 'loc-gone', cwd: '/elsewhere/gone', name: 'Refused' });
		deps.pinStore.save({ id: 'pin-empty', conversation: { environment: 'local', cli: 'claude', sessionId: 'empty' }, location: 'loc-gone', cwd: '/elsewhere/gone', name: '' });
		// The first Pin's start is refused before it takes a number, as with a facade.yolo neither true nor false
		let reads = 0;
		const yolo = deps.yolo;
		deps.yolo = () => { if (++reads === 1) { throw new FacadeError('UNAVAILABLE', 'configuration_invalid', 'facade.yolo must be true or false; received 1'); } return yolo(); };
		await world.agents.restorePins();
		const added = world.agents.list().filter(run => run.pin !== undefined);
		assert.deepStrictEqual(added.map(run => [run.name, run.pin, run.error?.source]), [['', 'pin-empty', 'location']], 'the next Pin keeps its red card');
		assert.deepStrictEqual(world.failures.map(failure => [failure.kind, failure.name, (failure as { count?: number }).count]), [['restore', 'Refused', 1]], 'one notification for the opening: the refused Pin, which has no card to show why, with its reason');
		assert.match(world.failures[0].reason ?? '', /facade\.yolo must be true or false/);
		assert.ok(world.pins().some(pin => pin.id === 'pin-refused'), 'the refused Pin is kept for the next opening');
		assert.ok(world.log.some(line => line.startsWith('Could not restore the Pin of Refused: facade.yolo must be true or false')), world.log.join('\n'));
		// Told alone, the empty-named one is named by its #aN
		const again = setUp();
		(again.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save({ id: 'pin-empty', conversation: { environment: 'local', cli: 'claude', sessionId: 'empty' }, location: 'loc-gone', cwd: '/elsewhere/gone', name: '' });
		await again.agents.restorePins();
		const [card] = again.agents.list().filter(run => run.pin === 'pin-empty');
		assert.deepStrictEqual(again.failures.map(failure => failure.name), [card.alias]);
	});

	test('a Pin a card already holds is not restored again on a reload; a Pin whose location is gone keeps a red card holding it, told once (RULES-4.2, LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const save = (pin: Pin) => (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save(pin);
		const crashed = world.agents.resume({ ...ENTRY, key: { ...ENTRY.key, sessionId: 'crashed' } }, { reveal: false }) as RunId;
		await settle();
		world.agents.pin(crashed);
		world.execution.exits.fire({ run: crashed, code: 3, interruptVerified: false });
		save({ id: 'pin-gone', conversation: { environment: 'local', cli: 'claude', sessionId: 'gone' }, location: 'loc-gone', cwd: '/elsewhere/gone', name: 'Gone' });
		const before = world.agents.list().length;
		await world.agents.restorePins();
		const added = world.agents.list().slice(before);
		assert.deepStrictEqual(added.map(run => [run.name, run.lifecycle, run.pin, run.error?.source]), [['Gone', 'ended', 'pin-gone', 'location']], 'only the unheld Pin is tried; it keeps a red card');
		assert.deepStrictEqual(world.errors.map(error => error.text), ['Could not restore Gone: Its working location /elsewhere/gone is not available in this window.']);
		await world.agents.close(added[0].id);
		assert.ok(!world.pins().some(pin => pin.id === 'pin-gone'), 'closing its card Unpins');
	});

	test('UX-2.4: Facade\'s own refusals of a Pin, an Unpin, a Resume or a launch carry the person\'s words - another window\'s ownership, a CLI that cannot resume its conversation - and an Unpin the store refuses is told in them', async () => {
		const world = setUp({ describe: (err, english) => err instanceof FacadeError && err.said ? `translated ${err.said.kind}` : english });
		const saidOf = (act: () => unknown) => { try { act(); } catch (err) { return err instanceof FacadeError ? err.said?.kind : messageOf(err); } return 'done'; };
		const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err);
		const codex = world.agents.launch({ name: 'C', location: 'loc-1', cli: 'codex', origin: 'human' });
		const claude = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const unpinnable = saidOf(() => world.agents.pin(codex));
		world.agents.pin(claude);
		// The workspace's state refuses the write: another window owns it now
		(world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore.remove = () => { throw new FacadeError('INVALID', 'ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST); };
		world.execution.tabCloses.fire({ run: claude, marked: true });
		await settle();
		const told = world.failures.map(each => [each.kind, each.reason]);
		world.execution.transfers.fire();
		await settle();
		const refused = [() => world.agents.pin(claude), () => world.agents.unpin(claude), () => world.agents.resume(ENTRY, { reveal: false }), () => world.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', origin: 'human' })].map(saidOf);
		assert.deepStrictEqual([unpinnable, told, refused], ['pin_unsupported', [['unpin', 'translated ownership_lost']], ['ownership_lost', 'ownership_lost', 'ownership_lost', 'ownership_lost']]);
		assert.ok(world.log.some(line => line.endsWith('as its tab was closed: Another window owns this workspace.')), 'the log keeps the English');
	});

	test('Resume and a restored Pin whose working location is not in this window say so in the person\'s words, by its path, never an ID; the log keeps the English (UX-2.4, LIFECYCLE-3.2, 3.4)', async () => {
		const world = setUp({ describe: (err, english) => err instanceof FacadeError && err.said ? `translated ${[err.said.kind, ...err.said.values].join(' ')}` : english });
		let refused: unknown;
		try { world.agents.resume({ ...ENTRY, cwd: '/elsewhere/app' }, { reveal: false }); } catch (err) { refused = err; }
		assert.ok(refused instanceof FacadeError);
		assert.deepStrictEqual([refused.said, refused.message], [{ kind: 'location_not_here', values: ['/elsewhere/app'] }, 'The conversation\'s working location /elsewhere/app is not available in this window.']);
		(world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save({ id: 'pin-gone', conversation: { environment: 'local', cli: 'claude', sessionId: 'gone' }, location: 'loc-gone', cwd: '/elsewhere/gone', name: 'Gone' });
		await world.agents.restorePins();
		assert.deepStrictEqual([world.agents.list().map(run => run.error?.reason), world.errors.map(error => error.text)], [
			['translated location_not_here /elsewhere/gone'], ['Could not restore Gone: translated location_not_here /elsewhere/gone']
		]);
		assert.ok(world.log.includes('Could not restore the pinned "Gone": Its working location /elsewhere/gone is not available in this window.'));
	});

	test('Pins of a location removed while no host ran - removing the first folder restarts the extensions - are unpinned, never restored red (RULES-2.4, 4.2)', async () => {
		const world = setUp({ removedWhileAway: ['loc-gone'] });
		const save = (pin: Pin) => (world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save(pin);
		const pin = (id: string): Pin => ({ id, conversation: { environment: 'local', cli: 'claude', sessionId: id }, location: 'loc-gone', cwd: '/work/gone', name: id });
		save(pin('pin-unheld'));
		save(pin('pin-held'));
		// A failed restoration of that folder's Pin, kept red for a reload
		const failed = 'run-' + '8'.repeat(32);
		world.retained.set(failed, { id: failed, origin: 'human', root: failed, tools: 'not_injected', alias: '#a8', name: 'Held', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-gone', cwd: '/work/gone', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, resumable: true, sessionId: 'pin-held', pin: 'pin-held', end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
		await world.agents.restore();
		await world.agents.restorePins();
		assert.deepStrictEqual([world.pins(), world.agents.list(), world.errors], [[], [], []]);
	});

	test('Resuming a crashed pinned conversation hands its Pin to the new card; closing the old card keeps the Pin (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const first = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		await settle();
		world.agents.pin(first);
		const pin = world.agents.get(first)!.pin;
		world.execution.exits.fire({ run: first, code: 3, interruptVerified: false });
		const second = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		await settle();
		assert.deepStrictEqual([world.agents.get(first)!.pin, world.agents.get(second)!.pin], [undefined, pin]);
		await world.agents.close(first);
		assert.ok(world.pins().some(each => each.id === pin), 'the live card\'s Pin is kept');
	});

	test('a Pin restoration that fails at once is told once for the opening, never also as a launch failure (RULES-1.8)', async () => {
		const world = setUp({ planError: new PlanError('claude is not installed in this environment.', 'not_found') });
		(world.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save({ id: 'pin-x', conversation: { environment: 'local', cli: 'claude', sessionId: 'x' }, location: 'loc-1', cwd: '/work/app', name: 'Ada' });
		await world.agents.restorePins();
		assert.deepStrictEqual(world.errors.map(error => error.text), ['Could not restore Ada: claude is not installed in this environment.']);
	});

	test('LIFECYCLE-3.4: a resumed conversation can be pinned from its start, before its CLI names it, and still can after a reload; a new one waits for its CLI', async () => {
		const world = setUp({ sessions: true });
		world.execution.namesAtSpawn = false;
		const resumed = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		const fresh = world.agents.launch({ name: 'New', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const meta = world.execution.spawned.find(each => each.run === resumed)!.meta;
		const before = [world.agents.get(resumed)?.resumable, world.agents.get(fresh)?.resumable, meta.resumable];
		world.agents.pin(resumed);
		const pinned = world.pins().map(pin => pin.conversation.sessionId);
		// Across a reload its record says so, before its CLI has said anything
		const reload = setUp({ sessions: true });
		reload.execution.liveRuns = [{ run: resumed, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta }];
		await reload.agents.restore();
		assert.deepStrictEqual([before, pinned, reload.agents.get(resumed)?.resumable], [[true, false, true], ['sess-1'], true]);
	});

	test('LIFECYCLE-3.4: an agent can be pinned before its CLI names a conversation, from the panel or its tab; the Pin takes the one named, and a window opened before that starts a new one with the same CLI, name and location', async () => {
		const world = setUp();
		world.execution.namesAtSpawn = false;
		const [fresh, unnamed, other] = [['Fresh', 'claude'], ['Unnamed', 'claude'], ['Other', 'codex']].map(([name, cli]) => world.agents.launch({ name, location: 'loc-1', cli, origin: 'human' }));
		await settle();
		const before = [fresh, unnamed, other].map(id => [world.agents.get(id)?.resumable, world.agents.get(id)?.pinnable]);
		world.agents.pin(fresh);
		world.execution.tabPins.fire({ run: unnamed, pinned: true });
		world.execution.tabPins.fire({ run: other, pinned: true });
		assert.throws(() => world.agents.pin(other), /cannot resume/, 'a CLI that cannot name its conversation still cannot be pinned');
		const unbound = world.pins().map(pin => [pin.name, pin.conversation.cli, pin.conversation.environment, pin.conversation.sessionId, pin.cwd]);
		world.execution.identities.fire({ run: fresh, sessionId: 'named-1' });
		const bound = world.pins().map(pin => pin.conversation.sessionId);
		// The window closes before Unnamed's CLI names one: the next opening starts a new conversation in its place
		const reopened = setUp();
		reopened.execution.namesAtSpawn = false;
		for (const pin of world.pins()) {
			(reopened.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save(pin);
		}
		await reopened.agents.restorePins();
		await settle();
		const plans = reopened.plans.map(plan => [plan.name, plan.cli, plan.location.id, plan.resume ? plan.resume.sessionId : 'new']).sort();
		const restored = reopened.agents.list().find(run => run.name === 'Unnamed')!;
		reopened.execution.identities.fire({ run: restored.id, sessionId: 'named-2' });
		assert.deepStrictEqual([before, unbound, bound, world.execution.pinnedTabs.filter(each => each.run === other), plans, restored.pin, reopened.pins().map(pin => [pin.name, pin.conversation.sessionId])], [
			[[false, true], [false, true], [false, undefined]],
			[['Fresh', 'claude', 'local', undefined, '/work/app'], ['Unnamed', 'claude', 'local', undefined, '/work/app']],
			['named-1', undefined],
			[{ run: other, pinned: false }],
			[['Fresh', 'claude', 'loc-1', 'named-1'], ['Unnamed', 'claude', 'loc-1', 'new']],
			world.pins()[1].id,
			[['Fresh', 'named-1'], ['Unnamed', 'named-2']]
		]);
	});

	test('LIFECYCLE-3.4: a Pin made before its CLI named a conversation is held by its own card alone - a reload or a running conversation does not start it twice - and Close removes it', async () => {
		const world = setUp();
		world.execution.namesAtSpawn = false;
		const run = world.agents.launch({ name: 'Early', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.pin(run);
		const meta = world.execution.metas.get(run)!;
		const reload = setUp();
		(reload.agents as unknown as { deps: { pinStore: { save(p: Pin): void } } }).deps.pinStore.save(world.pins()[0]);
		reload.execution.liveRuns = [{ run, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta }];
		reload.execution.elsewhere = [{ environment: 'local', cli: 'claude', sessionId: 'unrelated' }];
		await reload.agents.restore();
		await reload.agents.restorePins();
		const after = [reload.agents.list().map(each => [each.id, each.pin, each.pinnable]), reload.plans.length];
		await reload.agents.close(run);
		assert.deepStrictEqual([after, reload.pins()], [[[[run, world.pins()[0].id, true]], 0], []]);
	});

	test('PANEL-1.4: the last message sent to a run is kept - an empty one is none, a report never replaces it - with its process across a reload', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Line', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const report = () => world.execution.reports.fire({ run: id, activity: 'working', reporting: true });
		const said: (string | undefined)[] = [];
		const seen = () => said.push(world.agents.get(id)?.said);
		report(); seen();
		world.agents.said(id, '  fix the\nlogin   bug  '); seen();
		report(); seen();
		world.agents.said(id, '/clear'); seen();
		world.agents.said(id, '   '); seen();
		const meta = world.execution.metas.get(id)!;
		const reload = setUp();
		reload.execution.liveRuns = [{ run: id, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta }];
		await reload.agents.restore();
		reload.execution.reports.fire({ run: id, activity: 'not_working', reporting: true });
		assert.deepStrictEqual([said, meta.said, reload.agents.get(id)?.said], [
			[undefined, 'fix the login bug', 'fix the login bug', '/clear', '/clear'], '/clear', '/clear'
		]);
	});

	test('LIFECYCLE-2.2: a run\'s tab spins while its dot is green - starting or working - and stops once it is idle, waits for the person or is red', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Spin', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const report = (more: Partial<ActivityReport>) => world.execution.reports.fire({ run: id, activity: 'working', reporting: true, ...more });
		report({ activity: 'unknown', reporting: false, awaitingActivity: true });
		report({ activity: 'not_working' });
		report({ activity: 'working' });
		report({ activity: 'working', blocker: { kind: 'permission' } });
		report({ activity: 'working' });
		report({ activity: 'not_working', notReady: true });
		report({ activity: 'not_working' });
		world.execution.exits.fire({ run: id, code: 3, interruptVerified: false });
		// Accepted, it starts green; this test's execution reports nothing at its start, as a window's does at once, so it stops until
		// the first report here
		assert.deepStrictEqual(world.execution.spins.filter(each => each.run === id).map(each => each.busy), [true, false, true, false, true, false, true, false]);
	});

	test('a conversation has one Pin: pinning a card whose CLI resumed a pinned conversation takes that Pin last among the Pins, and a pinned card switching to it replaces it - Unpin then leaves none to restore (RULES-4.2, LIFECYCLE-3.4, PANEL-2.1)', async () => {
		const world = setUp();
		const store = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		const save = (pin: Pin) => store.save(pin);
		save({ id: 'pin-k', conversation: { ...ENTRY.key, sessionId: 'k' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Earlier' });
		save({ id: 'pin-top', conversation: { ...ENTRY.key, sessionId: 'top' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Top' });
		const id = world.agents.launch({ name: 'New', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		// Its CLI's own resume picks the pinned conversation; the person pins the card, from its menu or its tab
		world.execution.identities.fire({ run: id, sessionId: 'k' });
		world.agents.pin(id);
		assert.deepStrictEqual([world.pins().map(pin => [pin.id, pin.name]), world.agents.get(id)?.pin], [[['pin-top', 'Top'], ['pin-k', 'New']], 'pin-k']);
		world.agents.unpin(id);
		store.remove('pin-top');
		assert.deepStrictEqual(world.pins(), []);
		// A pinned card whose CLI switches to a conversation another Pin names
		save({ id: 'pin-m', conversation: { ...ENTRY.key, sessionId: 'm' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Other' });
		world.agents.pin(id);
		const own = world.agents.get(id)!.pin;
		world.execution.identities.fire({ run: id, sessionId: 'm' });
		assert.deepStrictEqual(world.pins().map(pin => [pin.id, pin.conversation.sessionId]), [[own, 'm']]);
		world.agents.unpin(id);
		await world.agents.restorePins();
		assert.deepStrictEqual([world.pins(), world.plans.filter(plan => plan.resume).length], [[], 0], 'nothing is restored after the Unpin');
	});

	test('a CLI that changes its session updates the record and the Pin once the new identity is known (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.agents.pin(id);
		world.execution.identities.fire({ run: id, sessionId: 'after-clear' });
		assert.strictEqual(world.agents.get(id)?.sessionId, 'after-clear');
		assert.strictEqual(world.pins()[0].conversation.sessionId, 'after-clear');
	});

	test('native home/new preserves the saved intent - pinning again keeps the one Pin (LIFECYCLE-3.4) - and a confirmed switch moves its ID and cwd together', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		await settle();
		world.agents.pin(run);
		const before = world.pins()[0];
		world.execution.identities.fire({ run, sessionId: null });
		assert.strictEqual(world.agents.get(run)?.resumable, false);
		assert.strictEqual(world.agents.get(run)?.pin, before.id);
		assert.deepStrictEqual(world.pins()[0], before);
		world.agents.pin(run);
		assert.deepStrictEqual(world.pins(), [before]);
		assert.strictEqual(world.execution.metas.get(run)?.exactResume, true, 'reload must keep watching even before the new conversation exists');
		world.execution.identities.fire({ run, sessionId: 'new-native-session', cwd: '/work/app/pkg' });
		assert.deepStrictEqual([world.pins()[0].conversation.sessionId, world.pins()[0].cwd, world.agents.get(run)?.resumable], ['new-native-session', '/work/app/pkg', true]);
	});

	test('reload keeps the Pin attached to a switched run after its storage update failed, then reconciles without resuming the old session', async () => {
		const world = setUp(), reload = setUp();
		const storeOf = (world: ReturnType<typeof setUp>) => (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId; await settle(); world.agents.pin(run);
		const old = world.pins()[0], store = storeOf(world), save = store.save;
		store.save = () => { throw new Error('disk full'); };
		world.execution.identities.fire({ run, sessionId: 'switched' });
		const meta = world.execution.metas.get(run)!;
		assert.strictEqual(meta.pin, old.id);
		world.agents.dispose(); store.save = save;
		storeOf(reload).save(old);
		reload.execution.liveRuns = [{ run, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta }];
		await reload.agents.restore();
		await reload.agents.restorePins();
		assert.deepStrictEqual(reload.execution.spawned, [], 'never launch the old durable session while its Pin is held');
		assert.strictEqual(reload.agents.get(run)?.pin, old.id);
		reload.execution.identities.fire({ run, sessionId: 'switched' });
		assert.strictEqual(reload.pins()[0].conversation.sessionId, 'switched');
		reload.agents.unpin(run);
		assert.strictEqual(reload.execution.metas.get(run)?.pin, undefined);
	});

	test('MCP connecting during native New keeps identity tracking enabled across reload', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId; await settle();
		world.execution.identities.fire({ run, sessionId: null });
		world.execution.toolConnections.fire(run);
		assert.strictEqual(world.agents.get(run)?.resumable, false);
		assert.strictEqual(world.execution.metas.get(run)?.exactResume, true);
	});

	test('a normal exit with failed durable Unpin retains a visible failure, said as an unpin failure, and does not restore the stale Pin; Close can retry (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId; await settle(); world.agents.pin(run);
		const store = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore, remove = store.remove;
		store.remove = () => { throw new Error('disk full'); };
		assert.doesNotThrow(() => world.execution.exits.fire({ run, code: 0, interruptVerified: false }));
		assert.strictEqual(world.agents.get(run)?.error?.source, 'pin');
		assert.strictEqual(world.failures.at(-1)?.kind, 'unpin');
		await world.agents.restorePins();
		assert.strictEqual(world.execution.spawned.length, 1);
		store.remove = remove; await world.agents.close(run);
		assert.strictEqual(world.pins().length, 0);
	});

	test('a late native hook cannot replace an ended run or its retained Pin', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		await settle(); world.agents.pin(run);
		world.execution.exits.fire({ run, code: 1, interruptVerified: false });
		const before = world.pins()[0];
		world.execution.identities.fire({ run, sessionId: 'late-child', cwd: '/wrong' });
		assert.deepStrictEqual(world.pins()[0], before);
		assert.strictEqual(world.agents.get(run)?.sessionId, ENTRY.key.sessionId);
	});

	test('a native session switch with a failed Pin write keeps the durable intent, reports the failure and does not break identity tracking', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId; await settle(); world.agents.pin(run);
		const old = world.pins()[0];
		const store = (world.agents as unknown as { deps: { pinStore: { save(pin: Pin): void } } }).deps.pinStore;
		const save = store.save; store.save = () => { throw new Error('disk full'); };
		assert.doesNotThrow(() => world.execution.identities.fire({ run, sessionId: 'new-session' }));
		assert.deepStrictEqual(world.pins()[0], old);
		assert.strictEqual(world.agents.get(run)?.sessionId, 'new-session');
		assert.strictEqual(world.failures.at(-1)?.kind, 'pin');
		store.save = save; world.execution.identities.fire({ run, sessionId: 'third-session' });
		assert.strictEqual(world.pins()[0].conversation.sessionId, 'third-session');
	});

});

suite('Agents started by agents, and their tools (RULES-4.3, LIFECYCLE-2.2, CLIS-2.2, MCP-2.3)', () => {

	test('an agent\'s start opens in the background and joins its caller\'s tree, its YOLO read from the setting; only the person\'s own starts are remembered', async () => {
		const world = setUp();
		const lead = world.agents.launch({ name: 'lead', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const worker = world.agents.launch({ name: 'worker', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: lead, root: lead } });
		const helper = world.agents.launch({ name: 'helper', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: worker, root: lead } });
		await settle();
		assert.deepStrictEqual([lead, worker, helper].map(id => world.execution.reveals.get(id)), [true, false, false]);
		const facts = (id: RunId) => { const run = world.agents.get(id)!; return [run.origin, run.root, run.creator, run.yolo, run.lifecycle]; };
		assert.deepStrictEqual([facts(lead), facts(worker), facts(helper)], [
			['human', lead, undefined, true, 'running'], ['agent', lead, lead, true, 'running'], ['agent', lead, worker, true, 'running']
		]);
		assert.deepStrictEqual(world.remembered, [{ location: 'loc-1', cli: 'claude' }]);
		// What ptyd keeps carries the tree, so that a reload finds it again
		const kept = world.execution.spawned.find(each => each.run === helper)!.meta;
		assert.deepStrictEqual([kept.root, kept.creator, kept.origin], [lead, worker, 'agent']);
	});

	test('an agent\'s start without its calling agent is refused before any effect; model and effort are nonempty where given', () => {
		const world = setUp();
		assert.throws(() => world.agents.launch({ name: 'x', location: 'loc-1', cli: 'claude', origin: 'agent' }), (err: unknown) =>
			err instanceof FacadeError && err.reason === 'invalid_argument' && /An agent start needs its calling agent/.test(err.message));
		assert.throws(() => world.agents.launch({ name: 'x', location: 'loc-1', cli: 'claude', origin: 'human', model: '  ' }), /The model must be a nonempty string where given/);
		assert.strictEqual(world.execution.pairs.size, 0);
	});

	test('a start an agent asked for that fails tells no person: its card is red with why, for the calling agent to hear (RULES-1.8)', async () => {
		const world = setUp({ planError: new PlanError('claude was not found on PATH.', 'not_found') });
		const id = world.agents.launch({ name: 'worker', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: 'run-lead', root: 'run-lead' } });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.lifecycle, world.agents.get(id)?.error?.reason, world.failures.length], ['ended', 'claude was not found on PATH.', 0]);
		assert.deepStrictEqual(await world.agents.started(id), { state: 'failed', error: 'claude was not found on PATH.' });
		// The person's own failed start still tells the person
		world.agents.launch({ name: 'mine', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.strictEqual(world.failures.length, 1);
	});

	test('with orchestration on each start is given its own shim, with this start\'s model, effort and prompt; its first prompt line is shown, cleaned', async () => {
		const world = setUp({ tools: true });
		const id = world.agents.launch({ name: 'w', location: 'loc-1', cli: 'claude', origin: 'agent', creator: { run: 'run-lead', root: 'run-lead' }, model: ' opus ', effort: 'high', prompt: '\n  Review\u202e the API  \nthen tests' });
		await settle();
		assert.deepStrictEqual(world.shims, [id]);
		const [request] = world.plans;
		assert.deepStrictEqual([request.tools?.env.FACADE_RUN, request.model, request.effort, request.prompt], [id, 'opus', 'high', '\n  Review\u202e the API  \nthen tests']);
		assert.deepStrictEqual([world.agents.get(id)?.model, world.agents.get(id)?.promptLine], ['opus', 'Review the API']);
		// Orchestration off: no shim asked, nothing to inject
		const off = setUp();
		off.agents.launch({ name: 'x', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual([off.shims, off.plans[0].tools], [[], undefined]);
	});

	test('the plan\'s tools, input reader and version become the run\'s facts; its shim saying hello makes the tools available, kept for a reload', async () => {
		const reader = { state: 'supported' as const, reason: 'claude-frame reads its input by its layout.' };
		const world = setUp({ tools: true, plan: { tools: { state: 'injected' }, input: { adapter: 'claude-frame', capability: reader }, version: '2.1.314' } });
		const id = world.agents.launch({ name: 'a', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.tools, facts.inputAdapter, facts.inputCapability, facts.version], ['connecting', 'claude-frame', reader, '2.1.314']);
		world.execution.toolConnections.fire(id);
		assert.strictEqual(world.agents.get(id)?.tools, 'available');
		assert.strictEqual(world.execution.metas.get(id)?.tools, 'available');
		// Its shim gone, none other connected: its tools are unavailable, said so, until a shim says hello again (RULES-3.1)
		world.execution.toolDisconnections.fire(id);
		assert.deepStrictEqual([world.agents.get(id)?.tools, world.agents.get(id)?.toolsProblem, world.execution.metas.get(id)?.tools], ['unavailable', 'disconnected', 'unavailable']);
		world.execution.toolConnections.fire(id);
		assert.deepStrictEqual([world.agents.get(id)?.tools, world.agents.get(id)?.toolsProblem, world.agents.get(id)?.toolsReason], ['available', undefined, undefined]);
		// Tools the plan could not give leave the CLI running without them, with why
		const without = setUp({ tools: true, plan: { tools: { state: 'unavailable', reason: 'another facade skill is in the project' } } });
		const other = without.agents.launch({ name: 'b', location: 'loc-1', cli: 'codex', origin: 'human' });
		await settle();
		assert.deepStrictEqual([without.agents.get(other)?.lifecycle, without.agents.get(other)?.tools, without.agents.get(other)?.toolsReason], ['running', 'unavailable', 'another facade skill is in the project']);
		// A shim going says nothing of tools that never connected: theirs stays why the plan gave none
		without.execution.toolDisconnections.fire(other);
		assert.deepStrictEqual([without.agents.get(other)?.tools, without.agents.get(other)?.toolsProblem], ['unavailable', undefined]);
	});

	test('started() settles once the process started, the launch failed or the run was closed first, with how its prompt goes in', async () => {
		const native = { path: 'native' as const, capability: { state: 'unverified' as const, reason: 'a positional argument' } };
		const world = setUp({ plan: { prompt: native } });
		const id = world.agents.launch({ name: 'a', location: 'loc-1', cli: 'claude', origin: 'human', prompt: 'go' });
		assert.deepStrictEqual(await world.agents.started(id), { state: 'running', prompt: native });
		let open!: () => void;
		world.execution.spawnGate = new Promise(resolve => open = resolve);
		const closing = world.agents.launch({ name: 'b', location: 'loc-1', cli: 'claude', origin: 'human' });
		const settled = world.agents.started(closing);
		await settle();
		await world.agents.close(closing);
		open();
		assert.strictEqual((await settled).state, 'closed');
		assert.deepStrictEqual(await world.agents.started('run-unknown'), { state: 'closed' });
	});

	test('a run\'s injected files are released as it is closed, exits or cannot start (CLIS-2.2)', async () => {
		const world = setUp();
		const closed = world.agents.launch({ name: 'a', location: 'loc-1', cli: 'claude', origin: 'human' });
		const exited = world.agents.launch({ name: 'b', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		await world.agents.close(closed);
		world.execution.exits.fire({ run: exited, code: 0, interruptVerified: false });
		world.execution.spawnError = new Error('spawn EACCES');
		const failed = world.agents.launch({ name: 'c', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.deepStrictEqual([...world.released].sort(), [closed, exited, failed].sort());
	});

	test('a reload restores each run\'s tree and tools from what ptyd keeps; an earlier build\'s run is a root of its own, without tools', async () => {
		const world = setUp();
		const meta = (more: Partial<RunMeta>): RunMeta => ({ alias: '#a1', name: 'a', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: false, createdAt: 1, ...more });
		const reader = { state: 'supported' as const, reason: 'claude-frame' };
		world.execution.liveRuns = [
			{ run: 'run-old', meta: meta({}), pid: 1, startedAt: 1, claimedElsewhere: false },
			{ run: 'run-child', meta: meta({ alias: '#a2', root: 'run-lead', creator: 'run-lead', origin: 'agent', tools: 'available', inputAdapter: 'claude-frame', inputCapability: reader, model: 'opus' }), pid: 2, startedAt: 2, claimedElsewhere: false }
		];
		await world.agents.restore();
		const old = world.agents.get('run-old')!;
		assert.deepStrictEqual([old.root, old.origin, old.creator, old.tools], ['run-old', 'human', undefined, 'not_injected']);
		const child = world.agents.get('run-child')!;
		assert.deepStrictEqual([child.root, child.origin, child.creator, child.tools, child.inputAdapter, child.inputCapability, child.model], ['run-lead', 'agent', 'run-lead', 'available', 'claude-frame', reader, 'opus']);
	});
});

/** What the card says of its run, in these words. */
const WORDS = {
	title: (value: string) => `Title: ${value}`, location: (value: string) => `Location: ${value}`, path: (value: string) => `Path: ${value}`, untitledPending: 'No title yet', untitledUnreadable: 'Title unavailable',
	starting: 'Starting', startingCli: (cli: string) => `Starting ${cli}...`, creatingWorktree: 'Creating worktree...',
	started: 'New conversation started', resumed: 'Conversation resumed', working: 'Working', notWorking: 'Idle', error: (reason: string) => `Error · ${reason}`,
	activityUnavailable: 'Status unavailable · check terminal', activityUnknown: (why: string) => `Status ${why} · check terminal`, needsAttention: 'Attention needed', toolsConnecting: 'Collaboration not connected yet', needsPermission: 'Permission needed',
	needsSignIn: 'Sign-in needed', hasQuestion: 'Answer needed', exitedWithCode: (code: string) => `Process exited · code ${code}`, endedBySignal: (signal: string) => `Process terminated · ${signal}`,
	exitUnknown: 'Process lost · reason unknown', toolsUnavailable: (problem?: string) => `Collaboration off · ${problem}`,
	startFailed: (reason: string) => `Start failed · ${reason}`, worktreeFailed: (reason: string) => `Worktree failed · ${reason}`,
	saidByAgent: (sender: string, line: string) => `${sender}: ${line}`, saidByPerson: (line: string) => line, saidByFacade: (line: string) => line, locale: 'en'
} satisfies CardWords;

suite('A run\'s title: its conversation\'s, as its CLI keeps it (CLIS-2.4, PANEL-1.4)', () => {
	/** The service's timers, each until it fires or is stopped: their time passes as the test says. */
	const timers = () => {
		const set: { readonly ms: number; readonly fn: () => void; done: boolean }[] = [];
		return {
			after: (ms: number, fn: () => void): Disposable => {
				const timer = { ms, fn, done: false };
				set.push(timer);
				return { dispose: () => { timer.done = true; } };
			},
			/** How long each timer still waiting waits. */
			waiting: () => set.filter(timer => !timer.done).map(timer => timer.ms),
			/** The time each waiting timer waits for passes: it fires. */
			pass: () => {
				for (const timer of set.filter(each => !each.done)) {
					timer.done = true;
					timer.fn();
				}
			}
		};
	};
	/** A CLI's own history: each read of it, answered from `titles` by session, or as the test has it answer - holding it, failing. */
	const history = (titles = new Map<string, string>()) => {
		const reads: { readonly key: ConversationKey; readonly cwd: string }[] = [];
		let reading = 0;
		let most = 0;
		let answer: (key: ConversationKey) => Promise<string | undefined> = async key => titles.get(key.sessionId);
		const stores: (string | undefined)[] = [];
		let storeNow: string | undefined = '/stores/at-launch';
		const port: ConversationTitlePort = {
			storeOf: () => storeNow,
			title: async (key, cwd, store) => {
				reads.push({ key, cwd });
				stores.push(store);
				most = Math.max(most, ++reading);
				try {
					return await answer(key);
				} finally {
					reading--;
				}
			}
		};
		return { port, reads, titles, stores, setStore: (next: string | undefined) => { storeNow = next; }, most: () => most, answerWith: (next: typeof answer) => { answer = next; } };
	};
	/** Each read held until the test answers it: `answer` answers the earliest still held. */
	const held = (store: ReturnType<typeof history>) => {
		const pending: ((title: string | undefined) => void)[] = [];
		store.answerWith(() => new Promise(resolve => pending.push(resolve)));
		return { answer: (title: string | undefined) => pending.shift()!(title), waiting: () => pending.length };
	};
	/** A turn of `run`'s CLI: it works, then its turn ends. */
	const turn = (world: ReturnType<typeof setUp>, run: RunId) => {
		world.execution.reports.fire({ run, activity: 'working', reporting: true });
		world.execution.reports.fire({ run, activity: 'not_working', reporting: true });
	};
	/** What `run`'s process keeps of it now: what its start gave, or what was kept since. */
	const kept = (world: ReturnType<typeof setUp>, run: RunId) => world.execution.metas.get(run) ?? world.execution.spawned.find(each => each.run === run)!.meta;

	test('CLIS-2.4: a run keeps the store its launch found - its turn-end reads and a reattachment\'s read use it after its CLI\'s settings moved the store or turned the CLI off; a new launch keeps the store found now', async () => {
		const clock = timers();
		const store = history(new Map([['sess-1', 'Saved work']]));
		const world = setUp({ sessions: true, titles: store.port, after: clock.after });
		const id = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await world.agents.started(id);
		await settle();
		store.setStore('/stores/moved');
		clock.pass();
		turn(world, id);
		await settle();
		const meta = kept(world, id);
		store.setStore(undefined);
		const reload = setUp({ sessions: true, titles: store.port, after: timers().after });
		reload.execution.liveRuns = [{ run: id, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta }];
		await reload.agents.restore();
		await settle();
		// Its first read, at acceptance, comes before its launch found a store; each read after uses the one it kept
		const runReads = store.stores.slice(1);
		store.setStore('/stores/moved');
		const fresh = world.agents.launch({ name: 'Bo', location: 'loc-1', cli: 'claude', origin: 'human' });
		await world.agents.started(fresh);
		assert.deepStrictEqual([meta.titleStore, runReads, world.agents.get(fresh)?.titleStore], ['/stores/at-launch', ['/stores/at-launch', '/stores/at-launch'], '/stores/moved']);
	});

	test('read by its exact conversation, in its folder, once its CLI names it and again as each turn ends - none before the CLI saved it; a change told only where it changed, and kept with its process', async () => {
		const clock = timers();
		const store = history();
		const world = setUp({ sessions: true, titles: store.port, after: clock.after });
		world.execution.namesAtSpawn = false;
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await world.agents.started(id);
		// An ID its launch gave it is not its CLI naming it: nothing is read yet
		const unnamed = store.reads.length;
		const session = world.agents.get(id)!.sessionId!;
		world.execution.identities.fire({ run: id, sessionId: session });
		await settle();
		const named = [store.reads.map(read => [read.key, read.cwd]), world.agents.get(id)?.title];
		// Saved now, as its CLI saves it at its first turn: read as that turn ends, once 30 seconds have passed since the last read
		store.titles.set(session, 'Fix the login redirect');
		turn(world, id);
		await settle();
		const waited = [store.reads.length, clock.waiting()];
		const before = world.changes.length;
		clock.pass();
		await settle();
		const titled = [store.reads.length, world.agents.get(id)?.title, kept(world, id).title, world.changes.slice(before).map(change => [change.run, change.kind])];
		// The next turn's end reads it again; the same title tells nothing
		turn(world, id);
		const again = world.changes.length;
		clock.pass();
		await settle();
		const same = [store.reads.length, world.changes.length - again];
		// Neither a report that ends no turn nor work going on asks for a read
		clock.pass();
		world.execution.reports.fire({ run: id, activity: 'not_working', reporting: true });
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true });
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, disconnected: true, reason: 'Lost' });
		clock.pass();
		await settle();
		assert.deepStrictEqual([unnamed, named, waited, titled, same, store.reads.length], [
			0,
			[[[{ environment: 'local', cli: 'claude', sessionId: session }, '/work/app']], undefined],
			[1, [TITLE_READS_MS]],
			[2, 'Fix the login redirect', 'Fix the login redirect', [[id, 'reported']]],
			[3, 0],
			3
		]);
	});

	test('at most one read in 30 seconds: one asked sooner follows once they are up - one for however many were asked - and a run\'s reads never overlap', async () => {
		const clock = timers();
		const store = history();
		const reads = held(store);
		const world = setUp({ sessions: true, titles: store.port, after: clock.after });
		// Its CLI names its conversation as it starts: the first read is at once, and under way
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await world.agents.started(id);
		await settle();
		const first = [store.reads.length, clock.waiting()];
		turn(world, id); turn(world, id); turn(world, id);
		await settle();
		// Its 30 seconds pass while it is still under way: the read asked meanwhile waits for it, and so does one asked after that
		clock.pass();
		await settle();
		turn(world, id);
		await settle();
		const during = store.reads.length;
		reads.answer('One');
		await settle();
		// It is over, and so are its 30 seconds: the one read asked meanwhile begins at once
		const following = [store.reads.length, world.agents.get(id)?.title, clock.waiting()];
		turn(world, id); turn(world, id);
		reads.answer('Two');
		await settle();
		// That read is over within its 30 seconds: the one asked meanwhile waits for them, and follows
		const resting = [store.reads.length, world.agents.get(id)?.title];
		clock.pass();
		await settle();
		reads.answer('Three');
		await settle();
		assert.deepStrictEqual([first, during, following, resting, store.reads.length, world.agents.get(id)?.title, store.most(), reads.waiting(), clock.waiting()], [
			[1, [TITLE_READS_MS]], 1, [2, 'One', [TITLE_READS_MS]], [2, 'Two'], 3, 'Three', 1, 0, [TITLE_READS_MS]
		]);
		// CLIS-2.4's bound itself
		assert.strictEqual(TITLE_READS_MS, 30_000);
	});

	test('nothing stays asked or waiting for a run closed or ended, nor once the service is disposed; a read under way then changes nothing', async () => {
		for (const how of ['close', 'exit', 'dispose'] as const) {
			const clock = timers();
			const store = history();
			const world = setUp({ sessions: true, titles: store.port, after: clock.after });
			const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
			await world.agents.started(id);
			await settle();
			store.titles.set(world.agents.get(id)!.sessionId!, 'Too late');
			// A turn's end asks for a read, which waits for the last one's 30 seconds
			turn(world, id);
			const asked = [store.reads.length, clock.waiting()];
			const end = async () => {
				if (how === 'close') { await world.agents.close(id); }
				if (how === 'exit') { world.execution.exits.fire({ run: id, code: 2, interruptVerified: false }); }
				if (how === 'dispose') { world.agents.dispose(); }
			};
			await end();
			const stopped = clock.waiting();
			clock.pass();
			await settle();
			assert.deepStrictEqual([asked, stopped, store.reads.length, world.agents.get(id)?.title], [[1, [TITLE_READS_MS]], [], 1, undefined], how);
			// A read under way as it ends or goes: its answer is no run's title
			const next = setUp({ sessions: true, titles: store.port, after: timers().after });
			const reads = held(store);
			const other = next.agents.launch({ name: 'Grace', location: 'loc-1', cli: 'claude', origin: 'human' });
			await next.agents.started(other);
			await settle();
			if (how === 'close') { await next.agents.close(other); }
			if (how === 'exit') { next.execution.exits.fire({ run: other, code: 2, interruptVerified: false }); }
			if (how === 'dispose') { next.agents.dispose(); }
			reads.answer('Too late');
			await settle();
			assert.deepStrictEqual([reads.waiting(), next.agents.get(other)?.title], [0, undefined], how);
			store.answerWith(async key => store.titles.get(key.sessionId));
		}
	});

	test('a read that finds none, or fails, keeps the last title - a failure said in the log once, never to the person; another conversation has none until it is read, and a read of the one it left changes nothing', async () => {
		const clock = timers();
		const store = history();
		const world = setUp({ sessions: true, titles: store.port, after: clock.after });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await world.agents.started(id);
		await settle();
		const session = world.agents.get(id)!.sessionId!;
		const readAgain = async () => { turn(world, id); clock.pass(); await settle(); };
		store.titles.set(session, 'One');
		await readAgain();
		const first = world.agents.get(id)?.title;
		store.titles.delete(session);
		await readAgain();
		const none = world.agents.get(id)?.title;
		store.answerWith(async () => { throw new Error('database is locked'); });
		await readAgain();
		await readAgain();
		const failed = [world.agents.get(id)?.title, world.log.filter(line => line.includes('Could not read the title')), world.errors, world.failures];
		// Its CLI switches conversation - /clear - as a read of the one it leaves is under way: the title goes at once, that read's answer
		// is not the new one's, and the new one's is read in its turn
		const reads = held(store);
		await readAgain();
		world.execution.identities.fire({ run: id, sessionId: 'switched' });
		const cleared = world.agents.get(id)?.title;
		reads.answer('One');
		await settle();
		const left = world.agents.get(id)?.title;
		store.answerWith(async key => store.titles.get(key.sessionId));
		store.titles.set('switched', 'Two');
		clock.pass();
		await settle();
		assert.deepStrictEqual([first, none, failed, cleared, left, world.agents.get(id)?.title, store.reads.at(-1)?.key.sessionId], [
			'One', 'One', ['One', ['Could not read the title of #a1\'s conversation: database is locked'], [], []], undefined, undefined, 'Two', 'switched'
		]);
	});

	test('a conversation it resumes - by Resume Agent, or a restored Pin - is read at once, as it is accepted, and its card says it resumed; a Pin that begins a new conversation says it started, read once its CLI names it', async () => {
		const clock = timers();
		const store = history(new Map([['sess-1', 'Saved work'], ['sess-2', 'Pinned work']]));
		const world = setUp({ sessions: true, titles: store.port, after: clock.after });
		world.execution.namesAtSpawn = false;
		const resumed = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		const accepted = store.reads.map(read => [read.key.sessionId, read.cwd]);
		await world.agents.started(resumed);
		const pins = (world.agents as unknown as { deps: { pinStore: PinStore } }).deps.pinStore;
		pins.save({ id: 'pin-2', conversation: { ...ENTRY.key, sessionId: 'sess-2' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Pinned' });
		pins.save({ id: 'pin-new', conversation: { environment: 'local', cli: 'claude' }, location: 'loc-1', cwd: ENTRY.cwd, name: 'Fresh' });
		await world.agents.restorePins();
		await settle();
		const restored = world.agents.list().find(run => run.pin === 'pin-2')!;
		const fresh = world.agents.list().find(run => run.pin === 'pin-new')!;
		const shown = (run: RunId) => { const facts = world.agents.get(run)!; return [facts.title, facts.resumed, statusOf(facts, WORDS).line]; };
		const before = [shown(resumed), kept(world, resumed).resumed, shown(restored.id), shown(fresh.id), store.reads.map(read => read.key.sessionId)];
		world.execution.identities.fire({ run: fresh.id, sessionId: 'sess-3' });
		await settle();
		assert.deepStrictEqual([accepted, before, store.reads.map(read => read.key.sessionId)], [
			[['sess-1', '/work/app']],
			[['Saved work', true, 'Conversation resumed'], true, ['Pinned work', true, 'Conversation resumed'], [undefined, undefined, 'New conversation started'], ['sess-1', 'sess-2']],
			['sess-1', 'sess-2', 'sess-3']
		]);
	});

	test('a reload shows its title and that it resumed at once, from what its process keeps, and reads the title again once for each run it brings back; a retained failure keeps that it resumed', async () => {
		const store = history(new Map([['sess-1', 'Saved work']]));
		const world = setUp({ sessions: true, titles: store.port, after: timers().after });
		const id = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await world.agents.started(id);
		await settle();
		const meta = kept(world, id);
		// The next window: its history answers nothing yet, and one run ended while it was away
		const later = history();
		held(later);
		const reload = setUp({ sessions: true, titles: later.port, after: timers().after });
		reload.execution.liveRuns = [
			{ run: id, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta },
			{ run: 'run-ended', claimedElsewhere: false, pid: 4243, startedAt: 1000, meta: { ...meta, alias: '#a9', sessionId: 'sess-9' }, exited: { code: 0, interruptVerified: false } }
		];
		await reload.agents.restore();
		await settle();
		const facts = reload.agents.get(id)!;
		const shown = [meta.title, meta.resumed, facts.title, facts.resumed, statusOf(facts, WORDS).line, later.reads.map(read => read.key.sessionId)];
		// A start that failed is kept red with what it was: that it resumed among it
		const failing = setUp({ sessions: true });
		failing.execution.spawnError = new Error('could not start');
		const failed = failing.agents.resume(ENTRY, { reveal: true }) as RunId;
		await failing.agents.started(failed);
		const again = setUp({ sessions: true });
		again.retained.set(failed, failing.retained.get(failed)!);
		await again.agents.restore();
		assert.deepStrictEqual([shown, failing.retained.get(failed)?.resumed, again.agents.get(failed)?.resumed], [
			['Saved work', true, 'Saved work', true, 'Conversation resumed', ['sess-1']], true, true
		]);
	});

	test('CLIS-2.4: only a title proven to come from the native conversation reader is kept - an earlier build\'s, which may be a CLI report\'s, is dropped from a retained failure and from a reattached run, never shown on its card or to agents, while a proven one survives both', async () => {
		const store = history(new Map([['sess-1', 'Saved work']]));
		const world = setUp({ sessions: true, titles: store.port, after: timers().after });
		const id = world.agents.resume(ENTRY, { reveal: true }) as RunId;
		await world.agents.started(id);
		await settle();
		const meta = kept(world, id);
		// A failed start an earlier build kept with a report's title, and one this build kept with its conversation's
		const failing = setUp({ sessions: true });
		failing.execution.spawnError = new Error('could not start');
		const failed = failing.agents.resume(ENTRY, { reveal: true }) as RunId;
		await failing.agents.started(failed);
		const record = failing.retained.get(failed)!;
		const { titleSource: _source, ...legacy } = { ...record, title: '✳ Report title from the terminal' };
		const again = setUp({ sessions: true });
		again.retained.set(failed, legacy as RetainedRun);
		again.retained.set('run-proven' as RunId, { ...record, id: 'run-proven' as RunId, alias: '#a8', title: 'Saved work', titleSource: 'conversation' } as RetainedRun);
		await again.agents.restore();
		// A reattached run of an earlier build: its kept title unproven; one of this build: proven
		const later = history();
		held(later);
		const reload = setUp({ sessions: true, titles: later.port, after: timers().after });
		const { titleSource: _metaSource, ...oldMeta } = { ...meta, title: '⠐ Working title' };
		reload.execution.liveRuns = [
			{ run: id, claimedElsewhere: false, pid: 4242, startedAt: 1000, meta },
			{ run: 'run-old', claimedElsewhere: false, pid: 4243, startedAt: 1000, meta: { ...oldMeta, alias: '#a9', sessionId: 'sess-9' } }
		];
		await reload.agents.restore();
		await settle();
		const cardTitle = (facts: RunFacts | undefined) => facts && cardOf(facts, { place: { label: 'main', qualified: 'main', context: 'main', path: '/work/app', kind: 'repo' }, selected: false, menu: { moveUp: false, moveDown: false }, words: WORDS }).details.summary?.value;
		const apiTitle = (facts: RunFacts | undefined) => facts && agentOf(facts, { id: 'w', label: 'W', environment: 'local' }, 10).title;
		const legacyFacts = again.agents.get(failed), provenFacts = again.agents.get('run-proven' as RunId);
		const oldFacts = reload.agents.get('run-old' as RunId), newFacts = reload.agents.get(id);
		assert.deepStrictEqual([meta.titleSource, record.titleSource], ['conversation', undefined]);
		assert.deepStrictEqual([legacyFacts?.title, cardTitle(legacyFacts), apiTitle(legacyFacts), provenFacts?.title, cardTitle(provenFacts)], [undefined, undefined, undefined, 'Saved work', 'Saved work']);
		assert.deepStrictEqual([oldFacts?.title, apiTitle(oldFacts), newFacts?.title, newFacts?.titleSource], [undefined, undefined, 'Saved work', 'conversation']);
	});
});
