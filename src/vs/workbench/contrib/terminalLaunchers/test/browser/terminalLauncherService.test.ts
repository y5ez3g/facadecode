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
import { IShellLaunchConfig, TerminalExitReason, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { AGENT_NAMES_STORAGE_KEY, TerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { AGENT_TERMINAL_ICON, AGENT_TITLE_TEMPLATE } from '../../common/terminalLaunchers.js';

/**
 * A terminal as far as the agents' names go: what it was started with - or, one a reload brought back,
 * the process it reconnects to - and why it ended, once it has.
 */
class TestTerminal {

	exitReason: TerminalExitReason | undefined;

	constructor(readonly shellIntegrationNonce: string, readonly shellLaunchConfig: IShellLaunchConfig) { }

	get icon(): TerminalIcon | undefined {
		return this.shellLaunchConfig.icon ?? this.shellLaunchConfig.attachPersistentProcess?.icon;
	}

	async focusWhenReady(): Promise<void> { }

	asInstance(): ITerminalInstance {
		return upcastPartial<ITerminalInstance>(this);
	}
}

/** An agent's terminal that a reload brought back, reconnecting to its process. */
function reconnecting(nonce: string): TestTerminal {
	return new TestTerminal(nonce, {
		attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: nonce }
	});
}

/**
 * The terminal service as far as the agents' names go: terminals made - each announced as it is made,
 * as upstream's are - and ended, and every one of them back.
 */
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

	/** The terminals `createTerminal` made, in order: each one's nonce is the name it was given. */
	readonly created: TestTerminal[] = [];

	override async createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance> {
		const config = (options?.config ?? {}) as IShellLaunchConfig;
		const terminal = new TestTerminal(config.name ?? '', config);
		this.created.push(terminal);
		this.made.fire(terminal.asInstance());
		return terminal.asInstance();
	}
}

suite('Terminal launchers - what a window keeps of its agents', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent\'s terminal keeps the name it was started with through the window closing, whoever started it, and loses it once it ends or does not come back', async () => {
		// Kept by the window before, as the agent button kept them: three agents, one of which does not come back, as after a restart of the app
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
		const service = disposables.add(instantiationService.createInstance(TerminalLauncherService));

		const first = reconnecting('first');
		const second = reconnecting('second');
		terminals.made.fire(first.asInstance());
		terminals.made.fire(second.asInstance());

		// Started now: one from the agent button, two of Facade's agents - named, with the robot - and a shell
		await service.open({ id: 'gemini', label: 'Gemini CLI', command: '' });
		const [button] = terminals.created;
		const facade = new TestTerminal('facade', { name: '@main #1 · Claude Code', icon: AGENT_TERMINAL_ICON });
		const closed = new TestTerminal('closed', { name: '@clamp #2 · Codex', icon: AGENT_TERMINAL_ICON });
		const shell = new TestTerminal('shell', { name: 'pwsh' });
		for (const terminal of [facade, closed, shell]) {
			terminals.made.fire(terminal.asInstance());
		}

		// The second one ends, the person closes one of Facade's, and the terminal service has every other terminal back
		second.exitReason = TerminalExitReason.User;
		terminals.ended.fire(second.asInstance());
		closed.exitReason = TerminalExitReason.User;
		terminals.ended.fire(closed.asInstance());
		terminals.instances = [first, button, facade, shell].map(terminal => terminal.asInstance());
		terminals.connected.complete();
		await timeout(0);

		// The window closes, and takes the agents with it
		for (const terminal of [first, button, facade]) {
			terminal.exitReason = TerminalExitReason.Shutdown;
			terminals.ended.fire(terminal.asInstance());
		}
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		assert.deepStrictEqual({
			named: [first.shellLaunchConfig.name, second.shellLaunchConfig.name],
			kept: JSON.parse(storage.get(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}')
		}, {
			named: ['Claude Code', 'Codex'],
			kept: {
				first: { name: 'Claude Code', titleTemplate: AGENT_TITLE_TEMPLATE },
				'Gemini CLI': { name: 'Gemini CLI', titleTemplate: AGENT_TITLE_TEMPLATE },
				facade: { name: '@main #1 · Claude Code' }
			}
		});
	});
});
