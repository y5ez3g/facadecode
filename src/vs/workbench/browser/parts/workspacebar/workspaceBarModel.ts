/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { canonicalUri, folderKey, FolderKey } from './workspaceBar.js';

/**
 * The rows: the workspace's own roots.
 *
 * ⚠️ Not a list of ours. A row IS a folder of the workspace, so what someone saves is an ordinary
 * `.code-workspace` and everything the workbench already does with one keeps working. Nothing here
 * stores a list; it reads the workspace, adds to it and takes away from it.
 */
export class WorkspaceBarModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** How everyone in the bar agrees which rows are one folder. */
	readonly key: FolderKey;

	get folders(): readonly IWorkspaceFolder[] {
		return this.contextService.getWorkspace().folders;
	}

	/**
	 * Folders that could not be reached. ⚠️ Marked, never dropped: deleted, unplugged and
	 * removed-from-a-terminal look the same from here, and the row is the only way to remove one.
	 */
	private unavailable = new Set<string>();

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IFileService private readonly fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super();

		this.key = uri => folderKey(uriIdentityService, uri);

		// ⚠️ Whoever edited it - the bar, the extension API, or someone typing in the workspace
		// file. The bar is a view of the folder list, not the only way to change it.
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => {
			this._onDidChange.fire();
			this.refreshAvailability().then(undefined, onUnexpectedError);
		}));

		this.refreshAvailability().then(undefined, onUnexpectedError);
	}

	isUnavailable(folder: IWorkspaceFolder): boolean {
		return this.unavailable.has(this.key(folder.uri));
	}

	/**
	 * Re-reads whether each folder's folder is still there. On demand, not watched: the moments
	 * worth paying for are starting up and a change to the list.
	 */
	async refreshAvailability(): Promise<void> {
		const folders = this.folders;
		const reachable = await Promise.all(folders.map(async folder => {
			try {
				return await this.fileService.exists(folder.uri);
			} catch {
				return false;	// a file system that cannot answer is one that cannot be switched to
			}
		}));

		const unavailable = new Set<string>();
		folders.forEach((folder, at) => {
			if (!reachable[at]) {
				unavailable.add(this.key(folder.uri));
			}
		});

		// Compared before firing: a redraw that changes nothing still costs focus and scroll.
		if (unavailable.size === this.unavailable.size && [...unavailable].every(key => this.unavailable.has(key))) {
			return;
		}

		this.unavailable = unavailable;
		this._onDidChange.fire();
	}

	/**
	 * Puts folders in the workspace, in the order given, skipping the ones already there.
	 *
	 * ⚠️ Against the batch as well as against the workspace. `doUpdateFolders` works out what is
	 * already there once, before its loop, so one call carrying the same folder twice writes it
	 * twice - and a `.code-workspace` dropped on the window can list one folder twice.
	 *
	 * ⚠️ Canonicalised on the way in, not on the way out: `/tmp` and `/private/tmp` are one place
	 * on macOS, and the workspace file should say which one only once.
	 */
	async add(uris: readonly URI[]): Promise<readonly URI[]> {
		const canonical = await Promise.all(uris.map(uri => canonicalUri(this.fileService, uri)));

		const listed = new Set(this.folders.map(folder => this.key(folder.uri)));
		const adding: URI[] = [];
		for (const uri of canonical) {
			const key = this.key(uri);
			if (listed.has(key)) {
				continue;
			}

			listed.add(key);
			adding.push(uri);
		}

		if (adding.length > 0) {
			await this.workspaceEditingService.addFolders(adding.map(uri => ({ uri })));
		}

		return adding;
	}

	/** Takes folders out of the workspace. ⚠️ Out of the list only - nothing here touches the disk. */
	async remove(uris: readonly URI[]): Promise<readonly IWorkspaceFolder[]> {
		const keys = new Set(uris.map(uri => this.key(uri)));
		const removing = this.folders.filter(folder => keys.has(this.key(folder.uri)));
		if (removing.length === 0) {
			return removing;
		}

		await this.workspaceEditingService.removeFolders(removing.map(folder => folder.uri));

		// Or the same folder added again would come back already marked as missing.
		for (const folder of removing) {
			this.unavailable.delete(this.key(folder.uri));
		}

		return removing;
	}
}
