/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarAgentsService } from '../../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { agentsByFolder, TerminalLauncherWorkspaceBar } from '../../browser/terminalLauncherWorkspaceBar.js';

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
			upcastPartial<IFolderTerminalsService>({ folderOf: agent => { const path = folders.get(agent); return path ? upcastPartial<IWorkspaceFolder>({ uri: URI.file(path) }) : undefined; } }),
			upcastPartial<IWorkspaceBarAgentsService>({ set: reported => { told.push(reported.map(({ folder, icons }) => `${folder.path}: ${icons.map(icon => icon.id).join(' ')}`)); } }),
			upcastPartial<IWorkspaceBarService>({ onDidRestoreEditors: editorsRestored.event }),
			upcastPartial<IActiveFolderService>({ onDidChangeActiveFolder: activeFolderChanged.event }),
			upcastPartial<IWorkspaceContextService>({ onDidChangeWorkspaceFolders: foldersChanged.event })
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
