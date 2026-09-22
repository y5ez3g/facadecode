/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
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

	/** The folder whose editors are on screen, or on their way there. */
	private showing: string | undefined;

	/** Resolves when the editors asked for last are actually up. */
	private settled: Promise<void> = Promise.resolve();

	/**
	 * Fires once a switch has put the incoming folder's editors on screen. Not fired for a rename,
	 * where nothing is restored.
	 */
	private readonly _onDidRestoreEditors = this._register(new Emitter<void>());
	readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

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

		// ⚠️ The window already has a folder before anybody clicks anything, and its editors are up:
		// the workbench restored them. Starting this blank would make the first event - a rename, say -
		// look like a move and put a saved set over what is on screen.
		const active = this.active;
		this.showing = active && this.key(active);

		// ⚠️ On the way out, while the folder being left is still on screen: the set is read out of
		// the live editor part. Reversed, this writes the outgoing folder's editors into the
		// incoming one's slot.
		//
		// ⚠️ Behind whatever restore is still in flight, and **joined**, so the switch waits for it.
		// `switchTo` returns as soon as the active folder has moved - the restore that follows is
		// started, not awaited - so a switch can be finished and awaited while the editors it asked
		// for are still arriving. Capturing then reads a screen that still holds the folder before
		// last, and writes it into this folder's slot. Joining is what makes capture, move and
		// restore one piece of work rather than three that can overlap.
		this._register(this.activeFolderService.onWillChangeActiveFolder(e => {
			if (!e.from) {
				return;
			}

			const key = this.key(e.from.uri);
			e.join(this.settled.then(() => editors.capture(key)));
		}));

		// And now the other way round, against the folder the window is on.
		//
		// ⚠️ Also fires when the active root was removed from the workspace and the service moved to
		// its neighbour. Restoring is right there too: nothing was captured on the way out, because
		// the folder that was left no longer exists to come back to.
		//
		// ⚠️ And it fires when the active root was only **renamed**, because the name is drawn in the
		// title and the explorer's header and they have to hear about it. That is not a move, and
		// restoring on it would put back whatever this folder had saved last time - or nothing at all
		// for one that has never been left - over the editors somebody has open right now.
		this._register(this.activeFolderService.onDidChangeActiveFolder(() => {
			const active = this.active;
			if (!active) {
				return;
			}

			const key = this.key(active);
			if (key === this.showing) {
				return;
			}

			this.showing = key;
			this.settled = editors.restore(key).then(() => this._onDidRestoreEditors.fire(), onUnexpectedError);
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
