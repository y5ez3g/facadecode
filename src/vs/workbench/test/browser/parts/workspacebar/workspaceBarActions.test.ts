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
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';

suite('Workspace bar - Remove Folder from Workspace', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-33 Remove Folder from Workspace on a row - or from the palette, on the focused one - goes the one way every removal goes', async () => {
		const removed: string[][] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			folderForCommand: () => URI.file('/focused'),
			remove: async uris => { removed.push(uris.map(uri => uri.path)); return { kind: 'removed', folders: uris }; }
		});
		const run = (target?: URI) => instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('facade.workspaceBar.removeFolder')!.handler(accessor, target));

		await run(URI.file('/lab'));
		await run();

		assert.deepStrictEqual(removed, [['/lab'], ['/focused']]);
	});
});

suite('Workspace bar - Customize', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const home = new WorkspaceFolder({ uri: URI.file('/home'), index: 0, name: 'home' });
	const w2 = new WorkspaceFolder({ uri: URI.file('/wt/w2'), index: 1, name: 'w2' });
	/** `lab`, whose own checkout is inside `home` and not in the workspace itself - only its worktree is. */
	const lab: IWorkspaceBarRepository = { kind: 'repository', main: URI.file('/home/lab'), folder: undefined, branch: 'main', members: [w2], worktrees: [{ uri: w2.uri, branch: 'feature/w2', label: 'feature/w2', exists: true, folder: w2 }] };

	/** What Customize... on the row of `target` asked the dialog, and what it kept, with `home` and `w2` in the workspace. */
	async function customize(target: URI): Promise<string[]> {
		const said: string[] = [];
		const folders: IWorkspaceFolder[] = [home, w2];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			folderForCommand: () => undefined,
			repositoryFor: uri => extUri.isEqual(uri, lab.main) || extUri.isEqual(uri, w2.uri) ? lab : undefined
		});
		instantiationService.stub(IWorkspaceBarCustomizationService, {
			get: () => undefined,
			set: (uri, customization) => { said.push(`keep ${uri.path} ${JSON.stringify(customization)}`); }
		});
		instantiationService.stub(IWorkspaceBarDialogService, {
			showCustomizeDialog: async target => {
				said.push(`ask ${target.defaultName}${target.worktree ? ', a worktree' : ''}`);
				return { name: 'Named' };
			}
		});
		instantiationService.stub(IWorkspaceContextService, {
			getWorkspace: () => ({ id: 'test', folders }),
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			getWorkspaceFolder: uri => folders.find(folder => extUri.isEqualOrParent(uri, folder.uri)) ?? null
		});
		instantiationService.stub(IWorkspaceEditingService, {
			renameFolder: async (uri: URI, name: string | undefined) => { said.push(`rename ${uri.path} ${name}`); }
		});
		instantiationService.stub(IUriIdentityService, { extUri });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('facade.workspaceBar.customizeFolder')!.handler(accessor, target));
		return said;
	}

	test('WS-34 a repository\'s row whose checkout is not in the workspace customizes that row, not the folder it is inside of; a folder in the list is named in the workspace file', async () => {
		assert.deepStrictEqual({
			repository: await customize(lab.main),
			folder: await customize(home.uri),
			worktree: await customize(w2.uri),
		}, {
			repository: ['ask lab', 'keep /home/lab {"name":"Named"}'],
			folder: ['ask home', 'keep /home {}', 'rename /home Named'],
			worktree: ['ask feature/w2, a worktree', 'keep /wt/w2 {}', 'rename /wt/w2 Named'],
		});
	});
});
