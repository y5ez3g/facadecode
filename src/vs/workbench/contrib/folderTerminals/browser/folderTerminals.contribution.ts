/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerFolderTerminalActions } from './folderTerminalActions.js';
import { FOLLOW_FOLDER, FolderTerminals, FolderTerminalsService, IFolderTerminalsService } from './folderTerminals.js';

registerFolderTerminalActions();

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[FOLLOW_FOLDER]: {
			type: 'boolean',
			description: localize('terminal.followFolder', "Controls whether a terminal in the editor area belongs to the folder it was opened in. When enabled, leaving that folder hides the terminal and returning shows the same shell again. When disabled, it belongs to the window, as a terminal in the panel does, and stays on screen as the window moves between folders."),
			default: true,
			scope: ConfigurationScope.APPLICATION
		}
	}
});

// Nothing can need parking before there are editors to park
registerWorkbenchContribution2(FolderTerminals.ID, FolderTerminals, WorkbenchPhase.AfterRestored);
registerSingleton(IFolderTerminalsService, FolderTerminalsService, InstantiationType.Delayed);
