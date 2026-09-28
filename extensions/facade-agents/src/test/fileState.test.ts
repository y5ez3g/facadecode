/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JsonFileState } from '../common/kernel/fileState';
import { tempDir } from './util';

suite('JsonFileState', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-state-');
	});

	teardown(() => {
		temp.remove();
	});

	test('what one sets, the next one made on the same file reads; a value set to undefined is gone', async () => {
		const file = path.join(temp.dir, 'workspace', 'window-state.json');
		const first = new JsonFileState(file);
		const before = first.get('pipe', 'none');
		await first.update('pipe', 'b71ef6fd');
		await first.update('pids', { '@lead · Claude Code': 4242 });
		await first.update('gone', 1);
		await first.update('gone', undefined);

		const second = new JsonFileState(file);
		assert.deepStrictEqual(
			{ before, pipe: second.get('pipe', 'none'), pids: second.get('pids', {}), gone: second.get('gone', 'default') },
			{ before: 'none', pipe: 'b71ef6fd', pids: { '@lead · Claude Code': 4242 }, gone: 'default' });
	});

	test('a file that does not hold an object of values starts it empty', () => {
		const file = path.join(temp.dir, 'window-state.json');
		const read = (content: string) => {
			fs.writeFileSync(file, content);
			return new JsonFileState(file).get('pipe', 'none');
		};
		assert.deepStrictEqual([read('{"pipe":'), read('["pipe"]'), read('null'), read('{"pipe":"a1"}')], ['none', 'none', 'none', 'a1']);
	});
});
