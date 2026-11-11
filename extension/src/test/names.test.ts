/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { BUILT_IN_NAMES } from '../base/names';
import { keptName, suggestName } from '../core/names';

/** The names terminal keys go by, and the aliases written for them: no suggestion may read as a key after `@`. */
const KEY_NAMES: readonly string[] = [
	'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp',
	'PageDown', 'Space', 'Return', 'Esc',
	...Array.from({ length: 26 }, (_, index) => `Ctrl+${String.fromCharCode('A'.charCodeAt(0) + index)}`)
];

suite('Agent names (LIFECYCLE-2.1)', () => {
	test('the built-in names are over a hundred short ASCII machine words, no two with the same first three letters, none a key name, a Facade word or a CLI', () => {
		const keys = new Set(KEY_NAMES.map(key => key.toLowerCase()));
		const words = ['agent', 'human', 'facade', 'pin', 'close', 'stop', 'resume', 'window', 'claude', 'codex', 'muse', 'qwen', 'agy', 'antigravity'];
		assert.ok(BUILT_IN_NAMES.length >= 100, `${BUILT_IN_NAMES.length} names`);
		assert.deepStrictEqual(BUILT_IN_NAMES.filter(name => !/^[A-Z][a-z]{2,7}$/.test(name)), []);
		const prefixes = BUILT_IN_NAMES.map(name => name.slice(0, 3).toLowerCase());
		assert.deepStrictEqual(prefixes.filter((prefix, i) => prefixes.indexOf(prefix) !== i), []);
		assert.deepStrictEqual(BUILT_IN_NAMES.filter(name => keys.has(name.toLowerCase()) || words.includes(name.toLowerCase())), []);
	});

	test('a name is one of the list that no agent in the window has, whatever its case or spaces; none once all are taken or the list is empty, so the agent is named by its ID', () => {
		const taken = BUILT_IN_NAMES.slice(0, -1).map(name => ` ${name.toUpperCase()} `);
		assert.deepStrictEqual([
			suggestName(taken, undefined, () => 0),
			suggestName(BUILT_IN_NAMES, undefined, () => 0.5),
			suggestName(['Ada'], [' Ada ', 'Grace'], () => 0),
			suggestName(['Ada', 'grace'], ['Ada', 'Grace'], () => 0),
			suggestName([], [], () => 0),
			suggestName([], ['  '], () => 0)
		], [BUILT_IN_NAMES[BUILT_IN_NAMES.length - 1], undefined, 'Grace', undefined, undefined, undefined]);
	});

	test('a name that is the agent\'s own ID is not kept for its conversation or Pin, which the next agent of it does not share', () => {
		assert.deepStrictEqual([keptName({ name: '#a7', alias: '#a7' }), keptName({ name: 'Ada', alias: '#a7' }), keptName({ name: '#a6', alias: '#a7' })], ['', 'Ada', '#a6']);
	});
});
