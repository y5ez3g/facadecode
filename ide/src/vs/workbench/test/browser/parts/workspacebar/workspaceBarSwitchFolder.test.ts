/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IPickOptions, IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { orderByRecent, SwitchFolderAction } from '../../../../browser/parts/workspacebar/workspaceBarSwitchFolder.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../../contrib/terminal/common/terminal.js';

suite('Workspace bar - Switch Folder', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const rows = ['/lab', '/wt/w2', '/notes', '/api'].map(path => URI.file(path));
	const key = (uri: URI) => uri.path;

	test('WS-53 the rows most recently gone to first, in that order, and the rest in the bar\'s order', () => {
		assert.deepStrictEqual({
			some: orderByRecent(rows, ['/notes', '/lab'], key).map(key),
			none: orderByRecent(rows, [], key).map(key),
			// one the bar no longer has is no row at all
			gone: orderByRecent(rows, ['/old', '/api'], key).map(key),
		}, {
			some: ['/notes', '/lab', '/wt/w2', '/api'],
			none: ['/lab', '/wt/w2', '/notes', '/api'],
			gone: ['/api', '/lab', '/wt/w2', '/notes'],
		});
	});

	test('WS-53 every row, a worktree under its repository\'s name, with the folder before this one selected; Enter goes there', async () => {
		const lab = new WorkspaceFolder({ uri: URI.file('/lab'), index: 0, name: 'lab' });
		const repository: IWorkspaceBarRepository = {
			kind: 'repository', main: lab.uri, folder: lab, branch: 'main', members: [lab],
			worktrees: [{ uri: URI.file('/wt/w2'), branch: 'feature/w2', label: 'feature/w2', exists: true, folder: undefined }]
		};
		const shown: string[] = [];
		let asked: { items: string[]; active: string | undefined; contextKey: string | undefined } | undefined;

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			recentRows: () => [URI.file('/notes'), URI.file('/wt/w2'), URI.file('/lab')],
			repositoryFor: (uri: URI) => uri.path === '/lab' || uri.path === '/wt/w2' ? repository : undefined,
			show: async (uri: URI) => { shown.push(uri.path); return { kind: 'shown' }; }
		});
		instantiationService.stub(IQuickInputService, {
			pick: (async (items: readonly IQuickPickItem[], options?: IPickOptions<IQuickPickItem>) => {
				const active = options?.activeItem as IQuickPickItem | undefined;
				asked = { items: items.map(item => `${item.label}${item.description ? ` - ${item.description}` : ''}`), active: active?.label, contextKey: options?.contextKey };
				return active;
			}) as IQuickInputService['pick']
		});
		instantiationService.stub(IWorkspaceBarCustomizationService, {
			get: (uri: URI) => uri.path === '/notes' ? { color: 'teal' as const } : undefined,
			nameFor: folder => folder.name
		});
		instantiationService.stub(IWorkspaceContextService, { getWorkspaceFolder: (uri: URI) => uri.path === '/lab' ? lab : uri.path === '/notes' ? new WorkspaceFolder({ uri, index: 1, name: 'notes' }) : null });
		instantiationService.stub(IUriIdentityService, { extUri });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(SwitchFolderAction.ID)!.handler(accessor));

		assert.deepStrictEqual({ asked, shown, skipsTheShell: DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(SwitchFolderAction.ID) }, {
			asked: {
				items: ['$(folder~folderteal) notes', '$(workspace-bar-worktree) feature/w2 - lab', '$(folder) lab'],
				active: '$(workspace-bar-worktree) feature/w2',
				contextKey: 'inFacadeSwitchFolderPicker'
			},
			shown: ['/wt/w2'],
			skipsTheShell: true
		});
	});
});
