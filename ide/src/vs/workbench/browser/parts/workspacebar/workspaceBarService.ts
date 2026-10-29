/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { isFolderToOpen, IOpenWindowOptions, IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkspaceBarRepository } from './workspaceBarGit.js';

/**
 * How `show` ended (WORKSPACE.md W6.2). Work that depends on the folder being shown goes on only after `shown`;
 * a failure has already been reported, and `added` says whether the folder joined the workspace regardless.
 */
export type ShowResult =
	| { readonly kind: 'shown' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly reason: string; readonly added?: boolean };

/** How `remove` ended (WORKSPACE.md W9.6); a failure has already been reported. */
export type RemoveResult =
	| { readonly kind: 'removed'; readonly folders: readonly URI[] }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly reason: string };

export interface IRemoveOptions {
	/** The caller has already asked about what would be lost, as deleting a worktree does. */
	readonly confirmed?: boolean;
	/**
	 * The folders leave for their worktree's deletion, which stops what runs in them and discards their unsaved
	 * changes itself once they are out (WORKTREE.md WT-8, steps 5 and 6): leaving, nothing of theirs is stopped or
	 * discarded, or moved to the panel.
	 */
	readonly deleting?: boolean;
}

/**
 * What the bar offers the rest of the workbench.
 *
 * In its own file so that an action can reach the bar without importing the part that registers it:
 * the part imports the actions, so the other direction would be a cycle.
 *
 * `layout.ts` also resolves this to force the part into existence before the grid is built.
 */
export interface IWorkspaceBarService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires once a switch has put the incoming folder's editors on screen. Anything that adds to the
	 * editor area on a switch has to use this rather than
	 * `IActiveFolderService.onDidChangeActiveFolder`, which is too early: the restore is started
	 * there without being awaited, so an editor opened at that point is closed again by the working
	 * set.
	 */
	readonly onDidRestoreEditors: Event<void>;

	/**
	 * Fires when what {@link repositoryFor} answers may have changed: a read of git's files found other
	 * repositories or worktrees than the last one did - a folder joined or left the workspace, git made
	 * or deleted a worktree - or worktrees were switched on or off.
	 */
	readonly onDidChangeRepositories: Event<void>;

	/**
	 * Puts folders in the workspace, in the order given, skipping the ones already there.
	 *
	 * ⚠️ Adds and stops there. Where a folder was dropped is what says whether somebody also meant
	 * to go to it: on the bar, or through its `+`, they are filling the list and expect to stay where
	 * they are - often after picking several at once. Dropping onto the window, or naming a folder on
	 * a command line, means "show me this", and that is `addAndShow`.
	 */
	add(uris: readonly URI[]): Promise<void>;

	/**
	 * Puts folders in the workspace and moves the window onto the last of them.
	 *
	 * ⚠️ One edit and one move, however many folders arrive: dropping three folders is one act, not
	 * three, and walking the window through the first two on the way to the third is a switch nobody
	 * asked for. The last one, because that is the one somebody's hand let go of.
	 */
	addAndShow(uris: readonly URI[]): Promise<ShowResult>;

	/** Collapses the bar to a column of icons, or opens it again. */
	toggleCollapsed(): void;

	/**
	 * Takes folders out of the workspace for every caller, leaving them on disk; asks first only when
	 * something would be lost (W9.6).
	 */
	remove(uris: readonly URI[], options?: IRemoveOptions): Promise<RemoveResult>;

	/** Whether `folder` is leaving through `remove`, so what runs in it stops rather than moves to the panel. */
	isRemoving(folder: URI): boolean;

	/** Whether `folder` is leaving through `remove` for its worktree's deletion, which stops what runs in it itself. */
	isDeleting(folder: URI): boolean;

	/**
	 * Moves the row `uri` is - a folder's, or a repository's with its worktrees in the workspace -
	 * `offset` rows along the bar, taking every folder of `folders[]` that row stands for with it.
	 */
	moveFolder(uri: URI, offset: number): Promise<void>;

	/**
	 * Shows a folder in this window: puts it in the workspace if it is not there yet, and moves the
	 * window onto it.
	 *
	 * ⚠️ The one decision point for the principle this fork turns on. Everything that means "show me
	 * this folder" ends up here; everything that means "give me a second window" goes on calling
	 * `IHostService.openWindow`, and which of the two a caller means stays a decision that caller
	 * makes rather than a default it inherits. "in New Window", the modifier in Open Recent and an
	 * extension calling `vscode.openFolder` all still mean a window.
	 */
	show(uri: URI): Promise<ShowResult>;

	/**
	 * What a command that was invoked without a folder should act on: the row the list has focus
	 * on, and failing that the folder the window is currently in.
	 */
	folderForCommand(): URI | undefined;

	/**
	 * The repository `uri` belongs to - as its main checkout or as one of its worktrees - the way the
	 * bar last read it from git's own files (WORKTREE.md WT-3). Undefined for a folder the bar
	 * does not know as part of a repository, and for every folder while the bar lists no worktrees.
	 */
	repositoryFor(uri: URI): IWorkspaceBarRepository | undefined;

	/**
	 * The folder of every row of the bar, top to bottom: a repository's row and then its worktrees', in
	 * the order somebody put them in (WT-1.7), a closed repository's included. What a list of things
	 * that live in folders is sorted by, to read in the bar's order.
	 */
	rowOrder(): readonly URI[];

	/** Every row, most recently visited first, for Switch Folder (WORKSPACE.md W9.11). */
	recentRows(): readonly URI[];

	/**
	 * Opens or closes a repository's row onto its worktrees (WORKTREE.md WT-1.10). The state is the
	 * bar's and outlives a collapse of the bar to its icons. Nothing happens for a folder that is not a
	 * repository's row.
	 */
	setExpanded(uri: URI, expanded: boolean): void;

	/**
	 * Resolves once the bar has read git's record of a worktree git has just made - at once when it
	 * has, and after reading git's files again when it has not. Git's own writes reach the bar batched,
	 * and a folder joining the workspace before its record is read is drawn at the end of the list
	 * until it is (WORKTREE.md WT-3.6).
	 */
	whenListed(worktree: URI): Promise<void>;

	/**
	 * Leaves a worktree's row out of the bar until the result is disposed - while it is being deleted
	 * (WORKTREE.md WT-8.9). Its row is drawn from git's records, which change only once git has
	 * deleted the worktree, and that takes seconds for a large one.
	 */
	hideWorktree(worktree: URI): IDisposable;

	focus(): void;
}

export const IWorkspaceBarService = createDecorator<IWorkspaceBarService>('workspaceBarService');

/**
 * Whether this window could actually show that folder.
 *
 * ⚠️ The **remote** authority, not the URI's: a folder on a remote this window is not connected to
 * needs a window that is, and putting it in the bar here would be a row that cannot be opened. A
 * `vscode-vfs://github/...` folder carries an authority too and is not remote at all - reading the
 * URI's own authority sent every one of those to a second window that did not need to exist.
 */
export function reaches(uri: URI, environmentService: IWorkbenchEnvironmentService): boolean {
	return getRemoteAuthority(uri) === environmentService.remoteAuthority;
}

/**
 * Opens what somebody asked to open.
 *
 * ⚠️ The rule in one place, for the callers that offer "a folder or a workspace or a file" and were
 * written when a folder could only mean a window: a folder goes into this window, and everything
 * else goes on being a window. So does a folder when somebody asked for a window in as many words -
 * `forceNewWindow` is what "in New Window" and the modifier in Open Recent both set.
 */
export async function openOrShow(
	workspaceBarService: IWorkspaceBarService,
	hostService: IHostService,
	environmentService: IWorkbenchEnvironmentService,
	toOpen: IWindowOpenable,
	options?: IOpenWindowOptions
): Promise<void> {
	if (isFolderToOpen(toOpen) && reaches(toOpen.folderUri, environmentService) && !options?.forceNewWindow) {
		await workspaceBarService.show(toOpen.folderUri);
		return;
	}

	return hostService.openWindow([toOpen], options);
}
