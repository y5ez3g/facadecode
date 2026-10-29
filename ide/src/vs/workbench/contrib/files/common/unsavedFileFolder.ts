/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { SideBySideEditor } from '../../../common/editor.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPutAwayEditorsService } from '../../../services/putAwayEditors/common/putAwayEditors.js';

/** The services {@link unsavedFileFolder} asks. */
export interface IUnsavedFileFolderServices {
	readonly editorService: Pick<IEditorService, 'findEditors'>;
	readonly activeFolderService: Pick<IActiveFolderService, 'activeFolder'>;
	readonly putAwayEditorsService: Pick<IPutAwayEditorsService, 'folders' | 'get'>;
	readonly contextService: Pick<IWorkspaceContextService, 'getWorkspaceFolder'>;
	readonly extUri: IExtUri;
}

/**
 * Facade Code: the folder an unsaved file is found in (WORKSPACE.md W6.2) - the folder on screen while one of its
 * editors shows it; else a folder that put its editor away, which shows it again once on screen; else, with no editor
 * at all, the workspace folder the file is in. None for a file outside every folder that no folder holds.
 */
export function unsavedFileFolder(resource: URI, services: IUnsavedFileFolderServices): IWorkspaceFolder | undefined {
	const active = services.activeFolderService.activeFolder;
	if (active && services.editorService.findEditors(resource, { supportSideBySide: SideBySideEditor.ANY }).length > 0) {
		return active;
	}

	const putAwayBy = services.putAwayEditorsService.folders().find(folder => services.putAwayEditorsService.get(folder).some(held => services.extUri.isEqual(held, resource)));
	return services.contextService.getWorkspaceFolder(putAwayBy ?? resource) ?? undefined;
}
