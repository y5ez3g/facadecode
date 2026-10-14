/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebardialog.css';
import './media/workspacebartoggle.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { basename, basenameOrAuthority } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { folderKey, orderWorktrees } from './workspaceBar.js';
import { findWorktree } from './workspaceBarGit.js';
import { IWorkspaceBarService } from './workspaceBarService.js';
import { explicitNameOf, IFolderCustomization, IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from './workspaceBarCustomize.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { InEditorZenModeContext } from '../../../common/contextkeys.js';
import { TitleBarLeftMenu } from '../titlebar/titlebarLeftToolbar.js';

/** The toolbar at the right end of the bar's header. */
export const WorkspaceBarTitleMenu = new MenuId('WorkspaceBarTitle');

/** What a right click on a folder opens. */
export const WorkspaceBarContextMenu = new MenuId('WorkspaceBarContext');

/**
 * The buttons at the end of a folder's row, shown while the pointer is on it - its `+`, New
 * Worktree... (WT-5.1). Run with the row's folder.
 */
export const WorkspaceBarRowToolbar = new MenuId('WorkspaceBarRowToolbar');

/*
 * The row menu's groups (WORKTREE.md WT-1.11), by what an item changes - the explorer's own rule,
 * where making a thing and seeing it elsewhere share the first group and what makes a thing go is
 * last:
 *
 *     navigation   what is in the row and where to see it: New Worktree..., Expand or Collapse,
 *                  Reveal in File Explorer
 *     ARRANGE      how the row stands in the list: Customize..., Move Up and Down
 *     9_remove     whether it stays: Remove Folder, Delete Worktree...
 *
 * Customize is with the moves, not by the removal as the explorer's Rename is: it changes nothing on
 * disk, only how the row stands in this list.
 */
const ARRANGE = '2_arrange';

/**
 * True while the keyboard is inside the list of folders, where F2, Alt+Up and Alt+Down act on the
 * focused row.
 *
 * Remove Folder has no key - it is a dialog away, which is not something to put behind a stray
 * keystroke. Anybody can still bind it themselves, with this as the `when`.
 */
export const WorkspaceBarFocusContext = new RawContextKey<boolean>('facadeWorkspaceBarFocus', false, localize('workspaceBar.focusContext', "Whether the workspace's list of folders has keyboard focus"));

/**
 * What the row a menu or a key acts on is: a plain `folder`, a `repository` (a main checkout, which
 * is a folder too) or a `worktree`. WORKTREE.md WT-1.11.
 *
 * Set by the view from the focused row; a right-click focuses its row first, so menu and keyboard agree.
 */
export const WorkspaceBarRowKindContext = new RawContextKey<'folder' | 'repository' | 'worktree'>('facadeWorkspaceBarRowKind', 'folder', localize('workspaceBar.rowKindContext', "Whether the focused row of the workspace is a folder, a repository or a worktree"));

/**
 * Whether the bar is collapsed to its column of icons - what its toggle in the title bar says it
 * will do: collapse it, or expand it again. Set by `WorkspaceBarPart`.
 */
export const WorkspaceBarCollapsedContext = new RawContextKey<boolean>('facadeWorkspaceBarCollapsed', false, localize('workspaceBar.collapsedContext', "Whether the workspace bar is collapsed to its icons"));

/** Rows that are folders of the list: everything except a worktree. */
const onFolderRow = WorkspaceBarRowKindContext.notEqualsTo('worktree');

/**
 * Whether the repository the menu's row stands for is open onto its worktrees: `expanded`,
 * `collapsed`, or empty for a row with nothing under it. WORKTREE.md WT-1.10.
 * Collapsed to its icons, the bar has no triangles, and the menu is how a repository opens and closes.
 */
export const WorkspaceBarRowExpansionContext = new RawContextKey<'' | 'expanded' | 'collapsed'>('facadeWorkspaceBarRowExpansion', '', localize('workspaceBar.rowExpansionContext', "Whether the repository of the focused row of the workspace shows its worktrees"));

/** Creates a worktree of a repository (WORKTREE.md WT-5); registered by `contrib/worktrees`, which can reach terminals. */
export const NEW_WORKTREE_COMMAND = 'facade.workspaceBar.newWorktree';

/** Deletes a worktree (WORKTREE.md WT-8). Registered by `contrib/worktrees`, beside New Worktree. */
export const DELETE_WORKTREE_COMMAND = 'facade.workspaceBar.deleteWorktree';

export const WORKSPACE_BAR_CATEGORY = localize2('workspaceBar.category', "Workspace");

/**
 * The switch for worktrees (WORKTREE.md WT-9). Off, the bar is the flat list of `folders[]` it was
 * before worktrees existed.
 */
export const SHOW_WORKTREES = 'facade.workspaceBar.worktrees';

/** Whether the bar lists worktrees: `SHOW_WORKTREES`, on unless switched off. */
export function areWorktreesShown(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(SHOW_WORKTREES) !== false;
}

/** `areWorktreesShown`, for a menu, a keybinding or a precondition to say. */
export const WORKTREES_SHOWN = ContextKeyExpr.notEquals(`config.${SHOW_WORKTREES}`, false);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[SHOW_WORKTREES]: {
			type: 'boolean',
			description: localize('workspaceBar.worktrees', "Controls whether the workspace bar lists Git worktrees under each repository."),
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
			category: WORKSPACE_BAR_CATEGORY,
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
 * The toggle's glyph: `menu`, the three bars that open a window's navigation pane out of a column of
 * icons and back - WinUI's NavigationView in Windows' own apps, Outlook's folder pane, Gmail. The bar
 * is this window's navigation and collapses to exactly that column, so it is that button.
 *
 * ⚠️ Which takes `menu` from the application menu, the one other thing that drew it: see
 * `workspacebartoggle.css`, where the menu bar keeps `more` instead.
 *
 * ⚠️ Not a chevron. In the title bar a `<` reads as Back - the command center has its own Back and
 * Forward arrows in the same row - and it says which way something moves without saying what. And
 * not `layout-sidebar-left`, because the layout controls at the other end of the same row already
 * draw that glyph for the primary side bar.
 */
const toggleCollapsedIcon = registerIcon('workspace-bar-toggle', Codicon.menu, localize('workspaceBar.toggleIcon', "Icon for collapsing and expanding the workspace bar."));

/**
 * Collapses the bar to a column of icons, or opens it again.
 *
 * ⚠️ At the front of the title bar, not in the bar's header. The title bar runs the width of the
 * window above the bar, so its first button is the one nearest the column - and a header with room
 * for one button fewer is a header with room for the `+`.
 *
 * ⚠️ One glyph in both states: the column under it says which state it is in. The tooltip says what
 * a click will do, and `toggled` is on while the bar is open, so it reads as pressed then.
 */
class ToggleCollapsedAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.toggleCollapsed';

	constructor() {
		super({
			id: ToggleCollapsedAction.ID,
			title: localize2('workspaceBar.toggleCollapsed', "Toggle Workspace Bar"),
			tooltip: localize('workspaceBar.expand', "Expand Workspace Bar"),
			category: WORKSPACE_BAR_CATEGORY,
			icon: toggleCollapsedIcon,
			toggled: { condition: WorkspaceBarCollapsedContext.toNegated(), tooltip: localize('workspaceBar.collapse', "Collapse Workspace Bar") },
			f1: true,
			// ⚠️ `NoHide` on that tool bar: hidden, the command palette would be the only way back.
			// ⚠️ Not in Zen Mode, which hides the bar: a click there would flip a column nobody can see,
			// and it would come back the other way on leaving.
			menu: { id: TitleBarLeftMenu, group: 'navigation', order: 0, when: InEditorZenModeContext.toNegated() }
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IWorkspaceBarService).toggleCollapsed();
	}
}

/**
 * Shows the folder where it lives.
 *
 * ⚠️ Through upstream's own `revealFileInOS` rather than the native host service: this file is
 * in `browser/`, and reaching for an electron-only service from here is a layer violation that the
 * checker catches - and a command is what the explorer's own menu item uses anyway.
 */
class RevealFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.revealFolder';

	constructor() {
		super({
			id: RevealFolderAction.ID,
			// The platform's own words for it. Upstream says all three somewhere already.
			title: isWindows ? localize2('workspaceBar.revealInWindows', "Reveal in File Explorer")
				: isMacintosh ? localize2('workspaceBar.revealInMac', "Reveal in Finder")
					: localize2('workspaceBar.revealInLinux', "Open Containing Folder"),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: 'navigation', order: 3 }
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
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: WorkspaceBarFocusContext,
				primary: KeyCode.F2
			},
			// Every row, worktrees included: a worktree has a name and a colour of its own to give.
			menu: { id: WorkspaceBarContextMenu, group: ARRANGE, order: 1 }
		});
	}

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const customizationService = accessor.get(IWorkspaceBarCustomizationService);
		const workspaceBarDialogService = accessor.get(IWorkspaceBarDialogService);
		const contextService = accessor.get(IWorkspaceContextService);
		const uriIdentityService = accessor.get(IUriIdentityService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);

		const target = uri ?? workspaceBarService.folderForCommand();
		if (!target) {
			return;
		}

		const memberAt = (at: URI) => contextService.getWorkspace().folders.find(candidate => uriIdentityService.extUri.isEqual(candidate.uri, at));

		// A listed folder's name goes in `folders[].name`; colour, icon and an unlisted row's name stay in the profile (W9.7)
		const current = (at: URI, folder: IWorkspaceFolder | undefined): IFolderCustomization => {
			const kept = customizationService.get(at);
			return { ...kept, name: (folder && explicitNameOf(folder)) || kept?.name };
		};
		const save = async (at: URI, folder: IWorkspaceFolder | undefined, answer: IFolderCustomization) => {
			if (folder && contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
				customizationService.set(at, { color: answer.color, icon: answer.icon });
				await workspaceEditingService.renameFolder(folder.uri, answer.name);
			} else {
				customizationService.set(at, answer);
			}
		};

		// A worktree first: once visited it is also a workspace folder, but unnamed it is called by its branch.
		const repository = workspaceBarService.repositoryFor(target);
		const worktree = findWorktree(repository, target, uriIdentityService.extUri);
		if (worktree) {
			const folder = memberAt(worktree.uri);
			const answer = await workspaceBarDialogService.showCustomizeDialog({ defaultName: worktree.label, worktree: true }, current(worktree.uri, folder));
			if (answer) {
				await save(worktree.uri, folder, answer);
			}
			return;
		}

		// The row's own folder - never one it is inside of, which is a row of its own. A repository whose
		// own checkout is not in the workspace, only worktrees of it, has a row all the same, named for
		// its folder on disk.
		const folder = memberAt(target);
		const row = folder ? { uri: folder.uri, name: basenameOrAuthority(folder.uri) }
			: repository && uriIdentityService.extUri.isEqual(repository.main, target) ? { uri: repository.main, name: basename(repository.main) }
				: undefined;
		if (!row) {
			return;
		}

		const answer = await workspaceBarDialogService.showCustomizeDialog({ defaultName: row.name, worktree: false }, current(row.uri, folder));
		if (answer) {
			await save(row.uri, folder, answer);
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
			title: localize2('workspaceBar.removeFolder', "Remove Folder from Workspace"),
			category: WORKSPACE_BAR_CATEGORY,
			icon: Codicon.trash,
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: '9_remove', order: 1, when: onFolderRow }
		});
	}

	/** Removes the context menu's row, or the focused one from the command palette, through the bar (WORKSPACE.md W9.6). */
	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (folder) {
			await workspaceBarService.remove([folder]);
		}
	}
}

/**
 * The weight of Alt+Up and Alt+Down on a row: one above `list.focusAnyUp` and `list.focusAnyDown`
 * (`listCommands.ts`), which take those keys in every focused list and otherwise win.
 */
const MOVE_WEIGHT = KeybindingWeight.WorkbenchContrib + 1;

/**
 * Moves a folder one place up or down the list.
 *
 * ⚠️ The list is `folders[]`, so the order is the one the `.code-workspace` file holds and the one
 * anybody opening that file sees. There is nothing of ours to keep in step.
 *
 * ⚠️ `reorderFolders`, which exists because neither `addFolders` nor `updateFolders` can express a move
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

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (!folder) {
			return;
		}

		// The whole row: a repository moves with its worktrees in the workspace.
		await workspaceBarService.moveFolder(folder, this.offset);
	}
}

class MoveFolderUpAction extends MoveFolderAction {

	static readonly ID = 'facade.workspaceBar.moveFolderUp';

	protected readonly offset = -1;

	constructor() {
		super({
			id: MoveFolderUpAction.ID,
			title: localize2('workspaceBar.moveFolderUp', "Move Folder Up"),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			keybinding: {
				when: ContextKeyExpr.and(WorkspaceBarFocusContext, onFolderRow),
				primary: KeyMod.Alt | KeyCode.UpArrow,
				weight: MOVE_WEIGHT
			},
			menu: { id: WorkspaceBarContextMenu, group: ARRANGE, order: 2, when: onFolderRow }
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
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			keybinding: {
				when: ContextKeyExpr.and(WorkspaceBarFocusContext, onFolderRow),
				primary: KeyMod.Alt | KeyCode.DownArrow,
				weight: MOVE_WEIGHT
			},
			menu: { id: WorkspaceBarContextMenu, group: ARRANGE, order: 3, when: onFolderRow }
		});
	}
}

/**
 * Moves a worktree one place up or down among its repository's worktrees (WORKTREE.md WT-1.7) - never
 * out of them, since a worktree's place is under its repository. The first move in a repository keeps
 * the whole order as it then stands; until then they are in the order they were made.
 */
abstract class MoveWorktreeAction extends Action2 {

	protected abstract readonly offset: number;

	override run(accessor: ServicesAccessor, uri?: URI): void {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const customizationService = accessor.get(IWorkspaceBarCustomizationService);
		const uriIdentityService = accessor.get(IUriIdentityService);

		const worktree = uri ?? workspaceBarService.folderForCommand();
		const repository = worktree && workspaceBarService.repositoryFor(worktree);
		if (!worktree || !repository) {
			return;
		}

		const key = (candidate: URI) => folderKey(uriIdentityService, candidate);
		const order = orderWorktrees(repository.worktrees.map(candidate => candidate.uri), customizationService.worktreeOrder(repository.main), candidate => candidate, key);
		const from = order.findIndex(candidate => key(candidate) === key(worktree));
		const to = from + this.offset;

		// The main checkout is not in the list, and the ends do not wrap round.
		if (from < 0 || to < 0 || to >= order.length) {
			return;
		}

		[order[from], order[to]] = [order[to], order[from]];
		customizationService.setWorktreeOrder(repository.main, order);
	}
}

const onWorktreeRow = WorkspaceBarRowKindContext.isEqualTo('worktree');

class MoveWorktreeUpAction extends MoveWorktreeAction {

	static readonly ID = 'facade.workspaceBar.moveWorktreeUp';

	protected readonly offset = -1;

	constructor() {
		super({
			id: MoveWorktreeUpAction.ID,
			title: localize2('workspaceBar.moveWorktreeUp', "Move Worktree Up"),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			precondition: WORKTREES_SHOWN,
			keybinding: {
				when: ContextKeyExpr.and(WorkspaceBarFocusContext, onWorktreeRow),
				primary: KeyMod.Alt | KeyCode.UpArrow,
				weight: MOVE_WEIGHT
			},
			menu: { id: WorkspaceBarContextMenu, group: ARRANGE, order: 2, when: onWorktreeRow }
		});
	}
}

class MoveWorktreeDownAction extends MoveWorktreeAction {

	static readonly ID = 'facade.workspaceBar.moveWorktreeDown';

	protected readonly offset = 1;

	constructor() {
		super({
			id: MoveWorktreeDownAction.ID,
			title: localize2('workspaceBar.moveWorktreeDown', "Move Worktree Down"),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			precondition: WORKTREES_SHOWN,
			keybinding: {
				when: ContextKeyExpr.and(WorkspaceBarFocusContext, onWorktreeRow),
				primary: KeyMod.Alt | KeyCode.DownArrow,
				weight: MOVE_WEIGHT
			},
			menu: { id: WorkspaceBarContextMenu, group: ARRANGE, order: 3, when: onWorktreeRow }
		});
	}
}

/**
 * Opens or closes a repository's row onto its worktrees, from its menu - the only way while the bar
 * is collapsed to its icons.
 */
abstract class SetExpandedAction extends Action2 {

	protected abstract readonly expanded: boolean;

	override run(accessor: ServicesAccessor, uri?: URI): void {
		const workspaceBarService = accessor.get(IWorkspaceBarService);

		const folder = uri ?? workspaceBarService.folderForCommand();
		if (folder) {
			workspaceBarService.setExpanded(folder, this.expanded);
		}
	}
}

class ExpandFolderAction extends SetExpandedAction {

	static readonly ID = 'facade.workspaceBar.expandFolder';

	protected readonly expanded = true;

	constructor() {
		super({
			id: ExpandFolderAction.ID,
			title: localize2('workspaceBar.expandFolder', "Expand"),
			category: WORKSPACE_BAR_CATEGORY,
			menu: { id: WorkspaceBarContextMenu, group: 'navigation', order: 2, when: WorkspaceBarRowExpansionContext.isEqualTo('collapsed') }
		});
	}
}

class CollapseFolderAction extends SetExpandedAction {

	static readonly ID = 'facade.workspaceBar.collapseFolder';

	protected readonly expanded = false;

	constructor() {
		super({
			id: CollapseFolderAction.ID,
			title: localize2('workspaceBar.collapseFolder', "Collapse"),
			category: WORKSPACE_BAR_CATEGORY,
			menu: { id: WorkspaceBarContextMenu, group: 'navigation', order: 2, when: WorkspaceBarRowExpansionContext.isEqualTo('expanded') }
		});
	}
}

class FocusWorkspaceAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.focus';

	constructor() {
		super({
			id: FocusWorkspaceAction.ID,
			title: localize2('workspaceBar.focus', "Focus on Workspace Bar"),
			category: WORKSPACE_BAR_CATEGORY,
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
registerAction2(MoveWorktreeUpAction);
registerAction2(MoveWorktreeDownAction);
registerAction2(ExpandFolderAction);
registerAction2(CollapseFolderAction);
registerAction2(FocusWorkspaceAction);
