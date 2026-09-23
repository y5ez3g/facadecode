/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { AGENT_TERMINAL_ICON, BUILT_IN_LAUNCHERS, commandExecutable, executableFileNames, isAgentTerminalIcon, isPathLike, searchPathEntries } from '../../common/terminalLaunchers.js';

suite('Terminal launchers - what to look for', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the word a command line starts with', () => {
		assert.deepStrictEqual([
			commandExecutable('claude'),
			commandExecutable('  codex  '),
			commandExecutable('agy --yolo'),
			commandExecutable('"C:/Program Files/x/muse.exe" chat'),	// quoted: the space is inside the name
			commandExecutable(`'/opt/my tools/grok' --version`),
			commandExecutable(''),
			commandExecutable('   ')
		], [
			'claude',
			'codex',
			'agy',
			'C:/Program Files/x/muse.exe',
			'/opt/my tools/grok',
			undefined,	// no command is not a missing tool - `New Terminal` is one of these
			undefined
		]);
	});

	test('the file names a bare command could be', () => {
		assert.deepStrictEqual([
			executableFileNames('claude', []),	// no extensions is every platform but Windows
			executableFileNames('claude', ['.exe', '.cmd']),
			executableFileNames('claude', ['.ps1']),	// whatever PATHEXT actually said
			executableFileNames('claude.exe', ['.exe', '.cmd']),	// already carries one
			executableFileNames('claude.CMD', ['.exe', '.cmd'])	// and case does not hide it
		], [
			['claude'],
			['claude.exe', 'claude.cmd'],
			['claude.ps1'],
			['claude.exe'],
			['claude.CMD']
		]);
	});

	test('a path is checked where it points, not searched for', () => {
		assert.deepStrictEqual([
			isPathLike('claude'),
			isPathLike('./claude'),
			isPathLike('C:\\tools\\claude.exe'),
			isPathLike('/usr/local/bin/claude')
		], [false, true, true, true]);
	});

	test('a built-in is a name and a command, and carries no artwork at all', () => {
		// Naming a product to say what a button starts is nominative use and is fine; shipping its
		// mark is a separate permission that Apache-2.0 section 6 declines to grant in as many words.
		// There used to be an `icon` per row and an assertion that it held a codicon id rather than a
		// path or a url. Every agent is drawn with the same robot now, so there is no field for a mark
		// to arrive in - which is a stronger guarantee than a test that one has not.
		assert.deepStrictEqual(BUILT_IN_LAUNCHERS.map(l => [l.id, l.label, l.command, Object.keys(l).sort()]), [
			['claude', 'Claude Code', 'claude', ['command', 'id', 'label']],
			['codex', 'Codex', 'codex', ['command', 'id', 'label']],
			['antigravity', 'Antigravity', 'agy', ['command', 'id', 'label']],
			['muse', 'Muse Code', 'muse', ['command', 'id', 'label']],
			['grok', 'Grok Build', 'grok', ['command', 'id', 'label']]
		]);
	});

	test('a POSIX PATH splits on colons and keeps case apart', () => {
		assert.deepStrictEqual(searchPathEntries('/usr/bin: /opt/Tools ::/opt/tools:/usr/bin', ':', true), [
			'/usr/bin',
			'/opt/Tools',	// a different directory from /opt/tools where case matters
			'/opt/tools'
		]);
	});

	test('a Windows PATH splits on semicolons, and one directory spelled two ways is one', () => {
		assert.deepStrictEqual(searchPathEntries('C:\\tools; C:/Tools ;;C:\\Windows', ';', false), [
			'C:\\tools',
			'C:\\Windows'
		]);
	});

	test('a terminal is an agent\'s when it is drawn with the agent glyph', () => {
		assert.deepStrictEqual([
			isAgentTerminalIcon(AGENT_TERMINAL_ICON),
			isAgentTerminalIcon(Codicon.terminal),		// a plain terminal
			isAgentTerminalIcon(undefined),				// one that never had an icon
			isAgentTerminalIcon(URI.file('/robot.png')),	// an icon that is a file, not a glyph
			isAgentTerminalIcon({ id: AGENT_TERMINAL_ICON.id })	// the same glyph, rebuilt from a stored record
		], [true, false, false, false, true]);
	});
});
