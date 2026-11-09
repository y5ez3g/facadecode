/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Terminal } from '@xterm/headless';
import { MouseModes } from '../base/mouseModes';

/** Claude Code 2.1.319's fullscreen start, and what it writes again with its first input after five seconds without any. */
const CLAUDE_START = '\x1b[?1004h\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l';
const CLAUDE_AGAIN = '\x1b(B\x0f\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

/** A headless xterm.js, the editor terminal's own parser, and its mouse. */
function terminal(): { write(data: string): Promise<void>; mouse(): string; changes(): number } {
	type Service = { activeProtocol: string; activeEncoding: string; onProtocolChange(listener: () => void): unknown };
	const term = new Terminal({ allowProposedApi: true, logLevel: 'off' });
	// Its own service, named for the core in xterm.js 6.0 and for its state from 6.1
	const core = (term as unknown as { _core: { coreMouseService?: Service; mouseStateService?: Service; writeSync?(data: string): void } })._core;
	const service = (core.coreMouseService ?? core.mouseStateService)!;
	let changes = 0;
	service.onProtocolChange(() => { changes++; });
	return {
		// Parsed at once where xterm.js still offers it: a write's callback waits for a timer, which on Windows takes up to 16 ms.
		// Nothing to write writes nothing: an empty write's callback may never come.
		write: async data => {
			if (!data) {
				return;
			}
			if (core.writeSync) {
				core.writeSync(data);
				return;
			}
			await new Promise<void>(resolve => term.write(data, resolve));
		},
		mouse: () => `${service.activeProtocol}/${service.activeEncoding}`,
		changes: () => changes
	};
}

suite('Mouse settings that would change nothing never reach an editor terminal (LIFECYCLE-2.2)', () => {

	test('Claude Code\'s settings again, which its first input after five seconds brings - often the press that starts a selection - are not written; what it writes with them is', () => {
		const modes = new MouseModes();
		assert.strictEqual(modes.shown(CLAUDE_START), CLAUDE_START, 'its start sets the mouse');
		assert.strictEqual(modes.shown(CLAUDE_AGAIN), '\x1b(B\x0f\x1b[?2004h');
		// A resize brings them again too
		assert.strictEqual(modes.shown('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'), '');
	});

	test('the terminal sets no protocol while a drag may be in progress, for what it has already: the drag keeps reporting', async () => {
		const editor = terminal();
		const modes = new MouseModes();
		await editor.write(modes.shown(CLAUDE_START));
		const before = editor.changes();
		await editor.write(modes.shown(CLAUDE_AGAIN));
		assert.strictEqual(editor.changes(), before, 'no protocol set, which stops a drag\'s reports');
		assert.strictEqual(editor.mouse(), 'ANY/SGR');
	});

	test('a run that changes the mouse goes whole and in its order, a reset or pixel positions too; the same again goes nowhere', () => {
		const modes = new MouseModes();
		const scroll = '\x1b[?1000h\x1b[?1006h';
		assert.strictEqual(modes.shown(scroll), scroll);
		assert.strictEqual(modes.shown(scroll), '');
		const full = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
		assert.strictEqual(modes.shown(full), full, 'from wheel and clicks to every motion');
		assert.strictEqual(modes.shown('\x1b[?1016h'), '\x1b[?1016h');
		assert.strictEqual(modes.shown('\x1b[?1016h'), '');
		assert.strictEqual(modes.shown('\x1b[?1016l\x1b[?1006h'), '\x1b[?1016l\x1b[?1006h');
		const off = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
		assert.strictEqual(modes.shown(off), off);
		assert.strictEqual(modes.shown(off), '');
	});

	test('settings with other output between them are runs of their own, each going whole where it changes the mouse; the output stays', () => {
		const modes = new MouseModes();
		modes.shown(CLAUDE_START);
		assert.strictEqual(modes.shown('a\x1b[?1000hb\x1b[?1003hc'), 'a\x1b[?1000hb\x1b[?1003hc', 'each changes it');
		assert.strictEqual(modes.shown('x\x1b[?1003hy\x1b[?1006hz'), 'xyz');
		// A setting of another mode ends a run: what is beside it is no part of it
		assert.strictEqual(modes.shown('\x1b[?1003h\x1b[?2026h\x1b[?1003h'), '\x1b[?2026h');
	});

	test('a setting of other modes with mouse modes in it is written as it is, and followed', () => {
		const modes = new MouseModes();
		assert.strictEqual(modes.shown('\x1b[?1049;1003;1006h'), '\x1b[?1049;1003;1006h');
		assert.strictEqual(modes.shown('\x1b[?1003h\x1b[?1006h'), '', 'the mouse it set is known');
		assert.strictEqual(modes.shown('\x1b[?25;1000l'), '\x1b[?25;1000l');
		assert.strictEqual(modes.shown('\x1b[?1003h'), '\x1b[?1003h', 'its reset of the protocol is known');
	});

	test('a full reset sets the mouse back to the default, so the settings after it go through; a soft reset leaves it', () => {
		const modes = new MouseModes();
		modes.shown(CLAUDE_START);
		assert.strictEqual(modes.shown('\x1bc\x1b[?1003h\x1b[?1006h'), '\x1bc\x1b[?1003h\x1b[?1006h');
		assert.strictEqual(modes.shown('\x1b[!p\x1b[?1003h'), '\x1b[!p');
		modes.reset();
		assert.strictEqual(modes.shown('\x1b[?1003h'), '\x1b[?1003h', 'a terminal opened anew has the default mouse');
	});

	test('a setting cut off between two writes waits for the next and is never half left out; other cut-off escapes too', () => {
		const modes = new MouseModes();
		modes.shown(CLAUDE_START);
		assert.strictEqual(modes.shown('text\x1b[?100'), 'text');
		assert.strictEqual(modes.shown('0h\x1b[?1002h\x1b[?1003h\x1b[?1006hmore'), 'more');
		assert.strictEqual(modes.shown('red\x1b'), 'red');
		assert.strictEqual(modes.shown('[31mred'), '\x1b[31mred');
		assert.strictEqual(modes.shown('\x1b['), '');
		assert.strictEqual(modes.shown('?1003h'), '');
		assert.strictEqual(modes.shown('\x9b?1003h'), '', 'the 8-bit CSI too');
		modes.shown('cut\x1b[?');
		modes.reset();
		assert.strictEqual(modes.shown('1003h'), '1003h', 'nothing held once the terminal went');
	});

	test('a setting is read as xterm.js reads it: past its sub-parameters, and as far as its 32nd parameter', async () => {
		const modes = new MouseModes();
		assert.strictEqual(modes.shown('\x1b[?1003:1;1006h'), '\x1b[?1003:1;1006h');
		assert.strictEqual(modes.shown('\x1b[?1003h\x1b[?1006h'), '', 'the mouse it set is known');
		// A reset after 32 other parameters is no reset: the terminal keeps its mouse, and so a reset after it is one
		const ignored = `\x1b[?${'2004;'.repeat(32)}1000l`;
		assert.strictEqual(modes.shown(ignored), ignored);
		assert.strictEqual(modes.shown('\x1b[?1000l'), '\x1b[?1000l');
		const editor = terminal();
		await editor.write(`\x1b[?1003:1;1006h${ignored}`);
		assert.strictEqual(editor.mouse(), 'ANY/SGR', 'as the editor\'s terminal has it');
	});

	test('a cut-off end too long for any setting is written as it comes, and then nothing is left out until the terminal is reset', () => {
		const modes = new MouseModes();
		modes.shown(CLAUDE_START);
		const long = `\x1b[?${'1'.repeat(300)}`;
		assert.strictEqual(modes.shown(long), long);
		assert.strictEqual(modes.shown(`;1000h${CLAUDE_AGAIN}`), `;1000h${CLAUDE_AGAIN}`, 'what that setting did is not known');
		modes.reset();
		assert.strictEqual(modes.shown(CLAUDE_START), CLAUDE_START);
		assert.strictEqual(modes.shown(CLAUDE_AGAIN), '\x1b(B\x0f\x1b[?2004h');
	});

	test('what is no mouse setting passes unchanged', () => {
		const modes = new MouseModes();
		for (const data of ['plain ? text', '\x1b[?2004h', '\x1b[?25l', '\x1b[?u', '\x1b]0;title?\x07', '\x1b[6n', '\x1b[?2026h\x1b[?2026l', '\x1b[>4;2m', 'a\x1b[2Jb']) {
			assert.strictEqual(modes.shown(data), data, JSON.stringify(data));
		}
	});

	test('whatever is written and however it is cut, the terminal\'s mouse is at every write what it would be with all of it', async function () {
		// Where xterm.js parses only on its timers, each of some 3000 writes waits for one
		this.timeout(120_000);
		// A seeded random generator: the same cases on every run
		let seed = 20261108;
		const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
		const pieces = [
			'\x1b[?9h', '\x1b[?9l', '\x1b[?1000h', '\x1b[?1000l', '\x1b[?1002h', '\x1b[?1002l', '\x1b[?1003h', '\x1b[?1003l', '\x1b[?1005h',
			'\x1b[?1006h', '\x1b[?1006l', '\x1b[?1015h', '\x1b[?1016h', '\x1b[?1016l', '\x1b[?1000;1006h', '\x1b[?1049;1003h', '\x1b[?25;1006l',
			'\x1bc', '\x1b[!p', '\x1b[?2004h', '\x1b[31m', 'text', '?', '\r\n', '\x9b?1002h', CLAUDE_AGAIN,
			'\x1b[?1000:1h', '\x1b[?1003:2;1006h', `\x1b[?${'1'.repeat(20)};1003l`, `\x1b[?${'2004;'.repeat(32)}1002h`
		];
		for (let round = 0; round < 150; round++) {
			let stream = '';
			for (let i = 0, n = 1 + random(20); i < n; i++) {
				stream += pieces[random(pieces.length)];
			}
			const all = terminal(), shown = terminal();
			const modes = new MouseModes();
			let at = 0;
			while (at < stream.length) {
				const next = Math.min(stream.length, at + 1 + random(12));
				const chunk = stream.slice(at, next);
				at = next;
				await all.write(chunk);
				await shown.write(modes.shown(chunk));
				assert.strictEqual(shown.mouse(), all.mouse(), `${JSON.stringify(stream)} up to ${at}`);
			}
		}
	});
});
