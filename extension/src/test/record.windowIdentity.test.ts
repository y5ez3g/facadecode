/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isWindowIdentity, isWindowToken } from '../base/windowIdentity';
import { beginWindowTerminals, retireWindowTerminals, windowToken } from '../record/windowIdentity';
import { keepWindowKey, workspaceRecord } from '../record/workspace';
import { tempDir } from './util';

suite('Record: local window handover identity', () => {
	let temp: ReturnType<typeof tempDir>;
	setup(() => { temp = tempDir('fc-window-'); });
	teardown(() => temp.remove());

	test('the continuing window retains its key across different editor sessions; a separate copied workspace does not', () => {
		const first = path.join(temp.dir, 'first-window');
		const second = path.join(temp.dir, 'second-window');
		const token = windowToken(first);
		assert.ok(isWindowToken(token));
		const owner = workspaceRecord('file:///work/repo', temp.dir).key;
		keepWindowKey(token, owner, ['file:///work/repo'], temp.dir);
		const later = { version: 1, token: windowToken(first), session: 'after-save-as' };
		assert.ok(isWindowIdentity(later, 'after-save-as'));
		assert.strictEqual(isWindowIdentity(later, 'before-save-as'), false);
		const folders = ['file:///work/repo', 'file:///work/other'];
		assert.strictEqual(workspaceRecord('file:///work/saved.code-workspace', temp.dir, undefined, { token: later.token, folders }).handedOver, owner);
		assert.notStrictEqual(windowToken(second), token);
		assert.strictEqual(workspaceRecord('file:///work/copied.code-workspace', temp.dir, undefined, { token: windowToken(second), folders }).handedOver, undefined);
	});

	test('a corrupt existing window record fails without inventing a different owner identity', () => {
		const file = path.join(temp.dir, 'handover.json');
		for (const value of ['{', '{}', '{"version":2,"token":"bad"}']) {
			fs.writeFileSync(file, value);
			assert.throws(() => windowToken(temp.dir));
			assert.strictEqual(fs.readFileSync(file, 'utf8'), value);
		}
	});

	test('missing, malformed and stale-session command replies cannot authorize handover', () => {
		const token = windowToken(temp.dir);
		// The component's version, where it names it (D110)
		assert.ok(isWindowIdentity({ version: 1, token, session: 'now', component: '0.2.0' }, 'now'));
		assert.ok(!isWindowIdentity({ version: 1, token, session: 'now', component: '' }, 'now'));
		assert.ok(!isWindowIdentity({ version: 1, token, session: 'now', component: 2 }, 'now'));
		for (const reply of [undefined, null, [], { version: 1, token }, { version: 2, token, session: 'now' },
			{ version: 1, token, session: 'old' }, { version: 1, token: '../other', session: 'now' }]) {
			assert.ok(!isWindowIdentity(reply, 'now'));
		}
	});

	test('a graceful terminal record is consumed once and a late older incarnation cannot write over its successor', () => {
		const first = beginWindowTerminals(temp.dir);
		const retired = [{ claim: { owner: 'workspace', generation: 1, token: 'one' }, runs: [{ run: 'run-a', title: '' }] }];
		retireWindowTerminals(temp.dir, first.epoch, retired);
		const second = beginWindowTerminals(temp.dir);
		assert.deepStrictEqual(second.retired, retired);
		retireWindowTerminals(temp.dir, first.epoch, retired);
		assert.deepStrictEqual(beginWindowTerminals(temp.dir).retired, []);
	});
});
