/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { EditorsOrder } from '../../../common/editor.js';
import { AbstractTextResourceEditorInput } from '../../../common/editor/textResourceEditorInput.js';
import { IEditorGroup, IEditorGroupsService, IEditorWorkingSet } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { folderKey } from './workspaceBar.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { IEditorGroupView } from '../editor/editor.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';

const STORAGE_KEY = 'workbench.workspaceBar.editorSets';

/** Settles once the active editor of one of the editor part's groups has resolved. */
function whenRestored(group: IEditorGroup): Promise<void> | undefined {
	return (group as Partial<IEditorGroupView>).whenRestored;
}

/** How long a switch waits for its editors to resolve. */
const EDITORS_RESOLVED_TIMEOUT = 3000;

/** Each folder's editors as an editor working set, as `contrib/scm/browser/workingSet.ts` keeps one per branch. */
export class WorkspaceBarEditors extends Disposable {

	private readonly sets = new Map<string, IEditorWorkingSet>();

	/** References that keep the text files of folders out of sight loaded (WORKSPACE.md W13). */
	private readonly resident = new Map<string, DisposableStore>();

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super();

		this.load();
		this._register(toDisposable(() => {
			for (const store of this.resident.values()) {
				store.dispose();
			}
			this.resident.clear();
		}));
	}

	/** Stores the editors on screen as `folder`'s; called before the active folder changes. */
	capture(folder: URI): void {
		const key = this.key(folder);

		// The editor part keeps every set it is given, so the previous one is deleted
		const previous = this.sets.get(key);
		if (previous) {
			this.editorGroupsService.deleteWorkingSet(previous);
		}

		this.sets.set(key, this.editorGroupsService.saveWorkingSet(key));
		this.save();

		const open = new ResourceMap<URI>(uri => this.key(uri));
		for (const { editor } of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			if (editor.resource && editor instanceof AbstractTextResourceEditorInput) {
				open.set(editor.resource, editor.resource);
			}
		}

		// Referenced while the editors still hold the models, so none is disposed in between
		this.resident.get(key)?.dispose();
		const store = new DisposableStore();
		this.resident.set(key, store);
		for (const resource of open.values()) {
			this.textModelService.createModelReference(resource).then(reference => {
				if (store.isDisposed) {
					reference.dispose();
				} else {
					store.add(reference);
				}
			}, () => { /* not a text model after all: nothing to hold */ });
		}
	}

	/**
	 * Puts back `folder`'s editors, or clears them for a folder never seen; called after the active folder
	 * changes. Rejects, leaving the screen as it was, when the editor part declines.
	 */
	async restore(folder: URI): Promise<void> {
		const key = this.key(folder);
		const set = this.sets.get(key);

		const applied = await this.editorGroupsService.applyWorkingSet(set ?? 'empty', { preserveFocus: true });
		if (!applied) {
			this.logService.warn(`[workspaceBar] the editor part declined the editors of ${key}`);
			// Shown after the switcher's "Some editors could not be restored for this folder."
			throw new Error(localize('workspaceBar.editorsNotClosed', "The open editors could not be closed."));
		}

		// Focus given to a text editor before it has its model is lost, so wait for the active editors, bounded
		await raceTimeout(Promise.all(this.editorGroupsService.groups.map(whenRestored)), EDITORS_RESOLVED_TIMEOUT);

		this.resident.get(key)?.dispose();
		this.resident.delete(key);
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

		for (const [key, store] of [...this.resident]) {
			if (!keys.has(key)) {
				store.dispose();
				this.resident.delete(key);
			}
		}

		if (dropped) {
			this.save();
		}
	}

	private key(uri: URI): string {
		return folderKey(this.uriIdentityService, uri);
	}

	/** Workspace scoped, as the working sets it points at are. */
	private load(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) {
				return;
			}

			const known = new Set(this.editorGroupsService.getWorkingSets().map(set => set.id));
			for (const [key, set] of JSON.parse(raw) as [string, IEditorWorkingSet][]) {
				// Stored apart from the working sets, so it can point at one that is gone
				if (known.has(set.id)) {
					this.sets.set(key, set);
				}
			}
		} catch {
			// A corrupt value loses the editor sets only
		}
	}

	private save(): void {
		this.storageService.store(STORAGE_KEY, JSON.stringify([...this.sets]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
