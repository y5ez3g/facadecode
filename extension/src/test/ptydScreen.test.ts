/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Terminal } from '@xterm/headless';
import { readScreen } from '../ptyd/screen';

/** A headless terminal as ptyd keeps a run's, with `data` drawn on it. */
async function drawn(data: string, options: { readonly cols?: number; readonly rows?: number; readonly scrollback?: number } = {}): Promise<Terminal> {
	const terminal = new Terminal({ cols: options.cols ?? 20, rows: options.rows ?? 6, scrollback: options.scrollback ?? 100, allowProposedApi: true });
	await new Promise<void>(resolve => terminal.write(data, resolve));
	return terminal;
}

suite('ptyd screen: a run\'s rendered text as read_screen returns it (MCP-5.1)', () => {

	test('lines top to bottom, the spaces they end in cut, inverse video marked [[...]] and dim text {{...}}; the plain text without marks', async () => {
		const terminal = await drawn('first\r\n\x1b[7mpicked\x1b[0m item\r\n\x1b[2mhint\x1b[0m   \r\n');
		const screen = readScreen(terminal, 50);
		assert.deepStrictEqual(screen.lines, ['first', '[[picked]] item', '{{hint}}', '']);
		assert.deepStrictEqual(screen.text, ['first', 'picked item', 'hint', '']);
		assert.deepStrictEqual([screen.buffer, screen.older, screen.trimmed], ['normal', false, false]);
		terminal.dispose();
	});

	test('a line wrapped over several rows is one line, and a wide character is read once', async () => {
		const terminal = await drawn(`${'a'.repeat(25)}\r\n你好 ok`, { cols: 10 });
		assert.deepStrictEqual(readScreen(terminal, 50).text, ['a'.repeat(25), '你好 ok']);
		terminal.dispose();
	});

	test('the bottom lines alone where fewer are asked for, saying that older ones are above', async () => {
		const terminal = await drawn('one\r\ntwo\r\nthree\r\nfour');
		const screen = readScreen(terminal, 2);
		assert.deepStrictEqual([screen.text, screen.older], [['three', 'four'], true]);
		terminal.dispose();
	});

	test('a full-screen program\'s alternate buffer is read while it is active, the normal buffer when asked for', async () => {
		const terminal = await drawn('shell line\r\n\x1b[?1049h\x1b[Hmenu');
		assert.deepStrictEqual([readScreen(terminal, 50).buffer, readScreen(terminal, 50).text[0]], ['alternate', 'menu']);
		assert.deepStrictEqual([readScreen(terminal, 50, 'normal').buffer, readScreen(terminal, 50, 'normal').text[0]], ['normal', 'shell line']);
		terminal.dispose();
	});

	test('a terminal that let go of its oldest lines says its scrollback is full', async () => {
		const terminal = await drawn(Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\r\n'), { rows: 4, scrollback: 5 });
		const screen = readScreen(terminal, 2_000);
		assert.strictEqual(screen.trimmed, true);
		assert.deepStrictEqual(screen.text.slice(-2), ['line 28', 'line 29']);
		terminal.dispose();
	});
});
