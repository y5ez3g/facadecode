/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFolderAgents, IWorkspaceBarAgentsService } from '../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';
import { AGENT_TERMINAL_ICON } from '../common/terminalLaunchers.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';

/**
 * The agents each folder runs, in the order they were started: an agent in the panel belongs to no
 * folder and is left out.
 */
export function agentsByFolder(agents: readonly ITerminalInstance[], folderOf: (agent: ITerminalInstance) => URI | undefined): IFolderAgents[] {
	const byFolder = new Map<string, { folder: URI; icons: ThemeIcon[] }>();
	// Instance ids count up as terminals are made, so they are the order the agents were started in
	for (const agent of [...agents].sort((a, b) => a.instanceId - b.instanceId)) {
		const folder = folderOf(agent);
		if (!folder) {
			continue;
		}
		let entry = byFolder.get(folder.toString());
		if (!entry) {
			entry = { folder, icons: [] };
			byFolder.set(folder.toString(), entry);
		}
		entry.icons.push(ThemeIcon.isThemeIcon(agent.icon) ? agent.icon : AGENT_TERMINAL_ICON);
	}
	return [...byFolder.values()];
}

/**
 * Tells the workspace bar which agents run in which folder, for each row to show its own (WORKTREE.md
 * WT-1.15). The agent menu knows which terminals are agents, and the folder terminals where each one
 * is; the bar, below both, knows neither.
 */
export class TerminalLauncherWorkspaceBar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.terminalLauncherWorkspaceBar';

	/**
	 * Told once the events of one change have all fired, not on each: a folder switch alone fires
	 * several, and the last of them, `onDidRestoreEditors`, is when its terminals are where they belong.
	 */
	private readonly report = this._register(new RunOnceScheduler(() => this.tellBar(), 0));

	constructor(
		@ITerminalLauncherService private readonly launcherService: ITerminalLauncherService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
		@IWorkspaceBarAgentsService private readonly barAgentsService: IWorkspaceBarAgentsService,
		@IWorkspaceBarService workspaceBarService: IWorkspaceBarService,
		@IActiveFolderService activeFolderService: IActiveFolderService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
	) {
		super();

		const schedule = () => this.report.schedule();
		// A terminal is made, closed or starts an agent
		this._register(launcherService.onDidChangeAgentTerminals(schedule));
		// A terminal with a tab belongs to the folder the window is on: a switch moves every one of them
		this._register(activeFolderService.onDidChangeActiveFolder(schedule));
		this._register(workspaceBarService.onDidRestoreEditors(schedule));
		this._register(contextService.onDidChangeWorkspaceFolders(schedule));

		this.tellBar();
	}

	private tellBar(): void {
		this.barAgentsService.set(agentsByFolder(this.launcherService.agentTerminals, agent => this.folderTerminalsService.folderOf(agent)?.uri));
	}
}
