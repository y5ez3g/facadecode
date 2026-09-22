/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
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
			title: localize2('facade.terminal.openTab', "New Terminal Tab"),
			icon: Codicon.terminal,
			f1: true,
			precondition: ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile),
			menu: {
				id: MenuId.TitleBar,
				group: 'navigation',
				// After the integrated browser, which upstream registers at 10
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
