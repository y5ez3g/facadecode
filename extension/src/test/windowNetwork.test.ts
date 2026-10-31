/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { WINDOW_NETWORK_PROTOCOL, type DirectoryAgent, type ServedRoute } from '../base/windowNetwork';
import { NotServed, windowAddress, WindowNetwork, windowSocketPath } from '../host/windowNetwork';
import { registerWindow, registryOf } from '../record/windowRegistry';
import { tempDir } from './util';

const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';

const AGENT: DirectoryAgent = { run: `run-${'b'.repeat(32)}`, alias: '#a7', name: 'Bob', root: `run-${'b'.repeat(32)}`, yolo: true, cli: 'codex', lifecycle: 'running' };

suite('Window network: window components register and carry requests between windows (ARCHITECTURE-1.1, 2.1)', () => {

	let home: ReturnType<typeof tempDir>;
	let networks: WindowNetwork[];
	let logs: string[];

	setup(() => {
		home = tempDir('facade-network-');
		networks = [];
		logs = [];
	});
	teardown(() => {
		for (const network of networks) {
			network.dispose();
		}
		home.remove();
	});

	/** A window component of `token`, labeled `label`, serving with `serve`. */
	function windowOf(token: string, label: string, serve: (request: ServedRoute) => Promise<unknown>, environment = 'local'): WindowNetwork {
		const network = new WindowNetwork({ home: home.dir, token, label: () => label, environment, serve, log: line => logs.push(line) });
		networks.push(network);
		return network;
	}

	test('an address is the same for a token every time, another token\'s another, and tells nothing of the token', () => {
		assert.strictEqual(windowAddress(TOKEN_A), windowAddress(TOKEN_A));
		assert.notStrictEqual(windowAddress(TOKEN_A), windowAddress(TOKEN_B));
		for (const token of [TOKEN_A, TOKEN_B]) {
			const address = windowAddress(token);
			assert.match(address, /^win-[0-9a-f]{16}$/);
			for (const part of token.split('-')) {
				assert.ok(!address.includes(part), `${address} shows ${part}`);
			}
		}
		const network = new WindowNetwork({ home: home.dir, token: TOKEN_A, label: () => 'A', environment: 'local', serve: async () => undefined, log: () => undefined });
		assert.strictEqual(network.window, windowAddress(TOKEN_A));
	});

	test('two started windows each list themselves first and the other, with what the other published of its agents', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', async () => undefined, 'ssh-remote+box');
		await a.start();
		await b.start();
		b.publish([AGENT, { run: 'not an agent' } as unknown as DirectoryAgent]);
		const fromA = a.directory();
		assert.strictEqual(fromA.self, a.window);
		assert.deepStrictEqual(fromA.windows, [
			{ window: a.window, label: 'Design', environment: 'local', agents: [] },
			{ window: b.window, label: 'Backend', environment: 'ssh-remote+box', agents: [AGENT] }
		]);
		assert.deepStrictEqual(fromA.unavailable, []);
		assert.deepStrictEqual(b.directory().windows.map(each => each.window), [b.window, a.window]);
		if (process.platform !== 'win32') {
			const socket = windowSocketPath(home.dir, a.window);
			assert.strictEqual(fs.statSync(socket).mode & 0o777, 0o600, 'the socket is the person\'s alone');
			assert.strictEqual(fs.statSync(path.dirname(socket)).mode & 0o077, 0, 'in a folder that is the person\'s alone');
		}
	});

	test('a route reaches the other window\'s component with who asked, what and how long it has, and brings back its answer', async () => {
		const served: ServedRoute[] = [];
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', async request => {
			served.push(request);
			return { agents: [AGENT], echoed: request.args };
		});
		await a.start();
		await b.start();
		const response = await a.route({ to: b.window, op: 'agents', args: { include_ended: true }, deadlineMs: 5_000 });
		assert.deepStrictEqual(response, { ok: true, result: { agents: [AGENT], echoed: { include_ended: true } } });
		assert.deepStrictEqual(served, [{ from: a.window, op: 'agents', args: { include_ended: true }, deadlineMs: 5_000 }]);
		// The connection is kept and used again, answers matched to their requests
		const [first, second] = await Promise.all([
			a.route({ to: b.window, op: 'summary', args: 1, deadlineMs: 5_000 }),
			a.route({ to: b.window, op: 'summary', args: 2, deadlineMs: 5_000 })
		]);
		assert.deepStrictEqual([first, second], [{ ok: true, result: { agents: [AGENT], echoed: 1 } }, { ok: true, result: { agents: [AGENT], echoed: 2 } }]);
	});

	test('a window is listed by the name its workspace extension publishes - a remote window\'s with its host - not the folder name its component sees', async () => {
		const a = windowOf(TOKEN_A, 'app', async () => undefined, 'ssh-remote+box');
		const b = windowOf(TOKEN_B, 'Backend', async () => undefined);
		await a.start();
		await b.start();
		const named = () => b.directory().windows.find(each => each.window === a.window)?.label;
		assert.strictEqual(named(), 'app');
		a.publish([AGENT], 'app [SSH: box]');
		assert.deepStrictEqual([named(), a.directory().windows[0].label], ['app [SSH: box]', 'app [SSH: box]']);
		// A later publication without a name keeps the one published
		a.publish([]);
		assert.strictEqual(named(), 'app [SSH: box]');
		assert.deepStrictEqual(logs, []);
	});

	test('a window no workspace extension serves yet - starting or restarting - is unavailable, and the request had no effect', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', async () => { throw new NotServed(); });
		await a.start();
		await b.start();
		assert.deepStrictEqual(await a.route({ to: b.window, op: 'summary', args: {}, deadlineMs: 5_000 }),
			{ ok: false, reason: 'window_unavailable', message: 'Facade Code in that window is not running yet - it is starting or restarting: the request had no effect.', effects: 'none' });
	});

	test('a request the other window fails to serve may have acted there: failed, its effects unknown', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', async () => { throw new Error('The agent ended while its keys went in.'); });
		await a.start();
		await b.start();
		assert.deepStrictEqual(await a.route({ to: b.window, op: 'call', args: {}, deadlineMs: 5_000 }),
			{ ok: false, reason: 'failed', message: 'The agent ended while its keys went in.', effects: 'unknown' });
	});

	test('a window not registered here cannot be reached and nothing was done there', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		await a.start();
		const response = await a.route({ to: windowAddress(TOKEN_B), op: 'call', args: {}, deadlineMs: 5_000 });
		assert.deepStrictEqual([response.ok, !response.ok && response.reason, !response.ok && response.effects], [false, 'window_unavailable', 'none']);
	});

	test('a registered window nobody answers for - its component gone without unregistering - cannot be reached; nothing was done there', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		await a.start();
		const ghost = windowAddress(TOKEN_B);
		registerWindow(home.dir, { protocol: WINDOW_NETWORK_PROTOCOL, window: ghost, socket: windowSocketPath(home.dir, ghost), pid: process.pid, label: 'Ghost', environment: 'local', agents: [], updatedAt: 1 });
		const response = await a.route({ to: ghost, op: 'call', args: {}, deadlineMs: 5_000 });
		assert.deepStrictEqual([response.ok, !response.ok && response.reason, !response.ok && response.effects], [false, 'window_unavailable', 'none']);
	});

	test('a window of another network protocol is listed as unavailable, and a route to it is refused with no effect', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		await a.start();
		const older = windowAddress(TOKEN_B);
		registerWindow(home.dir, { protocol: WINDOW_NETWORK_PROTOCOL + 1, window: older, socket: windowSocketPath(home.dir, older), pid: process.pid, label: 'Newer build', environment: 'local', agents: [AGENT], updatedAt: 1 });
		const directory = a.directory();
		assert.deepStrictEqual(directory.windows.map(each => each.window), [a.window]);
		assert.deepStrictEqual(directory.unavailable, [{ window: older, label: 'Newer build', reason: 'protocol_incompatible' }]);
		const response = await a.route({ to: older, op: 'call', args: {}, deadlineMs: 5_000 });
		assert.deepStrictEqual([response.ok, !response.ok && response.reason, !response.ok && response.effects], [false, 'protocol_incompatible', 'none']);
	});

	test('a request answered later than its deadline times out, its effects unknown; the late answer goes nowhere', async () => {
		let release!: () => void;
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', request => request.args === 'slow' ? new Promise(resolve => release = () => resolve('late')) : Promise.resolve('quick'));
		await a.start();
		await b.start();
		const response = await a.route({ to: b.window, op: 'call', args: 'slow', deadlineMs: 100 });
		assert.deepStrictEqual([response.ok, !response.ok && response.reason, !response.ok && response.effects], [false, 'timeout', 'unknown']);
		release();
		await new Promise(resolve => setTimeout(resolve, 50));
		// The late answer is taken for no other request: the next one gets its own answer
		assert.deepStrictEqual(await a.route({ to: b.window, op: 'call', args: 'next', deadlineMs: 5_000 }), { ok: true, result: 'quick' });
	});

	test('a request under way when the other window goes may have acted there: unavailable, its effects unknown', async () => {
		let begin!: () => void;
		const begun = new Promise<void>(resolve => begin = resolve);
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', () => {
			begin();
			return new Promise(() => undefined);
		});
		await a.start();
		await b.start();
		const pending = a.route({ to: b.window, op: 'call', args: {}, deadlineMs: 5_000 });
		await begun;
		b.dispose();
		const response = await pending;
		assert.deepStrictEqual([response.ok, !response.ok && response.reason, !response.ok && response.effects], [false, 'window_unavailable', 'unknown']);
	});

	test('a window that goes unregisters at once, a later route finds nothing; started again with its token, it is reached again', async () => {
		const a = windowOf(TOKEN_A, 'Design', async () => undefined);
		const b = windowOf(TOKEN_B, 'Backend', async () => 'first');
		await a.start();
		await b.start();
		assert.deepStrictEqual(await a.route({ to: b.window, op: 'summary', args: {}, deadlineMs: 5_000 }), { ok: true, result: 'first' });
		b.dispose();
		assert.ok(!fs.existsSync(path.join(registryOf(home.dir), `${b.window}.json`)));
		// Its connections close with it - long before a reloaded window comes up again - so none reaches what is gone
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual(a.directory().windows.map(each => each.window), [a.window]);
		const gone = await a.route({ to: b.window, op: 'summary', args: {}, deadlineMs: 5_000 });
		assert.deepStrictEqual([gone.ok, !gone.ok && gone.reason, !gone.ok && gone.effects], [false, 'window_unavailable', 'none']);
		// The same window after a reload: its address is its token's, and the old connection is replaced
		const again = windowOf(TOKEN_B, 'Backend', async () => 'again');
		await again.start();
		assert.strictEqual(again.window, b.window);
		assert.deepStrictEqual(await a.route({ to: b.window, op: 'summary', args: {}, deadlineMs: 5_000 }), { ok: true, result: 'again' });
		// A closing window routes nothing
		a.dispose();
		const closing = await a.route({ to: b.window, op: 'summary', args: {}, deadlineMs: 5_000 });
		assert.deepStrictEqual([closing.ok, !closing.ok && closing.reason, !closing.ok && closing.effects], [false, 'window_unavailable', 'none']);
	});

	test('a request in another protocol, or incomplete, is answered with why and serves nothing', async () => {
		const served: ServedRoute[] = [];
		const b = windowOf(TOKEN_B, 'Backend', async request => { served.push(request); return 'served'; });
		await b.start();
		const socket = net.connect(windowSocketPath(home.dir, b.window));
		await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
		const answers: unknown[] = [];
		let buffer = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let line: number;
			while ((line = buffer.indexOf('\n')) >= 0) {
				answers.push(JSON.parse(buffer.slice(0, line)));
				buffer = buffer.slice(line + 1);
			}
		});
		socket.write(`${JSON.stringify({ id: 1, protocol: WINDOW_NETWORK_PROTOCOL + 1, from: 'win-x', op: 'call', args: {}, deadlineMs: 1_000 })}\n`);
		socket.write(`${JSON.stringify({ id: 2, protocol: WINDOW_NETWORK_PROTOCOL, op: 'call', args: {}, deadlineMs: 1_000 })}\n`);
		socket.write('not json\n');
		socket.write(`${JSON.stringify({ id: 3, protocol: WINDOW_NETWORK_PROTOCOL, from: 'win-x', op: 'call', args: { n: 3 }, deadlineMs: 1_000 })}\n`);
		const deadline = Date.now() + 5_000;
		while (answers.length < 3 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		socket.destroy();
		assert.deepStrictEqual(answers.map(each => [(each as { id: number }).id, (each as { ok: boolean }).ok, (each as { reason?: string }).reason, (each as { effects?: string }).effects]), [
			[1, false, 'protocol_incompatible', 'none'],
			[2, false, 'failed', 'none'],
			[3, true, undefined, undefined]
		]);
		assert.deepStrictEqual(served, [{ from: 'win-x', op: 'call', args: { n: 3 }, deadlineMs: 1_000 }]);
	});
});
