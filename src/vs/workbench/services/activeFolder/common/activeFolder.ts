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

	/** A folder that is not one of the workspace's roots is refused, not adopted. */
	setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void>;
}

/**
 * ⚠️ `join`, in the shape of `IWorkspaceFoldersWillChangeEvent`: a listener with work to finish
 * first hands back a promise rather than racing the change it was told about.
 */
export interface IActiveFolderWillChangeEvent {
	readonly from: IWorkspaceFolder | undefined;
	readonly to: IWorkspaceFolder;
	join(promise: Promise<void>): void;
}
