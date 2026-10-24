/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IOpenWindowOptions, isFolderToOpen, isWorkspaceToOpen, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { ADD_ROOT_FOLDER_COMMAND_ID } from '../../../../browser/actions/workspaceCommands.js';
import { IDialogService, IFileDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ExternalFileImport } from '../../../../contrib/files/browser/fileImportExport.js';
import { ExplorerItem } from '../../../../contrib/files/common/explorerModel.js';
import { IWorkspaceBarService, openOrShow, ShowResult } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../../services/host/browser/host.js';

suite('Workspace bar - folders that extensions and links ask for', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const folder = URI.file('/work/api');
	const worktree = URI.file('/work/.worktrees/api/feature');
	const workspaceFile = URI.file('/work/team.code-workspace');
	const onAnotherRemote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/me/api' });
	const onGitHub = URI.from({ scheme: 'vscode-vfs', authority: 'github', path: '/microsoft/vscode' });

	/** What it was opened as, in a word: a folder or a workspace, and where. */
	function describe(openable: unknown): string {
		const what = openable as IWindowOpenable;
		return isFolderToOpen(what) ? `folder ${what.folderUri.toString()}` : isWorkspaceToOpen(what) ? `workspace ${what.workspaceUri.toString()}` : 'something else';
	}

	/** A local window: what it was asked to show in itself, and the windows it was asked to open. */
	function localWindow() {
		const asked: string[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		const workspaceBarService = {
			show: async (uri: URI) => { asked.push(`show ${uri.toString()}`); return { kind: 'shown' } as ShowResult; }
		} as Partial<IWorkspaceBarService> as IWorkspaceBarService;
		const hostService = {
			openWindow: async (toOpen: IWindowOpenable[], options?: IOpenWindowOptions) => { asked.push(`window ${toOpen.map(describe).join(', ')}${options?.forceNewWindow ? ' (new)' : ''}`); }
		} as Partial<IHostService> as IHostService;
		const environmentService = { remoteAuthority: undefined, isSessionsWindow: false } as Partial<IWorkbenchEnvironmentService> as IWorkbenchEnvironmentService;

		instantiationService.stub(IWorkspaceBarService, workspaceBarService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(IWorkbenchEnvironmentService, environmentService);
		instantiationService.stub(IEditorService, { openEditors: async () => [] } as Partial<IEditorService>);
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				const [openables, options] = args as [unknown[], IOpenWindowOptions | undefined];
				asked.push(`${id} ${openables.map(describe).join(', ')}${options?.forceNewWindow ? ' (new)' : ''}`);
				return undefined;
			}
		} as Partial<ICommandService>);

		return {
			asked,
			openOrShow: (toOpen: IWindowOpenable, options?: IOpenWindowOptions) => openOrShow(workspaceBarService, hostService, environmentService, toOpen, options),
			openFolder: (uri: URI, options?: unknown) => instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand('vscode.openFolder')!.handler(accessor, uri, options))
		};
	}

	test('WS-12 a folder on a remote this window is not connected to gets a window that is - a new one, never this one, whose list stays; a vscode-vfs folder, which carries an authority but is not remote, is shown here', async () => {
		const window = localWindow();

		await window.openOrShow({ folderUri: onAnotherRemote });
		await window.openOrShow({ folderUri: onGitHub });

		assert.deepStrictEqual(window.asked, [`window folder ${onAnotherRemote.toString()} (new)`, `show ${onGitHub.toString()}`]);
	});

	test('WS-12 an extension\'s vscode.openFolder shows a folder here; a workspace, or a folder asked for in a new window, is a new window; the list is never replaced', async () => {
		const window = localWindow();

		await window.openFolder(folder);
		await window.openFolder(workspaceFile);
		await window.openFolder(folder, { forceNewWindow: true });

		assert.deepStrictEqual(window.asked, [
			`show ${folder.toString()}`,
			`_files.windowOpen workspace ${workspaceFile.toString()}`,
			`_files.windowOpen folder ${folder.toString()} (new)`
		]);
	});

	test('File > Add Folder to Workspace adds through the bar - its trust question asked before an untrusted folder joins, Cancel keeping the list as it is - not past it, where only VS Code\'s Yes or No comes after (WORKSPACE.md W5; REMOTE.md RM-37)', async () => {
		const asked: string[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IFileDialogService, { showOpenDialog: async () => [folder], defaultFolderPath: async () => URI.file('/work') } as Partial<IFileDialogService>);
		instantiationService.stub(IPathService, { defaultUriScheme: 'file' } as Partial<IPathService>);
		instantiationService.stub(IWorkspaceBarService, { add: async (uris: readonly URI[]) => { asked.push(`bar add ${uris.map(uri => uri.path).join(', ')}`); } } as Partial<IWorkspaceBarService>);
		instantiationService.stub(IWorkspaceEditingService, { addFolders: async (folders: { uri: URI }[]) => { asked.push(`workspace add ${folders.map(each => each.uri.path).join(', ')}`); } } as Partial<IWorkspaceEditingService>);

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(ADD_ROOT_FOLDER_COMMAND_ID)!.handler(accessor));

		assert.deepStrictEqual(asked, ['bar add /work/api']);
	});

	test('a folder dropped on the Explorer and added to the workspace is added through the bar too, its trust question asked first (WORKSPACE.md W5)', async () => {
		const asked: string[] = [];
		const dropped = URI.file('/elsewhere/web');
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IFileService, {
			activateProvider: async () => { },
			hasProvider: () => true,
			resolveAll: async (toResolve: { resource: URI }[]) => toResolve.map(each => ({ success: true, stat: { resource: each.resource, isDirectory: true } }))
		} as unknown as Partial<IFileService>);
		instantiationService.stub(IHostService, { focus: async () => { } } as Partial<IHostService>);
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: folder }] }) } as unknown as Partial<IWorkspaceContextService>);
		instantiationService.stub(IProgressService, { withProgress: (_options: unknown, task: () => Promise<unknown>) => task() } as unknown as Partial<IProgressService>);
		// The drop's question answered "Add Folder to Workspace"
		instantiationService.stub(IDialogService, { prompt: async ({ buttons }: IPrompt<unknown>) => ({ result: await buttons!.find(button => button.label.includes('Add'))!.run({ checkboxChecked: false }) }) } as unknown as Partial<IDialogService>);
		instantiationService.stub(IWorkspaceBarService, { add: async (uris: readonly URI[]) => { asked.push(`bar add ${uris.map(uri => uri.path).join(', ')}`); } } as Partial<IWorkspaceBarService>);
		instantiationService.stub(IWorkspaceEditingService, { addFolders: async (folders: { uri: URI }[]) => { asked.push(`workspace add ${folders.map(each => each.uri.path).join(', ')}`); } } as Partial<IWorkspaceEditingService>);
		const dataTransfer = new DataTransfer();
		dataTransfer.setData(DataTransfers.RESOURCES, JSON.stringify([dropped.toString()]));

		await instantiationService.createInstance(ExternalFileImport).import({ isRoot: true, resource: folder } as ExplorerItem, new DragEvent('drop', { dataTransfer }), mainWindow);

		assert.deepStrictEqual(asked, ['bar add /elsewhere/web']);
	});

	test('WS-12 git\'s Open Worktree in Current Window shows the worktree here, and in New Window opens one', async () => {
		const window = localWindow();

		// What `git.openWorktree` and `git.openWorktreeInNewWindow` call (extensions/git/src/commands.ts)
		await window.openFolder(worktree, { forceReuseWindow: true });
		await window.openFolder(worktree, { forceNewWindow: true });

		assert.deepStrictEqual(window.asked, [`show ${worktree.toString()}`, `_files.windowOpen folder ${worktree.toString()} (new)`]);
	});
});
