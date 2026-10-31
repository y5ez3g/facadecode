/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PtydClient } from '../host/execution/ptydClient';
import { CallEvent, InputReading, lineReader, PTYD_PROTOCOL, Response, RunEvent, ScreenRead } from '../ptyd/protocol';
import { SHIM_PTYD_PROTOCOL } from '../transport/ptydLink';
import { CLAIM_WAIT_MS, MOST_RUN_CALLS, PtydServer } from '../ptyd/server';
import { IDLE, program, ptydPlace } from './ptydPlace';

/** A shim's side of ptyd's socket, as bare JSON lines: each request answered with the whole response, error facts and all. */
interface FakeShim {
	readonly socket: net.Socket;
	readonly hello: Response;
	ask(method: string, params: unknown): Promise<Response & { readonly result?: unknown; readonly error?: string; readonly reason?: string; readonly effects?: string }>;
	call(fields?: { readonly [key: string]: unknown }): ReturnType<FakeShim['ask']>;
}

const answerOf = (text: string) => ({ text, structured: { status: 'success', data: { text }, effects: { outcome: 'none' } }, isError: false });

suite('ptyd: a run\'s tool calls carried to the window that claims it, and its answers back (MCP-6.1, RULES-1.2)', function () {
	test('the shim speaks ptyd\'s own protocol: a test holds the two equal, as the layers keep the shim from importing it', () => {
		assert.strictEqual(SHIM_PTYD_PROTOCOL, PTYD_PROTOCOL);
	});

	this.timeout(20_000);
	let socketPath: string;
	let socketDir: string;
	let server: PtydServer;
	const clients: PtydClient[] = [];
	const sockets: net.Socket[] = [];

	setup(async () => {
		({ dir: socketDir, socket: socketPath } = ptydPlace('fc-calls-'));
		generation = 0;
		server = new PtydServer(socketPath);
		assert.strictEqual(await server.listen(), true);
	});

	teardown(() => {
		clients.splice(0).forEach(client => client.dispose());
		sockets.splice(0).forEach(socket => socket.destroy());
		server.close();
		fs.rmSync(socketDir, { recursive: true, force: true });
	});

	let generation = 0;
	/** A window's connection, holding `owner`'s workspace with an activation newer than any before it (ARCHITECTURE-2.3). */
	const connect = async (owner: string | undefined = 'w1') => {
		const client = await PtydClient.connect(socketPath, '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
		clients.push(client);
		if (owner !== undefined) {
			await client.request('claim', { owner, generation: ++generation, token: `activation-${generation}` });
		}
		return client;
	};
	const spawn = (client: PtydClient, run: string, owner = 'w1') => client.request('spawn', {
		run, owner, ...program(IDLE), cwd: os.tmpdir(), cols: 80, rows: 24, meta: {}
	});
	const shimOf = async (run: string, protocol = PTYD_PROTOCOL): Promise<FakeShim> => {
		const socket = net.connect(socketPath);
		sockets.push(socket);
		await new Promise(resolve => socket.once('connect', resolve));
		let next = 1;
		const waiting = new Map<number, (response: Response) => void>();
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => {
			const response = JSON.parse(line) as Response;
			waiting.get(response.id)?.(response);
			waiting.delete(response.id);
		}));
		const ask: FakeShim['ask'] = (method, params) => new Promise(resolve => {
			const id = next++;
			waiting.set(id, resolve);
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		const hello = await ask('hello', { protocol, role: 'shim', run });
		return { socket, hello, ask, call: fields => ask('call', { caller: run, tool: 'list_agents', arguments: {}, callId: '1', elapsedMs: 0, ...fields }) };
	};
	const callsOf = (client: PtydClient) => {
		const calls: CallEvent[] = [];
		client.onCall(event => calls.push(event));
		return calls;
	};
	const eventsOf = (client: PtydClient, run: string) => {
		const events: RunEvent[] = [];
		client.onRunEvent(run, event => events.push(event));
		return events;
	};
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
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	const toolsOf = (events: readonly RunEvent[]) => events.filter(event => event.event === 'tools');

	test('a shim\'s hello tells the window that claims its run that its tools are there, and a window that claims the run later as well', async () => {
		const first = await connect();
		const events = eventsOf(first, 'r1');
		await spawn(first, 'r1');
		const shim = await shimOf('r1');
		assert.deepStrictEqual(shim.hello, { id: 1, result: { protocol: PTYD_PROTOCOL, pid: process.pid } });
		assert.deepStrictEqual(await until('the tools event', () => toolsOf(events).length && toolsOf(events)), [{ event: 'tools', run: 'r1' }]);
		// The window reloads: the one that claims the run next is told, once however often it attaches
		first.dispose();
		await until('the claim to go', async () => !(await shim.ask('call', { caller: 'r1', elapsedMs: CLAIM_WAIT_MS })).result);
		const second = await connect();
		const later = eventsOf(second, 'r1');
		await second.request('attach', { run: 'r1' });
		await second.request('attach', { run: 'r1' });
		assert.deepStrictEqual(toolsOf(later), [{ event: 'tools', run: 'r1' }]);
	});

	test('a call goes to the window that claims its caller, its time in ptyd added; that window\'s answer goes back, concurrent calls of the run matched by number', async () => {
		const window = await connect();
		const calls = callsOf(window);
		await spawn(window, 'r2');
		const shim = await shimOf('r2');
		const first = shim.call({ callId: 'a', tool: 'send_message', arguments: { to: '@human', text: 'hi' }, elapsedMs: 100 });
		const second = shim.call({ callId: 'b', elapsedMs: 5 });
		await until('both calls', () => calls.length === 2);
		const [a, b] = calls;
		assert.notStrictEqual(a.id, b.id);
		const { elapsedMs, ...rest } = a.call;
		assert.deepStrictEqual(rest, { caller: 'r2', tool: 'send_message', arguments: { to: '@human', text: 'hi' }, callId: 'a' });
		assert.ok(typeof elapsedMs === 'number' && elapsedMs >= 100, String(elapsedMs));
		assert.ok(b.call.elapsedMs >= 5);
		// Answered in the other order: each reaches its own call
		await window.request('answer', { id: b.id, answer: answerOf('B') });
		await window.request('answer', { id: a.id, answer: answerOf('A') });
		assert.deepStrictEqual([(await first).result, (await second).result], [answerOf('A'), answerOf('B')]);
		await assert.rejects(window.request('answer', { id: a.id, answer: answerOf('again') }), /No call \d+ waits for this window's answer/);
		// Only the window a call was given to answers it
		const third = shim.call({ callId: 'c' });
		await until('the third call', () => calls.length === 3);
		const other = await connect();
		await assert.rejects(other.request('answer', { id: calls[2].id, answer: answerOf('not mine') }), /No call/);
		await window.request('answer', { id: calls[2].id, answer: answerOf('C') });
		assert.deepStrictEqual((await third).result, answerOf('C'));
	});

	test('with no window claiming the run, a call waits for one within two seconds of the shim\'s ingress, and is refused window_unavailable with no effect once they pass', async () => {
		const reloading = await connect();
		await spawn(reloading, 'r3');
		reloading.dispose();
		const shim = await shimOf('r3');
		await new Promise(resolve => setTimeout(resolve, 100));
		// 1.5 s spent before ptyd: half a second is left
		const began = Date.now();
		const late = await shim.call({ elapsedMs: 1_500 });
		const waited = Date.now() - began;
		assert.deepStrictEqual([late.reason, late.effects], ['window_unavailable', 'none']);
		assert.match(late.error ?? '', /No Facade Code window holds r3 now: the call had no effect/);
		assert.ok(waited >= 400 && waited < 1_500, String(waited));
		const nothingLeft = Date.now();
		assert.strictEqual((await shim.call({ elapsedMs: CLAIM_WAIT_MS })).reason, 'window_unavailable');
		assert.ok(Date.now() - nothingLeft < 300);
		// A window claiming the run within the time takes the call, with the wait counted
		const waiting = shim.call({ callId: 'w' });
		await new Promise(resolve => setTimeout(resolve, 300));
		const reloaded = await connect();
		const calls = callsOf(reloaded);
		await reloaded.request('attach', { run: 'r3' });
		await until('the waiting call', () => calls.length === 1);
		assert.ok(calls[0].call.elapsedMs >= 300, String(calls[0].call.elapsedMs));
		await reloaded.request('answer', { id: calls[0].id, answer: answerOf('after the reload') });
		assert.deepStrictEqual((await waiting).result, answerOf('after the reload'));
	});

	test('a window that goes holding a call leaves its effects unknown; a shim that goes cancels nothing a window took', async () => {
		const window = await connect();
		const calls = callsOf(window);
		await spawn(window, 'r4');
		const shim = await shimOf('r4');
		const lost = shim.call();
		await until('the call', () => calls.length === 1);
		window.dispose();
		const refused = await lost;
		assert.deepStrictEqual([refused.reason, refused.effects], ['window_unavailable', 'unknown']);
		assert.match(refused.error ?? '', /went before it answered: the call may have taken effect/);
		const next = await connect();
		const nextCalls = callsOf(next);
		await next.request('attach', { run: 'r4' });
		const gone = await shimOf('r4');
		void gone.call({ callId: 'orphan' });
		await until('the orphan call', () => nextCalls.length === 1);
		gone.socket.destroy();
		await new Promise(resolve => setTimeout(resolve, 100));
		// The window's answer is refused, nobody being left to read it: it knows the answer was not handed back (MCP-4.2)
		await assert.rejects(next.request('answer', { id: nextCalls[0].id, answer: answerOf('late') }), /The MCP shim of r4 went before call \d+'s answer was handed back/);
	});

	test('a call that waited for a window goes to it only after the attach that claims the run is answered', async () => {
		const owner = await connect();
		await spawn(owner, 'r9');
		owner.dispose();
		const shim = await shimOf('r9');
		await new Promise(resolve => setTimeout(resolve, 100));
		const waiting = shim.call({ callId: 'during the reload' });
		// The reloaded window, as bare lines in the order ptyd wrote them
		const socket = net.connect(socketPath);
		sockets.push(socket);
		await new Promise(resolve => socket.once('connect', resolve));
		const lines: { id?: number; event?: string; result?: unknown }[] = [];
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => lines.push(JSON.parse(line))));
		socket.write(`${JSON.stringify({ id: 1, method: 'hello', params: { protocol: PTYD_PROTOCOL, role: 'window' } })}\n`);
		socket.write(`${JSON.stringify({ id: 2, method: 'claim', params: { owner: 'w1', generation: ++generation, token: 'bare' } })}\n`);
		socket.write(`${JSON.stringify({ id: 4, method: 'attach', params: { run: 'r9' } })}\n`);
		const call = await until('the waiting call', () => lines.find(line => line.event === 'call') as CallEvent | undefined);
		assert.ok(lines.findIndex(line => line.id === 4 && 'result' in line) < lines.indexOf(call), JSON.stringify(lines.map(line => line.event ?? line.id)));
		socket.write(`${JSON.stringify({ id: 5, method: 'answer', params: { id: call.id, answer: answerOf('reattached') } })}\n`);
		assert.deepStrictEqual((await waiting).result, answerOf('reattached'));
		// The window's answer is answered once the shim has it
		await until('the answer acknowledged', () => lines.some(line => line.id === 5 && !('error' in line)));
	});

	test('a query with a route deadline is refused window_unavailable with no effect once it passes; the window\'s late answer is refused', async () => {
		const window = await connect();
		const calls = callsOf(window);
		await spawn(window, 'r10');
		const shim = await shimOf('r10');
		const began = Date.now();
		const late = await shim.call({ tool: 'read_messages', routeDeadlineMs: 400, elapsedMs: 100 });
		const waited = Date.now() - began;
		assert.deepStrictEqual([late.reason, late.effects], ['window_unavailable', 'none']);
		assert.match(late.error ?? '', /No Facade Code window answered read_messages of r10 within 0.4 seconds: a query, it had no effect/);
		assert.ok(waited >= 250 && waited < 1_000, String(waited));
		assert.strictEqual(calls.length, 1);
		await assert.rejects(window.request('answer', { id: calls[0].id, answer: answerOf('too late') }), /No call \d+ waits for this window's answer/);
		// Answered in time, a query is the window's answer
		const answering = shim.call({ tool: 'list_agents', routeDeadlineMs: 5_000 });
		await until('the second call', () => calls.length === 2);
		await window.request('answer', { id: calls[1].id, answer: answerOf('in time') });
		assert.deepStrictEqual((await answering).result, answerOf('in time'));
	});

	test('a call of a run ptyd does not hold, or one forgotten, is refused not_found with no effect', async () => {
		const unknown = await shimOf('nope');
		assert.ok('result' in unknown.hello);
		const refused = await unknown.call();
		assert.deepStrictEqual([refused.reason, refused.effects], ['not_found', 'none']);
		assert.match(refused.error ?? '', /holds no agent run nope/);
		const window = await connect();
		await spawn(window, 'r5');
		await window.request('forget', { run: 'r5' });
		assert.strictEqual((await (await shimOf('r5')).call()).reason, 'not_found');
		// A call waiting for a window is refused as its run is forgotten
		const owner = await connect();
		await spawn(owner, 'r6');
		owner.dispose();
		const shim = await shimOf('r6');
		await new Promise(resolve => setTimeout(resolve, 100));
		const waiting = shim.call();
		await new Promise(resolve => setTimeout(resolve, 100));
		// The workspace's next activation forgets it: the earlier connections hold the workspace no longer
		const reopened = await connect();
		await reopened.request('forget', { run: 'r6' });
		assert.strictEqual((await waiting).reason, 'not_found');
	});

	test('a shim of another protocol is refused protocol_incompatible and its connection closed; a shim makes no window\'s requests, nor a window calls', async () => {
		const older = await shimOf('r7', PTYD_PROTOCOL - 1);
		assert.strictEqual('reason' in older.hello && older.hello.reason, 'protocol_incompatible');
		assert.match('error' in older.hello ? older.hello.error : '', new RegExp(`speaks protocol ${PTYD_PROTOCOL - 1}, and its agent runtime \\(ptyd\\) protocol ${PTYD_PROTOCOL}`));
		await until('its connection to close', () => older.socket.destroyed || older.socket.readableEnded);
		const shim = await shimOf('r7');
		assert.match((await shim.ask('list', {})).error ?? '', /A run's MCP shim does not list/);
		assert.match((await shim.ask('spawn', {})).error ?? '', /does not spawn/);
		const window = await connect();
		await assert.rejects(window.request('call', { caller: 'r7', elapsedMs: 0 }), /come from a run's MCP shim/);
		// Nor may a shim claim a workspace, attach a run or type into one
		for (const method of ['claim', 'attach', 'type', 'keys', 'read', 'inspect', 'terminate']) {
			assert.match((await shim.ask(method, {})).error ?? '', new RegExp(`A run's MCP shim does not ${method}`), method);
		}
	});

	test('a newer activation of the workspace takes its runs: calls wait for its attach and go to it, never to the window it replaced (ARCHITECTURE-2.3)', async () => {
		const old = await connect();
		const oldCalls = callsOf(old);
		await spawn(old, 'r11');
		const shim = await shimOf('r11');
		void shim.call({ callId: 'before' });
		await until('the call to the owner', () => oldCalls.length === 1);
		await old.request('answer', { id: oldCalls[0].id, answer: answerOf('old') });
		// The successor claims the workspace while the old window is still connected: the run is no longer the old window's
		const successor = await connect();
		const calls = callsOf(successor);
		const waiting = shim.call({ callId: 'during the takeover' });
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.deepStrictEqual([oldCalls.length, calls.length], [1, 0]);
		await assert.rejects(old.request('attach', { run: 'r11' }), /ownership was transferred or expired/);
		await successor.request('attach', { run: 'r11' });
		await until('the call to the successor', () => calls.length === 1);
		await successor.request('answer', { id: calls[0].id, answer: answerOf('successor') });
		assert.deepStrictEqual((await waiting).result, answerOf('successor'));
		assert.strictEqual(oldCalls.length, 1);
	});


	test('the calls under way for one run are bounded: past the bound one is refused capacity_exceeded, with no effect', async () => {
		const window = await connect();
		const calls = callsOf(window);
		await spawn(window, 'r8');
		const shim = await shimOf('r8');
		const answers = Array.from({ length: MOST_RUN_CALLS }, (_, i) => shim.call({ callId: String(i) }));
		await until('every call', () => calls.length === MOST_RUN_CALLS);
		const over = await shim.call({ callId: 'over' });
		assert.deepStrictEqual([over.reason, over.effects], ['capacity_exceeded', 'none']);
		await window.request('answer', { id: calls[0].id, answer: answerOf('0') });
		assert.deepStrictEqual((await answers[0]).result, answerOf('0'));
		void shim.call({ callId: 'room again' });
		await until('the call after one was answered', () => calls.length === MOST_RUN_CALLS + 1);
	});

	test('`list` with no owner gives every run ptyd holds, of every owner and removed or not; with one, that owner\'s shown runs', async () => {
		const window = await connect();
		const other = await connect('w2');
		await spawn(window, 'mine');
		await spawn(other, 'theirs', 'w2');
		await spawn(window, 'forgotten');
		await window.request('forget', { run: 'forgotten' });
		assert.deepStrictEqual((await window.request('list', {})).map(run => run.run).sort(), ['forgotten', 'mine', 'theirs']);
		assert.deepStrictEqual((await window.request('list', { owner: 'w1' })).map(run => run.run), ['mine']);
	});
});

suite('ptyd: a run\'s terminal read and written for its owner (MCP-5, CLIS-2.1, RULES-1.10)', function () {
	this.timeout(20_000);
	let socketDir: string;
	let socketPath: string;
	let server: PtydServer;
	const clients: PtydClient[] = [];

	setup(async () => {
		({ dir: socketDir, socket: socketPath } = ptydPlace('fc-term-'));
		server = new PtydServer(socketPath);
		assert.strictEqual(await server.listen(), true);
	});

	teardown(() => {
		clients.splice(0).forEach(client => client.dispose());
		server.close();
		fs.rmSync(socketDir, { recursive: true, force: true });
	});

	const window = async (owner: string, generation: number) => {
		const client = await PtydClient.connect(socketPath, '/nonexistent/ptyd.js', path.join(socketDir, 'unused.log'));
		clients.push(client);
		await client.request('claim', { owner, generation, token: `activation-${generation}` });
		return client;
	};
	/**
	 * A program like `cat` in a terminal that echoes, alike on every platform: what is typed is shown as it comes, and each line again
	 * once Enter ends it; Ctrl+D ends it.
	 */
	const cat = (client: PtydClient, run: string, owner = 'w1') => client.request('spawn', {
		run, owner, ...program(`process.stdin.setRawMode(true); let line = ''; process.stdin.on('data', chunk => { for (const char of String(chunk)) { if (char === '\\x04') { process.exit(0); } else if (char === '\\r' || char === '\\n') { process.stdout.write('\\r\\n' + line + '\\r\\n'); line = ''; } else { line += char; process.stdout.write(char); } } });`),
		cwd: os.tmpdir(), cols: 80, rows: 24, meta: {}
	});
	const screenUntil = async (client: PtydClient, run: string, check: (read: ScreenRead) => boolean): Promise<ScreenRead> => {
		const deadline = Date.now() + 5_000;
		for (; ;) {
			const read = await client.request('read', { run, lines: 10 });
			if (check(read) || Date.now() > deadline) {
				return read;
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};

	test('type pastes text and Enter in turn; read gives the rendered lines; keys press named keys; a reader that does not recognize the screen says unknown', async () => {
		const owner = await window('w1', 1);
		await cat(owner, 't1');
		assert.deepStrictEqual(await owner.request('type', { run: 't1', text: 'hello facade', enter: true }), { outcome: 'applied', pasted: true, entered: true });
		const read = await screenUntil(owner, 't1', each => each.text.filter(line => line.includes('hello facade')).length >= 2);
		// The terminal's echo of the input, and cat's own copy of the line
		assert.ok(read.text.filter(line => line.includes('hello facade')).length >= 2, JSON.stringify(read.text));
		assert.deepStrictEqual([read.buffer, read.exited], ['normal', false]);
		// cat draws no Claude Code input frame: never a guess that the input is empty (RULES-1.4)
		const reading: InputReading = await owner.request('inspect', { run: 't1', adapter: 'claude-frame' });
		assert.strictEqual(reading.state, 'unknown');
		assert.strictEqual((await owner.request('inspect', { run: 't1', adapter: 'no-such-reader' })).state, 'unknown');
		await assert.rejects(owner.request('keys', { run: 't1', keys: ['Hyper+Q'] }), /Not a key: "Hyper\+Q"/);
		assert.deepStrictEqual(await owner.request('keys', { run: 't1', keys: ['Ctrl+D'] }), { outcome: 'applied', keysSent: 1 });
		const ended = await screenUntil(owner, 't1', each => each.exited);
		assert.strictEqual(ended.exited, true);
		// An ended run takes no more input, its screen still read as its last
		assert.deepStrictEqual(await owner.request('type', { run: 't1', text: 'late', enter: false }), { outcome: 'not_applied', pasted: false, entered: false, reason: 'ended' });
		assert.strictEqual((await owner.request('inspect', { run: 't1', adapter: 'claude-frame' })).state, 'unknown');
	});

	test('only the workspace\'s current owner reads, types into or inspects its runs; a whole number of lines is read', async () => {
		const owner = await window('w1', 1);
		await cat(owner, 't2');
		const stranger = await window('w2', 1);
		for (const [method, params] of [['read', { run: 't2', lines: 5 }], ['type', { run: 't2', text: 'x', enter: false }], ['keys', { run: 't2', keys: ['Enter'] }], ['inspect', { run: 't2', adapter: 'claude-frame' }]] as const) {
			await assert.rejects(stranger.request(method, params as never), /ownership was transferred or expired/, method);
		}
		await assert.rejects(owner.request('read', { run: 't2', lines: 0 }), /whole number of lines/);
		await assert.rejects(owner.request('read', { run: 'nope', lines: 5 }), /No run nope/);
		// A successor activation reads the run; the one it replaced no longer does
		const successor = await window('w1', 2);
		assert.strictEqual((await successor.request('read', { run: 't2', lines: 5 })).exited, false);
		await assert.rejects(owner.request('read', { run: 't2', lines: 5 }), /ownership was transferred or expired/);
	});
});
