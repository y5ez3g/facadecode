/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { connectWithin, type Reached } from '../base/connect';
import { lineReader } from '../base/lines';
import { EarlierPtyds, ptydSocketPath, PtydNotSent, reachOrStart } from '../host/execution/ptydClient';
import { EARLIER_PROTOCOLS } from '../ptyd/protocol';

suite('Reaching this window\'s own ptyd: only one that is not there is started (ARCHITECTURE-2.3)', () => {
	const busy: Reached = { absent: false, reason: 'it took no connection within 2 seconds' };
	const absent: Reached = { absent: true, reason: 'connect ENOENT' };
	const socketPath = path.join(os.tmpdir(), 'unused-ptyd.sock');

	test('a ptyd that is there but busy - a slow Windows pipe - is waited for, and no second one is started', async () => {
		let starts = 0;
		let tries = 0;
		const failure = await reachOrStart(socketPath, () => { starts++; }, '', async () => { tries++; return busy; }, 300).then(() => assert.fail('reached'), (err: unknown) => err);
		assert.ok(failure instanceof PtydNotSent, String(failure));
		assert.match(failure.message, /took no connection.*no other was started/);
		assert.strictEqual(starts, 0, 'a busy ptyd is never replaced');
		assert.ok(tries > 1, 'it is tried again while there is time');
	});

	test('none there is started once and waited for; one busy at first is reached once it takes the connection, nothing started', async () => {
		const socket = {} as net.Socket;
		let starts = 0;
		const answers: Reached[] = [absent, absent, absent, { socket }];
		assert.strictEqual(await reachOrStart(socketPath, () => { starts++; }, '', async () => answers.shift()!, 5_000), socket);
		assert.strictEqual(starts, 1);
		const later: Reached[] = [busy, busy, { socket }];
		assert.strictEqual(await reachOrStart(socketPath, () => { starts++; }, '', async () => later.shift()!, 5_000), socket);
		assert.strictEqual(starts, 1);
		await assert.rejects(reachOrStart(socketPath, () => { starts++; }, 'See its log.', async () => absent, 300), /ptyd did not start: nothing listens .* See its log\./);
		assert.strictEqual(starts, 2);
	});

	test('a connection finds a listener, or says nothing is there - never taking a missing listener for a busy one', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-connect-'));
		const socketFile = ptydSocketPath(directory);
		const server = net.createServer(socket => socket.end());
		try {
			const missing = await connectWithin(socketFile, 2_000);
			assert.deepStrictEqual([missing.socket, !missing.socket && missing.absent], [undefined, true]);
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketFile, resolve); });
			const reached = await connectWithin(socketFile, 2_000);
			assert.ok(reached.socket);
			reached.socket.destroy();
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			if (process.platform !== 'win32') { fs.rmSync(socketFile, { force: true }); }
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

suite('Earlier supervisor connections across asynchronous boundaries', () => {
	test('a close started while an idle check awaits its list keeps the connection until cleanup finishes', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-earlier-'));
		const protocol = EARLIER_PROTOCOLS[0];
		const socketPath = ptydSocketPath(directory, protocol);
		const sockets = new Set<net.Socket>();
		let deferList = false;
		let busy = false;
		let answer!: () => void;
		let listed!: () => void;
		const waiting = new Promise<void>(resolve => listed = resolve);
		const server = net.createServer(socket => {
			sockets.add(socket);
			socket.setEncoding('utf8');
			socket.on('error', () => socket.destroy());
			socket.on('data', lineReader(line => {
				const request = JSON.parse(line) as { id: number; method: string };
				const reply = (result: unknown) => socket.write(JSON.stringify({ id: request.id, result }) + '\n');
				if (request.method === 'hello') {
					reply({ protocol });
				} else if (request.method === 'list' && deferList) {
					answer = () => reply([]);
					listed();
				} else {
					reply(request.method === 'list' ? [{ run: 'earlier-run' }] : undefined);
				}
			}, error => socket.destroy(error)));
		});
		const held = new EarlierPtyds(directory, { owner: 'window', generation: 1, token: 'claim' }, {
			log: () => undefined, lost: () => undefined, ownerLost: () => undefined, busy: () => busy
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, resolve);
			});
			await held.find();
			assert.strictEqual(held.clients.length, 1);
			deferList = true;
			const checking = held.check();
			await waiting;
			busy = true;
			answer();
			await checking;
			assert.strictEqual(held.clients.length, 1, 'an older empty list must not disconnect cleanup started since');
			busy = false;
			const finished = held.check();
			// The second request gets its own answer, rather than reusing the first request's responder.
			await new Promise<void>(resolve => { listed = () => { answer(); resolve(); }; });
			await finished;
			assert.strictEqual(held.clients.length, 0, 'release the idle supervisor after cleanup finishes');
		} finally {
			held.dispose();
			for (const socket of sockets) { socket.destroy(); }
			await new Promise<void>(resolve => server.close(() => resolve()));
			if (process.platform !== 'win32') { fs.rmSync(socketPath, { force: true }); }
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
