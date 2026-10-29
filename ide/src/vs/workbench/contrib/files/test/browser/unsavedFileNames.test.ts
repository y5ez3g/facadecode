/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IResourceEditorInputIdentifier } from '../../../../../platform/editor/common/editor.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IEditorIdentifier } from '../../../../common/editor.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { unsavedNamesOf } from '../../../../services/workingCopy/common/workingCopyUnsavedNames.js';
import { UnsavedFileNames } from '../../browser/unsavedFileNames.js';

suite('Files - the files VS Code asks to save before the window closes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-49 each is named with the folder it is found in, as the bar names it - on screen, the folder the window is on; put away, the folder that put it away; with no editor, the folder it is in - and a file no folder holds by its name alone (WORKSPACE.md W10.7)', () => {
		const folder = (path: string, index: number) => new WorkspaceFolder({ uri: URI.file(path), index, name: basename(URI.file(path)) });
		const [lab, w2, notes] = [folder('/lab', 0), folder('/wt/w2', 1), folder('/notes', 2)];
		const repository = upcastPartial<IWorkspaceBarRepository>({ main: lab.uri, folder: lab, worktrees: [{ uri: w2.uri, branch: 'fix/login', label: 'fix/login', exists: true, folder: w2 }] });

		// On /lab; /wt/w2's README was open while the window was on the worktree, and is put away with its editors
		const draft = URI.from({ scheme: Schemas.untitled, path: 'Untitled-1' });
		const shown = [URI.file('/lab/README.md'), draft];
		const putAway = new Map([[w2.uri.path, [URI.file('/wt/w2/README.md')]]]);

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
			findEditors: (resource: URI | IResourceEditorInputIdentifier): readonly IEditorIdentifier[] => shown.some(uri => extUri.isEqual(uri, URI.isUri(resource) ? resource : resource.resource)) ? [upcastPartial<IEditorIdentifier>({})] : []
		}));
		instantiationService.stub(IActiveFolderService, upcastPartial<IActiveFolderService>({ activeFolder: lab }));
		instantiationService.stub(IPutAwayEditorsService, upcastPartial<IPutAwayEditorsService>({
			folders: () => [...putAway.keys()].map(path => URI.file(path)),
			get: uri => putAway.get(uri.path) ?? []
		}));
		instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
			getWorkspaceFolder: resource => [lab, w2, notes].find(candidate => extUri.isEqualOrParent(resource, candidate.uri)) ?? null
		}));
		instantiationService.stub(IUriIdentityService, upcastPartial<IUriIdentityService>({ extUri }));
		instantiationService.stub(IWorkspaceBarService, upcastPartial<IWorkspaceBarService>({ repositoryFor: uri => extUri.isEqual(uri, lab.uri) || extUri.isEqual(uri, w2.uri) ? repository : undefined }));
		instantiationService.stub(IWorkspaceBarCustomizationService, upcastPartial<IWorkspaceBarCustomizationService>({ nameFor: (each: IWorkspaceFolder) => each.name, get: () => undefined }));

		const unsaved = [
			upcastPartial<IWorkingCopy>({ resource: URI.file('/lab/README.md'), name: 'README.md' }),
			upcastPartial<IWorkingCopy>({ resource: URI.file('/wt/w2/README.md'), name: 'README.md' }),
			upcastPartial<IWorkingCopy>({ resource: URI.file('/notes/todo.md'), name: 'todo.md' }),
			upcastPartial<IWorkingCopy>({ resource: draft, name: 'first draft' }),
			upcastPartial<IWorkingCopy>({ resource: URI.file('/tmp/scratch.txt'), name: 'scratch.txt' }),
		];
		const names = store.add(instantiationService.createInstance(UnsavedFileNames));
		const told = unsavedNamesOf(unsaved);
		names.dispose();

		assert.deepStrictEqual({ told, afterwards: unsavedNamesOf(unsaved) }, {
			told: ['README.md · lab', 'README.md · lab (worktree: w2)', 'todo.md · notes', 'first draft · lab', 'scratch.txt'],
			afterwards: ['README.md', 'README.md', 'todo.md', 'first draft', 'scratch.txt'],
		});
	});
});
