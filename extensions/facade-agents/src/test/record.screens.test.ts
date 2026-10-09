/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { discardScreens, FinalScreenError, finalScreenFile, parseFinalScreen, readFinalScreen, screensDir, writeScreenSnapshot } from '../record/screens';
import { tempDir } from './util';

/** What is wrong with `text` as a final screen; or that it is one. */
function refusalOf(text: string): string {
	try {
		parseFinalScreen(text);
		return 'a final screen';
	} catch (err) {
		return err instanceof FinalScreenError ? err.message : `not a FinalScreenError: ${String(err)}`;
	}
}

suite('Record: agents\' screens', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-screens-');
	});

	teardown(() => {
		temp.remove();
	});

	test('a final screen file is read as the window writes it - the screen as the terminal ended, and the last full-screen frame before it - and anything else is refused with what is wrong', () => {
		const file = path.join(temp.dir, 'a3.json');
		fs.writeFileSync(file, JSON.stringify({ frame: ['Trust this folder?', '[[> Yes]]'], final: { buffer: 'normal', lines: ['bye'] } }));

		assert.deepStrictEqual({
			both: readFinalScreen(file),
			alternateOnly: parseFinalScreen('{"final":{"buffer":"alternate","lines":["menu"]}}'),
			nothingOnIt: parseFinalScreen('{"final":{"buffer":"normal","lines":[]}}'),
			notJson: refusalOf('bye\n'),
			notOne: refusalOf('{"final":{"buffer":"normal","lines":[1]}}'),
			badFrame: refusalOf('{"final":{"buffer":"normal","lines":[]},"frame":"menu"}'),
			noFile: readFinalScreen(path.join(temp.dir, 'a9.json'))
		}, {
			both: { final: { buffer: 'normal', lines: ['bye'] }, frame: ['Trust this folder?', '[[> Yes]]'] },
			alternateOnly: { final: { buffer: 'alternate', lines: ['menu'] } },
			nothingOnIt: { final: { buffer: 'normal', lines: [] } },
			notJson: 'it is not JSON',
			notOne: 'it is not a final screen as the window writes one',
			badFrame: 'it is not a final screen as the window writes one',
			noFile: undefined
		});
	});

	test('a screen read is written to a file of its own, which nothing writes again; the screens of the agents let go of are deleted, and nothing else', () => {
		const dir = screensDir(temp.dir);
		const first = writeScreenSnapshot(dir, 3, 1000, ['a', 'b']);
		const second = writeScreenSnapshot(dir, 3, 1000, ['c']);
		const texts = [fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8')];
		fs.writeFileSync(finalScreenFile(dir, 3), '{}');
		fs.writeFileSync(finalScreenFile(dir, 4), '{}');
		fs.writeFileSync(path.join(dir, 'a3.log'), 'not a screen');
		const discarded = discardScreens(dir, new Set([3]));

		assert.deepStrictEqual({ names: [path.basename(first), path.basename(second), path.basename(finalScreenFile(dir, 3))], texts, discarded, left: fs.readdirSync(dir).sort(), noFolder: discardScreens(path.join(temp.dir, 'nowhere'), new Set([3])) }, {
			names: ['a3-1000.txt', 'a3-1000-1.txt', 'a3.json'],
			texts: ['a\nb\n', 'c\n'],
			discarded: 3,
			left: ['a3.log', 'a4.json'],
			noFolder: 0
		});
	});
});
