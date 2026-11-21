/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import type { ScreenChange, ScreenSnapshot, WatchParams } from '../base/coreProtocol';
import { lineReader } from '../base/lines';
import type { ResizeAttach } from '../host/orchestrator/types';
import { daemonSocketPath } from '../host/rust/rpc';
import { FACADE_PROGRAM } from '../host/rust/types';
import { tempDir, waitFor } from './util';
import { withModules } from './withModules';

const build = '0.1.7';
const machine = '00000000-0000-4000-8000-000000000001';
type Connect = typeof import('../host/orchestrator/connection').connectOrchestrator;
type TestRequest = { readonly id?: number; readonly method: string; readonly params: unknown };

/** Drive the actual editor connection over private sockets, numbering each connection in arrival order. */
async function withDaemon(
	receive: (request: TestRequest, send: (...messages: object[]) => void, connection: number) => void,
	check: (connect: () => ReturnType<Connect>) => Promise<void>
): Promise<void> {
	const home = tempDir('facade-daemon-fixture-');
	const sockets = new Set<net.Socket>();
	let next = 0;
	const server = net.createServer(socket => {
		const connection = next++;
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		socket.on('data', lineReader(line => {
			const request: TestRequest = JSON.parse(line);
			receive(request, (...messages) => {
				socket.write(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n').join(''));
			}, connection);
		}, assert.fail));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const port = (server.address() as net.AddressInfo).port;
		const modules: Record<string, unknown> = {};
		const load = withModules(modules);
		const rpc = load<typeof import('../host/rust/rpc')>(require.resolve('../host/rust/rpc'));
		modules['../rust/rpc'] = {
			...rpc,
			connectDaemonSocket: async () => {
				const socket = net.connect(port, '127.0.0.1');
				await once(socket, 'connect');
				return { socket };
			},
			startDaemon: () => assert.fail('The isolated hello fixture already answers.'),
		};
		const { connectOrchestrator } = load<typeof import('../host/orchestrator/connection')>(require.resolve('../host/orchestrator/connection'));
		await check(() => connectOrchestrator({ home: home.dir, program: path.join(home.dir, FACADE_PROGRAM), build, log: () => {} }));
	} finally {
		for (const socket of sockets) { socket.destroy(); }
		await new Promise<void>(resolve => server.close(() => resolve()));
		home.remove();
	}
}

async function withHello(reply: object, check: (connect: () => ReturnType<Connect>) => Promise<void>): Promise<void> {
	const requests: TestRequest[] = [];
	await withDaemon((request, send) => {
		requests.push(request);
		send({ id: request.id, ...reply });
	}, check);
	assert.deepStrictEqual(requests.map(({ method, params }) => [method, params]), [
		['hello', { api_versions: [1], build, kind: 'ide' }],
	]);
}

const welcome = {
	api_version: 1, build: '0.1.6', machine_id: machine, pid: 4321, agent_count: 0,
	ops: ['agent.inspect', 'future.operation'], topics: ['agents', 'attach', 'machines', 'future.topic'],
};

suite('Core connection (ARCHITECTURE-1.4)', () => {
	test('uses the exact daemon socket name', () => {
		const home = 'D:\\Facade home\\\u4f60\u597d';
		if (process.platform === 'win32') {
			assert.strictEqual(daemonSocketPath(home), '\\\\.\\pipe\\facade-core-daemon-3023af2dc8');
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade.exe');
		} else {
			assert.strictEqual(daemonSocketPath(home), path.join('/tmp', `facade-core-${process.getuid?.() ?? os.userInfo().uid}`, 'daemon-3023af2dc8.sock'));
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade');
		}
	});

	test('accepts the offered API independently of the software build and tolerates future catalog entries', async () => {
		await withHello({ result: { ...welcome, future: { count: 1 } } }, async connect => {
			const link = await connect();
			try {
				assert.strictEqual(link.connected, true);
				assert.strictEqual(link.machineId, machine);
			} finally { link.dispose(); }
		});
	});

	test('rejects a daemon selecting an API the editor never offered', async () => {
		await withHello({ result: { ...welcome, api_version: 2 } }, async connect => {
			await assert.rejects(connect);
		});
	});

	test('retains the prerelease refusal and sends no legacy takeover request', async () => {
		const refusal = { code: -32602, message: 'Provide hello.params.protocol.', data: { reason: 'invalid_argument' } };
		await withHello({ error: refusal }, async connect => {
			await assert.rejects(connect, error => {
				const rejected = error instanceof Error && error.cause instanceof Error ? error.cause : error;
				assert.ok(rejected instanceof Error);
				assert.strictEqual(rejected.message, refusal.message);
				assert.strictEqual((rejected as Error & { reason: string }).reason, refusal.data.reason);
				return true;
			});
		});
	});

	test('reconnects Attach when the new daemon reuses a watch ID', async function () {
		this.timeout(10_000);
		const first = { machine_id: machine, agent_id: 'a1' };
		const second = { machine_id: machine, agent_id: 'a2' };
		const size = { cols: 80, rows: 24 };
		const restoredSize = { cols: 120, rows: 32 };
		const acknowledgements: TestRequest[] = [];
		const calls: { connection: number; request: TestRequest }[] = [];
		const requests: { connection: number; args: WatchParams }[] = [];
		const effects: unknown[] = [];
		const resize: ResizeAttach[] = [];
		let closingSent = false;
		const watchReply = (id: number | undefined, watch: number, reference: typeof first, screen: string, grid = size) => {
			const snapshot: ScreenSnapshot = { reference, address: reference.agent_id, size: grid, redraw: Buffer.from(screen).toString('base64') };
			return { id, result: { watch, snapshot } };
		};
		const changed = (watch: number, text: string) => {
			const change: ScreenChange = { kind: 'output', data: Buffer.from(text).toString('base64') };
			return { method: 'changed', params: { watch, change } };
		};
		await withDaemon((request, send, connection) => {
			switch (request.method) {
				case 'hello':
					send({ id: request.id, result: { ...welcome, pid: welcome.pid + connection, ops: ['attach.resize'] } });
					break;
				case 'watch': {
					const watch = request.params as Extract<WatchParams, { topic: 'attach' }>;
					requests.push({ connection, args: watch });
					const target = watch.args.target;
					const primary = typeof target !== 'string' && target.agent_id === first.agent_id;
					if (connection === 0 && !primary) {
						closingSent = true;
						// Keep this registration unanswered until after closing and deliver the stale frames in the same write.
						send({ method: 'closing', params: { build: '0.1.8' } }, changed(7, 'retired output'),
							{ method: 'watch_ended', params: { watch: 7, error: { code: -32000, message: 'retired watch', data: { reason: 'unavailable' } } } },
							watchReply(request.id, 8, second, 'retired reply'));
					} else if (primary) {
						send(watchReply(request.id, 7, first, connection ? 'restored' : 'initial', connection ? restoredSize : size));
					} else {
						send(watchReply(request.id, 8, second, 'second restored', restoredSize), changed(7, 'live output'));
					}
					break;
				}
				case 'closing':
					acknowledgements.push(request);
					break;
				default:
					calls.push({ connection, request });
					if (request.id !== undefined) { send({ id: request.id, result: {} }); }
			}
		}, async connect => {
			const link = await connect();
			let firstCapacity = size;
			const hold = (target: typeof first) => link.watchAttach(() => ({ target, size: target === first ? firstCapacity : size }), {
				snapshot(screen, setSize) {
					effects.push([screen.reference, Buffer.from(screen.redraw, 'base64').toString(), screen.size]);
					if (target === first) { resize.push(setSize); }
				},
				change(change) { effects.push(change.kind === 'output' ? Buffer.from(change.data, 'base64').toString() : change); },
				ended(error) { effects.push(error.message); },
				disconnected() { effects.push(['disconnected', target]); }
			});
			try {
				const primary = hold(first);
				await waitFor(() => resize.length === 1);
				firstCapacity = restoredSize;
				const secondary = hold(second);
				await waitFor(() => closingSent && effects.includes('live output'));
				assert.deepStrictEqual(requests, [
					{ connection: 0, args: { topic: 'attach', args: { target: first, size } } },
					{ connection: 0, args: { topic: 'attach', args: { target: second, size } } },
					{ connection: 1, args: { topic: 'attach', args: { target: first, size: restoredSize } } },
					{ connection: 1, args: { topic: 'attach', args: { target: second, size } } }
				]);
				assert.strictEqual(resize.length, 2);
				assert.deepStrictEqual(effects, [
					[first, 'initial', size], ['disconnected', first], ['disconnected', second],
					[first, 'restored', restoredSize], [second, 'second restored', restoredSize], 'live output'
				]);
				resize[0]({ size: { cols: 60, rows: 16 } });
				resize[1]({ size: restoredSize });
				secondary.dispose();
				primary.dispose();
				await waitFor(() => calls.filter(({ request }) => request.method === 'unwatch').length === 2);
				assert.deepStrictEqual(acknowledgements, [{ jsonrpc: '2.0', method: 'closing', params: {} }]);
				assert.deepStrictEqual(calls.map(({ connection, request: { method, params } }) => [connection, method, params]), [
					[1, 'call', { op: 'attach.resize', args: { watch: 7, size: restoredSize } }],
					[1, 'unwatch', { watch: 8 }],
					[1, 'unwatch', { watch: 7 }]
				]);
				assert.strictEqual(calls[0].request.id, undefined);
			} finally { link.dispose(); }
		});
	});
});
