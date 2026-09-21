/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebardialog.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { asCodeSpan } from './workspaceBar.js';
import { IWorkspaceBarService } from './workspaceBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';

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
 * Whether taking a folder off the list asks first.
 *
 * ⚠️ A setting rather than a remembered dismissal, because it is the answer to a question the
 * person was asked and it belongs somewhere they can find it again. `explorer.confirmDelete` is the
 * same shape, and deleting files is the more serious of the two.
 */
export const CONFIRM_REMOVE_FOLDER = 'facade.workspaceBar.confirmRemoveFolder';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[CONFIRM_REMOVE_FOLDER]: {
			type: 'boolean',
			description: localize('workspaceBar.confirmRemoveFolder', "Controls whether the workspace asks for confirmation before taking a folder off the list. The folder itself is never deleted."),
			default: true
		}
	}
});

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
			// ⚠️ `add`, not `addAndShow`: the dialog offers several folders on purpose, and somebody
			// ticking a handful of them wants them in the list, not to be moved onto whichever one
			// happened to be last. A drag says the other thing, and is answered the other way.
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
		const configurationService = accessor.get(IConfigurationService);

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (!folder) {
			return;
		}

		if (configurationService.getValue<boolean>(CONFIRM_REMOVE_FOLDER) === false) {
			return workspaceBarService.remove([folder]);
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

		const { confirmed, checkboxChecked } = await dialogService.confirm({
			// ⚠️ No severity glyph. Nothing here is destroyed - the folder is left where it is - and a
			// warning triangle over a reversible act is a claim the dialog cannot back up. `none` is
			// the type for it, and it announces the same as `question` does, which is nothing.
			type: 'none',
			message: localize('workspaceBar.removeFolderMessage', "Remove folder?"),
			detail,
			primaryButton: localize({ key: 'workspaceBar.removeFolderButton', comment: ['&& denotes a mnemonic'] }, "&&Remove Folder"),
			checkbox: { label: localize('workspaceBar.doNotAskAgain', "Do not ask me again") },
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

		if (!confirmed) {
			return;
		}

		// ⚠️ Written only when the answer was yes. Ticking the box and then cancelling is somebody
		// saying "not this one, and stop asking" - taking the second half of that while ignoring the
		// first would remove the next folder without a word.
		if (checkboxChecked === true) {
			await configurationService.updateValue(CONFIRM_REMOVE_FOLDER, false);
		}

		await workspaceBarService.remove([folder]);
	}
}

/**
 * Moves a folder one place up or down the list.
 *
 * ⚠️ The list is `folders[]`, so the order is the one the `.code-workspace` file holds and the one
 * anybody opening that file sees. There is nothing of ours to keep in step.
 *
 * ⚠️ `moveFolder`, which exists because neither `addFolders` nor `updateFolders` can express a move
 * without loss: both re-serialise whatever they are handed, so a reorder written with them rewrites
 * paths the person put in the file themselves. Measured before it existed - `updateFolders` over the
 * whole list turned five absolute paths into relative ones.
 *
 * ⚠️ No drag to reorder. Two ways to move a row is two sets of edge cases - a drag that starts on
 * the row the window is on, one that leaves the list, one that lands between two rows - for an
 * action people take a handful of times.
 */
abstract class MoveFolderAction extends Action2 {

	protected abstract readonly offset: number;

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (!folder) {
			return;
		}

		// ⚠️ The folder and how far, not two indices: where it sits is worked out when the move runs,
		// behind whatever else is changing the list.
		await workspaceEditingService.moveFolder(folder, this.offset);
	}
}

class MoveFolderUpAction extends MoveFolderAction {

	static readonly ID = 'facade.workspaceBar.moveFolderUp';

	protected readonly offset = -1;

	constructor() {
		super({
			id: MoveFolderUpAction.ID,
			title: localize2('workspaceBar.moveFolderUp', "Move Folder Up"),
			category: CATEGORY,
			f1: true,
			keybinding: {
				when: WorkspaceBarFocusContext,
				primary: KeyMod.Alt | KeyCode.UpArrow,
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: { id: WorkspaceBarContextMenu, group: '5_order', order: 1 }
		});
	}
}

class MoveFolderDownAction extends MoveFolderAction {

	static readonly ID = 'facade.workspaceBar.moveFolderDown';

	protected readonly offset = 1;

	constructor() {
		super({
			id: MoveFolderDownAction.ID,
			title: localize2('workspaceBar.moveFolderDown', "Move Folder Down"),
			category: CATEGORY,
			f1: true,
			keybinding: {
				when: WorkspaceBarFocusContext,
				primary: KeyMod.Alt | KeyCode.DownArrow,
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: { id: WorkspaceBarContextMenu, group: '5_order', order: 2 }
		});
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
registerAction2(MoveFolderUpAction);
registerAction2(MoveFolderDownAction);
registerAction2(FocusWorkspaceAction);
