/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { folderKey } from './workspaceBar.js';
import { WorkspaceBarEditors } from './workspaceBarEditors.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';

/**
 * Takes the window from one folder to another.
 *
 * ⚠️ Nothing moves. The workspace goes on holding every root; only which one the workbench draws
 * changes. So there is no queue here, no guard against a burst of clicks and no way back from a
 * failure - none of them have anything to fail at. What is left is the bar's two errands either
 * side of the change: the folder's editors, and saying so when a folder is not there any more.
 */
export class WorkspaceBarSwitcher extends Disposable {

	readonly onDidChangeActive: Event<void>;

	/** The folder the window is on. */
	get active(): URI | undefined { return this.activeFolderService.activeFolder?.uri; }

	constructor(
		private readonly model: WorkspaceBarModel,
		editors: WorkspaceBarEditors,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();

		this.onDidChangeActive = this.activeFolderService.onDidChangeActiveFolder;

		// ⚠️ On the way out, while the folder being left is still on screen: the set is read out of
		// the live editor part. Reversed, this writes the outgoing folder's editors into the
		// incoming one's slot.
		this._register(this.activeFolderService.onWillChangeActiveFolder(e => {
			if (e.from) {
				editors.capture(this.key(e.from.uri));
			}
		}));

		// And now the other way round, against the folder the window is on.
		//
		// ⚠️ Also fires when the active root was removed from the workspace and the service moved to
		// its neighbour. Restoring is right there too: nothing was captured on the way out, because
		// the folder that was left no longer exists to come back to.
		this._register(this.activeFolderService.onDidChangeActiveFolder(() => {
			const active = this.active;
			if (active) {
				editors.restore(this.key(active)).then(undefined, onUnexpectedError);
			}
		}));
	}

	private key(uri: URI): string {
		return folderKey(this.uriIdentityService, uri);
	}

	async switchTo(uri: URI): Promise<void> {
		// Before anything else: a row whose folder has gone answers with the reason rather than a
		// root row carrying a file-system error, which is what the explorer would draw instead.
		//
		// ⚠️ On the hot path on purpose, and it can afford to be: measured at 1-4ms against a switch
		// that takes 49-86ms end to end, nearly all of it redrawing. The alternative is the model's
		// own record of what is reachable, which is only as fresh as the last change to the folder
		// list - and a folder that went away while the window sat open is exactly the case this is
		// for.
		if (!(await this.fileService.exists(uri))) {
			this.logService.warn(`[workspaceBar] ${this.key(uri)} is not on disk any more`);
			this.notificationService.error(localize('workspaceBar.gone', "{0} is not on disk any more.", uri.fsPath));

			// And shown from then on: a notification is gone in five seconds.
			await this.model.refreshAvailability();
			return;
		}

		await this.activeFolderService.setActiveFolder(uri);
	}
}
