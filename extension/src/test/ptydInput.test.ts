/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { InputEffect, InputQueue } from '../ptyd/input';
import { DEFAULT_KEY_MODES, isAgentKey, keySequence, pasteSequence } from '../ptyd/keys';

suite('ptyd input (COLLABORATION-1.2, RULES-1.10)', () => {

	suite('keys and pasted text', () => {

		test('takes the names and one printable character', () => {
			assert.deepStrictEqual({
				taken: ['Enter', 'Shift+Tab', 'PageDown', 'Ctrl+C', 'Ctrl+Z', 'y', '1', ' ', '?'].map(isAgentKey),
				refused: ['F1', 'enter', 'Ctrl+1', 'ab', '', '\x1b', '\t', String.fromCharCode(0x200b)].map(isAgentKey)
			}, { taken: Array(9).fill(true), refused: Array(8).fill(false) });
		});

		test('sends each as a terminal does for the person in its default modes, and Ctrl+J as the line feed it is', () => {
			const keys = ['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Up', 'Ctrl+C', 'Ctrl+J', 'Space', 'y'];
			assert.deepStrictEqual(keys.map(key => keySequence(DEFAULT_KEY_MODES, key)), ['\r', '\x1b', '\t', '\x1b[Z', '\x7f', '\x1b[A', '\x03', '\n', ' ', 'y']);
		});

		test('presses the cursor keys, Home and End as SS3 with application cursor keys on, else as CSI', () => {
			const keys = ['Up', 'Down', 'Right', 'Left', 'Home', 'End'];
			assert.deepStrictEqual({
				normal: keys.map(key => keySequence(DEFAULT_KEY_MODES, key)),
				application: keys.map(key => keySequence({ ...DEFAULT_KEY_MODES, applicationCursorKeys: true }, key))
			}, {
				normal: ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F'],
				application: ['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD', '\x1bOH', '\x1bOF']
			});
		});

		test('in the kitty protocol: Escape, Ctrl with a letter and Shift+Tab as escape codes where it tells keys apart; Enter, Tab and Backspace too where every key is one', () => {
			const keys = ['Escape', 'Ctrl+C', 'Shift+Tab', 'Enter', 'Tab', 'Backspace', 'Up', 'y'];
			assert.deepStrictEqual({
				disambiguate: keys.map(key => keySequence({ ...DEFAULT_KEY_MODES, kittyFlags: 1 }, key)),
				allKeys: keys.map(key => keySequence({ ...DEFAULT_KEY_MODES, kittyFlags: 1 | 8 }, key))
			}, {
				disambiguate: ['\x1b[27u', '\x1b[99;5u', '\x1b[9;2u', '\r', '\t', '\x7f', '\x1b[A', 'y'],
				allKeys: ['\x1b[27u', '\x1b[99;5u', '\x1b[9;2u', '\x1b[13u', '\x1b[9u', '\x1b[127u', '\x1b[A', 'y']
			});
		});

		test('in win32 input mode, a key as its press and its release, with the character it types and Ctrl or Shift held', () => {
			const win32 = { ...DEFAULT_KEY_MODES, win32Input: true };
			assert.deepStrictEqual(['Enter', 'Ctrl+C', 'Up'].map(key => keySequence(win32, key)), [
				'\x1b[13;0;13;1;0;1_\x1b[13;0;13;0;0;1_',
				'\x1b[67;0;3;1;8;1_\x1b[67;0;3;0;8;1_',
				'\x1b[38;0;0;1;0;1_\x1b[38;0;0;0;0;1_'
			]);
		});

		test('without bracketed paste text goes in as it is, line breaks and tabs kept; controls cannot press keys or end a bracketed paste', () => {
			assert.deepStrictEqual([pasteSequence(false, 'a\nb\r\nc\td'), pasteSequence(true, 'x\x1by\n')], ['a\nb\r\nc\td', '\x1b[200~x\u241by\r\x1b[201~']);
			for (const bracketed of [false, true]) {
				const pasted = pasteSequence(bracketed, 'a\x03\t\x7f\x1b[201~\x1b[A\nb');
				const body = bracketed ? pasted.slice(6, -6) : pasted;
				assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body));
				assert.ok(body.includes('\t'));
				assert.ok(!body.includes('\x1b'));
			}
		});

		test('a bracketed paste preserves tab-indented code and tab-separated fields, its line breaks as a terminal pastes them', () => {
			const text = 'Patch:\r\tif (x) {\r\t\treturn 1;\r\t}\rTSV:\ta\tb';
			const pasted = pasteSequence(true, text);
			assert.strictEqual(pasted, `\x1b[200~${text}\x1b[201~`);
			assert.strictEqual(pasteSequence(true, text.replace(/\r/g, '\n')), pasted);
		});
	});

	suite('the queue', () => {

		const applied: InputEffect = { outcome: 'applied' };
		const notApplied: InputEffect = { outcome: 'not_applied' };
		const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

		test('takes one operation whole before the next, in the order they came', async () => {
			const queue = new InputQueue();
			const order: string[] = [];
			const op = (name: string) => queue.add(async () => {
				order.push(`${name} begins`);
				await wait(20);
				order.push(`${name} ends`);
				return applied;
			}, notApplied);
			await Promise.all([op('one'), op('two')]);
			assert.deepStrictEqual(order, ['one begins', 'one ends', 'two begins', 'two ends']);
		});

		test('drops what is waiting once its run ends or is being stopped, and takes nothing after', async () => {
			const queue = new InputQueue();
			const going = queue.add(() => wait(50).then(() => applied), notApplied);
			const waiting = queue.add(async () => applied, notApplied);
			await wait(10);
			queue.end();
			assert.deepStrictEqual(await going, applied, 'what was going in finishes; what waits does not');
			assert.deepStrictEqual(await waiting, { outcome: 'not_applied', reason: 'ended' });
			assert.deepStrictEqual(await queue.add(async () => applied, notApplied), { outcome: 'not_applied', reason: 'ended' });
		});

		test('a call that fails part way is said to have failed, never to have done nothing', async () => {
			const queue = new InputQueue();
			await assert.rejects(queue.add(async () => {
				throw new Error('write failed');
			}, notApplied), /write failed/);
		});
	});
});
