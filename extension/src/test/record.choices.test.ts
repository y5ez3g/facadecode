/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ChoiceStore } from '../record/choices';
import { tempDir } from './util';

suite('Contract: earlier model and effort choices (MCP-2.1, CLIS-1.4)', () => {

	let temp: ReturnType<typeof tempDir>;
	setup(() => temp = tempDir('facade-code-choices-'));
	teardown(() => temp.remove());

	test('kept per CLI and environment, most recent first without repeats, and read by every window', () => {
		const one = new ChoiceStore(temp.dir);
		one.remember('local', 'claude', { model: 'sonnet' });
		one.remember('local', 'claude', { model: 'opus', effort: 'high' });
		one.remember('local', 'claude', { model: 'sonnet' });
		one.remember('ssh-remote+box', 'claude', { model: 'haiku' });
		one.remember('local', 'codex', { effort: 'low' });
		const another = new ChoiceStore(temp.dir);
		assert.deepStrictEqual(another.list('local', 'claude'), { model: ['sonnet', 'opus'], effort: ['high'] });
		assert.deepStrictEqual(another.list('ssh-remote+box', 'claude'), { model: ['haiku'], effort: [] });
		assert.deepStrictEqual(another.list('local', 'codex'), { model: [], effort: ['low'] });
		assert.deepStrictEqual(another.list('local', 'qwen'), { model: [], effort: [] });
	});

	test('a start without explicit choices writes nothing, and the list stays small', () => {
		const store = new ChoiceStore(temp.dir);
		store.remember('local', 'claude', {});
		assert.ok(!fs.existsSync(path.join(temp.dir, 'start-choices.json')));
		for (let i = 0; i < 30; i++) {
			store.remember('local', 'claude', { model: `m${i}` });
		}
		const { model } = store.list('local', 'claude');
		assert.strictEqual(model.length, 20);
		assert.deepStrictEqual([model[0], model[19]], ['m29', 'm10']);
	});

	test('an unreadable file is an empty list, and the next start writes a good one', () => {
		fs.writeFileSync(path.join(temp.dir, 'start-choices.json'), '{not json');
		const store = new ChoiceStore(temp.dir);
		assert.deepStrictEqual(store.list('local', 'claude'), { model: [], effort: [] });
		store.remember('local', 'claude', { effort: 'max' });
		assert.deepStrictEqual(store.list('local', 'claude'), { model: [], effort: ['max'] });
	});
});
