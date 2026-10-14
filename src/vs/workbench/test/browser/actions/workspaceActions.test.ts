/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { RemoveRootFolderAction } from '../../../browser/actions/workspaceActions.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';

/** Answers the folder picker with the folder `picked`. */
class TestCommandService extends mock<ICommandService>() {

	picked: IWorkspaceFolder | undefined;

	override async executeCommand<R>(id: string): Promise<R | undefined> {
		return id === PICK_WORKSPACE_FOLDER_COMMAND_ID ? this.picked as R | undefined : undefined;
	}
}

suite('Workspace actions - Remove Folder from Workspace...', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the folder picked goes through the workspace bar, which asks first when something would be lost - never removed by the palette on its own; none picked, nothing happens (Facade Code, WORKSPACE.md W9.6)', async () => {
		const removed: string[] = [];
		const commands = new TestCommandService();
		commands.picked = new WorkspaceFolder({ uri: URI.file('/lab'), index: 0, name: 'lab' });
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ICommandService, commands);
		instantiationService.stub(IWorkspaceBarService, {
			remove: async uris => {
				removed.push(`through the bar: ${uris.map(uri => uri.path).join(', ')}`);
				return { kind: 'removed', folders: [] };
			}
		});
		instantiationService.stub(IWorkspaceEditingService, {
			removeFolders: async uris => { removed.push(`removed directly: ${uris.map(uri => uri.path).join(', ')}`); }
		});
		const action = new RemoveRootFolderAction();

		await instantiationService.invokeFunction(accessor => action.run(accessor));
		commands.picked = undefined;
		await instantiationService.invokeFunction(accessor => action.run(accessor));

		assert.deepStrictEqual(removed, ['through the bar: /lab']);
	});
});
