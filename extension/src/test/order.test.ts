/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { arranged, moved, withNew } from '../ui/order';

suite('The panel\'s manual stack (PANEL-2.1, U05)', () => {

	test('a new card goes first; one already in the stack keeps its place, whatever its state', () => {
		assert.deepStrictEqual([withNew(['b', 'a'], 'c'), withNew(['b', 'a'], 'a')], [['c', 'b', 'a'], ['b', 'a']]);
	});

	test('the stack arranges the runs present, those it does not know first, and drops those gone', () => {
		assert.deepStrictEqual(arranged(['b', 'gone', 'a'], ['new2', 'new1', 'a', 'b']), ['new2', 'new1', 'b', 'a']);
	});

	test('Move Up/Down trades places with the next card; nothing moves past an end', () => {
		const order = ['a', 'b', 'c'];
		assert.deepStrictEqual([
			moved(order, 'b', -1),
			moved(order, 'b', 1),
			moved(order, 'a', -1),
			moved(order, 'c', 1),
			moved(order, 'missing', 1),
			moved(['a', 'b'], 'a', 1)
		], [
			['b', 'a', 'c'],
			['a', 'c', 'b'],
			undefined,
			undefined,
			undefined,
			['b', 'a']
		]);
	});

	test('J14: 100 cards keep a stable order through moves', () => {
		let order = Array.from({ length: 100 }, (_, i) => `r${i}`);
		for (let i = 0; i < 99; i++) {
			order = moved(order, 'r0', 1)!;
		}
		assert.deepStrictEqual([order[99], order[0], order.length, new Set(order).size], ['r0', 'r1', 100, 100]);
	});
});
