/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type * as vscode from 'vscode';
import { isTerminalRegistration, TERMINAL_REGISTRATION_MS, type TerminalOwner } from '../base/windowIdentity';
import type { AgentTerminals } from '../host/execution/agentTerminals';
import type { WindowTerminals } from '../host/windowTerminals';
import { FakeClock } from './clock';
import { TestEmitter, withModules } from './withModules';
import { tempDir } from './util';

suite('Window terminal registration: actual objects across workspace host generations', () => {
	type Native = { name: string; disposed: number; creationOptions: vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
		processId: Promise<number | undefined>; readonly shown: boolean[]; show(preserveFocus: boolean): void; dispose(): void };
	let registry: WindowTerminals;
	let clock: FakeClock;
	let owner: TerminalOwner;
	let terminals: Native[];
	let opened: TestEmitter<Native>;
	let closed: TestEmitter<Native>;
	let managers: AgentTerminals[];
	let load: ReturnType<typeof withModules>;
	let publishOpen: boolean;
	let beforeCommand: ((request: { kind: string }) => Promise<void>) | undefined;
	let storage: ReturnType<typeof tempDir>;
	const commands: { kind: string; run?: string; actual?: unknown }[] = [];
	const create = (name: string, announce = true, creationOptions: Native['creationOptions'] = { name }): Native => {
		const terminal: Native = { name, creationOptions, processId: Promise.resolve(-1), disposed: 0, shown: [], show(preserveFocus) { this.shown.push(preserveFocus); }, dispose() {
			this.disposed++;
			terminals = terminals.filter(each => each !== this);
			closed.fire(this);
		} };
		terminals.push(terminal);
		if (announce) { opened.fire(terminal); }
		return terminal;
	};
	const begin = (run: string, who = owner) => {
		const ticket = registry.request({ ...who, kind: 'begin', run });
		assert.strictEqual(typeof ticket, 'string');
		return ticket;
	};
	const finish = (run: string, ticket: unknown, who = owner, actual?: unknown) => registry.request({ ...who, kind: 'finish', run, ticket }, actual);
	const bind = (run: string, name: string) => {
		const ticket = begin(run);
		const terminal = create(name);
		assert.strictEqual(finish(run, ticket), true);
		return terminal;
	};
	const nextHost = (handedOver = false) => {
		owner = { ...owner, claim: { ...owner.claim, generation: owner.claim.generation + 1, token: `host-${owner.claim.generation + 1}` } };
		assert.strictEqual(registry.request({ ...owner, kind: 'activate', handedOver }), true);
	};
	const restartLocalHost = (handedOver = true, beforeSnapshot?: () => void) => {
		registry.dispose();
		const prior = [...terminals]; terminals = [];
		const snapshot = prior.map(terminal => {
			const copy = create(terminal.name, false, 'pty' in terminal.creationOptions ? { name: terminal.creationOptions.name } : terminal.creationOptions);
			copy.processId = terminal.processId; return copy;
		});
		beforeSnapshot?.();
		const { WindowTerminals: Registry } = load<typeof import('../host/windowTerminals')>(require.resolve('../host/windowTerminals'));
		registry = new Registry({ directory: storage.dir, log: () => undefined });
		nextHost(handedOver);
		return snapshot;
	};
	const manager = (remote = true) => {
		const { AgentTerminals: Manager } = load<typeof import('../host/execution/agentTerminals')>(require.resolve('../host/execution/agentTerminals'));
		const result = new Manager({ media: {} as vscode.Uri, log: () => undefined, terminalOwner: { ...owner, remote },
			activated: () => undefined, closed: () => undefined, renamed: () => undefined });
		managers.push(result);
		return result;
	};

	setup(() => {
		clock = FakeClock.install();
		storage = tempDir('fc-terminal-retirement-');
		terminals = []; managers = []; commands.length = 0; publishOpen = true; beforeCommand = undefined;
		owner = { session: 'window-session', claim: { owner: 'workspace', generation: 1, token: 'host-1' } };
		opened = new TestEmitter(); closed = new TestEmitter();
		const changed = new TestEmitter();
		const api = {
			env: { sessionId: owner.session }, EventEmitter: TestEmitter,
			ThemeIcon: class { constructor(readonly id: string) { } }, Uri: { joinPath: () => ({}) },
			ViewColumn: { Active: -1 }, TerminalExitReason: { Shutdown: 1 },
			workspace: { getConfiguration: () => ({ get: () => ' - ' }), onDidChangeConfiguration: changed.event },
			window: {
				get terminals() { return terminals; },
				onDidOpenTerminal: opened.event, onDidCloseTerminal: closed.event, onDidChangeActiveTerminal: changed.event,
				tabGroups: { onDidChangeTabs: changed.event, onDidChangeTabGroups: changed.event, all: [], activeTabGroup: {} },
				createTerminal: (options: vscode.ExtensionTerminalOptions) => create(options.name, publishOpen, options)
			},
			commands: { executeCommand: async (_command: string, request: { kind: string }, actual?: unknown) => {
				commands.push({ ...request, actual });
				await beforeCommand?.(request);
				return registry.request(request, actual);
			} }
		};
		load = withModules({ vscode: api });
		const { WindowTerminals: Registry } = load<typeof import('../host/windowTerminals')>(require.resolve('../host/windowTerminals'));
		registry = new Registry({ directory: storage.dir, log: () => undefined });
		assert.strictEqual(registry.request({ ...owner, kind: 'activate' }), true);
	});

	teardown(() => {
		managers.forEach(each => each.dispose());
		registry.dispose(); clock.uninstall(); storage.remove();
	});

	for (const name of ['Ada - Same CLI title', '']) {
		test(`same-name runs replace exactly their own registered objects: ${JSON.stringify(name)}`, () => {
			const shell = create(name), troubleshooting = create(name), untrackedPty = create(name);
			const oldA = bind('run-a', name), oldB = bind('run-b', name);
			nextHost();
			const newA = bind('run-a', name);
			assert.deepStrictEqual([oldA.disposed, oldB.disposed], [1, 0]);
			const newB = bind('run-b', name);
			assert.deepStrictEqual([oldA.disposed, oldB.disposed, shell.disposed, troubleshooting.disposed, untrackedPty.disposed], [1, 1, 0, 0, 0]);
			assert.deepStrictEqual(terminals, [shell, troubleshooting, untrackedPty, newA, newB]);
		});
	}

	test('extra open followed by close remains ambiguous; a later valid capture can replace the retained binding', () => {
		const old = bind('run-a', 'same'); nextHost();
		const ticket = begin('run-a');
		const noise = create('same'); noise.dispose();
		const candidate = create('same');
		assert.strictEqual(finish('run-a', ticket), false);
		assert.strictEqual(old.disposed, 0); assert.strictEqual(candidate.disposed, 0);
		bind('run-a', 'different title');
		assert.strictEqual(old.disposed, 1); assert.strictEqual(candidate.disposed, 0);
	});

	test('a pre-existing object closing during capture does not contaminate the new object', () => {
		const existing = create('same'); const ticket = begin('run-a'); existing.dispose();
		const candidate = create('same');
		assert.strictEqual(finish('run-a', ticket, owner, candidate), true);
	});

	test('closed candidates and serialized lookalikes are rejected without deleting an old binding', () => {
		const old = bind('run-a', 'same'); nextHost();
		let ticket = begin('run-a'); const closedCandidate = create('same'); closedCandidate.dispose();
		assert.strictEqual(finish('run-a', ticket), false);
		ticket = begin('run-a'); const candidate = create('same');
		assert.strictEqual(finish('run-a', ticket, owner, { ...candidate }), false);
		assert.strictEqual(old.disposed, 0); assert.strictEqual(candidate.disposed, 0);
	});

	test('old activation, late finish and late cancel cannot replace or clear a newer capture', () => {
		const previous = owner; const oldTicket = begin('run-a'); create('old pending'); nextHost();
		const ticket = begin('run-a'); const current = create('current');
		assert.strictEqual(finish('run-a', oldTicket, previous), false);
		assert.strictEqual(registry.request({ ...previous, kind: 'activate' }), false);
		assert.strictEqual(registry.request({ ...previous, kind: 'cancel', run: 'run-a', ticket: oldTicket }), false);
		assert.strictEqual(finish('run-a', ticket), true);
		assert.strictEqual(current.disposed, 0);
	});

	test('normal close clears its binding and the replaced object late close cannot clear the new one', () => {
		const old = bind('run-a', 'A'); nextHost(); const replacement = bind('run-a', 'A');
		closed.fire(old); nextHost(); const third = bind('run-a', 'A');
		assert.strictEqual(replacement.disposed, 1);
		third.dispose(); nextHost(); bind('run-a', 'A');
		assert.strictEqual(third.disposed, 1, 'normal close removed the binding; do not dispose it again');
	});

	test('expired and cancelled captures dispose nothing, and release the next creation', async () => {
		const old = bind('run-a', 'A'); nextHost();
		const ticket = begin('run-a'); const candidate = create('A');
		await clock.tick(TERMINAL_REGISTRATION_MS);
		assert.strictEqual(finish('run-a', ticket), false);
		const next = begin('run-a'); create('A');
		assert.strictEqual(registry.request({ ...owner, kind: 'cancel', run: 'run-a', ticket: next }), false);
		assert.strictEqual(finish('run-a', next), false);
		assert.deepStrictEqual([old.disposed, candidate.disposed], [0, 0]);
		bind('run-a', 'A'); assert.strictEqual(old.disposed, 1);
	});

	test('malformed requests, changed session and equal-generation different tokens cannot mutate registration', () => {
		for (const value of [null, [], {}, { ...owner, kind: 'unknown' }, { ...owner, kind: 'begin', run: '' }]) {
			assert.strictEqual(isTerminalRegistration(value), false);
			assert.strictEqual(registry.request(value), false);
		}
		assert.strictEqual(registry.request({ ...owner, session: 'other', kind: 'activate' }), false);
		assert.strictEqual(registry.request({ ...owner, claim: { ...owner.claim, token: 'other' }, kind: 'activate' }), false);
	});

	test('runtime serializes two empty-name creates and sends no Terminal object across hosts', async () => {
		const oldA = bind('run-a', 'same'), oldB = bind('run-b', 'same'); nextHost();
		const runtime = manager();
		for (const run of ['run-a', 'run-b']) {
			const handle = runtime.create({ run, name: '', cli: 'claude' }, false);
			handle.open(false); handle.open(false);
		}
		await clock.tick(0);
		// A finish ends its capture: no cancel round trip follows it
		assert.deepStrictEqual(commands.map(each => each.kind), ['begin', 'finish', 'begin', 'finish']);
		assert.ok(commands.every(each => each.actual === undefined));
		assert.deepStrictEqual([oldA.disposed, oldB.disposed, terminals.length], [1, 1, 2]);
	});

	test('a window component that started again while this activation went on is told its claim again, and registers its next terminal (ARCHITECTURE-2.2)', async () => {
		// The local extension host restarted alone: its new registry knows no owner, and this activation did not activate again
		registry.dispose();
		const { WindowTerminals: Registry } = load<typeof import('../host/windowTerminals')>(require.resolve('../host/windowTerminals'));
		registry = new Registry({ directory: storage.dir, log: () => undefined });
		const runtime = manager();
		runtime.create({ run: 'run-a', name: 'Ada', cli: 'claude' }, false).open(false);
		await clock.tick(0);
		assert.deepStrictEqual(commands.map(each => each.kind), ['begin', 'activate', 'begin', 'finish']);
		// Registered: the next activation's terminal for the run replaces exactly this object
		nextHost();
		const later = manager();
		later.create({ run: 'run-a', name: 'Ada', cli: 'claude' }, false).open(false);
		await clock.tick(0);
		assert.deepStrictEqual(terminals.map(each => each.disposed), [0]);
		assert.strictEqual(terminals.length, 1);
	});

	test('local runtime supplies the actual object and never a title-shaped reconstruction', async () => {
		const runtime = manager(false); const handle = runtime.create({ run: 'run-a', name: 'Ada', cli: 'claude' }, false);
		handle.open(false); await clock.tick(0);
		assert.strictEqual(commands.find(each => each.kind === 'finish')?.actual, terminals[0]);
	});

	test('closing while begin is pending creates nothing and cancels the late capture', async () => {
		let release!: () => void;
		beforeCommand = request => request.kind === 'begin' ? new Promise<void>(resolve => release = resolve) : Promise.resolve();
		const runtime = manager(); const handle = runtime.create({ run: 'run-a', name: '', cli: 'claude' }, false);
		handle.open(false); await clock.tick(0); handle.dispose(); release(); await clock.tick(0);
		assert.strictEqual(terminals.length, 0);
		assert.deepStrictEqual(commands.map(each => each.kind), ['begin', 'cancel']);
		begin('another');
	});

	test('closing while waiting for own open cancels capture and permits the next run', async () => {
		publishOpen = false;
		const runtime = manager(); const handle = runtime.create({ run: 'run-a', name: '', cli: 'claude' }, false);
		handle.open(false); await clock.tick(0); assert.strictEqual(terminals.length, 1);
		handle.dispose(); await clock.tick(0);
		assert.deepStrictEqual(commands.map(each => each.kind), ['begin', 'cancel']);
		assert.strictEqual(terminals.length, 0);
		publishOpen = true; runtime.create({ run: 'run-b', name: '', cli: 'claude' }, false).open(false); await clock.tick(0);
		assert.strictEqual(terminals.length, 1);
	});

	test('reveal during queued creation is accepted and only the latest request is shown', async () => {
		let release!: () => void;
		let held = false;
		beforeCommand = request => request.kind === 'begin' && !held
			? new Promise<void>(resolve => { held = true; release = resolve; }) : Promise.resolve();
		const runtime = manager();
		const first = runtime.create({ run: 'run-a', name: 'A', cli: 'claude' }, false);
		const last = runtime.create({ run: 'run-b', name: 'B', cli: 'claude' }, false);
		first.open(false); last.open(false); await clock.tick(0);
		assert.strictEqual(first.reveal(false), true);
		assert.strictEqual(last.reveal(true), true);
		release(); await clock.tick(0);
		assert.deepStrictEqual(terminals.map(each => each.shown), [[], [true]]);
	});

	for (const title of ['Ada - Old CLI title', '']) {
		test(`a graceful local registry loss retires the complete old group after its two runs return: ${JSON.stringify(title)}`, async () => {
			bind('run-a', title); bind('run-b', title);
			const old = restartLocalHost();
			const shell = create(title); shell.processId = Promise.resolve(1234);
			bind('run-a', 'New CLI title A'); bind('run-b', 'New CLI title B');
			assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a', 'run-b'] }), true);
			assert.deepStrictEqual(old.map(each => each.disposed), [1, 1]);
			assert.strictEqual(shell.disposed, 0);
			assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a', 'run-b'] }), false);
		});
	}

	for (const name of ['Ada', '']) {
		test(`a displayed CLI title does not have to equal the original creation name: ${JSON.stringify(name)}`, async () => {
			const title = `${name} - Shared CLI title`;
			for (const run of ['run-a', 'run-b']) { bind(run, name).name = title; }
			const old = restartLocalHost();
			assert.deepStrictEqual(old.map(each => each.creationOptions.name), [name, name]);
			bind('run-a', 'New CLI title A'); bind('run-b', 'New CLI title B');
			assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a', 'run-b'] }), true);
			assert.deepStrictEqual(old.map(each => each.disposed), [1, 1]);
		});
	}

	test('an extra matching old third-party object prevents the entire group from being retired', async () => {
		bind('run-a', 'same'); bind('run-b', 'same'); create('same', true, { name: 'third-party original name' });
		const old = restartLocalHost(); bind('run-a', 'same'); bind('run-b', 'same');
		assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a', 'run-b'] }), false);
		assert.deepStrictEqual(old.map(each => each.disposed), [0, 0, 0]);
	});

	test('ordinary shells, a current PTY and a late object never join the activation resource set', async () => {
		bind('run-a', 'same'); const positive = create('same'); positive.processId = Promise.resolve(666);
		create('same', true, { name: 'same', shellPath: '/bin/sh' });
		let currentPty!: Native;
		const old = restartLocalHost(true, () => { currentPty = create('same', true, { name: 'same', pty: {} as vscode.Pseudoterminal }); });
		const late = create('same');
		bind('run-a', 'new');
		assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a'] }), true);
		assert.deepStrictEqual([...old, late, currentPty].map(each => each.disposed), [1, 0, 0, 0, 0]);
	});

	test('a canonical-only takeover cannot retire old groups even when a shutdown record exists', async () => {
		bind('run-a', 'same'); const old = restartLocalHost(false); bind('run-a', 'same');
		assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a'] }), false);
		assert.strictEqual(old[0].disposed, 0);
	});

	test('a partial restore preserves the complete old resource group', async () => {
		bind('run-a', 'same'); bind('run-b', 'same');
		const old = restartLocalHost(); bind('run-a', 'same');
		assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a'] }), false);
		assert.deepStrictEqual(old.map(each => each.disposed), [0, 0]);
	});

	test('an unknown PID cannot shrink a colliding group to an apparently exact match', async () => {
		bind('run-a', 'same'); create('same').processId = Promise.resolve(undefined);
		const old = restartLocalHost(); bind('run-a', 'same');
		assert.strictEqual(await registry.request({ ...owner, kind: 'retire', runs: ['run-a'] }), false);
		assert.deepStrictEqual(old.map(each => each.disposed), [0, 0]);
	});

	test('an old terminal that never answers for its process keeps its own group alone: the other groups are retired by the wait\'s end', async () => {
		bind('run-a', 'A'); bind('run-b', 'B').processId = new Promise(() => undefined);
		const old = restartLocalHost(); bind('run-a', 'A now'); bind('run-b', 'B now');
		const retiring = registry.request({ ...owner, kind: 'retire', runs: ['run-a', 'run-b'] });
		await clock.tick(TERMINAL_REGISTRATION_MS);
		assert.strictEqual(await retiring, true);
		assert.deepStrictEqual(old.map(each => [each.name, each.disposed]), [['A', 1], ['B', 0]]);
	});

	test('a late PID result from an earlier owner cannot retire any old resource', async () => {
		const terminal = bind('run-a', 'same'); let pid!: (value: number) => void;
		terminal.processId = new Promise(resolve => { pid = resolve; });
		const old = restartLocalHost(); bind('run-a', 'same');
		const retiring = registry.request({ ...owner, kind: 'retire', runs: ['run-a'] });
		nextHost(); pid(-1);
		assert.strictEqual(await retiring, false); assert.strictEqual(old[0].disposed, 0);
	});
});
