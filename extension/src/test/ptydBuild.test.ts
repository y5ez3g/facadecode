/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { forgetPtyd, ptydBuild, ptydRecords, recordedPtyds, recordPtyd } from '../base/ptydRegistry';
import { ownPtydSocket, PtydClient, ptydSocketPath } from '../host/execution/ptydClient';
import { PTYD_PROTOCOL } from '../ptyd/protocol';
import { installationGone } from '../ptyd/run';
import { PtydServer } from '../ptyd/server';

suite('Each installation runs its own ptyd (ARCHITECTURE-2.4)', () => {
	let temp: string;
	setup(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-build-')); });
	teardown(() => fs.rmSync(temp, { recursive: true, force: true }));

	test('a build is its installation: another path, version or rewritten script is another build, the same one in every window', () => {
		const first = path.join(temp, 'facade.facadecode-0.0.4', 'dist', 'ptyd.js');
		const second = path.join(temp, 'facade.facadecode-0.0.5', 'dist', 'ptyd.js');
		for (const script of [first, second]) {
			fs.mkdirSync(path.dirname(script), { recursive: true });
			fs.writeFileSync(script, '// ptyd');
		}
		assert.strictEqual(ptydBuild(first, '0.0.4'), ptydBuild(first, '0.0.4'));
		assert.notStrictEqual(ptydBuild(first, '0.0.4'), ptydBuild(second, '0.0.4'));
		assert.notStrictEqual(ptydBuild(first, '0.0.4'), ptydBuild(first, '0.0.5'));
		const before = ptydBuild(first, '0.0.4');
		fs.utimesSync(first, new Date(), new Date(Date.now() + 60_000));
		assert.notStrictEqual(ptydBuild(first, '0.0.4'), before, 'a script rebuilt in place');
		assert.match(ptydBuild(first, '0.0.4'), /^[0-9a-f]{10}$/);
		// Each build's ptyd listens on a name of its own; the name builds used before keeps no build
		const home = path.join(temp, 'home');
		assert.notStrictEqual(ownPtydSocket(home, first, '0.0.4'), ownPtydSocket(home, second, '0.0.4'));
		assert.ok(ownPtydSocket(home, first, '0.0.4').includes(`-${PTYD_PROTOCOL}-${ptydBuild(first, '0.0.4')}-`));
		assert.ok(!ptydSocketPath(home).includes(ptydBuild(first, '0.0.4')));
	});

	test('records: written whole, listed while readable, taken out only by the process that wrote them', () => {
		const folder = ptydRecords(temp);
		assert.deepStrictEqual(recordedPtyds(folder), [], 'no folder yet');
		recordPtyd(folder, { protocol: 14, build: 'abcdef0123', socket: '/tmp/a.sock', pid: 10 });
		recordPtyd(folder, { protocol: 14, build: '0123abcdef', socket: '/tmp/b.sock', pid: 11 });
		fs.writeFileSync(path.join(folder, 'broken.json'), '{');
		fs.writeFileSync(path.join(folder, 'other.json'), JSON.stringify({ protocol: 14, build: 'NOT HEX', socket: '/tmp/c.sock', pid: 12 }));
		assert.deepStrictEqual(recordedPtyds(folder).map(record => record.socket).sort(), ['/tmp/a.sock', '/tmp/b.sock']);
		forgetPtyd(folder, '/tmp/a.sock', 99);
		assert.strictEqual(recordedPtyds(folder).length, 2, 'another process\'s record stays');
		forgetPtyd(folder, '/tmp/a.sock', 10);
		forgetPtyd(folder, '/tmp/b.sock');
		assert.deepStrictEqual(recordedPtyds(folder), []);
		assert.deepStrictEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), [], 'no partial file left');
	});

	test('ptyd says its build in hello, and a window refuses another build\'s ptyd at its own name', async () => {
		const socket = ptydSocketPath(path.join(temp, 'home'), PTYD_PROTOCOL, 'abcdef0123');
		const server = new PtydServer(socket, () => undefined);
		server.build = '0123abcdef';
		assert.strictEqual(await server.listen(), true);
		try {
			const joined = (await PtydClient.join(socket, PTYD_PROTOCOL))!;
			assert.deepStrictEqual([joined.speaks, joined.build], [PTYD_PROTOCOL, '0123abcdef']);
			joined.dispose();
			await assert.rejects(PtydClient.connect(socket, '/unused/ptyd.js', path.join(temp, 'ptyd.log'), { build: 'abcdef0123', start: false }), /runs build 0123abcdef, not this window's abcdef0123/);
			server.build = undefined;
			await assert.rejects(PtydClient.connect(socket, '/unused/ptyd.js', path.join(temp, 'ptyd.log'), { build: 'abcdef0123', start: false }), /runs build unnamed/);
			const own = await PtydClient.connect(socket, '/unused/ptyd.js', path.join(temp, 'ptyd.log'), { start: false });
			own.dispose();
		} finally {
			server.close();
		}
	});

	test('a ptyd whose installation was removed says what is gone: its script, or on Windows node-pty\'s console worker', () => {
		const script = path.join(temp, 'ptyd.js');
		assert.strictEqual(installationGone(script, 'darwin', () => false), script);
		assert.strictEqual(installationGone(script, 'darwin', () => true), undefined);
		const missing = installationGone(script, 'win32', file => file === script);
		assert.ok(missing?.endsWith(path.join('worker', 'conoutSocketWorker.js')), missing);
		assert.strictEqual(installationGone(script, 'win32', () => true), undefined);
	});
});
