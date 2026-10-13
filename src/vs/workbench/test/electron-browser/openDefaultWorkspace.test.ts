/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../platform/log/common/log.js';
import { IWorkspaceToOpen } from '../../../platform/window/common/window.js';
import { defaultWorkspaceUri } from '../../../platform/workspaces/common/defaultWorkspace.js';
import { OpenDefaultWorkspaceAction } from '../../electron-browser/actions/windowActions.js';
import { INativeWorkbenchEnvironmentService } from '../../services/environment/electron-browser/environmentService.js';
import { IHostService } from '../../services/host/browser/host.js';

suite('Open Default Workspace', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** Without a drive letter: an in-memory disk has no drive root, and `mkdirp` takes one for granted on Windows. */
	const userDataPath = '/someone/Facade Code';

	/** Runs the menu item in a remote window after `prepare`, returning what it asked the host to open and the disk afterwards. */
	async function openDefaultWorkspace(prepare?: (fileService: IFileService) => Promise<unknown>): Promise<{ opened: unknown[]; fileService: IFileService }> {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		await prepare?.(fileService);

		const opened: unknown[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(INativeWorkbenchEnvironmentService, { userDataPath, remoteAuthority: 'ssh-remote+box' } as Partial<INativeWorkbenchEnvironmentService>);
		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IHostService, {
			openWindow: async (what?: unknown) => {
				opened.push(Array.isArray(what) ? what.map(openable => (openable as IWorkspaceToOpen).workspaceUri.toString()) : what);
			}
		} as Partial<IHostService>);

		await instantiationService.invokeFunction(accessor => new OpenDefaultWorkspaceAction().run(accessor));
		return { opened, fileService };
	}

	test('WS-02 it opens the default workspace on this machine, made when it was missing', async () => {
		const { opened, fileService } = await openDefaultWorkspace();

		assert.deepStrictEqual({ opened, made: await fileService.exists(defaultWorkspaceUri(userDataPath)) }, {
			opened: [[defaultWorkspaceUri(userDataPath).toString()]],
			made: true
		});
	});

	test('WS-02 with a directory in its place, an empty window, on this machine and not on the remote', async () => {
		const { opened } = await openDefaultWorkspace(fileService => fileService.createFolder(defaultWorkspaceUri(userDataPath)));

		assert.deepStrictEqual(opened, [{ remoteAuthority: null }]);
	});
});
