/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentIcons.css';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationKeyValuePairs, Extensions as WorkbenchExtensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerTerminalLauncherActions } from './terminalLauncherActions.js';
import './terminalLauncherService.js';
import { TerminalLauncherMenu } from './terminalLauncherMenu.js';
import { TerminalLauncherWorkspaceBar } from './terminalLauncherWorkspaceBar.js';
import { RunningWorkShutdownQuestion } from './terminalLauncherShutdown.js';

registerTerminalLauncherActions();

// The button itself is there whatever happens, because Configure Agents is always in the menu.
// This is what puts the agents beside it, and it runs early so the first opening is the real list.
registerWorkbenchContribution2(TerminalLauncherMenu.ID, TerminalLauncherMenu, WorkbenchPhase.BlockRestore);

// With the folder terminals they ask, which start `AfterRestored`
registerWorkbenchContribution2(TerminalLauncherWorkspaceBar.ID, TerminalLauncherWorkspaceBar, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(RunningWorkShutdownQuestion.ID, RunningWorkShutdownQuestion, WorkbenchPhase.AfterRestored);

// The agent menu once kept a list of agents of its own under `facade.agents`, which is where the agents'
// settings are now (AGENT-LAUNCHER.md, L7): the built-ins are found as the menu opens, and a list left
// there would hide them, so it goes.
Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration)
	.registerConfigurationMigrations([{
		key: 'facade.agents',
		includeApplication: true,
		migrateFn: (value: unknown): ConfigurationKeyValuePairs => Array.isArray(value) ? [['facade.agents', { value: undefined }]] : []
	}]);
