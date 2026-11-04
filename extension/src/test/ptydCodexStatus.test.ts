/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/headless';
import { codexAdapter } from '../clis/codex';
import { activityOf } from '../clis/activity';
import { codexCompletedBackground } from '../ptyd/screenStatus';
import { readStatusLines } from '../ptyd/screen';
import { ProgramStatus } from '../ptyd/status';
import { settled, sleep, useFakeClock } from './clock';

interface Capture {
	readonly label: string;
	readonly cols: number;
	readonly clippedStart: boolean;
	readonly lines: readonly string[];
	readonly dimLines: readonly number[];
}

const CAPTURES: readonly Capture[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/screens/codex/0.166.0-background.json'), 'utf8'));
const completed = CAPTURES.find(capture => capture.label === 'background-completed')!;
const read = (capture: Capture) => codexCompletedBackground(capture.lines, capture.clippedStart, undefined, new Set(capture.dimLines), capture.cols);

suite('Codex 0.166.0 interactive turns with retained background commands (CLIS-2.3)', () => {
	useFakeClock();

	test('native captures distinguish completion from genuine work and a follow-up, including the cropped 60-column footer', () => {
		for (const capture of CAPTURES) {
			const idle = ['background-completed', 'follow-up-completed', 'resize-60', 'resize-120'].includes(capture.label);
			assert.deepStrictEqual(read(capture), idle ? { state: 'idle' } : undefined, capture.label);
		}
		assert.deepStrictEqual(['0.165.0', '0.166.0', '0.166.1', '0.167.0', undefined].map(version => codexAdapter.screenStatus?.(version)),
			[undefined, 'codex-0.166', undefined, undefined, undefined]);
	});

	test('a footer cropped at any width is its native prefix, a crop ending on a space included, as a row keeps no trailing spaces', () => {
		const background = completed.lines.findIndex(line => line.startsWith('  1 background'));
		const footer = completed.lines[background];
		const croppedAt = (cols: number): Capture => ({ ...completed, cols, lines: completed.lines.map((line, index) => index === background ? footer.slice(0, cols).trimEnd() : line) });
		// From the width that still shows all of its count's words on
		const legible = '  1 background terminal running'.length;
		for (let cols = legible; cols < footer.length; cols++) {
			assert.deepStrictEqual(read(croppedAt(cols)), { state: 'idle' }, `${cols} columns: ${JSON.stringify(croppedAt(cols).lines[background])}`);
		}
		// Narrower, it no longer says that a command is running: nothing is read from it
		assert.strictEqual(read(croppedAt(legible - 1)), undefined);
		// Cut shorter than the width it was drawn at is no native crop
		const short: Capture = { ...completed, cols: 60, lines: completed.lines.map((line, index) => index === background ? footer.slice(0, 40) : line) };
		assert.strictEqual(read(short), undefined);
	});

	test('a background footer, available input, old summary, output words or an incomplete layout alone never prove idle', () => {
		const summary = completed.lines.findIndex(line => line.includes('Worked for'));
		const background = completed.lines.findIndex(line => line.startsWith('  1 background'));
		const prompt = completed.lines.findIndex(line => line.startsWith('› Ask'));
		const changed = (at: number, text: string): Capture => ({ ...completed, lines: completed.lines.map((line, index) => index === at ? text : line) });
		for (const capture of [
			changed(summary, ''),
			changed(background - 1, '• The response is still streaming'),
			changed(background - 1, '› A new instruction'),
			changed(background - 1, '• Working (1s • esc to interrupt)'),
			changed(summary, '  Done: all tests passed'),
			changed(background, '  1 background terminal running'),
			changed(prompt, ''),
			{ ...completed, lines: completed.lines.slice(0, -2) },
			{ ...completed, dimLines: completed.dimLines.filter(index => index !== summary) },
			{ ...completed, dimLines: completed.dimLines.filter(index => index !== background) },
			{ ...completed, lines: completed.lines.slice(summary), dimLines: completed.dimLines.map(index => index - summary), clippedStart: true }
		]) { assert.strictEqual(read(capture), undefined, JSON.stringify(capture.lines)); }
		// A draft is independent of activity, even if it contains words that resemble working/completion indicators.
		assert.deepStrictEqual(read(changed(prompt, '› Working (1s • esc to interrupt)')), { state: 'idle' });
	});

	test('terminal styling is required and preserved through the actual screen reader', async () => {
		const terminal = new Terminal({ cols: completed.cols, rows: completed.lines.length, allowProposedApi: true });
		try {
			for (const styled of [false, true]) {
				const drawing = completed.lines.map((line, index) => styled && completed.dimLines.includes(index) ? `\x1b[2m${line}\x1b[22m` : line).join('\r\n');
				await settled(new Promise<void>(resolve => terminal.write(`\x1bc${drawing}`, resolve)));
				const screen = readStatusLines(terminal);
				assert.deepStrictEqual(codexCompletedBackground(screen.lines, screen.clippedStart, screen.boldHeads, screen.dimLines, terminal.cols), styled ? { state: 'idle' } : undefined);
			}
		} finally { terminal.dispose(); }
	});

	test('one native working report spans completed and follow-up turns; effective episodes and title changes stay accurate', async () => {
		const status = new ProgramStatus(true);
		status.report({ state: 'working', title: 'Native title' });
		const began = status.status!.at;
		await sleep(20);
		status.observed(read(completed));
		assert.strictEqual(activityOf(status.status).activity, 'not_working');
		const finished = status.status!.at;
		assert.ok(finished > began);
		await sleep(20);
		status.report({ state: 'working', title: 'New title' });
		status.observed(read(completed));
		assert.deepStrictEqual(status.status, { state: 'idle', title: 'New title', at: finished });
		status.report({ id: 'worker', state: 'working' });
		assert.strictEqual(status.status!.at, finished);
		status.observed(read(CAPTURES.find(capture => capture.label === 'follow-up-working')!));
		assert.strictEqual(activityOf(status.status).activity, 'working');
		assert.ok(status.status!.at > finished);
		await sleep(20);
		status.observed(read(completed));
		assert.strictEqual(status.status!.state, 'idle');
		status.observed(undefined);
		assert.strictEqual(status.status!.state, 'working', 'lost correction restores the actual root report');
	});

	test('native non-working states, blockers, errors, clear/reset and negotiation always win; other CLIs keep report precedence', () => {
		for (const report of [{ state: 'idle' }, { state: 'done' }, { state: 'blocked' }, { state: 'blocked', kind: 'permission' }, { state: 'error' }, { state: 'clear' }] as const) {
			const status = new ProgramStatus(true);
			status.report({ state: 'working' });
			status.observed(read(completed));
			status.report(report);
			status.observed(read(completed));
			assert.strictEqual(status.status!.state, report.state === 'clear' ? 'pending' : report.state);
			assert.strictEqual(status.status!.kind, 'kind' in report ? report.kind : undefined);
		}
		const status = new ProgramStatus(true);
		status.observed(read(completed));
		assert.strictEqual(status.status, undefined, 'no native working record to correct');
		status.asked();
		status.observed(read(completed));
		assert.strictEqual(status.status!.state, 'pending');
		status.report({ state: 'working' });
		status.observed(read(completed));
		status.clear();
		status.observed(read(completed));
		assert.strictEqual(status.status!.state, 'pending');
		const other = new ProgramStatus();
		other.report({ state: 'working' });
		other.observed(read(completed));
		assert.strictEqual(other.status!.state, 'working');
	});
});
