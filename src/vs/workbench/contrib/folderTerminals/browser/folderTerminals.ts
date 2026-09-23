/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { folderKey } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { GroupsOrder, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, AUX_WINDOW_GROUP } from '../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Controls whether a terminal in the editor area belongs to the folder it was opened in.
 */
export const FOLLOW_FOLDER = 'facade.terminal.followFolder';

/**
 * The column recorded for a terminal whose tab was in an auxiliary window rather than the main
 * editor grid.
 */
const AUXILIARY_WINDOW = -1;

/**
 * A terminal that has been taken out of the editor area, and the tab it should be given back.
 */
interface IParkedTerminal {
	readonly instance: ITerminalInstance;

	/** The column of the main editor grid, or {@link AUXILIARY_WINDOW}. */
	readonly column: number;

	/** The index within that column. Not meaningful for an auxiliary window. */
	readonly index: number;

	/** The `forcePersist` value to restore once the terminal is shown again. */
	readonly persisted: boolean | undefined;
}

/**
 * Keeps a terminal editor alive across a folder switch and puts it back where it was.
 *
 * Switching folders applies an editor working set, which closes every editor that is not part of
 * it. A `TerminalEditorInput` disposes its instance when it is closed, so without this the shells
 * of the folder being left are killed. Terminals are instead moved to the background before the
 * working set is captured, and shown again once the incoming folder's editors are up.
 */
export class FolderTerminals extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.folderTerminals';

	private readonly _parked = new Map</*folder*/string, IParkedTerminal[]>();
	private readonly _watching = new Map</*folder*/string, DisposableStore>();

	/**
	 * Incremented by every folder switch. A restore in flight compares against it and stops when it
	 * has moved, so that terminals are not shown in a folder they do not belong to.
	 */
	private _generation = 0;

	constructor(
		@IActiveFolderService private readonly _activeFolderService: IActiveFolderService,
		@IWorkspaceBarService private readonly _workspaceBarService: IWorkspaceBarService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@ILogService private readonly _logService: ILogService
	) {
		super();

		this._register(this._activeFolderService.onWillChangeActiveFolder(e => {
			// Every switch, including one that has nothing to park, so that a restore in flight stops
			this._generation++;

			if (e.from && this._isEnabled()) {
				this._park(this._key(e.from.uri));
			}
		}));

		// Not on the folder change itself: the workspace bar starts its restore there without
		// awaiting it, so terminals shown at that point are closed again by the working set
		this._register(this._workspaceBarService.onDidRestoreEditors(() => {
			const folder = this._activeFolderService.activeFolder;
			if (folder) {
				this._unpark(this._key(folder.uri)).then(undefined, onUnexpectedError);
			}
		}));

		// A folder can leave the workspace without the active folder service announcing it first, in
		// which case nothing parks and the terminals would be held for a folder that is gone
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this._pruneRemovedFolders()));

		this._register(toDisposable(() => this._forgetAll()));
	}

	private _isEnabled(): boolean {
		return this._configurationService.getValue<boolean>(FOLLOW_FOLDER) !== false;
	}

	/**
	 * Moves the folder's terminal editors to the background, recording where each one was.
	 *
	 * Only terminals that currently have a tab are taken; a panel terminal belongs to the window
	 * and one that is already in the background has no position to read. Positions are read and the
	 * record written before anything is moved, since backgrounding closes tabs and renumbers the
	 * ones after them.
	 */
	private _park(key: string): void {
		const parking: IParkedTerminal[] = [];

		for (const instance of this._terminalService.instances) {
			if (instance.target !== TerminalLocation.Editor) {
				continue;
			}

			const place = this._placeOf(instance);
			if (place) {
				parking.push({ instance, ...place, persisted: instance.shellLaunchConfig.forcePersist });
			}
		}

		if (parking.length === 0) {
			return;
		}

		const held = this._parked.get(key) ?? [];
		this._parked.set(key, [...held, ...parking]);

		const store = this._watching.get(key) ?? new DisposableStore();
		this._watching.set(key, store);

		for (const { instance } of parking) {
			store.add(instance.onDisposed(() => this._forget(key, instance)));
		}

		for (const { instance } of parking) {
			// `setTerminalLayoutInfo` only persists backgrounded terminals that carry this, so without
			// it a window reload would discard the shells this contribution exists to keep
			instance.shellLaunchConfig.forcePersist = true;
			this._terminalService.moveToBackground(instance);
		}

		this._logService.trace(`[folderTerminals] parked ${parking.length} terminal(s) for ${key}`);
	}

	/**
	 * The position of a terminal's tab, or `undefined` when it does not have one.
	 */
	private _placeOf(instance: ITerminalInstance): { column: number; index: number } | undefined {
		const columns = this._editorGroupsService.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE);

		for (const [column, group] of columns.entries()) {
			const [editor] = group.findEditors(instance.resource);
			if (editor) {
				return { column, index: group.getIndexOfEditor(editor) };
			}
		}

		for (const part of this._editorGroupsService.parts) {
			if (part === this._editorGroupsService.mainPart) {
				continue;
			}

			for (const group of part.groups) {
				if (group.findEditors(instance.resource).length > 0) {
					return { column: AUXILIARY_WINDOW, index: -1 };
				}
			}
		}

		return undefined;
	}

	/**
	 * Shows the folder's terminals again, in the columns and at the tabs they were at.
	 *
	 * Entries are shown lowest index first so that each move lands in a column whose earlier tabs
	 * are already in place, and each one stays in the queue until it is actually back so that a
	 * failure or a second switch does not leave a live shell untracked.
	 */
	private async _unpark(key: string): Promise<void> {
		const parked = this._parked.get(key);
		if (!parked?.length) {
			return;
		}

		const generation = this._generation;
		const queue = [...parked].sort((a, b) => a.index - b.index);
		this._parked.set(key, queue);

		while (queue.length) {
			const entry = queue[0];

			try {
				// `preserveFocus` because the workspace bar restores its own editors that way and a
				// switch should not move the caret
				await this._terminalService.showBackgroundTerminal(entry.instance, true, {
					viewColumn: entry.column === AUXILIARY_WINDOW ? AUX_WINDOW_GROUP : ACTIVE_GROUP,
					preserveFocus: true
				});
			} catch (error) {
				this._logService.error(`[folderTerminals] could not reopen a terminal for ${key}`, error);
				return;
			}

			// The open cannot be cancelled once it is in flight, so a terminal that arrives after the
			// window has moved on is put straight back rather than left in the wrong folder
			if (this._generation !== generation) {
				this._terminalService.moveToBackground(entry.instance);
				this._logService.trace(`[folderTerminals] switch during restore, ${queue.length} terminal(s) still parked for ${key}`);
				return;
			}

			entry.instance.shellLaunchConfig.forcePersist = entry.persisted;
			this._restorePosition(entry);
			queue.shift();
		}

		this._parked.delete(key);
		this._watching.get(key)?.dispose();
		this._watching.delete(key);

		this._logService.trace(`[folderTerminals] reopened ${parked.length} terminal(s) for ${key}`);
	}

	/**
	 * Moves a terminal that has just been shown to the tab it was at. A separate move because the
	 * options a background terminal is shown with carry a column but no index.
	 */
	private _restorePosition({ instance, column, index }: IParkedTerminal): void {
		if (column === AUXILIARY_WINDOW || index < 0) {
			return;
		}

		const columns = this._editorGroupsService.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE);
		const target = columns[column];
		if (!target) {
			// The layout has fewer columns than it had; the terminal keeps the one it arrived in
			return;
		}

		const source = columns.find(group => group.findEditors(instance.resource).length > 0);
		if (!source) {
			return;
		}

		const [editor] = source.findEditors(instance.resource);
		if (editor && (source !== target || source.getIndexOfEditor(editor) !== index)) {
			source.moveEditor(editor, target, { index });
		}
	}

	private _forget(key: string, instance: ITerminalInstance): void {
		const remaining = (this._parked.get(key) ?? []).filter(candidate => candidate.instance !== instance);
		if (remaining.length) {
			this._parked.set(key, remaining);
			return;
		}

		this._parked.delete(key);
		this._watching.get(key)?.dispose();
		this._watching.delete(key);
	}

	private _pruneRemovedFolders(): void {
		const present = new Set(this._contextService.getWorkspace().folders.map(folder => this._key(folder.uri)));

		for (const [key, parked] of [...this._parked]) {
			if (present.has(key)) {
				continue;
			}

			this._logService.trace(`[folderTerminals] folder removed, disposing ${parked.length} parked terminal(s)`);
			this._parked.delete(key);
			this._watching.get(key)?.dispose();
			this._watching.delete(key);

			for (const { instance } of parked) {
				instance.dispose(TerminalExitReason.User);
			}
		}
	}

	private _forgetAll(): void {
		for (const store of this._watching.values()) {
			store.dispose();
		}

		this._watching.clear();
		this._parked.clear();
	}

	private _key(uri: URI): string {
		return folderKey(this._uriIdentityService, uri);
	}
}
