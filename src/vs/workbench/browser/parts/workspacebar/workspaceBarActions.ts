/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebardialog.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { asCodeSpan } from './workspaceBar.js';
import { IWorkspaceBarService } from './workspaceBarService.js';

/** The toolbar at the right end of the bar's header. */
export const WorkspaceBarTitleMenu = new MenuId('WorkspaceBarTitle');

/** What the header's `+` opens. */
export const WorkspaceBarNewMenu = new MenuId('WorkspaceBarNew');

/** What a right click on a folder opens. */
export const WorkspaceBarContextMenu = new MenuId('WorkspaceBarContext');

/**
 * True while the keyboard is inside the list of folders.
 *
 * Nothing here is bound to a key - removing a folder is a dialog away, which is not something to
 * put behind a stray keystroke. It is registered so that a keybinding of someone's own can be.
 */
export const WorkspaceBarFocusContext = new RawContextKey<boolean>('facadeWorkspaceBarFocus', false, localize('workspaceBar.focusContext', "Whether the workspace's list of folders has keyboard focus"));

const CATEGORY = localize2('workspaceBar.category', "Workspace");

/**
 * The `+` is a menu, not a button, with one item in it today.
 *
 * ⚠️ There is more than one way to get a folder - a folder here, a repository to clone, one on a
 * remote - and a button that goes straight to a folder picker has to become a menu the first time a
 * second way exists. A control that changes what a click does is worse than one that always opens
 * the same list, so it is titled "New" rather than after the one thing under it.
 */
MenuRegistry.appendMenuItem(WorkspaceBarTitleMenu, {
	submenu: WorkspaceBarNewMenu,
	title: localize2('workspaceBar.new', "New"),
	icon: Codicon.add,
	group: 'navigation',
	order: 1
});

class OpenFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.openFolder';

	constructor() {
		super({
			id: OpenFolderAction.ID,
			title: localize2('workspaceBar.openFolder', "Open Folder"),
			category: CATEGORY,
			f1: true,
			menu: { id: WorkspaceBarNewMenu, group: 'navigation', order: 1 }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const pathService = accessor.get(IPathService);
		const workspaceBarService = accessor.get(IWorkspaceBarService);

		const folders = await fileDialogService.showOpenDialog({
			title: localize('workspaceBar.openFolderTitle', "Open Folder"),
			openLabel: localize('workspaceBar.openFolderButton', "Add"),
			// ⚠️ More than one: someone collecting their folders has them in one place.
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: true,
			defaultUri: await fileDialogService.defaultFolderPath(),
			availableFileSystems: [pathService.defaultUriScheme]
		});

		if (folders?.length) {
			await workspaceBarService.add(folders);
		}
	}
}

/**
 * ⚠️ Remove, not Delete. The folder stays on disk - this is a bookmark leaving a list, and one
 * column to the right, in the explorer, Delete already means the other thing.
 */
class RemoveFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.removeFolder';

	constructor() {
		super({
			id: RemoveFolderAction.ID,
			title: localize2('workspaceBar.removeFolder', "Remove Folder"),
			category: CATEGORY,
			icon: Codicon.trash,
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: '9_remove', order: 1 }
		});
	}

	/** `uri` comes from the context menu. From the command palette there is none, and the row the
	 * list has focus on is what was meant. */
	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		// ⚠️ All of them before the first `await`: a `ServicesAccessor` is only good for the
		// synchronous part of a run, and this one has a dialog in the middle of it.
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const dialogService = accessor.get(IDialogService);
		const labelService = accessor.get(ILabelService);

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (!folder) {
			return;
		}

		// The path, then what the two words in the button actually do. Both matter: two folders can
		// be called the same thing, and what a row takes with it when it goes is not obvious.
		// ⚠️ `appendMarkdown` for the sentence too, not `appendText`: `appendText` turns every run of
		// spaces into `&nbsp;`, which makes the whole sentence one unbreakable word and leaves the
		// renderer to split it mid-word. The sentence is escaped because a translator writes it; the
		// path is not, because it goes inside a code span - see `asCodeSpan`.
		const detail = new MarkdownString();
		detail.appendMarkdown(`${asCodeSpan(labelService.getUriLabel(folder))}\n\n`);
		detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('workspaceBar.removeFolderDetail', "Removes this folder from the workspace and forgets the editors saved for it. The folder itself is left alone.")));

		const { confirmed } = await dialogService.confirm({
			// ⚠️ No severity glyph. Nothing here is destroyed - the folder is left where it is - and a
			// warning triangle over a reversible act is a claim the dialog cannot back up. `none` is
			// the type for it, and it announces the same as `question` does, which is nothing.
			type: 'none',
			message: localize('workspaceBar.removeFolderMessage', "Remove folder?"),
			detail,
			primaryButton: localize({ key: 'workspaceBar.removeFolderButton', comment: ['&& denotes a mnemonic'] }, "&&Remove Folder"),
			// ⚠️ The workbench's dialog rather than the system's, whatever `window.dialogStyle` says:
			// a native alert renders one run of plain text, and the path is the whole point of asking.
			// The class is what shapes it - see `media/workspacebardialog.css`.
			custom: {
				classes: ['workspacebar-confirm'],
				// ⚠️ `disableCloseButton`, not `disableCloseAction`: the latter takes the Escape key
				// with it and leaves a dialog there is no way out of but a button.
				disableCloseButton: true
			}
		});

		if (confirmed) {
			await workspaceBarService.remove([folder]);
		}
	}
}

class FocusWorkspaceAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.focus';

	constructor() {
		super({
			id: FocusWorkspaceAction.ID,
			title: localize2('workspaceBar.focus', "Focus on Workspace"),
			category: CATEGORY,
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IWorkspaceBarService).focus();
	}
}

registerAction2(OpenFolderAction);
registerAction2(RemoveFolderAction);
registerAction2(FocusWorkspaceAction);
