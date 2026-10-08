/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/terminalLauncherButton.css';
import { $, append, getActiveWindow, getWindow } from '../../../../base/browser/dom.js';
import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import type { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { getBaseLayerHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate2.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';
import { Action2, IMenuService, MenuId, MenuItemAction, MenuRegistry, registerAction2, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
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

/** The category the agents' commands are under, as the agents' extension's are (AGENT-LAUNCHER.md, L7). */
const AGENTS_CATEGORY = localize2('facade.agents.category', "Agents");

/**
 * The agent button, drawn as a dropdown anchored to itself: upstream's action widget, as its own
 * pickers of agents are (`ChatContinueInSessionActionItem`), because a context menu draws no icons
 * and each agent's row carries its logo. The agents above, the rest of `AGENT_MENU` below a line.
 *
 * A submenu rather than an action: where the title bar has no room for the button its overflow draws
 * a submenu as one, with the agents under it, while an action there is a row that runs
 * `SHOW_AGENT_MENU` - which has no button to drop the menu from. So the rows come from `AGENT_MENU`
 * here too, and the overflow and this list cannot disagree about what is in it. `ISubmenuItem` carries
 * no keybinding, so the tooltip asks that command for its own.
 */
class AgentMenuActionViewItem extends ActionWidgetDropdownActionViewItem implements IAgentMenuButton {

	/** The title bar's, which the base takes no options to be given. */
	private readonly _hoverDelegate: IHoverDelegate | undefined;
	private _hover: IManagedHover | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IMenuService menuService: IMenuService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService
	) {
		// Read on every opening, because the agents are commands that come and go with the settings; and
		// every opening looks for the built-ins again, for the next one to show what this machine has now
		const rows = () => {
			_launcherService.refreshAvailable().catch(onUnexpectedError);
			return agentMenuRows(menuService.getMenuActions(AGENT_MENU, contextKeyService), notificationService);
		};

		super(action, {
			actionProvider: { getActions: () => rows().agents },
			// Show Active Agents and Configure, under a line and without icons, as the pickers
			// upstream builds on this put their own "manage" rows
			actionBarActionProvider: { getActions: () => rows().rest }
		}, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		this._hoverDelegate = options.hoverDelegate;
		this._register(this._launcherService.registerButton(this));
	}

	/**
	 * The button's own glyph, the submenu's icon, and no hover of its own: the base puts one up with
	 * only the label, and `updateTooltip` already puts up the full one - with the count and the key.
	 */
	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const icon = this.action instanceof SubmenuItemAction && ThemeIcon.isThemeIcon(this.action.item.icon) ? this.action.item.icon : Codicon.robot;
		element.classList.add(...ThemeIcon.asClassNameArray(icon));
		return null;
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
		const tooltip = this.keybindingService.appendKeybinding(this.action.tooltip || this.action.label, SHOW_AGENT_MENU, this.contextKeyService);

		const count = this._launcherService.agentTerminals.length;
		if (count === 0) {
			return tooltip;
		}

		return count === 1
			? localize('facade.agent.oneActive', "{0} - 1 active agent", tooltip)
			: localize('facade.agent.someActive', "{0} - {1} active agents", tooltip, count);
	}

	/**
	 * The tooltip under the title bar's hover delegate, as the row's other buttons have theirs. The
	 * base would put it up under the default one, and this would be the one button in the row whose
	 * tooltip waits before it shows.
	 */
	protected override updateTooltip(): void {
		if (!this.element) {
			return;
		}

		this.updateAriaLabel();

		const tooltip = this.getTooltip();
		if (this._hover) {
			this._hover.update(tooltip);
		} else {
			this._hover = this._register(getBaseLayerHoverDelegate().setupManagedHover(this._hoverDelegate ?? getDefaultHoverDelegate('element'), this.element, tooltip));
		}
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

/** `AGENT_MENU` as the agent button's dropdown draws it: the agents, and the rows under the line. */
export function agentMenuRows(groups: ReadonlyArray<[string, ReadonlyArray<MenuItemAction | SubmenuItemAction>]>, notificationService: INotificationService): { readonly agents: IActionWidgetDropdownAction[]; readonly rest: IActionWidgetDropdownAction[] } {
	const rows = (agents: boolean) => groups
		.filter(([group]) => (group === AGENT_MENU_GROUP) === agents)
		.flatMap(([, items]) => items)
		.filter(item => item instanceof MenuItemAction)
		.map(item => toDropdownAction(item, notificationService));

	return { agents: rows(true), rest: rows(false) };
}

/**
 * A row of `AGENT_MENU` as a row of the dropdown, with the icon a context menu would leave out.
 *
 * ⚠️ A row that fails says so, as a context menu's does (`ContextMenuHandler`). The dropdown runs a
 * row without waiting for it, so what fails would otherwise go nowhere a person sees - while the
 * same row in the title bar's overflow, a context menu, shows it.
 */
function toDropdownAction(item: MenuItemAction, notificationService: INotificationService): IActionWidgetDropdownAction {
	return {
		id: item.id,
		label: item.label,
		tooltip: item.tooltip,
		class: undefined,
		enabled: item.enabled,
		checked: undefined,
		icon: ThemeIcon.isThemeIcon(item.item.icon) ? item.item.icon : undefined,
		run: () => item.run().catch(error => {
			if (!isCancellationError(error)) {
				notificationService.error(error);
			}
		})
	};
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
			category: AGENTS_CATEGORY,
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
			category: AGENTS_CATEGORY,
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

/** VS Code's settings at the agents' own, for somebody who wants to change how an agent starts rather than start one. */
class ConfigureAgentsAction extends Action2 {

	constructor() {
		super({
			id: CONFIGURE_AGENTS,
			title: localize2('facade.agent.configure', "Configure Agents..."),
			category: AGENTS_CATEGORY,
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
