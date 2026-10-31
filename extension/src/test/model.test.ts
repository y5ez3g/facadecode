/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Catalog, Location, LocationRemoval, RunChange, RunFacts, WorkspaceFolderInfo } from '../core/ports';
import type { CardWords } from '../ui/cardView';
import { PanelModel, REPORT_COALESCE_MS, Timers } from '../ui/model';
import { PanelPrefs, Storage } from '../ui/order';
import type { PanelState } from '../webview/protocol';
import { TestEmitter } from './withModules';

const WORDS: CardWords = {
	worktreeFailure: reason => reason,
	starting: 'Starting', startingCli: cli => `Starting ${cli}...`, creatingWorktree: 'Creating worktree...', working: 'Working', notWorking: 'Idle', error: reason => `Error: ${reason}`,
	activityUnavailable: 'Activity unavailable', readyForInput: 'Ready for input', needsPermission: 'Needs permission', needsSignIn: 'Sign-in required', hasQuestion: 'Waiting for an answer',
	exitedWithCode: code => `Exited with code ${code}`, endedBySignal: signal => `Ended by signal ${signal}`, exitUnknown: 'Disconnected; exit cause unknown', window: label => `Window: ${label}`
};

const SHOP: WorkspaceFolderInfo = { index: 0, name: 'shop', uri: 'file:///shop', path: '/shop' };
const DOCS: WorkspaceFolderInfo = { index: 1, name: 'docs', uri: 'file:///docs', path: '/docs' };

function location(id: string, label: string, folder: WorkspaceFolderInfo): Location {
	return { id, path: `/${label}`, uri: `file:///${label}`, environment: 'local', label, folders: [folder], kind: 'checkout', opened: false, git: 'ok' };
}

const MAIN = location('loc-main', 'main', SHOP);
const LOGIN = location('loc-login', 'login-fix', SHOP);
const GUIDE = location('loc-guide', 'guide', DOCS);

const id = (n: number) => `run-${n.toString(16).padStart(32, '0')}`;

function run(n: number, more: Partial<RunFacts> = {}): RunFacts {
	return {
		id: id(n), alias: `#a${n}`, name: `Agent ${n}`, cli: 'claude', displayName: 'Claude Code', command: 'claude', location: MAIN.id, cwd: MAIN.path,
		environment: 'local', yolo: true, createdAt: n, lifecycle: 'running', phase: 'running', activity: 'working', reporting: true, ...more
	};
}

class Agents {
	readonly runs = new Map<string, RunFacts>();
	readonly changes = new TestEmitter<RunChange>();
	readonly onDidChange = this.changes.event;
	list(): readonly RunFacts[] { return [...this.runs.values()]; }
	get(run: string): RunFacts | undefined { return this.runs.get(run); }
	add(facts: RunFacts): void { this.runs.set(facts.id, facts); this.changes.fire({ run: facts.id, kind: 'added' }); }
	update(run: string, more: Partial<RunFacts>, kind: RunChange['kind']): void { this.runs.set(run, { ...this.runs.get(run)!, ...more }); this.changes.fire({ run, kind }); }
	remove(run: string): void { this.runs.delete(run); this.changes.fire({ run, kind: 'removed' }); }
}

class Locations {
	catalog: Catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
	readonly changed = new TestEmitter<void>();
	readonly removed = new TestEmitter<LocationRemoval>();
	readonly onDidChange = this.changed.event;
	readonly onDidRemove = this.removed.event;
	snapshot(): Catalog { return this.catalog; }
}

class Memory implements Storage {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	update(key: string, value: unknown): Thenable<void> { this.values.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

/** A clock and timers the test moves on. */
class Clock implements Timers {
	at = 1_000;
	private next = 1;
	private readonly due = new Map<number, { readonly at: number; readonly run: () => void }>();
	now(): number { return this.at; }
	setTimeout(run: () => void, ms: number): unknown { const handle = this.next++; this.due.set(handle, { at: this.at + ms, run }); return handle; }
	clearTimeout(handle: unknown): void { this.due.delete(handle as number); }
	advance(ms: number): void {
		this.at += ms;
		for (const [handle, timer] of [...this.due].sort((a, b) => a[1].at - b[1].at)) {
			if (timer.at <= this.at) {
				this.due.delete(handle);
				timer.run();
			}
		}
	}
}

const tick = () => new Promise(resolve => setImmediate(resolve));

suite('The panel model: one coherent state (PANEL-1, 2, 3.1)', () => {
	let agents: Agents;
	let locations: Locations;
	let storage: Memory;
	let clock: Clock;
	let models: PanelModel[];
	let states: PanelState[];
	let settle: () => void;

	const make = (ready: Promise<unknown> = Promise.resolve()) => {
		const model = new PanelModel({ agents, locations, prefs: new PanelPrefs(storage), words: WORDS, remote: false, ready, timers: clock });
		model.onDidChange(state => states.push(state));
		models.push(model);
		return model;
	};
	const names = (state: PanelState) => state.cards.map(card => card.name);

	setup(() => {
		agents = new Agents();
		locations = new Locations();
		storage = new Memory();
		clock = new Clock();
		models = [];
		states = [];
	});

	teardown(() => models.forEach(model => model.dispose()));

	test('until this window\'s runs are reconciled it is loading and draws no empty state; then the empty state says why (PANEL-1.1, 1.2)', async () => {
		const model = make(new Promise<void>(resolve => settle = resolve));
		await tick();
		const loading = model.state();
		settle();
		await tick();
		const noAgents = model.state();
		locations.catalog = { locations: [], folders: [], pending: false };
		locations.changed.fire();
		await tick();
		const noFolder = model.state();
		assert.deepStrictEqual([loading.loading, loading.empty, noAgents.loading, noAgents.empty, noFolder.empty], [true, undefined, false, 'noAgents', 'noFolder']);
	});

	test('U02: whatever changes in one moment goes out as one state, each a new revision', async () => {
		const model = make();
		await tick();
		const before = states.length;
		agents.add(run(1));
		agents.add(run(2));
		model.select(id(1));
		await tick();
		assert.deepStrictEqual([states.length - before, names(model.state()), model.state().revision > states[before - 1].revision], [1, ['Agent 2', 'Agent 1'], true]);
	});

	test('a CLI\'s reported text and activity reach the page at most once per 300 ms; lifecycle changes and errors go at once', async () => {
		const model = make();
		agents.add(run(1));
		await tick();
		const sent = () => states.length;
		const first = sent();
		// After a quiet coalescing window, the first report goes at once
		clock.advance(REPORT_COALESCE_MS + 100);
		agents.update(id(1), { title: 'One' }, 'reported');
		await tick();
		const leading = sent() - first;
		clock.advance(50);
		agents.update(id(1), { title: 'Two' }, 'reported');
		clock.advance(50);
		agents.update(id(1), { title: 'Three' }, 'reported');
		await tick();
		const held = sent() - first;
		clock.advance(REPORT_COALESCE_MS - 100);
		await tick();
		const trailing = sent() - first;
		const line = model.state().cards[0].line;
		// An error is a lifecycle change: it does not wait for the coalescer
		clock.advance(10);
		agents.update(id(1), { error: { reason: 'Rate limited', source: 'cli', at: 1 } }, 'lifecycle');
		await tick();
		assert.deepStrictEqual([leading, held, trailing, line, sent() - first, model.state().cards[0].dot], [1, 1, 2, 'Three', 3, 'error']);
	});

	test('U05: the badge counts every card - starting and failed alike; a new card goes first; the order is kept in workspace storage', async () => {
		let model = make();
		agents.add(run(1, { lifecycle: 'starting', phase: 'launching_cli' }));
		agents.add(run(2, { lifecycle: 'ended', end: { kind: 'failed', at: 1 }, error: { reason: 'Not found', source: 'launch', at: 1 } }));
		agents.add(run(3, { location: GUIDE.id }));
		await tick();
		const counted = [model.state().cardCount, names(model.state())];
		assert.ok(model.move(id(1), -1));
		await tick();
		const moved = names(model.state());
		model.dispose();
		model = make();
		await tick();
		const reloaded = names(model.state());
		agents.add(run(4));
		await tick();
		assert.deepStrictEqual([counted, moved, reloaded, names(model.state())], [
			[3, ['Agent 3', 'Agent 2', 'Agent 1']],
			['Agent 3', 'Agent 1', 'Agent 2'],
			['Agent 3', 'Agent 1', 'Agent 2'],
			['Agent 4', 'Agent 3', 'Agent 1', 'Agent 2']
		]);
	});

	test('Move Up/Down trades places with the next card; the menu offers each only where it moves (PANEL-2.1, 2.2)', async () => {
		const model = make();
		agents.add(run(1));
		agents.add(run(2, { location: GUIDE.id }));
		agents.add(run(3));
		await tick();
		const menus = model.state().cards.map(card => [card.name, card.menu.moveUp, card.menu.moveDown]);
		assert.ok(model.move(id(1), -1));
		assert.ok(model.move(id(1), -1));
		assert.ok(!model.move(id(1), -1), 'the top card does not move up');
		assert.ok(model.move(id(3), 1));
		await tick();
		assert.deepStrictEqual([menus, names(model.state())], [[['Agent 3', false, true], ['Agent 2', true, true], ['Agent 1', true, false]], ['Agent 1', 'Agent 2', 'Agent 3']]);
	});

	test('selection follows the last active owned terminal, survives a file in front and goes with its run; a background start leaves it; a failed launch stays selected (PANEL-2.1)', async () => {
		const model = make();
		agents.add(run(1));
		agents.add(run(2));
		model.activated(id(1));
		await tick();
		const followed = [model.state().cards.find(card => card.selected)?.name, model.selectedAgent()];
		model.activated(undefined);
		agents.add(run(3));
		await tick();
		const kept = [model.state().cards.find(card => card.selected)?.name, model.selectedAgent()];
		model.select(id(3));
		agents.update(id(3), { lifecycle: 'ended', end: { kind: 'failed', at: 1 }, error: { reason: 'Not found', source: 'launch', at: 1 } }, 'lifecycle');
		await tick();
		const failed = model.state().cards.find(card => card.selected)?.name;
		model.activated(id(3));
		await tick();
		const ended = model.selectedAgent();
		agents.remove(id(3));
		await tick();
		assert.deepStrictEqual([followed, kept, failed, ended, model.state().cards.some(card => card.selected), model.selectedAgent()], [
			['Agent 1', { run: id(1), ended: false }],
			['Agent 1', { run: id(1), ended: false }],
			'Agent 3',
			{ run: id(3), ended: true },
			false,
			undefined
		]);
	});

	test('a card says its location by branch or folder, its workspace folder first in a multi-folder window - and keeps it while the location is only unlisted (PANEL-1.3)', async () => {
		const model = make();
		agents.add(run(1, { location: LOGIN.id, cwd: LOGIN.path }));
		await tick();
		const multi = model.state().cards[0].location;
		locations.catalog = { locations: [{ ...MAIN, folders: [SHOP] }], folders: [SHOP], pending: true };
		locations.changed.fire();
		await tick();
		assert.deepStrictEqual([multi, model.state().cards[0].location], [
			{ label: 'login-fix', folderPrefix: 'shop', full: 'shop · login-fix\n/login-fix' },
			{ label: 'login-fix', full: 'login-fix\n/login-fix' }
		]);
	});

	test('D66: a plain folder\'s location, named that folder already, says its name once in a multi-folder window - no `docs · docs`', async () => {
		const plain = { ...location('loc-docs', 'docs', DOCS), kind: 'folder' as const };
		locations.catalog = { locations: [MAIN, plain], folders: [SHOP, DOCS], pending: false };
		const model = make();
		agents.add(run(1, { location: plain.id, cwd: plain.path }));
		agents.add(run(2, { location: MAIN.id, cwd: MAIN.path }));
		await tick();
		assert.deepStrictEqual(model.state().cards.map(card => card.location), [
			{ label: 'main', folderPrefix: 'shop', full: 'shop · main\n/main' }, { label: 'docs', full: 'docs\n/docs' }
		]);
	});

	test('PANEL-1.5: the hover names the window; a rename is shown at once; the state carries only the remote capability', async () => {
		const model = new PanelModel({ agents, locations, prefs: new PanelPrefs(storage), words: WORDS, remote: false, window: 'shop', ready: Promise.resolve(), timers: clock });
		models.push(model);
		agents.add(run(1, { name: 'Lead' }));
		await tick();
		const before = model.state().cards.map(card => card.name);
		agents.update(id(1), { name: 'Chief' }, 'renamed');
		await tick();
		assert.deepStrictEqual([before, model.state().cards.map(card => card.name), model.state().cards[0].location.full, model.state().capabilities], [
			['Lead'],
			['Chief'],
			'shop · main\n/main\nWindow: shop',
			{ remote: false }
		]);
	});

	test('ARCHITECTURE-4.2: an earlier build\'s stored card order is ignored, never translated, with one line in the agents log', () => {
		const logged: string[] = [];
		storage.values.set('facade.panel.order', ['row-1', id(1)]);
		const prefs = new PanelPrefs(storage, { event: line => logged.push(line) });
		const read = [prefs.order(), prefs.order()];
		const clean = new PanelPrefs(new Memory(), { event: line => logged.push(line) });
		assert.deepStrictEqual([read, clean.order()], [[[id(1)], [id(1)]], []]);
		assert.deepStrictEqual(logged, [
			'Ignored a stored panel card order (facade.panel.order) this build does not read, as from an earlier build'
		]);
	});

	test('J14: 100 cards are drawn in their order and counted', async () => {
		const model = make();
		for (let n = 1; n <= 100; n++) {
			agents.add(run(n));
		}
		await tick();
		assert.deepStrictEqual([model.state().cardCount, model.state().cards.length, model.state().cards[0].name, model.state().cards[99].name], [100, 100, 'Agent 100', 'Agent 1']);
	});
});
