/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ConnectionGainEvent, ConnectionLostEvent, PersistentConnectionEvent, ReconnectionPermanentFailureEvent } from '../../../../../platform/remote/common/remoteAgentConnection.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import type { IWorkspaceBarRepository, IWorkspaceBarWorktree } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILifecycleService, ShutdownReason } from '../../../../services/lifecycle/common/lifecycle.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TestLifecycleService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalService } from '../../../terminal/browser/terminalService.js';
import { IFacadeRunsService } from '../../../facadeCommands/browser/facadeRuns.js';
import { facadeRunProperties } from '../../../facadeCommands/common/facadeRun.js';
import { RunningWorkShutdownQuestion } from '../../browser/terminalLauncherShutdown.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { setTerminalShutdownQuestion, terminalShutdownQuestion } from '../../common/terminalShutdownQuestion.js';

suite('Agent launchers - VS Code\'s question before the window closes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const terminal = (instanceId: number, title: string, state: { exitCode?: number; hasChildProcesses?: boolean; agent?: string; workspaceFolder?: IWorkspaceFolder; run?: number } = {}) =>
		upcastPartial<ITerminalInstance>({ instanceId, title, exitCode: state.exitCode, hasChildProcesses: !!state.hasChildProcesses, isDisposed: false, shellLaunchConfig: { name: state.agent }, workspaceFolder: state.workspaceFolder, ...(state.run !== undefined ? { reconnectionProperties: facadeRunProperties({ workspace: 'rec', id: state.run }) } : {}) });

	/** `api`, its row named API Server, and its worktree `fix-login`, as the bar shows them. */
	const api = upcastPartial<IWorkspaceFolder>({ uri: URI.file('/w/api'), name: 'API Server' });
	const fix = upcastPartial<IWorkspaceFolder>({ uri: URI.file('/w/.wt/api/fix'), name: 'fix-login' });
	const repository = upcastPartial<IWorkspaceBarRepository>({ main: api.uri, folder: api, worktrees: [upcastPartial<IWorkspaceBarWorktree>({ uri: fix.uri, label: 'fix-login', folder: fix })] });

	/** Claude at work in `api` - a folder the window is not on - Codex in its worktree, a dev server in the panel, Muse ended. */
	const claude = terminal(1, 'Claude Code', { hasChildProcesses: true, agent: '@claude #a1' });
	const codex = terminal(2, 'Codex', { hasChildProcesses: true, agent: '@codex #a2', run: 2 });
	const muse = terminal(3, '@muse #a3', { exitCode: 0, agent: '@muse #a3' });
	const server = terminal(4, 'npm run dev', { hasChildProcesses: true, workspaceFolder: api });
	const pwsh = terminal(5, 'pwsh');
	const folders = new Map<ITerminalInstance, URI>([[claude, api.uri], [codex, fix.uri], [muse, api.uri]]);

	const question = (remoteAuthority: string | undefined, states: Emitter<PersistentConnectionEvent>) => new RunningWorkShutdownQuestion(
		upcastPartial<ITerminalLauncherService>({ agentTerminals: [claude, codex, muse] }),
		upcastPartial<IFolderTerminalsService>({ folderOf: instance => folders.get(instance) }),
		upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: [api, fix] }) }),
		upcastPartial<IWorkspaceBarService>({ repositoryFor: () => repository }),
		upcastPartial<IWorkspaceBarCustomizationService>({ nameFor: folder => folder.name, get: () => undefined }),
		upcastPartial<IUriIdentityService>({ extUri }),
		upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority }),
		upcastPartial<IRemoteAgentService>({ getConnection: () => upcastPartial<IRemoteAgentConnection>({ onDidStateChange: states.event }) }),
		upcastPartial<ILabelService>({ getHostLabel: () => 'monster' }),
		// Codex was started by an agent of another workspace: closing ends a child of its tree (L3)
		upcastPartial<IFacadeRunsService>({ live: { workspace: 'rec', ids: [2], preparing: [], creators: [{ id: 2, creator: '@lead #a9 (workspace lab)' }] } })
	);

	test('WS-49 VS Code\'s question is told what would stop - every agent and terminal, one to a line, agents first, each by kind and name, then its place as the bar names it - and counts agents apart from terminals; with no agent it is VS Code\'s question, and past ten lines it counts the rest', () => {
		const states = store.add(new Emitter<PersistentConnectionEvent>());
		const contribution = question(undefined, states);
		const told = {
			everything: terminalShutdownQuestion()?.describe([pwsh, server, muse, codex, claude]),
			terminals: terminalShutdownQuestion()?.describe([pwsh]),
			many: terminalShutdownQuestion()?.describe(Array.from({ length: 12 }, (_, at) => terminal(10 + at, `zsh ${at + 1}`))).detail.split('\n').slice(-2),
		};
		contribution.dispose();

		assert.deepStrictEqual({ ...told, afterwards: terminalShutdownQuestion() }, {
			everything: {
				message: 'Do you want to terminate 2 agents and 3 terminals?',
				detail: [
					'Agent @claude #a1 · API Server',
					'Agent @codex #a2 · API Server (worktree: fix-login) · started by @lead #a9 (workspace lab)',
					'Terminal (@muse #a3) · API Server',
					'Terminal (npm run dev) · API Server',
					'Terminal (pwsh)',
				].join('\n')
			},
			terminals: { message: undefined, detail: 'Terminal (pwsh)' },
			many: ['Terminal (zsh 10)', '...2 additional sessions not shown'],
			afterwards: undefined,
		});
	});

	test('while the window cannot reach its remote the question names the remote and says its agents keep running there as long as its server runs; back, it is the question as ever (REMOTE.md R4)', () => {
		const states = store.add(new Emitter<PersistentConnectionEvent>());
		const contribution = question('ssh-remote+monster', states);
		const ask = (terminals: readonly ITerminalInstance[]) => terminalShutdownQuestion()?.describe(terminals)?.message;
		const button = () => terminalShutdownQuestion()?.describe([claude])?.primaryButton;
		const buttons: (string | undefined)[] = [button()];
		const seen = {
			connected: ask([claude, server]),
			lost: (states.fire(new ConnectionLostEvent('token', 0)), buttons.push(button()), ask([claude, server])),
			agent: ask([claude]),
			agents: ask([claude, codex]),
			terminal: ask([server]),
			terminals: ask([server, pwsh]),
			agentAndTerminal: ask([claude, server]),
			back: (states.fire(new ConnectionGainEvent('token', 0, 1)), buttons.push(button()), ask([claude, server])),
			givenUp: (states.fire(new ReconnectionPermanentFailureEvent('token', 0, 1, false)), buttons.push(button()), ask([claude])),
		};
		contribution.dispose();

		assert.deepStrictEqual({ ...seen, buttons }, {
			connected: 'Do you want to terminate 1 agent and 1 terminal?',
			lost: 'Do you want to close the window? monster cannot be reached. Its agent and terminal keep running there as long as its server runs.',
			agent: 'Do you want to close the window? monster cannot be reached. Its agent keeps running there as long as its server runs.',
			agents: 'Do you want to close the window? monster cannot be reached. Its 2 agents keep running there as long as its server runs.',
			terminal: 'Do you want to close the window? monster cannot be reached. Its terminal keeps running there as long as its server runs.',
			terminals: 'Do you want to close the window? monster cannot be reached. Its 2 terminals keep running there as long as its server runs.',
			agentAndTerminal: 'Do you want to close the window? monster cannot be reached. Its agent and terminal keep running there as long as its server runs.',
			back: 'Do you want to terminate 1 agent and 1 terminal?',
			givenUp: 'Do you want to close the window? monster cannot be reached. Its agent keeps running there as long as its server runs.',
			// Confirming closes the window and stops nothing there, and its button says so; connected, it is VS Code's Terminate
			buttons: [undefined, '&&Close Window', undefined, '&&Close Window'],
		});
	});

	suite('in VS Code\'s terminal service', () => {

		/** What closing for `reason` asked with a busy terminal in the background, and whether the window stayed. */
		/** `told`: what Facade tells the question - nothing, what would stop, or that and its own message as well - and `button`, its own button. */
		async function close(reason: ShutdownReason, told: boolean | string, button?: string) {
			const asked: IConfirmation[] = [];
			const configurationService = new TestConfigurationService({ files: {}, terminal: { integrated: { confirmOnExit: 'hasChildProcesses', enablePersistentSessions: true } } });
			const instantiationService = workbenchInstantiationService({ configurationService: () => configurationService }, store);
			instantiationService.stub(IDialogService, upcastPartial<IDialogService>({ confirm: async confirmation => { asked.push(confirmation); return { confirmed: false }; } }));
			instantiationService.stub(ITerminalInstanceService, 'getBackend', undefined);
			instantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
			instantiationService.stub(IRemoteAgentService, 'getConnection', null);
			instantiationService.stub(IWorkspaceEditingService, { onDidEnterWorkspace: Event.None });

			const disposed = store.add(new Emitter<ITerminalInstance>());
			const parked = upcastPartial<ITerminalInstance>({ instanceId: 7, title: 'Claude Code', hasChildProcesses: true, onDisposed: disposed.event });
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => ({ hideFromUser: true }));
			instantiationService.stub(ITerminalInstanceService, 'createInstance', () => parked);

			const terminalService = store.add(instantiationService.createInstance(TerminalService));
			instantiationService.stub(ITerminalService, terminalService);
			// It makes its editor style a task later, which must be while it is still there to hold it
			await timeout(0);
			terminalService.registerProcessSupport(true);
			await terminalService.createTerminal({ config: { hideFromUser: true }, skipContributedProfileCheck: true });
			const question = told ? setTerminalShutdownQuestion({ describe: terminals => ({ message: told === true ? undefined : told, detail: `${terminals.length} named`, ...(button ? { primaryButton: button } : {}) }) }) : undefined;

			const vetoes: (boolean | Promise<boolean>)[] = [];
			(instantiationService.get(ILifecycleService) as TestLifecycleService).fireBeforeShutdown({ reason, veto: value => { vetoes.push(value); }, finalVeto: () => { } });
			const kept = (await Promise.all(vetoes)).some(Boolean);

			question?.dispose();
			disposed.fire(parked);
			return { asked: asked.map(({ message, detail, primaryButton }) => ({ message, detail, primaryButton })), kept };
		}

		const question = { message: 'Do you want to terminate the active terminal session?', detail: '1 named', primaryButton: '&&Terminate' };

		test('WS-49 closing or quitting asks VS Code\'s own question about a terminal kept in the background, with what Facade names under it - and its message where Facade has one; Cancel keeps the window', async () => {
			assert.deepStrictEqual({
				close: await close(ShutdownReason.CLOSE, true),
				quit: await close(ShutdownReason.QUIT, true),
				agents: await close(ShutdownReason.CLOSE, 'Do you want to terminate 1 agent?'),
				// Away from its remote, confirming terminates nothing: the question's own button (REMOTE.md R4)
				away: await close(ShutdownReason.CLOSE, 'Do you want to close the window? monster cannot be reached.', '&&Close Window'),
			}, {
				close: { asked: [question], kept: true },
				quit: { asked: [question], kept: true },
				agents: { asked: [{ ...question, message: 'Do you want to terminate 1 agent?' }], kept: true },
				away: { asked: [{ ...question, message: 'Do you want to close the window? monster cannot be reached.', primaryButton: '&&Close Window' }], kept: true },
			});
		});

		test('WS-56 Close Workspace asks the same before the window becomes empty', async () => {
			assert.deepStrictEqual(await close(ShutdownReason.LOAD, true), { asked: [question], kept: true });
		});

		test('WS-49 a reload asks nothing, as what runs comes back with it; and stock, untold, does not see the background', async () => {
			assert.deepStrictEqual({
				reload: await close(ShutdownReason.RELOAD, true),
				stock: await close(ShutdownReason.CLOSE, false),
			}, {
				reload: { asked: [], kept: false },
				stock: { asked: [], kept: false },
			});
		});
	});
});
