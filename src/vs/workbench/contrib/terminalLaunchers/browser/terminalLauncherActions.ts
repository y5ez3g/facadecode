/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow, getWindow } from '../../../../base/browser/dom.js';
import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { getFlatActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { IAgentMenuButton, ITerminalLauncherService } from './terminalLauncherService.js';

/** The dropdown the agent button opens. Filled from the setting by `TerminalLauncherMenu`. */
export const AGENT_MENU = new MenuId('FacadeAgentMenu');

/** The group the agents themselves sit in, above the separator. */
export const AGENT_MENU_GROUP = 'agents';

export const SHOW_AGENT_MENU = 'facade.agent.showMenu';
export const CONFIGURE_AGENTS = 'facade.agent.configure';

const AGENTS_PRECONDITION = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile);

/**
 * The agent button, drawn as a dropdown anchored to itself.
 *
 * An action rather than a submenu, although a submenu would draw the same dropdown for nothing:
 * `ISubmenuItem` carries no keybinding, so the button would be the only one in the row whose
 * tooltip does not say how to reach it from the keyboard.
 */
class AgentMenuActionViewItem extends DropdownMenuActionViewItem implements IAgentMenuButton {

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ITerminalLauncherService launcherService: ITerminalLauncherService
	) {
		// Rebuilt on every opening, because the agents are commands that come and go with the setting
		const menus = new DisposableStore();

		super(action, {
			getActions: () => {
				menus.clear();
				const menu = menus.add(menuService.createMenu(AGENT_MENU, this._contextKeyService));
				return getFlatActionBarActions(menu.getActions());
			}
		}, contextMenuService, {
			...options,
			classNames: action.class,
			// Or the tooltip is the only one in the row that does not say how to open it from the
			// keyboard: a tool bar hands this to the dropdowns it builds itself, and not to ours.
			keybindingProvider: item => this._keybindingService.lookupKeybinding(item.id)
		});

		this._register(menus);
		this._register(launcherService.registerButton(this));
	}

	/**
	 * The label with the keybinding after it, the way every other button in the row reads it.
	 *
	 * A dropdown does not do this for itself: `keybindingProvider` reaches the items inside the
	 * menu and never the button that opens it.
	 */
	protected override getTooltip(): string {
		return this._keybindingService.appendKeybinding(this.action.tooltip || this.action.label, this.action.id, this._contextKeyService);
	}

	protected override setAriaLabelAttributes(element: HTMLElement): void {
		super.setAriaLabelAttributes(element);
		element.ariaLabel = this.getTooltip();
	}

	/** Whether this is the button drawn in that window. */
	isIn(window: Window): boolean {
		return !!this.element?.isConnected && getWindow(this.element) === window;
	}
}

export function createAgentMenuActionViewItem(action: IAction, options: IActionViewItemOptions, instantiationService: IInstantiationService): AgentMenuActionViewItem {
	return instantiationService.createInstance(AgentMenuActionViewItem, action, options);
}

/**
 * The agent button. Left click drops a menu of the agents somebody keeps and starts the one they
 * pick; the keybinding opens the same menu on the same button.
 */
class ShowAgentMenuAction extends Action2 {

	constructor() {
		super({
			id: SHOW_AGENT_MENU,
			title: localize2('facade.agent.showMenu', "Agent"),
			icon: Codicon.robot,
			f1: true,
			precondition: AGENTS_PRECONDITION,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA
			},
			menu: {
				id: MenuId.TitleBar,
				group: TitleBarLeadingActionsGroup,
				// Ahead of the terminal, which takes 20
				order: 10
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ITerminalLauncherService).showMenu(getActiveWindow());
	}
}

/** The dialog on its own, for somebody who wants to change an agent rather than start one. */
class ConfigureAgentsAction extends Action2 {

	constructor() {
		super({
			id: CONFIGURE_AGENTS,
			title: localize2('facade.agent.configure', "Configure Agents..."),
			f1: true,
			precondition: AGENTS_PRECONDITION,
			menu: {
				id: AGENT_MENU,
				group: 'z_configure',
				order: 1
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ITerminalLauncherService).configure();
	}
}

export function registerTerminalLauncherActions(): void {
	registerAction2(ShowAgentMenuAction);
	registerAction2(ConfigureAgentsAction);
}
