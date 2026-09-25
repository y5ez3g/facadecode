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
import { IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { foldersToRemove } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';

suite('Workspace bar - removing a folder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const isEqual = (a: URI, b: URI) => a.toString() === b.toString();
	const member = (path: string) => new WorkspaceFolder({ uri: URI.file(path), index: 0, name: path });

	const repository: IWorkspaceBarRepository = {
		kind: 'repository',
		main: URI.file('/lab'),
		folder: member('/lab'),
		branch: 'main',
		// The checkout under a second spelling too - a link to it - which is one row with the first.
		members: [member('/lab'), member('/link-lab'), member('/wt/w2')],
		worktrees: [
			{ uri: URI.file('/wt/w2'), branch: 'w2', label: 'w2', exists: true, folder: member('/wt/w2') },
			{ uri: URI.file('/wt/w10'), branch: 'w10', label: 'w10', exists: true, folder: undefined },
		]
	};

	test('a repository takes every other folder of its row with it; anything else goes alone', () => {
		assert.deepStrictEqual({
			'repository row': foldersToRemove(URI.file('/lab'), repository, isEqual).map(uri => uri.path),
			'plain folder': foldersToRemove(URI.file('/notes'), undefined, isEqual).map(uri => uri.path),
			'a worktree itself': foldersToRemove(URI.file('/wt/w2'), repository, isEqual).map(uri => uri.path),
		}, {
			'repository row': ['/lab', '/link-lab', '/wt/w2'],
			'plain folder': ['/notes'],
			'a worktree itself': ['/wt/w2'],
		});
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
			getWorkspaceFolder: uri => folders.find(folder => extUri.isEqualOrParent(uri, folder.uri)) ?? null
		});
		instantiationService.stub(IUriIdentityService, { extUri });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('facade.workspaceBar.customizeFolder')!.handler(accessor, target));
		return said;
	}

	test('a repository\'s row whose checkout is not in the workspace customizes that row, not the folder it is inside of', async () => {
		assert.deepStrictEqual({
			repository: await customize(lab.main),
			folder: await customize(home.uri),
			worktree: await customize(w2.uri),
		}, {
			repository: ['ask lab', 'keep /home/lab {"name":"Named"}'],
			folder: ['ask home', 'keep /home {"name":"Named"}'],
			worktree: ['ask feature/w2, a worktree', 'keep /wt/w2 {"name":"Named"}'],
		});
	});
});
