/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { discardScreens, FinalScreenError, finalScreenFile, parseFinalScreen, readFinalScreen, screensDir, writeFinalScreenText, writeScreenSnapshot } from '../record/screens';
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
			// When it was taken and last showed output, and what its terminal no longer held (D2; DB-06)
			withFacts: parseFinalScreen('{"final":{"buffer":"normal","lines":["$"],"older":true,"trimmed":false},"capturedAt":9000,"lastOutput":4000}'),
			notJson: refusalOf('bye\n'),
			notOne: refusalOf('{"final":{"buffer":"normal","lines":[1]}}'),
			badFrame: refusalOf('{"final":{"buffer":"normal","lines":[]},"frame":"menu"}'),
			badFacts: [refusalOf('{"final":{"buffer":"normal","lines":[],"trimmed":"yes"}}'), refusalOf('{"final":{"buffer":"normal","lines":[]},"capturedAt":"now"}')],
			noFile: readFinalScreen(path.join(temp.dir, 'a9.json'))
		}, {
			both: { final: { buffer: 'normal', lines: ['bye'] }, frame: ['Trust this folder?', '[[> Yes]]'] },
			alternateOnly: { final: { buffer: 'alternate', lines: ['menu'] } },
			nothingOnIt: { final: { buffer: 'normal', lines: [] } },
			withFacts: { final: { buffer: 'normal', lines: ['$'], older: true, trimmed: false }, capturedAt: 9000, lastOutput: 4000 },
			notJson: 'it is not JSON',
			notOne: 'it is not a final screen as the window writes one',
			badFrame: 'it is not a final screen as the window writes one',
			badFacts: ['it is not a final screen as the window writes one', 'it is not a final screen as the window writes one'],
			noFile: undefined
		});
	});

	test('a screen read is written to a file of its own, which nothing writes again, and so is a final screen as text; the screens of the agents let go of are deleted - their final screens as text, and one the window was still writing, too - and nothing else (D6; DB-01)', () => {
		const dir = screensDir(temp.dir);
		const first = writeScreenSnapshot(dir, 3, 1000, ['a', 'b']);
		const second = writeScreenSnapshot(dir, 3, 1000, ['c']);
		const final = writeFinalScreenText(dir, 3, ['[its screen as its terminal ended]', 'bye']);
		const finalAgain = writeFinalScreenText(dir, 3, ['other']);
		const texts = [fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8'), fs.readFileSync(final, 'utf8'), fs.readFileSync(writeFinalScreenText(dir, 5, []), 'utf8')];
		fs.writeFileSync(finalScreenFile(dir, 3), '{}');
		fs.writeFileSync(`${finalScreenFile(dir, 3)}.tmp`, '{"fin');
		fs.writeFileSync(finalScreenFile(dir, 4), '{}');
		fs.writeFileSync(path.join(dir, 'a3.log'), 'not a screen');
		const discarded = discardScreens(dir, new Set([3]));

		assert.deepStrictEqual({ names: [path.basename(first), path.basename(second), path.basename(finalScreenFile(dir, 3)), path.basename(final), finalAgain === final], texts, discarded, left: fs.readdirSync(dir).sort(), noFolder: discardScreens(path.join(temp.dir, 'nowhere'), new Set([3])) }, {
			names: ['a3-1000.txt', 'a3-1000-1.txt', 'a3.json', 'a3.txt', true],
			texts: ['a\nb\n', 'c\n', '[its screen as its terminal ended]\nbye\n', ''],
			discarded: 5,
			left: ['a3.log', 'a4.json', 'a5.txt'],
			noFolder: 0
		});
	});
});
