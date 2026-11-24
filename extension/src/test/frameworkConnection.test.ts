/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter, once } from 'events';
import { PassThrough } from 'stream';
import type { ScreenChange, ScreenSnapshot, WatchParams } from '../base/frameworkProtocol';
import { connectWithin } from '../base/connect';
import { lineReader } from '../base/lines';
import type { ResizeAttach } from '../host/framework/types';
import { daemonSocketPath } from '../host/framework/rpc';
import { FACADE_PROGRAM } from '../host/framework/daemonTypes';
import { ptydPlace } from './ptydPlace';
import { tempDir, waitFor } from './util';
import { withModules } from './withModules';

const build = '0.1.7';
const machine = '00000000-0000-4000-8000-000000000001';
type Connect = typeof import('../host/framework/connection').connectOrchestrator;
type TestRequest = { readonly id?: number; readonly method: string; readonly params: unknown };

/** Drive the actual editor connection over private sockets, numbering each connection in arrival order. */
async function withDaemon(
	receive: (request: TestRequest, send: (...messages: object[]) => void, connection: number) => void,
	check: (connect: () => ReturnType<Connect>, home: string) => Promise<void>,
	localSocket = false
): Promise<void> {
	const home = tempDir('facade-daemon-fixture-');
	const place = localSocket ? ptydPlace('fd-framework-') : undefined;
	const endpoint = place?.pipe('daemon');
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
	try {
		if (endpoint) { server.listen(endpoint); } else { server.listen(0, '127.0.0.1'); }
		await once(server, 'listening');
		const port = (server.address() as net.AddressInfo).port;
		const modules: Record<string, unknown> = {};
		const load = withModules(modules);
		const rpc = load<typeof import('../host/framework/rpc')>(require.resolve('../host/framework/rpc'));
		modules['./rpc'] = {
			...rpc,
			connectDaemonSocket: async (_home: string, waitMs: number) => {
				if (endpoint) { return connectWithin(endpoint, waitMs); }
				const socket = net.connect(port, '127.0.0.1');
				await once(socket, 'connect');
				return { socket };
			},
			startDaemon: () => assert.fail('The isolated hello fixture already answers.'),
		};
		const { connectOrchestrator } = load<typeof import('../host/framework/connection')>(require.resolve('../host/framework/connection'));
		await check(() => connectOrchestrator({ home: home.dir, program: path.join(home.dir, FACADE_PROGRAM), build, log: () => {} }), home.dir);
	} finally {
		for (const socket of sockets) { socket.destroy(); }
		await new Promise<void>(resolve => server.close(() => resolve()));
		if (place) { fs.rmSync(place.dir, { recursive: true, force: true }); }
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

suite('Framework connection (ARCHITECTURE-1.4)', () => {
	test('carries typed startup refusal and planned restart details through the editor adapter', async () => {
		const home = tempDir('facade-startup-report-');
		try {
			const program = path.join(home.dir, FACADE_PROGRAM);
			for (const reason of ['refused', 'protocol_incompatible'] as const) {
				const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
				const load = withModules({ child_process: { spawn: (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
					assert.deepStrictEqual([file, args], [program, ['daemon', '--takeover']]);
					assert.deepStrictEqual([options.env.FACADE_HOME, options.env.FACADE_EDITOR_STARTUP_REPORT], [home.dir, '1']);
					return child;
				} } });
				const { startDaemon } = load<typeof import('../host/framework/rpc')>(require.resolve('../host/framework/rpc'));
				const { DaemonError } = load<typeof import('../host/framework/daemonTypes')>(require.resolve('../host/framework/daemonTypes'));
				const data = { reason, details: { next: 'Plan a restart before retrying.' } };
				const body = { code: -32000, message: 'Plan a restart before retrying.', data };
				const result = startDaemon({ home: home.dir, program, log: assert.fail }, '--takeover');
				child.stdout.end(`facade-editor-daemon-error ${JSON.stringify(body)}\n`);
				child.stderr.end('Startup diagnostics\n');
				child.emit('close', 1);
				await assert.rejects(result, (error: unknown) => {
					assert.ok(error instanceof DaemonError);
					assert.deepStrictEqual([error.code, error.message, error.reason, error.data], [body.code, body.message, reason, data]);
					return true;
				});
			}
		} finally { home.remove(); }
	});

	test('keeps startup failures without a typed stdout report as ordinary errors', async () => {
		const home = tempDir('facade-startup-error-');
		try {
			const program = path.join(home.dir, FACADE_PROGRAM);
			for (const [event, detail] of [['error', 'ENOENT'], ['close', 'ordinary startup failure']] as const) {
				const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
				const load = withModules({ child_process: { spawn: () => child } });
				const { startDaemon } = load<typeof import('../host/framework/rpc')>(require.resolve('../host/framework/rpc'));
				const { DaemonError } = load<typeof import('../host/framework/daemonTypes')>(require.resolve('../host/framework/daemonTypes'));
				const result = startDaemon({ home: home.dir, program, log: assert.fail }, '--detach');
				if (event === 'error') {
					child.emit('error', new Error(detail));
				} else {
					child.stdout.end(`${detail}\n`);
					child.stderr.end('facade-editor-daemon-error {"code":-32000,"message":"wrong stream","data":{"reason":"refused"}}\n');
					child.emit('close', 1);
				}
				await assert.rejects(result, (error: unknown) => {
					assert.ok(error instanceof Error && !(error instanceof DaemonError));
					assert.ok(error.message.includes(detail), error.message);
					return true;
				});
			}
		} finally { home.remove(); }
	});

	test('uses the exact daemon socket name', () => {
		const home = 'D:\\Facade home\\\u4f60\u597d';
		if (process.platform === 'win32') {
			assert.strictEqual(daemonSocketPath(home), '\\\\.\\pipe\\facade-framework-daemon-3023af2dc8');
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade.exe');
		} else {
			assert.strictEqual(daemonSocketPath(home), path.join('/tmp', `facade-framework-${process.getuid?.() ?? os.userInfo().uid}`, 'daemon-3023af2dc8.sock'));
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

	test('retains the incompatible hello refusal and sends no legacy takeover request', async () => {
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

	test('Open Settings File uses the live absolute status path and preserves an exclusive creator', async () => {
		const requests: TestRequest[] = [];
		const opened: { file: string; preview: boolean; text: string }[] = [];
		const errors: string[] = [];
		const created: string[] = [];
		const competing = '{ "yolo": false }\n';
		let home: string;
		let file: string;
		let race: string;
		let settingsPath: string;
		let exclusiveLinks = 0;
		await withDaemon((request, send) => {
			requests.push(request);
			if (request.method === 'hello') {
				send({ id: request.id, result: { ...welcome, ops: ['daemon.status'] } });
			} else {
				send({ id: request.id, result: {
					home, settings_file: settingsPath, build: welcome.build, daemon_pid: welcome.pid, agent_count: 0, machines: [],
				} });
			}
		}, async (connect, root) => {
			home = root;
			file = path.join(home, 'status', 'facade.json');
			race = path.join(home, 'other-status', 'facade.json');
			settingsPath = file;
			const handlers = new Map<string, () => Promise<void>>();
			const vscode = {
				Uri: { file: (fsPath: string) => ({ fsPath }) },
				l10n: { t: (text: string, ..._args: unknown[]) => text },
				commands: {
					registerCommand: (id: string, run: () => Promise<void>) => {
						handlers.set(id, run);
						return { dispose: () => handlers.delete(id) };
					}
				},
				window: {
					showTextDocument: async (uri: { fsPath: string }, options: { preview: boolean }) => {
						opened.push({ file: uri.fsPath, preview: options.preview, text: fs.readFileSync(uri.fsPath, 'utf8') });
					},
					showErrorMessage: async (message: string) => { errors.push(message); }
				}
			};
			const hostFs = new Proxy(fs, { get: (target, key) => key === 'linkSync' ? (source: string, dest: string) => {
				exclusiveLinks++;
				// A second writer wins after the command found no file and prepared its temporary file.
				if (dest === race) { fs.writeFileSync(dest, competing, { flag: 'wx' }); }
				fs.linkSync(source, dest);
			} : Reflect.get(target, key) });
			const { frameworkSettings } = withModules({ vscode, fs: hostFs })<typeof import('../host/framework/settings')>(require.resolve('../host/framework/settings'));
			const link = await connect();
			const registration = frameworkSettings({ status: () => link.call('daemon.status', {}), log: { event: line => created.push(line) } }).register();
			try {
				const edit = handlers.get('facade.openSettingsFile') ?? assert.fail('Missing Open Settings File registration.');
				await edit();
				assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}\n');
				settingsPath = race;
				await edit();
				assert.strictEqual(fs.readFileSync(race, 'utf8'), competing);
				assert.deepStrictEqual(opened, [
					{ file, preview: false, text: '{}\n' },
					{ file: race, preview: false, text: competing },
				]);
				assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['facade.json']);
				assert.deepStrictEqual(fs.readdirSync(path.dirname(race)), ['facade.json']);
				assert.deepStrictEqual([exclusiveLinks, created.length, errors], [2, 1, []]);
				assert.strictEqual(fs.existsSync(path.join(home, 'facade.json')), false, 'The command follows the status path.');
				settingsPath = 'relative/facade.json';
				await edit();
				assert.strictEqual(opened.length, 2);
				assert.deepStrictEqual(errors, ['The Orchestrator did not return an absolute path to facade.json.']);
			} finally {
				registration.dispose();
				link.dispose();
			}
		}, true);
		assert.deepStrictEqual(requests.map(({ method, params }) => [method, params]), [
			['hello', { api_versions: [1], build, kind: 'ide' }],
			...Array.from({ length: 3 }, () => ['call', { op: 'daemon.status', args: {} }]),
		]);
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
