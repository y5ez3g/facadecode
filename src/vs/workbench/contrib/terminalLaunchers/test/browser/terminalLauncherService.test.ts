/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
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

	/** What was typed into it, each line run. */
	readonly typed: string[] = [];

	constructor(readonly shellIntegrationNonce: string, readonly shellLaunchConfig: IShellLaunchConfig) { }

	async sendText(text: string): Promise<void> {
		this.typed.push(text);
	}

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

	/**
	 * The launcher service over `terminals`, its settings `configuration`, the commands it runs kept in `ran`;
	 * `trust` is whether the workspace is trusted, and what the person answers VS Code's question with.
	 */
	function launcherService(terminals: TestTerminalService, storage: TestStorageService, configuration: TestConfigurationService, ran: string[] = [], trust: { readonly trusted: boolean; readonly answer?: boolean } = { trusted: true }): TerminalLauncherService {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ITerminalService, terminals);
		instantiationService.stub(IStorageService, storage);
		instantiationService.stub(ILifecycleService, { when: async () => { } });
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IActiveFolderService, {});
		instantiationService.stub(IWorkspaceContextService, {});
		instantiationService.stub(IWorkspaceTrustManagementService, { isWorkspaceTrusted: () => trust.trusted });
		instantiationService.stub(IWorkspaceTrustRequestService, {
			requestWorkspaceTrust: async () => {
				ran.push('trust?');
				return trust.answer;
			}
		});
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				ran.push(`${id} ${JSON.stringify(args)}`);
				return undefined;
			}
		});
		return disposables.add(instantiationService.createInstance(TerminalLauncherService));
	}

	test('choosing an agent - a built-in or a custom one - is Start Agent with its id, asking nothing more; in Restricted Mode VS Code\'s own question comes first: trusted, the same start goes on, and denied, nothing starts', async () => {
		const terminals = new TestTerminalService();
		const ran: string[] = [];
		const trusted = launcherService(terminals, disposables.add(new TestStorageService()), new TestConfigurationService(), ran);
		await trusted.open({ id: 'codex', label: 'Codex', command: 'codex' });
		await trusted.open({ id: 'reviewer', label: 'reviewer', command: '/opt/review/bin/review', custom: true });
		const granted = launcherService(terminals, disposables.add(new TestStorageService()), new TestConfigurationService(), ran, { trusted: false, answer: true });
		await granted.open({ id: 'claude', label: 'Claude Code', command: 'claude' });
		const denied = launcherService(terminals, disposables.add(new TestStorageService()), new TestConfigurationService(), ran, { trusted: false, answer: false });
		await denied.open({ id: 'muse', label: 'Muse Code', command: 'muse' });

		assert.deepStrictEqual({ ran, shells: terminals.created.length }, {
			ran: ['facade.agents.startAgent [{"cli":"codex"}]', 'facade.agents.startAgent [{"cli":"reviewer","custom":true}]', 'trust?', 'facade.agents.startAgent [{"cli":"claude"}]', 'trust?'],
			shells: 0
		});
	});

	test('Configure Agents opens VS Code\'s settings at the agents\' own, the same search every time', async () => {
		const ran: string[] = [];
		const service = launcherService(new TestTerminalService(), disposables.add(new TestStorageService()), new TestConfigurationService(), ran);
		await service.configure();
		await service.configure();

		assert.deepStrictEqual(ran, ['workbench.action.openSettings ["@ext:vscode.facade-agents"]', 'workbench.action.openSettings ["@ext:vscode.facade-agents"]']);
	});

	test('an agent\'s terminal keeps the name it was started with through the window closing, whoever started it, and loses it once it ends or does not come back', async () => {
		// Kept by the window before, as the agent button kept them: three agents, one of which does not come back, as after a restart of the app
		const storage = disposables.add(new TestStorageService());
		storage.store(AGENT_NAMES_STORAGE_KEY, JSON.stringify({ first: 'Claude Code', second: 'Codex', gone: 'Grok Build' }), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const terminals = new TestTerminalService();
		// Listening as the window makes its terminals
		launcherService(terminals, storage, new TestConfigurationService());

		const first = reconnecting('first');
		const second = reconnecting('second');
		terminals.made.fire(first.asInstance());
		terminals.made.fire(second.asInstance());

		// Started now: one from the agent menu - its CLI's title, then which agent it is - two others of Facade's
		// agents - named, with the robot - and a shell
		const button = new TestTerminal('button', { name: '@gemini #3', icon: AGENT_TERMINAL_ICON, titleTemplate: '${sequence}${separator}@gemini #3' });
		const facade = new TestTerminal('facade', { name: '@main #1 · Claude Code', icon: AGENT_TERMINAL_ICON });
		const closed = new TestTerminal('closed', { name: '@clamp #2 · Codex', icon: AGENT_TERMINAL_ICON });
		const shell = new TestTerminal('shell', { name: 'pwsh' });
		for (const terminal of [button, facade, closed, shell]) {
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
				button: { name: '@gemini #3', titleTemplate: '${sequence}${separator}@gemini #3' },
				facade: { name: '@main #1 · Claude Code' }
			}
		});
	});
});
