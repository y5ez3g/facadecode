/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Separator } from '../../../../base/common/actions.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, TITLE_BAR_ACTIVE_BACKGROUND } from '../../../common/theme.js';
import { ActivitybarPart, getActivityBarContextMenuActions } from '../activitybar/activitybarPart.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';

/**
 * Options for the activity icons when `workbench.activityBar.location` is `toolbar` and they are
 * hosted in the title bar.
 *
 * These follow the side bar's `top` and `bottom` options (`SidebarPart.getCompositeBarOptions`)
 * with three changes: a title bar container class, a fixed hover position, since this bar is always
 * at the top of the window, and the activity bar's context menu tail rather than the side bar's.
 */
export function getTitlebarCompositeBarOptions(
	menuService: IMenuService,
	contextKeyService: IContextKeyService,
	configurationService: IConfigurationService,
	layoutService: IWorkbenchLayoutService,
	instantiationService: IInstantiationService,
): IPaneCompositeBarOptions {
	return {
		partContainerClass: 'titlebar',

		// The activity bar's own keys: `workbench.activityBar.location` picks one place for one
		// bar, so only one of them is ever on screen and what was pinned, hidden and reordered has
		// to survive being moved - the same way `top` and `bottom` share these with `default`.
		pinnedViewContainersKey: ActivitybarPart.pinnedViewContainersKey,
		placeholderViewContainersKey: ActivitybarPart.placeholderViewContainersKey,
		viewContainersWorkspaceStateKey: ActivitybarPart.viewContainersWorkspaceStateKey,
		icon: true,
		orientation: ActionsOrientation.HORIZONTAL,
		recomputeSizes: true,
		activityHoverOptions: {
			position: () => HoverPosition.BELOW,
		},

		// Without these the position is a one-way door: the context menu would offer the view
		// containers and nothing else, leaving the settings editor and the command palette as the
		// only ways back. Parts.ACTIVITYBAR_PART for the same reason the bar is built with it.
		fillExtraContextMenuActions: actions => {
			actions.push(new Separator());
			actions.push(...getActivityBarContextMenuActions(Parts.ACTIVITYBAR_PART, menuService, contextKeyService, configurationService, layoutService, instantiationService));
		},
		compositeSize: 0,
		iconSize: 16,
		overflowActionSize: 30,
		colors: theme => ({
			activeBackgroundColor: theme.getColor(TITLE_BAR_ACTIVE_BACKGROUND),
			inactiveBackgroundColor: theme.getColor(TITLE_BAR_ACTIVE_BACKGROUND),
			activeBorderBottomColor: theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER),
			activeForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND),
			inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND),
			badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
			badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
			dragAndDropBorder: theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER)
		}),
		compact: true
	};
}
