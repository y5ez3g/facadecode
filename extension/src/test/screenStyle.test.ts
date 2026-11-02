/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { screenText, tailStyles } from '../base/screenStyle';

/** Independent reader of the public representation: validates nesting and unescapes source characters. */
function decode(text: string): string {
	const stack: string[] = [], result: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') { result.push(text[++i]); continue; }
		const pair = text.slice(i, i + 2);
		if (pair === '[[' || pair === '{{') { stack.push(pair === '[[' ? ']]' : '}}'); i++; }
		else if (pair === ']]' || pair === '}}') { assert.strictEqual(stack.pop(), pair); i++; }
		else { result.push(text[i]); }
	}
	assert.strictEqual(stack.length, 0);
	return result.join('');
}

suite('Reversible screen style text (MCP-5.1)', () => {
	test('literal markup, backslashes, whitespace and Unicode remain exact, styled or unstyled', () => {
		const text = ' [[{{literal}}]] \\ 🐱 e\u0301 中文\nsecond line\n  ';
		const cues = [{ start: 1, end: 16, inverse: true as const, dim: true as const }];
		for (const styles of [undefined, [], cues]) { assert.strictEqual(decode(screenText(text, styles)), text); }
		assert.ok(screenText(text, cues).includes('[[{{\\[\\['));
	});

	test('a highlight is readable where it appears, including a blank cursor, without counting character offsets', () => {
		assert.strictEqual(screenText('🐱e\u0301\nA\nB\n ', [{ start: 4, end: 5, inverse: true }, { start: 6, end: 7, dim: true }, { start: 8, end: 9, inverse: true }]), '🐱e\u0301\n[[A]]\n{{B}}\n[[ ]]');
	});

	test('tailing a saved frame adjusts source cues before rendering the one retained body', () => {
		const text = ['old 🐱', 'new e\u0301', 'selected'];
		const styles = [{ start: 6, end: 12, dim: true as const }, { start: 13, end: 21, inverse: true as const }];
		assert.strictEqual(screenText(text.slice(-1).join('\n'), tailStyles(text, styles, 1)), '[[selected]]');
	});

	test('invalid or overlapping source ranges fail rather than inventing cues or dropping source text', () => {
		assert.throws(() => screenText('abc', [{ start: 0, end: 4, dim: true }]));
		assert.throws(() => screenText('abc', [{ start: 0, end: 2, dim: true }, { start: 1, end: 3, inverse: true }]));
	});
});
