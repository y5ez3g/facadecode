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
import { CONFIRM_REMOVE_FOLDER, foldersToRemove, whatRemovingStops } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
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

	test('what it stops: the agents in every folder it takes out and, with the last of a repository\'s, those under the rows that go with it - and whether a process it terminates there is one VS Code would ask about (D30)', () => {
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
		const agentsService = {
			agentsIn: agentsIn(new Map([['/lab', 1], ['/wt/w2', 2], ['/wt/w10', 4], ['/notes', 8], ['/wt/fix', 16], ['/wt/login', 32], ['/api', 64]])),
			// In rows that go with a repository alone: its worktree that never joined the workspace, its checkout that never did either
			terminatesProcessesIn: (uri: URI) => uri.path === '/wt/w10' || uri.path === '/api'
		};
		const stopped = (path: string, of: IWorkspaceBarRepository | undefined) => whatRemovingStops([of], foldersToRemove(URI.file(path), of, isEqual), agentsService, isEqual);

		assert.deepStrictEqual({
			'repository row': stopped('/lab', repository),
			'plain folder': stopped('/notes', undefined),
			'a worktree, the repository staying': stopped('/wt/w2', repository),
			'a repository\'s last folder, a worktree': stopped('/wt/fix', api),
		}, {
			'repository row': { agents: 7, processes: true },
			'plain folder': { agents: 8, processes: false },
			'a worktree, the repository staying': { agents: 2, processes: false },
			'a repository\'s last folder, a worktree': { agents: 112, processes: true },
		});
	});

	/**
	 * What Remove Folder on the rows of `targets` - one, or several as the Explorer's selection gives them - asked, with
	 * `agents` running by folder and a process VS Code would ask about before terminating it in each of `processes`,
	 * once confirmed: the glyph, the question and what the dialog says - or that it asked nothing - and each edit that
	 * took folders out of the workspace.
	 */
	async function removeFolder(targets: URI | URI[], agents: Map<string, number>, processes: readonly string[] = [], settings: Record<string, unknown> = {}): Promise<{ asked: string; message?: string; detail?: string[]; removed: string[][] }> {
		let asked: IConfirmation | undefined;
		const removed: string[][] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			folderForCommand: () => undefined,
			repositoryFor: uri => repository.members.some(folder => isEqual(folder.uri, uri)) || isEqual(repository.main, uri) ? repository : undefined,
			remove: async uris => { removed.push(uris.map(uri => uri.path)); }
		});
		instantiationService.stub(IWorkspaceBarAgentsService, { agentsIn: agentsIn(agents), terminatesProcessesIn: uri => processes.includes(uri.path) });
		instantiationService.stub(IDialogService, {
			confirm: async confirmation => {
				asked = confirmation;
				return { confirmed: true };
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: uri => uri.path });
		instantiationService.stub(IConfigurationService, new TestConfigurationService(settings));
		instantiationService.stub(IUriIdentityService, { extUri });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('facade.workspaceBar.removeFolder')!.handler(accessor, targets));
		if (!asked) {
			return { asked: 'nothing', removed };
		}
		const detail = typeof asked.detail === 'string' ? asked.detail : asked.detail?.value ?? '';
		return { asked: String(asked.type), message: asked.message, detail: detail.split('\n\n'), removed };
	}

	test('several folders at once - the Explorer\'s selection - are asked about once, each named, and taken out of the workspace in one edit: what their rows take with them, and the agents they stop, counted once (VC-02)', async () => {
		// The repository's checkout, one of its worktrees - which goes with it already - and another folder
		assert.deepStrictEqual(await removeFolder([URI.file('/lab'), URI.file('/wt/w2'), URI.file('/notes')], new Map([['/lab', 1], ['/wt/w10', 2], ['/notes', 4]])), {
			asked: 'warning',
			message: 'Remove 3 Folders?',
			detail: [
				'- `/lab`\n- `/wt/w2`\n- `/notes`',
				'Removes these folders from the workspace, and the editors kept open for them. Files on disk will not be deleted.',
				'The associated worktree will also be removed from the workspace, but remains on disk.',
				'7 agents are working in them, and will be stopped.',
			],
			removed: [['/lab', '/link-lab', '/wt/w2', '/notes']],
		});
	});

	test('it asks only where it stops something - an agent, or a process VS Code would ask about before terminating it - says which, and warns; a folder that runs nothing is removed unasked, and nothing is asked with asking turned off (D30)', async () => {
		// What the dialog says first: the folder, and what removing it does
		const removes = (folder: string) => [`\`${folder}\``, 'Removes this folder from the workspace, and the editors kept open for it. Files on disk will not be deleted.'];
		assert.deepStrictEqual({
			'repository row': await removeFolder(URI.file('/lab'), new Map([['/lab', 1], ['/wt/w10', 2]])),
			'one agent': await removeFolder(URI.file('/notes'), new Map([['/notes', 1]])),
			'a process': await removeFolder(URI.file('/notes'), new Map(), ['/notes']),
			'an agent and a process': await removeFolder(URI.file('/notes'), new Map([['/notes', 1]]), ['/notes']),
			'nothing running there': await removeFolder(URI.file('/notes'), new Map([['/lab', 1]]), ['/lab']),
			'asking turned off': await removeFolder(URI.file('/notes'), new Map([['/notes', 1]]), ['/notes'], { [CONFIRM_REMOVE_FOLDER]: false }),
		}, {
			'repository row': { asked: 'warning', message: 'Remove Folder?', detail: [...removes('/lab'), 'The 2 associated worktrees will also be removed from the workspace, but remain on disk.', '3 agents are working in it, and will be stopped.'], removed: [['/lab', '/link-lab', '/wt/w2']] },
			'one agent': { asked: 'warning', message: 'Remove Folder?', detail: [...removes('/notes'), 'An agent is working in it, and will be stopped.'], removed: [['/notes']] },
			'a process': { asked: 'warning', message: 'Remove Folder?', detail: [...removes('/notes'), 'Processes are running in its terminals, and will be terminated.'], removed: [['/notes']] },
			'an agent and a process': { asked: 'warning', message: 'Remove Folder?', detail: [...removes('/notes'), 'An agent is working in it, and will be stopped.', 'Processes are running in its terminals, and will be terminated.'], removed: [['/notes']] },
			'nothing running there': { asked: 'nothing', removed: [['/notes']] },
			'asking turned off': { asked: 'nothing', removed: [['/notes']] },
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
