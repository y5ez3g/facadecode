/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { PipeEndpoint, readWindowRecord } from '../transport/endpoint';
import { PipeClient, PipeHandlers, PipeServer, pipePath } from '../transport/pipe';
import { McpStdioServer } from '../transport/stdio';
import { StdioMcpClient } from './mcpClient';
import { outcomeOf, runHook, sleep, tempDir } from './util';

/** An MCP server on in-memory streams, and a way to talk to it. */
function mcpHarness(slowTool: (signal: AbortSignal, progress: (message: string) => void) => Promise<string>) {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines: object[] = [];
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
		listTools: async () => [{ name: 'slow', description: 'Waits.', inputSchema: { type: 'object' } }, { name: 'boom', description: 'Fails.', inputSchema: { type: 'object' } }],
		callTool: async (name, _args, context) => {
			if (name === 'boom') {
				throw new Error('it broke');
			}
			return { text: await slowTool(context.signal, context.progress), data: { ok: true } };
		}
	});
	void server.start();
	return {
		lines,
		send: (message: object | string) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
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

	test('negotiates the version, lists tools, and returns text and structured content', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
		mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'missing', arguments: {} } });
		mcp.send({ jsonrpc: '2.0', id: 6, method: 'server/discover' });
		assert.deepStrictEqual([await mcp.response(1), await mcp.response(2), await mcp.response(3), await mcp.response(4), await mcp.response(5), await mcp.response(6)], [
			{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'facade', version: '0.0.1' } } },
			{ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'slow', description: 'Waits.', inputSchema: { type: 'object' } }, { name: 'boom', description: 'Fails.', inputSchema: { type: 'object' } }] } },
			{ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } } },
			{ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } },
			{ jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'Unknown tool: missing' } },
			{ jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'Method not found: server/discover' } }
		]);
	});

	test('an unknown version gets the newest one; a 2024 client gets no structured content', async () => {
		const mcp = mcpHarness(async () => 'done');
		mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
		const newest = await mcp.response(1) as { result: { protocolVersion: string } };
		const old = mcpHarness(async () => 'done');
		old.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
		old.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
		await old.response(1);
		assert.deepStrictEqual({ newest: newest.result.protocolVersion, old: await old.response(2) }, {
			newest: '2025-11-25',
			old: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'done' }] } }
		});
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
		await sleep(50);
		mcp.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } });
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
});

suite('Transport: the pipe', () => {

	test('refuses an unknown token, streams progress, aborts a call whose caller left, and says when nothing listens', async () => {
		let aborted = false;
		const server = await PipeServer.listen<string>(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), {
			authenticate: token => token === 'good' ? 'someone' : undefined,
			hello: caller => ({ caller }),
			hook: () => '',
			call: async (caller, tool, args, context) => {
				if (tool === 'wait') {
					await new Promise<void>(resolve => context.signal.addEventListener('abort', () => {
						aborted = true;
						resolve();
					}));
					return 'aborted';
				}
				context.progress('halfway');
				return { caller, tool, args };
			}
		});
		try {
			const progress: string[] = [];
			const good = new PipeClient(server.path, 'good');
			const hello = await good.hello();
			const result = await good.call('echo', { a: 1 }, message => progress.push(message));
			const refused = await outcomeOf(new PipeClient(server.path, 'bad').hello());
			const controller = new AbortController();
			const waiting = outcomeOf(good.call('wait', {}, () => { }, controller.signal));
			await sleep(100);
			controller.abort();
			const cancelled = await waiting;
			await sleep(100);
			const nobody = await outcomeOf(new PipeClient(pipePath(`test-${crypto.randomBytes(4).toString('hex')}`), 'good').call('echo', {}, () => { }));
			assert.deepStrictEqual({ hello, result, progress, refused, cancelled, aborted, nobody: nobody.split(':')[0] }, {
				hello: { caller: 'someone' },
				result: { caller: 'someone', tool: 'echo', args: { a: 1 } },
				progress: ['halfway'],
				refused: 'UNAUTHORIZED: Facade refused the connection (401).',
				cancelled: 'CANCELLED: Cancelled',
				aborted: true,
				nobody: 'UNREACHABLE'
			});
		} finally {
			server.dispose();
		}
	});
});

suite('Transport: the shim and the window\'s end of the pipe', function () {

	this.timeout(60_000);

	let temp: { dir: string; remove(): void };
	let pipe: string;
	let endpoint: PipeEndpoint<string>;
	/** Who the window knows, by token: what a registry would answer. */
	let tokens: Map<string, string>;
	const clients: StdioMcpClient[] = [];

	/** A contract whose one tool says who called it and with what; `hang` answers only once its caller left. */
	const echo: PipeHandlers<string> = {
		authenticate: token => tokens.get(token),
		hello: caller => ({
			name: caller,
			tools: [
				{ name: 'echo', title: 'Echo', description: 'Says what it was given.', inputSchema: { type: 'object' } },
				{ name: 'hang', title: 'Hang', description: 'Never answers.', inputSchema: { type: 'object' } }
			],
			instructions: `You are @${caller}.`
		}),
		call: async (caller, tool, args, context) => tool === 'hang'
			? new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ text: 'too late' })))
			: { text: `@${caller} said ${(args as { text?: string }).text} to ${tool}` },
		hook: (caller, event, payload) => event === 'stop' ? JSON.stringify({ decision: 'block', reason: `@${caller} ${JSON.stringify(payload)}` }) : ''
	};

	/** An agent's MCP server, started the way its launch starts it: the shim, with its token file. */
	function agent(name: string): StdioMcpClient {
		const token = crypto.randomBytes(8).toString('hex');
		tokens.set(token, name);
		const tokenFile = path.join(temp.dir, `${name}.token`);
		fs.writeFileSync(tokenFile, token);
		const launch = endpoint.mcpServer(tokenFile);
		const client = StdioMcpClient.start(launch.args.slice(2));
		clients.push(client);
		return client;
	}

	setup(async () => {
		temp = tempDir('facade-transport-');
		tokens = new Map([['person-token', 'you']]);
		pipe = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo, path.join(temp.dir, 'hooks'));
	});

	teardown(async () => {
		await Promise.all(clients.splice(0).map(client => client.stop()));
		endpoint.dispose();
		temp.remove();
	});

	test('an agent\'s MCP server offers the window\'s tools and instructions, and passes its calls through', async () => {
		const main = agent('main');
		const init = await main.initialize();
		const said = await main.call('echo', { text: 'hello' });

		assert.deepStrictEqual({ instructions: init.instructions, tools: await main.tools(), said: said.text, launch: endpoint.mcpServer('/runs/main-1.token') }, {
			instructions: 'You are @main.',
			tools: ['echo', 'hang'],
			said: '@main said hello to echo',
			launch: {
				command: process.execPath,
				args: [path.join(__dirname, '..', 'transport', 'shim.js'), 'mcp', '--pipe', pipe, '--token-file', '/runs/main-1.token'],
				env: { ELECTRON_RUN_AS_NODE: '1' }
			}
		});
	});

	test('a script with the person\'s token finds the window through window.json, and acts as the person', async () => {
		const record = readWindowRecord(temp.dir);
		const you = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: record!.pipe, FACADE_AGENTS_TOKEN: 'person-token' });
		clients.push(you);
		await you.initialize();
		const said = await you.call('echo', { text: 'hi' });

		assert.deepStrictEqual({ pipe: record?.pipe, pid: record?.pid, said: said.text }, { pipe, pid: process.pid, said: '@you said hi to echo' });
	});

	test('an agent the window no longer knows is told to stop working', async () => {
		const main = agent('main');
		await main.initialize();
		tokens.clear();

		const refused = await main.call('echo', { text: 'still me?' });

		assert.deepStrictEqual({ isError: refused.isError, code: refused.data?.code, stop: /no longer accepts @main.*Stop working/.test(refused.text) }, { isError: true, code: 'REFUSED', stop: true });
	});

	test('a call made while the window\'s end is away waits for it and runs once it is back; one cut off halfway says so, and is not made again', async () => {
		const main = agent('main');
		await main.initialize();
		endpoint.dispose();
		const waited = main.call('echo', { text: 'anyone?' });
		await sleep(1500);
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo, path.join(temp.dir, 'hooks'));
		const back = await waited;
		const hanging = main.call('hang', {});
		await sleep(300);
		endpoint.dispose();
		const cut = await hanging;
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo, path.join(temp.dir, 'hooks'));

		assert.deepStrictEqual({ back: back.text, cut: cut.isError && /window may have reloaded/.test(cut.text), code: cut.data?.code }, { back: '@main said anyone? to echo', cut: true, code: 'UNAVAILABLE' });
	});

	test('with no window, the MCP server offers facade_status, which says why', async () => {
		const orphan = StdioMcpClient.start([]);
		clients.push(orphan);
		await orphan.initialize();
		const status = await orphan.call('facade_status');

		assert.deepStrictEqual({ tools: await orphan.tools(), isError: status.isError, why: /without a pipe and a token/.test(status.text) }, { tools: ['facade_status'], isError: true, why: true });
	});

	test('a hook runs its launcher as a CLI does, and prints what the window answers for what the CLI gave it; with no window, nothing', async () => {
		const token = crypto.randomBytes(8).toString('hex');
		tokens.set(token, 'main');
		const tokenFile = path.join(temp.dir, 'main-1.token');
		fs.writeFileSync(tokenFile, token);
		const command = endpoint.hookCommand(tokenFile, 'main-1');
		const launcher = fs.readFileSync(command.replace(/^"|"$/g, ''), 'utf8');
		const shim = path.join(__dirname, '..', 'transport', 'shim.js');

		const stop = await runHook(`${command} event:stop`, '{"stop_hook_active":false}');
		const prompt = await runHook(`${command} event:prompt`, '{"prompt":"hi"}');
		endpoint.dispose();
		const away = await runHook(`${command} event:stop`, '{}');
		endpoint = await PipeEndpoint.start(pipe, temp.dir, echo, path.join(temp.dir, 'hooks'));

		assert.deepStrictEqual({ command, launcher, stop, prompt, away }, {
			command: path.join(temp.dir, 'hooks', `${path.basename(temp.dir)}-main-1${process.platform === 'win32' ? '.cmd' : '.sh'}`).split(path.sep).join('/'),
			launcher: process.platform === 'win32'
				? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${shim}" "hook" "--pipe" "${pipe}" "--token-file" "${tokenFile}" %*\r\n`
				: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${shim}' 'hook' '--pipe' '${pipe}' '--token-file' '${tokenFile}' "$@"\n`,
			stop: { status: 0, stdout: '{"decision":"block","reason":"@main {\\"stop_hook_active\\":false}"}\n' },
			prompt: { status: 0, stdout: '' },
			away: { status: 0, stdout: '' }
		});
	});
});
