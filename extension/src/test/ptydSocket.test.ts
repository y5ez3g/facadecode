/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PtydClient, ptydSocketPath } from '../host/execution/ptydClient';
import { probe, PtydServer } from '../ptyd/server';
import { PTYD_PROTOCOL } from '../ptyd/protocol';
import { ensurePtydSocket } from '../ptyd/socket';
import { ptydPlace } from './ptydPlace';
import { replaceFsFunction, tempDir } from './util';
import { withModules } from './withModules';

// Unix sockets alone: Windows listens on named pipes, which have no folder or file mode to own
(process.platform === 'win32' ? suite.skip : suite)('ptyd socket ownership', function () {
	test('the fallback is always short and private, independent of a shared tmpdir, and a pre-existing nonprivate folder is refused', () => {
		const socket = ptydSocketPath('/unused/isolated-review-home');
		const dir = path.dirname(socket);
		const stat = fs.lstatSync(dir);
		assert.strictEqual(dir, path.join('/tmp', `facade-ptyd-${os.userInfo().uid}`));
		assert.match(path.basename(socket), new RegExp(`^extension-ptyd-${PTYD_PROTOCOL}-[0-9a-f]{12}\\.sock$`));
		assert.ok(Buffer.byteLength(socket) < 103);
		assert.strictEqual(stat.uid, os.userInfo().uid);
		assert.strictEqual(stat.mode & 0o077, 0);
		// Model a squatter's existing directory without changing the real user's shared folder.
		const restore = replaceFsFunction('lstatSync', original => ((file, options) => {
			const found = original(file, options);
			if (found && String(file) === dir) {
				Object.defineProperty(found, 'mode', { value: Number(found.mode) | 0o055 });
			}
			return found;
		}) as typeof fs.lstatSync);
		try {
			assert.throws(() => ptydSocketPath('/unused/isolated-review-home'), /private directory owned by this user/);
		} finally {
			restore();
		}
	});

	test('public or symlinked parents and non-socket files are refused before a client connects or a server removes anything', async () => {
		const temp = tempDir('fd-socket-');
		try {
			const publicDir = path.join(temp.dir, 'public');
			fs.mkdirSync(publicDir, { mode: 0o755 });
			fs.chmodSync(publicDir, 0o755);
			const alias = path.join(temp.dir, 'alias');
			fs.symlinkSync(publicDir, alias);
			for (const dir of [publicDir, alias]) {
				const socket = path.join(dir, 'ptyd.sock');
				await assert.rejects(PtydClient.connect(socket, '/must-not-spawn', path.join(temp.dir, 'unused.log')), /private directory owned by this user/);
				await assert.rejects(new PtydServer(socket).listen(), /private directory owned by this user/);
			}
			const file = path.join(temp.dir, 'ptyd.sock');
			fs.writeFileSync(file, 'keep this file');
			await assert.rejects(PtydClient.connect(file, '/must-not-spawn', path.join(temp.dir, 'unused.log')), /socket owned by this user/);
			await assert.rejects(new PtydServer(file).listen(), /socket owned by this user/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), 'keep this file');
			fs.symlinkSync(file, path.join(temp.dir, 'link.sock'));
			assert.throws(() => ensurePtydSocket(path.join(temp.dir, 'link.sock')), /socket owned by this user/);
		} finally {
			temp.remove();
		}
	});

	test('a foreign-owned socket or parent is refused before any connection or handshake reaches its listener', async () => {
		const temp = tempDir('fd-socket-');
		const socket = path.join(temp.dir, 'ptyd.sock');
		let connections = 0;
		const listener = net.createServer(client => { connections++; client.destroy(); });
		await new Promise<void>(resolve => listener.listen(socket, resolve));
		try {
			for (const foreign of [temp.dir, socket]) {
				const restore = replaceFsFunction('lstatSync', original => ((file, options) => {
					const found = original(file, options);
					if (found && String(file) === foreign) {
						Object.defineProperty(found, 'uid', { value: Number(found.uid) + 1 });
					}
					return found;
				}) as typeof fs.lstatSync);
				try {
					await assert.rejects(PtydClient.connect(socket, '/must-not-spawn', path.join(temp.dir, 'unused.log')), /owned by this user/);
					await assert.rejects(new PtydServer(socket).listen(), /owned by this user/);
				} finally {
					restore();
				}
			}
			assert.strictEqual(connections, 0);
		} finally {
			await new Promise<void>(resolve => listener.close(() => resolve()));
			temp.remove();
		}
	});
});

suite('ptyd liveness: only a connection proves a ptyd there, only a refusal or nothing at all proves none', () => {

	/** Where a ptyd at `socket` keeps its startup lock, as it names it. */
	const lockOf = (socket: string) => process.platform === 'win32' ? path.join(os.tmpdir(), `${path.basename(socket)}.lock`) : `${socket}.lock`;

	/** A ptyd whose probe of its socket meets `found`: a connection that never comes or ends, or an error with that code. */
	function probing(found: 'silence' | string) {
		const fakeNet = {
			...net,
			connect: () => {
				const socket = new EventEmitter() as EventEmitter & { destroy(): void };
				socket.destroy = () => undefined;
				if (found !== 'silence') {
					setTimeout(() => socket.emit('error', Object.assign(new Error(found), { code: found })), 5);
				}
				return socket;
			}
		};
		return withModules({ net: fakeNet })<typeof import('../ptyd/server')>(require.resolve('../ptyd/server'));
	}

	test('a ptyd too busy to answer at once, or one whose socket fails otherwise, is no ptyd gone: a new one gives way and takes no lock', async function () {
		this.timeout(10_000);
		for (const found of ['silence', 'EACCES', 'EPERM', 'EAGAIN']) {
			const place = ptydPlace('fc-busy-');
			try {
				const { PtydServer: Server, probe } = probing(found);
				assert.strictEqual(await probe(place.socket, 200), 'unknown', found);
				const starting = new Server(place.socket);
				assert.strictEqual(await starting.listen(), false, found);
				assert.strictEqual(fs.existsSync(lockOf(place.socket)), false, found);
				starting.close();
			} finally {
				fs.rmSync(place.dir, { recursive: true, force: true });
			}
		}
	});

	test('a socket refused or absent is a ptyd that died, taken over; one that takes the connection is alive, and kept', async () => {
		for (const found of ['ECONNREFUSED', 'ENOENT']) {
			const place = ptydPlace('fc-gone-');
			const { PtydServer: Server, probe } = probing(found);
			const taking = new Server(place.socket);
			try {
				assert.strictEqual(await probe(place.socket), 'gone', found);
				assert.strictEqual(await taking.listen(), true, found);
			} finally {
				taking.close();
				fs.rmSync(place.dir, { recursive: true, force: true });
			}
		}
		const place = ptydPlace('fc-alive-');
		const live = new PtydServer(place.socket);
		try {
			assert.strictEqual(await live.listen(), true);
			assert.deepStrictEqual([await probe(place.socket), await new PtydServer(place.socket).listen()], ['alive', false]);
		} finally {
			live.close();
			fs.rmSync(place.dir, { recursive: true, force: true });
		}
	});

	// Unix sockets alone: a closing server removes the file at its path, which a named pipe has none of
	(process.platform === 'win32' ? test.skip : test)('a ptyd whose socket another took over for gone never removes that one\'s socket as it closes', async () => {
		const place = ptydPlace('fc-successor-');
		const displaced = new PtydServer(place.socket);
		const successor = net.createServer(socket => socket.end());
		try {
			assert.strictEqual(await displaced.listen(), true);
			// Its socket taken for gone and replaced, as a starting ptyd replaces one refused or absent
			fs.rmSync(place.socket);
			await new Promise<void>(resolve => successor.listen(place.socket, resolve));
			displaced.close();
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.deepStrictEqual([fs.existsSync(place.socket), await probe(place.socket)], [true, 'alive']);
			// Its own socket it removes as ever
			const own = ptydPlace('fc-own-');
			const alone = new PtydServer(own.socket);
			assert.strictEqual(await alone.listen(), true);
			alone.close();
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.strictEqual(fs.existsSync(own.socket), false);
			fs.rmSync(own.dir, { recursive: true, force: true });
		} finally {
			await new Promise<void>(resolve => successor.close(() => resolve()));
			fs.rmSync(place.dir, { recursive: true, force: true });
		}
	});
});
