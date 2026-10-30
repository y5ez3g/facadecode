/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SUGGESTED_NAMES, suggestName } from '../core/names';

/** The names terminal keys go by, and the aliases written for them: no suggestion may read as a key after `@`. */
const KEY_NAMES: readonly string[] = [
	'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp',
	'PageDown', 'Space', 'Return', 'Esc',
	...Array.from({ length: 26 }, (_, index) => `Ctrl+${String.fromCharCode('A'.charCodeAt(0) + index)}`)
];

suite('Suggested agent names (LIFECYCLE-2.1, D57)', () => {
	test('over a hundred short ASCII machine words, no two with the same first three letters, none a key name, a Facade word or a CLI', () => {
		const keys = new Set(KEY_NAMES.map(key => key.toLowerCase()));
		const words = ['agent', 'human', 'facade', 'pin', 'close', 'stop', 'resume', 'window', 'claude', 'codex', 'muse', 'qwen', 'agy', 'antigravity'];
		assert.ok(SUGGESTED_NAMES.length >= 100, `${SUGGESTED_NAMES.length} names`);
		assert.deepStrictEqual(SUGGESTED_NAMES.filter(name => !/^[A-Z][a-z]{2,7}$/.test(name)), []);
		const prefixes = SUGGESTED_NAMES.map(name => name.slice(0, 3).toLowerCase());
		assert.deepStrictEqual(prefixes.filter((prefix, i) => prefixes.indexOf(prefix) !== i), []);
		assert.deepStrictEqual(SUGGESTED_NAMES.filter(name => keys.has(name.toLowerCase()) || words.includes(name.toLowerCase())), []);
	});

	test('a suggestion is one no agent in the window has while any is left, whatever its case; once all are used, any of them', () => {
		const taken = SUGGESTED_NAMES.slice(0, -1).map(name => name.toUpperCase());
		assert.strictEqual(suggestName(taken, () => 0), SUGGESTED_NAMES[SUGGESTED_NAMES.length - 1]);
		assert.ok(SUGGESTED_NAMES.includes(suggestName(SUGGESTED_NAMES, () => 0.5)));
	});
});
