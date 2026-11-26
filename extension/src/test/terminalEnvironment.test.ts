/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { composeEnvironment, setVariable, variableOf, withHostVariables } from '../base/terminalEnvironment';

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

	test('the VS Code adapter strips ELECTRON_RUN_AS_NODE and supplies terminal colors', () => {
		const base = composeEnvironment({ host: { ELECTRON_RUN_AS_NODE: '1', TERM_PROGRAM: 'iTerm' }, terminal: { FACADE_AGENT: 'mine', COLORTERM: '256' } }, 'darwin');
		assert.deepStrictEqual(base, { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor', FACADE_AGENT: 'mine' });
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
		// macOS: the person's NODE_OPTIONS come back from where VS Code's launcher keeps them, as its terminal has them
		assert.deepStrictEqual(composeEnvironment({ host: { VSCODE_NODE_OPTIONS: '--max-old-space-size=8192', VSCODE_NODE_REPL_EXTERNAL_MODULE: '/repl.js' } }, 'darwin'),
			{ NODE_OPTIONS: '--max-old-space-size=8192', NODE_REPL_EXTERNAL_MODULE: '/repl.js', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
		assert.deepStrictEqual(composeEnvironment({ host: { VSCODE_NODE_OPTIONS: '--x' } }, 'linux'), { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' });
	});
});
