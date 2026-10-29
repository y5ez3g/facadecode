/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { agentsFirst, listedSessions, placeNameFor, workLine } from '../../../browser/parts/workspacebar/workspaceBarQuestions.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';
import { IFacadeRunsService } from '../../facadeCommands/browser/facadeRuns.js';
import { facadeRunOf } from '../../facadeCommands/common/facadeRun.js';
import { setTerminalShutdownQuestion } from '../common/terminalShutdownQuestion.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';
import { workOf } from './terminalLauncherWorkspaceBar.js';

/** Tells VS Code's question before shutdown about background terminals, and lists the agents and terminals that would stop (WORKSPACE.md W11). */
export class RunningWorkShutdownQuestion extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.runningWorkShutdownQuestion';

	constructor(
		@ITerminalLauncherService private readonly launcherService: ITerminalLauncherService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IFacadeRunsService private readonly runsService: IFacadeRunsService,
	) {
		super();

		this._register(setTerminalShutdownQuestion({ describe: terminals => this.describe(terminals as readonly ITerminalInstance[]) }));
	}

	/**
	 * The question about `instances`, every one of which would stop: one to a line, as VS Code lists the files a close
	 * would lose - the agents first, then every other terminal, idle ones too, as the question counts them - each with
	 * its place (WORKSPACE.md W10.7). Where there are agents the message counts them apart from terminals; otherwise
	 * it is VS Code's own.
	 */
	describe(instances: readonly ITerminalInstance[]): { readonly message: string | undefined; readonly detail: string } {
		const agentTerminals = new Set(this.launcherService.agentTerminals);
		const sessions = agentsFirst(instances
			.filter(instance => !instance.isDisposed)
			.sort((a, b) => a.instanceId - b.instanceId)
			.map(instance => ({ instance, ...workOf(instance, agentTerminals) })));
		const agents = sessions.filter(session => session.kind === 'agent').length;

		// An agent another workspace's agent started says so: closing the window ends a child of a tree that lives on there (L3)
		const creators = this.runsService.live?.creators ?? [];
		const lines = sessions.map(session => {
			const line = workLine(session, this.placeOf(session.instance));
			const run = session.kind === 'agent' ? facadeRunOf(session.instance) : undefined;
			const creator = run && run.workspace === this.runsService.live?.workspace ? creators.find(each => each.id === run.id)?.creator : undefined;
			return creator ? localize('runningWork.startedBy', "{0} · started by {1}", line, creator) : line;
		});
		return { message: this.message(agents, sessions.length - agents), detail: listedSessions(lines).join('\n') };
	}

	private message(agents: number, terminals: number): string | undefined {
		if (!agents) {
			return undefined;
		}
		if (!terminals) {
			return agents === 1
				? localize('runningWork.agent', "Do you want to terminate 1 agent?")
				: localize('runningWork.agents', "Do you want to terminate {0} agents?", agents);
		}
		if (agents === 1) {
			return terminals === 1
				? localize('runningWork.agentAndTerminal', "Do you want to terminate 1 agent and 1 terminal?")
				: localize('runningWork.agentAndTerminals', "Do you want to terminate 1 agent and {0} terminals?", terminals);
		}
		return terminals === 1
			? localize('runningWork.agentsAndTerminal', "Do you want to terminate {0} agents and 1 terminal?", agents)
			: localize('runningWork.agentsAndTerminals', "Do you want to terminate {0} agents and {1} terminals?", agents, terminals);
	}

	/** Where `instance` works, as the bar names it: the folder it is kept for, else the one its tab names; none for neither. */
	private placeOf(instance: ITerminalInstance): string | undefined {
		const uri = this.folderTerminalsService.folderOf(instance) ?? instance.workspaceFolder?.uri;
		if (!uri) {
			return undefined;
		}

		const extUri = this.uriIdentityService.extUri;
		const folder = this.contextService.getWorkspace().folders.find(candidate => extUri.isEqual(candidate.uri, uri));
		return placeNameFor(this.customizationService, uri, folder, this.workspaceBarService.repositoryFor(uri), extUri);
	}
}
