/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import type { ErrorBody, Request } from '../base/coreProtocol';
import { lineReader } from '../base/lines';
import { daemonSocketPath } from '../host/rust/rpc';
import { FACADE_PROGRAM } from '../host/rust/types';
import { withModules } from './withModules';

/** Exercise the real framing over a private loopback socket. Live daemon takeover is covered by integration. */
async function refusedUpgrade(refusal: ErrorBody, listingFails = false): Promise<void> {
	const build = '0.2.0';
	const machine_id = '00000000-0000-4000-8000-000000000001';
	const selector = `id:${machine_id.replace(/-/g, '')}`;
	const needsList = refusal.data.reason === 'protocol_incompatible' && refusal.message.includes('the running keeper speaks');
	const requests: Request[] = [];
	const server = net.createServer(socket => {
		socket.on('data', lineReader(line => {
			const request: Request = JSON.parse(line);
			requests.push(request);
			const answers = [
				{ error: { code: -32000, message: 'v2 only', data: { reason: 'protocol_incompatible', protocol: { local_protocol: [2, 2] } } } },
				{ result: { protocol: 2, machine_id, build: '0.1.6' } },
				{ error: refusal },
				listingFails ? { error: { code: -32000, message: 'Failed to list', data: { reason: 'unavailable' } } } : {
					result: { agents: [
						{ agent_id: 'a7', machine_id, process: 'running' },
						{ agent_id: 'a9', machine_id, process: 'ended' },
						{ agent_id: 'a8', machine_id, process: 'running', guest: true },
						{ agent_id: 'a7', machine_id: '00000000-0000-4000-8000-000000000002', process: 'running' },
					] },
				},
			];
			socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answers[requests.length - 1] }) + '\n');
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
			startDaemon: () => assert.fail('The isolated protocol fixture already answers.'),
		};
		const { connectOrchestrator } = load<typeof import('../host/orchestrator/connection')>(require.resolve('../host/orchestrator/connection'));
		const program = path.join(os.tmpdir(), FACADE_PROGRAM);
		await assert.rejects(connectOrchestrator({ home: os.tmpdir(), program, build, log: assert.fail }), error => {
			const rejected = error as Error & { reason: string; data: object };
			const tip = needsList && !listingFails ? `\n  tip: stop a7@${machine_id} and retry the upgrade` : '';
			assert.strictEqual(rejected.message, refusal.message + tip);
			assert.strictEqual(rejected.reason, refusal.data.reason);
			assert.deepStrictEqual(rejected.data, refusal.data);
			return true;
		});
		assert.deepStrictEqual(requests.map(({ method, params }) => [method, params]), [
			['hello', { protocol: [3, 3], kind: 'ide', build, capabilities: ['attach'] }],
			['hello', { protocol: [2, 3], kind: 'terminal', build }],
			['call', { op: 'daemon.upgrade', args: { program, build, daemon_protocol: [2, 3], keeper_protocol: [1, 1] } }],
			...(needsList ? [['call', { op: 'agent.list', args: { machine: selector } }]] : []),
		]);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

suite('Core connection (ARCHITECTURE-1.4)', () => {
	test('uses the exact daemon socket name and preserves takeover refusal diagnostics', async () => {
		const home = 'D:\\Facade home\\\u4f60\u597d';
		if (process.platform === 'win32') {
			assert.strictEqual(daemonSocketPath(home), '\\\\.\\pipe\\facade-core-daemon-3023af2dc8');
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade.exe');
		} else {
			assert.strictEqual(daemonSocketPath(home), path.join('/tmp', `facade-core-${process.getuid?.() ?? os.userInfo().uid}`, 'daemon-3023af2dc8.sock'));
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade');
		}
		const keeper = { code: -32000, message: 'the running keeper speaks 1 to 1', data: { reason: 'protocol_incompatible' } } as const;
		await refusedUpgrade(keeper);
		await refusedUpgrade(keeper, true);
		await refusedUpgrade({ code: -32000, message: 'builds of one version do not take over from each other', data: { reason: 'refused' } });
	});
});
