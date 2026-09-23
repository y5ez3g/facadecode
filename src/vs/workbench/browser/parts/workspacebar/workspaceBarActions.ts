/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../dialogs/media/facadedialog.css';
import './media/workspacebardialog.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { asCodeSpan } from './workspaceBar.js';
import { IWorkspaceBarService } from './workspaceBarService.js';
import { IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { showCustomizeDialog } from './workspaceBarCustomize.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';

/** The toolbar at the right end of the bar's header. */
export const WorkspaceBarTitleMenu = new MenuId('WorkspaceBarTitle');

/** What the header's `+` opens. */

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
 * ⚠️ A setting and nothing else. There is no "do not ask me again" in the dialog: the question is
 * one line and it is asked about something that cannot be undone from inside the dialog, so the box
 * that turns it off is clutter in front of the one thing worth reading. Somebody who does not want to
 * be asked can say so here, where it can also be found again and turned back on.
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

class OpenFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.openFolder';

	constructor() {
		super({
			id: OpenFolderAction.ID,
			title: localize2('workspaceBar.openFolder', "Open Folder..."),
			category: CATEGORY,
			icon: Codicon.add,
			f1: true,
			/*
			 * ⚠️ On the header itself, not inside a menu hanging off it. The `+` was a submenu with
			 * this one item in it, kept that way for the day a second way of getting a folder arrives
			 * - clone, a remote, a new worktree. One item behind one click is a menu that exists to be
			 * dismissed: the button said `+`, the menu said "Open Folder", and the folder picker was
			 * two clicks away for the only thing it could do. It goes back to being a menu when there
			 * is a second thing to put in it.
			 */
			menu: { id: WorkspaceBarTitleMenu, group: 'navigation', order: 1 }
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
/**
 * Shows the folder where it lives.
 *
 * ⚠️ Through upstream's own `revealFileInOS` rather than the native host service: this file is
 * in `browser/`, and reaching for an electron-only service from here is a layer violation that the
 * checker catches - and a command is what the explorer's own menu item uses anyway.
 */
/**
 * Collapses the bar to a column of icons, or opens it again.
 *
 * ⚠️ An action in the header's own toolbar, beside the `+`. Hand-rolled as an anchor in the strip
 * above, it came out with the browser's own focus ring and, worse, kept `:focus` after a click - so it
 * sat lit, chip and all, while the `+` beside it was quiet. Measured: `bg rgba(90,93,94,0.31)` at rest
 * against the `+`'s transparent. In the same toolbar the two are the same object and cannot drift.
 *
 * ⚠️ And out of the strip for a second reason: macOS draws the window's three buttons across it,
 * 70px of them over a column that is 36 when collapsed. Nothing of ours belongs in that row.
 */
class ToggleCollapsedAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.toggleCollapsed';

	constructor() {
		super({
			id: ToggleCollapsedAction.ID,
			title: localize2('workspaceBar.toggleCollapsed', "Toggle Workspace Bar"),
			category: CATEGORY,
			icon: Codicon.threeBars,
			f1: true,
			// ⚠️ Order 2, so it follows the `+` that is order 1 in the same group.
			menu: { id: WorkspaceBarTitleMenu, group: 'navigation', order: 2 }
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IWorkspaceBarService).toggleCollapsed();
	}
}

class RevealFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.revealFolder';

	constructor() {
		super({
			id: RevealFolderAction.ID,
			// The platform's own words for it. Upstream says all three somewhere already.
			title: isWindows ? localize2('workspaceBar.revealInWindows', "Reveal in File Explorer")
				: isMacintosh ? localize2('workspaceBar.revealInMac', "Reveal in Finder")
					: localize2('workspaceBar.revealInLinux', "Open Containing Folder"),
			category: CATEGORY,
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: '1_open', order: 1 }
		});
	}

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		const folder = uri ?? accessor.get(IWorkspaceBarService).folderForCommand();
		if (!folder) {
			return;
		}

		await accessor.get(ICommandService).executeCommand('revealFileInOS', folder);
	}
}

/**
 * Asks for a folder's display name and colour.
 *
 * ⚠️ The only way to rename a row. F2 opens this rather than starting an inline edit, because a
 * second way to change the same thing is a second set of edge cases - and the colour would have
 * nowhere to live in an inline edit anyway.
 */
class CustomizeFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.customizeFolder';

	constructor() {
		super({
			id: CustomizeFolderAction.ID,
			title: localize2('workspaceBar.customizeFolder', "Customize..."),
			category: CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: WorkspaceBarFocusContext,
				primary: KeyCode.F2
			},
			menu: { id: WorkspaceBarContextMenu, group: '2_customize', order: 1 }
		});
	}

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		// ⚠️ All of them before the first `await`: a `ServicesAccessor` is only good for the
		// synchronous part of a run, and this one has a dialog in the middle of it.
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const customizationService = accessor.get(IWorkspaceBarCustomizationService);
		const contextService = accessor.get(IWorkspaceContextService);
		const services = {
			layoutService: accessor.get(IWorkbenchLayoutService),
			keybindingService: accessor.get(IKeybindingService),
			hostService: accessor.get(IHostService),
			contextViewService: accessor.get(IContextViewService)
		};

		const target = uri ?? workspaceBarService.folderForCommand();
		if (!target) {
			return;
		}

		const folder = contextService.getWorkspace().folders.find(candidate => candidate.uri.toString() === target.toString())
			?? contextService.getWorkspaceFolder(target);
		if (!folder) {
			return;
		}

		const answer = await showCustomizeDialog(folder, customizationService.get(folder.uri), services);
		if (answer) {
			customizationService.set(folder.uri, answer);
		}
	}
}

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
				classes: ['facade-dialog', 'workspacebar-confirm'],
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

registerAction2(ToggleCollapsedAction);
registerAction2(OpenFolderAction);
registerAction2(RevealFolderAction);
registerAction2(CustomizeFolderAction);
registerAction2(RemoveFolderAction);
registerAction2(MoveFolderUpAction);
registerAction2(MoveFolderDownAction);
registerAction2(FocusWorkspaceAction);
