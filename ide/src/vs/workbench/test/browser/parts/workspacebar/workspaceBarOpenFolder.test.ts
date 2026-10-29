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
import '../../../../browser/actions/workspaceCommands.js';
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

	test('WS-12 a folder on a remote this window is not connected to gets a window that is; a vscode-vfs folder, which carries an authority but is not remote, is shown here', async () => {
		const window = localWindow();

		await window.openOrShow({ folderUri: onAnotherRemote });
		await window.openOrShow({ folderUri: onGitHub });

		assert.deepStrictEqual(window.asked, [`window folder ${onAnotherRemote.toString()}`, `show ${onGitHub.toString()}`]);
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

	test('WS-12 git\'s Open Worktree in Current Window shows the worktree here, and in New Window opens one', async () => {
		const window = localWindow();

		// What `git.openWorktree` and `git.openWorktreeInNewWindow` call (extensions/git/src/commands.ts)
		await window.openFolder(worktree, { forceReuseWindow: true });
		await window.openFolder(worktree, { forceNewWindow: true });

		assert.deepStrictEqual(window.asked, [`show ${worktree.toString()}`, `_files.windowOpen folder ${worktree.toString()} (new)`]);
	});
});
