/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { fileLine, placeNameFor } from '../../../browser/parts/workspacebar/workspaceBarQuestions.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPutAwayEditorsService } from '../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopy } from '../../../services/workingCopy/common/workingCopy.js';
import { setUnsavedNames } from '../../../services/workingCopy/common/workingCopyUnsavedNames.js';
import { IUnsavedFileFolderServices, unsavedFileFolder } from '../common/unsavedFileFolder.js';

/** Names each file VS Code's dialogs before shutdown list with the folder it is found in, as the bar names that (WORKSPACE.md W11). */
export class UnsavedFileNames extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.unsavedFileNames';

	private readonly folderServices: IUnsavedFileFolderServices;

	constructor(
		@IEditorService editorService: IEditorService,
		@IActiveFolderService activeFolderService: IActiveFolderService,
		@IPutAwayEditorsService putAwayEditorsService: IPutAwayEditorsService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
	) {
		super();

		this.folderServices = { editorService, activeFolderService, putAwayEditorsService, contextService, extUri: uriIdentityService.extUri };
		this._register(setUnsavedNames(workingCopies => workingCopies.map(workingCopy => this.nameOf(workingCopy))));
	}

	/** `README.md · lab`: its name, then where it is found (WORKSPACE.md W10.7); its name alone where no folder holds it. */
	private nameOf(workingCopy: IWorkingCopy): string {
		const folder = unsavedFileFolder(workingCopy.resource, this.folderServices);
		return fileLine(workingCopy.name, folder && placeNameFor(this.customizationService, folder.uri, folder, this.workspaceBarService.repositoryFor(folder.uri), this.folderServices.extUri));
	}
}
