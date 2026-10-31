/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EarlierPtyds, ptydSocketPath } from '../host/execution/ptydClient';
import { EARLIER_PROTOCOLS, lineReader } from '../ptyd/protocol';

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
