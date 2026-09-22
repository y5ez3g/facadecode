/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';

/**
 * Whether the product's mark is drawn at the left of the title bar.
 *
 * ⚠️ Off by default. The mark was the first thing in the window's top left because nothing else
 * was; the workspace bar is column zero now and reaches the top, so that corner is taken and the
 * mark sat 36px along from it, between the column and the menus. Two marks in one corner is one
 * mark and one thing to look past on the way to File.
 */
export const SHOW_APP_ICON = 'facade.titleBar.showAppIcon';

/**
 * Asked once, where upstream asks the platform and the title bar style, and never again.
 *
 * ⚠️ Deliberately not live. The icon is not just an element: `NativeTitlebarPart.createContentArea`
 * gives it its `-webkit-app-region` and its double-click-to-close listener, both only if it is
 * already there. Creating one later hands back the pixels without either, so it would drag the
 * window where it should close it. Upstream decides the rest of the title bar's shape once for the
 * same kind of reason, and `window.titleBarStyle` is the setting it does it for.
 */
export function showAppIcon(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(SHOW_APP_ICON) === true;
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[SHOW_APP_ICON]: {
			type: 'boolean',
			description: localize('titleBar.showAppIcon', "Controls whether the product icon is shown at the left of the title bar. The workspace bar occupies that corner, so it is hidden by default. Applies to windows opened after the change, and only where the title bar is custom, on Windows and Linux."),
			default: false,
			scope: ConfigurationScope.APPLICATION
		}
	}
});
