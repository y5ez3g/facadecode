/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IListService } from '../../../../../platform/list/browser/listService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { REMOVE_FOLDER_ASKED_COMMAND_ID } from '../../../../browser/actions/workspaceCommands.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { IExplorerService } from '../../browser/files.js';
import '../../browser/fileCommands.js';
import { REMOVE_ROOT_FOLDER_COMMAND_ID } from '../../browser/fileConstants.js';

suite('Files - Remove Folder from Workspace, in the Explorer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a folder of the workspace goes as the workspace bar\'s Remove Folder takes one - asked first, naming the agents it stops - never removed unasked; what is no folder of the workspace is left alone (Facade Code, N-65)', async () => {
		const ran: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				ran.push(`${id} ${URI.isUri(args[0]) ? args[0].path : ''}`);
				return undefined;
			}
		});
		instantiationService.stub(IWorkspaceEditingService, {
			removeFolders: async uris => { ran.push(`removed unasked: ${uris.map(uri => uri.path).join(', ')}`); }
		});
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ folders: [new WorkspaceFolder({ uri: URI.file('/lab'), index: 0, name: 'lab' })] }) });
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IListService, { lastFocusedList: undefined });
		instantiationService.stub(IEditorService, {});
		instantiationService.stub(IEditorGroupsService, { activeGroup: upcastPartial<IEditorGroup>({ selectedEditors: [] }) });
		instantiationService.stub(IExplorerService, {});

		const handler = CommandsRegistry.getCommand(REMOVE_ROOT_FOLDER_COMMAND_ID)!.handler;
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/lab')));
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/lab/src')));

		assert.deepStrictEqual(ran, [`${REMOVE_FOLDER_ASKED_COMMAND_ID} /lab`, 'workbench.action.removeRootFolder ']);
	});
});
