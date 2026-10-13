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
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { IExplorerService } from '../../browser/files.js';
import '../../browser/fileCommands.js';
import { REMOVE_ROOT_FOLDER_COMMAND_ID } from '../../browser/fileConstants.js';

suite('Files - Remove Folder from Workspace, in the Explorer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the folders of the workspace it is run on go through the workspace bar\'s Remove Folder - all in one go, asked about once where it asks - never removed by the Explorer on its own; what is no folder of the workspace is left alone (Facade Code, N-65; VC-02; D30)', async () => {
		const ran: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				const [folders] = args;
				ran.push(`${id} ${Array.isArray(folders) ? folders.map(folder => URI.isUri(folder) ? folder.path : String(folder)).join(', ') : URI.isUri(folders) ? folders.path : ''}`);
				return undefined;
			}
		});
		instantiationService.stub(IWorkspaceEditingService, {
			removeFolders: async uris => { ran.push(`removed directly: ${uris.map(uri => uri.path).join(', ')}`); }
		});
		const folder = (path: string, index: number) => new WorkspaceFolder({ uri: URI.file(path), index, name: path });
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ folders: [folder('/lab', 0), folder('/notes', 1)] }) });
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IListService, { lastFocusedList: undefined });
		instantiationService.stub(IEditorService, {});
		// Several selected, as a multi-selection gives them
		let selected: EditorInput[] = [];
		instantiationService.stub(IEditorGroupsService, { activeGroup: upcastPartial<IEditorGroup>({ get selectedEditors() { return [...selected]; } }) });
		instantiationService.stub(IExplorerService, {});

		const handler = CommandsRegistry.getCommand(REMOVE_ROOT_FOLDER_COMMAND_ID)!.handler;
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/lab')));
		selected = ['/lab', '/notes', '/lab/src'].map(path => upcastPartial<EditorInput>({ resource: URI.file(path), matches: other => EditorResourceAccessor.getOriginalUri(other)?.path === path }));
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/lab')));
		selected = [];
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/lab/src')));

		assert.deepStrictEqual(ran, [`${REMOVE_FOLDER_ASKED_COMMAND_ID} /lab`, `${REMOVE_FOLDER_ASKED_COMMAND_ID} /lab, /notes`, 'workbench.action.removeRootFolder ']);
	});
});
