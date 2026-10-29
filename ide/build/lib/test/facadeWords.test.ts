/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import path from 'path';
import { suite, test } from 'node:test';
import { lists, reasonFor, VSCODE_STRINGS, vscodeWords } from '../facade/words.ts';

const root = path.resolve(import.meta.dirname, '../../..');

suite('Facade words', () => {

	const words = vscodeWords(root);

	test('ID-13 a string that still says "VS Code" is about VS Code the project, and says why', () => {
		assert.deepStrictEqual(words.filter(word => !reasonFor(word)).map(word => `${word.file} [${word.key}] ${word.text}`), []);
	});

	test('ID-13 every reason still has its string', () => {
		assert.deepStrictEqual(VSCODE_STRINGS.filter(entry => !words.some(word => lists(entry, word))).map(entry => `${entry.file} [${entry.key}]`), []);
	});

	test('ID-13 the scan reads every place a string can say it: the workbench, an extension\'s code, an extension\'s manifest', () => {
		const from = (prefix: RegExp) => words.some(word => prefix.test(word.file));
		assert.deepStrictEqual({
			workbench: from(/^src\/vs\//),
			extensionCode: from(/^extensions\/[^/]+\/.*src\/.*\.ts$/),
			manifest: from(/^extensions\/[^/]+\/package\.nls\.json$/)
		}, { workbench: true, extensionCode: true, manifest: true });
	});
});
