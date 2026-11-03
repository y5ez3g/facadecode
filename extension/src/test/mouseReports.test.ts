/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MouseReports } from '../base/mouseReports';

suite('Mouse reports an editor terminal could not measure (LIFECYCLE-2.2)', () => {

	test('a release sent after a clicked link took the terminal away keeps its press position, never "aN;NaNm"', () => {
		const mouse = new MouseReports();
		assert.strictEqual(mouse.repair('\x1b[<0;12;5M'), '\x1b[<0;12;5M');
		assert.strictEqual(mouse.repair('\x1b[<0;NaN;NaNm'), '\x1b[<0;12;5m');
	});

	test('one with no measured report before it is left out, and what was typed with it stays', () => {
		assert.strictEqual(new MouseReports().repair('a\x1b[<0;NaN;NaNmb'), 'ab');
		assert.strictEqual(new MouseReports().repair('\x1b[<0;NaN;NaNm'), '');
	});

	test('the last measured report gives the position: a later press, motion or wheel, in the same chunk too', () => {
		const mouse = new MouseReports();
		assert.strictEqual(mouse.repair('\x1b[<0;3;4M\x1b[<32;7;9M\x1b[<0;NaN;NaNm'), '\x1b[<0;3;4M\x1b[<32;7;9M\x1b[<0;7;9m');
		assert.strictEqual(mouse.repair('\x1b[<64;20;2M'), '\x1b[<64;20;2M');
		assert.strictEqual(mouse.repair('\x1b[<2;NaN;8m'), '\x1b[<2;20;2m');
	});

	test('pixel positions, URXVT and the character encodings are kept whole the same way', () => {
		const pixels = new MouseReports();
		assert.strictEqual(pixels.repair('\x1b[<0;300;120M'), '\x1b[<0;300;120M');
		assert.strictEqual(pixels.repair('\x1b[<0;NaN;NaNm'), '\x1b[<0;300;120m');

		const urxvt = new MouseReports();
		assert.strictEqual(urxvt.repair('\x1b[32;10;3M'), '\x1b[32;10;3M');
		assert.strictEqual(urxvt.repair('\x1b[35;NaN;NaNM'), '\x1b[35;10;3M');

		// The default encoding writes each coordinate as a character 32 past it: an unmeasured one is a NUL
		const characters = new MouseReports();
		assert.strictEqual(characters.repair('\x1b[M +%'), '\x1b[M +%');
		assert.strictEqual(characters.repair('\x1b[M#\0\0'), '\x1b[M#+%');
		assert.strictEqual(new MouseReports().repair('\x1b[M#\0\0'), '');
	});

	test('typed text, keys and pastes that are no mouse report pass unchanged', () => {
		const mouse = new MouseReports();
		for (const typed of ['aN;NaNm', 'hello', '\r', '\x1b[A', '\x1b[1;5C', '\x1b[200~NaN;NaN\x1b[201~', '\x1b[3~', '\x1b', '\x1b[<']) {
			assert.strictEqual(mouse.repair(typed), typed, JSON.stringify(typed));
		}
	});
});
