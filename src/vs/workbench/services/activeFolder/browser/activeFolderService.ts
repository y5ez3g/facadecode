/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Promises } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IHistoryService } from '../../history/common/history.js';
import { IActiveFolderService, IActiveFolderWillChangeEvent } from '../common/activeFolder.js';

/**
 * ⚠️ `StorageScope.WORKSPACE`: which root a window is on is a fact about that window. It survives
 * an edit to the folder list, because the workspace id is the hash of the configuration path and
 * editing folders does not change it, and it is carried through Save Workspace As, because
 * `enterWorkspace` switches the storage with its data preserved.
 */
const STORAGE_KEY = 'workbench.activeFolder';

export class ActiveFolderService extends Disposable implements IActiveFolderService {

	declare readonly _serviceBrand: undefined;

	private readonly _onWillChangeActiveFolder = this._register(new Emitter<IActiveFolderWillChangeEvent>());
	readonly onWillChangeActiveFolder: Event<IActiveFolderWillChangeEvent> = this._onWillChangeActiveFolder.event;

	private readonly _onDidChangeActiveFolder = this._register(new Emitter<void>());
	readonly onDidChangeActiveFolder: Event<void> = this._onDidChangeActiveFolder.event;

	private _activeFolder: IWorkspaceFolder | undefined;
	get activeFolder(): IWorkspaceFolder | undefined { return this._activeFolder; }

	/** The root a deliberate move left, by its folder: an index would point elsewhere once the list changed. */
	private _previousFolder: URI | undefined;
	get previousFolder(): IWorkspaceFolder | undefined {
		const folder = this._previousFolder && this.folderFor(this._previousFolder);
		return folder && !(this._activeFolder && this.uriIdentityService.extUri.isEqual(folder.uri, this._activeFolder.uri)) ? folder : undefined;
	}

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IHistoryService historyService: IHistoryService,
	) {
		super();

		this._activeFolder = this.restore(historyService);

		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.reconcile()));
	}

	private folderFor(uri: URI): IWorkspaceFolder | undefined {
		return this.contextService.getWorkspace().folders.find(folder => this.uriIdentityService.extUri.isEqual(folder.uri, uri));
	}

	/**
	 * Where a window starts. ⚠️ Upstream's guess, taken once and only when nothing was stored: a
	 * workspace reopened with its editors is already on a root, and starting on `folders[0]`
	 * instead leaves the bar naming one project while the editor shows another.
	 */
	private restore(historyService: IHistoryService): IWorkspaceFolder | undefined {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		const stored = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try {
				const remembered = this.folderFor(URI.parse(stored));
				if (remembered) {
					return remembered;
				}
			} catch {
				// A corrupt value costs the starting row, not the window.
			}
		}

		const guessed = historyService.getLastActiveWorkspaceRoot();

		return (guessed && this.folderFor(guessed)) ?? folders[0];
	}

	/**
	 * Keeps up with an edit to the folder list, whoever made it - the bar, the extension API, or
	 * someone typing in the `.code-workspace` file.
	 *
	 * ⚠️ By index when the active root is gone: the folders below it have moved up, so the one now
	 * holding its index is the row that took its place. That is what the list does visually, and
	 * the two have to agree.
	 */
	private reconcile(): void {
		const folders = this.contextService.getWorkspace().folders;
		const previous = this._activeFolder;

		if (!previous) {
			if (folders.length > 0) {
				this._activeFolder = folders[0];
				this.save();
				this._onDidChangeActiveFolder.fire();
			}
			return;
		}

		const current = this.folderFor(previous.uri);
		if (current) {
			// The same root, in a list that was rebuilt around it. ⚠️ Adopted rather than kept, so
			// that the index this reads next time is the one the folder has now.
			this._activeFolder = current;

			// ⚠️ The name and not the index. The name is drawn - in the title, in the explorer's
			// header, on the row - so a `.code-workspace` edited to rename this root has to reach
			// them. The index is this class's own bookkeeping and nobody outside it reads one, so
			// firing when a folder somewhere else is removed would be noise.
			if (current.name !== previous.name) {
				this._onDidChangeActiveFolder.fire();
			}
			return;
		}

		// Gone. ⚠️ By index: the folders below it have moved up, so whichever now holds its index is
		// the row that took its place. That is what the list does on screen, and the two have to agree.
		this._activeFolder = folders.length > 0 ? folders[Math.min(previous.index, folders.length - 1)] : undefined;
		this.save();
		this._onDidChangeActiveFolder.fire();
	}

	activeFolderFor(scheme?: string, authority?: string): IWorkspaceFolder | undefined {
		const matches = (folder: IWorkspaceFolder) =>
			(!scheme || folder.uri.scheme === scheme) && (!authority || folder.uri.authority === authority);

		if (this._activeFolder && matches(this._activeFolder)) {
			return this._activeFolder;
		}

		return this.contextService.getWorkspace().folders.find(matches);
	}

	async setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void> {
		const uri = URI.isUri(folder) ? folder : folder.uri;
		const target = this.folderFor(uri);
		if (!target) {
			// Racing a removal. Reported rather than adopted: a root that is not in the workspace
			// cannot be shown by the parts that read the workspace.
			throw new Error(`Invalid active folder: '${uri.toString(true)}' does not belong to the current workspace.`);
		}

		if (this._activeFolder && this.uriIdentityService.extUri.isEqual(this._activeFolder.uri, target.uri)) {
			return;
		}

		const from = this._activeFolder;
		await this.willChange(from, target.uri);

		// The folder may have left, been renamed or moved while the joiners ran
		const current = this.folderFor(target.uri);
		if (!current) {
			throw new CancellationError();
		}
		if (this._activeFolder && this.uriIdentityService.extUri.isEqual(this._activeFolder.uri, current.uri)) {
			return;
		}

		this._previousFolder = from?.uri;
		this._activeFolder = current;
		this.save();
		this._onDidChangeActiveFolder.fire();
	}

	async startOn(folder: URI): Promise<void> {
		// The editors on screen are the folder's being left, and the reload keeps what is on screen
		if (!this._activeFolder || !this.uriIdentityService.extUri.isEqual(this._activeFolder.uri, folder)) {
			await this.willChange(this._activeFolder, folder);
		}

		// As the folder it is on is kept: what `restore` reads, the workspace by then having it
		this.storageService.store(STORAGE_KEY, folder.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** Announces a move and waits for the work its listeners join; a joiner that fails stops it while nothing has changed yet (WORKSPACE.md W6.2). */
	private async willChange(from: IWorkspaceFolder | undefined, to: URI): Promise<void> {
		const joiners: Promise<void>[] = [];
		this._onWillChangeActiveFolder.fire({ from, to, join(promise) { joiners.push(promise); } });
		await Promises.settled(joiners);
	}

	private save(): void {
		if (this._activeFolder) {
			this.storageService.store(STORAGE_KEY, this._activeFolder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

registerSingleton(IActiveFolderService, ActiveFolderService, InstantiationType.Delayed);
