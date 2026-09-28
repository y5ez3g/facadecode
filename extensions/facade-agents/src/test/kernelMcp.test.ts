/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipePath } from '../common/ipc';
import { Kernel } from '../common/kernel/kernel';
import { readWindowRecord, WorkspaceServer } from '../common/kernel/server';
import { INSTRUCTIONS, TOOL_NAMES } from '../common/kernel/tools';
import { StdioMcpClient } from './mcpClient';
import { tempDir } from './util';

/*
 * The facade MCP server end to end (L2-PLAN, step 27): agents' MCP servers are the real shim,
 * started as processes, speaking to the window's pipe with their tokens.
 */

suite('The facade MCP server, through the shim', function () {

	this.timeout(60_000);

	let temp: { dir: string; remove(): void };
	let kernel: Kernel;
	let server: WorkspaceServer;
	let pipe: string;
	const clients: StdioMcpClient[] = [];

	/** An agent in the workspace, with its MCP server started the way a launch starts it. */
	function connect(name: string, groups: string[] = []): StdioMcpClient {
		const added = kernel.addAgent({ name, agent: 'fake', groups, startedBy: 'you' });
		const tokenFile = path.join(temp.dir, `${name}.token`);
		fs.writeFileSync(tokenFile, added.token);
		const client = StdioMcpClient.start(['--pipe', pipe, '--token-file', tokenFile]);
		clients.push(client);
		return client;
	}

	setup(async () => {
		temp = tempDir('facade-mcp-');
		kernel = Kernel.open({ dir: path.join(temp.dir, 'workspace') });
		pipe = pipePath(`test-${crypto.randomBytes(6).toString('hex')}`);
		server = await WorkspaceServer.start({ kernel, pipe });
	});

	teardown(async () => {
		await Promise.all(clients.splice(0).map(client => client.stop()));
		server.dispose();
		kernel.dispose();
		temp.remove();
	});

	test('the window gives every agent the same twelve tools and the instructions', async () => {
		const a = connect('a');
		const init = await a.initialize();
		assert.strictEqual(init.instructions, INSTRUCTIONS);
		assert.deepStrictEqual(await a.tools(), [...TOOL_NAMES]);
		const me = await a.call('whoami');
		assert.match(me.text, /^You are @a, an agent \(fake\)\./);
		assert.match(me.text, /Started by @you\./);
		assert.strictEqual(me.data?.name, 'a');
	});

	test('two agents message each other and share a page; results say what is unread', async () => {
		const a = connect('a', ['p1']);
		const b = connect('b', ['p1']);
		await Promise.all([a.initialize(), b.initialize()]);
		const sent = await a.call('send', { to: ['#p1'], text: 'the plan is in p1/plan' });
		assert.match(sent.text, /^Sent message \d+ to @b\.$/);
		const written = await a.call('write', { page: 'p1/plan', text: '# Plan\n- f2' });
		assert.strictEqual(written.text, 'Wrote p1/plan: version 1.');
		const who = await b.call('who');
		assert.match(who.text, /\(1 unread message: call recv\.\)$/);
		const got = await b.call('recv');
		assert.match(got.text, /^1 message:\n\[\d+\] @a → #p1: the plan is in p1\/plan\n\(cursor \d+, unread 0\)$/);
		const page = await b.call('read', { page: 'p1/plan' });
		assert.match(page.text, /^p1\/plan, version 1, by @a, /);
		assert.ok(page.text.endsWith('# Plan\n- f2'));
		const stale = await b.call('write', { page: 'p1/plan', text: 'b\'s plan', if_version: 1 });
		assert.strictEqual(stale.text, 'Wrote p1/plan: version 2.');
		const refused = await a.call('write', { page: 'p1/plan', text: 'a\'s plan', if_version: 1 });
		assert.match(refused.text, /^Not written: p1\/plan is at version 2 \(by @b\)/);
		assert.strictEqual(refused.data?.ok, false);
		const bad = await a.call('send', { to: ['@nobody'], text: 'x' });
		assert.strictEqual(bad.isError, true);
		assert.match(bad.text, /Nobody here is called @nobody/);
	});

	test('recv waits in the tool call, with progress, until a message comes', async () => {
		const a = connect('a');
		const b = connect('b');
		await Promise.all([a.initialize(), b.initialize()]);
		const waiting = b.call('recv', { wait_sec: 30 });
		await new Promise(resolve => setTimeout(resolve, 300));
		await a.call('send', { to: ['@b'], text: 'are you there?' });
		const got = await waiting;
		assert.match(got.text, /@a → @b: are you there\?/);
	});

	test('a call made while the window reloads is repeated once it is back', async () => {
		const a = connect('a');
		await a.initialize();
		assert.strictEqual((await a.call('who')).isError, false);
		server.dispose();
		const pending = a.call('who');
		await new Promise(resolve => setTimeout(resolve, 500));
		server = await WorkspaceServer.start({ kernel, pipe });
		const result = await pending;
		assert.strictEqual(result.isError, false, result.text);
		assert.match(result.text, /@a · fake/);
	});

	test('an agent that was stopped, or replaced under its name, is no longer heard', async () => {
		const a = connect('a');
		await a.initialize();
		kernel.addAgent({ name: 'a', agent: 'fake' });
		const refused = await a.call('send', { to: ['@you'], text: 'still me?' });
		assert.strictEqual(refused.isError, true);
		assert.match(refused.text, /no longer accepts @a/);
	});

	test('a script with the person\'s token finds the window and acts as @you', async () => {
		const record = readWindowRecord(kernel.dir);
		assert.strictEqual(record?.pipe, pipe);
		const you = StdioMcpClient.start([], { FACADE_AGENTS_PIPE: record!.pipe, FACADE_AGENTS_TOKEN: kernel.youToken });
		clients.push(you);
		await you.initialize();
		const me = await you.call('whoami');
		assert.match(me.text, /^You are @you, the person\./);
	});
});
