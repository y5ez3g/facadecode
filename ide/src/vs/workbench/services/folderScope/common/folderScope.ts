/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputButton } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

export const IFolderScopeService = createDecorator<IFolderScopeService>('folderScopeService');

export const FolderScopeContext = new RawContextKey<string>('facadeFolderScope', 'folder',
	localize('facadeFolderScope', "Whether views are scoped to the current folder or the entire workspace"));

export const enum FolderScope {
	/** The folder the window is on. */
	Folder = 'folder',
	/** Every folder the workspace holds. */
	Workspace = 'workspace'
}

/**
 * How wide the window is looking: the folder it is on, or every folder the workspace holds.
 *
 * ⚠️ One answer for every view that asks - Find in Files, Go to File, Go to Symbol in Workspace,
 * Problems - because it is one question to the person asking it. Somebody who widened the search
 * view and then presses ⌘P is still looking for the same thing, and somebody who has widened to
 * find a problem does not want to narrow again to read it.
 *
 * ⚠️ This is the only narrowing in the design that can cost someone a result they would otherwise
 * have found, which is why the way back has to be reachable from wherever they are and has to be
 * remembered. A scope that resets on the next keystroke is a scope nobody can use.
 *
 * ⚠️ Separate from `IActiveFolderService`, which answers which folder the window is *on*. That one
 * is a fact about the window; this one is a choice about how much of it to show.
 */
export interface IFolderScopeService {

	readonly _serviceBrand: undefined;

	readonly scope: FolderScope;

	/**
	 * Fires when the answer to `folders()` changes, which is either of two things: the person
	 * widened or narrowed it, or the window moved to another folder.
	 */
	readonly onDidChangeScope: Event<void>;

	/**
	 * The folders a search should cover right now.
	 *
	 * ⚠️ Answers with every folder when the window is on none, which is what an empty workspace and
	 * a workspace whose folders have all been removed both look like. A search that answered with
	 * nothing there would be a search that silently finds nothing.
	 */
	folders(): readonly IWorkspaceFolder[];

	/**
	 * Whether a view showing this resource should show it right now.
	 *
	 * ⚠️ True for anything the workspace does not hold at all - a file opened from outside it, or
	 * anything at all in a window with no folders. Nothing can be narrowed away by a folder it was
	 * never in, and widening would not bring it back.
	 */
	covers(resource: URI): boolean;

	setScope(scope: FolderScope): void;
}

/** What the toggle on a picker looks like, so both pickers say the same thing. */
export interface IScopedPicker {
	buttons: readonly IQuickInputButton[];
	readonly onDidTriggerButton: Event<IQuickInputButton>;
}

/**
 * Puts the way back to the whole workspace on a picker, as a button in its title bar.
 *
 * ⚠️ On the picker and not only in the search view. Somebody who types a file name, finds nothing,
 * and has to go and open another view to widen has been handed a narrowing with no way out of it
 * from where they are.
 */
export function addFolderScopeToggle(picker: IScopedPicker, folderScopeService: IFolderScopeService, store: DisposableStore): void {
	// ⚠️ Beside whatever the picker already offers, not instead of it. A picker can carry buttons of
	// its own - quick text search has one - and replacing the list would take them away.
	const theirs = [...picker.buttons];
	let ours: IQuickInputButton | undefined;

	const draw = () => {
		const widened = folderScopeService.scope === FolderScope.Workspace;
		ours = {
			iconClass: ThemeIcon.asClassName(widened ? Codicon.folderLibrary : Codicon.folder),
			tooltip: widened
				? localize('folderScope.searchingAll', "Searching all folders. Click to search only the current folder.")
				: localize('folderScope.searchingFolder', "Searching the current folder. Click to search all workspace folders.")
		};
		picker.buttons = [...theirs, ours];
	};

	store.add(folderScopeService.onDidChangeScope(draw));

	// ⚠️ And only for our own button: the picker fires this for every one it has, so a picker with
	// a button of its own would toggle the scope when that one was pressed.
	store.add(picker.onDidTriggerButton(button => {
		if (button !== ours) {
			return;
		}

		folderScopeService.setScope(folderScopeService.scope === FolderScope.Workspace ? FolderScope.Folder : FolderScope.Workspace);
	}));

	draw();
}
