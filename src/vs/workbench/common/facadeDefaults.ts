/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';

/**
 * Settings this fork answers differently from stock, and the one place that says so.
 *
 * ⚠️ Default overrides, not edits where the settings are declared. The declarations live in
 * upstream's files, and a changed literal in one of those is a conflict on every merge that
 * touches the region - for a value the registry has an API to change from outside. Keeping them
 * here also means the list of what this fork moved is one file long rather than a search.
 *
 * ⚠️ And overrides rather than forced values: every setting below is still the setting it was, so
 * writing upstream's answer into `settings.json` gets upstream's behaviour back. That is what this
 * fork means by a switch.
 *
 * ⚠️ Frozen, because the registry keeps this object rather than a copy of it: it is read back
 * whenever a default is resolved, so anything that reached in and changed a value here would be
 * changing what the product does, from outside the one file that is supposed to say so.
 */
export const FACADE_CONFIGURATION_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({

	/*
	 * The secondary side bar starts closed.
	 *
	 * Upstream opens it in any folder or workspace - `visibleInWorkspace` - because it is where
	 * chat lives and chat is what upstream puts in front of somebody on their first run. This
	 * window already spends a column on the left for the workspace bar, so taking the right one
	 * as well on first run leaves the editor as the narrow middle of three before anybody has
	 * opened a file.
	 *
	 * It is a default and not a removal: the panel is a keystroke away, and
	 * `workbench.secondarySideBar.defaultVisibility` still takes `visibleInWorkspace`.
	 *
	 * ⚠️ The agent sessions window is not this window and is not covered. That window declares its
	 * own default for this setting, `readOnly` and next to upstream's, and the secondary side bar
	 * is part of what it is for.
	 */
	'workbench.secondarySideBar.defaultVisibility': 'hidden'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerDefaultConfigurations([{ overrides: { ...FACADE_CONFIGURATION_DEFAULTS } }]);
