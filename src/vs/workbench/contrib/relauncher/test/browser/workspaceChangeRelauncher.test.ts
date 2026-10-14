/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { WorkspaceChangeExtHostRelauncher } from '../../browser/relauncher.contribution.js';

suite('Facade - extension host and the first folder', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-29 WS-32 a workspace window whose first folder changes - added, removed, reordered - restarts no extension host', async () => {
		let folders = [{ uri: URI.file('/a') }, { uri: URI.file('/b') }];
		const onDidChangeWorkspaceFolders = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const context = {
			getCompleteWorkspace: async () => ({ folders }),
			getWorkspace: () => ({ folders }),
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event
		} as unknown as IWorkspaceContextService;

		let stopped = 0;
		let reloaded = 0;
		const extensionService = { stopExtensionHosts: async () => { stopped++; return true; }, startExtensionHosts: () => { } } as unknown as IExtensionService;
		const hostService = { reload: async () => { reloaded++; } } as unknown as IHostService;
		const environmentService = { extensionTestsLocationURI: undefined, isSessionsWindow: false, remoteAuthority: undefined } as unknown as IWorkbenchEnvironmentService;

		store.add(new WorkspaceChangeExtHostRelauncher(context, extensionService, hostService, environmentService));
		await timeout(0);

		const change = { added: [], removed: [], changed: [] };
		folders = [{ uri: URI.file('/b') }, { uri: URI.file('/a') }];
		onDidChangeWorkspaceFolders.fire(change);
		folders = [{ uri: URI.file('/a') }];
		onDidChangeWorkspaceFolders.fire(change);
		folders = [{ uri: URI.file('/new') }, { uri: URI.file('/a') }];
		onDidChangeWorkspaceFolders.fire(change);

		// Past the relauncher's own 10 ms buffer.
		await timeout(50);

		assert.deepStrictEqual({ stopped, reloaded }, { stopped: 0, reloaded: 0 });
	});
});
