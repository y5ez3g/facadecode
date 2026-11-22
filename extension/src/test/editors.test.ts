/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { endEditors, localFolderIdentity } from './integration/editors';
import { tempDir } from './util';
import { withModules } from './withModules';

suite('Isolated editor process cleanup', () => {
	test('ends both the retained application and its second launcher, including a process ignoring TERM, without touching another process', async function () {
		this.timeout(10_000);
		const start = (ignoreTerm: boolean) => spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
		const original = start(true), reopened = start(false), unrelated = start(false);
		const all = [original, reopened, unrelated];
		try {
			await Promise.all(all.map(child => once(child.stdout!, 'data')));
			await endEditors([original, reopened]);
			for (const child of [original, reopened]) {
				assert.ok(child.exitCode !== null || child.signalCode !== null, 'every launched process must be reaped');
				assert.ok(child.stdout!.destroyed && child.stderr!.destroyed, 'captured pipes must not retain the runner');
			}
			assert.strictEqual(unrelated.exitCode, null);
			assert.strictEqual(unrelated.signalCode, null);
			assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
		} finally {
			await endEditors(all);
		}
	});

	test('accepts a launcher that has already exited after forwarding to its application', async () => {
		const launcher = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
		await once(launcher, 'exit');
		await endEditors([launcher]);
		assert.strictEqual(launcher.exitCode, 0);
		assert.ok(launcher.stdout!.destroyed && launcher.stderr!.destroyed);
	});
});

suite('Exact peer workspace folder identity', () => {
	test('compares absolute directories and refuses a same-name sibling, a file, and missing or relative paths', () => {
		const root = tempDir('fd-peer-path-');
		try {
			const target = path.join(root.dir, 'one', 'peer');
			const sibling = path.join(root.dir, 'two', 'peer');
			fs.mkdirSync(target, { recursive: true });
			fs.mkdirSync(sibling, { recursive: true });
			const file = path.join(target, 'file');
			fs.writeFileSync(file, '');
			const identity = localFolderIdentity(target);
			assert.ok(identity);
			assert.strictEqual(localFolderIdentity(path.join(target, '.')), identity);
			assert.notStrictEqual(localFolderIdentity(sibling), identity);
			for (const rejected of [file, path.join(target, 'missing'), 'peer', undefined]) {
				assert.strictEqual(localFolderIdentity(rejected), undefined);
			}
		} finally {
			root.remove();
		}
	});

	test('accepts Windows URI and process drive spellings while keeping the complete native path', () => {
		const files = new Set([String.raw`D:\scratch\peer`, String.raw`d:\scratch\peer`, String.raw`D:\other\peer`]);
		const { localFolderIdentity: identity } = withModules({
			path: path.win32,
			fs: {
				realpathSync: { native: (file: string) => {
					if (!files.has(file)) { throw new Error('No such directory'); }
					return file;
				} },
				statSync: () => ({ isDirectory: () => true })
			}
		}, { process: { platform: 'win32' } })<typeof import('./integration/editors')>(require.resolve('./integration/editors'));
		assert.strictEqual(identity(String.raw`D:\scratch\peer`), String.raw`d:\scratch\peer`);
		assert.strictEqual(identity(String.raw`d:\scratch\peer`), String.raw`d:\scratch\peer`);
		assert.notStrictEqual(identity(String.raw`D:\other\peer`), identity(String.raw`D:\scratch\peer`));
		assert.strictEqual(identity(String.raw`D:peer`), undefined);
	});
});
