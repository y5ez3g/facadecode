/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { IShellLaunchConfig, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { facadeRunProperties } from '../../../facadeCommands/common/facadeRun.js';
import { ShutdownReason, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { AGENT_TERMINAL_ICON, agentIcon, agentLaunchOf, AGENT_TITLE_TEMPLATE, BUILT_IN_LAUNCHERS, commandExecutable, executableFileNames, isAgentGoneAtStartup, isPathLike, readAgentNames, restoreAgentLaunch, searchPathEntries } from '../../common/terminalLaunchers.js';

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

	test('a path is checked where it points, not searched for - a backslash being a separator on Windows alone, as the agents\' extension takes it', () => {
		assert.deepStrictEqual([
			isPathLike('claude'),
			isPathLike('./claude'),
			isPathLike('C:\\tools\\claude.exe'),
			isPathLike('/usr/local/bin/claude')
		], [false, true, isWindows, true]);
	});

	test('a built-in is a name, a command and where its settings are, and carries no artwork at all', () => {
		// Naming a product to say what a button starts is nominative use and is fine; shipping its
		// mark is a separate permission that Apache-2.0 section 6 declines to grant in as many words.
		// There used to be an `icon` per row and an assertion that it held a codicon id rather than a
		// path or a url. Every agent is drawn with the same robot now, so there is no field for a mark
		// to arrive in - which is a stronger guarantee than a test that one has not.
		assert.deepStrictEqual(BUILT_IN_LAUNCHERS.map(l => [l.id, l.label, l.command, Object.keys(l).sort()]), [
			['claude', 'Claude Code', 'claude', ['command', 'id', 'label', 'setting']],
			['codex', 'Codex', 'codex', ['command', 'id', 'label', 'setting']],
			['agy', 'Antigravity', 'agy', ['command', 'id', 'label', 'setting']],
			['muse', 'Muse Code', 'muse', ['command', 'id', 'label', 'setting']]
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

	test('a built-in agent is drawn with the logo of the program its command starts; every custom agent with the robot, whatever program it runs (X-60)', () => {
		assert.deepStrictEqual([
			agentIcon('claude').id,
			agentIcon('codex --yolo').id,
			agentIcon('agy').id,
			agentIcon('muse').id,
			agentIcon('grok').id,
			agentIcon('"C:\\Program Files\\Claude\\Claude.EXE" --resume').id,	// a path, an extension, any case
			agentIcon('/usr/local/bin/codex').id,
			agentIcon('my-agent --fast').id,	// not one of ours: the robot
			agentIcon('').id,					// only a shell: the robot
			agentIcon('/Users/me/.local/bin/claude', true).id,	// a custom agent running the real claude: the robot
			agentIcon('codex', true).id
		], [
			'agent-claude',
			'agent-codex',
			'agent-antigravity',
			'agent-muse',
			'agent-grok',
			'agent-claude',
			'agent-codex',
			AGENT_TERMINAL_ICON.id,
			AGENT_TERMINAL_ICON.id,
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

	test('a terminal started now is kept with its name and title template when it is an agent\'s run - marked so, whatever its icon - and named; no other is, an ordinary terminal the person drew with the robot included (VC-06)', () => {
		const run = facadeRunProperties({ workspace: 'w', id: 1 });
		const configs: Record<string, IShellLaunchConfig> = {
			agent: { name: '@claude #a1', titleTemplate: '${sequence}${separator}@claude #a1', icon: agentIcon('claude'), reconnectionProperties: run },
			repainted: { name: '@codex #a2', icon: Codicon.terminal, reconnectionProperties: run },	// an agent's, given another icon
			robot: { name: 'pwsh', icon: AGENT_TERMINAL_ICON },	// an ordinary terminal drawn with the robot
			shell: { name: 'pwsh', icon: Codicon.terminal },
			unnamed: { icon: AGENT_TERMINAL_ICON, reconnectionProperties: run },
			// One a reload brought back, given its name again: kept already, not kept anew
			reconnecting: {
				name: '@claude #a1', icon: AGENT_TERMINAL_ICON, reconnectionProperties: run,
				attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: 'known', reconnectionProperties: run }
			},
		};

		assert.deepStrictEqual(Object.entries(configs).map(([which, config]) => [which, agentLaunchOf(config)]), [
			['agent', { name: '@claude #a1', titleTemplate: '${sequence}${separator}@claude #a1' }],
			['repainted', { name: '@codex #a2', titleTemplate: undefined }],
			['robot', undefined],
			['shell', undefined],
			['unnamed', undefined],
			['reconnecting', undefined],
		]);
	});

	test('WS-38 after a restart an agent is gone - what would come back in its tab is a new shell under its old output - and after a reload, or a crash, it is still running; a plain terminal, or one only drawn as an agent\'s, comes back either way', () => {
		const agent = { reconnectionProperties: facadeRunProperties({ workspace: 'w', id: 1 }) };
		const restarted = { startupKind: StartupKind.ReopenedWindow, lastShutdownReason: ShutdownReason.QUIT };

		assert.deepStrictEqual({
			restarted: isAgentGoneAtStartup(agent, restarted),
			reloaded: isAgentGoneAtStartup(agent, { startupKind: StartupKind.ReloadedWindow, lastShutdownReason: ShutdownReason.RELOAD }),
			crashed: isAgentGoneAtStartup(agent, { startupKind: StartupKind.ReopenedWindow, lastShutdownReason: undefined }),
			plain: isAgentGoneAtStartup({}, restarted)
		}, { restarted: true, reloaded: false, crashed: false, plain: false });
	});

	test('a reconnecting agent terminal - its run\'s, by its mark, whatever its icon - gets back its name and title template, found by its nonce, and nothing else does, an ordinary terminal drawn with the robot included (VC-06)', () => {
		const names = new Map([['known', { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE }], ['facade', { name: '@main · Claude Code' }]]);
		const run = facadeRunProperties({ workspace: 'w', id: 1 });
		const reconnecting = (nonce: string, icon: TerminalIcon, marked = true): IShellLaunchConfig => ({
			attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon, shellIntegrationNonce: nonce, reconnectionProperties: marked ? run : undefined }
		});
		const configs: Record<string, IShellLaunchConfig> = {
			agent: reconnecting('known', AGENT_TERMINAL_ICON),
			facade: reconnecting('facade', AGENT_TERMINAL_ICON),	// one of Facade's agents, whose name is its title
			unknown: reconnecting('other', AGENT_TERMINAL_ICON),
			repainted: reconnecting('known', Codicon.terminal),	// given another icon since, an agent's all the same
			robot: reconnecting('known', AGENT_TERMINAL_ICON, false),	// an ordinary terminal drawn with the robot
			started: {},										// a new terminal rather than a reconnecting one
		};

		const restored = Object.entries(configs).map(([which, config]) => [which, restoreAgentLaunch(config, names), config.name, config.titleTemplate]);

		assert.deepStrictEqual(restored, [
			['agent', true, 'Claude Code', AGENT_TITLE_TEMPLATE],
			['facade', true, '@main · Claude Code', undefined],
			['unknown', false, undefined, undefined],
			['repainted', true, 'Claude Code', AGENT_TITLE_TEMPLATE],
			['robot', false, undefined, undefined],
			['started', false, undefined, undefined],
		]);
	});

	test('a reconnecting agent terminal gets back its name and title template, its title as the pty host kept it - its CLI\'s own, the label made from it again once (N-03)', () => {
		const names = new Map([['codex', { name: '@codex #a3', titleTemplate: AGENT_TITLE_TEMPLATE }], ['plain', { name: '@main · Claude Code' }]]);
		const reconnecting = (nonce: string, title: string): IShellLaunchConfig => ({
			attachPersistentProcess: { id: 1, pid: 1, title, titleSource: TitleEventSource.Sequence, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: nonce, reconnectionProperties: facadeRunProperties({ workspace: 'w', id: 3 }) }
		});
		const configs = [reconnecting('codex', 'Fix it'), reconnecting('plain', 'Fix it')];

		configs.forEach(config => restoreAgentLaunch(config, names));

		assert.deepStrictEqual(configs.map(config => [config.name, config.titleTemplate, config.attachPersistentProcess?.title]), [
			['@codex #a3', AGENT_TITLE_TEMPLATE, 'Fix it'],
			['@main · Claude Code', undefined, 'Fix it'],
		]);
	});
});
