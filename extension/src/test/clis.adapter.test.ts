/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { activityOf, cliTitle, interruptVerified, MOST_SHOWN } from '../clis/activity';
import { composeEnvironment, runEnvironment, setVariable, variableOf, withHostVariables } from '../clis/environment';
import { displayLine, truncateCodePoints } from '../base/text';

suite('CLIs: the environment composer (CLIS-1.2)', () => {

	test('each layer over the one before: a string sets, null removes, an omitted name inherits; ${env:NAME} reads the host, an unset one empty', () => {
		const env = composeEnvironment({
			host: { A: 'host', B: 'host', C: 'host', HOME: '/home/me', UNSET: undefined },
			terminal: { A: 'terminal', B: null, D: '${env:HOME}/d:${env:NOPE}', E: 'terminal' },
			profile: { A: 'profile', E: null, F: 'profile ${env:C}' }
		}, 'linux');
		assert.deepStrictEqual(env, { A: 'profile', C: 'host', HOME: '/home/me', D: '/home/me/d:', F: 'profile host', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		assert.strictEqual(withHostVariables('${env:path}', { PATH: '/bin' }, 'linux'), '');
	});

	test('on Windows a variable named in any case is the same variable: one key is kept, in the case it had, and null removes it whatever the case', () => {
		const env = composeEnvironment({
			host: { Path: 'C:\\Windows', ComSpec: 'cmd.exe', Temp: 'C:\\t' },
			terminal: { PATH: 'C:\\tools;${env:PATH}' },
			profile: { comspec: null, TEMP: 'D:\\t' }
		}, 'win32');
		assert.deepStrictEqual(env, { Path: 'C:\\tools;C:\\Windows', Temp: 'D:\\t', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		// Elsewhere another case is another variable
		assert.deepStrictEqual(composeEnvironment({ host: { Path: 'a' }, terminal: { PATH: 'b' } }, 'linux'), { Path: 'a', PATH: 'b', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		const duplicates: { [name: string]: string } = { path: 'x', PATH: 'y' };
		setVariable(duplicates, 'Path', 'z', 'win32');
		assert.deepStrictEqual(duplicates, { path: 'z' });
		assert.strictEqual(variableOf({ pAtH: 'v' }, 'PATH', 'win32'), 'v');
	});

	test('no agent CLI inherits ELECTRON_RUN_AS_NODE; each run carries its own alias, set over any configured value', () => {
		const base = composeEnvironment({ host: { ELECTRON_RUN_AS_NODE: '1', TERM_PROGRAM: 'iTerm' }, terminal: { FACADE_AGENT: 'mine', COLORTERM: '256' } }, 'darwin');
		assert.deepStrictEqual(runEnvironment(base, '#a12', 'darwin'), { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor', FACADE_AGENT: '#a12' });
	});
});

suite('CLIs: activity and titles from what a run reports (CLIS-2.3)', () => {

	test('working is working; idle, done and blocked are not working, blocked with what it waits for; error is a known error; a pending probe, clear or reset is unknown', () => {
		assert.deepStrictEqual([
			activityOf({ state: 'working' }),
			activityOf({ state: 'idle' }),
			activityOf({ state: 'done' }),
			activityOf({ state: 'blocked', kind: 'permission', msg: 'Run  npm\ninstall?' }),
			activityOf({ state: 'blocked' }),
			activityOf({ state: 'error', msg: 'Rate limited' }),
			activityOf({ state: 'error' }),
			activityOf({ state: 'pending', negotiating: true }),
			activityOf({ state: 'pending' })
		], [
			{ activity: 'working', reporting: true },
			{ activity: 'not_working', reporting: true },
			{ activity: 'not_working', reporting: true },
			{ activity: 'not_working', reporting: true, blocker: { kind: 'permission', text: 'Run npm install?' } },
			{ activity: 'not_working', reporting: true },
			{ activity: 'not_working', reporting: true, error: { text: 'Rate limited' } },
			{ activity: 'not_working', reporting: true, error: {} },
			{ activity: 'unknown', reporting: true, unknown: 'waiting' },
			{ activity: 'unknown', reporting: true, unknown: 'cleared' }
		]);
	});

	test('a run whose CLI never took part in the protocol does not report: its activity is unknown, never inferred from a quiet screen', () => {
		assert.deepStrictEqual(activityOf(undefined), { activity: 'unknown', reporting: false, unknown: 'not_reporting' });
	});

	test('the report\'s title is preferred over the terminal\'s; only adapter-known decorations go, and a title that only names the CLI, its folder or the agent is none', () => {
		const context = { cwd: '/work/shop-app', name: 'Ada' };
		assert.deepStrictEqual([
			cliTitle('claude', 'Claude Code', { reported: 'Fixing the tests', terminal: '✳ Something else' }, context),
			cliTitle('claude', 'Claude Code', { terminal: '⠐ Refactoring parser' }, context),
			cliTitle('claude', 'Claude Code', { terminal: '✳ Claude Code' }, context),
			cliTitle('claude', 'Claude Code', { terminal: 'claude - shop-app' }, context),
			cliTitle('claude', 'Claude Code', { terminal: 'shop-app' }, context),
			cliTitle('claude', 'Claude Code', { terminal: 'Ada' }, context),
			// Punctuation the person typed is the title's own text, and so is a mark of a CLI without an adapter that knows it
			cliTitle('claude', 'Claude Code', { terminal: '✳ ★ Release v2 — notes!' }, context),
			cliTitle('other', 'Other', { terminal: '✳ ★ Release v2 — notes!' }, context),
			cliTitle('other', 'Other', { terminal: 'Other' }, context),
			cliTitle('claude', 'Claude Code', { terminal: '  \u202eevil\u200b  ' }, context),
			cliTitle('claude', 'Claude Code', {}, context)
		], ['Fixing the tests', 'Refactoring parser', undefined, undefined, undefined, undefined, '★ Release v2 — notes!', '✳ ★ Release v2 — notes!', undefined, 'evil', undefined]);
	});

	test('titles and status words are capped at 300 code points with an ellipsis, never splitting a character', () => {
		const long = `${'a'.repeat(298)}🌍🌍tail`;
		const title = cliTitle('claude', 'Claude Code', { terminal: long }, { cwd: '/w', name: 'n' })!;
		assert.strictEqual([...title].length, MOST_SHOWN);
		assert.strictEqual(title, `${'a'.repeat(298)}🌍…`);
		assert.deepStrictEqual([truncateCodePoints('ab🌍cd', 4), truncateCodePoints('ab🌍', 3), truncateCodePoints('abc', 0)], ['ab🌍…', 'ab🌍', '']);
		assert.strictEqual(displayLine('a\tb\r\nc\u0007d\u202e', 10), 'a b c d');
	});

	test('an exit is a verified interrupt only by a built-in adapter\'s evidence: exit 130 or SIGINT just after a Ctrl+C; without an adapter, never', () => {
		assert.deepStrictEqual([
			interruptVerified('claude', { code: 130, ctrlC: true }),
			interruptVerified('claude', { signal: 'SIGINT', ctrlC: true }),
			interruptVerified('claude', { code: 130, ctrlC: false }),
			interruptVerified('claude', { code: 1, ctrlC: true }),
			interruptVerified('other', { code: 130, ctrlC: true })
		], [true, true, false, false, false]);
	});
});
