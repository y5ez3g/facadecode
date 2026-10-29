/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { VIEWLET_ID } from './files.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IWorkingCopy, WorkingCopyCapabilities } from '../../../services/workingCopy/common/workingCopy.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IPutAwayEditorsService } from '../../../services/putAwayEditors/common/putAwayEditors.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUnsavedFileFolderServices, unsavedFileFolder } from './unsavedFileFolder.js';

export class DirtyFilesIndicator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dirtyFilesIndicator';

	private readonly badgeHandle = this._register(new MutableDisposable());

	private lastKnownDirtyCount = 0;

	private readonly folderServices: IUnsavedFileFolderServices;

	constructor(
		@IActivityService private readonly activityService: IActivityService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@IPutAwayEditorsService private readonly putAwayEditorsService: IPutAwayEditorsService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService contextService: IWorkspaceContextService
	) {
		super();

		this.folderServices = { editorService, activeFolderService, putAwayEditorsService, contextService, extUri: uriIdentityService.extUri };

		this.updateActivityBadge();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Working copy dirty indicator
		this._register(this.workingCopyService.onDidChangeDirty(workingCopy => this.onWorkingCopyDidChangeDirty(workingCopy)));

		// Facade Code: the count is the folder on screen's, so it changes with what is on screen too - redrawn only when
		// it is another, as editors change all the time
		const updateIfChanged = () => {
			if (this.dirtyCountOnScreen() !== this.lastKnownDirtyCount) {
				this.updateActivityBadge();
			}
		};
		this._register(this.editorService.onDidEditorsChange(updateIfChanged));
		this._register(this.activeFolderService.onDidChangeActiveFolder(updateIfChanged));
		this._register(this.putAwayEditorsService.onDidChange(updateIfChanged));
	}

	private onWorkingCopyDidChangeDirty(workingCopy: IWorkingCopy): void {
		const gotDirty = workingCopy.isDirty();
		if (gotDirty && !(workingCopy.capabilities & WorkingCopyCapabilities.Untitled) && this.filesConfigurationService.hasShortAutoSaveDelay(workingCopy.resource)) {
			return; // do not indicate dirty of working copies that are auto saved after short delay
		}

		if (gotDirty || this.lastKnownDirtyCount > 0) {
			this.updateActivityBadge();
		}
	}

	private updateActivityBadge(): void {
		const dirtyCount = this.lastKnownDirtyCount = this.dirtyCountOnScreen();

		// Indicate dirty count in badge if any
		if (dirtyCount > 0) {
			this.badgeHandle.value = this.activityService.showViewContainerActivity(
				VIEWLET_ID,
				{
					badge: new NumberBadge(dirtyCount, num => num === 1 ? nls.localize('dirtyFile', "1 unsaved file") : nls.localize('dirtyFiles', "{0} unsaved files", dirtyCount)),
				}
			);
		} else {
			this.badgeHandle.clear();
		}
	}

	/**
	 * Facade Code: the unsaved files of the folder on screen (WORKSPACE.md W6.2) - those its editors show, and of the
	 * rest, changed with no editor at all (an edit across files, say), those inside it (`unsavedFileFolder`). Another
	 * folder's, put away with its editors, are out of sight and out of the count; saving and closing take them in still.
	 * With no folder on screen, every unsaved file, as stock counts.
	 */
	private dirtyCountOnScreen(): number {
		const folder = this.activeFolderService.activeFolder;
		if (!folder) {
			return this.workingCopyService.dirtyCount;
		}

		return this.workingCopyService.dirtyWorkingCopies.filter(workingCopy => {
			const holder = unsavedFileFolder(workingCopy.resource, this.folderServices);
			return !!holder && this.uriIdentityService.extUri.isEqual(holder.uri, folder.uri);
		}).length;
	}
}
