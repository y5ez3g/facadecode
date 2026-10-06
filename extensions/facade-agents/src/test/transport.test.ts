/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import { getEventListeners } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { DeferredPromise } from '../base/async';
import { PipeEndpoint } from '../transport/endpoint';
import { McpStdioServer } from '../transport/mcpServer';
import { PipeClient, PipeHandlers, PipeServer, pipePath } from '../transport/pipe';
import { helloOf, toolResultOf } from '../transport/protocol';
import { StdioMcpClient } from './mcpClient';
import { outcomeOf, sleep, tempDir, waitFor } from './util';

/** An MCP server on in-memory streams, whose tools are found once `toolsFound` resolves, and a way to talk to it. */
function mcpHarness(slowTool: (signal: AbortSignal, progress: (message: string) => void) => Promise<string>, toolsFound: Promise<void> = Promise.resolve()) {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines: object[] = [];
	const logged: string[] = [];
	let buffer = '';
	output.setEncoding('utf8');
	output.on('data', (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			lines.push(JSON.parse(buffer.slice(0, newline)));
			buffer = buffer.slice(newline + 1);
		}
	});
	const server = new McpStdioServer(input, output, {
		name: 'facade',
		version: '0.0.1',
		instructions: async () => 'Be brief.',
		listTools: async () => {
			await toolsFound;
			return [{ name: 'slow', title: 'Slow', description: 'Waits.', inputSchema: { type: 'object' } }, { name: 'boom', description: 'Fails.', inputSchema: { type: 'object' } }];
		},
		callTool: async (name, _args, context) => {
			if (name === 'boom') {
				throw new Error('it broke');
			}
			return { text: await slowTool(context.signal, context.progress), data: { ok: true } };
		},
		log: message => logged.push(message)
	});
	void server.start();
	return {
		lines,
		logged,
		send: (message: object | string) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
		/** Writes bytes as they are, as a pipe delivers a part of a message. */
		write: (bytes: Buffer) => input.write(bytes),
		/** Closes the server's input, as a CLI that quits does. */
		end: () => input.end(),
		response: async (id: number) => {
			for (let tries = 0; tries < 200; tries++) {
				const found = lines.find(line => (line as { id?: number }).id === id);
				if (found) {
					return found;
				}
				await sleep(10);
			}
			throw new Error(`no response to ${id}`);
		}
	};
}

suite('Transport: MCP over stdio', () => {

	test('negotiates the version, gives the instructions, lists tools, and returns text and structured content; a tool\'s failure is a result, an unknown tool or method an error', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
		mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'missing', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 6, method: 'server/discover' });

		assert.deepStrictEqual([await mcp.response(1), await mcp.response(2), await mcp.response(3), await mcp.response(4), await mcp.response(5), await mcp.response(6)], [
			{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'facade', version: '0.0.1' }, instructions: 'Be brief.' } },
			{ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'slow', title: 'Slow', description: 'Waits.', inputSchema: { type: 'object' } }, { name: 'boom', description: 'Fails.', inputSchema: { type: 'object' } }] } },
			{ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } } },
			{ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } },
			{ jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'Unknown tool: missing' } },
			{ jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'Method not found: server/discover' } }
		]);
	});

	test('an unknown version gets the newest one; a 2024 client gets no titles and no structured content', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
		const newest = await mcp.response(1) as { result: { protocolVersion: string } };
		const old = mcpHarness(async () => 'done');
		old.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
		old.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		old.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
		await old.response(1);

		assert.deepStrictEqual({ newest: newest.result.protocolVersion, tools: await old.response(2), call: await old.response(3) }, {
			newest: '2025-11-25',
			tools: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'slow', description: 'Waits.', inputSchema: { type: 'object' } }, { name: 'boom', description: 'Fails.', inputSchema: { type: 'object' } }] } },
			call: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'done' }] } }
		});
	});

	test('a progress token that is no string or number is not one: the call runs, and no progress names it', async () => {
		const mcp = mcpHarness(async (_signal, progress) => {
			progress('working');
			return 'done';
		});
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
		await mcp.response(1);
		mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {}, _meta: { progressToken: { not: 'a token' } } } });
		await mcp.response(2);

		assert.deepStrictEqual(mcp.lines.slice(1).map(line => (line as { method?: string }).method ?? 'response'), ['response']);
	});

	test('sends progress for a long call, and a cancelled call gets no response', async () => {
		const mcp = mcpHarness(async (signal, progress) => {
			progress('working');
			progress('still working');
			await sleep(10_000, signal);
			return 'never';
		});
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
		await mcp.response(1);
		mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {}, _meta: { progressToken: 'p1' } } });
		await waitFor(() => mcp.lines.length === 3);
		mcp.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } });
		// Long enough for an answer the cancelled call should not get.
		await sleep(100);

		assert.deepStrictEqual(mcp.lines.slice(1), [
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, message: 'working' } },
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 2, message: 'still working' } }
		]);
	});

	test('a line that is not JSON is a parse error, and the server keeps going', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send('not json');
		mcp.send({ jsonrpc: '2.0', id: 7, method: 'ping' });

		assert.deepStrictEqual([mcp.lines[0], await mcp.response(7)], [
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ jsonrpc: '2.0', id: 7, result: {} }
		]);
	});

	test('a request that is no request - not an object, an id neither string nor number, an empty batch - is refused as one, and parameters that are not an object count as none', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send('null');
		mcp.send({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' });
		mcp.send('[]');
		mcp.send({ jsonrpc: '2.0', id: 8, method: 'initialize', params: 'latest' });
		const initialized = await mcp.response(8) as { result?: { protocolVersion?: string } };
		const invalid = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };

		assert.deepStrictEqual({ refused: mcp.lines.filter(line => (line as { id?: unknown }).id === null), initialized: initialized.result?.protocolVersion }, {
			refused: [invalid, invalid, invalid],
			initialized: '2025-11-25'
		});
	});

	test('a batch, as revisions before 2025-06-18 may send, is answered once, with a response for each request in it: none for a notification, an error for what is no request', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send([
			{ jsonrpc: '2.0', id: 1, method: 'ping' },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } },
			7
		]);
		await waitFor(() => mcp.lines.length > 0);
		// Long enough for an answer the batch should not get apart from it.
		await sleep(50);

		assert.deepStrictEqual(mcp.lines, [[
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'done' }] } },
			{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
		]]);
	});

	test('what the server fails at - a line that is not JSON, a request it could not serve - is logged, never written where the protocol goes', async () => {
		const found = new DeferredPromise<void>();
		const mcp = mcpHarness(async () => 'done', found.p);
		mcp.send('not json');
		mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
		await sleep(20);
		found.error(new Error('The window broke.'));

		assert.deepStrictEqual({ response: await mcp.response(5), logged: mcp.logged.map(line => line.split('\n')[0]) }, {
			response: { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'The window broke.' } },
			logged: ['A line that is not JSON came in, and was answered with a parse error.', 'tools/list failed: Error: The window broke.']
		});
	});

	test('a client that closed its end, as a CLI that quits does, is sent nothing more: what it asked for and is still pending is dropped', async () => {
		const found = new DeferredPromise<void>();
		const mcp = mcpHarness(async () => 'done', found.p);
		mcp.send({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
		await sleep(20);
		mcp.end();
		await sleep(20);
		found.complete();
		// Long enough for an answer that should not be written.
		await sleep(50);

		assert.deepStrictEqual(mcp.lines, []);
	});

	test('a call cancelled while the server still finds its tools - as an agent\'s does while the window reloads - is not run, and gets no response', async () => {
		const found = new DeferredPromise<void>();
		let runs = 0;
		const mcp = mcpHarness(async () => {
			runs++;
			return 'done';
		}, found.p);
		mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } });
		// Both lines read before the tools are found.
		await sleep(20);
		found.complete();
		mcp.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
		await mcp.response(3);
		// Long enough for an answer the cancelled call should not get.
		await sleep(50);

		assert.deepStrictEqual({ runs, answered: mcp.lines.some(line => (line as { id?: number }).id === 2) }, { runs: 0, answered: false });
	});

	test('a message the pipe delivers in parts, split inside a character, is read whole', async () => {
		// Two Chinese characters, which UTF-8 writes in three bytes each.
		const name = String.fromCharCode(0x5de5, 0x5177);
		const mcp = mcpHarness(async () => 'done');
		const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: {} } })}\n`);
		const inside = bytes.indexOf(Buffer.from(name.charAt(1))) + 1;
		mcp.write(bytes.subarray(0, inside));
		await sleep(10);
		mcp.write(bytes.subarray(inside));

		assert.deepStrictEqual(await mcp.response(4), { jsonrpc: '2.0', id: 4, error: { code: -32602, message: `Unknown tool: ${name}` } });
	});
});

suite('Transport: the pipe', () => {

	test('a call whose caller left runs to its end all the same, its answer going nowhere: what a tool starts is carried through, and the window goes on', async () => {
		const release = new DeferredPromise<void>();
		const finished: string[] = [];
		let arrived = false;
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: () => 'someone',
			hello: caller => ({ caller }),
			call: async (_caller, tool) => {
				if (tool === 'slow') {
					arrived = true;
					await release.p;
				}
				finished.push(tool);
				return tool;
			}
		});
		try {
			const client = new PipeClient(server.path, 'good');
			const controller = new AbortController();
			const slow = outcomeOf(client.call('slow', {}, () => { }, controller.signal));
			await waitFor(() => arrived);
			controller.abort();
			const cancelled = await slow;
			release.complete();
			await waitFor(() => finished.length === 1);
			const next = await client.call('quick', {}, () => { });

			assert.deepStrictEqual({ cancelled, finished, next }, { cancelled: 'CANCELLED: Cancelled', finished: ['slow', 'quick'], next: 'quick' });
		} finally {
			server.dispose();
		}
	});

	test('a call made as the window goes, where the call before it connected, never reached the window: it did not run, and is told so, as when nothing listens', async () => {
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: () => 'someone',
			hello: caller => ({ caller }),
			call: async (_caller, tool) => tool
		});
		const client = new PipeClient(server.path, 'good');
		const before = await client.call('quick', {}, () => { });
		server.dispose();
		const after = await outcomeOf(client.call('quick', {}, () => { }));

		assert.deepStrictEqual({ before, after: after.split(':')[0] }, { before: 'quick', after: 'UNREACHABLE' });
	});

	test('refuses an unknown token, says hello, streams progress, passes a failure on with its code, and says when nothing listens', async () => {
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: token => token === 'good' ? 'someone' : undefined,
			hello: caller => ({ caller }),
			call: async (caller, tool, args, progress) => {
				if (tool === 'fail') {
					throw Object.assign(new Error('it broke'), { code: 'FAILED' });
				}
				if (tool === 'plain') {
					throw new Error('it broke, with no code');
				}
				progress('halfway');
				return { caller, tool, args };
			}
		});
		try {
			const progress: string[] = [];
			const good = new PipeClient(server.path, 'good');
			const hello = await good.hello();
			const result = await good.call('echo', { a: 1 }, message => progress.push(message));
			const failed = await outcomeOf(good.call('fail', {}, () => { }));
			const plain = await outcomeOf(good.call('plain', {}, () => { }));
			const refused = await outcomeOf(new PipeClient(server.path, 'bad').hello());
			const refusedCall = await outcomeOf(new PipeClient(server.path, 'bad').call('echo', {}, () => { }));
			const nobody = await outcomeOf(new PipeClient(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), 'good').call('echo', {}, () => { }));

			assert.deepStrictEqual({ hello, result, progress, failed, plain, refused, refusedCall, nobody: nobody.split(':')[0] }, {
				hello: { caller: 'someone' },
				result: { caller: 'someone', tool: 'echo', args: { a: 1 } },
				progress: ['halfway'],
				failed: 'FAILED: it broke',
				plain: 'INTERNAL: it broke, with no code',
				refused: 'UNAUTHORIZED: Facade refused the connection (401).',
				refusedCall: 'UNAUTHORIZED: Facade refused the call (401).',
				nobody: 'UNREACHABLE'
			});
		} finally {
			server.dispose();
		}
	});

	test('a request whose body is JSON but no object, is over 1 MB, or goes nowhere the window serves, is refused, and the window goes on; a client does not send a call over 1 MB', async () => {
		let calls = 0;
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: () => 'someone',
			hello: caller => ({ caller }),
			call: async (_caller, tool) => {
				calls++;
				return tool;
			}
		});
		try {
			const post = (where: string, body: string) => new Promise<number | undefined>((resolve, reject) => {
				const req = http.request({ socketPath: server.path, path: where, method: 'POST', headers: { 'Authorization': 'Bearer good', 'Content-Type': 'application/json' } }, res => {
					res.resume();
					resolve(res.statusCode);
				});
				req.on('error', reject);
				req.end(body);
			});

			const tooLarge = 'x'.repeat(1_100_000);
			const statuses = [await post('/hello', 'null'), await post('/hello', '[1]'), await post('/hello', '{ not json'), await post('/hook', '{}'), await post('/call', '{"args":{}}'), await post('/call', JSON.stringify({ tool: 'echo', args: tooLarge })), await post('/hello', '{}')];
			const notSent = await outcomeOf(new PipeClient(server.path, 'good').call('echo', tooLarge, () => { }));

			assert.deepStrictEqual({ statuses, notSent, calls }, {
				statuses: [400, 400, 400, 404, 404, 413, 200],
				notSent: 'TOO_LARGE: The call is over the 1048576 bytes a call may carry.',
				calls: 0
			});
		} finally {
			server.dispose();
		}
	});

	test('a line of an answer the client cannot read - not JSON, or not a line of an answer - fails the call with a code: what follows it is not read, and the process goes on', async () => {
		const pipe = pipePath(`test-${crypto.randomBytes(4).toString('hex')}`);
		const lines = ['not json', '{"type":"progress"}'];
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
			res.end(`{"type":"progress","message":"halfway"}\n${lines.shift()}\n{"type":"result","result":"late"}\n`);
		});
		await new Promise<void>(resolve => server.listen(pipe, resolve));
		try {
			const progress: string[] = [];
			const client = new PipeClient(pipe, 'any');
			const notJson = await outcomeOf(client.call('echo', {}, message => progress.push(message)));
			const notALine = await outcomeOf(client.call('echo', {}, message => progress.push(message)));

			assert.deepStrictEqual({ notJson, notALine, progress }, {
				notJson: 'FAILED: Facade answered the call with a line that could not be read.',
				notALine: 'FAILED: Facade answered the call with a line that could not be read.',
				progress: ['halfway', 'halfway']
			});
		} finally {
			server.close();
		}
	});

	test('a call cancelled before it is made is not made; a call waiting for a window that is not there leaves no listener behind on its signal', async () => {
		const controller = new AbortController();
		const nobody = new PipeClient(pipePath(`nobody-${crypto.randomBytes(6).toString('hex')}`), 'token');
		const outcomes = [];
		for (let i = 0; i < 5; i++) {
			outcomes.push(await outcomeOf(nobody.call('echo', {}, () => undefined, controller.signal)));
		}
		controller.abort();

		assert.deepStrictEqual({
			unreachable: outcomes.every(outcome => /^UNREACHABLE: /.test(outcome)),
			listeners: getEventListeners(controller.signal, 'abort').length,
			cancelled: await outcomeOf(nobody.call('echo', {}, () => undefined, controller.signal))
		}, { unreachable: true, listeners: 0, cancelled: 'CANCELLED: Cancelled' });
	});

	test('a request the window fails on - telling its caller, or saying hello - is answered with why, not left waiting, and logged; the window goes on', async () => {
		let failing: 'authenticate' | 'hello' | undefined;
		const logged: string[] = [];
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: token => {
				if (failing === 'authenticate') {
					throw Object.assign(new Error('The record cannot be read.'), { code: 'EBUSY' });
				}
				return token === 'good' ? 'someone' : undefined;
			},
			hello: caller => {
				if (failing === 'hello') {
					throw new Error('Another Facade window took this workspace\'s agents.');
				}
				return { caller };
			},
			call: async (_caller, tool) => tool,
			log: message => logged.push(message)
		});
		try {
			const client = new PipeClient(server.path, 'good');
			failing = 'hello';
			const hello = await outcomeOf(client.hello());
			failing = 'authenticate';
			const call = await outcomeOf(client.call('echo', {}, () => { }));
			failing = undefined;

			assert.deepStrictEqual({ hello, call, then: await client.hello(), logged: logged.map(line => line.split('\n')[0]) }, {
				hello: 'FAILED: Another Facade window took this workspace\'s agents.',
				call: 'FAILED: The record cannot be read.',
				then: { caller: 'someone' },
				logged: [
					'The window failed saying hello on its pipe: Error: Another Facade window took this workspace\'s agents.',
					'The window failed telling who called on its pipe: Error: The record cannot be read.'
				]
			});
		} finally {
			server.dispose();
		}
	});

	test('a call whose connection breaks once the window has answered in part - its progress come - may have run, and is said to', async () => {
		const progressed = new DeferredPromise<void>();
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: () => 'someone',
			hello: caller => ({ caller }),
			call: async (_caller, _tool, _args, progress) => {
				progress('halfway');
				progressed.complete();
				return new Promise(() => { });
			}
		});
		const progress: string[] = [];
		const call = outcomeOf(new PipeClient(server.path, 'good').call('slow', {}, message => progress.push(message)));
		await progressed.p;
		await waitFor(() => progress.length === 1);
		server.dispose();

		assert.deepStrictEqual({ call: (await call).split(':')[0], progress }, { call: 'NOT_CONNECTED', progress: ['halfway'] });
	});

	test('a hello cut off halfway - the window gone as it answered - is said to be, not waited for', async () => {
		const pipe = pipePath(`test-${crypto.randomBytes(4).toString('hex')}`);
		const server = http.createServer((req, res) => {
			req.resume();
			res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
			res.write('{"name":');
			setTimeout(() => res.destroy(), 20);
		});
		await new Promise<void>(resolve => server.listen(pipe, resolve));
		try {
			assert.strictEqual(await outcomeOf(new PipeClient(pipe, 'any').hello()), 'NOT_CONNECTED: Facade closed the connection before it said hello.');
		} finally {
			server.close();
		}
	});

	test('a line of an answer the pipe delivers in parts, split inside a character, is read whole', async () => {
		const pipe = pipePath(`test-${crypto.randomBytes(4).toString('hex')}`);
		// Two Chinese characters, which UTF-8 writes in three bytes each.
		const word = String.fromCharCode(0x5b8c, 0x6210);
		const line = Buffer.from(`${JSON.stringify({ type: 'result', result: word })}\n`);
		const inside = line.indexOf(Buffer.from(word.charAt(1))) + 1;
		const server = http.createServer((req, res) => {
			req.resume();
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
			res.write(line.subarray(0, inside));
			setTimeout(() => res.end(line.subarray(inside)), 20);
		});
		await new Promise<void>(resolve => server.listen(pipe, resolve));
		try {
			assert.strictEqual(await new PipeClient(pipe, 'any').call('echo', {}, () => { }), word);
		} finally {
			server.close();
		}
	});

	test('the pipe is a named pipe on Windows; elsewhere a socket in the user\'s runtime folder when there is one, else in the temporary folder', () => {
		if (process.platform === 'win32') {
			assert.strictEqual(pipePath('x'), `${path.sep}${path.sep}.${path.sep}pipe${path.sep}facade-agents-x`);
			return;
		}
		const runtime = process.env.XDG_RUNTIME_DIR;
		try {
			process.env.XDG_RUNTIME_DIR = '/run/user/1000';
			const inRuntime = pipePath('x');
			delete process.env.XDG_RUNTIME_DIR;

			assert.deepStrictEqual([inRuntime, pipePath('x')], [process.platform === 'darwin' ? path.join(os.tmpdir(), 'facade-agents-x.sock') : '/run/user/1000/facade-agents-x.sock', path.join(os.tmpdir(), 'facade-agents-x.sock')]);
		} finally {
			if (runtime === undefined) {
				delete process.env.XDG_RUNTIME_DIR;
			} else {
				process.env.XDG_RUNTIME_DIR = runtime;
			}
		}
	});

	test('elsewhere than Windows the pipe is a socket only its user can open, which replaces a file a window that ended left, and goes with the window', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const pipe = pipePath(`test-${crypto.randomBytes(4).toString('hex')}`);
		fs.writeFileSync(pipe, 'left by a window that ended');
		const server = await PipeServer.listen<string>(pipe, {
			authenticate: () => 'someone',
			hello: caller => ({ caller }),
			call: async (_caller, tool) => tool
		});
		const stat = fs.statSync(pipe);
		server.dispose();

		assert.deepStrictEqual({ socket: stat.isSocket(), mode: stat.mode & 0o777, gone: !fs.existsSync(pipe) }, { socket: true, mode: 0o600, gone: true });
	});
});

suite('Transport: what an agent\'s end of the pipe reads from the window', () => {

	const tool = { name: 'spawn', description: 'Starts a child.', inputSchema: { type: 'object', properties: { cli: { type: 'string' } }, required: ['cli'], additionalProperties: false } };

	test('a hello is read field by field: one that is not a hello, or holds a tool it cannot read, is none', () => {
		assert.deepStrictEqual([
			helloOf({ name: 'main', tools: [{ ...tool, title: 'Spawn' }], instructions: 'Be brief.' }),
			helloOf({ name: 'main', tools: [], instructions: 'Be brief.', other: 1 }),
			helloOf({}),
			helloOf('hello'),
			helloOf({ name: 7, tools: [], instructions: '' }),
			helloOf({ name: 'main', tools: tool, instructions: '' }),
			helloOf({ name: 'main', tools: [], instructions: 3 }),
			helloOf({ name: 'main', tools: [{ ...tool, inputSchema: undefined }], instructions: '' }),
			helloOf({ name: 'main', tools: [{ ...tool, inputSchema: [] }], instructions: '' }),
			helloOf({ name: 'main', tools: [{ ...tool, title: 7 }], instructions: '' }),
			helloOf({ name: 'main', tools: ['spawn'], instructions: '' })
		], [
			{ name: 'main', tools: [{ ...tool, title: 'Spawn' }], instructions: 'Be brief.' },
			{ name: 'main', tools: [], instructions: 'Be brief.' },
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined
		]);
	});

	test('a tool\'s result is read as text, with its data and whether it failed: anything else is none', () => {
		assert.deepStrictEqual([
			toolResultOf({ text: 'Started.', data: { pid: 7 } }),
			toolResultOf({ text: 'No.', isError: true }),
			toolResultOf({ text: 3 }),
			toolResultOf({ text: 'Started.', data: 'main' }),
			toolResultOf({ text: 'Started.', isError: 'no' }),
			toolResultOf(null)
		], [{ text: 'Started.', data: { pid: 7 } }, { text: 'No.', isError: true }, undefined, undefined, undefined, undefined]);
	});
});

suite('Transport: the shim and the window\'s end of the pipe', function () {

	this.timeout(60_000);

	let temp: { dir: string; remove(): void };
	let pipe: string;
	let endpoint: PipeEndpoint<string>;
	/** Who the window knows, by token: what the process table would answer. */
	let tokens: Map<string, string>;
	const clients: StdioMcpClient[] = [];
	/** The calls of `hang` that reached the window's end, which it never answers. */
	let hanging = 0;
	/** Why the window fails to say hello, while it does. */
	let helloFails: string | undefined;
	/** What the calls of `echo` that the window ran were given. */
	let echoed: string[];

	/** A contract whose tool `echo` says who called it and with what, `fail` fails as it is told, and `hang` never answers. */
	const echo: PipeHandlers<string> = {
		authenticate: token => tokens.get(token),
		hello: caller => {
			if (helloFails) {
				throw new Error(helloFails);
			}
			return {
				name: caller,
				tools: [
					{ name: 'echo', title: 'Echo', description: 'Says what it was given.', inputSchema: { type: 'object' } },
					{ name: 'hang', title: 'Hang', description: 'Never answers.', inputSchema: { type: 'object' } }
				],
				instructions: `You are @${caller}.`
			};
		},
		call: async (caller, tool, args, progress) => {
			if (tool === 'hang') {
				hanging++;
				return new Promise(() => { });
			}
			const given = args as { text?: string; fail?: string };
			if (given.fail) {
				throw Object.assign(new Error(given.fail), { code: 'FAILED' });
			}
			echoed.push(String(given.text));
			progress('echoing');
			return { text: `@${caller} said ${given.text} to ${tool}` };
		}
	};

	/** An agent's MCP server, started the way its launch starts it: the shim, with its token file. */
	function agent(name: string): StdioMcpClient {
		const token = crypto.randomBytes(8).toString('hex');
		tokens.set(token, name);
		const tokenFile = path.join(temp.dir, `${name}.token`);
		fs.writeFileSync(tokenFile, token);
		const launch = endpoint.mcpServer(tokenFile, 60_000);
		const client = StdioMcpClient.start(launch.args.slice(2));
		clients.push(client);
		return client;
	}

	/** The window record the endpoint keeps beside the ledger. */
	function windowRecord(): { pipe?: string; pid?: number } | undefined {
		try {
			return JSON.parse(fs.readFileSync(path.join(temp.dir, 'window.json'), 'utf8'));
		} catch {
			return undefined;
		}
	}

	setup(async () => {
		temp = tempDir('facade-transport-');
		tokens = new Map([['person-token', 'you']]);
		helloFails = undefined;
		hanging = 0;
		echoed = [];
		pipe = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);
	});

	teardown(async () => {
		await Promise.all(clients.splice(0).map(client => client.stop()));
		endpoint.dispose();
		temp.remove();
	});

	test('an agent\'s MCP server offers the window\'s tools and instructions, and passes its calls through, with the window\'s progress; it is told how long to wait for the window, in its own environment or its agent\'s', async () => {
		const main = agent('main');
		const init = await main.initialize();
		const said = await main.call('echo', { text: 'hello' });

		assert.deepStrictEqual({ instructions: init.instructions, tools: await main.tools(), said: said.text, progress: main.progress, launch: endpoint.mcpServer('/runs/7.token', 45_000), shared: endpoint.sharedMcpServer(), agent: endpoint.agentEnv('t0ken', 45_000) }, {
			instructions: 'You are @main.',
			tools: ['echo', 'hang'],
			said: '@main said hello to echo',
			progress: ['echoing'],
			launch: {
				command: process.execPath,
				args: [path.join(__dirname, '..', 'transport', 'shim.js'), 'mcp', '--pipe', pipe, '--token-file', '/runs/7.token'],
				env: { ELECTRON_RUN_AS_NODE: '1', FACADE_AGENTS_WAIT_MS: '45000' }
			},
			shared: { command: process.execPath, args: [path.join(__dirname, '..', 'transport', 'shim.js'), 'mcp', '--agent'], env: { ELECTRON_RUN_AS_NODE: '1' } },
			agent: { FACADE_AGENTS_PIPE: pipe, FACADE_AGENTS_TOKEN: 't0ken', FACADE_AGENTS_WAIT_MS: '45000' }
		});
	});

	test('a script with the person\'s token finds the window through window.json, and acts as the person; the record goes with the window', async () => {
		const record = windowRecord();
		const you = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: record?.pipe, FACADE_AGENTS_TOKEN: 'person-token' });
		clients.push(you);
		await you.initialize();
		const said = await you.call('echo', { text: 'hi' });
		endpoint.dispose();
		const afterwards = windowRecord();
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);

		assert.deepStrictEqual({ pipe: record?.pipe, pid: record?.pid, said: said.text, afterwards }, { pipe, pid: process.pid, said: '@you said hi to echo', afterwards: undefined });
	});

	test('an agent the window no longer knows is told to stop working', async () => {
		const main = agent('main');
		await main.initialize();
		tokens.clear();

		const refused = await main.call('echo', { text: 'still me?' });

		assert.deepStrictEqual([refused.isError, refused.data?.code, refused.text], [true, 'REFUSED', 'Facade no longer accepts @main: it was killed, or exited. Stop working.']);
	});

	test('a call made while the window\'s end is away waits for it and runs once it is back; one cut off halfway says so, and is not made again', async () => {
		const main = agent('main');
		await main.initialize();
		endpoint.dispose();
		const waited = main.call('echo', { text: 'anyone?' });
		await sleep(1500);
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);
		const back = await waited;
		const cutOff = main.call('hang', {});
		await waitFor(() => hanging === 1);
		endpoint.dispose();
		const cut = await cutOff;
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);

		assert.deepStrictEqual({ back: back.text, waiting: main.progress.includes('Waiting for Facade\'s window to come back.'), cut: cut.isError && cut.text.replace(/\(.*?\)/, '(...)'), code: cut.data?.code, hanging }, {
			back: '@main said anyone? to echo',
			waiting: true,
			cut: 'Facade\'s window went away during hang (...), as it does while it reloads, so hang may have run. Find out whether it did before you call it again.',
			code: 'UNAVAILABLE',
			hanging: 1
		});
	});

	test('a call the window refuses, or one that fails there, is no reload: it says what went wrong, and that the call did not run or failed', async () => {
		const main = agent('main');
		await main.initialize();
		const tooLarge = await main.call('echo', { text: 'x'.repeat(1_100_000) });
		const failed = await main.call('echo', { fail: 'the disk is full' });

		assert.deepStrictEqual({ tooLarge: [tooLarge.isError, tooLarge.data?.code, tooLarge.text], failed: [failed.isError, failed.data?.code, failed.text] }, {
			tooLarge: [true, 'INVALID', 'Facade did not take echo: its arguments are over the 1 MB a call may carry. Put what is long in a file, and give its path instead.'],
			failed: [true, 'FAILED', 'echo failed in Facade\'s window: the disk is full']
		});
	});

	test('the MCP server a CLI\'s agents share finds the agent from its environment, and waits for the window through a reload as an agent\'s does; a script does not', async () => {
		const token = crypto.randomBytes(8).toString('hex');
		tokens.set(token, 'slugify');
		// A script waits a moment only: the person who runs it is told at once.
		const env = { FACADE_AGENTS_PIPE: pipe, FACADE_SCRIPT_WAIT_MS: '500' };
		const shared = StdioMcpClient.start(endpoint.sharedMcpServer().args.slice(2), { ...env, FACADE_AGENTS_TOKEN: token });
		const script = StdioMcpClient.start([], { ...env, FACADE_AGENTS_TOKEN: 'person-token' });
		clients.push(shared, script);
		await Promise.all([shared.initialize(), script.initialize()]);
		endpoint.dispose();
		const calls = [shared.call('echo', { text: 'anyone?' }), script.call('echo', { text: 'anyone?' })];
		await sleep(1500);
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);
		const [fromAgent, fromScript] = await Promise.all(calls);

		assert.deepStrictEqual({ agent: fromAgent.text, script: fromScript.data?.code, gone: /did not come back/.test(fromScript.text) }, { agent: '@slugify said anyone? to echo', script: 'UNAVAILABLE', gone: true });
	});

	test('with no window, the MCP server offers facade_status, which says why; so does one whose variables its CLI did not expand, or whose token file cannot be read', async () => {
		const orphan = StdioMcpClient.start([]);
		const unexpanded = StdioMcpClient.start(['--agent'], { FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}' });
		const gone = path.join(temp.dir, 'gone.token');
		const tokenless = StdioMcpClient.start(['--pipe', pipe, '--token-file', gone]);
		clients.push(orphan, unexpanded, tokenless);
		await Promise.all([orphan.initialize(), unexpanded.initialize(), tokenless.initialize()]);
		const status = await orphan.call('facade_status');
		const unexpandedStatus = await unexpanded.call('facade_status');
		const tokenlessStatus = await tokenless.call('facade_status');

		assert.deepStrictEqual({
			tools: await orphan.tools(),
			isError: status.isError,
			code: status.data?.code,
			why: [/without a pipe and a token/.test(status.text), /without a pipe and a token/.test(unexpandedStatus.text), tokenlessStatus.text.includes(`the token file ${gone} cannot be read`)]
		}, { tools: ['facade_status'], isError: true, code: 'UNAVAILABLE', why: [true, true, true] });
	});

	test('a window that fails to say hello is not taken for a window that is there: a script is told why, at once', async () => {
		helloFails = 'Another Facade window took this workspace\'s agents.';
		const you = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: pipe, FACADE_AGENTS_TOKEN: 'person-token', FACADE_SCRIPT_WAIT_MS: '500' });
		clients.push(you);
		await you.initialize();
		const status = await you.call('facade_status');

		assert.deepStrictEqual({ tools: await you.tools(), why: status.text.includes('Facade\'s window failed to say hello (Another Facade window took this workspace\'s agents.)') }, { tools: ['facade_status'], why: true });
	});

	test('an endpoint that cannot record where it listens does not listen: its pipe is left for the next try', async () => {
		const notAFolder = path.join(temp.dir, 'not-a-folder');
		fs.writeFileSync(notAFolder, '');
		const other = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		const started = await outcomeOf(PipeEndpoint.start(other, notAFolder, echo));
		const reached = await outcomeOf(new PipeClient(other, 'person-token').call('echo', { text: 'anyone?' }, () => { }));

		assert.deepStrictEqual({ started: started === 'fulfilled', reached: reached.split(':')[0] }, { started: false, reached: 'UNREACHABLE' });
	});

	test('a window of another version - a hello, a result or a call it cannot read - is said to be one: the agent is told the call did not run, or what came back', async () => {
		const fake = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		let hello: object = { name: 'main', tools: [{ name: 'echo', description: 'Says what it was given.', inputSchema: { type: 'object' } }], instructions: '' };
		let answer: (res: http.ServerResponse) => void = res => {
			res.writeHead(400).end();
		};
		const server = http.createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				if (req.url === '/hello') {
					res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hello));
				} else {
					answer(res);
				}
			});
		});
		await new Promise<void>(resolve => server.listen(fake, resolve));
		try {
			const tokenFile = path.join(temp.dir, 'main.token');
			fs.writeFileSync(tokenFile, 'any');
			const main = StdioMcpClient.start(['--pipe', fake, '--token-file', tokenFile]);
			clients.push(main);
			await main.initialize();
			const refused = await main.call('echo');
			answer = res => {
				res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end('{"type":"result","result":{"words":"not a result"}}\n');
			};
			const unreadable = await main.call('echo');
			hello = { name: 'main' };
			const later = StdioMcpClient.start(['--pipe', fake, '--token-file', tokenFile]);
			clients.push(later);
			await later.initialize();
			const status = await later.call('facade_status');

			assert.deepStrictEqual({ refused: [refused.data?.code, refused.text], unreadable: [unreadable.data?.code, unreadable.text], tools: await later.tools(), status: status.text.includes('Facade said hello with something this version cannot read') }, {
				refused: ['INVALID', 'Facade could not read the call to echo, so it did not run. Facade refused the call (400).'],
				unreadable: ['FAILED', 'Facade answered echo with something this version cannot read.'],
				tools: ['facade_status'],
				status: true
			});
		} finally {
			server.close();
		}
	});

	test('a call its CLI cancels gets no answer: one the window runs goes on there, and one that waits for the window is not made once it is back', async () => {
		const main = agent('main');
		await main.initialize();
		const running = await main.callAndCancel('hang', {}, waitFor(() => hanging === 1));
		// The shim reads its input in order: once it answers a ping, it has the cancel, and only then does the window go
		await main.request('ping', {});
		endpoint.dispose();
		const waiting = await main.callAndCancel('echo', { text: 'too late' }, sleep(300));
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo);
		const after = await main.call('echo', { text: 'after' });

		assert.deepStrictEqual({ answered: [main.answered.has(running), main.answered.has(waiting)], hanging, echoed, after: after.text }, {
			answered: [false, false],
			hanging: 1,
			echoed: ['after'],
			after: '@main said after to echo'
		});
	});

	test('an agent whose token the window does not know, from its start, is offered facade_status, which says so', async () => {
		const tokenFile = path.join(temp.dir, 'stranger.token');
		fs.writeFileSync(tokenFile, 'not a token the window gave');
		const stranger = StdioMcpClient.start(['--pipe', pipe, '--token-file', tokenFile]);
		clients.push(stranger);
		await stranger.initialize();
		const status = await stranger.call('facade_status');

		assert.deepStrictEqual({ tools: await stranger.tools(), why: status.text.includes('Facade no longer accepts this session\'s token') }, { tools: ['facade_status'], why: true });
	});

	test('a window that is not there is waited for once: after that, listing the tools or calling facade_status says it is away at once', async () => {
		const away = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: pipePath(`nobody-${crypto.randomBytes(6).toString('hex')}`), FACADE_AGENTS_TOKEN: 'person-token', FACADE_SCRIPT_WAIT_MS: '500' });
		clients.push(away);
		await away.initialize();
		const start = Date.now();
		const tools = await away.tools();
		const status = await away.call('facade_status');

		assert.deepStrictEqual({ tools, why: status.text.includes('Facade is not reachable ('), atOnce: Date.now() - start < 500 }, { tools: ['facade_status'], why: true, atOnce: true });
	});

	test('an agent\'s MCP server whose CLI quits while it waits for the window stops waiting, and exits by itself', async () => {
		const tokenFile = path.join(temp.dir, 'main.token');
		fs.writeFileSync(tokenFile, 'any');
		const waiting = StdioMcpClient.start(['--pipe', pipePath(`nobody-${crypto.randomBytes(6).toString('hex')}`), '--token-file', tokenFile]);
		// Never answered: the window is not there, and the CLI quits.
		void waiting.initialize();
		await sleep(300);
		const quit = Date.now();
		await waiting.stop();

		assert.deepStrictEqual({ byItself: waiting.child.signalCode === null, atOnce: Date.now() - quit < 1500 }, { byItself: true, atOnce: true });
	});

	test('an agent\'s MCP server waits for a window that is not there as long as its launch says - as the person set it - and then says it is away', async () => {
		const tokenFile = path.join(temp.dir, 'main.token');
		fs.writeFileSync(tokenFile, 'any');
		const waiting = StdioMcpClient.start(['--pipe', pipePath(`nobody-${crypto.randomBytes(6).toString('hex')}`), '--token-file', tokenFile], { FACADE_AGENTS_WAIT_MS: '700' });
		clients.push(waiting);
		const start = Date.now();
		await waiting.initialize();
		const waited = Date.now() - start;
		const status = await waiting.call('facade_status');

		assert.deepStrictEqual({ waited: waited >= 600 && waited < 10_000, why: status.text.includes('Facade is not reachable (') }, { waited: true, why: true });
	});

	test('a window that does not answer its hello - stopped in a debugger, say - is waited for no longer than one that is not there', async () => {
		const stopped = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		// Takes each request, and answers none.
		const server = http.createServer(req => req.resume());
		await new Promise<void>(resolve => server.listen(stopped, resolve));
		try {
			const you = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: stopped, FACADE_AGENTS_TOKEN: 'person-token', FACADE_SCRIPT_WAIT_MS: '500' });
			clients.push(you);
			await you.initialize();
			const status = await you.call('facade_status');

			assert.strictEqual(status.text.includes('Facade is not reachable (Facade did not say hello in time.)'), true);
		} finally {
			server.close();
		}
	});
});
