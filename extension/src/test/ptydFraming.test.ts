/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { lineReader, MAX_JSON_LINE_BYTES } from '../ptyd/protocol';

suite('ptyd framing: complete UTF-8 messages within a finite byte bound', () => {

	test('byte-fragmented Unicode and several lines per chunk are delivered whole and in order', () => {
		const lines: string[] = [];
		const read = lineReader(line => lines.push(line), undefined, 32);
		const first = JSON.stringify({ text: '📘你好' });
		for (const byte of Buffer.from(first + '\n', 'utf8')) {
			read(Buffer.from([byte]));
		}
		read('\n  \r\n{"a":1}\n{"b":');
		read('2}\n');
		assert.deepStrictEqual(lines, [first, '{"a":1}', '{"b":2}']);
	});

	test('the byte limit is per frame, not per chunk or connection', () => {
		const lines: string[] = [];
		const read = lineReader(line => lines.push(line), undefined, 4);
		read('1234\n'.repeat(100));
		assert.deepStrictEqual(lines, Array(100).fill('1234'));
	});

	test('a fragmented frame is rejected by UTF-8 byte count before its newline and later input stays rejected', () => {
		const lines: string[] = [];
		const errors: string[] = [];
		const read = lineReader(line => lines.push(line), err => errors.push(err.message), 8);
		read('éé');
		read('éé');
		assert.deepStrictEqual([lines, errors], [[], []]);
		read('é');
		read('\nvalid\n');
		read('x'.repeat(100));
		assert.deepStrictEqual([lines, errors], [[], ['The ptyd frame exceeds 8 bytes.']]);
	});

	test('an oversized complete line does not deliver its partial content or following frames', () => {
		const lines: string[] = [];
		const errors: string[] = [];
		const read = lineReader(line => lines.push(line), err => errors.push(err.message), 4);
		read('ok\n12345\nnext\n');
		assert.deepStrictEqual([lines, errors], [['ok'], ['The ptyd frame exceeds 4 bytes.']]);
	});

	test('the default limit admits an 8 MiB snapshot with worst-case JSON escaping', () => {
		const size = 8 * 1024 * 1024;
		const frame = JSON.stringify({ id: 1, result: { screen: '\u0000'.repeat(size), seq: 1 } });
		let drawn = 0;
		const read = lineReader(line => { drawn = (JSON.parse(line) as { result: { screen: string } }).result.screen.length; });
		assert.ok(Buffer.byteLength(frame) <= MAX_JSON_LINE_BYTES);
		read(frame + '\n');
		assert.strictEqual(drawn, size);
	});
});
