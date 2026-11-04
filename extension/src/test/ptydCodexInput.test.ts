/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/headless';
import type { RunFacts } from '../core/ports';
import { OrdinaryInput } from '../host/input';
import { InputScreen, inputScreenOf, readInput } from '../ptyd/composer';
import { isOwnDraft } from '../ptyd/drafts';
import { codexCompletedBackground } from '../ptyd/screenStatus';
import { settled, useFakeClock } from './clock';

interface Capture {
	readonly label: string;
	readonly expect: 'usable' | 'draft' | 'unknown';
	readonly cols: number;
	readonly cursor: InputScreen['cursor'];
	readonly cursorHidden: boolean;
	readonly rows: readonly { readonly cells: string; readonly dim?: readonly (readonly [number, number])[]; readonly inverse?: readonly (readonly [number, number])[] }[];
}

// Real 0.166.0 cells from probe-codex-input.cjs --raw, with and without its right-aligned warning. These captures contain only
// single-column characters; the exporter asserts their native cell columns before removing padding and compacting style runs.
const CAPTURES: readonly Capture[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/screens/codex/0.166.0-input.json'), 'utf8'));
const capture = (label: string) => CAPTURES.find(each => each.label === label)!;
const screenOf = (each: Capture): InputScreen => ({
	cursor: each.cursor,
	rows: each.rows.map(row => {
		const chars = [...row.cells];
		return Array.from({ length: each.cols }, (_, x) => ({ chars: chars[x] ?? ' ', x,
			dim: row.dim?.some(([start, end]) => x >= start && x < end) ?? false,
			inverse: row.inverse?.some(([start, end]) => x >= start && x < end) ?? false }));
	})
});
const changedRow = (screen: InputScreen, at: number, text: string): InputScreen => ({ ...screen,
	rows: screen.rows.map((row, y) => y === at ? row.map((cell, x) => ({ ...cell, chars: [...text][x] ?? ' ', dim: false, inverse: false })) : row)
});
const read = (screen: InputScreen) => readInput(screen, 'codex-prompt');
const firstMessage = 'Isolated passive footer delivery.\nKeep this second line exactly once.';
const nextMessage = 'Isolated new activity delivery.\nKeep this follow-up exactly once.';
const NOTHING = { outcome: 'none', text_written: 'none', enter_written: false };

function delivery(initial: InputScreen, pasted = screenOf(capture('passive-pasted'))) {
	let screen = initial, now = 0;
	const writes: unknown[] = [];
	const input = new OrdinaryInput({
		get: () => ({ id: 'fixture', inputAdapter: 'codex-prompt', inputCapability: { state: 'supported', reason: 'Native fixture' } } as RunFacts),
		inspectInput: async () => read(screen),
		typeText: async (_run, text, enter) => { writes.push({ text, enter }); screen = pasted; return { outcome: 'applied', pasted: true }; },
		pressKeys: async (_run, keys) => { writes.push({ keys }); screen = screenOf(capture('new-activity-empty')); return { outcome: 'applied', keysSent: keys.length }; },
		monotonic: () => now,
		wait: async ms => { now += ms; }
	});
	return { input, writes, change: (next: InputScreen) => { screen = next; } };
}

suite('Codex passive transcript footers keep ordinary input separate from active interactions (CLIS-2.1)', () => {
	useFakeClock();

	test('native empty, working, multiline paste, genuine draft and active-interaction captures retain their meaning', () => {
		assert.strictEqual(CAPTURES.length, 16);
		for (const each of CAPTURES) {
			assert.strictEqual(read(screenOf(each)).state, each.expect, each.label);
			if (each.expect !== 'unknown') assert.strictEqual(each.cursorHidden, false, `${each.label}: native composer cursor is visible`);
		}
		for (const suffix of ['', '-no-warning']) {
			for (const [label, message] of [['passive-pasted', firstMessage], ['new-activity-pasted', nextMessage]]) {
				const reading = read(screenOf(capture(label + suffix)));
				assert.strictEqual(reading.draft, message);
				assert.ok(isOwnDraft(reading.draft!, message, 'codex-prompt'));
				assert.ok(!isOwnDraft(reading.draft!, message + '\nAnother line.', 'codex-prompt'));
			}
		}
	});

	test('a whole native-shaped message and a follow-up each get one paste and one Enter, including the draft footer transition', async () => {
		for (const suffix of ['', '-no-warning']) {
			for (const [label, message] of [['passive', firstMessage], ['new-activity', nextMessage]]) {
				const { input, writes } = delivery(screenOf(capture(label + '-empty' + suffix)), screenOf(capture(label + '-pasted' + suffix)));
				assert.strictEqual(await input.inspect('fixture'), 'usable');
				assert.deepStrictEqual((await input.submit('fixture', message)).effects, { outcome: 'confirmed', text_written: 'full', enter_written: true });
				assert.deepStrictEqual(writes, [{ text: message, enter: false }, { keys: ['Enter'] }]);
			}
		}
	});

	test('real drafts and native browsing, history search, transcript search and text selection get no automated input', async () => {
		for (const each of CAPTURES.filter(each => each.expect !== 'usable')) {
			const { input, writes } = delivery(screenOf(each));
			assert.deepStrictEqual((await input.submit('fixture', firstMessage)).effects, NOTHING, each.label);
			assert.deepStrictEqual((await input.enter('fixture', firstMessage + ' changed')), NOTHING, each.label);
			assert.deepStrictEqual(writes, [], each.label);
		}
		// A draft or interaction can appear after the delivery's preflight read; submit must inspect again before pasting.
		for (const label of ['protected-draft', 'selection']) {
			const test = delivery(screenOf(capture('passive-empty')));
			assert.strictEqual(await test.input.inspect('fixture'), 'usable');
			test.change(screenOf(capture(label)));
			assert.deepStrictEqual((await test.input.submit('fixture', firstMessage)).effects, NOTHING);
			assert.deepStrictEqual(test.writes, []);
		}
	});

	test('placeholder words are not a whitelist; complete model, blank separator, prompt and cursor evidence are still required', () => {
		const screen = screenOf(capture('new-activity-empty'));
		const prompt = screen.cursor.y, model = screen.rows.length - 2, footer = model + 1;
		assert.strictEqual(read(changedRow(screen, prompt, '› Ask Codex to do anything')).state, 'draft', 'the same words typed by a person');
		assert.strictEqual(read({ ...screen, rows: screen.rows.map((row, y) => y === prompt ? row.map(cell => cell.x === 2 ? { ...cell, inverse: true } : cell) : row) }).state, 'usable', 'a dim placeholder with a block cursor');
		for (const changed of [
			changedRow(screen, model, ''), changedRow(screen, model - 1, '  Not a separator'), changedRow(screen, prompt, '> '),
			changedRow(screen, footer, '  enter confirm · esc cancel'), changedRow(screen, footer, '  New activity · enter copy & follow · esc clear'),
			changedRow(screen, footer, '  New activity · enter/esc latest · unexpected action'),
			{ ...screen, cursor: { x: 2, y: footer } }, { ...screen, cursor: { x: 3, y: prompt } }, { ...screen, drawing: true }
		]) assert.strictEqual(read(changed).state, 'unknown');
	});

	test('an actual synchronized terminal drawing is unavailable until its complete frame arrives', async () => {
		const each = capture('new-activity-empty'), screen = screenOf(each);
		const terminal = new Terminal({ cols: each.cols, rows: each.rows.length, allowProposedApi: true });
		try {
			const frame = screen.rows.map(row => row.map(cell => `${cell.dim ? '\x1b[2m' : '\x1b[22m'}${cell.chars}`).join('')).join('\r\n');
			await settled(new Promise<void>(resolve => terminal.write(`\x1b[?2026h\x1b[H${frame}\x1b[${each.cursor.y + 1};${each.cursor.x + 1}H`, resolve)));
			const test = delivery(inputScreenOf(terminal));
			assert.deepStrictEqual((await test.input.submit('fixture', firstMessage)).effects, NOTHING);
			assert.deepStrictEqual(test.writes, []);
			await settled(new Promise<void>(resolve => terminal.write('\x1b[?2026l', resolve)));
			assert.strictEqual(read(inputScreenOf(terminal)).state, 'usable');
		} finally { terminal.dispose(); }
	});

	test('passive input never extends the completed-turn status correction to possibly old transcript content', () => {
		const completed = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/screens/codex/0.166.0-background.json'), 'utf8')) as
			{ label: string; cols: number; lines: string[]; dimLines: number[] }[]).find(each => each.label === 'background-completed')!;
		for (const each of CAPTURES.filter(each => each.expect === 'usable')) {
			const lines = [...completed.lines.slice(0, -1), each.rows.at(-1)!.cells];
			assert.strictEqual(read(screenOf(each)).state, 'usable');
			assert.strictEqual(codexCompletedBackground(lines, false, undefined, new Set(completed.dimLines), each.cols), undefined, each.label);
		}
	});
});
