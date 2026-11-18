/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import * as path from 'path';
import { Duplex } from 'stream';
import { MACHINE_BRIDGE_CHUNK_BYTES, machineBridgeBytes, WORKSPACE_MACHINE_BRIDGE_COMMAND, type MachineBridgeAction, type MachineBridgePipe, type WindowIdentity } from '../base/windowIdentity';
import { withModules } from './withModules';

const home = process.env.FACADE_HOME!;
const build = '0.1.6';
const identity = (): WindowIdentity => ({ version: 1, session: randomUUID(), token: randomUUID() });
const handle = ({ session, token }: WindowIdentity) => ({ session, token, stream: randomUUID() });
const jsonLine = (value: object) => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

suite('A6 Remote-SSH machine bridge', () => {
	test('a workspace opens only its own relay, preserves binary chunks and stderr, and closes that relay with EOF', async () => {
		const remoteHome = path.join(home, 'remote home 測試');
		const program = path.join(remoteHome, 'packaged facade');
		const exits: Promise<unknown[]>[] = [];
		const diagnostic = Buffer.from([0, 0xff, 0x0a]);
		const { RemoteSshWorkspace } = withModules({ child_process: {
			spawn(binary: string, args: string[], options: SpawnOptionsWithoutStdio) {
				assert.strictEqual(binary, program);
				assert.deepStrictEqual(args, ['machine', 'serve', '--home-hex', Buffer.from(remoteHome).toString('hex')]);
				assert.strictEqual(options.env?.FACADE_HOME, remoteHome);
				const child = spawn(process.execPath, ['-e', `process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stderr.write(Buffer.from(${JSON.stringify([...diagnostic])})));`], options);
				exits.push(once(child, 'close'));
				return child;
			}
		} })<typeof import('../host/remoteSshWorkspace')>(require.resolve('../host/remoteSshWorkspace'));
		const identityA = identity();
		const identityB = identity();
		const a = new RemoteSshWorkspace(identityA, program, remoteHome);
		const b = new RemoteSshWorkspace(identityB, program, remoteHome);
		const first = handle(identityA);
		const other = handle(identityB);
		const ask = (action: MachineBridgeAction) => b.request({ ...other, ...action });
		const readAll = async (pipe: MachineBridgePipe): Promise<Buffer> => {
			const chunks: Buffer[] = [];
			for (;;) {
				const reply = await ask({ kind: 'read', pipe }) as { data?: string; eof?: true };
				if (reply.data !== undefined) {
					const bytes = machineBridgeBytes(reply.data);
					assert.ok(bytes && bytes.length <= MACHINE_BRIDGE_CHUNK_BYTES);
					chunks.push(bytes);
				}
				if (reply.eof === true) {
					return Buffer.concat(chunks);
				}
			}
		};
		try {
			assert.strictEqual(await a.request({ ...first, kind: 'open' }), true);
			assert.strictEqual(await b.request({ ...first, kind: 'open' }), undefined);
			assert.strictEqual(await ask({ kind: 'open' }), true);
			assert.strictEqual(await ask({ kind: 'write', data: Buffer.alloc(MACHINE_BRIDGE_CHUNK_BYTES + 1).toString('base64') }), undefined);
			assert.strictEqual(await ask({ kind: 'write', data: 'YQ =\n=' }), undefined);
			assert.strictEqual(exits.length, 0, 'open and rejected writes leave the program stopped');

			const aToken = Buffer.from([5, 0, 255]);
			assert.strictEqual(await a.request({ ...first, kind: 'write', data: aToken.toString('base64') }), true);
			assert.strictEqual(await a.request({ ...first, kind: 'read', pipe: 'stdout' }).then(result => (result as { data: string }).data), aToken.toString('base64'));
			const bFirst = Buffer.from([7, 9, 0, 255]);
			assert.strictEqual(await ask({ kind: 'write', data: bFirst.toString('base64') }), true);
			assert.strictEqual(await a.request({ ...first, kind: 'close' }), true);
			assert.deepStrictEqual(await exits[0], [0, null], 'the relay saw EOF and exited without a signal');
			const reloaded = handle(identityA);
			assert.strictEqual(await a.request({ ...reloaded, kind: 'open' }), true);
			assert.strictEqual(await a.request({ ...first, kind: 'close' }), undefined, 'an earlier stream cannot close its successor');

			const payload = Buffer.alloc(4 * MACHINE_BRIDGE_CHUNK_BYTES + 19);
			for (let i = 0; i < payload.length; i++) {
				payload[i] = i % 251;
			}
			const [, stdout, stderr] = await Promise.all([
				(async () => {
					for (let i = 0; i < payload.length; i += MACHINE_BRIDGE_CHUNK_BYTES) {
						assert.strictEqual(await ask({ kind: 'write', data: payload.subarray(i, i + MACHINE_BRIDGE_CHUNK_BYTES).toString('base64') }), true);
					}
					assert.strictEqual(await ask({ kind: 'end' }), true);
				})(),
				readAll('stdout'),
				readAll('stderr')
			]);
			assert.deepStrictEqual(stdout, Buffer.concat([bFirst, payload]), 'the surviving window retains the original stream and byte order');
			assert.deepStrictEqual(stderr, diagnostic);
			assert.deepStrictEqual(await exits[1], [0, null]);
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	test('terminal authorization and trust frames are consumed locally, even when machine frames share their chunk', async () => {
		const remote = { name: 'gpu', machine_id: randomUUID(), boot_id: randomUUID(), protocol: [2, 2], build };
		const greeting = jsonLine({ id: 9, method: 'hello', params: { kind: 'machine' } });
		const machineBytes = Buffer.from([0xff, 0, 0xac, 0x0a, 0x0d]);
		const incoming = Buffer.from([0x80, 0, 0x0a]);
		const requests: unknown[] = [];
		const received: Buffer[] = [];
		const socket = new Duplex({
			read() { },
			write(bytes: Buffer, _encoding, done) {
				if (requests.length < 2) {
					requests.push(JSON.parse(bytes.toString()));
					this.push(requests.length === 1 ? jsonLine({ id: 1, result: { protocol: 2, build } }) : Buffer.concat([jsonLine({ id: 2, result: {} }), greeting]));
				} else {
					received.push(bytes);
				}
				done();
			}
		});
		const { openLocalMachine } = withModules({ './rust/connection': { connectDaemonSocket: async () => ({ socket }), startDaemon: () => assert.fail('The daemon already runs.') } })
			<typeof import('../host/remoteSshDaemon')>(require.resolve('../host/remoteSshDaemon'));
		const stop = new AbortController();
		try {
			const core = await openLocalMachine({ home, build, program: () => undefined, log: () => undefined }, stop.signal);
			assert.ok(core);
			assert.deepStrictEqual(requests, [
				{ jsonrpc: '2.0', id: 1, method: 'hello', params: { kind: 'terminal', protocol: [2, 2], build } },
				{ jsonrpc: '2.0', id: 2, method: 'call', params: { op: 'machine.connect', args: { kind: 'temporary', transport: { kind: 'bridge' } } } }
			]);
			const forwarded: (Buffer | undefined)[] = [];
			const trust: unknown[] = [];
			await core.sendToWorkspace(async bytes => {
				forwarded.push(bytes);
				if (forwarded.length === 1) {
					assert.deepStrictEqual(bytes, greeting);
					await core.write(incoming);
					socket.push(Buffer.concat([jsonLine({ method: 'machine.connected', params: { machine: remote, first_connection: true } }), machineBytes]));
					socket.push(null);
				}
			}, event => trust.push(event));
			await core.write(incoming);
			await core.write();
			assert.deepStrictEqual(forwarded, [greeting, machineBytes, undefined]);
			assert.deepStrictEqual(received, [incoming, incoming], 'local output still accepts bytes after input EOF');
			assert.deepStrictEqual(trust, [{ machine: remote, first_connection: true }]);
		} finally {
			stop.abort();
		}
	});

	test('an absent local core warns once across retries without starting the relay', async () => {
		const requests: string[] = [];
		const warnings: string[] = [];
		let secondClose!: () => void;
		const triedTwice = new Promise<void>(resolve => { secondClose = resolve; });
		const { startRemoteSshMachine } = withModules({
			vscode: {
				commands: { executeCommand: async (command: string, action: MachineBridgeAction) => {
					assert.strictEqual(command, WORKSPACE_MACHINE_BRIDGE_COMMAND);
					requests.push(action.kind);
					if (requests.length === 4) {
						secondClose();
					}
					return true;
				} },
				extensions: { getExtension: () => undefined },
				l10n: { t: (text: string) => text },
				window: { showWarningMessage: async (text: string) => warnings.push(text) }
			},
			'../clis/executable': { executableAt: () => undefined, which: () => undefined },
			'./rust/connection': {
				connectDaemonSocket: async () => ({ absent: true, reason: 'test socket absent' }),
				startDaemon: () => assert.fail('No local executable is available.')
			}
		})<typeof import('../host/remoteSsh')>(require.resolve('../host/remoteSsh'));
		const { session, token } = identity();
		const bridge = startRemoteSshMachine({ extensionPath: home, extension: { packageJSON: { version: build } } } as never, home, session, token);
		try {
			await triedTwice;
		} finally {
			await bridge.close();
		}
		assert.deepStrictEqual(requests, ['open', 'close', 'open', 'close']);
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /Install Facade Code locally/);
	});

	test('trust is shown for the first connection the core reports, including after a stream is replaced', async () => {
		const notes: string[] = [];
		let opened = 0;
		let closed = 0;
		let reconnected!: () => void;
		const done = new Promise<void>(resolve => { reconnected = resolve; });
		const machine = { name: 'gpu', machine_id: randomUUID() };
		const { startRemoteSshMachine } = withModules({
			vscode: {
				commands: { executeCommand: async (_command: string, action: MachineBridgeAction) => {
					if (action.kind === 'close' && ++closed === 2) {
						reconnected();
					}
					return action.kind === 'read' ? { eof: true } : true;
				} },
				l10n: { t: (text: string, name: string) => text.replace('{0}', name) },
				window: { showInformationMessage: async (text: string) => notes.push(text) }
			},
			'./remoteSshDaemon': {
				openLocalMachine: async () => {
					const first_connection = ++opened === 1;
					return {
						sendToWorkspace: async (_write: unknown, connected: (event: object) => void) => connected({ machine, first_connection }),
						write: async () => undefined
					};
				}
			}
		})<typeof import('../host/remoteSsh')>(require.resolve('../host/remoteSsh'));
		const { session, token } = identity();
		const bridge = startRemoteSshMachine({ extension: { packageJSON: { version: build } } } as never, home, session, token);
		try {
			await done;
		} finally {
			await bridge.close();
		}
		assert.strictEqual(opened, 2);
		assert.strictEqual(notes.length, 1);
		assert.match(notes[0], /^Connected to gpu\./);
	});
});
