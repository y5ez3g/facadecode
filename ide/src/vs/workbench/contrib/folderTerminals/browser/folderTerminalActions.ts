/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { activeFolderTerminalCwd } from '../../terminal/browser/terminalActions.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';

export const OPEN_TERMINAL_TAB = 'facade.terminal.openTab';

/**
 * Opens a terminal in the editor area, in the folder the window is on.
 *
 * The location is passed explicitly rather than by changing
 * `terminal.integrated.defaultLocation`, so the terminal panel and its keybinding keep working.
 */
class OpenTerminalTabAction extends Action2 {

	constructor() {
		super({
			id: OPEN_TERMINAL_TAB,
			title: localize2('facade.terminal.openTab', "Terminal"),
			icon: Codicon.terminal,
			f1: true,
			precondition: ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				// The family the integrated browser started at `Ctrl+Alt+/`: the three buttons that
				// open something into a tab share a modifier, and the letter is the thing opened.
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT
			},
			menu: {
				id: MenuId.TitleBar,
				// Ahead of the layout controls rather than trailing them: this and the agent button are
				// what this window is for, and the group exists for exactly that.
				group: TitleBarLeadingActionsGroup,
				order: 20
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const cwd = (await activeFolderTerminalCwd(accessor))?.cwd;

		const instance = await terminalService.createTerminal({ cwd, location: { viewColumn: ACTIVE_GROUP } });
		await instance.focusWhenReady();
	}
}

export function registerFolderTerminalActions(): void {
	registerAction2(OpenTerminalTabAction);
}
