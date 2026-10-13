/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentIcons.css';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AGENTS_SETTING } from '../common/terminalLaunchers.js';
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

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[AGENTS_SETTING]: {
			type: 'array',
			description: localize('agents.description', "The agents on the agent button. Each one starts a terminal tab in the folder the window is on and runs its command there. The Configure Agents command edits this list."),
			default: [],
			scope: ConfigurationScope.APPLICATION,
			items: {
				type: 'object',
				required: ['id', 'command'],
				properties: {
					id: {
						type: 'string',
						description: localize('agents.id', "Identifies the agent. An entry whose id repeats an earlier one is ignored.")
					},
					label: {
						type: 'string',
						description: localize('agents.label', "The name shown in the list. Defaults to the id.")
					},
					command: {
						type: 'string',
						description: localize('agents.command', "The command line run in the new terminal. Leave empty to open a shell and run nothing.")
					}
				}
			}
		}
	}
});
