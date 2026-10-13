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
import { PICK_WORKSPACE_FOLDER_COMMAND_ID, REMOVE_FOLDER_ASKED_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';

/** Answers the folder picker with the folder `picked`, and keeps each other command it runs, with the path it is given. */
class TestCommandService extends mock<ICommandService>() {

	readonly ran: string[] = [];
	picked: IWorkspaceFolder | undefined;

	override async executeCommand<R>(id: string, ...args: unknown[]): Promise<R | undefined> {
		if (id === PICK_WORKSPACE_FOLDER_COMMAND_ID) {
			return this.picked as R | undefined;
		}
		this.ran.push(`${id} ${URI.isUri(args[0]) ? args[0].path : ''}`);
		return undefined;
	}
}

suite('Workspace actions - Remove Folder from Workspace...', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the folder picked goes through the workspace bar\'s Remove Folder - which asks first where that stops agents or processes - never removed by the palette on its own; none picked, nothing happens (Facade Code, N-65; D30)', async () => {
		const commands = new TestCommandService();
		commands.picked = new WorkspaceFolder({ uri: URI.file('/lab'), index: 0, name: 'lab' });
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ICommandService, commands);
		instantiationService.stub(IWorkspaceEditingService, {
			removeFolders: async uris => { commands.ran.push(`removed directly: ${uris.map(uri => uri.path).join(', ')}`); }
		});
		const action = new RemoveRootFolderAction();

		await instantiationService.invokeFunction(accessor => action.run(accessor));
		commands.picked = undefined;
		await instantiationService.invokeFunction(accessor => action.run(accessor));

		assert.deepStrictEqual(commands.ran, [`${REMOVE_FOLDER_ASKED_COMMAND_ID} /lab`]);
	});
});
