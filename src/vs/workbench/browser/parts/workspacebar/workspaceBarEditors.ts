/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../services/editor/common/editorGroupsService.js';

const STORAGE_KEY = 'workbench.workspaceBar.editorSets';

/**
 * Each folder's editors, so that switching to one brings back what was open in it. Nothing here
 * serialises an editor: `IEditorGroupsService` working sets do it in one call, the same way
 * `contrib/scm/browser/workingSet.ts` does per branch.
 */
export class WorkspaceBarEditors extends Disposable {

	private readonly sets = new Map<string, IEditorWorkingSet>();

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.load();
	}

	/**
	 * Stores the editors currently on screen under `key`. ⚠️ Before the folder changes: the set is
	 * read out of the live editor part.
	 */
	capture(key: string): void {
		// Replaced, not accumulated: `saveWorkingSet` mints a new set every time and the editor part
		// keeps every one it is given.
		const previous = this.sets.get(key);
		if (previous) {
			this.editorGroupsService.deleteWorkingSet(previous);
		}

		this.sets.set(key, this.editorGroupsService.saveWorkingSet(key));
		this.save();
	}

	/**
	 * Puts back the editors stored under `key`, or clears them when the folder has never been seen.
	 * ⚠️ After the folder has changed, so editors resolve against the new one.
	 */
	async restore(key: string): Promise<void> {
		const set = this.sets.get(key);

		try {
			// A folder nobody has opened yet starts clean: leaving the previous one's tabs up means
			// the row says one folder and the tabs say another. Focus stays where the click was.
			await this.editorGroupsService.applyWorkingSet(set ?? 'empty', { preserveFocus: true });
		} catch (error) {
			// A working set that cannot be applied costs this folder's editors, not the switch.
			this.logService.error(`[workspaceBar] failed to restore editors for ${key}`, error);
		}
	}

	/**
	 * Drops the editors of every folder that is no longer in the workspace.
	 *
	 * ⚠️ Not only the ones taken out through the bar. A folder can leave because someone edited the
	 * `.code-workspace` file or because an extension called `updateWorkspaceFolders`, and a set kept
	 * for a folder that is not there is a set nothing will ever ask for again - it would sit in
	 * storage, and in the editor part, for the life of the workspace.
	 *
	 * ⚠️ The working set too, not just our reference to it: the editor part keeps every set it is
	 * handed until it is told otherwise.
	 */
	prune(keys: ReadonlySet<string>): void {
		let dropped = false;

		for (const [key, set] of [...this.sets]) {
			if (keys.has(key)) {
				continue;
			}

			this.editorGroupsService.deleteWorkingSet(set);
			this.sets.delete(key);
			dropped = true;
		}

		if (dropped) {
			this.save();
		}
	}

	/**
	 * ⚠️ `StorageScope.WORKSPACE`, unlike the list of folders: the sets live in that scope, so a
	 * reference kept elsewhere outlives what it points at. Safe only while the window keeps one.
	 */
	private load(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) {
				return;
			}

			const known = new Set(this.editorGroupsService.getWorkingSets().map(set => set.id));
			for (const [key, set] of JSON.parse(raw) as [string, IEditorWorkingSet][]) {
				// The two are stored separately, so this side can point at nothing.
				if (known.has(set.id)) {
					this.sets.set(key, set);
				}
			}
		} catch {
			// A corrupt value costs the editor sets, not the bar.
		}
	}

	private save(): void {
		this.storageService.store(STORAGE_KEY, JSON.stringify([...this.sets]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
