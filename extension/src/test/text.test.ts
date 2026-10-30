/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { truncateText } from '../base/text';
import { shown } from '../clis/config';

suite('Text previews keep Unicode characters whole', () => {

	test('the ellipsis fits the limit without splitting an emoji, and text already within the limit is kept', () => {
		assert.deepStrictEqual([
			truncateText('ab🌍cd', 4), truncateText('ab🌍cd', 5), truncateText('ab🌍', 4),
			truncateText('abc', 0), truncateText('abc', 1), truncateText('ab cd', 4)
		], ['ab…', 'ab🌍…', 'ab🌍', '', '…', 'ab…']);
	});

	test('a long configuration value is also cut between code points', () => {
		const previews = [55, 57].map(length => shown(`${'a'.repeat(length)}🌍tail`));
		assert.deepStrictEqual(previews, [`"${'a'.repeat(55)}🌍t…`, `"${'a'.repeat(57)}…`]);
		assert.ok(previews.every(preview => Buffer.from(preview, 'utf8').toString('utf8') === preview));
	});
});
