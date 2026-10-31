/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { museScreen, screenReaderOf } from '../ptyd/screenStatus';
import { ProgramStatus } from '../ptyd/status';

// Tests compile to build/out/test; the fixtures stay beside their source
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'screens', 'muse');

/** A fixture's rows as a terminal shows them: each without the spaces at its end. */
function rowsOf(name: string): string[] {
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as { readonly rows: readonly { readonly cells: string }[] };
	return fixture.rows.map(row => row.cells.trimEnd());
}

/** Muse Code's input frame at the bottom of a screen, with the rows `above` it. */
function frame(above: readonly string[], input: readonly string[] = ['❯']): string[] {
	const rule = '─'.repeat(60);
	return [...above, `── Voice input (Alt+V to start) ${'─'.repeat(30)}`, ...input, rule, '  muse-spark-1.3 · minimal · <folder> · Launch overrides', '', ''];
}

suite('ptyd: Muse Code\'s screen, read as its status where it reports nothing (CLIS-2.3, D80)', () => {

	test('every screen it was seen drawing: working while its working row stands above its input, past its usage warning and queued input; not working with the input empty or holding a draft; blocked at its sign-in choice and its trust question', () => {
		const names = fs.readdirSync(FIXTURES).map(file => file.replace(/\.json$/, '')).sort();
		assert.deepStrictEqual(Object.fromEntries(names.map(name => [name, museScreen(rowsOf(name))])), {
			'1.4.12-linux-idle': { state: 'idle' },
			'1.4.12-linux-sign-in': { state: 'blocked', kind: 'auth' },
			'1.4.12-win32-idle': { state: 'idle' },
			'1.4.14-darwin-busy': { state: 'working' },
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

suite('ptyd: a screen reading in a program\'s status, which its own word always outranks (CLIS-2.3, D80)', () => {

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

	test('a report takes the place of a screen reading too; a reset or a new prompt does not take a screen reading away, which is no record of the program\'s own', () => {
		const reported = new ProgramStatus();
		reported.observed({ state: 'working' });
		reported.report({ state: 'done' });
		reported.observed({ state: 'working' });
		assert.deepStrictEqual([reported.takesPart, reported.status!.state], [true, 'done']);
		const read = new ProgramStatus();
		read.observed({ state: 'working' });
		read.clear();
		read.promptStarted();
		assert.deepStrictEqual([read.takesPart, read.status!.state], [false, 'working']);
	});
});
