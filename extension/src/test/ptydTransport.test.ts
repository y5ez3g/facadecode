/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as net from 'net';
import { PtydClient, PtydLost, PtydNotSent, ptydSocketPath } from '../host/execution/ptydClient';
import { isPtydEvent, lineReader, PTYD_PROTOCOL, type Request, type RunEvent } from '../ptyd/protocol';
import { FakeClock } from './clock';
import { tempDir } from './util';
import { withModules } from './withModules';

suite('ptyd transport boundaries', () => {
	test('an attempted write that fails remains uncertain even when the peer received its complete request', async () => {
		const temp = tempDir('fc-write-result-');
		const socketPath = ptydSocketPath(temp.dir);
		let peer: net.Socket | undefined;
		let received!: (request: Request) => void;
		const didReceive = new Promise<Request>(resolve => received = resolve);
		const server = net.createServer(socket => {
			peer = socket;
			socket.on('data', lineReader(line => {
				const request = JSON.parse(line) as Request;
				if (request.method === 'hello') {
					socket.write(`${JSON.stringify({ id: request.id, result: { protocol: PTYD_PROTOCOL, pid: 1 } })}\n`);
				} else {
					received(request);
				}
			}));
		});
		await new Promise<void>(resolve => server.listen(socketPath, resolve));
		let client: PtydClient | undefined;
		try {
			client = await PtydClient.connect(socketPath, '/must-not-start', '/unused');
			const socket = (client as unknown as { socket: net.Socket }).socket;
			const write = socket.write.bind(socket);
			socket.write = ((line: string, callback: (error?: Error | null) => void) =>
				write(line, () => callback(new Error('lost write acknowledgement')))) as typeof socket.write;
			await assert.rejects(client.request('input', { run: 'original', data: '雪🙂' }),
				(err: unknown) => err instanceof PtydLost && /lost write acknowledgement/.test(err.message));
			const request = await didReceive;
			assert.deepStrictEqual([request.method, request.params], ['input', { run: 'original', data: '雪🙂' }]);
			client.dispose();
			await assert.rejects(client.request('input', { run: 'original', data: 'never sent' }), PtydNotSent);
		} finally {
			client?.dispose();
			peer?.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});

	test('malformed event objects never reach terminal listeners', async () => {
		const temp = tempDir('fc-transport-');
		const socketPath = ptydSocketPath(temp.dir);
		let peer: net.Socket | undefined;
		const server = net.createServer(socket => {
			peer = socket;
			socket.setEncoding('utf8');
			socket.on('data', lineReader(line => {
				const request = JSON.parse(line) as Request;
				socket.write(`${JSON.stringify({ id: request.id, result: request.method === 'hello' ? { protocol: PTYD_PROTOCOL, pid: 1 } : [] })}\n`);
			}));
		});
		await new Promise<void>(resolve => server.listen(socketPath, resolve));
		let client: PtydClient | undefined;
		try {
			client = await PtydClient.connect(socketPath, '/must-not-start', '/unused');
			const events: RunEvent[] = [];
			client.onRunEvent('r', event => events.push(event));
			const invalid = [null, 1, [], { event: 'unknown', run: 'r' }, { event: 'output', run: 'r', seq: 1, data: null }, { event: 'exit', run: 'r' }, { event: 'status', run: 'r', status: {} }];
			peer!.write(invalid.map(value => JSON.stringify(value)).join('\n') + '\n');
			peer!.write(`${JSON.stringify({ event: 'output', run: 'r', seq: 1, data: 'valid' })}\n`);
			await client.request('list', { owner: 'unused' });
			assert.deepStrictEqual([invalid.map(isPtydEvent), events], [invalid.map(() => false), [{ event: 'output', run: 'r', seq: 1, data: 'valid' }]]);
		} finally {
			client?.dispose();
			peer?.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});

	test('a rejected hello closes its socket instead of leaving an unreachable connection alive', async () => {
		const temp = tempDir('fc-hello-');
		const socketPath = ptydSocketPath(temp.dir);
		let closed!: () => void;
		const didClose = new Promise<void>(resolve => closed = resolve);
		const server = net.createServer(socket => {
			socket.on('close', closed);
			socket.on('data', lineReader(line => socket.write(`${JSON.stringify({ id: (JSON.parse(line) as Request).id, error: 'rejected hello' })}\n`)));
		});
		await new Promise<void>(resolve => server.listen(socketPath, resolve));
		try {
			await assert.rejects(PtydClient.connect(socketPath, '/must-not-start', '/unused'), /rejected hello/);
			await didClose;
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});

	test('a peer that accepts hello without replying reaches the deadline and is disconnected', async () => {
		const temp = tempDir('fc-hello-time-');
		const socketPath = ptydSocketPath(temp.dir);
		let peer: net.Socket | undefined;
		let hello!: () => void;
		const didHello = new Promise<void>(resolve => hello = resolve);
		let closed!: () => void;
		const didClose = new Promise<void>(resolve => closed = resolve);
		const server = net.createServer(socket => {
			peer = socket;
			socket.on('close', closed);
			socket.on('data', hello);
		});
		await new Promise<void>(resolve => server.listen(socketPath, resolve));
		const clock = FakeClock.install();
		try {
			const failed = assert.rejects(PtydClient.connect(socketPath, '/must-not-start', '/unused'), /did not answer hello within 5000 ms/);
			await didHello;
			await clock.tick(4_999);
			assert.strictEqual(peer?.destroyed, false);
			await clock.tick(1);
			await failed;
			await didClose;
		} finally {
			clock.uninstall();
			peer?.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});

	test('an oversized reply disconnects the client and rejects pending requests with the framing failure', async () => {
		// A smaller reader limit exercises the real socket client's failure path without sending 64 MiB over a test socket.
		const { PtydClient: Client } = withModules({ '../../ptyd/protocol': {
			isPtydEvent, PTYD_PROTOCOL,
			lineReader: (onLine: (line: string) => void, onError: (err: Error) => void) => lineReader(onLine, onError, 128)
		} })<typeof import('../host/execution/ptydClient')>(require.resolve('../host/execution/ptydClient'));
		const temp = tempDir('fc-frame-');
		const socketPath = ptydSocketPath(temp.dir);
		let peer: net.Socket | undefined;
		let closed!: () => void;
		const didClose = new Promise<void>(resolve => closed = resolve);
		const server = net.createServer(socket => {
			peer = socket;
			socket.on('close', closed);
			socket.on('data', lineReader(line => {
				const request = JSON.parse(line) as Request;
				socket.write(request.method === 'hello'
					? `${JSON.stringify({ id: request.id, result: { protocol: PTYD_PROTOCOL, pid: 1 } })}\n`
					: 'x'.repeat(129));
			}));
		});
		await new Promise<void>(resolve => server.listen(socketPath, resolve));
		let client: PtydClient | undefined;
		try {
			client = await Client.connect(socketPath, '/must-not-start', '/unused');
			await assert.rejects(client.request('list', { owner: 'unused' }), /frame exceeds 128 bytes/);
			await didClose;
			await assert.rejects(client.request('list', { owner: 'unused' }), /not connected/);
		} finally {
			client?.dispose();
			peer?.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});
});
