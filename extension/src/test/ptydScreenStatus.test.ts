/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/headless';
import { readStatusLines } from '../ptyd/screen';
import { museScreen, ScreenReading, screenReaderOf } from '../ptyd/screenStatus';
import { ProgramStatus } from '../ptyd/status';

// Tests compile to build/out/test; the fixtures stay beside their source
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'screens', 'muse');

/** A fixture's rows as a terminal shows them: each without the spaces at its end. */
function readingOf(name: string): ScreenReading | undefined {
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as { readonly rows: readonly { readonly cells: string; readonly bold?: readonly [number, number][] }[] };
	const bold = new Set(fixture.rows.flatMap((row, index) => row.bold?.some(([start, end]) => start === 0 && end > 0) ? [index] : []));
	return museScreen(fixture.rows.map(row => row.cells.trimEnd()), false, bold);
}

/** Muse Code's input frame at the bottom of a screen, with the rows `above` it. */
function frame(above: readonly string[], input: readonly string[] = ['❯']): string[] {
	const rule = '─'.repeat(60);
	return [...above, `── Voice input (Alt+V to start) ${'─'.repeat(30)}`, ...input, rule, '  muse-spark-1.3 · minimal · <folder> · Launch overrides', '', ''];
}

suite('ptyd: Muse Code\'s screen, read as its status where it reports nothing (CLIS-2.3)', () => {

	test('real terminal soft wraps, including wide text and a resize, preserve the logical working row', async () => {
		const terminal = new Terminal({ cols: 80, rows: 40, allowProposedApi: true });
		try {
			const screen = frame(['◈ Checking 编译结果 and a task with a very long description (3s · esc to interrupt)']);
			await new Promise<void>(resolve => terminal.write(screen.join('\r\n'), resolve));
			for (const cols of [80, 38, 100]) {
				terminal.resize(cols, 40);
				const reading = readStatusLines(terminal);
				assert.deepStrictEqual(museScreen(reading.lines, reading.clippedStart), { state: 'working' }, String(cols));
			}
		} finally { terminal.dispose(); }
	});

	test('the native bold answer marker distinguishes a response from the same words in a working indicator', async () => {
		const terminal = new Terminal({ cols: 80, rows: 40, allowProposedApi: true });
		try {
			for (const [marker, expected] of [['◆ ', 'working'], ['\x1b[1m◆ \x1b[22m', 'idle']] as const) {
				await new Promise<void>(resolve => terminal.write(`\x1bc${frame([`${marker}Thinking (3s · esc to interrupt)`]).join('\r\n')}`, resolve));
				const screen = readStatusLines(terminal);
				assert.deepStrictEqual(museScreen(screen.lines, screen.clippedStart, screen.boldHeads), { state: expected });
			}
		} finally { terminal.dispose(); }
	});

	test('a clipped or incomplete layout supplies no idle evidence or stale login prompt', () => {
		const signIn = ['  Log in with browser · Enter to choose', '  Set an API key'];
		const whole = frame(['◈ Thinking (2s · esc to interrupt)']);
		assert.deepStrictEqual([
			museScreen(frame([])),
			museScreen(whole, true),
			museScreen(whole.slice(0, -3)),
			museScreen([...signIn, ...whole.slice(0, -3)])
		], [undefined, undefined, undefined, undefined]);
	});

	test('status review: changed or hard-wrapped working indicators are unknown, never idle', () => {
		for (const above of [
			['◈ Thinking (2s · esc to cancel)'],
			['◈ Thinking through a longer task (3s ·', 'esc to interrupt)'],
			['An unfamiliar activity indicator']
		]) {
			assert.strictEqual(museScreen(frame(above)), undefined, above.join('\n'));
		}
	});

	test('every screen it was seen drawing: working while its working row stands above its input, past its usage warning and queued input; not working with the input empty or holding a draft; blocked at its sign-in choice and its trust question', () => {
		const names = fs.readdirSync(FIXTURES).map(file => file.replace(/\.json$/, '')).sort();
		assert.deepStrictEqual(Object.fromEntries(names.map(name => [name, readingOf(name)])), {
			'1.4.12-linux-idle': { state: 'idle' },
			'1.4.12-linux-sign-in': { state: 'blocked', kind: 'auth' },
			'1.4.12-win32-idle': { state: 'idle' },
			'1.4.14-darwin-busy': { state: 'working' },
			'1.4.14-darwin-answered-narrow': { state: 'idle' },
			'1.4.14-darwin-busy-submitted': { state: 'working' },
			'1.4.14-darwin-empty': { state: 'idle' },
			// Recalled from its history while it works: still working
			'1.4.14-darwin-history': { state: 'working' },
			'1.4.14-darwin-long-submitted': { state: 'working' },
			'1.4.14-darwin-pasted': { state: 'idle' },
			'1.4.14-darwin-slash': { state: 'idle' },
			'1.4.14-darwin-trust': { state: 'blocked', kind: 'permission' },
			'1.4.14-darwin-typed': { state: 'idle' },
			'1.4.14-darwin-working': { state: 'working' },
			'1.4.14-darwin-working-typed': { state: 'working' },
			'1.4.14-win32-idle': { state: 'idle' },
			'1.4.14-win32-sign-in': { state: 'blocked', kind: 'auth' }
		});
	});

	test('no reading where its input frame is not whole on the screen - nothing drawn yet, a frame without its bottom rule, a prompt row with no rule above it, a working row with no frame under it', () => {
		const rule = '─'.repeat(60);
		assert.deepStrictEqual([
			museScreen([]),
			museScreen(['', '', '']),
			museScreen(['  Muse Code 1.4.14', `── Voice input (Alt+V to start) ${rule}`, '❯']),
			museScreen(['  Muse Code 1.4.14', 'text', '❯', rule]),
			museScreen(['◈ Thinking (2s · esc to interrupt)', '', '']),
			// One of the two choices alone is no sign-in screen
			museScreen(['  Log in with browser · Enter to choose'])
		], [undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('only its own working row says it works: a prompt the person wrote, what it answered and an old row of work above them say nothing; text typed into its input is never read', () => {
		assert.deepStrictEqual([
			museScreen(frame(['❯ Say: Thinking (2s · esc to interrupt)', '', '⚠ Usage running low · week: --% left'])),
			museScreen(frame(['◈ Thinking (2s · esc to interrupt)', '• Done: the tests pass', ''])),
			museScreen(frame(['  Muse Code 1.4.14'], ['❯ ◈ Thinking (2s · esc to interrupt)'])),
			museScreen(frame(['◆ Thinking (3s · esc to interrupt)', '', '⚠ Usage running low · week: --% left', '◆ Queued input · ↑ to edit', '└ the next message', '  goes on here'])),
			museScreen(frame(['◈ Running npm test (12s · esc to interrupt)']))
		], [{ state: 'idle' }, { state: 'idle' }, { state: 'idle' }, { state: 'working' }, { state: 'working' }]);
	});

	test('its sign-in choice and its trust question stand in place of its input: their words above a whole input frame, left from before, say nothing - the frame decides', () => {
		const signIn = ['  Log in with browser · Enter to choose', '  Set an API key'];
		assert.deepStrictEqual([
			museScreen(frame([...signIn, ''])),
			museScreen(frame([...signIn, '◈ Thinking (2s · esc to interrupt)'])),
			museScreen(frame(['Do you trust this workspace?', ''])),
			museScreen(['', ...signIn, '']),
			museScreen(['Do you trust this workspace?', '  Yes, trust this workspace', '  No'])
		], [{ state: 'idle' }, { state: 'working' }, { state: 'idle' }, { state: 'blocked', kind: 'auth' }, { state: 'blocked', kind: 'permission' }]);
	});

	test('readers by the ID an adapter names: Muse Code\'s; none for no ID, or one this ptyd does not know', () => {
		assert.deepStrictEqual([screenReaderOf('muse') === museScreen, screenReaderOf(undefined), screenReaderOf('qwen'), screenReaderOf('toString')], [true, undefined, undefined, undefined]);
	});
});

suite('ptyd: a screen reading in a program\'s status, which its own word always outranks (CLIS-2.3)', () => {

	test('status review: resetting the terminal revokes its screen evidence', () => {
		const status = new ProgramStatus();
		status.observed({ state: 'working' });
		status.clear();
		assert.strictEqual(status.status?.state, 'pending');
	});

	test('a program that takes no part is read from its screen, the same reading again keeping its time; once it asks or reports, its screen counts for nothing', () => {
		const status = new ProgramStatus();
		const seen: unknown[] = [];
		status.onDidChange(each => seen.push(each && [each.state, each.kind]));
		status.observed({ state: 'idle' });
		const began = status.status!.at;
		status.observed({ state: 'idle' });
		status.observed({ state: 'working' });
		status.observed({ state: 'blocked', kind: 'auth' });
		assert.deepStrictEqual([status.takesPart, seen], [false, [['idle', undefined], ['working', undefined], ['blocked', 'auth']]]);
		assert.ok(status.status!.at >= began);
		// Its question takes over at once; what its screen shows afterwards changes nothing
		status.asked();
		status.observed({ state: 'working' });
		assert.deepStrictEqual([status.takesPart, status.status!.state, status.status!.negotiating], [true, 'pending', true]);
		status.report({ state: 'idle' });
		status.observed({ state: 'working' });
		assert.strictEqual(status.status!.state, 'idle');
	});

	test('native reports take precedence; reset and a new shell prompt invalidate screen evidence', () => {
		const reported = new ProgramStatus();
		reported.observed({ state: 'working' });
		reported.report({ state: 'done' });
		reported.observed({ state: 'working' });
		assert.deepStrictEqual([reported.takesPart, reported.status!.state], [true, 'done']);
		const read = new ProgramStatus();
		read.observed({ state: 'working' });
		read.clear();
		read.promptStarted();
		assert.deepStrictEqual([read.takesPart, read.status!.state, read.status!.unavailable], [false, 'pending', 'screen_reset']);
	});

	test('unrecognized completed screens revoke old observations without inventing a fresh startup or resetting the time repeatedly', () => {
		const status = new ProgramStatus();
		status.observed(undefined);
		assert.deepStrictEqual([status.status], [undefined], 'no initial evidence: the launch still has its initial grace');
		status.observed({ state: 'idle' });
		status.observed(undefined);
		const lost = status.status;
		assert.strictEqual(lost?.state, 'pending');
		assert.strictEqual(lost?.unavailable, 'screen_unrecognized');
		status.observed(undefined);
		assert.strictEqual(status.status, lost);
		status.observed({ state: 'working' });
		assert.strictEqual(status.status?.state, 'working');
		status.promptStarted();
		assert.strictEqual(status.status?.unavailable, 'screen_reset');
		status.report({ state: 'idle' });
		status.observed(undefined);
		assert.strictEqual(status.status?.state, 'idle', 'screen loss cannot override a native report');
	});
});
