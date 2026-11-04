/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EarlierPtyds, PtydClient, PtydGone, PtydNotSent, ptydSocketPath } from '../host/execution/ptydClient';
import { lineReader } from '../base/lines';
import { EARLIER_PROTOCOLS, PTYD_PROTOCOL, RunEvent, SpawnParams } from '../ptyd/protocol';
import { PtydServer } from '../ptyd/server';
import * as runModule from '../ptyd/run';
import { eachLine, finish, IDLE, program, programEnv, ptydPlace } from './ptydPlace';
import { withModules } from './withModules';

/** A socket no earlier ptyd listens on, standing for the window's own (ARCHITECTURE-2.4). */
const OWN_SOCKET = path.join(os.tmpdir(), 'facade-test-own-ptyd.sock');

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

	test('two windows racing to resume one exact conversation start it only once, without exposing other metadata', async () => {
		const a = await connect();
		const b = await connect(false);
		await b.request('claim', { owner: 'w2', generation: 1, token: 'other-window' });
		const key = { environment: 'local', cli: 'claude', sessionId: 'exact-session' };
		const results = await Promise.allSettled([
			spawn(a, 'r-a', 'sleep 30', { meta: { ...key, name: 'private-name' } }),
			spawn(b, 'r-b', 'sleep 30', { owner: 'w2', meta: { ...key, name: 'private-name' } })
		]);
		assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
		const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
		assert.match(String(rejected.reason), /already running/);
		assert.deepStrictEqual(await a.request('conversations', {}), [key]);
		const won = results[0].status === 'fulfilled' ? [a, 'r-a'] as const : [b, 'r-b'] as const;
		await won[0].request('terminate', { run: won[1], graceMs: 50 });
		await until('the terminated conversation to leave the running list', async () => (await a.request('conversations', {})).length === 0 ? true : undefined);
	});

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
		const lost: string[] = [];
		// Whether the window is closing a run through it
		let busy = false;
		const hold = new EarlierPtyds(home, OWN_SOCKET, { owner: 'w1', generation: 2, token: 'after' }, { log: line => said.push(line), lost: each => lost.push(each), ownerLost: () => assert.fail('No newer activation took the workspace.'), busy: () => busy });
		const other = new EarlierPtyds(home, OWN_SOCKET, { owner: 'w2', generation: 1, token: 'other' }, { log: () => undefined, lost: () => undefined, ownerLost: () => undefined });
		try {
			// The window before the update starts a run there, and goes as it reloads into this build
			const before = (await PtydClient.join(earlierSocket, protocol))!;
			await before.request('claim', { owner: 'w1', generation: 1, token: 'before' });
			const { pid } = await spawn(before, 'run-kept', `process.stdout.write('ready\\r\\n'); ${eachLine("process.stdout.write('got ' + line + '\\r\\n');")}`);
			await until('its initial screen', async () => (await before.request('attach', { run: 'run-kept' })).screen.includes('ready'));
			before.dispose();
			await until('ptyd to wait for its owner', () => waits.size === 1);
			// Another workspace's window finds none of its runs there, and does not ask again
			await assert.rejects(other.client(earlierSocket), PtydGone);
			const asked = connections;
			await other.find();
			await assert.rejects(other.client(earlierSocket), PtydGone);
			assert.strictEqual(connections, asked);
			// The reloaded window joins it in its protocol and claims the run there, once, asked again on a reconnect
			await hold.find();
			await hold.find();
			assert.strictEqual(waits.size, 0, 'no wait is left to end it five minutes later');
			assert.ok(alive(pid));
			assert.deepStrictEqual(hold.clients.map(([each]) => each), [earlierSocket]);
			assert.deepStrictEqual(said, [`1 agents an earlier Facade Code started are in the ptyd ${path.basename(earlierSocket)} (protocol ${protocol}): this window shows them and keeps them running until it closes, and starts none there.`]);
			// And operates it there: its screen, what is typed, what it answers
			const client = await hold.client(earlierSocket);
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
			assert.strictEqual(said[1], `The agents an earlier Facade Code started in the ptyd ${path.basename(earlierSocket)} (protocol ${protocol}) have ended: this window lets that ptyd go.`);
			assert.deepStrictEqual([hold.clients, lost], [[], []], 'letting it go is no loss');
			await until('ptyd to wait for its owner again', () => waits.size === 1);
			// Let go, it is not asked again: nothing puts off its idle exit
			const released = connections;
			await hold.find();
			await hold.check();
			await assert.rejects(hold.client(earlierSocket), PtydGone);
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
		const lost: string[] = [];
		const hold = new EarlierPtyds(home, OWN_SOCKET, { owner: 'w1', generation: 2, token: 'after' }, { log: () => undefined, lost: each => lost.push(each), ownerLost: () => undefined });
		const odd = new PtydServer(ptydSocketPath(home, protocol), () => undefined);
		try {
			const before = (await PtydClient.join(earlierSocket, protocol))!;
			await before.request('claim', { owner: 'w1', generation: 1, token: 'before' });
			await spawn(before, 'run-taken', IDLE);
			before.dispose();
			await hold.client(earlierSocket);
			// Its ptyd goes - it ended, or was ended - and the window hears so
			earlier.close();
			await until('the loss told', () => lost.length === 1);
			assert.deepStrictEqual(lost, [earlierSocket]);
			await assert.rejects(hold.client(earlierSocket), PtydGone);
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

	test('the tool calls of a run a ptyd of an earlier protocol holds reach the window that joined it, which answers them: none waits without end (ARCHITECTURE-2.4, MCP-6.1)', async function () {
		this.timeout(20_000);
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-home-'));
		const protocol = EARLIER_PROTOCOLS[EARLIER_PROTOCOLS.length - 1];
		const earlierSocket = ptydSocketPath(home, protocol);
		const earlier = new PtydServer(earlierSocket, () => undefined, undefined, protocol);
		assert.strictEqual(await earlier.listen(), true);
		const refused = { text: 'protocol_incompatible', structured: { status: 'failure', error: { code: 'UNAVAILABLE', reason: 'protocol_incompatible' }, effects: { outcome: 'none' } }, isError: true };
		const heard: unknown[] = [];
		const hold = new EarlierPtyds(home, OWN_SOCKET, { owner: 'w1', generation: 2, token: 'after' }, { log: () => undefined, lost: () => undefined, ownerLost: () => undefined,
			connected: client => client.onCall(event => { heard.push(event.call); void client.request('answer', { id: event.id, answer: refused }); }) });
		let shim: net.Socket | undefined;
		try {
			const before = (await PtydClient.join(earlierSocket, protocol))!;
			await before.request('claim', { owner: 'w1', generation: 1, token: 'before' });
			await spawn(before, 'run-kept', IDLE);
			before.dispose();
			// The reloaded window shows the run through that ptyd, which makes it the run's window there
			await (await hold.client(earlierSocket)).request('attach', { run: 'run-kept' });
			// The run's shim, as the build before the update made it, calls a tool
			const connection = shim = net.connect(earlierSocket);
			await new Promise(resolve => connection.once('connect', resolve));
			const answers: { id: number; result?: unknown; error?: string }[] = [];
			connection.setEncoding('utf8');
			connection.on('data', lineReader(line => answers.push(JSON.parse(line)), err => { throw err; }));
			connection.write(`${JSON.stringify({ id: 1, method: 'hello', params: { protocol, role: 'shim', run: 'run-kept' } })}\n`);
			connection.write(`${JSON.stringify({ id: 2, method: 'call', params: { protocol: 2, caller: 'run-kept', tool: 'send_message', arguments: { to: '#a1', text: 'hi' }, callId: 'c-1', elapsedMs: 0 } })}\n`);
			const answered = await until('the call answered', () => answers.find(each => each.id === 2));
			assert.deepStrictEqual([heard.length, (heard[0] as { callId?: string }).callId, answered.result], [1, 'c-1', refused]);
		} finally {
			shim?.destroy();
			await hold.client(earlierSocket).then(client => client.request('terminate', { run: 'run-kept', graceMs: 50 })).catch(() => undefined);
			hold.dispose();
			earlier.close();
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
		const hold = new EarlierPtyds(home, OWN_SOCKET, { owner: 'w1', generation: 2, token: 'after' }, { log: () => undefined, lost: () => undefined, ownerLost: () => undefined });
		try {
			const started = Date.now();
			await assert.rejects(hold.client(socket), PtydNotSent);
			assert.ok(Date.now() - started < 8_000, `answered in ${Date.now() - started} ms`);
			const asked = taken.length;
			await assert.rejects(hold.client(socket), PtydNotSent);
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
		assert.strictEqual(info.claimedElsewhere, false);
		// ConPTY can emit its terminal initialization before the spawn reply. All output still has consecutive sequence numbers.
		assert.ok(Number.isSafeInteger(info.seq) && info.seq >= 0);
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

	test('a window opening the workspace within its grace takes its runs over, whichever window, local or remote - no claim ends them (RULES-4.1)', async () => {
		const window = async (generation: number, local: boolean) => {
			const client = await PtydClient.connect(socketPath, '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
			clients.push(client);
			await client.request('claim', { owner: 'w1', generation, token: `activation-${generation}`, local });
			return client;
		};
		const first = await window(1, true);
		const { pid } = await spawn(first, 'kept-local', IDLE);
		first.dispose();
		await new Promise(resolve => setTimeout(resolve, 300));
		const reopened = await window(2, true);
		assert.deepStrictEqual([alive(pid), (await reopened.request('list', { owner: 'w1' })).map(run => [run.run, run.exited])], [true, [['kept-local', undefined]]]);
		reopened.dispose();
		await new Promise(resolve => setTimeout(resolve, 300));
		const remote = await window(3, false);
		assert.deepStrictEqual((await remote.request('list', { owner: 'w1' })).map(run => run.run), ['kept-local']);
	});

	test('a claim while its grace is ending its runs is answered once they ended: its window restores its Pins after them, never beside them (LIFECYCLE-3.5)', async function () {
		this.timeout(20_000);
		const place = ptydPlace('fd-grace-');
		// The grace, run by hand, and each end held until the test lets it finish
		const graces: (() => void)[] = [];
		let release!: () => void;
		const held = new Promise<void>(resolve => release = resolve);
		class HeldEnd extends runModule.Run {
			override async terminate(graceMs: number) {
				await held;
				return super.terminate(graceMs);
			}
		}
		const Graced = withModules({ './run': { ...runModule, Run: HeldEnd } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const graced = new Graced(place.socket, () => undefined, { after: (_ms, run) => { graces.push(run); return { dispose: () => undefined }; } });
		try {
			assert.strictEqual(await graced.listen(), true);
			const window = async (generation: number) => {
				const client = await PtydClient.connect(place.socket, '/nonexistent/ptyd.js', path.join(place.dir, 'unused.log'));
				clients.push(client);
				await client.request('claim', { owner: 'w1', generation, token: `activation-${generation}`, local: true });
				return client;
			};
			const first = await window(1);
			const { pid } = await spawn(first, 'ending', IDLE);
			first.dispose();
			await until('its grace to start', () => graces.length === 1);
			graces[0]();
			let answered = false;
			const claiming = window(2).then(client => { answered = true; return client; });
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.strictEqual(answered, false, 'not answered while its run is still ending');
			release();
			const claimed = await claiming;
			assert.deepStrictEqual([alive(pid), await claimed.request('list', { owner: 'w1' }), await claimed.request('conversations', {})], [false, [], []]);
		} finally {
			graced.close();
			fs.rmSync(place.dir, { recursive: true, force: true });
		}
	});

	test('a run its grace ended without that end confirmed stays listed, uncertain, holding its conversation and never reattached, until it ends (ARCHITECTURE-2.2, LIFECYCLE-3.5)', async function () {
		this.timeout(20_000);
		const place = ptydPlace('fd-uncertain-');
		const graces: (() => void)[] = [];
		// An end that is not confirmed: the process goes on, as one Windows could not end
		class UnconfirmedEnd extends runModule.Run {
			override async terminate(): Promise<'unconfirmed'> { return 'unconfirmed'; }
		}
		const Graced = withModules({ './run': { ...runModule, Run: UnconfirmedEnd } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const graced = new Graced(place.socket, () => undefined, { after: (_ms, run) => { graces.push(run); return { dispose: () => undefined }; } });
		let pid = 0;
		try {
			assert.strictEqual(await graced.listen(), true);
			const window = async (generation: number) => {
				const client = await PtydClient.connect(place.socket, '/nonexistent/ptyd.js', path.join(place.dir, 'unused.log'));
				clients.push(client);
				await client.request('claim', { owner: 'w1', generation, token: `activation-${generation}`, local: true });
				return client;
			};
			const meta = { name: 'stuck', sessionId: 's-stuck', cli: 'claude', environment: 'local' };
			const first = await window(1);
			({ pid } = await spawn(first, 'stuck', IDLE, { meta }));
			first.dispose();
			await until('its grace to start', () => graces.length === 1);
			graces[0]();
			const claimed = await window(2);
			const [listed] = await claimed.request('list', { owner: 'w1' });
			assert.deepStrictEqual([listed.run, listed.uncertain, await claimed.request('conversations', {})], ['stuck', true, [{ environment: 'local', cli: 'claude', sessionId: 's-stuck' }]]);
			await assert.rejects(claimed.request('attach', { run: 'stuck' }), /No run stuck/);
			await assert.rejects(spawn(claimed, 'again', IDLE, { meta }), /already running in Facade/);
			// Its exit heard, it is listed no more
			process.kill(pid);
			await until('it to be let go', async () => (await claimed.request('list', { owner: 'w1' })).length === 0);
		} finally {
			if (pid && alive(pid)) { process.kill(pid); }
			graced.close();
			fs.rmSync(place.dir, { recursive: true, force: true });
		}
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

	test('a run that ended and is then terminated is let go of at once: no window, nor any listing, finds it again (LIFECYCLE-4.2)', async () => {
		const client = await connect();
		const events = eventsOf(client, 'ended');
		await spawn(client, 'ended', finish(`'done\\n'`, 0));
		await until('its end', () => events.find(event => event.event === 'exit'));
		assert.strictEqual(await client.request('terminate', { run: 'ended', graceMs: 100 }), 'already_exited');
		// Its window may go before it forgets the run: ptyd holds it no longer either way
		assert.deepStrictEqual((await client.request('list', {})).map(run => run.run), []);
		await assert.rejects(client.request('read', { run: 'ended', lines: 5 }), /No run ended/);
	});

	test('a run whose program never started is no run: its claim goes with it (ARCHITECTURE-2.3)', async () => {
		// A console that ends before its program has a PID, as Windows reports a program it could not start
		const pty = { pid: 0, onData() {}, onExit(listener: (event: { exitCode: number }) => void) { setTimeout(() => listener({ exitCode: 193 }), 20); }, kill() {}, write() {}, resize() {}, pause() {}, resume() {} };
		const Server = withModules({ 'node-pty': { spawn: () => pty } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const failing = new Server(pipe('failing'));
		assert.strictEqual(await failing.listen(), true);
		try {
			const client = await PtydClient.connect(pipe('failing'), '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
			clients.push(client);
			await client.request('claim', { owner: 'w1', generation: 1, token: 'failing' });
			await assert.rejects(spawn(client, 'never', IDLE), /Cannot create process \(error code: 193\)/);
			assert.deepStrictEqual([(failing as unknown as { claims: Map<unknown, unknown> }).claims.size, await client.request('list', {})], [0, []]);
		} finally {
			failing.close();
		}
	});

	// Twenty starts asked within seconds on Windows held ptyd for all their program creations at once - 0.2-1 s each - and the wait of
	// the last for its program ran out behind the others: "did not start within 10 seconds" (ARCHITECTURE-2.3)
	test('programs are created in turn: a run\'s once the one asked before it has its own, the run there meanwhile - listed, its conversation running, its details, size and input kept - and none created once it was closed (ARCHITECTURE-2.3)', async () => {
		const events: string[] = [];
		const consoles: { readonly cols: number; readonly rows: number; written: string }[] = [];
		// Consoles whose programs start when the test lets them, as node-pty's do on Windows once their output is connected
		const gates: (() => void)[] = [];
		const consoleOf = (_file: string, _args: string[], options: { readonly cols: number; readonly rows: number }) => {
			const id = consoles.push({ cols: options.cols, rows: options.rows, written: '' });
			events.push(`made ${id}`);
			const pty = { pid: 0, onData() {}, onExit() {}, kill() {}, write(data: string) { consoles[id - 1].written += data; }, resize() {}, pause() {}, resume() {} };
			gates[id] = () => { pty.pid = 1000 + id; events.push(`started ${id}`); };
			return pty;
		};
		const begin = async (id: number) => (await until(`console ${id}`, () => gates[id]))();
		const Server = withModules({ 'node-pty': { spawn: consoleOf } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const lined = new Server(pipe('lined'));
		assert.strictEqual(await lined.listen(), true);
		try {
			const open = async (generation: number) => {
				const client = await PtydClient.connect(pipe('lined'), '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
				clients.push(client);
				await client.request('claim', { owner: 'w1', generation, token: `lined-${generation}` });
				return client;
			};
			const client = await open(1);
			const conversation = { name: 'resumed', cli: 'claude', environment: 'local', sessionId: 's-1' };
			const a = spawn(client, 'a', IDLE);
			const b = spawn(client, 'b', IDLE, { meta: conversation });
			const c = spawn(client, 'c', IDLE);
			await until('the first console', () => consoles.length === 1);
			// While a's program starts, b and c wait their turn: they are there, b's conversation running, and each takes what a window gives it
			await assert.rejects(spawn(client, 'b2', IDLE, { meta: conversation }), /This conversation is already running in Facade/);
			assert.deepStrictEqual(await client.request('conversations', {}), [{ environment: 'local', cli: 'claude', sessionId: 's-1' }]);
			assert.deepStrictEqual((await client.request('list', { owner: 'w1' })).map(run => [run.run, run.pid]), [['a', 0], ['b', 0], ['c', 0]]);
			await client.request('setMeta', { run: 'b', meta: { ...conversation, name: 'renamed' } });
			await client.request('resize', { run: 'b', cols: 100, rows: 40 });
			await client.request('input', { run: 'b', data: 'typed early' });
			// c, closed, ends with no program ever created for it
			assert.strictEqual(await client.request('terminate', { run: 'c', graceMs: 0 }), 'terminated');
			await begin(1);
			await begin(2);
			const [first, second] = [await a, await b];
			assert.deepStrictEqual([first.pid, second.pid, second.meta.name, consoles[1].cols, consoles[1].rows, consoles[1].written], [1001, 1002, 'renamed', 100, 40, 'typed early']);
			await assert.rejects(c, /closed before its turn to start came/);
			assert.deepStrictEqual(events, ['made 1', 'started 1', 'made 2', 'started 2']);
			// One whose window lost its workspace while it waited is still started, as it was before: the newer activation finds it
			const d = spawn(client, 'd', IDLE);
			const e = spawn(client, 'e', IDLE);
			await until('the console of d', () => consoles.length === 3);
			const newer = await open(2);
			await begin(3);
			await begin(4);
			await Promise.allSettled([d, e]);
			assert.deepStrictEqual((await newer.request('list', { owner: 'w1' })).map(run => [run.run, run.pid]), [['a', 1001], ['b', 1002], ['d', 1003], ['e', 1004]]);
			assert.deepStrictEqual(events.slice(4), ['made 3', 'started 3', 'made 4', 'started 4']);
		} finally {
			lined.close();
		}
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
		// Node caches the TTY size until it handles SIGWINCH; input can arrive before that notification.
		await spawn(client, 'r6', `const reportSize = () => { const [columns, rows] = process.stdout.getWindowSize(); process.stdout.write(rows + ' ' + columns + '\\n'); };
			process.stdout.on('resize', reportSize); ${eachLine('reportSize();')} process.stdout.write('one\\n'); ${IDLE}`);
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
		raw.on('data', lineReader(line => replies.push(JSON.parse(line)), err => { throw err; }));
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
			['blocked', undefined, undefined, 'permission']
		]);
	});

	test('CLIS-2.3: a program\'s question whether ptyd takes reports is answered before any of its output reaches a window: a window\'s terminal answering its next question at once comes second, however far ptyd\'s own parse is behind', async function () {
		this.timeout(20_000);
		const client = await connect();
		const file = path.join(os.tmpdir(), `fd-answers-${process.pid}-${Date.now()}.txt`);
		// Much drawn first, then the question and the terminal's own identification (DA1) at once, as Claude Code asks them
		const program = `const fs = require('fs'); process.stdin.setRawMode(true); let got = ''; process.stdin.on('data', d => { got += d.toString('latin1'); fs.writeFileSync(${JSON.stringify(file)}, got); }); process.stdout.write('x'.repeat(2000000) + '\\x1b]7501;?\\x1b\\\\\\x1b[c'); setInterval(() => {}, 1000);`;
		let answered = false;
		client.onRunEvent('r-ask', event => {
			// The window answers the identification the moment it sees it
			if (!answered && event.event === 'output' && event.data.includes('\x1b[c')) {
				answered = true;
				void client.request('input', { run: 'r-ask', data: '\x1b[?62;22c' });
			}
		});
		try {
			await client.request('spawn', { run: 'r-ask', owner: 'w1', file: process.execPath, args: ['-e', program], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: {} });
			const got = await until('both answers', () => {
				try {
					const text = fs.readFileSync(file, 'latin1');
					return text.includes('\x1b]7501;?:states=') && text.includes('\x1b[?62;22c') && text;
				} catch {
					return false;
				}
			}, 15_000);
			assert.ok(got.indexOf('\x1b]7501;?:states=') < got.indexOf('\x1b[?62;22c'), JSON.stringify(got));
			assert.strictEqual(got.split('\x1b]7501;?:states=').length - 1, 1, 'answered once, not again as its parse reaches the question');
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	// Codex, made behind other tabs, asked its terminal's colours; its window's terminal answered once its tab was opened, long after
	// Codex stopped waiting: Codex read an Escape - its turn interrupted - and the answer as typed text (2026-11-03). What ptyd can
	// answer it answers at once, whoever claims the run; the editor's answers to those never reach the program (ARCHITECTURE-2.3)
	test('a program\'s question its headless terminal can answer is answered by ptyd at once, whether or not a window claims the run (ARCHITECTURE-2.3)', async () => {
		let emit: (data: string) => void = () => undefined;
		const written: string[] = [];
		const pty = { pid: 4242, onData(listener: (data: string) => void) { emit = listener; }, onExit() {}, kill() {}, write(data: string) { written.push(data); }, resize() {}, pause() {}, resume() {} };
		const Server = withModules({ 'node-pty': { spawn: () => pty } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const asking = new Server(pipe('asking'));
		assert.strictEqual(await asking.listen(), true);
		try {
			const open = async (generation: number) => {
				const client = await PtydClient.connect(pipe('asking'), '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
				clients.push(client);
				await client.request('claim', { owner: 'w1', generation, token: `asking-${generation}` });
				return client;
			};
			const window = await open(1);
			await spawn(window, 'asks', IDLE);
			// The program asks where its cursor is and what the terminal is; ptyd's answers are what it wrote to the program, read once
			// the questions are drawn
			const answered = async (client: PtydClient) => {
				const before = written.length;
				emit('\x1b[6n\x1b[c');
				await client.request('read', { run: 'asks', lines: 1 });
				return written.slice(before).join('');
			};
			const expected = '\x1b[1;1R\x1b[?1;2c';
			assert.strictEqual(await answered(window), expected, 'claimed by the window that started it');
			await window.request('attach', { run: 'asks' });
			assert.strictEqual(await answered(window), expected, 'its terminal drawing the screen');
			const reloaded = await open(2);
			await reloaded.request('attach', { run: 'asks' });
			assert.strictEqual(await answered(reloaded), expected, 'claimed by a reloaded window');
			reloaded.dispose();
			const next = await open(3);
			await until('ptyd answering with no window', async () => await answered(next) === expected);
		} finally {
			asking.close();
		}
	});

	// Codex waits 200 to 300 ms for its terminal's colours and reads a later answer as typed keys: an editor terminal's answer, through
	// the window and ptyd, can be later on a busy machine, and for a tab behind others is (2026-11-03)
	test('a program asking its terminal\'s colours is answered by ptyd at once with those its window said, and not at all before (ARCHITECTURE-2.3)', async () => {
		let emit: (data: string) => void = () => undefined;
		const written: string[] = [];
		const pty = { pid: 4343, onData(listener: (data: string) => void) { emit = listener; }, onExit() {}, kill() {}, write(data: string) { written.push(data); }, resize() {}, pause() {}, resume() {} };
		const Server = withModules({ 'node-pty': { spawn: () => pty } })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server')).PtydServer;
		const asking = new Server(pipe('colours'));
		assert.strictEqual(await asking.listen(), true);
		try {
			const open = async (generation: number) => {
				const client = await PtydClient.connect(pipe('colours'), '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
				clients.push(client);
				await client.request('claim', { owner: 'w1', generation, token: `colours-${generation}` });
				return client;
			};
			const window = await open(1);
			await spawn(window, 'asks', IDLE);
			const answered = async (client: PtydClient, question: string) => {
				const before = written.length;
				emit(question);
				await client.request('read', { run: 'asks', lines: 1 });
				return written.slice(before).join('');
			};
			assert.strictEqual(await answered(window, '\x1b]11;?\x1b\\'), '', 'no colours said yet: no answer, and the program uses its own');
			await window.request('colours', { foreground: 'cccc/cccc/cccc', background: '1919/1a1a/1b1b', cursor: 'aeaf/adad/b0b0' });
			assert.strictEqual(await answered(window, '\x1b]10;?\x1b\\\x1b]11;?\x07\x1b]12;?\x1b\\'),
				'\x1b]10;rgb:cccc/cccc/cccc\x1b\\\x1b]11;rgb:1919/1a1a/1b1b\x1b\\\x1b]12;rgb:aeaf/adad/b0b0\x1b\\');
			// A program setting its colours is no question; a window not saying its own yet leaves the run those it had
			assert.strictEqual(await answered(window, '\x1b]11;rgb:0000/0000/0000\x1b\\'), '');
			// ptyd's one thread held - as creating a program holds it - past a tenth of a second: a question that arrives within a second
			// after may have waited, and no answer is better than a late one; then it is answered again
			const heldUntil = Date.now() + 150;
			while (Date.now() < heldUntil) { /* held */ }
			await new Promise(resolve => setTimeout(resolve, 30));
			assert.strictEqual(await answered(window, '\x1b]11;?\x1b\\'), '', 'just held up: not answered');
			await new Promise(resolve => setTimeout(resolve, 1_100));
			assert.strictEqual(await answered(window, '\x1b]11;?\x1b\\'), '\x1b]11;rgb:1919/1a1a/1b1b\x1b\\', 'answered again a second after');
			const reloaded = await open(2);
			await reloaded.request('attach', { run: 'asks' });
			assert.strictEqual(await answered(reloaded, '\x1b]11;?\x1b\\'), '\x1b]11;rgb:1919/1a1a/1b1b\x1b\\');
			await reloaded.request('colours', { foreground: '3b3b/3b3b/3b3b', background: 'ffff/ffff/ffff' });
			assert.strictEqual(await answered(reloaded, '\x1b]11;?\x1b\\'), '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', 'the theme changed');
			await assert.rejects(reloaded.request('colours', { background: 'white' } as never), /Terminal colours are rrrr\/gggg\/bbbb/);
		} finally {
			asking.close();
		}
	});

	test('a run whose adapter names a screen reader is read from its screen while its program reports nothing, as Muse Code on Windows; a program that asks is read by its own word alone (CLIS-2.3)', async function () {
		this.timeout(10_000);
		const client = await connect();
		const input = `── Voice input (Alt+V to start) ${'─'.repeat(30)}\r\n❯\r\n${'─'.repeat(60)}\r\n  muse-spark-1.3 · minimal · /work`;
		const idle = `  Muse Code 1.4.14\r\n${input}`;
		const working = `◈ Thinking (1s · esc to interrupt)\r\n\r\n${input}`;
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

	test('screen status survives soft wrap and resize, loses invalidated evidence and recovers without retaining false working or idle', async function () {
		this.timeout(15_000);
		const client = await connect();
		const events = eventsOf(client, 'screen-reset');
		const input = `${'─'.repeat(60)}\r\n❯\r\n${'─'.repeat(60)}\r\n  model · effort · /work`;
		const work = `◈ Checking 编译结果 with a long description (3s · esc to interrupt)\r\n${input}`;
		const frame = (above: string) => `\x1b[2J\x1b[H${above}\r\n${input}`;
		const frames = {
			u: frame('◇ Future indicator (esc to cancel)'),
			r: '\x1bc',
			w: `\x1b[2J\x1b[H${work}`,
			i: frame('• READY'),
			s: '\x1b[?2026h\x1b[2J\x1b[H',
			e: `${work}\x1b[?2026l`
		};
		// PTY input is a stream: ConPTY may combine consecutive writes in one stdin chunk.
		const program = `process.stdin.setRawMode(true); const frames = ${JSON.stringify(frames)};
		process.stdout.write(frames.w); process.stdin.on('data', chunk => { for (const command of chunk.toString()) { process.stdout.write(frames[command] || ''); } });
		setInterval(() => {}, 1000);`;
		await spawn(client, 'screen-reset', program, { cols: 38, rows: 24, screenStatus: 'muse' });
		const latest = () => events.flatMap(event => event.event === 'status' && event.status ? [event.status] : []).at(-1);
		await until('soft wrapped work', () => latest()?.state === 'working');
		await client.request('resize', { run: 'screen-reset', cols: 100, rows: 24 });
		const send = (data: string) => client.request('input', { run: 'screen-reset', data });
		await send('s');
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.strictEqual(latest()?.state, 'working', 'an unfinished synchronized draw is not an observation');
		// Finish the synchronized draw and replace it in one write, regardless of how stdin groups the commands.
		await send('eu');
		await until('unknown layout revokes working', () => latest()?.unavailable === 'screen_unrecognized');
		await send('i');
		await until('a known resting layout recovers', () => latest()?.state === 'idle');
		await send('w');
		await until('work resumes', () => latest()?.state === 'working');
		await send('r');
		await until('a full reset revokes work', () => latest()?.unavailable === 'screen_reset');
		await until('claimable snapshot is also unknown', async () => (await client.request('list', { owner: 'w1' })).find(run => run.run === 'screen-reset')?.status?.state === 'pending');
		await send('w');
		await until('a fresh screen recovers after reset', () => latest()?.state === 'working');
	});

	test('Codex completion and follow-up status reach events, list and reattach while its background process remains alive (CLIS-2.3)', async function () {
		this.timeout(15_000);
		const client = await connect();
		const events = eventsOf(client, 'codex-background');
		const captures: { label: string; lines: string[]; dimLines: number[] }[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/screens/codex/0.166.0-background.json'), 'utf8'));
		const frame = (label: string) => {
			const capture = captures.find(each => each.label === label)!;
			return '\x1b[2J\x1b[H' + capture.lines.map((line, index) => capture.dimLines.includes(index) ? `\x1b[2m${line}\x1b[22m` : line).join('\r\n');
		};
		const native = (body: string) => `\x1b]7501;${body}\x1b\\`;
		const frames = {
			i: frame('background-completed'), w: frame('follow-up-working'), t: frame('follow-up-streaming'),
			s: '\x1b[?2026h' + frame('follow-up-working'), e: '\x1b[?2026l',
			b: native('state=blocked:kind=permission') + frame('background-completed'),
			f: native('state=error') + frame('background-completed'),
			c: native('state=clear') + frame('background-completed'),
			n: native('state=working') + frame('follow-up-working'),
			r: '\x1bc' + frame('background-completed')
		};
		const pidFile = path.join(socketDir, 'background.pid');
		const source = `process.stdin.setRawMode(true);
		const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
		process.on('exit', () => child.kill());
		const frames = ${JSON.stringify(frames)};
		process.stdout.write(frames.n);
		process.stdin.on('data', chunk => { for (const command of chunk.toString()) { process.stdout.write(frames[command] || ''); } });
		setInterval(() => {}, 1000);`;
		await spawn(client, 'codex-background', source, { cols: 120, rows: 40, screenStatus: 'codex-0.166' });
		const latest = () => events.flatMap(event => event.event === 'status' && event.status ? [event.status] : []).at(-1);
		const send = (data: string) => client.request('input', { run: 'codex-background', data });
		await until('native working', () => latest()?.state === 'working');
		await send('i');
		await until('completed turn', () => latest()?.state === 'idle');
		const firstCompletion = latest()!.at;
		const backgroundPid = Number(fs.readFileSync(pidFile, 'utf8'));
		assert.ok(alive(backgroundPid), 'the background process did not end with the interactive turn');
		await send('s');
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.strictEqual(latest()!.at, firstCompletion, 'a partial synchronized update is not a status observation');
		await send('e');
		await until('follow-up working without another native report', () => latest()?.state === 'working');
		await send('t');
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.strictEqual(latest()?.state, 'working', 'streaming has a background-only footer but no new completed-turn summary');
		await send('i');
		await until('next completion', () => latest()?.state === 'idle' && latest()!.at > firstCompletion);
		for (const [command, expected] of [['b', 'blocked'], ['f', 'error'], ['c', 'pending'], ['n', 'working'], ['r', 'pending'], ['n', 'working'], ['i', 'idle']]) {
			await send(command);
			await until(`native precedence: ${command}`, () => latest()?.state === expected);
		}
		assert.ok(alive(backgroundPid));
		const expected = latest();
		client.dispose();
		const recovered = await connect();
		assert.deepStrictEqual((await recovered.request('list', { owner: 'w1' })).find(run => run.run === 'codex-background')?.status, expected);
		assert.deepStrictEqual((await recovered.request('attach', { run: 'codex-background' })).info.status, expected);
		await recovered.request('terminate', { run: 'codex-background', graceMs: 100 });
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
