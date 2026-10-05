/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUri } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { agentsStoppedBy, foldersToRemove } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarAgentsService } from '../../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';

suite('Workspace bar - removing a folder', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

	/** The agents running in each folder, by its path: one robot for each. */
	const agentsIn = (counts: Map<string, number>) => (uri: URI) => Array.from({ length: counts.get(uri.path) ?? 0 }, () => ThemeIcon.fromId('robot'));

	test('what it stops: the agents in every folder it takes out and, with the last of a repository\'s, those under the rows that go with it', () => {
		// `api`, whose checkout never joined the workspace - only its worktree `fix` did - and whose worktree `login` did not either
		const fix = member('/wt/fix');
		const api: IWorkspaceBarRepository = {
			kind: 'repository',
			main: URI.file('/api'),
			folder: undefined,
			branch: 'main',
			members: [fix],
			worktrees: [
				{ uri: fix.uri, branch: 'fix', label: 'fix', exists: true, folder: fix },
				{ uri: URI.file('/wt/login'), branch: 'login', label: 'login', exists: true, folder: undefined },
			]
		};
		const agentsService = { agentsIn: agentsIn(new Map([['/lab', 1], ['/wt/w2', 2], ['/wt/w10', 4], ['/notes', 8], ['/wt/fix', 16], ['/wt/login', 32], ['/api', 64]])) };
		const stopped = (path: string, of: IWorkspaceBarRepository | undefined) => agentsStoppedBy(of, foldersToRemove(URI.file(path), of, isEqual), agentsService, isEqual);

		assert.deepStrictEqual({
			'repository row': stopped('/lab', repository),
			'plain folder': stopped('/notes', undefined),
			'a worktree, the repository staying': stopped('/wt/w2', repository),
			'a repository\'s last folder, a worktree': stopped('/wt/fix', api),
		}, {
			'repository row': 7,
			'plain folder': 8,
			'a worktree, the repository staying': 2,
			'a repository\'s last folder, a worktree': 112,
		});
	});

	/** What Remove Folder on the row of `target` asked, with `agents` running by folder, once confirmed: the glyph, the last paragraph, and what it took out. */
	async function removeFolder(target: URI, agents: Map<string, number>): Promise<{ type: string | undefined; said: string; removed: string[] }> {
		let asked: IConfirmation | undefined;
		const removed: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			folderForCommand: () => undefined,
			repositoryFor: uri => repository.members.some(folder => isEqual(folder.uri, uri)) || isEqual(repository.main, uri) ? repository : undefined,
			remove: async uris => { removed.push(...uris.map(uri => uri.path)); }
		});
		instantiationService.stub(IWorkspaceBarAgentsService, { agentsIn: agentsIn(agents) });
		instantiationService.stub(IDialogService, {
			confirm: async confirmation => {
				asked = confirmation;
				return { confirmed: true };
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: uri => uri.path });
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IUriIdentityService, { extUri });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('facade.workspaceBar.removeFolder')!.handler(accessor, target));
		const detail = typeof asked?.detail === 'string' ? asked.detail : asked?.detail?.value ?? '';
		return { type: asked?.type === undefined ? undefined : String(asked.type), said: detail.split('\n\n').pop()!, removed };
	}

	test('it says how many agents it stops, and warns; a folder that runs none is removed as before', async () => {
		assert.deepStrictEqual({
			'repository row': await removeFolder(URI.file('/lab'), new Map([['/lab', 1], ['/wt/w10', 2]])),
			'one agent': await removeFolder(URI.file('/notes'), new Map([['/notes', 1]])),
			'none': await removeFolder(URI.file('/notes'), new Map([['/lab', 1]])),
		}, {
			'repository row': { type: 'warning', said: '3 agents are working in it, and will be stopped.', removed: ['/lab', '/link-lab', '/wt/w2'] },
			'one agent': { type: 'warning', said: 'An agent is working in it, and will be stopped.', removed: ['/notes'] },
			'none': { type: 'none', said: 'Removes this folder from the workspace, and the editors kept open for it. Files on disk will not be deleted.', removed: ['/notes'] },
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
