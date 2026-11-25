/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { lineReader } from '../base/lines';
import { PtydClient, PTYD_PROTOCOL, ptydSocketPath } from '../host/migration/supervisor';
import { tempDir } from './util';

suite('Legacy supervisor transport (ARCHITECTURE-1.4)', () => {
	test('retirement uses the five released requests and reports loss of custody', async () => {
		const temp = tempDir('fd-old-supervisor-');
		const socket = process.platform === 'win32' ? ptydSocketPath(temp.dir, PTYD_PROTOCOL) : path.join(temp.dir, 'old.sock');
		fs.chmodSync(temp.dir, 0o700);
		const messages: { readonly method: string; readonly params: unknown }[] = [];
		const claim = { owner: '0123456789abcdef', generation: 1, token: 'retired' };
		const run = { run: 'old-a', pid: 0, owner: claim.owner, cwd: temp.dir, startedAt: 0, claimedElsewhere: false, meta: {} };
		const results: Record<string, unknown> = {
			hello: { protocol: PTYD_PROTOCOL, pid: process.pid, build: 'abcd' },
			list: [run], conversations: [{ cli: 'claude', sessionId: 'saved', environment: 'local' }],
			claim: null, terminate: 'terminated'
		};
		const server = net.createServer(connection => {
			connection.setEncoding('utf8');
			connection.on('data', lineReader(line => {
				const { id, method, params } = JSON.parse(line);
				messages.push({ method, params });
				connection.write(JSON.stringify({ id, result: results[method] }) + '\n');
				if (method === 'terminate') {
					connection.write(JSON.stringify({ event: 'ownerLost', owner: claim.owner }) + '\n');
				}
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
			const lost = new Promise<string>(resolve => client!.onDidLoseOwner(resolve));
			assert.deepStrictEqual(await client.request('list', {}), [run]);
			assert.deepStrictEqual(await client.request('conversations', {}), results.conversations);
			await client.request('claim', claim);
			assert.strictEqual(await client.request('terminate', { run: run.run, graceMs: 2_000 }), 'terminated');
			assert.strictEqual(await lost, claim.owner);
			assert.deepStrictEqual(messages, [
				{ method: 'hello', params: { protocol: PTYD_PROTOCOL } }, { method: 'list', params: {} },
				{ method: 'conversations', params: {} }, { method: 'claim', params: claim },
				{ method: 'terminate', params: { run: run.run, graceMs: 2_000 } }
			]);
		} finally {
			client?.dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
			temp.remove();
		}
	});
});
