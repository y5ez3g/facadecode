/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILifecycleService, ShutdownReason } from '../../../../services/lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TestLifecycleService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalService } from '../../../terminal/browser/terminalService.js';
import { RunningWorkShutdownQuestion } from '../../browser/terminalLauncherShutdown.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { setTerminalShutdownQuestion, terminalShutdownQuestion } from '../../common/terminalShutdownQuestion.js';

suite('Agent launchers - VS Code\'s question before the window closes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const terminal = (instanceId: number, title: string, state: { exitCode?: number; hasChildProcesses?: boolean } = {}) =>
		upcastPartial<ITerminalInstance>({ instanceId, title, exitCode: state.exitCode, hasChildProcesses: !!state.hasChildProcesses, isDisposed: false });

	/** Claude, at work in `api` - a folder the window is not on - and a dev server in the panel. */
	const claude = terminal(1, 'Claude Code', { hasChildProcesses: true });
	const server = terminal(2, 'npm run dev', { hasChildProcesses: true });
	const folders = new Map<ITerminalInstance, URI>([[claude, URI.file('/w/api')]]);

	test('WS-49 VS Code\'s question is told what would stop - each agent and terminal running a process, by name, with its folder - while the agent menu is there', () => {
		const contribution = new RunningWorkShutdownQuestion(
			upcastPartial<ITerminalLauncherService>({ agentTerminals: [claude] }),
			upcastPartial<IFolderTerminalsService>({ folderOf: instance => folders.get(instance) })
		);
		const told = {
			running: terminalShutdownQuestion()?.describe([claude, server]),
			idle: terminalShutdownQuestion()?.describe([terminal(3, 'pwsh')]),
		};
		contribution.dispose();

		assert.deepStrictEqual({ ...told, afterwards: terminalShutdownQuestion() }, {
			running: 'Claude Code in folder \'api\' and terminal \'npm run dev\' will be terminated.',
			idle: undefined,
			afterwards: undefined,
		});
	});

	suite('in VS Code\'s terminal service', () => {

		/** What closing for `reason` asked with a busy terminal in the background, and whether the window stayed. */
		async function close(reason: ShutdownReason, told: boolean) {
			const asked: IConfirmation[] = [];
			const configurationService = new TestConfigurationService({ files: {}, terminal: { integrated: { confirmOnExit: 'hasChildProcesses', enablePersistentSessions: true } } });
			const instantiationService = workbenchInstantiationService({ configurationService: () => configurationService }, store);
			instantiationService.stub(IDialogService, upcastPartial<IDialogService>({ confirm: async confirmation => { asked.push(confirmation); return { confirmed: false }; } }));
			instantiationService.stub(ITerminalInstanceService, 'getBackend', undefined);
			instantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
			instantiationService.stub(IRemoteAgentService, 'getConnection', null);

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
			const question = told ? setTerminalShutdownQuestion({ describe: terminals => `${terminals.length} named` }) : undefined;

			const vetoes: (boolean | Promise<boolean>)[] = [];
			(instantiationService.get(ILifecycleService) as TestLifecycleService).fireBeforeShutdown({ reason, veto: value => { vetoes.push(value); }, finalVeto: () => { } });
			const kept = (await Promise.all(vetoes)).some(Boolean);

			question?.dispose();
			disposed.fire(parked);
			return { asked: asked.map(({ message, detail, primaryButton }) => ({ message, detail, primaryButton })), kept };
		}

		const question = { message: 'Do you want to terminate the active terminal session?', detail: '1 named', primaryButton: '&&Terminate' };

		test('WS-49 closing or quitting asks VS Code\'s own question about a terminal kept in the background, with what Facade names under it; Cancel keeps the window', async () => {
			assert.deepStrictEqual({
				close: await close(ShutdownReason.CLOSE, true),
				quit: await close(ShutdownReason.QUIT, true),
			}, {
				close: { asked: [question], kept: true },
				quit: { asked: [question], kept: true },
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
