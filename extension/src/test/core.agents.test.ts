/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AgentService } from '../core/agents';
import { FacadeError } from '../core/errors';
import {
	ActivityReport, CleanupResult, Disposable, Event, ExecutionPort, ExitReport, LaunchPlan, LiveRun, Location, LocationPort,
	ConversationEntry, ConversationMeta, ConversationKey, Pin, HumanFailure, LocationRemoval, PairFacts, PlanError, PlanRequest, RunChange, RunFacts, RunId, RunMeta, WorktreeError, WorktreePlan
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
	readonly tabCloses = new Emitter<RunId>();
	readonly tabRenames = new Emitter<{ readonly run: RunId; readonly name: string }>();
	readonly identities = new Emitter<{ readonly run: RunId; readonly sessionId: string | null; readonly cwd?: string }>();
	readonly tabPins = new Emitter<{ readonly run: RunId; readonly pinned: boolean }>();
	readonly pinnedTabs: { run: RunId; pinned: boolean }[] = [];
	readonly onDidIdentify = this.identities.event;
	readonly onDidPinTab = this.tabPins.event;
	elsewhere: ConversationKey[] = [];
	async conversations(): Promise<readonly ConversationKey[]> { return this.elsewhere; }
	pinTab(run: RunId, pinned: boolean): void { this.pinnedTabs.push({ run, pinned }); }
	failSpawnFor?: (plan: LaunchPlan) => boolean;
	readonly transfers = new Emitter<void>();
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
	readonly onDidRenameTab = this.tabRenames.event;
	readonly onDidLoseOwnership = this.transfers.event;
	openPair(facts: PairFacts, options: { reveal: boolean }): void { this.pairs.set(facts.run, facts); this.reveals.set(facts.run, options.reveal); }
	note(run: RunId, text: string): void { this.notes.push({ run, text }); }
	async spawn(run: RunId, plan: LaunchPlan, meta: RunMeta): Promise<{ pid: number; startedAt: number }> {
		await this.spawnGate;
		if (this.failSpawnFor?.(plan)) { throw new Error('the CLI could not start'); }
		if (this.spawnError) {
			throw this.spawnError;
		}
		this.spawned.push({ run, plan, meta });
		if (plan.exactResume && plan.sessionId) { this.identities.fire({ run, sessionId: plan.sessionId }); }
		return { pid: 4242, startedAt: 1000 };
	}
	async attach(live: LiveRun, facts: PairFacts): Promise<void> { this.pairs.set(live.run, facts); }
	async terminate(run: RunId): Promise<CleanupResult> { this.terminated.push(run); return this.cleanup; }
	removePair(run: RunId): void { this.pairs.delete(run); this.removed.push(run); }
	async reveal(): Promise<boolean> { return true; }
	reopen(run: RunId): void { this.reopened.push(run); }
	rename(run: RunId, name: string): void { const pair = this.pairs.get(run); if (pair) { this.pairs.set(run, { ...pair, name }); } }
	readonly metas = new Map<RunId, RunMeta>();
	setMeta(run: RunId, meta: RunMeta): void { this.metas.set(run, meta); }
	async live(): Promise<readonly LiveRun[]> { return this.liveRuns; }
	async endWindow(): Promise<void> { this.endedWindow = true; }
}

const WORKTREE: Location = { ...LOCATION, id: 'loc-wt', path: '/work/app.worktrees/fix', uri: 'file:///work/app.worktrees/fix', label: 'fix', kind: 'checkout', branch: 'fix', opened: false, git: 'ok' };

function setUp(options: {
	sessions?: boolean; failSpawnFor?: (plan: LaunchPlan) => boolean; planError?: PlanError; worktreeError?: WorktreeError; worktreeGate?: Promise<void>; removedWhileAway?: readonly string[];
	confirm?: (agent: { readonly run: RunId; readonly label: string }) => Promise<boolean>; describe?: (err: unknown, english: string) => string;
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
	const retained = new Map<RunId, RunFacts>();
	const log: string[] = [];
	let next = 0;
	let alias = 0;
	let now = 10_000;
	const agents = new AgentService({
		conversations: { get: key => conversations.get(key.sessionId), put: (key, meta) => conversations.set(key.sessionId, meta) },
		pinStore: { list: () => pins, save: pin => { pins = pins.some(each => each.id === pin.id) ? pins.map(each => each.id === pin.id ? pin : each) : [pin, ...pins]; },
			remove: id => { pins = pins.filter(pin => pin.id !== id); }, reorder: ids => { pins = ids.map(id => pins.find(pin => pin.id === id)!).filter(Boolean); } },
		newPinId: () => `pin-${++pinId}`,
		execution,
		planner: {
			plan: async (request: PlanRequest) => {
				plans.push(request);
				if (options.planError) {
					throw options.planError;
				}
				return { ...(options.sessions ? { exactResume: request.cli === 'claude', sessionId: request.resume?.sessionId ?? `session-${request.run}` } : {}), cli: request.cli, displayName: 'Claude Code', command: 'claude', executable: '/bin/claude', args: [], env: {}, cwd: request.location.path };
			}
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
			error: (text, opts) => errors.push({ text, ...(opts.show ? { show: opts.show } : {}) }),
			...(options.confirm ? { confirmClose: options.confirm } : {})
		},
		retained: { list: () => [...retained.values()], put: run => retained.set(run.id, run), remove: run => retained.delete(run) },
		aliases: { next: () => `#a${++alias}` },
		clock: { now: () => ++now },
		log: { event: text => log.push(text) },
		lifetime: { onDidClose: closes.event },
		yolo: () => true,
		...(options.describe ? { describe: options.describe } : {}),
		newRunId: () => `run-${(++next).toString(16).padStart(32, '0')}`
	});
	const changes: RunChange[] = [];
	agents.onDidChange(change => changes.push(change));
	return { pins: () => pins, conversations, agents, execution, removals, closes, errors, failures, remembered, retained, log, changes, created, plans };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

suite('Agent lifecycle: one launch service (LIFECYCLE-1.5, 3.1; RULES-3.3)', () => {
	test('ownership transfer drops cards and pending starts without closing or forgetting the transferred processes', async () => {
		const world = setUp();
		const live = world.agents.launch({ name: 'Live', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.spawnError = new Error('retain me');
		const failed = world.agents.launch({ name: 'Failed', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.spawnError = undefined;
		const pending = world.agents.launch({ name: 'Pending', location: 'loc-1', cli: 'claude' });
		world.execution.transfers.fire();
		await settle();
		await world.agents.restore();
		assert.deepStrictEqual({
			runs: world.agents.list(), terminated: world.execution.terminated, removed: world.execution.removed,
			retained: [...world.retained.keys()], started: world.execution.spawned.map(each => each.run),
			transferred: world.changes.filter(each => each.cause === 'transfer').map(each => each.run)
		}, { runs: [], terminated: [], removed: [], retained: [failed], started: [live], transferred: [live, failed, pending] });
		assert.throws(() => world.agents.launch({ name: 'Stale', location: 'loc-1', cli: 'claude' }),
			(err: unknown) => err instanceof FacadeError && err.reason === 'ownership_lost' && /owned by another window/.test(err.message));
	});

	test('a damaged retained record is ignored without stopping restoration', async () => {
		const world = setUp();
		world.retained.set('bad', { id: 'bad', alias: '#a1', name: 'Incomplete' } as RunFacts);
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs], world.log], [[], [], ['Ignored an invalid retained agent record.']]);
	});

	test('an accepted launch creates its pair at once, before the process, and keeps the same run through startup (J01, LIFECYCLE-1.5)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: '  Ada Lovelace ', location: 'loc-1', cli: 'claude' });
		assert.ok(world.execution.pairs.has(id), 'the terminal exists before the process');
		assert.deepStrictEqual(world.agents.get(id)?.lifecycle, 'starting');
		assert.strictEqual(world.agents.get(id)?.name, 'Ada Lovelace');
		await settle();
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual([facts.lifecycle, facts.phase, facts.pid, facts.displayName], ['running', 'running', 4242, 'Claude Code']);
		assert.strictEqual(world.execution.spawned.length, 1);
		assert.deepStrictEqual(world.remembered, [{ location: 'loc-1', cli: 'claude' }], 'a human launch remembers its CLI and location once the process starts');
		assert.strictEqual(world.execution.reveals.get(id), true, 'a human New Agent shows its terminal');
	});

	test('names are labels: empty strings, spaces, duplicates and human are accepted with distinct run IDs (LIFECYCLE-2.1)', () => {
		const world = setUp();
		const names = ['Ada Lovelace', 'Ada Lovelace', 'human', '@Human', '', '   '];
		const ids = names.map(name => world.agents.launch({ name, location: 'loc-1', cli: 'claude' }));
		assert.strictEqual(new Set(ids).size, names.length);
		assert.deepStrictEqual(ids.map(id => world.agents.get(id)?.name), names.map(name => name.trim()));
		assert.strictEqual(world.execution.pairs.size, names.length);
	});

	test('missing fields are reported together before any effect (RULES-5.1, M02)', () => {
		const world = setUp();
		assert.throws(() => world.agents.launch({ name: undefined as unknown as string, location: '', cli: '' }), (err: unknown) =>
			err instanceof FacadeError && /name must be a string/.test(err.message) && /working location is required/.test(err.message) && /CLI is required/.test(err.message));
		assert.strictEqual(world.execution.pairs.size, 0);
	});

	test('a launch that cannot be planned keeps its pair red, retained, and tells the person who started it (J04, RULES-1.8)', async () => {
		const world = setUp({ planError: new PlanError('claude is not installed in this environment.', 'not_found') });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
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
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
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
		world.retained.set(failed, { id: failed, alias: '#a9', name: 'Failed', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
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
		const closed = world.agents.launch({ name: 'Closed', location: 'loc-1', cli: 'claude' });
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
		world.retained.set(id, { id, alias: '#a8', name: 'Gone', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-gone', cwd: '/work/gone', environment: 'local', yolo: true, createdAt: 1, lifecycle: 'ended', phase: 'launching_cli', activity: 'unknown', reporting: false, end: { kind: 'failed', at: 2 }, error: { reason: 'boom', source: 'launch', at: 2 } });
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list().map(run => run.id), world.execution.pairs.has(id), world.retained.has(id)], [[], false, false]);
	});

	test('explicit close removes card and terminal at once and cleans up in the background (J07, LIFECYCLE-3.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
		await settle();
		const closing = world.agents.close(id);
		assert.strictEqual(world.agents.get(id), undefined, 'gone from the record at once');
		assert.deepStrictEqual(world.execution.removed, [id], 'its terminal is gone at once');
		assert.strictEqual(await closing, 'terminated');
		world.execution.exits.fire({ run: id, code: 143, interruptVerified: false });
		assert.strictEqual(world.agents.get(id), undefined, 'its later exit does not bring it back');
	});

	test('closing during startup prevents the later spawn (WORKTREES-2.5, RULES-5.2)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => release = resolve);
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
		await settle();
		assert.strictEqual(await world.agents.close(id), 'not_started');
		release();
		await settle();
		assert.strictEqual(world.agents.get(id), undefined);
		assert.deepStrictEqual(world.remembered, []);
	});

	test('exit 0 or a verified interrupt removes the pair; an unexplained nonzero exit keeps it red with its code and no popup (J06, RULES-3.3)', async () => {
		const world = setUp();
		const normal = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		const interrupted = world.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude' });
		const crashed = world.agents.launch({ name: 'C', location: 'loc-1', cli: 'claude' });
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

	test('an exit heard before its start is answered leaves the run ended: its tab then closes without the question for a live agent (RULES-3.1, 3.3, LIFECYCLE-3.1)', async () => {
		const asked: RunId[] = [];
		const world = setUp({ confirm: async agent => { asked.push(agent.run); return false; } });
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.exits.fire({ run: id, code: 1, interruptVerified: false });
		release();
		await settle();
		const facts = world.agents.get(id)!;
		world.execution.tabCloses.fire(id);
		await settle();
		assert.deepStrictEqual([facts.lifecycle, facts.end?.kind, facts.pid, asked, world.agents.get(id)], ['ended', 'abnormal', 4242, [], undefined]);
	});

	test('a rename while the CLI starts is kept with its process, as a later one is: a reloaded window shows it (LIFECYCLE-2.1, 3.5)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
		await settle();
		world.agents.rename(id, 'Grace');
		release();
		await settle();
		assert.strictEqual(world.execution.metas.get(id)?.name, 'Grace');
	});

	test('a CLI a signal ended is abnormal though its code is 0 - as node-pty reports a process killed on Linux and macOS - and keeps its red pair; the person\'s own close is not (RULES-3.3)', async () => {
		const world = setUp();
		const killed = world.agents.launch({ name: 'K', location: 'loc-1', cli: 'claude' });
		const closed = world.agents.launch({ name: 'C', location: 'loc-1', cli: 'claude' });
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

	test('activity reports set the facts; a reported error clears only when the CLI recovers (RULES-3.2)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, title: 'Fix login' });
		assert.deepStrictEqual([world.agents.get(id)?.activity, world.agents.get(id)?.title], ['working', 'Fix login']);
		world.execution.reports.fire({ run: id, activity: 'not_working', reporting: true, error: 'API overloaded' });
		assert.strictEqual(world.agents.get(id)?.error?.reason, 'API overloaded');
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true });
		assert.strictEqual(world.agents.get(id)?.error, undefined);
		assert.strictEqual(world.agents.get(id)?.title, 'Fix login', 'the last title stays until the CLI sets another');
	});

	test('a run is awaiting its CLI\'s activity while its reports say so, and no longer once one does not (CLIS-2.3, D81)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, awaitingActivity: true });
		assert.deepStrictEqual([world.agents.get(id)?.lifecycle, world.agents.get(id)?.awaitingActivity, world.agents.get(id)?.activityReason], ['running', true, undefined]);
		world.execution.reports.fire({ run: id, activity: 'unknown', reporting: false, reason: 'The CLI has not reported its activity' });
		const facts = world.agents.get(id)!;
		assert.deepStrictEqual(['awaitingActivity' in facts, facts.activityReason], [false, 'The CLI has not reported its activity']);
	});

	test('confirmed location removal closes the agents there; other locations continue (W05, RULES-2.4)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		await settle();
		world.removals.fire({ ids: ['loc-other'], cause: 'deleted' });
		assert.ok(world.agents.get(id));
		world.removals.fire({ ids: ['loc-1'], cause: 'folder' });
		await settle();
		assert.strictEqual(world.agents.get(id), undefined);
		assert.deepStrictEqual(world.execution.terminated, [id]);
	});

	test('a natively closed tab is an explicit close (LIFECYCLE-3.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabCloses.fire(id);
		await settle();
		assert.strictEqual(world.agents.get(id), undefined);
		assert.deepStrictEqual(world.execution.terminated, [id]);
	});

	test('a live agent whose tab was closed - alone or with other editors - ends only once the person confirms; kept, its terminal opens again (LIFECYCLE-3.1)', async () => {
		const asked: { readonly run: RunId; readonly label: string }[] = [];
		let answer = false;
		const world = setUp({ confirm: async agent => { asked.push(agent); return answer; } });
		const named = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		const unnamed = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabCloses.fire(named);
		world.execution.tabCloses.fire(unnamed);
		await settle();
		assert.deepStrictEqual({ asked, kept: [!!world.agents.get(named), !!world.agents.get(unnamed)], reopened: world.execution.reopened, terminated: world.execution.terminated },
			{ asked: [{ run: named, label: 'A' }, { run: unnamed, label: '#a2' }], kept: [true, true], reopened: [named, unnamed], terminated: [] });
		answer = true;
		world.execution.tabCloses.fire(named);
		await settle();
		assert.deepStrictEqual([world.agents.get(named), world.execution.terminated], [undefined, [named]]);
	});

	test('a closed tab of a starting or ended agent closes it without asking (LIFECYCLE-3.1)', async () => {
		const asked: RunId[] = [];
		let release!: () => void;
		const world = setUp({ confirm: async agent => { asked.push(agent.run); return false; } });
		world.execution.spawnGate = new Promise(resolve => { release = resolve; });
		const starting = world.agents.launch({ name: 'S', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabCloses.fire(starting);
		await settle();
		release();
		world.execution.spawnGate = Promise.resolve();
		world.execution.spawnError = new Error('no program');
		const failed = world.agents.launch({ name: 'F', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabCloses.fire(failed);
		await settle();
		assert.deepStrictEqual({ asked, starting: world.agents.get(starting), failed: world.agents.get(failed), reopened: world.execution.reopened },
			{ asked: [], starting: undefined, failed: undefined, reopened: [] });
	});

	test('a failure says Facade\'s own reason in the person\'s words and an empty name by its #aN, while the log keeps the English (UX-2.4, LIFECYCLE-2.1)', async () => {
		const world = setUp({ planError: new PlanError('facade.claude.path is "x", which was not found', 'not_found', { kind: 'path_not_on_path', values: ['facade.claude', '"x"', '/work/app'] }),
			describe: (err, english) => err instanceof PlanError && err.said ? `translated ${err.said.kind}` : english });
		const id = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude' });
		await settle();
		assert.deepStrictEqual({ reason: world.agents.get(id)?.error?.reason, failure: world.failures.map(each => [each.name, each.reason]), log: world.log.filter(line => line.startsWith('Could not start')) },
			{ reason: 'translated path_not_on_path', failure: [['#a1', 'translated path_not_on_path']], log: ['Could not start #a1: facade.claude.path is "x", which was not found'] });
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
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
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
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabRenames.fire({ run: id, name: '  Grace Hopper ' });
		assert.deepStrictEqual([world.agents.get(id)?.name, world.execution.pairs.get(id)?.name, world.execution.metas.get(id)?.name], ['Grace Hopper', 'Grace Hopper', 'Grace Hopper']);
		assert.ok(world.changes.some(change => change.run === id && change.kind === 'renamed'), 'its card is renamed');
		assert.deepStrictEqual(world.errors, []);
		// A failed launch's red card keeps a tab rename across a reload too
		world.execution.spawnError = new Error('boom');
		const failed = world.agents.launch({ name: 'Bea', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.tabRenames.fire({ run: failed, name: 'Cy' });
		assert.strictEqual(world.retained.get(failed)?.name, 'Cy');
	});

	test('a tab can be renamed to human or an empty string; a run no longer here is left alone (LIFECYCLE-2.1, 2.2, RULES-1.8)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude' });
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

	test('partial Git failures retain only confirmed effects and carry them through notifications and reload', async () => {
		for (const effects of [{}, { branchCreated: true }, { destinationCreated: WORKTREE.path }, { branchCreated: true, destinationCreated: WORKTREE.path }]) {
			const world = setUp({ worktreeError: new WorktreeError('disk full', 'creation_failed', effects) });
			const id = world.agents.launch({ name: '', location: LOCATION.id, cli: 'claude', worktree: { branch: 'fix' } });
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
			const id = world.agents.launch({ name: 'Ada', location: LOCATION.id, cli: 'claude', worktree: { branch: 'fix' } });
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
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', worktree: { branch: 'fix' } });
		assert.strictEqual(await world.agents.close(id), 'not_started');
		release();
		const crashed = world.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude' });
		await settle();
		world.execution.exits.fire({ run: crashed, code: 3, interruptVerified: false });
		world.agents.rename(crashed, 'Bea');
		assert.strictEqual(world.execution.metas.get(crashed)?.name, 'Bea');
	});

	test('a launch with a new worktree creates it first, then starts the CLI there; closing during creation prevents the spawn and keeps the worktree (W03, WORKTREES-2.5)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', worktree: { branch: 'fix' } });
		assert.strictEqual(world.agents.get(id)?.phase, 'creating_worktree');
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.location, world.agents.get(id)?.cwd, world.agents.get(id)?.phase], ['loc-wt', WORKTREE.path, 'running']);

		let release!: () => void;
		const gated = setUp({ worktreeGate: new Promise(resolve => release = resolve) });
		const closing = gated.agents.launch({ name: 'B', location: 'loc-1', cli: 'claude', worktree: { branch: 'fix' } });
		await gated.agents.close(closing);
		release();
		await settle();
		assert.strictEqual(gated.created.length, 1, 'the worktree was still made');
		assert.strictEqual(gated.execution.spawned.length, 0, 'its CLI never starts');
	});

	test('a worktree that cannot be made keeps the pair red with the actual reason (J04, WORKTREES-2.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', worktree: { branch: 'bad name' } });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.end?.kind, world.agents.get(id)?.error?.reason], ['failed', 'bad name is not a valid branch name.']);
	});
});

const continuitySetup = (options: Parameters<typeof setUp>[0] = {}) => setUp({ ...options, sessions: true });
const ENTRY: ConversationEntry = { key: { environment: 'local', cli: 'claude', sessionId: 'sess-1' }, cwd: '/work/app', title: 'Saved work' };
suite('Agent continuity: Resume, Pin and new worktrees (LIFECYCLE-3.2–3.4, RULES-4.2, WORKTREES-2)', () => {
	const setUp = (options: Parameters<typeof continuitySetup>[0] = {}) => continuitySetup(options);
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

	test('D69: a resumed conversation is held by its run - one whose CLI cannot pin a run as its own too - until the run is closed', async () => {
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
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
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

	test('explicit close, normal exit and location removal Unpin; an abnormal exit keeps the Pin (RULES-4.2, EXPERIENCE-2.6)', async () => {
		const world = setUp();
		const [closed, normal, crashed, removed] = ['A', 'B', 'C', 'D'].map(name => world.agents.launch({ name, location: 'loc-1', cli: 'claude' }));
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

	test('a CLI that changes its session updates the record and the Pin once the new identity is known (LIFECYCLE-3.4)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude' });
		await settle();
		world.agents.pin(id);
		world.execution.identities.fire({ run: id, sessionId: 'after-clear' });
		assert.strictEqual(world.agents.get(id)?.sessionId, 'after-clear');
		assert.strictEqual(world.pins()[0].conversation.sessionId, 'after-clear');
	});

	test('native home/new temporarily disables Pin, preserves the saved intent, and a confirmed switch moves its ID and cwd together', async () => {
		const world = setUp();
		const run = world.agents.resume(ENTRY, { reveal: false }) as RunId;
		await settle();
		world.agents.pin(run);
		const before = world.pins()[0];
		world.execution.identities.fire({ run, sessionId: null });
		assert.strictEqual(world.agents.get(run)?.resumable, false);
		assert.strictEqual(world.agents.get(run)?.pin, before.id);
		assert.deepStrictEqual(world.pins()[0], before);
		assert.throws(() => world.agents.pin(run), /cannot resume/);
		assert.strictEqual(world.execution.metas.get(run)?.exactResume, true, 'reload must keep watching even before the new conversation exists');
		world.execution.identities.fire({ run, sessionId: 'new-native-session', cwd: '/work/app/pkg' });
		assert.deepStrictEqual([world.pins()[0].conversation.sessionId, world.pins()[0].cwd, world.agents.get(run)?.resumable], ['new-native-session', '/work/app/pkg', true]);
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
