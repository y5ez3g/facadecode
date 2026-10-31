/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AgentService } from '../core/agents';
import { FacadeError } from '../core/errors';
import {
	ActivityReport, CleanupResult, Disposable, Event, ExecutionPort, ExitReport, LaunchPlan, LiveRun, Location, LocationPort,
	HumanFailure, LocationRemoval, PairFacts, PlanError, PlanRequest, RunChange, RunFacts, RunId, RunMeta, WorktreeError, WorktreePlan
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
	readonly transfers = new Emitter<void>();
	readonly toolConnections = new Emitter<RunId>();
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
	readonly onDidConnectTools = this.toolConnections.event;
	openPair(facts: PairFacts, options: { reveal: boolean }): void { this.pairs.set(facts.run, facts); this.reveals.set(facts.run, options.reveal); }
	note(run: RunId, text: string): void { this.notes.push({ run, text }); }
	async spawn(run: RunId, plan: LaunchPlan, meta: RunMeta): Promise<{ pid: number; startedAt: number }> {
		await this.spawnGate;
		if (this.spawnError) {
			throw this.spawnError;
		}
		this.spawned.push({ run, plan, meta });
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
	planError?: PlanError; worktreeError?: WorktreeError; worktreeGate?: Promise<void>; removedWhileAway?: readonly string[];
	confirm?: (agent: { readonly run: RunId; readonly label: string }) => Promise<boolean>; describe?: (err: unknown, english: string) => string;
	/** What each plan adds to the test's plain one: its tools, input reader, prompt path, version. */
	plan?: Partial<LaunchPlan>;
	/** Orchestration on: each start is given its own shim. */
	tools?: boolean;
} = {}) {
	const execution = new FakeExecution();
	const removals = new Emitter<LocationRemoval>();
	const closes = new Emitter<void>();
	const locations: LocationPort = {
		snapshot: () => ({ locations: [LOCATION], folders: LOCATION.folders, pending: false }),
		resolve: id => id === LOCATION.id ? LOCATION : id === WORKTREE.id ? WORKTREE : undefined,
		refresh: async () => undefined,
		onDidChange: new Emitter<void>().event,
		onDidRemove: removals.event,
		removalOf: id => options.removedWhileAway?.includes(id) ? 'folder' : undefined
	};
	const created: WorktreePlan[] = [];
	const plans: PlanRequest[] = [];
	const errors: { text: string; show?: RunId }[] = [];
	const failures: HumanFailure[] = [];
	const remembered: { location: string; cli: string }[] = [];
	const retained = new Map<RunId, RunFacts>();
	const released: RunId[] = [];
	const shims: RunId[] = [];
	const log: string[] = [];
	let next = 0;
	let alias = 0;
	let now = 10_000;
	const agents = new AgentService({
		execution,
		planner: {
			plan: async (request: PlanRequest) => {
				plans.push(request);
				if (options.planError) {
					throw options.planError;
				}
				return {
					cli: request.cli, displayName: 'Claude Code', command: 'claude', executable: '/bin/claude', args: [], env: {}, cwd: request.location.path,
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
				text: `Could not start ${failure.name}: ${failure.reason}`,
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
		...(options.tools ? { tools: (run: RunId) => (shims.push(run), { command: '/runtime', args: ['/ext/dist/shim.js'], env: { FACADE_RUN: run } }) } : {}),
		...(options.describe ? { describe: options.describe } : {}),
		newRunId: () => `run-${(++next).toString(16).padStart(32, '0')}`
	});
	const changes: RunChange[] = [];
	agents.onDidChange(change => changes.push(change));
	return { agents, execution, removals, closes, errors, failures, remembered, retained, released, shims, log, changes, created, plans };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

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

	test('a damaged retained record is ignored without stopping restoration', async () => {
		const world = setUp();
		world.retained.set('bad', { id: 'bad', alias: '#a1', name: 'Incomplete' } as RunFacts);
		await world.agents.restore();
		assert.deepStrictEqual([world.agents.list(), [...world.execution.pairs], world.log], [[], [], ['Ignored an invalid retained agent record.']]);
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

	test('closing during startup prevents the later spawn (WORKTREES-2.5, RULES-5.2)', async () => {
		const world = setUp();
		let release!: () => void;
		world.execution.spawnGate = new Promise(resolve => release = resolve);
		const id = world.agents.launch({ name: 'Ada', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		assert.strictEqual(await world.agents.close(id), 'not_started');
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

	test('activity reports set the facts; a reported error clears only when the CLI recovers (RULES-3.2)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true, title: 'Fix login' });
		assert.deepStrictEqual([world.agents.get(id)?.activity, world.agents.get(id)?.title], ['working', 'Fix login']);
		world.execution.reports.fire({ run: id, activity: 'not_working', reporting: true, error: 'API overloaded' });
		assert.strictEqual(world.agents.get(id)?.error?.reason, 'API overloaded');
		world.execution.reports.fire({ run: id, activity: 'working', reporting: true });
		assert.strictEqual(world.agents.get(id)?.error, undefined);
		assert.strictEqual(world.agents.get(id)?.title, 'Fix login', 'the last title stays until the CLI sets another');
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

	test('a natively closed tab is an explicit close (LIFECYCLE-3.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
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
		const named = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human' });
		const unnamed = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude', origin: 'human' });
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
		const starting = world.agents.launch({ name: 'S', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.tabCloses.fire(starting);
		await settle();
		release();
		world.execution.spawnGate = Promise.resolve();
		world.execution.spawnError = new Error('no program');
		const failed = world.agents.launch({ name: 'F', location: 'loc-1', cli: 'claude', origin: 'human' });
		await settle();
		world.execution.tabCloses.fire(failed);
		await settle();
		assert.deepStrictEqual({ asked, starting: world.agents.get(starting), failed: world.agents.get(failed), reopened: world.execution.reopened },
			{ asked: [], starting: undefined, failed: undefined, reopened: [] });
	});

	test('a failure says Facade\'s own reason in the person\'s words and an empty name by its #aN, while the log keeps the English (UX-2.4, LIFECYCLE-2.1)', async () => {
		const world = setUp({ planError: new PlanError('facade.claude.path is "x", which was not found', 'not_found', { kind: 'path_not_on_path', values: ['facade.claude', '"x"', '/work/app'] }),
			describe: (err, english) => err instanceof PlanError && err.said ? `translated ${err.said.kind}` : english });
		const id = world.agents.launch({ name: '', location: 'loc-1', cli: 'claude', origin: 'human' });
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
		await gated.agents.close(closing);
		release();
		await settle();
		assert.strictEqual(gated.created.length, 1, 'the worktree was still made');
		assert.strictEqual(gated.execution.spawned.length, 0, 'its CLI never starts');
	});

	test('a worktree that cannot be made keeps the pair red with the actual reason (J04, WORKTREES-2.1)', async () => {
		const world = setUp();
		const id = world.agents.launch({ name: 'A', location: 'loc-1', cli: 'claude', origin: 'human', worktree: { branch: 'bad name' } });
		await settle();
		assert.deepStrictEqual([world.agents.get(id)?.end?.kind, world.agents.get(id)?.error?.reason], ['failed', 'bad name is not a valid branch name.']);
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
		// Tools the plan could not give leave the CLI running without them, with why
		const without = setUp({ tools: true, plan: { tools: { state: 'unavailable', reason: 'another facade skill is in the project' } } });
		const other = without.agents.launch({ name: 'b', location: 'loc-1', cli: 'codex', origin: 'human' });
		await settle();
		assert.deepStrictEqual([without.agents.get(other)?.lifecycle, without.agents.get(other)?.tools, without.agents.get(other)?.toolsReason], ['running', 'unavailable', 'another facade skill is in the project']);
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
