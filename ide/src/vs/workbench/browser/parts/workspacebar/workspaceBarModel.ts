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
import { FolderReorder, IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { canonicalUri, folderKey, FolderKey, unreachable } from './workspaceBar.js';

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

	/** Folders that could not be reached, by key; marked rather than dropped, as the row is the way to remove one. */
	private unavailable = new Map<string, 'missing' | 'unreadable'>();

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

	/** Whether `folder` is unavailable because it could not be read, rather than not being there (WS-63). */
	isUnreadable(folder: IWorkspaceFolder): boolean {
		return this.unavailable.get(this.key(folder.uri)) === 'unreadable';
	}

	/**
	 * Re-reads whether each folder's folder is still there. On demand, not watched: the moments
	 * worth paying for are starting up and a change to the list.
	 */
	async refreshAvailability(): Promise<void> {
		const folders = this.folders;
		const reached = await Promise.all(folders.map(folder => unreachable(this.fileService, folder.uri)));

		const unavailable = new Map<string, 'missing' | 'unreadable'>();
		folders.forEach((folder, at) => {
			const why = reached[at];
			if (why) {
				unavailable.set(this.key(folder.uri), why.kind);
			}
		});

		// Compared before firing: a redraw that changes nothing still costs focus and scroll.
		if (unavailable.size === this.unavailable.size && [...unavailable].every(([key, why]) => this.unavailable.get(key) === why)) {
			return;
		}

		this.unavailable = unavailable;
		this._onDidChange.fire();
	}

	/**
	 * The one name this bar knows a folder by: its canonical spelling, resolved.
	 *
	 * ⚠️ To compare with, never to store. What goes into `folders[]` is the spelling whoever asked
	 * gave, exactly as `addFolders` would have written it: `/tmp/x` named on a command line belongs
	 * in a workspace file under `/tmp` as a sibling, and resolving it first turns that sibling into
	 * `../../private/tmp/x`. Which folder is this, and what should the file say, are two questions,
	 * and only the first one needs the symlink followed.
	 */
	private async canonicalKey(uri: URI): Promise<string> {
		return this.key(await canonicalUri(this.fileService, uri));
	}

	/**
	 * The row `uri` names, under whichever spelling the workspace holds it.
	 *
	 * ⚠️ Needed by anything that has to act on a folder after adding it: `add` answers with what it
	 * added, which is nothing when the folder was already there, and the caller's own spelling may
	 * not be the one in the workspace.
	 */
	async resolve(uri: URI): Promise<IWorkspaceFolder | undefined> {
		const folders = this.folders;
		const [wanted, listed] = await Promise.all([
			this.canonicalKey(uri),
			Promise.all(folders.map(folder => this.canonicalKey(folder.uri)))
		]);

		return folders.find((_, at) => listed[at] === wanted);
	}

	/**
	 * Puts folders in the workspace, in the order given, skipping the ones already there.
	 *
	 * ⚠️ Against the batch as well as against the workspace. `doUpdateFolders` works out what is
	 * already there once, before its loop, so one call carrying the same folder twice writes it
	 * twice - and a `.code-workspace` dropped on the window can list one folder twice.
	 *
	 * ⚠️ Compared canonically, stored verbatim: `/tmp` and `/private/tmp` are one place on macOS, so
	 * one folder under both spellings is one row - but the row keeps the spelling it arrived with,
	 * because the workspace file is the person's and upstream would have written it that way.
	 */
	async add(uris: readonly URI[]): Promise<readonly URI[]> {
		const [listedKeys, candidateKeys] = await Promise.all([
			Promise.all(this.folders.map(folder => this.canonicalKey(folder.uri))),
			Promise.all(uris.map(uri => this.canonicalKey(uri)))
		]);

		const listed = new Set(listedKeys);
		const adding: URI[] = [];
		uris.forEach((uri, at) => {
			if (listed.has(candidateKeys[at])) {
				return;
			}

			listed.add(candidateKeys[at]);
			adding.push(uri);
		});

		if (adding.length > 0) {
			await this.workspaceEditingService.addFolders(adding.map(uri => ({ uri })));
		}

		return adding;
	}

	/** Takes folders out of the workspace. ⚠️ Out of the list only - nothing here touches the disk. */
	async remove(uris: readonly URI[]): Promise<readonly IWorkspaceFolder[]> {
		const folders = this.folders;
		const [wanted, listed] = await Promise.all([
			Promise.all(uris.map(uri => this.canonicalKey(uri))),
			Promise.all(folders.map(folder => this.canonicalKey(folder.uri)))
		]);

		const keys = new Set(wanted);
		const removing = folders.filter((_, at) => keys.has(listed[at]));
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

	/**
	 * Puts the workspace's folders in the order `reorder` returns, each written as it was.
	 * `reorder` gets the folders as they are when the edit runs (`IWorkspaceEditingService.reorderFolders`).
	 */
	async reorder(reorder: FolderReorder): Promise<void> {
		await this.workspaceEditingService.reorderFolders(reorder);
	}
}
