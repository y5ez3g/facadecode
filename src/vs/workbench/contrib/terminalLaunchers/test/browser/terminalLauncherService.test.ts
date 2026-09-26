/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalExitReason, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { AGENT_NAMES_STORAGE_KEY, TerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { AGENT_TERMINAL_ICON } from '../../common/terminalLaunchers.js';

/** An agent's terminal that a reload brought back, reconnecting to its process - and why it ended, once it has. */
class TestAgent {

	readonly icon = AGENT_TERMINAL_ICON;
	readonly shellLaunchConfig: IShellLaunchConfig;
	exitReason: TerminalExitReason | undefined;

	constructor(readonly shellIntegrationNonce: string) {
		this.shellLaunchConfig = {
			attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce }
		};
	}

	asInstance(): ITerminalInstance {
		return upcastPartial<ITerminalInstance>(this);
	}
}

/** The terminal service as far as the agents' names go: terminals made and ended, and every one of them back. */
class TestTerminalService extends mock<ITerminalService>() {

	readonly made = new Emitter<ITerminalInstance>();
	readonly ended = new Emitter<ITerminalInstance>();
	readonly connected = new DeferredPromise<void>();

	override readonly onDidCreateInstance = this.made.event;
	override readonly onDidDisposeInstance = this.ended.event;
	override readonly onDidChangeInstances = Event.None;
	override readonly onAnyInstanceIconChange = Event.None;
	override readonly whenConnected = this.connected.p;
	override instances: ITerminalInstance[] = [];
}

suite('Terminal launchers - what a window keeps of its agents', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent keeps its name through the window closing, and loses it once it ends or does not come back', async () => {
		// Kept by the window before: three agents, one of which does not come back, as after a restart of the app
		const storage = disposables.add(new TestStorageService());
		storage.store(AGENT_NAMES_STORAGE_KEY, JSON.stringify({ first: 'Claude Code', second: 'Codex', gone: 'Grok Build' }), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const terminals = new TestTerminalService();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ITerminalService, terminals);
		instantiationService.stub(IStorageService, storage);
		instantiationService.stub(ILifecycleService, { when: async () => { } });
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IActiveFolderService, {});
		instantiationService.stub(IConfigurationResolverService, {});
		instantiationService.stub(IWorkbenchLayoutService, {});
		instantiationService.stub(IKeybindingService, {});
		instantiationService.stub(IHostService, {});
		instantiationService.stub(IContextViewService, {});
		disposables.add(instantiationService.createInstance(TerminalLauncherService));

		const first = new TestAgent('first');
		const second = new TestAgent('second');
		terminals.made.fire(first.asInstance());
		terminals.made.fire(second.asInstance());

		// The second one ends, and the terminal service has every other terminal back
		second.exitReason = TerminalExitReason.User;
		terminals.ended.fire(second.asInstance());
		terminals.instances = [first.asInstance()];
		terminals.connected.complete();
		await timeout(0);

		// The window closes, and takes the first one with it
		first.exitReason = TerminalExitReason.Shutdown;
		terminals.ended.fire(first.asInstance());
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		assert.deepStrictEqual({
			named: [first.shellLaunchConfig.name, second.shellLaunchConfig.name],
			kept: JSON.parse(storage.get(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}')
		}, {
			named: ['Claude Code', 'Codex'],
			kept: { first: 'Claude Code' }
		});
	});
});
