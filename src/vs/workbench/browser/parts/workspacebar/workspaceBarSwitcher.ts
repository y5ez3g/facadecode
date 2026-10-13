/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { folderKey, pathOf, unreachable } from './workspaceBar.js';
import { WorkspaceBarEditors } from './workspaceBarEditors.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';

/** How a request to move the window ended (WORKSPACE.md W6.2); a failure has already been reported. */
export type SwitchResult =
	| { readonly kind: 'shown' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly reason: string };

/** The parts where someone works, whose focus a switch back restores. */
const WORK_PARTS = [Parts.EDITOR_PART, Parts.PANEL_PART, Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART] as const;

/** Moves the window from one folder to another, one request at a time with the latest winning (WORKSPACE.md W6.2). */
export class WorkspaceBarSwitcher extends Disposable {

	readonly onDidChangeActive: Event<void>;

	/** The folder the window is on. */
	get active(): URI | undefined { return this.activeFolderService.activeFolder?.uri; }

	/** The folder whose editors are on screen, or on their way there. */
	private showing: string | undefined;

	/** Settles once the last requested editors are restored or have failed to be. */
	private settled: Promise<void> = Promise.resolve();

	/** Why the last restore failed, if it did. */
	private restoreFailure: unknown;

	/** The newest request waiting its turn. */
	private waiting: { readonly uri: URI; readonly added: readonly URI[]; readonly done: DeferredPromise<SwitchResult> } | undefined;
	private running = false;

	/** The part last worked in, per folder key. */
	private readonly lastWorkedIn = new Map<string, typeof WORK_PARTS[number]>();

	/** Fires once a switch has restored the incoming folder's editors. */
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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		this.onDidChangeActive = this.activeFolderService.onDidChangeActiveFolder;

		this._register(addDisposableListener(mainWindow.document, EventType.FOCUS_IN, e => this.noteFocus(e.target)));

		// The workbench has already restored the active folder's editors
		const active = this.active;
		this.showing = active && this.key(active);

		// Joined behind any restore in flight, so a failed capture stops the switch before anything closes
		this._register(this.activeFolderService.onWillChangeActiveFolder(e => {
			if (!e.from) {
				return;
			}

			const from = e.from.uri;
			e.join(this.settled.then(() => editors.capture(from)));
		}));

		// Also fires when the active folder is renamed, which keeps its key and must restore nothing
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
			this.restoreFailure = undefined;
			this.settled = editors.restore(active).then(
				() => this._onDidRestoreEditors.fire(),
				error => {
					this.restoreFailure = error;
					this.logService.error(`[workspaceBar] failed to restore editors for ${key}`, error);
				});
		}));
	}

	private key(uri: URI): string {
		return folderKey(this.uriIdentityService, uri);
	}

	private noteFocus(target: EventTarget | null): void {
		const active = this.active;
		if (!active || !(target instanceof Node)) {
			return;
		}

		for (const part of WORK_PARTS) {
			if (this.layoutService.getContainer(mainWindow, part)?.contains(target)) {
				this.lastWorkedIn.set(this.key(active), part);
				return;
			}
		}
	}

	/** Moves the window onto `uri`; `added` are the folders put in the workspace for this move. */
	switchTo(uri: URI, added: readonly URI[] = []): Promise<SwitchResult> {
		this.waiting?.done.complete({ kind: 'cancelled' });
		const done = new DeferredPromise<SwitchResult>();
		this.waiting = { uri, added, done };
		void this.drain();
		return done.p;
	}

	private async drain(): Promise<void> {
		if (this.running) {
			return;
		}

		this.running = true;
		try {
			while (this.waiting) {
				const { uri, added, done } = this.waiting;
				this.waiting = undefined;
				let result: SwitchResult;
				try {
					result = await this.run(uri);
				} catch (error) {
					result = { kind: 'failed', reason: toErrorMessage(error) };
				}

				// Joined, but the window did not get there (W5); a failed restore leaves it on the folder
				if (result.kind === 'failed' && added.length > 0 && !this.isOn(uri)) {
					this.sayAdded(uri, added);
				}
				done.complete(result);
			}
		} finally {
			this.running = false;
		}
	}

	private async run(uri: URI): Promise<SwitchResult> {
		// Checked on every switch, as a folder can go while the window is open; a failed read is not a deletion
		const why = await unreachable(this.fileService, uri);
		if (why) {
			let reason: string;
			if (why.kind === 'missing') {
				this.logService.warn(`[workspaceBar] ${this.key(uri)} is not on disk any more`);
				this.notificationService.error(localize('workspaceBar.gone', "Folder '{0}' no longer exists on disk.", pathOf(uri)));
				reason = localize('workspaceBar.goneReason', "no longer exists on disk");
			} else {
				this.logService.warn(`[workspaceBar] ${this.key(uri)} could not be read: ${why.reason}`);
				this.notificationService.error(localize('workspaceBar.unreadable', "Failed to read folder '{0}': {1}", pathOf(uri), why.reason));
				reason = why.reason;
			}

			// Keeps the row marked after the notification is gone
			await this.model.refreshAvailability();
			return { kind: 'failed', reason };
		}

		if (this.isOn(uri)) {
			return { kind: 'shown' };
		}

		try {
			await this.activeFolderService.setActiveFolder(uri);
		} catch (error) {
			if (isCancellationError(error)) {
				return { kind: 'cancelled' };
			}

			// The outgoing folder could not be captured, so nothing has changed (W6.2)
			const reason = toErrorMessage(error);
			this.logService.error(`[workspaceBar] could not leave for ${this.key(uri)}`, error);
			this.notificationService.error(localize('workspaceBar.couldNotLeave', "Failed to switch folder: could not store the open editors of the current folder. {0}", reason));
			return { kind: 'failed', reason };
		}

		await this.settled;
		if (this.restoreFailure !== undefined) {
			// The window stays on the target, and both folders' editor sets are kept (W6.2)
			const reason = toErrorMessage(this.restoreFailure);
			this.notificationService.error(localize('workspaceBar.couldNotRestore', "Some editors could not be restored for this folder. {0}", reason));
			return { kind: 'failed', reason };
		}

		// Focus where this folder was left, or the editor on a first visit (W6.2)
		const part = this.lastWorkedIn.get(this.key(uri)) ?? Parts.EDITOR_PART;
		this.layoutService.focusPart(part, mainWindow);

		return { kind: 'shown' };
	}

	private isOn(uri: URI): boolean {
		return !!this.active && this.uriIdentityService.extUri.isEqual(this.active, uri);
	}

	private sayAdded(target: URI, added: readonly URI[]): void {
		this.notificationService.info(added.length === 1 && this.uriIdentityService.extUri.isEqual(added[0], target)
			? localize('workspaceBar.addedNotShown', "Folder '{0}' was added to the workspace, but could not be switched to.", pathOf(target))
			: localize('workspaceBar.addedNotShownOf', "Added folders to the workspace: {0}. Failed to switch to '{1}'.", added.map(pathOf).join(', '), pathOf(target)));
	}
}
