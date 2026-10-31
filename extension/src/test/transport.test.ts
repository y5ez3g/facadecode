/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { lineReader } from '../base/lines';
import { RUN_VARIABLE } from '../clis/environment';
import { instructionsFor } from '../schema/instructions';
import { TOOL_PROTOCOL, type ToolAnswer } from '../schema/protocol';
import { QUERY_ROUTE_MS, TOOLS } from '../schema/tools';
import { SHIM_AGENT, SHIM_PTYD, SHIM_RUN, shimLaunch } from '../transport/launch';
import { McpShim } from '../transport/mcpServer';
import { CallFailed, PtydLink, SHIM_PTYD_PROTOCOL } from '../transport/ptydLink';

/** The shim as compiled: run as its CLI runs it, with Node, over stdio. */
const SHIM = path.join(__dirname, '..', 'transport', 'shim.js');

/** A JSON-RPC message as the shim writes it. */
interface Message {
	readonly id?: string | number | null;
	readonly result?: any;
	readonly error?: { readonly code: number; readonly message: string };
}

/** A run's CLI as the shim's MCP client: requests by id, every message the shim wrote, and its exit. */
class McpClient {

	readonly messages: Message[] = [];
	readonly exited: Promise<number | null>;
	private next = 1;
	private readonly waiting = new Map<string | number, (message: Message) => void>();
	private readonly child: ChildProcess;

	constructor(env: { readonly [name: string]: string }) {
		// Windows' own variables, without which Node cannot start there, and nothing else of this process's environment
		const system = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {};
		this.child = spawn(process.execPath, [SHIM], { env: { PATH: process.env.PATH ?? '', ...system, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
		this.exited = new Promise(resolve => this.child.once('exit', code => resolve(code)));
		this.child.stdout!.on('data', lineReader(line => {
			const message = JSON.parse(line) as Message;
			this.messages.push(message);
			if (message.id !== undefined && message.id !== null) {
				this.waiting.get(message.id)?.(message);
				this.waiting.delete(message.id);
			}
		}, err => assert.fail(err)));
	}

	request(method: string, params?: unknown, id: string | number = this.next++): Promise<Message> {
		return new Promise(resolve => {
			this.waiting.set(id, resolve);
			this.write({ jsonrpc: '2.0', id, method, ...params !== undefined ? { params } : {} });
		});
	}

	/** A tools/call, its result as MCP gives it. */
	async call(name: string, args: unknown, id?: string | number): Promise<any> {
		const answer = await this.request('tools/call', { name, arguments: args }, id);
		assert.ok(answer.result, JSON.stringify(answer));
		return answer.result;
	}

	write(message: unknown): void {
		this.writeLine(JSON.stringify(message));
	}

	writeLine(line: string): void {
		this.child.stdin!.write(`${line}\n`);
	}

	/** Ends its input, as a CLI closing its MCP server does. */
	end(): Promise<number | null> {
		this.child.stdin!.end();
		return this.exited;
	}

	kill(): void {
		this.child.kill();
	}
}

/** One request a connection asked the fake ptyd, with the connection it came on. */
interface Asked {
	readonly id: number;
	readonly method: string;
	readonly params: any;
	readonly socket: net.Socket;
}

/**
 * ptyd as a run's shim sees it: it answers the shim's hello with its protocol, and keeps each call for the test to answer or refuse
 * as the window that claims the run would, through ptyd's `call` (ARCHITECTURE-2.3). The routing itself is ptyd's and its tests'.
 */
class FakePtyd {

	readonly asked: Asked[] = [];
	private readonly sockets = new Set<net.Socket>();
	private readonly server: net.Server;

	constructor(readonly socketPath: string, private readonly protocol = SHIM_PTYD_PROTOCOL) {
		this.server = net.createServer(socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
			socket.on('error', () => socket.destroy());
			socket.on('data', lineReader(line => {
				const request = JSON.parse(line) as Omit<Asked, 'socket'>;
				if (request.method === 'hello') {
					this.reply(socket, { id: request.id, result: { protocol: this.protocol, pid: process.pid } });
				}
				this.asked.push({ ...request, socket });
			}, () => socket.destroy()));
		});
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	hellos(): Asked[] {
		return this.asked.filter(each => each.method === 'hello');
	}

	calls(): Asked[] {
		return this.asked.filter(each => each.method === 'call');
	}

	answer(call: Asked, answer: unknown): void {
		this.reply(call.socket, { id: call.id, result: answer });
	}

	refuse(call: Asked, error: string, reason?: string, effects?: 'none' | 'unknown'): void {
		this.reply(call.socket, { id: call.id, error, ...reason ? { reason } : {}, ...effects ? { effects } : {} });
	}

	/** Every connection dropped, as ptyd going away or a window that claimed the run going mid-call. */
	drop(): void {
		this.sockets.forEach(socket => socket.destroy());
	}

	close(): Promise<void> {
		this.drop();
		return new Promise(resolve => this.server.close(() => resolve()));
	}

	private reply(socket: net.Socket, message: object): void {
		socket.write(`${JSON.stringify(message)}\n`);
	}
}

const answerOf = (text: string, isError = false): ToolAnswer => ({ text, structured: { status: isError ? 'failure' : 'success', data: { text }, effects: { outcome: 'confirmed' } }, isError });

const until = async <T>(what: string, check: () => T | undefined | false, ms = 5_000): Promise<T> => {
	const deadline = Date.now() + ms;
	for (; ;) {
		const value = check();
		if (value !== undefined && value !== false) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}.`);
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
};

/** The facts of a transport failure as the shim reports one: an error result whose text is its message. */
const failureOf = (result: any) => {
	assert.strictEqual(result.isError, true);
	assert.deepStrictEqual(result.content, [{ type: 'text', text: result.structuredContent.error.message }]);
	const { status, data, error, effects } = result.structuredContent;
	assert.deepStrictEqual([status, data], ['failure', {}]);
	return [error.code, error.reason, effects.outcome];
};

suite('Transport: the run\'s MCP shim (MCP-1.1, 1.2, 6.1)', function () {
	this.timeout(30_000);
	let socketDir: string;
	let socketPath: string;
	const fakes: FakePtyd[] = [];
	const shims: McpClient[] = [];
	const links: PtydLink[] = [];

	setup(() => {
		socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shim-'));
		fs.chmodSync(socketDir, 0o700);
		// A named pipe on Windows, a socket file elsewhere: as ptyd listens on each
		socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\facade-shim-test-${crypto.randomBytes(8).toString('hex')}` : path.join(socketDir, 'ptyd.sock');
	});

	teardown(async () => {
		shims.splice(0).forEach(shim => shim.kill());
		links.splice(0).forEach(link => link.dispose());
		await Promise.all(fakes.splice(0).map(fake => fake.close()));
		fs.rmSync(socketDir, { recursive: true, force: true });
	});

	const ptyd = async (protocol?: number) => {
		const fake = new FakePtyd(socketPath, protocol);
		fakes.push(fake);
		await fake.listen();
		return fake;
	};
	/** The shim of `run` as its CLI starts it, from the launch a window gives. */
	const shimOf = (run: string, more: { readonly [name: string]: string } = {}) => {
		const launch = shimLaunch({ runtime: process.execPath, script: SHIM, socket: socketPath, run });
		assert.deepStrictEqual([launch.command, launch.args], [process.execPath, [SHIM]]);
		const shim = new McpClient({ ...launch.env, [SHIM_AGENT]: '#a7', ...more });
		shims.push(shim);
		return shim;
	};
	const linkOf = (run: string, maxLineBytes?: number) => {
		const link = new PtydLink(socketPath, run, maxLineBytes);
		links.push(link);
		return link;
	};

	test('its launch names the run and ptyd\'s socket, and it reads the run\'s #aN from the variable the CLIs set', () => {
		assert.strictEqual(SHIM_AGENT, RUN_VARIABLE);
		assert.deepStrictEqual(shimLaunch({ runtime: '/editor/node', script: '/ext/dist/shim.js', socket: '/tmp/ptyd.sock', run: 'run-9' }), {
			command: '/editor/node',
			args: ['/ext/dist/shim.js'],
			env: { ELECTRON_RUN_AS_NODE: '1', [SHIM_RUN]: 'run-9', [SHIM_PTYD]: '/tmp/ptyd.sock' }
		});
		assert.deepStrictEqual([SHIM_RUN, SHIM_PTYD], ['FACADE_RUN', 'FACADE_PTYD']);
	});

	test('the handshake: the client\'s protocol version where the shim speaks it, else the newest; the nine tools in order; ping; notifications unanswered; unknown methods and unreadable lines refused', async () => {
		const shim = shimOf('run-1', { [SHIM_PTYD]: path.join(socketDir, 'nothing.sock') });
		const init = await shim.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
		assert.deepStrictEqual(init.result, {
			protocolVersion: '2025-03-26',
			capabilities: { tools: { listChanged: false } },
			// The compiled shim has no manifest beside it to read its version from
			serverInfo: { name: 'facade', version: 'unknown' },
			instructions: instructionsFor('#a7')
		});
		assert.strictEqual((await shim.request('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
		assert.strictEqual((await shim.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
		assert.strictEqual((await shim.request('initialize', {})).result.protocolVersion, '2025-06-18');
		const before = shim.messages.length;
		shim.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
		shim.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
		assert.deepStrictEqual(await shim.request('ping', undefined, 'p'), { jsonrpc: '2.0', id: 'p', result: {} });
		assert.strictEqual(shim.messages.length, before + 1);
		const listed = (await shim.request('tools/list', {})).result;
		assert.deepStrictEqual(listed.tools.map((tool: { name: string }) => tool.name), [
			'list_start_options', 'start_agent', 'list_agents', 'stop_agent', 'send_message', 'read_messages', 'read_screen', 'type_text', 'press_keys'
		]);
		// No pagination: the whole list, and nothing else
		assert.deepStrictEqual(listed, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		assert.deepStrictEqual((await shim.request('resources/list', {}, 9)).error?.code, -32601);
		assert.strictEqual((await shim.request('tools/call', { arguments: {} }, 10)).error?.code, -32602);
		shim.writeLine('{ not json');
		const unreadable = await until('the parse error', () => shim.messages.find(message => message.error?.code === -32700));
		assert.strictEqual(unreadable.id, null);
		// A batch is answered as one, its notifications unanswered
		shim.write([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
		await until('the batch answer', () => shim.messages.some(message => Array.isArray(message) && message.length === 1 && message[0].id === 'b1'));
		assert.strictEqual(await shim.end(), 0);
	});

	test('with nothing listening on ptyd\'s socket, or no run to speak for, a call is an error result that had no effect', async () => {
		const unreachable = shimOf('run-1', { [SHIM_PTYD]: path.join(socketDir, 'nothing.sock') });
		const result = await unreachable.call('list_agents', {});
		assert.deepStrictEqual(failureOf(result), ['UNAVAILABLE', 'window_unavailable', 'none']);
		assert.match(result.structuredContent.error.message, /cannot be reached at .*nothing\.sock/);
		const runless = new McpClient({ [SHIM_PTYD]: socketPath });
		shims.push(runless);
		assert.deepStrictEqual(failureOf(await runless.call('list_agents', {})), ['UNAVAILABLE', 'configuration_invalid', 'none']);
	});

	test('a call goes to ptyd as the run\'s shim and the window\'s answer comes back as an MCP result; concurrent calls are matched by id; the hello comes once per connection', async () => {
		const fake = await ptyd();
		const shim = shimOf('run-2');
		await shim.request('initialize', { protocolVersion: '2025-06-18' });
		// Initializing says hello at once, so that the window learns the run's tools are there
		const hello = await until('the hello', () => fake.hellos()[0]);
		assert.deepStrictEqual(hello.params, { protocol: SHIM_PTYD_PROTOCOL, role: 'shim', run: 'run-2' });
		const first = shim.call('send_message', { to: '@human', text: 'first' }, 7);
		const second = shim.call('list_agents', {}, 'x');
		const omitted = shim.request('tools/call', { name: 'list_agents' }, 'no-arguments');
		await until('three calls', () => fake.calls().length === 3);
		const byId = new Map(fake.calls().map(each => [each.params.callId, each]));
		const seven = byId.get('7')!;
		const { elapsedMs, ...rest } = seven.params;
		// Each call says the shim's tool protocol; a query has the route deadline of its ten seconds (MCP-1.3, 6.2)
		assert.deepStrictEqual(rest, { protocol: TOOL_PROTOCOL, caller: 'run-2', tool: 'send_message', arguments: { to: '@human', text: 'first' }, callId: '7' });
		assert.ok(typeof elapsedMs === 'number' && elapsedMs >= 0 && elapsedMs < 2_000, String(elapsedMs));
		assert.deepStrictEqual(byId.get('no-arguments')!.params.arguments, {});
		assert.deepStrictEqual([byId.get('x')!.params.routeDeadlineMs, byId.get('x')!.params.protocol], [QUERY_ROUTE_MS, TOOL_PROTOCOL]);
		fake.answer(byId.get('x')!, answerOf('the agents'));
		fake.answer(seven, answerOf('refused', true));
		fake.answer(byId.get('no-arguments')!, answerOf('none'));
		assert.deepStrictEqual(await second, { content: [{ type: 'text', text: 'the agents' }], structuredContent: answerOf('the agents').structured, isError: false });
		assert.deepStrictEqual(await first, { content: [{ type: 'text', text: 'refused' }], structuredContent: answerOf('refused', true).structured, isError: true });
		assert.strictEqual((await omitted).result.isError, false);
		// One connection to ptyd for all of them
		assert.strictEqual(fake.hellos().length, 1);
		// An answer the window gives in no readable form may still have acted
		const odd = shim.call('list_agents', {}, 'odd');
		await until('the fourth call', () => fake.calls().length === 4);
		fake.answer(fake.calls()[3], { text: 'no structure' });
		assert.deepStrictEqual(failureOf(await odd), ['UNAVAILABLE', 'protocol_incompatible', 'unknown']);
	});

	test('arguments and answers of several megabytes go whole both ways', async () => {
		const fake = await ptyd();
		const shim = shimOf('run-3');
		const text = 'é\n\t"🌍\\'.repeat(400_000);
		const answer = shim.call('type_text', { agent: '#a1', text }, 1);
		const call = await until('the call', () => fake.calls()[0], 10_000);
		assert.strictEqual(call.params.arguments.text, text);
		const back = `${text}${text}`;
		fake.answer(call, answerOf(back));
		const result = await answer;
		assert.strictEqual(result.content[0].text, back);
		assert.strictEqual(result.structuredContent.data.text, back);
	});

	test('what ptyd answers instead of a window is reported as it says: whether the call may have acted, and why', async () => {
		const fake = await ptyd();
		const shim = shimOf('run-4');
		const refusals: readonly [string | undefined, 'none' | 'unknown' | undefined, readonly string[]][] = [
			['not_found', undefined, ['NOT_FOUND', 'not_found', 'none']],
			['window_unavailable', 'none', ['UNAVAILABLE', 'window_unavailable', 'none']],
			['window_unavailable', 'unknown', ['UNAVAILABLE', 'window_unavailable', 'unknown']],
			['capacity_exceeded', 'none', ['UNAVAILABLE', 'capacity_exceeded', 'none']],
			// A refusal ptyd and this shim do not share is their protocols differing
			['something_else', undefined, ['UNAVAILABLE', 'protocol_incompatible', 'none']],
			[undefined, 'unknown', ['UNAVAILABLE', 'protocol_incompatible', 'unknown']]
		];
		for (const [n, [reason, effects, expected]] of refusals.entries()) {
			const result = shim.call('stop_agent', { agent: '#a2' }, n);
			const call = await until(`call ${n}`, () => fake.calls()[n]);
			fake.refuse(call, `refused as ${reason}`, reason, effects);
			const failed = await result;
			assert.deepStrictEqual(failureOf(failed), expected, String(reason));
			assert.strictEqual(failed.structuredContent.error.message, `refused as ${reason}`);
		}
	});

	test('ptyd\'s connection lost mid-call: effects unknown; the next call connects and says hello again', async () => {
		const fake = await ptyd();
		const shim = shimOf('run-5');
		const lost = shim.call('stop_agent', { agent: '#a2' });
		await until('the call', () => fake.calls().length === 1);
		fake.drop();
		const result = await lost;
		assert.deepStrictEqual(failureOf(result), ['UNAVAILABLE', 'window_unavailable', 'unknown']);
		assert.match(result.content[0].text, /may have taken effect/);
		const again = shim.call('list_agents', {});
		await until('the call on a new connection', () => fake.calls().length === 2);
		assert.strictEqual(fake.hellos().length, 2);
		fake.answer(fake.calls()[1], answerOf('again'));
		assert.strictEqual((await again).content[0].text, 'again');
	});

	test('a ptyd that answers with another protocol is reported protocol_incompatible, with no effect', async () => {
		await ptyd(SHIM_PTYD_PROTOCOL - 1);
		const result = await shimOf('run-6').call('list_agents', {});
		assert.deepStrictEqual(failureOf(result), ['UNAVAILABLE', 'protocol_incompatible', 'none']);
		assert.match(result.content[0].text, new RegExp(`speaks protocol ${SHIM_PTYD_PROTOCOL}, and its agent runtime \\(ptyd\\) protocol ${SHIM_PTYD_PROTOCOL - 1}`));
	});

	test('its input ending, it answers what was asked and ends; a window that took a call goes on with it', async () => {
		const fake = await ptyd();
		const shim = shimOf('run-7');
		const answer = shim.call('list_agents', {}, 1);
		await until('the call', () => fake.calls().length === 1);
		const exited = shim.end();
		await new Promise(resolve => setTimeout(resolve, 200));
		fake.answer(fake.calls()[0], answerOf('still answered'));
		assert.strictEqual((await answer).content[0].text, 'still answered');
		assert.strictEqual(await exited, 0);
	});

	test('a call longer than ptyd reads as one line is never sent: it had no effect, and the connection goes on', async () => {
		const fake = await ptyd();
		const link = linkOf('run-8', 400);
		const refused = await link.call({ tool: 'type_text', arguments: { agent: '#a1', text: 'x'.repeat(500) }, callId: '1' }, performance.now()).then(() => undefined, err => err);
		assert.ok(refused instanceof CallFailed);
		assert.deepStrictEqual([refused.code, refused.reason, refused.outcome], ['UNAVAILABLE', 'capacity_exceeded', 'none']);
		assert.match(refused.message, /more than the 400 bytes one call can carry\. It had no effect\./);
		const fits = link.call({ tool: 'list_agents', arguments: {}, callId: '2' }, performance.now());
		const call = await until('the call that fits', () => fake.calls()[0]);
		assert.strictEqual(call.params.callId, '2');
		fake.answer(call, { text: 'ok', structured: {}, isError: false });
		assert.deepStrictEqual(await fits, { text: 'ok', structured: {}, isError: false });
		assert.strictEqual(fake.hellos().length, 1);
	});

	test('an answer longer than one line may be gives the connection up: its calls may have acted, and the next call connects again', async () => {
		const fake = await ptyd();
		const link = linkOf('run-9', 400);
		const pending = link.call({ tool: 'read_screen', arguments: { agent: '#a1' }, callId: '1' }, performance.now()).then(() => undefined, err => err);
		const call = await until('the call', () => fake.calls()[0]);
		fake.answer(call, answerOf('y'.repeat(500)));
		const failed = await pending;
		assert.ok(failed instanceof CallFailed);
		assert.deepStrictEqual([failed.code, failed.reason, failed.outcome], ['UNAVAILABLE', 'window_unavailable', 'unknown']);
		assert.match(failed.message, /^The agent runtime \(ptyd\) sent an answer longer than one line may be \(A line exceeds 400 bytes\.\): the call may have taken effect\.$/);
		const next = link.call({ tool: 'list_agents', arguments: {}, callId: '2' }, performance.now());
		const second = await until('the call on a new connection', () => fake.calls()[1]);
		fake.answer(second, answerOf('fine'));
		assert.strictEqual(((await next) as ToolAnswer).text, 'fine');
		assert.strictEqual(fake.hellos().length, 2);
	});
});

suite('Transport: the MCP server of a run\'s shim (MCP-6.1)', () => {

	test('a request line too long to read is answered as an invalid request, and the requests after it are read as ever', async () => {
		const written: object[] = [];
		const logged: string[] = [];
		const shim = new McpShim({
			alias: '#a1',
			version: 'test',
			link: { connect: () => Promise.resolve(), call: () => Promise.resolve(answerOf('called')) },
			write: message => written.push(message),
			log: line => logged.push(line)
		});
		shim.oversized(new Error('A line exceeds 4 bytes.'));
		shim.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
		await shim.idle();
		assert.deepStrictEqual(written, [
			{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: it was not read. A line exceeds 4 bytes.' } },
			{ jsonrpc: '2.0', id: 1, result: {} }
		]);
		assert.deepStrictEqual(logged, ['Did not read a request: A line exceeds 4 bytes.']);
	});
});
