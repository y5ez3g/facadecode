/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { agentsFirst, listedSessions, placeNameFor, workLine } from '../../../browser/parts/workspacebar/workspaceBarQuestions.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
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

	/** Whether the window cannot reach its remote: lost, waited on, reconnecting, or given up (REMOTE.md R4). */
	private _away = false;

	constructor(
		@ITerminalLauncherService private readonly launcherService: ITerminalLauncherService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILabelService private readonly labelService: ILabelService,
		@IFacadeRunsService private readonly runsService: IFacadeRunsService,
	) {
		super();

		this._register(setTerminalShutdownQuestion({ describe: terminals => this.describe(terminals as readonly ITerminalInstance[]) }));
		const connection = remoteAgentService.getConnection();
		if (connection) {
			this._register(connection.onDidStateChange(e => {
				this._away = e.type !== PersistentConnectionEventType.ConnectionGain;
			}));
		}
	}

	/**
	 * The question about `instances`, every one of which would stop: one to a line, as VS Code lists the files a close
	 * would lose - the agents first, then every other terminal, idle ones too, as the question counts them - each with
	 * its place (WORKSPACE.md W10.7). Where there are agents the message counts them apart from terminals; otherwise
	 * it is VS Code's own. While the window cannot reach its remote the message says so instead, and that what runs
	 * there keeps running; its button closes the window, terminating nothing (REMOTE.md R4).
	 */
	describe(instances: readonly ITerminalInstance[]): { readonly message: string | undefined; readonly detail: string; readonly primaryButton?: string } {
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
		return {
			message: this.message(agents, sessions.length - agents),
			detail: listedSessions(lines).join('\n'),
			...(this._away ? { primaryButton: localize({ key: 'runningWork.closeWindow', comment: ['&& denotes a mnemonic'] }, "&&Close Window") } : {})
		};
	}

	private message(agents: number, terminals: number): string | undefined {
		if (this._away) {
			return this.awayMessage(agents, terminals);
		}
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

	/**
	 * The question while the window cannot reach its remote: closing stops nothing, and what runs
	 * there keeps running as long as its server runs (REMOTE.md R4).
	 */
	private awayMessage(agents: number, terminals: number): string {
		const host = this.host();
		if (!agents) {
			return terminals === 1
				? localize('runningWork.awayTerminal', "Do you want to close the window? {0} cannot be reached. Its terminal keeps running there as long as its server runs.", host)
				: localize('runningWork.awayTerminals', "Do you want to close the window? {0} cannot be reached. Its {1} terminals keep running there as long as its server runs.", host, terminals);
		}
		if (!terminals) {
			return agents === 1
				? localize('runningWork.awayAgent', "Do you want to close the window? {0} cannot be reached. Its agent keeps running there as long as its server runs.", host)
				: localize('runningWork.awayAgents', "Do you want to close the window? {0} cannot be reached. Its {1} agents keep running there as long as its server runs.", host, agents);
		}
		if (agents === 1) {
			return terminals === 1
				? localize('runningWork.awayAgentAndTerminal', "Do you want to close the window? {0} cannot be reached. Its agent and terminal keep running there as long as its server runs.", host)
				: localize('runningWork.awayAgentAndTerminals', "Do you want to close the window? {0} cannot be reached. Its agent and {1} terminals keep running there as long as its server runs.", host, terminals);
		}
		return terminals === 1
			? localize('runningWork.awayAgentsAndTerminal', "Do you want to close the window? {0} cannot be reached. Its {1} agents and terminal keep running there as long as its server runs.", host, agents)
			: localize('runningWork.awayAgentsAndTerminals', "Do you want to close the window? {0} cannot be reached. Its {1} agents and {2} terminals keep running there as long as its server runs.", host, agents, terminals);
	}

	/** The remote as the window's remote indicator names it (REMOTE.md R3). */
	private host(): string {
		const authority = this.environmentService.remoteAuthority;
		return authority ? this.labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority : '';
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
