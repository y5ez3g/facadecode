/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarAgentsService } from '../../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { FOLLOW_FOLDER, IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { agentsByFolder, runningWork, TerminalLauncherWorkspaceBar } from '../../browser/terminalLauncherWorkspaceBar.js';

/** An agent's terminal, as much of one as the bar is told about: when it was made, and its tab's icon. */
class TestAgent extends mock<ITerminalInstance>() {
	constructor(override readonly instanceId: number, override readonly icon: TerminalIcon | undefined) {
		super();
	}
}

suite('Agent launchers - the agents the workspace bar shows', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the bar is told on start, again once each change has fired all its events, and when a switch moves the agents', async () => {
		const agentsChanged = store.add(new Emitter<void>());
		const activeFolderChanged = store.add(new Emitter<void>());
		const editorsRestored = store.add(new Emitter<void>());
		const foldersChanged = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		let agents: ITerminalInstance[] = [];
		const folders = new Map<ITerminalInstance, string>();
		const told: string[][] = [];
		store.add(new TerminalLauncherWorkspaceBar(
			upcastPartial<ITerminalLauncherService>({ onDidChangeAgentTerminals: agentsChanged.event, get agentTerminals() { return agents; } }),
			upcastPartial<IFolderTerminalsService>({ folderOf: agent => { const path = folders.get(agent); return path ? URI.file(path) : undefined; } }),
			upcastPartial<IWorkspaceBarAgentsService>({ set: reported => { told.push(reported.map(({ folder, icons }) => `${folder.path}: ${icons.map(icon => icon.id).join(' ')}`)); }, registerWorkProvider: () => Disposable.None }),
			upcastPartial<IWorkspaceBarService>({ onDidRestoreEditors: editorsRestored.event }),
			upcastPartial<IActiveFolderService>({ onDidChangeActiveFolder: activeFolderChanged.event }),
			upcastPartial<IWorkspaceContextService>({ onDidChangeWorkspaceFolders: foldersChanged.event }),
			new TestConfigurationService()
		));

		// An agent starts in /lab
		const claude = new TestAgent(1, ThemeIcon.fromId('agent-claude'));
		agents = [claude];
		folders.set(claude, '/lab');
		agentsChanged.fire();
		await timeout(1);

		// The window moves to /wt/w2 and a second agent starts there: three events, told once
		const codex = new TestAgent(2, ThemeIcon.fromId('agent-codex'));
		agents = [claude, codex];
		folders.set(codex, '/wt/w2');
		activeFolderChanged.fire();
		editorsRestored.fire();
		agentsChanged.fire();
		await timeout(1);

		// The first agent is closed
		agents = [codex];
		agentsChanged.fire();
		await timeout(1);

		assert.deepStrictEqual(told, [
			[],
			['/lab: agent-claude'],
			['/lab: agent-claude', '/wt/w2: agent-codex'],
			['/wt/w2: agent-codex'],
		]);
	});

	test('the bar is told again when terminals start or stop following folders, which moves an agent of the editor area between its folder and the window', async () => {
		const configuration = new TestConfigurationService();
		const agent = new TestAgent(1, ThemeIcon.fromId('agent-claude'));
		let folder: URI | undefined = URI.file('/lab');
		const told: string[][] = [];
		store.add(new TerminalLauncherWorkspaceBar(
			upcastPartial<ITerminalLauncherService>({ onDidChangeAgentTerminals: Event.None, agentTerminals: [agent] }),
			upcastPartial<IFolderTerminalsService>({ folderOf: () => folder }),
			upcastPartial<IWorkspaceBarAgentsService>({ set: reported => { told.push(reported.map(({ folder }) => folder.path)); }, registerWorkProvider: () => Disposable.None }),
			upcastPartial<IWorkspaceBarService>({ onDidRestoreEditors: Event.None }),
			upcastPartial<IActiveFolderService>({ onDidChangeActiveFolder: Event.None }),
			upcastPartial<IWorkspaceContextService>({ onDidChangeWorkspaceFolders: Event.None }),
			configuration
		));

		// Not following folders: the editor area's agent is the window's, on no row
		folder = undefined;
		configuration.onDidChangeConfigurationEmitter.fire(upcastPartial<IConfigurationChangeEvent>({ affectsConfiguration: (key: string) => key === FOLLOW_FOLDER }));
		await timeout(1);

		assert.deepStrictEqual(told, [['/lab'], []]);
	});

	test('WS-33 WS-49 what taking a folder out or closing the window stops, of the terminals it ends: its agents whose process runs, and its other terminals running one - oldest first, an agent by the name it was started under, a terminal by its title', () => {
		const terminal = (instanceId: number, title: string, state: { name?: string; exitCode?: number; hasChildProcesses?: boolean; isDisposed?: boolean } = {}) =>
			upcastPartial<ITerminalInstance>({ instanceId, title, shellLaunchConfig: { name: state.name }, exitCode: state.exitCode, hasChildProcesses: !!state.hasChildProcesses, isDisposed: !!state.isDisposed });
		const claude = terminal(5, 'Claude Code', { name: 'Claude Code' });
		// The title its program set, as ping sets `PING`
		const pinger = terminal(6, 'PING', { name: 'Pinger' });
		const finished = terminal(2, 'Codex', { name: 'Codex', exitCode: 0 });
		const server = terminal(3, 'npm run dev', { hasChildProcesses: true });
		const idle = terminal(1, 'pwsh');
		const closed = terminal(4, 'npm test', { hasChildProcesses: true, isDisposed: true });

		assert.deepStrictEqual(runningWork([pinger, claude, finished, server, idle, closed], new Set([pinger, claude, finished])), [
			{ id: 3, kind: 'terminal', name: 'npm run dev' },
			{ id: 5, kind: 'agent', name: 'Claude Code' },
			{ id: 6, kind: 'agent', name: 'Pinger' },
		]);
	});

	test('each folder\'s agents in the order they were started, a custom icon as the robot, and one in the panel on no row', () => {
		const lab = URI.file('/lab');
		const w2 = URI.file('/wt/w2');
		const claude = new TestAgent(3, ThemeIcon.fromId('agent-claude'));
		const codex = new TestAgent(1, ThemeIcon.fromId('agent-codex'));
		const ownIcon = new TestAgent(2, URI.file('/icons/agent.svg'));
		const inPanel = new TestAgent(4, ThemeIcon.fromId('agent-claude'));
		const folders = new Map<ITerminalInstance, URI>([[claude, lab], [codex, lab], [ownIcon, w2]]);

		const agents = agentsByFolder([claude, inPanel, ownIcon, codex], agent => folders.get(agent));

		assert.deepStrictEqual(agents.map(({ folder, icons }) => ({ folder: folder.path, icons: icons.map(icon => icon.id) })), [
			{ folder: '/lab', icons: ['agent-codex', 'agent-claude'] },
			{ folder: '/wt/w2', icons: ['robot'] },
		]);
	});
});
