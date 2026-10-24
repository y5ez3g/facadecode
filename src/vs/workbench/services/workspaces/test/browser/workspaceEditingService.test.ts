/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DidEnterWorkspaceEvent } from '../../browser/abstractWorkspaceEditingService.js';
import { UNKNOWN_EMPTY_WINDOW_WORKSPACE } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IJSONEditingService } from '../../../configuration/common/jsonEditing.js';
import { BrowserWorkspaceEditingService } from '../../browser/workspaceEditingService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';

suite('WorkspaceEditingService', () => {

	suite('DidEnterWorkspaceEvent', () => {

		test('event captures old workspace and new workspace URI', () => {
			const oldWorkspace = { id: 'old-folder', uri: URI.file('/old/folder') };
			const newWorkspace = { id: 'new-workspace', configPath: URI.file('/test/workspace.code-workspace') };
			const event = new DidEnterWorkspaceEvent(oldWorkspace, newWorkspace);

			assert.strictEqual(event.oldWorkspace, oldWorkspace);
			assert.strictEqual(event.newWorkspace, newWorkspace);
		});

		test('join collects promises', async () => {
			const newWorkspace = { id: 'new-workspace', configPath: URI.file('/test/workspace.code-workspace') };
			const event = new DidEnterWorkspaceEvent(UNKNOWN_EMPTY_WINDOW_WORKSPACE, newWorkspace);

			let executed1 = false;
			let executed2 = false;

			event.join(
				(async () => { executed1 = true; })(),
			);

			event.join(
				(async () => { executed2 = true; })(),
			);

			await event.wait();

			assert.strictEqual(executed1, true, 'First promise should have executed');
			assert.strictEqual(executed2, true, 'Second promise should have executed');
		});

		test('wait resolves when all promises complete', async () => {
			const newWorkspace = { id: 'new-workspace', configPath: URI.file('/test/workspace.code-workspace') };
			const event = new DidEnterWorkspaceEvent(UNKNOWN_EMPTY_WINDOW_WORKSPACE, newWorkspace);

			let resolve1: () => void;
			let resolve2: () => void;
			const promise1 = new Promise<void>(r => { resolve1 = r; });
			const promise2 = new Promise<void>(r => { resolve2 = r; });

			event.join(promise1);
			event.join(promise2);

			let waitCompleted = false;
			const waitPromise = event.wait().then(() => { waitCompleted = true; });

			// Should not be completed yet
			await Promise.resolve();
			assert.strictEqual(waitCompleted, false);

			// Resolve first promise
			resolve1!();
			await Promise.resolve();
			assert.strictEqual(waitCompleted, false);

			// Resolve second promise
			resolve2!();
			await waitPromise;
			assert.strictEqual(waitCompleted, true);
		});

		test('wait resolves immediately when no promises are joined', async () => {
			const newWorkspace = { id: 'new-workspace', configPath: URI.file('/test/workspace.code-workspace') };
			const event = new DidEnterWorkspaceEvent(UNKNOWN_EMPTY_WINDOW_WORKSPACE, newWorkspace);

			await event.wait();
			// Should complete without error
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

suite('WorkspaceEditingService - entering a workspace', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	class TestWorkspaceEditingService extends BrowserWorkspaceEditingService {
		enter(workspaceUri: URI, reloading: boolean) {
			return this.doEnterWorkspace(workspaceUri, reloading);
		}
	}

	test('a window that reloads once it has entered it - a remote one - leaves its configuration to that reload: read before, a remote folder\'s would wait on the connection the stopped extension hosts took down (REMOTE.md R7)', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const workspaceUri = URI.file('/w/team.code-workspace');
		const workspace = { id: 'team', configPath: workspaceUri };
		const initialized: string[] = [];
		instantiationService.stub(IConfigurationService, 'initialize', async (identifier: { id: string }) => { initialized.push(identifier.id); });
		instantiationService.stub(IJSONEditingService, { write: async () => { } });
		instantiationService.stub(IWorkspacesService, {
			getWorkspaceIdentifier: async () => workspace,
			enterWorkspace: async () => ({ workspace })
		});
		const service = disposables.add(instantiationService.createInstance(TestWorkspaceEditingService));

		const reloading = await service.enter(workspaceUri, true);
		const staying = await service.enter(workspaceUri, false);

		assert.deepStrictEqual({ initialized, entered: [reloading?.workspace.id, staying?.workspace.id] }, { initialized: ['team'], entered: ['team', 'team'] });
	});
});
