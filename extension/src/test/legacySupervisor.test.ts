/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { lineReader } from '../base/lines';
import { PtydClient, PTYD_PROTOCOL, ptydSocketPath, releasedPtydSockets } from '../host/migration/supervisor';
import { tempDir } from './util';

suite('Legacy supervisor transport (ARCHITECTURE-1.4)', () => {
	test('Windows enumerates a bound pipe with the released home and build suffixes', async function () {
		if (process.platform !== 'win32') { this.skip(); }
		const temp = tempDir('fd-old-pipe-');
		const namespace = '\\\\.\\pipe\\';
		const build = '0123456789';
		const homeHash = createHash('sha256').update(temp.dir).digest('hex').slice(0, 12);
		const name = `facade-extension-ptyd-17-${build}-${homeHash}`;
		const socket = `${namespace}${name}`;
		const server = net.createServer(connection => connection.destroy());
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socket, resolve);
			});
			assert.ok(fs.readdirSync(namespace).includes(name), `Windows did not enumerate the bound fixture ${name}`);
			assert.strictEqual(ptydSocketPath(temp.dir, PTYD_PROTOCOL, build), socket);
			assert.deepStrictEqual(releasedPtydSockets(temp.dir), [{ socket, build }]);
			assert.deepStrictEqual(releasedPtydSockets(path.join(temp.dir, 'other-home')), []);
		} finally {
			if (server.listening) { await new Promise<void>(resolve => server.close(() => resolve())); }
			temp.remove();
		}
	});

	test('observes the released supervisor with read-only requests', async () => {
		const temp = tempDir('fd-old-supervisor-');
		const socket = process.platform === 'win32' ? ptydSocketPath(temp.dir, PTYD_PROTOCOL) : path.join(temp.dir, 'old.sock');
		fs.chmodSync(temp.dir, 0o700);
		const messages: { readonly method: string; readonly params: unknown }[] = [];
		const run = { run: 'old-a', pid: 0, owner: '0123456789abcdef', cwd: temp.dir, startedAt: 0, claimedElsewhere: false, meta: {} };
		const results: Record<string, unknown> = {
			hello: { protocol: PTYD_PROTOCOL, pid: process.pid, build: 'abcd' },
			list: [run], conversations: [{ cli: 'claude', sessionId: 'saved', environment: 'local' }]
		};
		const server = net.createServer(connection => {
			connection.setEncoding('utf8');
			connection.on('data', lineReader(line => {
				const { id, method, params } = JSON.parse(line);
				messages.push({ method, params });
				connection.write(JSON.stringify({ id, result: results[method] }) + '\n');
			}, error => connection.destroy(error)));
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socket, resolve);
		});
		let client: PtydClient | undefined;
		try {
			client = await PtydClient.join(socket, PTYD_PROTOCOL);
			assert.ok(client);
			assert.deepStrictEqual([client.pid, client.build], [process.pid, 'abcd']);
			assert.deepStrictEqual(await client.request('list', {}), [run]);
			assert.deepStrictEqual(await client.request('conversations', {}), results.conversations);
			assert.deepStrictEqual(messages, [
				{ method: 'hello', params: { protocol: PTYD_PROTOCOL } }, { method: 'list', params: {} },
				{ method: 'conversations', params: {} }
			]);
		} finally {
			client?.dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});
});
