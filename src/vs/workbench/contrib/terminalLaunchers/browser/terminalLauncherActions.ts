/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/terminalLauncherButton.css';
import { $, append, getActiveWindow, getWindow } from '../../../../base/browser/dom.js';
import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { getFlatActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, IMenuService, MenuId, MenuRegistry, registerAction2, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { TerminalLauncherQuickPick } from './terminalLauncherQuickPick.js';
import { IAgentMenuButton, ITerminalLauncherService } from './terminalLauncherService.js';

/** The dropdown the agent button opens. Filled from the setting by `TerminalLauncherMenu`. */
export const AGENT_MENU = new MenuId('FacadeAgentMenu');

/** The group the agents themselves sit in, above the separator. */
export const AGENT_MENU_GROUP = 'agents';

/** The group below the separator: the active agents, and the dialog that edits the list. */
const AGENT_MENU_MANAGE_GROUP = 'z_configure';

const SHOW_AGENT_MENU = 'facade.agent.showMenu';
const SHOW_ACTIVE_AGENTS = 'facade.agent.showActive';
export const CONFIGURE_AGENTS = 'facade.agent.configure';

const AGENTS_PRECONDITION = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile);

/**
 * The agent button, drawn as a dropdown anchored to itself.
 *
 * A submenu rather than an action: where the title bar has no room for the button its overflow draws
 * a submenu as one, with the agents under it, while an action there is a row that runs
 * `SHOW_AGENT_MENU` - which has no button to drop the menu from. `ISubmenuItem` carries no keybinding,
 * so the tooltip asks that command for its own.
 */
class AgentMenuActionViewItem extends DropdownMenuActionViewItem implements IAgentMenuButton {

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService
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
			// A submenu's glyph is its item's: its class says only that it is a submenu
			classNames: action instanceof SubmenuItemAction && ThemeIcon.isThemeIcon(action.item.icon) ? ThemeIcon.asClassName(action.item.icon) : action.class,
			// Or the tooltip is the only one in the row that does not say how to open it from the
			// keyboard: a tool bar hands this to the dropdowns it builds itself, and not to ours.
			keybindingProvider: item => this._keybindingService.lookupKeybinding(item.id)
		});

		this._register(menus);
		this._register(this._launcherService.registerButton(this));
	}

	override render(container: HTMLElement): void {
		super.render(container);

		// How many agents are active, on the button's corner the way the title bar's other buttons carry
		// a count. For the eye only: the label says it too.
		const badge = append(container, $('.agent-count'));
		badge.setAttribute('aria-hidden', 'true');

		const update = () => {
			const count = this._launcherService.agentTerminals.length;
			badge.textContent = String(count);
			badge.style.display = count ? '' : 'none';
			this.updateTooltip();
		};
		update();
		this._register(this._launcherService.onDidChangeAgentTerminals(update));
	}

	/**
	 * The label with the keybinding after it, the way every other button in the row reads it, and
	 * then how many agents are active - the word `Show Active Agents...` uses.
	 *
	 * A dropdown does not do this for itself: `keybindingProvider` reaches the items inside the
	 * menu and never the button that opens it.
	 */
	protected override getTooltip(): string {
		const tooltip = this._keybindingService.appendKeybinding(this.action.tooltip || this.action.label, SHOW_AGENT_MENU, this._contextKeyService);

		const count = this._launcherService.agentTerminals.length;
		if (count === 0) {
			return tooltip;
		}

		return count === 1
			? localize('facade.agent.oneActive', "{0} - 1 active agent", tooltip)
			: localize('facade.agent.someActive', "{0} - {1} active agents", tooltip, count);
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
 * The agent menu from the keyboard: the one the button drops, on the button - or where the title bar's
 * own overflow opens, when there is no button on screen to drop it from.
 */
class ShowAgentMenuAction extends Action2 {

	constructor() {
		super({
			id: SHOW_AGENT_MENU,
			title: localize2('facade.agent.showMenu', "Show Agent Menu"),
			f1: true,
			precondition: AGENTS_PRECONDITION,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		const window = getActiveWindow();
		if (accessor.get(ITerminalLauncherService).showMenu(window)) {
			return;
		}

		// Put away in the title bar's overflow, or no title bar drawn: under the title bar at its end, as
		// the overflow's menu opens, else at the window's top corner
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const titleBar = layoutService.isVisible(Parts.TITLEBAR_PART, window) ? layoutService.getContainer(window, Parts.TITLEBAR_PART) : undefined;
		accessor.get(IContextMenuService).showContextMenu({
			menuId: AGENT_MENU,
			contextKeyService: accessor.get(IContextKeyService),
			getAnchor: () => titleBar ?? { x: window.innerWidth, y: 0 },
			anchorAlignment: AnchorAlignment.RIGHT
		});
	}
}

/**
 * Every active agent, whichever folder it is in, in a picker: somebody running several in several
 * folders otherwise has no one place that says how many there are, or where.
 *
 * ⚠️ No keybinding of its own. It is a row of the agent menu, which has one, and the chord that
 * would go with that one's - Ctrl+Shift+Alt+A - is upstream's for Open Agents Window while a screen
 * reader is on.
 */
class ShowActiveAgentsAction extends Action2 {

	constructor() {
		super({
			id: SHOW_ACTIVE_AGENTS,
			title: localize2('facade.agent.showActive', "Show Active Agents..."),
			f1: true,
			precondition: AGENTS_PRECONDITION,
			menu: {
				id: AGENT_MENU,
				group: AGENT_MENU_MANAGE_GROUP,
				order: 0
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IInstantiationService).createInstance(TerminalLauncherQuickPick).show();
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
				group: AGENT_MENU_MANAGE_GROUP,
				order: 1
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ITerminalLauncherService).configure();
	}
}

export function registerTerminalLauncherActions(): void {
	// The button (`AgentMenuActionViewItem`)
	MenuRegistry.appendMenuItem(MenuId.TitleBar, {
		submenu: AGENT_MENU,
		title: localize2('facade.agent.menu', "Agent"),
		icon: Codicon.robot,
		group: TitleBarLeadingActionsGroup,
		// Ahead of the terminal, which takes 20
		order: 10,
		when: AGENTS_PRECONDITION
	});

	registerAction2(ShowAgentMenuAction);
	registerAction2(ShowActiveAgentsAction);
	registerAction2(ConfigureAgentsAction);
}
