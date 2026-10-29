/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IResourceEditorInputIdentifier } from '../../../../../platform/editor/common/editor.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorIdentifier } from '../../../../common/editor.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IActivityService, NumberBadge } from '../../../../services/activity/common/activity.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { DirtyFilesIndicator } from '../../common/dirtyFilesIndicator.js';

suite('Files - the count of unsaved files on the Explorer\'s icon', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('is the folder on screen\'s: what its editors show, and what is changed inside it with no editor - not what another folder put away; with no folder on screen, every unsaved file (WORKSPACE.md W6.2)', () => {
		// On /a; /a/opened-in-b.ts was opened while the window was on /b, and is put away with /b's editors
		const window = {
			folder: URI.file('/a') as URI | undefined,
			dirty: ['/a/shown.ts', '/a/edited.ts', '/a/opened-in-b.ts', '/b/put-away.ts', '/b/edited.ts'],
			shown: new Set(['/a/shown.ts']),
			putAway: new Map([['/b', ['/a/opened-in-b.ts', '/b/put-away.ts']]]),
		};
		const folderChanged = store.add(new Emitter<void>());
		let badge: { readonly number: number } | undefined;

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IActivityService, upcastPartial<IActivityService>({
			// The one shown: a new one is shown before the one it replaces is disposed
			showViewContainerActivity: (_id, activity) => {
				const shown = badge = { number: (activity.badge as NumberBadge).number };
				return toDisposable(() => {
					if (badge === shown) {
						badge = undefined;
					}
				});
			}
		}));
		instantiationService.stub(IWorkingCopyService, upcastPartial<IWorkingCopyService>({
			get dirtyCount() { return window.dirty.length; },
			get dirtyWorkingCopies() { return window.dirty.map(path => upcastPartial<IWorkingCopy>({ resource: URI.file(path) })); },
			onDidChangeDirty: Event.None
		}));
		instantiationService.stub(IFilesConfigurationService, upcastPartial<IFilesConfigurationService>({ hasShortAutoSaveDelay: () => false }));
		instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
			findEditors: (resource: URI | IResourceEditorInputIdentifier): readonly IEditorIdentifier[] => window.shown.has((URI.isUri(resource) ? resource : resource.resource).path) ? [upcastPartial<IEditorIdentifier>({})] : [],
			onDidEditorsChange: Event.None
		}));
		instantiationService.stub(IActiveFolderService, upcastPartial<IActiveFolderService>({
			get activeFolder() { return window.folder ? upcastPartial<IWorkspaceFolder>({ uri: window.folder }) : undefined; },
			onDidChangeActiveFolder: folderChanged.event
		}));
		instantiationService.stub(IPutAwayEditorsService, upcastPartial<IPutAwayEditorsService>({
			folders: () => [...window.putAway.keys()].map(path => URI.file(path)),
			get: folder => (window.putAway.get(folder.path) ?? []).map(path => URI.file(path)),
			onDidChange: Event.None
		}));
		instantiationService.stub(IUriIdentityService, upcastPartial<IUriIdentityService>({ extUri }));
		const folders = [URI.file('/a'), URI.file('/b')];
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
			getWorkspaceFolder: resource => {
				const uri = folders.find(folder => extUri.isEqualOrParent(resource, folder));
				return uri ? upcastPartial<IWorkspaceFolder>({ uri }) : null;
			}
		}));

		store.add(instantiationService.createInstance(DirtyFilesIndicator));
		const onA = badge?.number;

		// To /b: its editors shown, /a's put away
		window.folder = URI.file('/b');
		window.shown = new Set(['/b/put-away.ts', '/a/opened-in-b.ts']);
		window.putAway = new Map([['/a', ['/a/shown.ts']]]);
		folderChanged.fire();
		const onB = badge?.number;

		window.folder = undefined;
		folderChanged.fire();

		assert.deepStrictEqual({ onA, onB, onNoFolder: badge?.number }, { onA: 2, onB: 3, onNoFolder: 5 });
	});
});
