/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IRunningWork } from '../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { stoppingNames } from '../../../browser/parts/workspacebar/workspaceBarRemoval.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';
import { setTerminalShutdownQuestion } from '../common/terminalShutdownQuestion.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';
import { runningWork } from './terminalLauncherWorkspaceBar.js';

/** Tells VS Code's question before shutdown about background terminals, and which agents and terminals would stop (WORKSPACE.md W11). */
export class RunningWorkShutdownQuestion extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.runningWorkShutdownQuestion';

	constructor(
		@ITerminalLauncherService private readonly launcherService: ITerminalLauncherService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
	) {
		super();

		this._register(setTerminalShutdownQuestion({ describe: terminals => this.describe(terminals as readonly ITerminalInstance[]) }));
	}

	/** The question's detail: one sentence naming the agents, then the terminals, running among `instances`. */
	describe(instances: readonly ITerminalInstance[]): string | undefined {
		const running = runningWork(instances, new Set(this.launcherService.agentTerminals));
		if (!running.length) {
			return undefined;
		}

		// Each in its folder, when it has one: two agents of the same kind are two folders' work
		const folderOf = (item: IRunningWork) => {
			const instance = instances.find(candidate => candidate.instanceId === item.id);
			const folder = instance && this.folderTerminalsService.folderOf(instance);
			return folder ? basename(folder) : undefined;
		};
		return localize('runningWork.stops', "{0} will be terminated.", stoppingNames(running, true, folderOf));
	}
}
