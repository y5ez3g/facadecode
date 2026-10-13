/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import '../../browser/fileCommands.js';
import { SAVE_ALL_COMMAND_ID } from '../../browser/fileConstants.js';

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
