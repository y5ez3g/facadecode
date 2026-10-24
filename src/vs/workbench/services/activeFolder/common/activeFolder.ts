/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

export const IActiveFolderService = createDecorator<IActiveFolderService>('activeFolderService');

/**
 * Which of the workspace's roots the window is on.
 *
 * The workspace holds every root and keeps holding them. This says which one the parts the
 * workbench draws should show, so that a window with eight roots in it reads as a window with
 * one - and moving between them costs nothing, because nothing is torn down.
 *
 * ⚠️ The question is upstream's, not ours. `IHistoryService.getLastActiveWorkspaceRoot()` has
 * 27 call sites - the terminal's cwd, the file dialog's starting directory, search-from-here,
 * the debug configuration picker - and every one of them is guessing which root is meant. This
 * is the same question with an answer.
 *
 * ⚠️ Nothing here writes to the workspace. `doUpdateFolders` is read-modify-write over
 * `getWorkspace().folders`, so a narrowed list reaching it would delete the rest of them from
 * the `.code-workspace` file.
 */
export interface IActiveFolderService {

	readonly _serviceBrand: undefined;

	/** Undefined only while the workspace has no roots at all. */
	readonly activeFolder: IWorkspaceFolder | undefined;

	/**
	 * The folder the window was moved off to reach the active one, while it is still one of the
	 * workspace's roots; undefined otherwise. Where a view falls back to when the folder it was on goes
	 * and the folder that owned it is gone too (AGENT-ORCHESTRATION.md, O5).
	 */
	readonly previousFolder: IWorkspaceFolder | undefined;

	/**
	 * Before the change, for whoever has to put something away first.
	 *
	 * ⚠️ Only for a deliberate move. When the active root leaves the workspace this service moves to
	 * its neighbour without announcing it first, because there is nothing to put away: whatever a
	 * listener saved would be keyed to a folder the workspace no longer has. Only
	 * `onDidChangeActiveFolder` fires then.
	 */
	readonly onWillChangeActiveFolder: Event<IActiveFolderWillChangeEvent>;

	/**
	 * After the change.
	 *
	 * ⚠️ Also fires when the active root keeps its identity but is renamed, which an edit to the
	 * `.code-workspace` file can do. A listener that draws the name needs to hear about it, and
	 * needs to hear about it from here rather than from `onDidChangeWorkspaceFolders` - the two are
	 * the same event, and which of them runs first is whichever was registered first.
	 */
	readonly onDidChangeActiveFolder: Event<void>;

	/**
	 * The active folder, when it can be reached on the given scheme and authority; otherwise the
	 * first folder of the workspace that can be.
	 *
	 * ⚠️ The fallback is upstream's own, kept rather than simplified away. A workspace can hold a
	 * local folder and a remote one at the same time, and a caller that asks for a local path
	 * cannot be handed the remote folder the window happens to be on - it would resolve
	 * `${workspaceFolder}` to a path that does not exist on the machine the caller is on.
	 *
	 * ⚠️ Filters given as `undefined` accept anything, which is what a caller with no opinion
	 * means. `activeFolderFor()` and `activeFolder` then answer the same.
	 */
	activeFolderFor(scheme?: string, authority?: string): IWorkspaceFolder | undefined;

	/** Moves to a workspace root; rejects when a will-change listener fails, with a `CancellationError` when the folder left meanwhile. */
	setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void>;

	/**
	 * Where the window starts on its next load: a folder joining the workspace with the reload that enters one, which
	 * a remote window makes (`enterWorkspace`). `setActiveFolder` cannot be told of a folder the workspace does not have yet.
	 * Announced first, as a move is, since the reload keeps what is on screen; rejects when a will-change listener fails,
	 * the window then starting on the folder it is on.
	 */
	startOn(folder: URI): Promise<void>;
}

/** Lets a listener `join` work the change waits for, as `IWorkspaceFoldersWillChangeEvent` does; a rejection stops it (WORKSPACE.md W6.2). */
export interface IActiveFolderWillChangeEvent {
	readonly from: IWorkspaceFolder | undefined;
	/** One of the workspace's roots, or the folder the window starts on once the reload that enters a workspace has added it (`startOn`). */
	readonly to: URI;
	join(promise: Promise<void>): void;
}

/**
 * The workspace's folders, with the one the window is on first.
 *
 * ⚠️ Ordered, never narrowed. These are the callers that ask "which folder?", which is a question
 * about the workspace: listing every folder is the point of them. The only thing wrong with them in
 * a window that is on one folder is that the folder it is on is not the first thing offered.
 *
 * ⚠️ Stable otherwise: the rest keep the order the workspace has them in, because that order is the
 * `.code-workspace` file's and people arrange it.
 */
export function foldersWithActiveFirst(folders: readonly IWorkspaceFolder[], active: IWorkspaceFolder | undefined): IWorkspaceFolder[] {
	if (!active) {
		return [...folders];
	}

	return activeFirst(folders, folder => folder.uri.toString() === active.uri.toString());
}

/**
 * `items` with the one the window is on first, and everything else in the order it already had.
 *
 * ⚠️ Moved, not sorted. Lists like the debugger's launches carry an order other things depend
 * on - the workspace's `launch.json` sits at the end of that one and is taken from there by index -
 * so this answers only "which goes on top" and disturbs nothing else.
 */
export function activeFirst<T>(items: readonly T[], isActive: (item: T) => boolean): T[] {
	const index = items.findIndex(isActive);

	return index <= 0 ? [...items] : [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}
