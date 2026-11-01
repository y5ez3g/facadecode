/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { once } from 'events';
import { endEditors } from './integration/editors';

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
