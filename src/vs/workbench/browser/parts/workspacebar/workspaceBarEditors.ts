/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { EditorExtensions, EditorsOrder, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { AbstractTextResourceEditorInput } from '../../../common/editor/textResourceEditorInput.js';
import { IEditorGroup, IEditorGroupsService, IEditorWorkingSet } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHeldEditorsService } from '../../../services/heldEditors/common/heldEditors.js';
import { IPutAwayEditorsService } from '../../../services/putAwayEditors/common/putAwayEditors.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
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

/**
 * Each folder's editors as an editor working set, as `contrib/scm/browser/workingSet.ts` keeps one per branch.
 * Unsaved text editors are put away with their folder and come back with it (WORKSPACE.md W6.2).
 */
export class WorkspaceBarEditors extends Disposable {

	private readonly sets = new Map<string, IEditorWorkingSet>();

	/** The folder being left and its unsaved editors, put away once the next folder's editors are up. */
	private leaving: { readonly folder: URI; readonly unsaved: readonly URI[] } | undefined;

	/** References that keep the text files of folders out of sight loaded (WORKSPACE.md W13). */
	private readonly resident = new Map<string, DisposableStore>();

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IHeldEditorsService private readonly heldEditorsService: IHeldEditorsService,
		@IPutAwayEditorsService private readonly putAwayEditorsService: IPutAwayEditorsService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
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

		const unsaved = new ResourceMap<URI>(uri => this.key(uri));
		const open = new ResourceMap<URI>(uri => this.key(uri));
		for (const { editor } of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			if (editor.resource && editor.isDirty() && this.canPutAway(editor)) {
				unsaved.set(editor.resource, editor.resource);
			}
			if (editor.resource && editor instanceof AbstractTextResourceEditorInput) {
				open.set(editor.resource, editor.resource);
			}
		}
		this.leaving = { folder, unsaved: [...unsaved.values()] };

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
	 * Puts back `folder`'s editors, and puts away the unsaved ones of the folder just captured; called after
	 * the active folder changes. Rejects, leaving the screen as it was, when the editor part declines.
	 */
	async restore(folder: URI): Promise<void> {
		const key = this.key(folder);
		const set = this.sets.get(key);

		// Only a captured folder's editors are put away: one that left the workspace keeps them on screen (W9.6)
		const leaving = this.leaving;
		this.leaving = undefined;

		// Before they are closed, or `TextFileEditorTracker` opens them again here
		if (leaving) {
			this.putAwayEditorsService.set(leaving.folder, leaving.unsaved);
		}

		// An editor a program waits on stays: closing it would tell `git commit` its message is written (W6.2)
		const applied = await this.editorGroupsService.applyWorkingSet(set ?? 'empty', {
			preserveFocus: true,
			exclude: editor => this.heldEditorsService.isHeld(editor),
			putAway: editor => !!leaving && this.canPutAway(editor)
		});
		if (!applied) {
			if (leaving) {
				this.putAwayEditorsService.set(leaving.folder, []);
			}
			this.logService.warn(`[workspaceBar] the editor part declined the editors of ${key}`);
			// Shown after the switcher's "Some editors could not be restored for this folder."
			throw new Error(localize('workspaceBar.editorsNotClosed', "The open editors could not be closed."));
		}

		// Focus given to a text editor before it has its model is lost, so wait for the active editors, bounded
		await raceTimeout(Promise.all(this.editorGroupsService.groups.map(whenRestored)), EDITORS_RESOLVED_TIMEOUT);

		this.putAwayEditorsService.set(folder, []);
		this.resident.get(key)?.dispose();
		this.resident.delete(key);
	}

	/**
	 * Drops the editor sets of folders no longer in the workspace, however they left. Unsaved editors put
	 * away by a folder that left are opened again here (W9.6).
	 */
	async prune(members: readonly URI[]): Promise<void> {
		const keys = new Set(members.map(member => this.key(member)));
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

		const bringBack: URI[] = [];
		for (const folder of this.putAwayEditorsService.folders()) {
			if (keys.has(this.key(folder))) {
				continue;
			}

			bringBack.push(...this.putAwayEditorsService.get(folder).filter(resource => this.workingCopyService.isDirty(resource)));
			this.putAwayEditorsService.set(folder, []);
		}

		if (bringBack.length) {
			await this.editorService.openEditors(bringBack.map(resource => ({ resource, options: { pinned: true, preserveFocus: true, inactive: true } })));
		}
	}

	/** Whether `editor` can be put away: a text or untitled editor its working set can bring back (W6.2). */
	private canPutAway(editor: EditorInput): boolean {
		return editor instanceof AbstractTextResourceEditorInput
			&& !this.heldEditorsService.isHeld(editor)
			&& !!Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).getEditorSerializer(editor)?.canSerialize(editor);
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
