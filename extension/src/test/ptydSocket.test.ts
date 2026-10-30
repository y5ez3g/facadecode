/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PtydClient, ptydSocketPath } from '../host/execution/ptydClient';
import { PtydServer } from '../ptyd/server';
import { PTYD_PROTOCOL } from '../ptyd/protocol';
import { ensurePtydSocket } from '../ptyd/socket';
import { replaceFsFunction, tempDir } from './util';

suite('ptyd socket ownership', function () {
	if (process.platform === 'win32') {
		return;
	}

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
