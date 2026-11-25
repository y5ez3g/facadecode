/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeEnvironment } from './integration/probeState';
import { tempDir } from './util';

suite('Real CLI probes keep the owner\'s configuration isolated', () => {
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
