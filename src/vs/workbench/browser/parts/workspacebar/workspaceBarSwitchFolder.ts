/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { escapeIcons } from '../../../../base/common/iconLabels.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { inQuickPickContext } from '../../quickaccess.js';
import { WORKSPACE_BAR_CATEGORY } from './workspaceBarActions.js';
import { folderGlyphFor, folderRowNameFor, glyphInFolderColor, IWorkspaceBarCustomizationService, worktreeIcon, worktreeNameFor } from './workspaceBarCustomization.js';
import { findWorktree } from './workspaceBarGit.js';
import { IWorkspaceBarService } from './workspaceBarService.js';

/** Ctrl+' (Cmd+' on macOS): no VS Code binding, shell, agent CLI or AltGr layout uses it (WORKSPACE.md W9.11). */
const SWITCH_FOLDER_KEY = KeyMod.CtrlCmd | KeyCode.Quote;

/** Set while Switch Folder's list is open, so that its key pressed again moves down the list. */
const IN_SWITCH_FOLDER_PICKER = 'inFacadeSwitchFolderPicker';

/** `rows` with the most recently visited first, then the rest in the bar's order; `recent` holds keys. */
export function orderByRecent(rows: readonly URI[], recent: readonly string[], key: (uri: URI) => string): URI[] {
	const rank = new Map(recent.map((recentKey, at) => [recentKey, at]));
	return rows
		.map((uri, at) => ({ uri, at, rank: rank.get(key(uri)) ?? Number.MAX_SAFE_INTEGER }))
		.sort((a, b) => a.rank - b.rank || a.at - b.at)
		.map(({ uri }) => uri);
}

interface ISwitchFolderPick extends IQuickPickItem {
	readonly uri: URI;
}

/** Workspace: Switch Folder..., a quick pick of the bar's rows with the most recent first (WORKSPACE.md W9.11). */
export class SwitchFolderAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.switchFolder';

	constructor() {
		super({
			id: SwitchFolderAction.ID,
			title: localize2('workspaceBar.switchFolder', "Switch Folder..."),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: SWITCH_FOLDER_KEY }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const quickInputService = accessor.get(IQuickInputService);
		const customizationService = accessor.get(IWorkspaceBarCustomizationService);
		const contextService = accessor.get(IWorkspaceContextService);
		const { extUri } = accessor.get(IUriIdentityService);

		const picks = workspaceBarService.recentRows().map((uri): ISwitchFolderPick => {
			const repository = workspaceBarService.repositoryFor(uri);
			const worktree = repository && !extUri.isEqual(repository.main, uri) ? findWorktree(repository, uri, extUri) : undefined;
			const customization = customizationService.get(uri);
			if (repository && worktree) {
				const name = worktreeNameFor(customizationService, worktree);
				return {
					uri,
					label: `$(${glyphInFolderColor(worktreeIcon, customization?.color).id}) ${escapeIcons(name)}`,
					// The repository it is a worktree of, as its row hangs under that one's
					description: folderRowNameFor(customizationService, repository.main, repository.folder),
					ariaLabel: name
				};
			}

			const name = folderRowNameFor(customizationService, uri, contextService.getWorkspaceFolder(uri) ?? undefined);
			return {
				uri,
				label: `$(${glyphInFolderColor(folderGlyphFor(customization), customization?.color).id}) ${escapeIcons(name)}`,
				ariaLabel: name
			};
		});

		// Opened without quick navigation, to be typed into; the key pressed again turns it on (`SwitchFolderNextAction`)
		const pick = await quickInputService.pick(picks, {
			placeHolder: localize('workspaceBar.switchFolderPlaceholder', "Select a folder to switch to"),
			matchOnDescription: true,
			activeItem: picks[1] ?? picks[0],
			contextKey: IN_SWITCH_FOLDER_PICKER
		});
		if (pick) {
			await workspaceBarService.show(pick.uri);
		}
	}
}

/** Switch Folder's key, pressed again while its list is open: down the list, as Open Recent's does. */
class SwitchFolderNextAction extends Action2 {

	static readonly ID = 'facade.workspaceBar.switchFolder.next';

	constructor() {
		super({
			id: SwitchFolderNextAction.ID,
			title: localize2('workspaceBar.switchFolderNext', "Select Next Folder in Switch Folder"),
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: ContextKeyExpr.and(inQuickPickContext, ContextKeyExpr.has(IN_SWITCH_FOLDER_PICKER)),
				primary: SWITCH_FOLDER_KEY
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		const keybindings = accessor.get(IKeybindingService).lookupKeybindings(SwitchFolderAction.ID);
		accessor.get(IQuickInputService).navigate(true, { keybindings });
	}
}

registerAction2(SwitchFolderAction);
registerAction2(SwitchFolderNextAction);
