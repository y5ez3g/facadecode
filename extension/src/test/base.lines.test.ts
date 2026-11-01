/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { lineReader, MAX_JSON_LINE_BYTES } from '../base/lines';

suite('Base: newline-delimited JSON read whole within one bound', () => {

	const reader = (options: Parameters<typeof lineReader>[2] = {}) => {
		const lines: string[] = [];
		const errors: string[] = [];
		const read = lineReader(line => lines.push(line), err => errors.push(err.message), options);
		return { lines, errors, read };
	};

	test('a character split between chunks, and several lines in one chunk, are delivered whole and in order; blank lines are not', () => {
		const { lines, errors, read } = reader({ maxBytes: 32 });
		const first = JSON.stringify({ text: '📘你好' });
		for (const byte of Buffer.from(`${first}\n`, 'utf8')) {
			read(Buffer.from([byte]));
		}
		read('\n  \r\n{"a":1}\n{"b":');
		read('2}\n');
		assert.deepStrictEqual([lines, errors], [[first, '{"a":1}', '{"b":2}'], []]);
	});

	test('the bound is per line, counted in UTF-8 bytes, not per chunk', () => {
		const { lines, read } = reader({ maxBytes: 4 });
		read('1234\n'.repeat(100));
		assert.deepStrictEqual(lines, Array(100).fill('1234'));
		const accents = reader({ maxBytes: 4 });
		accents.read('éé\néé');
		accents.read('é\n');
		assert.deepStrictEqual([accents.lines, accents.errors], [['éé'], ['A line exceeds 4 bytes.']]);
	});

	test('by default a longer line stops the reader: neither it nor anything after it is delivered', () => {
		const { lines, errors, read } = reader({ maxBytes: 4 });
		read('ok\n12345\nnext\n');
		read('more\n');
		assert.deepStrictEqual([lines, errors], [['ok'], ['A line exceeds 4 bytes.']]);
	});

	test('skipping, a longer line is dropped up to its line break - however many chunks it comes in - and reading goes on', () => {
		const { lines, errors, read } = reader({ maxBytes: 4, oversized: 'skip' });
		read('ok\n123');
		read('45678');
		read('9\nnext\n12345\nlast\n');
		assert.deepStrictEqual([lines, errors], [['ok', 'next', 'last'], ['A line exceeds 4 bytes.', 'A line exceeds 4 bytes.']]);
	});

	test('the default bound takes an 8 MiB screen with JSON\'s worst escaping; a bound that is no positive integer is refused', () => {
		const size = 8 * 1024 * 1024;
		const frame = JSON.stringify({ id: 1, result: { screen: '\u0000'.repeat(size), seq: 1 } });
		let drawn = 0;
		const read = lineReader(line => drawn = (JSON.parse(line) as { result: { screen: string } }).result.screen.length, err => assert.fail(err));
		assert.ok(Buffer.byteLength(frame) <= MAX_JSON_LINE_BYTES);
		read(`${frame}\n`);
		assert.strictEqual(drawn, size);
		for (const maxBytes of [0, -1, 1.5, Number.MAX_VALUE]) {
			assert.throws(() => lineReader(() => undefined, () => undefined, { maxBytes }), /positive safe integer/);
		}
	});
});
