/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeEnvironment } from './integration/probeState';
import { tempDir } from './util';

suite('Real CLI probes keep the owner\'s configuration isolated', () => {
	test('the capture command refuses a personal home or configuration before invoking its CLI', () => {
		const script = path.resolve(__dirname, '../../../scripts/capture-inputs.mjs');
		for (const options of [
			{ args: ['--home', os.homedir()], overrides: '{}' },
			{ args: [], overrides: JSON.stringify({ CODEX_HOME: path.join(os.homedir(), '.codex') }) }
		]) {
			const result = spawnSync(process.execPath, [script, 'codex', '--path', path.join(os.tmpdir(), 'not-an-installed-cli'), ...options.args], {
				encoding: 'utf8', timeout: 5000, env: { ...process.env, FACADE_CAPTURE_ENV: options.overrides }
			});
			assert.strictEqual(result.status, 1, result.stderr);
			assert.match(result.stderr, /must name isolated state/);
			assert.doesNotMatch(result.stderr, /posix_spawn|CreateProcess/);
		}
	});

	test('the old home escape and host profile overrides fail before starting any editor', () => {
		assert.throws(() => probeEnvironment({}, true), /isolated temporary CLI home/);
		for (const name of ['HOME', 'USERPROFILE', 'FACADE_HOME', 'VSCODE_IPC_HOOK']) {
			assert.throws(() => probeEnvironment({ [name]: os.homedir() }, false), /cannot override/);
		}
		assert.throws(() => probeEnvironment({ CODEX_HOME: path.join(os.homedir(), '.codex') }, false), /isolated state/);
		assert.throws(() => probeEnvironment({}, false, path.join(os.homedir(), '.claude')), /isolated state/);
	});

	test('temporary state and credentials pass without being copied to disk; malformed values fail', () => {
		const temp = tempDir('facade-probe-state-');
		try {
			const env = { CODEX_HOME: path.join(temp.dir, 'codex'), OPENAI_API_KEY: 'test-only-value' };
			assert.deepStrictEqual(probeEnvironment(env, false), env);
			assert.deepStrictEqual(fs.readdirSync(temp.dir), []);
			for (const invalid of [null, [], { CODEX_HOME: 1 }]) {
				assert.throws(() => probeEnvironment(invalid, false), /object of string values/);
			}
		} finally {
			temp.remove();
		}
	});
});
