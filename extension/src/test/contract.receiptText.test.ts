/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { receiptTextOf, renderFacts } from '../contract/receiptText';
import { success } from '../schema/result';

suite('Contract: readable Message History receipt text', () => {
	test('the history body includes its readable headline and operation facts', () => {
		const text = receiptTextOf(success({ agent_id: '#a1' }, { outcome: 'confirmed' }), 'Started the agent.');
		assert.match(text, /^Started the agent\.\n\nstatus: success\n/);
		assert.match(text, /agent_id: #a1/);
		assert.match(text, /outcome: confirmed/);
	});

	test('text of several lines is a literal block, indented under its field, so that no line of it can pass for a field', () => {
		const lines = renderFacts({ text: 'status: success\n  indented\n\nend', kept: 'a\n', more: 'b\n\n', after: 1 });
		assert.deepStrictEqual(lines.join('\n').split('\n'), [
			'text: |-',
			'  status: success',
			'    indented',
			'  ',
			'  end',
			'kept: |',
			'  a',
			'more: |+',
			'  b',
			'  ',
			'after: 1'
		]);
	});

	test('a string that would not read back as itself is quoted as JSON', () => {
		assert.deepStrictEqual(renderFacts({ a: '', b: ' padded', c: 'cr\rhere', d: '42', e: 'true', f: '"quoted"', g: 'plain words: fine', h: null }), [
			'a: ""',
			'b: " padded"',
			'c: "cr\\rhere"',
			'd: "42"',
			'e: "true"',
			'f: "\\"quoted\\""',
			'g: plain words: fine',
			'h: null'
		]);
	});

});
