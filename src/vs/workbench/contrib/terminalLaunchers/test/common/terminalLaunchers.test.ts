/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { IShellLaunchConfig, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { AGENT_TERMINAL_ICON, agentIcon, agentLaunchOf, AGENT_TITLE_TEMPLATE, BUILT_IN_LAUNCHERS, commandExecutable, executableFileNames, isAgentTerminalIcon, isPathLike, readAgentNames, restoreAgentLaunch, searchPathEntries } from '../../common/terminalLaunchers.js';

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

	test('a terminal is an agent\'s when it is drawn with an agent\'s icon', () => {
		assert.deepStrictEqual([
			isAgentTerminalIcon(AGENT_TERMINAL_ICON),
			isAgentTerminalIcon(agentIcon('claude')),	// a built-in agent's logo
			isAgentTerminalIcon(Codicon.terminal),		// a plain terminal
			isAgentTerminalIcon(Codicon.claude),		// the font's mark, which is not an agent's icon
			isAgentTerminalIcon(undefined),				// one that never had an icon
			isAgentTerminalIcon(URI.file('/robot.png')),	// an icon that is a file, not a glyph
			isAgentTerminalIcon({ id: AGENT_TERMINAL_ICON.id }),	// the same glyph, rebuilt from a stored record
			isAgentTerminalIcon({ id: agentIcon('codex').id })		// and a logo, rebuilt the same way
		], [true, true, false, false, false, false, true, true]);
	});

	test('an agent is drawn with the logo of the program its command starts', () => {
		assert.deepStrictEqual([
			agentIcon('claude').id,
			agentIcon('codex --yolo').id,
			agentIcon('agy').id,
			agentIcon('muse').id,
			agentIcon('grok').id,
			agentIcon('"C:\\Program Files\\Claude\\Claude.EXE" --resume').id,	// a path, an extension, any case
			agentIcon('/usr/local/bin/codex').id,
			agentIcon('my-agent --fast').id,	// not one of ours: the robot
			agentIcon('').id					// only a shell: the robot
		], [
			'agent-claude',
			'agent-codex',
			'agent-antigravity',
			'agent-muse',
			'agent-grok',
			'agent-claude',
			'agent-codex',
			AGENT_TERMINAL_ICON.id,
			AGENT_TERMINAL_ICON.id
		]);
	});
});

suite('Terminal launchers - an agent across a reload', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the names kept for the agents are read back, a name on its own as the agent button kept it, and storage that cannot be read gives none', () => {
		assert.deepStrictEqual([
			[...readAgentNames(JSON.stringify({ first: { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }, second: { name: '@main · Claude Code' } }))],
			[...readAgentNames(JSON.stringify({ first: 'Claude Code', second: 'Codex' }))],
			[...readAgentNames(JSON.stringify({ first: 'Claude Code', second: 7, third: '', fourth: { name: 7 } }))],
			[...readAgentNames('{ not json')],
			[...readAgentNames(JSON.stringify(['Claude Code']))],
			[...readAgentNames(undefined)],
		], [
			[['first', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }], ['second', { name: '@main · Claude Code', titleTemplate: undefined }]],
			[['first', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }], ['second', { name: 'Codex', titleTemplate: AGENT_TITLE_TEMPLATE }]],
			[['first', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }]],
			[],
			[],
			[],
		]);
	});

	test('a terminal started now is kept with its name and title template when it is drawn as an agent\'s and named, whoever started it, and no other is', () => {
		const configs: Record<string, IShellLaunchConfig> = {
			button: { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE, icon: agentIcon('claude') },
			facade: { name: '@main #1 · Claude Code', icon: AGENT_TERMINAL_ICON },	// one of Facade's agents, whose name is its title
			shell: { name: 'pwsh', icon: Codicon.terminal },
			unnamed: { icon: AGENT_TERMINAL_ICON },
			// One a reload brought back, given its name again: kept already, not kept anew
			reconnecting: {
				name: 'Claude Code', icon: AGENT_TERMINAL_ICON,
				attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: 'known' }
			},
		};

		assert.deepStrictEqual(Object.entries(configs).map(([which, config]) => [which, agentLaunchOf(config)]), [
			['button', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }],
			['facade', { name: '@main #1 · Claude Code', titleTemplate: undefined }],
			['shell', undefined],
			['unnamed', undefined],
			['reconnecting', undefined],
		]);
	});

	test('a reconnecting agent terminal gets back its name and title template, found by its nonce, and nothing else does', () => {
		const names = new Map([['known', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }], ['facade', { name: '@main · Claude Code' }]]);
		const reconnecting = (nonce: string, icon: TerminalIcon): IShellLaunchConfig => ({
			attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon, shellIntegrationNonce: nonce }
		});
		const configs: Record<string, IShellLaunchConfig> = {
			agent: reconnecting('known', AGENT_TERMINAL_ICON),
			facade: reconnecting('facade', AGENT_TERMINAL_ICON),	// one of Facade's agents, whose name is its title
			unknown: reconnecting('other', AGENT_TERMINAL_ICON),
			repainted: reconnecting('known', Codicon.terminal),	// given another icon since, so no longer an agent's
			started: {},										// a new terminal rather than a reconnecting one
		};

		const restored = Object.entries(configs).map(([which, config]) => [which, restoreAgentLaunch(config, names), config.name, config.titleTemplate]);

		assert.deepStrictEqual(restored, [
			['agent', true, 'Claude Code', AGENT_TITLE_TEMPLATE],
			['facade', true, '@main · Claude Code', undefined],
			['unknown', false, undefined, undefined],
			['repainted', false, undefined, undefined],
			['started', false, undefined, undefined],
		]);
	});
});
