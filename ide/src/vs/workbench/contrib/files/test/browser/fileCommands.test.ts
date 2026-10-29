/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IListService } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IExplorerService } from '../../browser/files.js';
import '../../browser/fileCommands.js';
import { REMOVE_ROOT_FOLDER_COMMAND_ID, SAVE_ALL_COMMAND_ID } from '../../browser/fileConstants.js';

suite('Files - Save All', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-17 WS-59 Save All saves the unsaved editors put away with other folders too: each working copy once, one at a time, and one that is not saved stays unsaved', async () => {
		const steps: string[] = [];
		const copy = (path: string, dirty = true, saves = true) => {
			const workingCopy = {
				resource: URI.file(path),
				dirty,
				isDirty: () => workingCopy.dirty,
				save: async () => {
					steps.push(`save ${path}`);
					workingCopy.dirty = !saves;
					return saves;
				}
			};
			return workingCopy;
		};
		const draft = copy('/w/api/draft.ts');
		const shared = copy('/w/api/shared.ts');
		const clean = copy('/w/api/clean.ts', false);
		// a Save As cancelled, or a write that failed
		const refused = copy('/w/notes/Untitled-1', true, false);
		const copies = new Map([draft, shared, clean, refused].map(workingCopy => [workingCopy.resource.path, [workingCopy]]));
		const api = URI.file('/w/api');
		const notes = URI.file('/w/notes');

		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IInstantiationService, instantiationService);
		instantiationService.stub(INotificationService, new TestNotificationService());
		// nothing unsaved on screen
		instantiationService.stub(IEditorGroupsService, { getGroups: () => [] });
		instantiationService.stub(IEditorService, { save: async () => ({ success: true, editors: [] }) });
		instantiationService.stub(IPutAwayEditorsService, {
			folders: () => [api, notes],
			// the one file both hold out of sight
			get: (folder: URI) => folder === api ? [draft.resource, shared.resource, clean.resource] : [shared.resource, refused.resource]
		});
		instantiationService.stub(IWorkingCopyService, { getAll: (resource: URI) => copies.get(resource.path) as unknown as readonly IWorkingCopy[] | undefined });

		await instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(SAVE_ALL_COMMAND_ID)!.handler(accessor));

		assert.deepStrictEqual({ steps, refusedStillUnsaved: refused.isDirty() }, {
			steps: ['save /w/api/draft.ts', 'save /w/api/shared.ts', 'save /w/notes/Untitled-1'],
			refusedStillUnsaved: true
		});
	});
});

suite('Files - Remove Folder from Workspace, in the Explorer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the folders of the workspace it is run on go through the workspace bar - all in one go, asked about once where it asks - never removed by the Explorer on its own; what is no folder of the workspace is left alone; the Agents window, which has no bar, removes them itself (Facade Code, VC-02; WORKSPACE.md W9.6)', async () => {
		const ran: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string) => {
				ran.push(id);
				return undefined;
			}
		});
		instantiationService.stub(IWorkspaceBarService, {
			remove: async uris => {
				ran.push(`through the bar: ${uris.map(uri => uri.path).join(', ')}`);
				return { kind: 'removed', folders: [] };
			}
		});
		instantiationService.stub(IWorkspaceEditingService, {
			removeFolders: async uris => { ran.push(`removed directly: ${uris.map(uri => uri.path).join(', ')}`); }
		});
		let sessionsWindow = false;
		instantiationService.stub(IWorkbenchEnvironmentService, { get isSessionsWindow() { return sessionsWindow; } });
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
		sessionsWindow = true;
		await instantiationService.invokeFunction(accessor => handler(accessor, URI.file('/notes')));

		assert.deepStrictEqual(ran, ['through the bar: /lab', 'through the bar: /lab, /notes', 'workbench.action.removeRootFolder', 'removed directly: /notes']);
	});
});
