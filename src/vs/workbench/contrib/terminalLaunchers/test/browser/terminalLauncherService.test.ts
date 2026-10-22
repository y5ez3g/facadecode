/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IProcessEnvironment, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IReconnectionProperties, IShellLaunchConfig, TerminalExitReason, TerminalIcon, TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IFacadeLiveRuns, IFacadeRunsService } from '../../../facadeCommands/browser/facadeRuns.js';
import { facadeRunProperties, IPreparingRun } from '../../../facadeCommands/common/facadeRun.js';
import { TerminalLauncherDetection } from '../../browser/terminalLauncherDetection.js';
import { AGENT_NAMES_STORAGE_KEY, TerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { AGENT_TERMINAL_ICON, AGENT_TITLE_TEMPLATE, commandExecutable } from '../../common/terminalLaunchers.js';

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

	/** As a real terminal's: the mark of the process it reconnects to, else of the one it was started with. */
	get reconnectionProperties(): IReconnectionProperties | undefined {
		return this.shellLaunchConfig.attachPersistentProcess?.reconnectionProperties || this.shellLaunchConfig.reconnectionProperties;
	}

	async focusWhenReady(): Promise<void> { }

	asInstance(): ITerminalInstance {
		return upcastPartial<ITerminalInstance>(this);
	}
}

/** An agent's terminal that a reload brought back, reconnecting to its process: marked as its run's. */
function reconnecting(nonce: string): TestTerminal {
	return new TestTerminal(nonce, {
		attachPersistentProcess: { id: 1, pid: 1, title: 'node', titleSource: TitleEventSource.Process, cwd: '', icon: AGENT_TERMINAL_ICON, shellIntegrationNonce: nonce, reconnectionProperties: facadeRunProperties({ workspace: 'record', id: 1 }) }
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
	function launcherService(terminals: TestTerminalService, storage: TestStorageService, configuration: TestConfigurationService, ran: string[] = [], trust: { readonly trusted: boolean; readonly answer?: boolean } = { trusted: true }, runs: Partial<IFacadeRunsService> = { live: undefined, onDidChangeLive: Event.None }): TerminalLauncherService {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IFacadeRunsService, runs);
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

	test('the folder on screen as the person chooses goes with the start: one they go to while it is under way - VS Code\'s trust question included - does not take the agent there (PS-15)', async () => {
		const a = URI.file('/work/a');
		const b = URI.file('/work/b');
		const activeFolder: { activeFolder: IWorkspaceFolder | undefined } = { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: a }) };
		const ran: string[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IFacadeRunsService, { live: undefined, onDidChangeLive: Event.None });
		instantiationService.stub(ITerminalService, new TestTerminalService());
		instantiationService.stub(IStorageService, disposables.add(new TestStorageService()));
		instantiationService.stub(ILifecycleService, { when: async () => { } });
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IActiveFolderService, activeFolder);
		instantiationService.stub(IWorkspaceContextService, {});
		instantiationService.stub(IWorkspaceTrustManagementService, { isWorkspaceTrusted: () => false });
		instantiationService.stub(IWorkspaceTrustRequestService, {
			requestWorkspaceTrust: async () => {
				// The person goes to B while VS Code asks
				activeFolder.activeFolder = upcastPartial<IWorkspaceFolder>({ uri: b });
				return true;
			}
		});
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				const [options] = args as [{ cli: string; folder?: URI }];
				ran.push(`${id} ${options.cli} in ${options.folder?.path}`);
				// ... and is on B by the time the extension would ask
				activeFolder.activeFolder = upcastPartial<IWorkspaceFolder>({ uri: b });
				return undefined;
			}
		});
		const service = disposables.add(instantiationService.createInstance(TerminalLauncherService));
		await service.open({ id: 'claude', label: 'Claude Code', command: 'claude' });

		assert.deepStrictEqual(ran, ['facade.agents.startAgent claude in /work/a']);
	});

	test('the agents counted and listed are those the agents\' extension says are live, by the run each terminal is marked with: one with a shell\'s icon included, one that ended and keeps its tab or an ordinary terminal given the robot not; one still making its worktree counted, with no terminal yet, and listed apart as preparing (L3; LA-06); before the extension has said, the runs whose processes run (X-51; UI-09)', () => {
		const terminals = new TestTerminalService();
		const run = (id: number, options: { readonly exitCode?: number; readonly icon?: TerminalIcon } = {}) => upcastPartial<ITerminalInstance>({ reconnectionProperties: facadeRunProperties({ workspace: 'record', id }), exitCode: options.exitCode, isDisposed: false, icon: options.icon, shellLaunchConfig: {} });
		const shellIcon = run(1, { icon: Codicon.terminal });
		const ended = run(2, { exitCode: 0 });
		const ordinary = upcastPartial<ITerminalInstance>({ icon: AGENT_TERMINAL_ICON, exitCode: undefined, isDisposed: false, shellLaunchConfig: {} });
		terminals.instances = [shellIcon, ended, ordinary];
		const changed = disposables.add(new Emitter<void>());
		const runs = { live: undefined as IFacadeLiveRuns | undefined, onDidChangeLive: changed.event };
		const service = launcherService(terminals, disposables.add(new TestStorageService()), new TestConfigurationService(), [], { trusted: true }, runs);
		const before = { count: service.activeAgentCount, listed: service.agentTerminals, preparing: service.preparingAgents };
		const making: IPreparingRun = { id: 3, name: 'lint', phase: 'creating_worktree' };
		runs.live = { workspace: 'record', ids: [1, 3], preparing: [making], creators: [] };
		changed.fire();

		assert.deepStrictEqual({ before, after: { count: service.activeAgentCount, listed: service.agentTerminals, preparing: service.preparingAgents } }, {
			before: { count: 1, listed: [shellIcon], preparing: [] },
			after: { count: 2, listed: [shellIcon], preparing: [making] }
		});
	});

	// Paths as macOS and Linux spell them: Windows reads the home from USERPROFILE, and takes a backslash for a separator too
	(isWindows ? test.skip : test)('a built-in\'s path setting is looked for as a start takes it: `~` the home its environment says - what its launch sets over what a terminal in the folder on screen gets - else the person\'s home as VS Code knows it, as in an empty window, which has no terminal\'s environment to read; a relative path from the folder on screen (AGENT-LAUNCHER.md, L10)', async () => {
		/** The files the built-ins `settings` offer are looked for at, with the folder on screen `folder`, where a terminal gets `env`. */
		const lookedFor = async (settings: Record<string, unknown>, folder: URI | undefined, env: IProcessEnvironment | undefined) => {
			const looked: string[] = [];
			const instantiationService = disposables.add(new TestInstantiationService());
			instantiationService.stub(IFacadeRunsService, { live: undefined, onDidChangeLive: Event.None });
			instantiationService.stub(ITerminalService, new TestTerminalService());
			instantiationService.stub(IStorageService, disposables.add(new TestStorageService()));
			instantiationService.stub(ILifecycleService, { when: async () => { } });
			instantiationService.stub(IConfigurationService, new TestConfigurationService(settings));
			instantiationService.stub(ILogService, new NullLogService());
			instantiationService.stub(IActiveFolderService, { activeFolder: folder && upcastPartial<IWorkspaceFolder>({ uri: folder }) });
			instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ folders: [] }) });
			// A terminal there gets `env`, as `_facade.terminal.environment` answers
			const answers = new Map<string, unknown>([['_facade.terminal.environment', env]]);
			instantiationService.stub(ICommandService, { executeCommand: async <R>(id: string) => answers.get(id) as R | undefined });
			instantiationService.stub(IPathService, new TestPathService(URI.file('/home/me')));
			instantiationService.stubInstance(TerminalLauncherDetection, {
				detect: async launchers => {
					looked.push(...launchers.map(launcher => commandExecutable(launcher.command) ?? ''));
					return new Set();
				}
			});
			await disposables.add(instantiationService.createInstance(TerminalLauncherService)).refreshAvailable();
			return looked.sort();
		};
		const tilde = { 'facade.agents.claude.path': '~/bin/claude', 'facade.agents.antigravity.path': '~/agy', 'facade.agents.antigravity.launch': { environment: { HOME: '/home/launch' } }, 'facade.agents.muse.enabled': false };

		assert.deepStrictEqual({
			inAFolder: await lookedFor({ ...tilde, 'facade.agents.codex.path': 'tools/codex' }, URI.file('/work/a'), { PATH: '/usr/bin', HOME: '/home/term', USERPROFILE: '/home/windows' }),
			emptyWindow: await lookedFor({ ...tilde, 'facade.agents.codex.enabled': false }, undefined, undefined),
		}, {
			inAFolder: ['/home/launch/agy', '/home/term/bin/claude', '/work/a/tools/codex'],
			emptyWindow: ['/home/launch/agy', '/home/me/bin/claude'],
		});
	});

	test('Configure Agents opens VS Code\'s settings at the agents\' own, the same search every time', async () => {
		const ran: string[] = [];
		const service = launcherService(new TestTerminalService(), disposables.add(new TestStorageService()), new TestConfigurationService(), ran);
		await service.configure();
		await service.configure();

		assert.deepStrictEqual(ran, ['workbench.action.openSettings ["@ext:vscode.facade-agents"]', 'workbench.action.openSettings ["@ext:vscode.facade-agents"]']);
	});

	test('an agent\'s name is kept as its terminal starts, not with the window\'s next save, and one a floating window brings back last keeps its own: after a crash a moment on, the Codex child\'s tab read only its folder (N-49; WIN-13)', async () => {
		const storage = disposables.add(new TestStorageService());
		storage.store(AGENT_NAMES_STORAGE_KEY, JSON.stringify({ floating: { name: '@floatme #a3' } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const terminals = new TestTerminalService();
		const runsRestored = new DeferredPromise<void>();
		launcherService(terminals, storage, new TestConfigurationService(), [], { trusted: true }, { live: undefined, onDidChangeLive: Event.None, whenRestored: runsRestored.p });

		const child = new TestTerminal('child', { name: '@livechild #a2', icon: AGENT_TERMINAL_ICON, titleTemplate: '${sequence}${separator}@livechild #a2', reconnectionProperties: facadeRunProperties({ workspace: 'record', id: 2 }) });
		terminals.made.fire(child.asInstance());
		const keptAtOnce = JSON.parse(storage.get(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}');

		// The panel's terminals are back and the window is past its phases; the floating window's comes after
		terminals.instances = [child.asInstance()];
		terminals.connected.complete();
		await timeout(0);
		const floating = reconnecting('floating');
		terminals.made.fire(floating.asInstance());
		terminals.instances = [child, floating].map(terminal => terminal.asInstance());
		runsRestored.complete();
		await timeout(0);
		storage.testEmitWillSaveState(WillSaveStateReason.NONE);

		const both = { floating: { name: '@floatme #a3' }, child: { name: '@livechild #a2', titleTemplate: '${sequence}${separator}@livechild #a2' } };
		assert.deepStrictEqual({ keptAtOnce, floating: floating.shellLaunchConfig.name, kept: JSON.parse(storage.get(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}') }, {
			keptAtOnce: both,
			floating: '@floatme #a3',
			kept: both
		});
	});

	test('an agent\'s terminal keeps the name it was started with through the window closing, whoever started it, and loses it once it ends or does not come back; an ordinary terminal drawn with the robot keeps none (VC-06)', async () => {
		// Kept by the window before, as the agent button kept them: three agents, one of which does not come back, as after a restart of the app -
		// and an ordinary terminal the person drew with the robot, which a window that went by the icon kept as an agent's
		const storage = disposables.add(new TestStorageService());
		storage.store(AGENT_NAMES_STORAGE_KEY, JSON.stringify({ first: 'Claude Code', second: 'Codex', gone: 'Grok Build', robot: 'pwsh' }), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const terminals = new TestTerminalService();
		// Listening as the window makes its terminals
		launcherService(terminals, storage, new TestConfigurationService());

		const first = reconnecting('first');
		const second = reconnecting('second');
		terminals.made.fire(first.asInstance());
		terminals.made.fire(second.asInstance());

		// Started now: one from the agent menu - its CLI's title, then which agent it is - two others of Facade's
		// agents - named, with the robot - each marked as its run's, a shell, and the ordinary terminal drawn with the robot
		const button = new TestTerminal('button', { name: '@gemini #3', icon: AGENT_TERMINAL_ICON, titleTemplate: '${sequence}${separator}@gemini #3', reconnectionProperties: facadeRunProperties({ workspace: 'record', id: 3 }) });
		const facade = new TestTerminal('facade', { name: '@main #1 · Claude Code', icon: AGENT_TERMINAL_ICON, reconnectionProperties: facadeRunProperties({ workspace: 'record', id: 1 }) });
		const closed = new TestTerminal('closed', { name: '@clamp #2 · Codex', icon: AGENT_TERMINAL_ICON, reconnectionProperties: facadeRunProperties({ workspace: 'record', id: 2 }) });
		const shell = new TestTerminal('shell', { name: 'pwsh' });
		const robot = new TestTerminal('robot', { name: 'pwsh', icon: AGENT_TERMINAL_ICON });
		for (const terminal of [button, facade, closed, shell, robot]) {
			terminals.made.fire(terminal.asInstance());
		}

		// The second one ends, the person closes one of Facade's, and the terminal service has every other terminal back
		second.exitReason = TerminalExitReason.User;
		terminals.ended.fire(second.asInstance());
		closed.exitReason = TerminalExitReason.User;
		terminals.ended.fire(closed.asInstance());
		terminals.instances = [first, button, facade, shell, robot].map(terminal => terminal.asInstance());
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
