/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EarlierPtyds, PtydClient, PtydGone, PtydNotSent, ptydSocketPath } from '../host/execution/ptydClient';
import { EARLIER_PROTOCOLS, lineReader, PTYD_PROTOCOL, RunEvent, SpawnParams } from '../ptyd/protocol';
import { PtydServer } from '../ptyd/server';
import * as runModule from '../ptyd/run';
import { eachLine, finish, IDLE, program, programEnv, ptydPlace } from './ptydPlace';
import { withModules } from './withModules';

/** Whether a process `pid` still exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

suite('ptyd: runs held for windows (ARCHITECTURE-2.3, 2.4, RULES-4.1)', function () {
	this.timeout(20_000);
	let socketPath: string;
	let socketDir: string;
	let pipe: (name: string) => string;
	let server: PtydServer;
	const clients: PtydClient[] = [];
	const extra: net.Socket[] = [];
	let generation = 0;
	let snapshotGate: { readonly waiting: Promise<void>; entered(): void } | undefined;

	setup(async () => {
		generation = 0;
		snapshotGate = undefined;
		({ dir: socketDir, socket: socketPath, pipe } = ptydPlace('fd-ptyd-'));
		class DelayedSnapshotRun extends runModule.Run {
			override async snapshot() {
				const snapshot = await super.snapshot();
				const gate = snapshotGate;
				snapshotGate = undefined;
				if (gate) { gate.entered(); await gate.waiting; }
				return snapshot;
			}
		}
		const Server = withModules({ './run': { ...runModule, Run: DelayedSnapshotRun } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		server = new Server(socketPath);
		assert.strictEqual(await server.listen(), true);
	});

	teardown(() => {
		clients.splice(0).forEach(client => client.dispose());
		extra.splice(0).forEach(socket => socket.destroy());
		server.close();
		fs.rmSync(socketDir, { recursive: true, force: true });
	});

	const connect = async (claim = true) => {
		// The server listens already: nothing is started
		const client = await PtydClient.connect(socketPath, '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
		clients.push(client);
		if (claim) {
			await client.request('claim', { owner: 'w1', generation: ++generation, token: `activation-${generation}` });
		}
		return client;
	};
	/** Starts `source` as the run `run`, in Node: the same program on every platform. */
	const spawn = (client: PtydClient, run: string, source: string, more: Partial<SpawnParams> = {}) => client.request('spawn', {
		run, owner: 'w1', ...program(source), cwd: os.tmpdir(), cols: 80, rows: 24, meta: { name: run }, ...more
	});
	const until = async <T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 5_000): Promise<T> => {
		const deadline = Date.now() + ms;
		for (; ;) {
			const value = await check();
			if (value !== undefined && value !== false) {
				return value;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${what}.`);
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	const eventsOf = (client: PtydClient, run: string) => {
		const events: RunEvent[] = [];
		client.onRunEvent(run, event => events.push(event));
		return events;
	};
	const outputOf = (events: readonly RunEvent[]) => events.map(event => event.event === 'output' ? event.data : '').join('');

	test('says which protocol it speaks; a second ptyd on the socket gives way; a window of another protocol is told so and nothing is ended', async () => {
		const client = await connect();
		assert.deepStrictEqual(await client.request('hello', { protocol: PTYD_PROTOCOL }), { protocol: PTYD_PROTOCOL, pid: process.pid });
		assert.strictEqual(await new PtydServer(socketPath).listen(), false);
		// A ptyd of an earlier protocol, which answers hello with its own number
		const older = pipe('older');
		const fake = net.createServer(socket => socket.on('data', chunk => {
			const { id } = JSON.parse(chunk.toString().split('\n')[0]);
			socket.write(`${JSON.stringify({ id, result: { protocol: PTYD_PROTOCOL - 1, pid: 1 } })}\n`);
		}));
		await new Promise<void>(resolve => fake.listen(older, resolve));
		try {
			await assert.rejects(PtydClient.connect(older, '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log')), new RegExp(`speaks protocol ${PTYD_PROTOCOL - 1}, and this window protocol ${PTYD_PROTOCOL}: its runs keep running`));
		} finally {
			await new Promise<void>(resolve => fake.close(() => resolve()));
		}
	});

	test('a window joins the ptyd of an earlier protocol that holds its runs - in that protocol, starting none - and claims them there: an update ends none of them, and the window operates them through it; once none is left it lets that ptyd go (ARCHITECTURE-2.4, RULES-4.1)', async function () {
		this.timeout(20_000);
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-home-'));
		const protocol = EARLIER_PROTOCOLS[0];
		const earlierSocket = ptydSocketPath(home, protocol);
		// ptyd's five minutes for an absent owner, run by hand
		const waits = new Set<() => void>();
		const earlier = new PtydServer(earlierSocket, () => undefined, { after: (_ms, run) => { waits.add(run); return { dispose: () => waits.delete(run) }; } }, protocol);
		assert.strictEqual(await earlier.listen(), true);
		// Each connection made to it: every one puts off the idle exit it waits for
		let connections = 0;
		(earlier as unknown as { readonly server: net.Server }).server.on('connection', () => connections++);
		const said: string[] = [];
		const lost: number[] = [];
		// Whether the window is closing a run through it
		let busy = false;
		const hold = new EarlierPtyds(home, { owner: 'w1', generation: 2, token: 'after' }, { log: line => said.push(line), lost: each => lost.push(each), ownerLost: () => assert.fail('No newer activation took the workspace.'), busy: () => busy });
		const other = new EarlierPtyds(home, { owner: 'w2', generation: 1, token: 'other' }, { log: () => undefined, lost: () => undefined, ownerLost: () => undefined });
		try {
			// The window before the update starts a run there, and goes as it reloads into this build
			const before = (await PtydClient.join(earlierSocket, protocol))!;
			await before.request('claim', { owner: 'w1', generation: 1, token: 'before' });
			const { pid } = await spawn(before, 'run-kept', `process.stdout.write('ready\\r\\n'); ${eachLine("process.stdout.write('got ' + line + '\\r\\n');")}`);
			await until('its initial screen', async () => (await before.request('attach', { run: 'run-kept' })).screen.includes('ready'));
			before.dispose();
			await until('ptyd to wait for its owner', () => waits.size === 1);
			// Another workspace's window finds none of its runs there, and does not ask again
			await assert.rejects(other.client(protocol), PtydGone);
			const asked = connections;
			await other.find();
			await assert.rejects(other.client(protocol), PtydGone);
			assert.strictEqual(connections, asked);
			// The reloaded window joins it in its protocol and claims the run there, once, asked again on a reconnect
			await hold.find();
			await hold.find();
			assert.strictEqual(waits.size, 0, 'no wait is left to end it five minutes later');
			assert.ok(alive(pid));
			assert.deepStrictEqual(hold.clients.map(([each]) => each), [protocol]);
			assert.deepStrictEqual(said, [`1 agents an earlier Facade Code started are in a ptyd of protocol ${protocol}: this window shows them and keeps them running until it closes.`]);
			// And operates it there: its screen, what is typed, what it answers
			const client = await hold.client(protocol);
			const events = eventsOf(client, 'run-kept');
			const { screen } = await client.request('attach', { run: 'run-kept' });
			assert.ok(screen.includes('ready'), screen);
			await client.request('input', { run: 'run-kept', data: 'old\r' });
			await until('its answer', () => outputOf(events).includes('got old'));
			await hold.check();
			assert.strictEqual(said.length, 1, 'still running, still held');
			// It ends; while the window shows how, it is held still. Forgotten, the next check lets that ptyd go, which then waits for
			// the owner as for any window, to exit once idle
			process.kill(pid, 'SIGKILL');
			await until('its end', async () => (await client.request('list', { owner: 'w1' }))[0]?.exited);
			await hold.check();
			assert.strictEqual(said.length, 1, 'an end still shown keeps it held');
			await client.request('forget', { run: 'run-kept' });
			// While the window closes a run through it, it is held still
			busy = true;
			await hold.check();
			assert.deepStrictEqual([said.length, hold.clients.length], [1, 1], 'not let go with a close under way');
			busy = false;
			await hold.check();
			assert.strictEqual(said[1], `The agents an earlier Facade Code started in a ptyd of protocol ${protocol} have ended: this window lets that ptyd go.`);
			assert.deepStrictEqual([hold.clients, lost], [[], []], 'letting it go is no loss');
			await until('ptyd to wait for its owner again', () => waits.size === 1);
			// Let go, it is not asked again: nothing puts off its idle exit
			const released = connections;
			await hold.find();
			await hold.check();
			await assert.rejects(hold.client(protocol), PtydGone);
			assert.strictEqual(connections, released);
		} finally {
			hold.dispose();
			other.dispose();
			earlier.close();
			fs.rmSync(earlierSocket, { force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test('the ptyd of an earlier protocol going takes the window\'s runs there with it: the loss is told, and joining again finds them gone; a ptyd that answers as another protocol than its socket\'s is not joined (ARCHITECTURE-2.4)', async function () {
		this.timeout(15_000);
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-home-'));
		const protocol = EARLIER_PROTOCOLS[0];
		const earlierSocket = ptydSocketPath(home, protocol);
		const earlier = new PtydServer(earlierSocket, () => undefined, undefined, protocol);
		assert.strictEqual(await earlier.listen(), true);
		const lost: number[] = [];
		const hold = new EarlierPtyds(home, { owner: 'w1', generation: 2, token: 'after' }, { log: () => undefined, lost: each => lost.push(each), ownerLost: () => undefined });
		const odd = new PtydServer(ptydSocketPath(home, protocol), () => undefined);
		try {
			const before = (await PtydClient.join(earlierSocket, protocol))!;
			await before.request('claim', { owner: 'w1', generation: 1, token: 'before' });
			await spawn(before, 'run-taken', IDLE);
			before.dispose();
			await hold.client(protocol);
			// Its ptyd goes - it ended, or was ended - and the window hears so
			earlier.close();
			await until('the loss told', () => lost.length === 1);
			assert.deepStrictEqual(lost, [protocol]);
			await assert.rejects(hold.client(protocol), PtydGone);
			// A ptyd of this build's protocol on that socket - none would listen there - is not joined as the earlier one
			assert.strictEqual(await odd.listen(), true);
			await assert.rejects(PtydClient.join(earlierSocket, protocol), new RegExp(`for protocol ${protocol} speaks protocol ${PTYD_PROTOCOL}: this window does not join it`));
		} finally {
			hold.dispose();
			earlier.close();
			odd.close();
			fs.rmSync(earlierSocket, { force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test('a ptyd of an earlier protocol that takes a connection and answers nothing is not taken for gone - its runs would be told ended - but asked again, each time in bounded time (ARCHITECTURE-2.4)', async function () {
		this.timeout(20_000);
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-home-'));
		const protocol = EARLIER_PROTOCOLS[0];
		const socket = ptydSocketPath(home, protocol);
		const taken: net.Socket[] = [];
		const silent = net.createServer(connection => { taken.push(connection); connection.on('data', () => undefined); });
		await new Promise<void>(resolve => silent.listen(socket, resolve));
		const hold = new EarlierPtyds(home, { owner: 'w1', generation: 2, token: 'after' }, { log: () => undefined, lost: () => undefined, ownerLost: () => undefined });
		try {
			const started = Date.now();
			await assert.rejects(hold.client(protocol), PtydNotSent);
			assert.ok(Date.now() - started < 8_000, `answered in ${Date.now() - started} ms`);
			const asked = taken.length;
			await assert.rejects(hold.client(protocol), PtydNotSent);
			assert.ok(taken.length > asked, 'asked again');
		} finally {
			hold.dispose();
			taken.forEach(each => each.destroy());
			await new Promise<void>(resolve => silent.close(() => resolve()));
			fs.rmSync(socket, { force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test('a terminal title longer than any tab shows is kept and told cut, so that no message of the run outgrows a frame (ARCHITECTURE-2.4)', async () => {
		const client = await connect();
		const events = eventsOf(client, 'titled');
		await spawn(client, 'titled', `process.stdout.write('\\x1b]0;' + 'x'.repeat(20000) + '\\x07ready'); ${IDLE}`);
		const told = await until('its title', () => events.find(event => event.event === 'title') as { title: string } | undefined);
		const listed = (await client.request('list', { owner: 'w1' })).find(run => run.run === 'titled');
		assert.deepStrictEqual([told.title.length, listed?.title.length, told.title.startsWith('xxx')], [4096, 4096, true]);
		await client.request('terminate', { run: 'titled', graceMs: 200 });
	});

	test('a run held back - its window not reading - is ended and its end confirmed: what it writes is read on as it ends (LIFECYCLE-4.2, ARCHITECTURE-2.4)', async function () {
		this.timeout(15_000);
		const run = new runModule.Run({ run: 'flood', owner: 'w1', file: process.execPath, args: ['-e', "const text = 'flood\\n'.repeat(1024); function write() { while (process.stdout.write(text)) {} process.stdout.once('drain', write); } write();"], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: {} });
		try {
			await new Promise(resolve => setTimeout(resolve, 200));
			run.hold({});
			// Its terminal's buffer full and its writes blocked, as a window that stopped reading leaves it
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.strictEqual(await run.terminate(500), 'terminated');
		} finally {
			run.dispose();
		}
	});

	test('a run started is claimed by its window: its numbered output, what it is typed and its end reach that window', async () => {
		const client = await connect();
		const events = eventsOf(client, 'r1');
		const info = await spawn(client, 'r1', `process.stdout.write('started\\n'); ${eachLine(finish(`'got ' + line + '\\n'`, 3))}`);
		assert.ok(info.pid > 1);
		assert.deepStrictEqual([info.claimedElsewhere, info.seq], [false, 0]);
		await until('its first line', () => outputOf(events).includes('started'));
		await client.request('input', { run: 'r1', data: 'hello\r' });
		await until('its answer', () => outputOf(events).includes('got hello'));
		const exit = await until('its end', () => events.find(event => event.event === 'exit'));
		assert.deepStrictEqual(exit, { event: 'exit', run: 'r1', exitCode: 3 });
		const numbers = events.flatMap(event => event.event === 'output' ? [event.seq] : []);
		assert.deepStrictEqual(numbers, numbers.map((_, i) => i + 1));
	});

	test('a run ID is never started twice, even once its run was forgotten (RULES-2.2)', async () => {
		const client = await connect();
		await spawn(client, 'once', 'process.exit(0)');
		await until('its end', async () => (await client.request('list', { owner: 'w1' })).find(run => run.run === 'once')?.exited);
		await client.request('forget', { run: 'once' });
		assert.deepStrictEqual(await client.request('list', { owner: 'w1' }), []);
		await assert.rejects(spawn(client, 'once', 'process.exit(0)'), /was started before: ptyd never starts a run ID twice/);
		await assert.rejects(client.request('input', { run: 'nope', data: 'x' }), /No run nope/);
	});

	test('a window that goes leaves its runs running, unclaimed; a window of the same workspace claims and draws one again, every output after its screen once', async () => {
		const first = await connect();
		const early = eventsOf(first, 'r2');
		await spawn(first, 'r2', `process.stdout.write('\\x1b]0;Working\\x07before\\n'); ${eachLine(`process.stdout.write('after ' + line + '\\n');`)} ${IDLE}`);
		await until('its line', () => outputOf(early).includes('before'));
		first.dispose();
		await new Promise(resolve => setTimeout(resolve, 300));
		const second = await connect();
		const [listed] = await second.request('list', { owner: 'w1' });
		assert.deepStrictEqual([listed.run, listed.exited, listed.claimedElsewhere, listed.title], ['r2', undefined, false, 'Working']);
		const events = eventsOf(second, 'r2');
		const { screen, seq, info } = await second.request('attach', { run: 'r2' });
		assert.ok(screen.includes('before') && !screen.includes('after'), JSON.stringify(screen));
		assert.strictEqual(seq, info.seq);
		await second.request('input', { run: 'r2', data: 'x\r' });
		await until('its new output', () => outputOf(events).includes('after x'));
		assert.ok(events.every(event => event.event !== 'output' || event.seq > seq));
		assert.ok(!outputOf(events).includes('before'));
	});

	test('a newer activation takes the same process immediately and fences every stale effect and later reconnect', async () => {
		const first = await connect();
		const before = await spawn(first, 'r3', IDLE);
		const lost: string[] = [];
		first.onDidLoseOwner(owner => lost.push(owner));
		const second = await connect();
		await until('the transfer notice', () => lost.length === 1);
		const attached = await second.request('attach', { run: 'r3' });
		assert.deepStrictEqual([attached.info.pid, attached.info.startedAt, lost], [before.pid, before.startedAt, ['w1']]);
		for (const operation of [
			() => first.request('attach', { run: 'r3' }),
			() => first.request('input', { run: 'r3', data: 'stale' }),
			() => first.request('resize', { run: 'r3', cols: 1, rows: 1 }),
			() => first.request('setMeta', { run: 'r3', meta: { name: 'stale' } }),
			() => first.request('terminate', { run: 'r3', graceMs: 0 }),
			() => first.request('forget', { run: 'r3' }),
			() => first.request('endWindow', { owner: 'w1', graceMs: 0 }),
			() => spawn(first, 'stale-run', IDLE),
			() => first.request('claim', { owner: 'w1', generation: 1, token: 'activation-1' })
		]) {
			await assert.rejects(operation(), /ownership was transferred or expired/);
		}
		first.dispose();
		const resumedOld = await connect(false);
		await assert.rejects(resumedOld.request('claim', { owner: 'w1', generation: 1, token: 'activation-1' }), /ownership was transferred or expired/);
		const [after] = await second.request('list', { owner: 'w1' });
		assert.deepStrictEqual([after.pid, after.exited, after.cols, after.rows, after.meta], [before.pid, undefined, 80, 24, { name: 'r3' }]);
	});

	test('terminate hangs up the process group and answers its actual end; one that ignores the hang-up is killed after the grace, its children with it; an ended or unknown run already exited (LIFECYCLE-4.2)', async () => {
		const client = await connect();
		const events = eventsOf(client, 'stubborn');
		await spawn(client, 'polite', IDLE);
		assert.strictEqual(await client.request('terminate', { run: 'polite', graceMs: 3_000 }), 'terminated');
		// It and the child it started both ignore the hang-up: only the group kill ends the child. Windows has no hang-up: the processes
		// of its console are ended at once, the child with them.
		const ignoring = `process.on('SIGHUP', () => {});`;
		await spawn(client, 'stubborn', `${ignoring} const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`${ignoring} ${IDLE}`)}], { stdio: 'inherit' }); process.stdout.write('child ' + child.pid + '\\n'); ${IDLE}`);
		const child = Number((await until('its child', () => /child (\d+)/.exec(outputOf(events)) ?? undefined))[1]);
		assert.ok(alive(child));
		const began = Date.now();
		assert.strictEqual(await client.request('terminate', { run: 'stubborn', graceMs: 300 }), 'terminated');
		const exit = await until('its end', () => events.find(event => event.event === 'exit'));
		if (process.platform !== 'win32') {
			assert.ok(Date.now() - began >= 300);
			assert.strictEqual(exit.event === 'exit' && exit.signal, 9);
		}
		await until('its child to be gone', () => !alive(child));
		assert.strictEqual(await client.request('terminate', { run: 'stubborn', graceMs: 300 }), 'already_exited');
		assert.strictEqual(await client.request('terminate', { run: 'never', graceMs: 300 }), 'already_exited');
	});

	test('a snapshot that finishes after takeover cannot bind the old connection', async () => {
		const old = await connect();
		const original = await spawn(old, 'snapshot-race', IDLE);
		let release!: () => void;
		let entered!: () => void;
		const began = new Promise<void>(resolve => entered = resolve);
		snapshotGate = { waiting: new Promise(resolve => release = resolve), entered };
		const attaching = old.request('attach', { run: 'snapshot-race' });
		await began;
		const current = await connect();
		const rejected = assert.rejects(attaching, /ownership was transferred or expired/);
		release();
		await rejected;
		const snapshot = await current.request('attach', { run: 'snapshot-race' });
		assert.deepStrictEqual([snapshot.info.pid, snapshot.info.startedAt], [original.pid, original.startedAt]);
	});

	test('a close accepted before takeover cannot be restored while its forced cleanup is pending', async () => {
		const old = await connect();
		const events = eventsOf(old, 'closing-race');
		const original = await spawn(old, 'closing-race', `process.on('SIGHUP', () => {}); process.stdout.write('ready\\n'); ${IDLE}`);
		await until('the hangup handler', () => outputOf(events).includes('ready'));
		const closing = old.request('terminate', { run: 'closing-race', graceMs: 150 });
		await until('close accepted', async () => (await old.request('list', { owner: 'w1' })).length === 0);
		const current = await connect();
		await assert.rejects(current.request('attach', { run: 'closing-race' }), /No run/);
		assert.strictEqual(await closing, 'terminated');
		await until('the original process ended', () => !alive(original.pid));
	});

	test('a forgotten run is dropped as it ends; an owner disconnect retains live processes inside the grace period', async () => {
		const client = await connect();
		const events = eventsOf(client, 'r4');
		await spawn(client, 'r4', eachLine('process.exit(0);'));
		await client.request('forget', { run: 'r4' });
		assert.deepStrictEqual(await client.request('list', { owner: 'w1' }), []);
		await client.request('input', { run: 'r4', data: '\r' });
		await until('its end', () => events.find(event => event.event === 'exit'));
		await until('it to be dropped', async () => {
			try {
				await client.request('input', { run: 'r4', data: 'x' });
				return false;
			} catch (err) {
				return /No run r4/.test(String(err));
			}
		});
		const kept = await connect();
		const lone = await spawn(kept, 'r5', IDLE);
		kept.dispose();
		await new Promise(resolve => setTimeout(resolve, 500));
		const other = await connect();
		const [listed] = await other.request('list', { owner: 'w1' });
		assert.deepStrictEqual([listed.run, listed.exited, alive(lone.pid)], ['r5', undefined, true]);
	});

	test('endWindow requires current ownership and ends only that workspace', async () => {
		const mine = await connect();
		await spawn(mine, 'm1', IDLE);
		const theirs = await connect(false);
		await theirs.request('claim', { owner: 'w2', generation: 1, token: 'other-workspace' });
		await spawn(theirs, 't1', IDLE, { owner: 'w2' });
		await assert.rejects(mine.request('endWindow', { owner: 'w2', graceMs: 0 }), /ownership was transferred or expired/);
		assert.strictEqual(await mine.request('endWindow', { owner: 'w1', graceMs: 1_000 }), 1);
		assert.deepStrictEqual((await theirs.request('list', { owner: 'w2' })).map(run => run.run), ['t1']);
	});

	test('a resize reaches the process', async () => {
		const client = await connect();
		const events = eventsOf(client, 'r6');
		await spawn(client, 'r6', `process.stdout.write('one\\n'); ${eachLine(`const [columns, rows] = process.stdout.getWindowSize(); process.stdout.write(rows + ' ' + columns + '\\n');`)} ${IDLE}`);
		await until('its line', () => outputOf(events).includes('one'));
		await client.request('resize', { run: 'r6', cols: 100, rows: 30 });
		await client.request('input', { run: 'r6', data: '\r' });
		await until('its size', () => outputOf(events).includes('30 100'));
	});

	test('a duplicate request and a reply lost before reconnect never repeat terminal input or spawn', async () => {
		const raw = net.connect(socketPath);
		extra.push(raw);
		raw.setEncoding('utf8');
		const replies: { id?: number; error?: string; result?: unknown }[] = [];
		raw.on('data', lineReader(line => replies.push(JSON.parse(line))));
		await new Promise(resolve => raw.once('connect', resolve));
		const send = (id: number, method: string, params: object) => raw.write(`${JSON.stringify({ id, method, params })}\n`);
		send(1, 'claim', { owner: 'w1', generation: 1, token: 'raw' });
		await until('claim', () => replies.find(reply => reply.id === 1));
		const output = path.join(socketDir, 'typed.txt');
		const program = `const fs = require('fs'); process.stdin.setRawMode(true); fs.appendFileSync(${JSON.stringify(output)}, 'START\\n'); process.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(output)}, d)); setInterval(() => {}, 1000);`;
		const params = { run: 'once', owner: 'w1', file: process.execPath, args: ['-e', program], cwd: socketDir, env: programEnv(), cols: 80, rows: 24, meta: {} };
		send(2, 'spawn', params);
		send(2, 'spawn', params);
		await until('duplicate spawn response', () => replies.filter(reply => reply.id === 2).length === 2);
		await until('the process to be ready', () => fs.existsSync(output));
		send(3, 'input', { run: 'once', data: '雪🙂' });
		send(3, 'input', { run: 'once', data: '雪🙂' });
		await until('input written', () => fs.readFileSync(output, 'utf8').includes('雪🙂'));
		send(3, 'input', { run: 'once', data: 'different' });
		await until('mismatched duplicate refused', () => replies.some(reply => reply.id === 3 && !!reply.error));
		send(4, 'attach', { run: 'once' });
		await until('screen', () => replies.some(reply => reply.id === 4 && !reply.error));
		send(4, 'attach', { run: 'once' });
		await until('screen reply is not retained in the effect cache', () => replies.some(reply => reply.id === 4 && !!reply.error));
		// Lose the connection after the effect. A later activation observes it; it sends no input again.
		raw.destroy();
		const recovered = await connect(false);
		await recovered.request('claim', { owner: 'w1', generation: 2, token: 'recovered' });
		const [run] = await recovered.request('list', { owner: 'w1' });
		assert.deepStrictEqual([run.run, fs.readFileSync(output, 'utf8')], ['once', 'START\n雪🙂']);
		await recovered.request('terminate', { run: 'once', graceMs: 100 });
	});

	test('a program that asks whether its terminal takes reports is answered at once; its reports, the title among them, reach the window that claims it', async () => {
		const client = await connect();
		const events = eventsOf(client, 'r8');
		const title = Buffer.from('Fixing tests').toString('base64');
		const program = `const out = s => process.stdout.write(s); process.stdin.setRawMode(true); out('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('\\x1b]7501;?:states=')) { out('\\x1b]7501;state=working:title=${title}\\x1b\\\\'); setTimeout(() => out('\\x1b]7501;id=worker:state=error\\x1b\\\\\\x1b]7501;state=blocked:kind=permission\\x1b\\\\'), 100); } }); setInterval(() => {}, 1000);`;
		await client.request('spawn', { run: 'r8', owner: 'w1', file: process.execPath, args: ['-e', program], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: {} });
		const statuses = await until('its reports', () => {
			const told = events.flatMap(event => event.event === 'status' && event.status ? [event.status] : []);
			return told.some(status => status.state === 'blocked') && told;
		});
		assert.deepStrictEqual(statuses.map(status => [status.state, status.negotiating, status.title, status.kind]), [
			['pending', true, undefined, undefined],
			['working', undefined, 'Fixing tests', undefined],
			['blocked', undefined, 'Fixing tests', 'permission']
		]);
	});

	test('a run whose adapter names a screen reader is read from its screen while its program reports nothing, as Muse Code on Windows; a program that asks is read by its own word alone (CLIS-2.3, D80)', async function () {
		this.timeout(10_000);
		const client = await connect();
		const idle = `── Voice input (Alt+V to start) ${'─'.repeat(30)}\r\n❯\r\n${'─'.repeat(60)}\r\n  muse-spark-1.3 · minimal · /work`;
		const working = `◈ Thinking (1s · esc to interrupt)\r\n\r\n${idle}`;
		const drawing = (ask: boolean) => `const out = s => process.stdout.write(s); ${ask ? 'out(\'\\x1b]7501;?\\x1b\\\\\');' : ''} out('\\x1b[2J\\x1b[H' + ${JSON.stringify(idle)}); setTimeout(() => out('\\x1b[2J\\x1b[H' + ${JSON.stringify(working)}), 600); setInterval(() => {}, 1000);`;
		const start = (run: string, ask: boolean) => client.request('spawn', { run, owner: 'w1', file: process.execPath, args: ['-e', drawing(ask)], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: {}, screenStatus: 'muse' });
		const statesOf = (events: readonly RunEvent[]) => events.flatMap(event => event.event === 'status' && event.status ? [event.status.state] : []);
		const read = eventsOf(client, 'screen');
		await start('screen', false);
		assert.deepStrictEqual(await until('its screen read as working', () => statesOf(read).includes('working') && statesOf(read)), ['idle', 'working']);
		// A window that claims it later is told what its screen showed
		assert.strictEqual((await client.request('list', { owner: 'w1' })).find(run => run.run === 'screen')?.status?.state, 'working');
		const asking = eventsOf(client, 'asking');
		await start('asking', true);
		await until('its question answered', () => statesOf(asking).length > 0);
		await new Promise(resolve => setTimeout(resolve, 1_200));
		assert.deepStrictEqual(statesOf(asking), ['pending']);
	});

	test('a window that does not take its output pauses the run once the output waiting for it passes the bound, and lets it go on once it is gone (ARCHITECTURE-2.4)', async function () {
		this.timeout(30_000);
		const observer = await connect(false);
		// A window that asks to start a flood and never reads what it is told
		const stalled = net.connect(socketPath);
		extra.push(stalled);
		await new Promise(resolve => stalled.once('connect', resolve));
		stalled.pause();
		stalled.write(`${JSON.stringify({ id: 1, method: 'claim', params: { owner: 'w1', generation: 1, token: 'stalled' } })}\n`);
		stalled.write(`${JSON.stringify({ id: 2, method: 'spawn', params: { run: 'flood', owner: 'w1', file: process.execPath, args: ['-e', `const line = 'x'.repeat(4095) + '\\n'; const go = () => { while (process.stdout.write(line)) { } process.stdout.once('drain', go); }; go();`], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: {} } })}\n`);
		const seqOf = async () => (await observer.request('list', { owner: 'w1' })).find(run => run.run === 'flood')?.seq ?? 0;
		// Its output stops once more than 8 MiB waits for the stalled window
		let last = -1;
		const paused = await until('the run to be paused', async () => {
			const now = await seqOf();
			await new Promise(resolve => setTimeout(resolve, 500));
			const later = await seqOf();
			last = later;
			return now > 0 && later === now && later;
		}, 20_000);
		assert.ok(paused > 0);
		stalled.destroy();
		await until('the run to go on', async () => await seqOf() > last, 10_000);
		await observer.request('claim', { owner: 'w1', generation: 2, token: 'observer' });
		await observer.request('terminate', { run: 'flood', graceMs: 200 });
	});
});

suite('ptyd: a run held back on Windows (LIFECYCLE-4.2, ARCHITECTURE-2.4)', function () {
	if (process.platform !== 'win32') {
		return;
	}

	test('a run its window stopped reading is ended and its end confirmed: ConPTY tells the exit once what it wrote is read', async function () {
		this.timeout(15_000);
		const shell = process.env.ComSpec ?? 'C:\Windows\System32\cmd.exe';
		const run = new runModule.Run({ run: 'flood', owner: 'w1', file: shell, args: ['/d', '/c', 'for /L %i in () do @echo flood flood flood flood flood flood'], cwd: os.tmpdir(), env: { ...process.env } as Record<string, string>, cols: 80, rows: 24, meta: {} });
		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			run.hold({});
			await new Promise(resolve => setTimeout(resolve, 800));
			assert.strictEqual(await run.terminate(1000), 'terminated');
		} finally {
			run.dispose();
		}
	});
});
