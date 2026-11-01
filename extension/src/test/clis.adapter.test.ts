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

	test('the host\'s environment is inherited as VS Code\'s integrated terminal inherits it: without the editor\'s own variables, nor an earlier session\'s - a configured layer still sets them (CLIS-1.2)', () => {
		const host = {
			PATH: '/bin', HOME: '/home/me', FACADE_HOME: '/tmp/facade', TMUX: '/tmp/tmux-1/default,1,0',
			// The editor's own, as its extension host has them
			VSCODE_CWD: '/Applications', VSCODE_NLS_CONFIG: '{}', VSCODE_IPC_HOOK: '/tmp/main.sock', VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_IPC_HOOK_CLI: '/tmp/cli.sock', VSCODE_PORTABLE: '/portable', VSCODE_SHELL_LOGIN: '1', VSCODE_ENV_APPEND: 'A=1',
			ELECTRON_NO_ATTACH_CONSOLE: '1', SNAP: '/snap/code/1', SNAP_NAME: 'code', SNAPSHOT: 'kept', GDK_PIXBUF_MODULE_FILE: '/snap/x',
			// An earlier run's and a Claude Code session's, as a window opened from inside one inherits them
			FACADE_AGENT: '#a3', FACADE_CODE_SESSION_FILE: '/old/r.session.json', FACADE_CODE_TITLE_COMMAND: 'old', FACADE_RUN: 'run-old', FACADE_PTYD: '/old.sock', FACADE_ELECTRON_RUN_AS_NODE: '1',
			CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_BRIDGE_SESSION_ID: 'y', CLAUDE_CODE_EXECPATH: '/claude', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_JOB_DIR: '/jobs/1',
			CLAUDE_CONFIG_DIR: '/home/me/.claude-work'
		};
		const kept = { PATH: '/bin', HOME: '/home/me', FACADE_HOME: '/tmp/facade', TMUX: '/tmp/tmux-1/default,1,0', VSCODE_IPC_HOOK_CLI: '/tmp/cli.sock', VSCODE_PORTABLE: '/portable', VSCODE_SHELL_LOGIN: '1', VSCODE_ENV_APPEND: 'A=1', SNAPSHOT: 'kept', CLAUDE_CONFIG_DIR: '/home/me/.claude-work', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' };
		assert.deepStrictEqual(composeEnvironment({ host }, 'linux'), kept);
		// On Windows the names compare in any case
		assert.deepStrictEqual(composeEnvironment({ host: { Path: 'C:\\bin', vscode_cwd: 'C:\\x', ClaudeCode: '1', Facade_Code_Session_File: 'C:\\r' } }, 'win32'), { Path: 'C:\\bin', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		// A person's explicit setting is theirs; the launch then sets the run's own variables over what is left
		assert.deepStrictEqual(composeEnvironment({ host, launch: { CLAUDE_CODE_ENTRYPOINT: 'mine', VSCODE_EXTRA: 'mine' } }, 'linux'), { ...kept, CLAUDE_CODE_ENTRYPOINT: 'mine', VSCODE_EXTRA: 'mine' });
		assert.strictEqual(runEnvironment(composeEnvironment({ host }, 'linux'), '#a9', 'linux').FACADE_AGENT, '#a9');
		// macOS: the person's NODE_OPTIONS come back from where VS Code's launcher keeps them, as its terminal has them
		assert.deepStrictEqual(composeEnvironment({ host: { VSCODE_NODE_OPTIONS: '--max-old-space-size=8192', VSCODE_NODE_REPL_EXTERNAL_MODULE: '/repl.js' } }, 'darwin'),
			{ NODE_OPTIONS: '--max-old-space-size=8192', NODE_REPL_EXTERNAL_MODULE: '/repl.js', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		assert.deepStrictEqual(composeEnvironment({ host: { VSCODE_NODE_OPTIONS: '--x' } }, 'linux'), { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
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

	test('Antigravity, Muse Code, OpenCode and Pi: a title that only names the CLI, its folder or the agent - alone or joined - is none; a title of work is kept whole, the report\'s first', () => {
		const context = { cwd: '/work/shop-app', name: 'Ada' };
		assert.deepStrictEqual([
			cliTitle('pi', 'Pi', { terminal: 'π - shop-app' }, context),
			cliTitle('pi', 'Pi', { terminal: 'π - Fix login - shop-app' }, context),
			cliTitle('pi', 'Pi', { terminal: 'pi' }, context),
			cliTitle('opencode', 'OpenCode', { terminal: 'OpenCode' }, context),
			cliTitle('opencode', 'OpenCode', { terminal: 'OC | shop-app' }, context),
			cliTitle('opencode', 'OpenCode', { terminal: 'OC | Fix the login bug' }, context),
			cliTitle('opencode', 'OpenCode', { reported: 'Fix the login bug', terminal: 'OC | Fix the login bug' }, context),
			cliTitle('muse', 'Muse Code', { terminal: 'Muse Code' }, context),
			cliTitle('muse', 'Muse Code', { terminal: 'muse - shop-app' }, context),
			cliTitle('muse', 'Muse Code', { terminal: 'Refactoring the parser' }, context),
			cliTitle('agy', 'Antigravity', { terminal: 'agy' }, context),
			cliTitle('agy', 'Antigravity', { terminal: 'Antigravity · shop-app' }, context),
			cliTitle('agy', 'Antigravity', { terminal: 'Ada' }, context)
		], [undefined, 'π - Fix login - shop-app', undefined, undefined, undefined, 'OC | Fix the login bug', 'Fix the login bug', undefined, undefined, 'Refactoring the parser', undefined, undefined, undefined]);
	});

	test('the placeholder OpenCode reports for a session it has not named yet is no title: its terminal\'s is read instead; a title a person gave is kept, and only its adapter knows it (CLIS-2.3)', () => {
		const context = { cwd: '/work/shop-app', name: 'Ada' };
		const placeholder = 'New session - 2026-10-31T03:29:22.759Z';
		assert.deepStrictEqual([
			cliTitle('opencode', 'OpenCode', { reported: placeholder, terminal: 'OpenCode' }, context),
			cliTitle('opencode', 'OpenCode', { reported: placeholder, terminal: 'OC | Reply OK only' }, context),
			cliTitle('opencode', 'OpenCode', { reported: 'Child session - 2026-10-31T03:29:22.759Z' }, context),
			cliTitle('opencode', 'OpenCode', { reported: 'New session - plan the release' }, context),
			cliTitle('pi', 'Pi', { reported: placeholder }, context)
		], [undefined, 'OC | Reply OK only', undefined, 'New session - plan the release', placeholder]);
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
		// Every built-in ends on SIGINT as POSIX programs do; Pi's and OpenCode's own Ctrl+C exit is 0, a normal exit anyway
		assert.deepStrictEqual(['codex', 'agy', 'muse', 'opencode', 'pi'].map(cli => [
			interruptVerified(cli, { code: 130, ctrlC: true }),
			interruptVerified(cli, { signal: 'SIGINT', ctrlC: true }),
			interruptVerified(cli, { code: 130, ctrlC: false }),
			interruptVerified(cli, { code: 1, ctrlC: true })
		]), Array(5).fill([true, true, false, false]));
	});
});
