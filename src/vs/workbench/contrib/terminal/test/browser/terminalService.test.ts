/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, fail, strictEqual } from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { TerminalLocation, TitleEventSource, type IPtyHostAttachTarget, type IShellLaunchConfig, type ITerminalBackend, type ITerminalsLayoutInfo, type TerminalIcon } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../browser/terminal.js';
import { TerminalService, whenReplayed } from '../../browser/terminalService.js';
import { ITerminalProfileService, TERMINAL_CONFIG_SECTION } from '../../common/terminal.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TestTerminalGroupService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestLifecycleService } from '../../../../test/common/workbenchTestServices.js';
import { ILifecycleService, InternalBeforeShutdownEvent, ShutdownReason, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { IDidEnterWorkspaceEvent, IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import type { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';

suite('Workbench - TerminalService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalService: TerminalService;
	let configurationService: TestConfigurationService;
	let dialogService: TestDialogService;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;

	setup(async () => {
		dialogService = new TestDialogService();
		configurationService = new TestConfigurationService({
			files: {},
			terminal: {
				integrated: {
					confirmOnKill: 'never',
					enablePersistentSessions: true
				}
			}
		});

		instantiationService = workbenchInstantiationService({
			configurationService: () => configurationService,
		}, store);
		instantiationService.stub(IDialogService, dialogService);
		instantiationService.stub(ITerminalInstanceService, 'getBackend', undefined);
		instantiationService.stub(ITerminalInstanceService, 'getRegisteredBackends', []);
		instantiationService.stub(IRemoteAgentService, 'getConnection', null);
		instantiationService.stub(IWorkspaceEditingService, { onDidEnterWorkspace: Event.None });

		terminalService = store.add(instantiationService.createInstance(TerminalService));
		instantiationService.stub(ITerminalService, terminalService);
	});

	suite('background terminals', () => {
		test('should remove disposed hidden terminals and their listeners', async () => {
			const disposalEmitters = Array.from({ length: 3 }, () => store.add(new Emitter<ITerminalInstance>()));
			const instances = disposalEmitters.map((emitter, index) => ({
				instanceId: index + 1,
				onDisposed: emitter.event,
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance));
			let instanceIndex = 0;
			instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', () => ({ hideFromUser: true }));
			instantiationService.stub(ITerminalInstanceService, 'createInstance', () => instances[instanceIndex++]);
			terminalService.registerProcessSupport(true);

			const backgroundedTerminalDisposables = Reflect.get(terminalService, '_backgroundedTerminalDisposables') as { size: number };
			for (let i = 0; i < instances.length; i++) {
				const instance = await terminalService.createTerminal({
					config: { hideFromUser: true },
					skipContributedProfileCheck: true,
				});

				strictEqual(terminalService.instances.includes(instance), true);
				strictEqual(backgroundedTerminalDisposables.size, 1);
				strictEqual(disposalEmitters[i].hasListeners(), true);

				disposalEmitters[i].fire(instance);

				strictEqual(terminalService.instances.includes(instance), false);
				strictEqual(backgroundedTerminalDisposables.size, 0);
				strictEqual(disposalEmitters[i].hasListeners(), false);
			}
		});
	});

	test('a remote window brings back the terminals held in the background, as a local one does - a folder\'s put away by a switch among them: else a reload loses every shell of a folder not on screen, its process left running on the remote (REMOTE.md R7) - those no window has, as the panel\'s: not another window\'s a second time', async () => {
		const authority = 'ssh-remote+host';
		instantiationService.set(IWorkbenchEnvironmentService, new class extends mock<IWorkbenchEnvironmentService>() {
			override get remoteAuthority() { return authority; }
		});
		const backend = upcastPartial<ITerminalBackend>({
			onDidRequestDetach: Event.None,
			// 8 another window has, as it does when this window's workspace became another and the old one is opened again
			getTerminalLayoutInfo: async () => ({ tabs: [], background: [upcastPartial<IPtyHostAttachTarget>({ id: 7, isOrphan: true }), upcastPartial<IPtyHostAttachTarget>({ id: 8, isOrphan: false })] }),
			reduceConnectionGraceTime: async () => { },
		});
		instantiationService.stub(ITerminalInstanceService, 'getBackend', async (remoteAuthority?: string) => remoteAuthority === authority ? backend : undefined);
		instantiationService.stub(ITerminalProfileService, 'getContributedDefaultProfile', async () => undefined);
		const created: IShellLaunchConfig[] = [];
		instantiationService.stub(ITerminalInstanceService, 'convertProfileToShellLaunchConfig', (config: IShellLaunchConfig) => config);
		instantiationService.stub(ITerminalInstanceService, 'createInstance', (config: IShellLaunchConfig) => {
			created.push(config);
			// Every event of it quiet, as the service listens to each of them
			return new Proxy<Record<string | symbol, unknown>>({ instanceId: created.length, shellLaunchConfig: config }, {
				get: (target, property) => Reflect.has(target, property) ? target[property] : typeof property === 'string' && property.startsWith('on') ? Event.None : undefined
			}) as unknown as ITerminalInstance;
		});

		const service = store.add(instantiationService.createInstance(TerminalService));
		service.registerProcessSupport(true);
		await service.whenConnected;

		deepStrictEqual(created.map(config => ({ attached: config.attachPersistentProcess?.id, hidden: config.hideFromUser })), [{ attached: 7, hidden: true }]);
	});

	test('a window saves its terminals\' layout only once it has taken back the one it had: an editor terminal coming back first - an agent\'s, its dimensions changing as it is laid out - would save one without the panel\'s terminals still to come back, in place of the one the pty host is about to give back (REMOTE.md R7)', async () => {
		const authority = 'ssh-remote+host';
		instantiationService.set(IWorkbenchEnvironmentService, new class extends mock<IWorkbenchEnvironmentService>() {
			override get remoteAuthority() { return authority; }
		});
		// What the pty host is asked, in order, and when the layout it had came back
		const asked: string[] = [];
		const layout = new DeferredPromise<ITerminalsLayoutInfo>();
		const backend = upcastPartial<ITerminalBackend>({
			onDidRequestDetach: Event.None,
			setTerminalLayoutInfo: async () => { asked.push('set'); },
			getTerminalLayoutInfo: () => { asked.push('get'); return layout.p.then(info => { asked.push('got'); return info; }); },
			reduceConnectionGraceTime: async () => { },
		});
		instantiationService.stub(ITerminalInstanceService, 'getBackend', async (remoteAuthority?: string) => remoteAuthority === authority ? backend : undefined);
		instantiationService.stub(ITerminalProfileService, 'getContributedDefaultProfile', async () => undefined);
		const service = store.add(instantiationService.createInstance(TerminalService));
		service.registerProcessSupport(true);
		await timeout(0);
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const saveNow = () => (service as unknown as { _saveStateNow(): void })._saveStateNow();

		// As an editor terminal laid out before the layout came back asks, then once it has
		saveNow();
		layout.complete({ tabs: [], background: [] });
		await service.whenConnected;
		saveNow();

		deepStrictEqual(asked, ['get', 'got', 'set']);
	});

	test('a remote window carries its terminals\' layout across the reload VS Code gives it as it enters a workspace - a folder window given a second folder - its connection down meanwhile: the reload gives it to the pty host, which keeps layouts by workspace, before reading it, so that the panel\'s terminals are back; a load that is no reload drops it (REMOTE.md R7)', async () => {
		const authority = 'ssh-remote+host';
		instantiationService.set(IWorkbenchEnvironmentService, new class extends mock<IWorkbenchEnvironmentService>() {
			override get remoteAuthority() { return authority; }
		});
		const entered = store.add(new Emitter<IDidEnterWorkspaceEvent>());
		instantiationService.stub(IWorkspaceEditingService, { onDidEnterWorkspace: entered.event });
		// What the pty host is asked, in order
		let asked: string[] = [];
		const backend = upcastPartial<ITerminalBackend>({
			onDidRequestDetach: Event.None,
			setTerminalLayoutInfo: async layout => { asked.push(`set ${JSON.stringify(layout)}`); },
			getTerminalLayoutInfo: async () => { asked.push('get'); return { tabs: [], background: [] }; },
			reduceConnectionGraceTime: async () => { },
		});
		instantiationService.stub(ITerminalInstanceService, 'getBackend', async (remoteAuthority?: string) => remoteAuthority === authority ? backend : undefined);
		instantiationService.stub(ITerminalProfileService, 'getContributedDefaultProfile', async () => undefined);
		// The panel's one group, of the terminal of process 4; and another, of process 5's
		const groupOf = (id: number) => upcastPartial<ITerminalGroup>({ getLayoutInfo: isActive => ({ isActive, activePersistentProcessId: id, terminals: [{ relativeSize: 1, terminal: id }] }) });
		const [group, other] = [groupOf(4), groupOf(5)];
		const groupService = instantiationService.get(ITerminalGroupService) as TestTerminalGroupService;
		const lifecycleService = instantiationService.get(ILifecycleService) as TestLifecycleService;
		// A load of the window, the last one gone, and a workspace entered under it, if any, with the panel's groups, the
		// window then reloading once the event's joiners are done - `meanwhile` what one of them does: what it asked the pty host
		let service: TerminalService | undefined;
		const load = async (startupKind: StartupKind, enter: boolean, groups = [group], meanwhile?: () => void) => {
			service?.dispose();
			asked = [];
			lifecycleService.startupKind = startupKind;
			groupService.groups = groups;
			groupService.activeGroup = groups[0];
			service = store.add(instantiationService.createInstance(TerminalService));
			service.registerProcessSupport(true);
			await service.whenConnected;
			// What its constructor puts off to the next turn, done before it can go
			await timeout(0);
			if (enter) {
				const joined: Promise<void>[] = [];
				entered.fire(upcastPartial<IDidEnterWorkspaceEvent>({ join: promise => joined.push(promise) }));
				meanwhile?.();
				await Promise.all(joined);
				lifecycleService.fireBeforeShutdown(upcastPartial<InternalBeforeShutdownEvent>({ reason: ShutdownReason.RELOAD, veto: () => { } }));
			}
			return asked;
		};

		const loads = [
			await load(StartupKind.NewWindow, true),
			await load(StartupKind.ReloadedWindow, false),
			await load(StartupKind.ReloadedWindow, true),
			await load(StartupKind.ReopenedWindow, false),
			await load(StartupKind.ReloadedWindow, true, []),
			await load(StartupKind.ReloadedWindow, false),
			await load(StartupKind.ReloadedWindow, true, [group], () => { groupService.groups = [other]; groupService.activeGroup = other; }),
			await load(StartupKind.ReloadedWindow, false),
		];

		// The second load, the reload, gives the pty host the layout carried before reading one. The fourth, a window
		// opened on the workspace anew, drops the one carried for it, which the fifth no longer finds. The fifth, its
		// panel empty, carries none for the sixth: a layout of nothing would only take the place of one the pty host has.
		// The seventh's joiner changes its panel, as one putting a folder's terminals away does (`WorkspaceBarSwitcher.startOn`):
		// the eighth is given the panel the window had as it reloaded
		const layoutOf = (id: number) => ({ tabs: [{ isActive: true, activePersistentProcessId: id, terminals: [{ relativeSize: 1, terminal: id }] }], background: [] });
		deepStrictEqual(loads, [['get'], [`set ${JSON.stringify(layoutOf(4))}`, 'get'], ['get'], ['get'], ['get'], ['get'], ['get'], [`set ${JSON.stringify(layoutOf(5))}`, 'get']]);
	});

	test('the window is connected once each terminal that came back has replayed what its process wrote, or never will: its process failed to start - its folder gone - or ended, before or after, or its terminal closed (N-67)', async () => {
		const terminal = () => {
			const replayed = store.add(new Emitter<void>());
			const exit = store.add(new Emitter<number | undefined>());
			const disposed = store.add(new Emitter<ITerminalInstance>());
			return { replayed, exit, disposed, instance: upcastPartial<ITerminalInstance>({ isDisposed: false, onProcessReplayComplete: replayed.event, onExit: exit.event, onDisposed: disposed.event }) };
		};
		const [replaying, failing, closing, endedBefore] = [terminal(), terminal(), terminal(), terminal()];
		const connected = Promise.all([whenReplayed(replaying.instance, false), whenReplayed(failing.instance, false), whenReplayed(closing.instance, false), whenReplayed(endedBefore.instance, true)]).then(() => 'connected');
		replaying.replayed.fire();
		failing.exit.fire(undefined);
		closing.disposed.fire(closing.instance);
		const meanwhile = timeout(50);
		const outcome = await Promise.race([connected, meanwhile.then(() => 'still waiting', () => 'still waiting')]);
		meanwhile.cancel();

		strictEqual(outcome, 'connected');
	});

	suite('safeDisposeTerminal', () => {
		let onExitEmitter: Emitter<number | undefined>;

		setup(() => {
			onExitEmitter = store.add(new Emitter<number | undefined>());
		});

		test('should not show prompt when confirmOnKill is never', async () => {
			await setConfirmOnKill(configurationService, 'never');
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should not show prompt when any terminal editor is closed (handled by editor itself)', async () => {
			await setConfirmOnKill(configurationService, 'editor');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			await setConfirmOnKill(configurationService, 'always');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Editor,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should not show prompt when confirmOnKill is editor and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'editor');
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should show prompt when confirmOnKill is panel and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'panel');
			// No child process cases
			dialogService.setConfirmResult({ confirmed: false });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			// Child process cases
			dialogService.setConfirmResult({ confirmed: false });
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				dispose: () => fail()
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
		test('should show prompt when confirmOnKill is always and panel terminal is closed', async () => {
			await setConfirmOnKill(configurationService, 'always');
			// No child process cases
			dialogService.setConfirmResult({ confirmed: false });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: false,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			// Child process cases
			dialogService.setConfirmResult({ confirmed: false });
			await terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				dispose: () => fail()
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
			dialogService.setConfirmResult({ confirmed: true });
			terminalService.safeDisposeTerminal({
				target: TerminalLocation.Panel,
				hasChildProcesses: true,
				onExit: onExitEmitter.event,
				dispose: () => onExitEmitter.fire(undefined)
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance);
		});
	});

	suite('persistent title and icon updates', () => {
		let backend: TestPersistentTerminalBackend;

		setup(() => {
			backend = new TestPersistentTerminalBackend();
			(terminalService as unknown as { _primaryBackend: Partial<ITerminalBackend> })._primaryBackend = backend;
		});

		test('should not update pty host metadata for custom pty terminals', async () => {
			const instance = createTerminalInstance({ customPtyImplementation: true });

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
				updateIcon(terminalService, instance, false);
			});

			strictEqual(backend.titleUpdateCount, 0);
			strictEqual(backend.iconUpdateCount, 0);
		});

		test('should update pty host metadata for regular pty terminals', async () => {
			const instance = createTerminalInstance();

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
				updateIcon(terminalService, instance, true);
			});

			strictEqual(backend.titleUpdateCount, 1);
			strictEqual(backend.iconUpdateCount, 1);
			strictEqual(backend.lastTitle, 'terminal title');
			strictEqual(backend.lastIconUserInitiated, true);
		});

		test('a window whose workspace became another - a folder window given a second folder - keeps its terminals\' layout under the new one at once, not a debounce later: reloaded right after, it finds them (N-50)', async () => {
			let id = 'folder';
			const stateChanged = store.add(new Emitter<WorkbenchState>());
			instantiationService.set(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({
				getWorkspace: () => upcastPartial<IWorkspace>({ id, folders: [] }),
				getWorkbenchState: () => WorkbenchState.FOLDER,
				onDidChangeWorkbenchState: stateChanged.event,
				onDidChangeWorkspaceFolders: Event.None,
				onDidChangeWorkspaceName: Event.None
			}));
			const service = store.add(instantiationService.createInstance(TerminalService));
			// It saves a layout only once it has taken back the one it had
			await service.whenConnected;
			const savedUnder: string[] = [];
			(service as unknown as { _primaryBackend: Partial<ITerminalBackend> })._primaryBackend = { setTerminalLayoutInfo: async () => { savedUnder.push(id); } };
			// eslint-disable-next-line @typescript-eslint/naming-convention
			(service as unknown as { _attachProcessLayoutListeners(): void })._attachProcessLayoutListeners();

			stateChanged.fire(WorkbenchState.FOLDER);
			id = 'untitled';
			stateChanged.fire(WorkbenchState.WORKSPACE);

			deepStrictEqual(savedUnder, ['untitled']);
		});

		test('a window started with persistent sessions off saves its terminals\' layout once they are on: it waits for no layout it never took back', async () => {
			await setPersistentSessions(configurationService, false);
			const service = store.add(instantiationService.createInstance(TerminalService));
			await service.whenConnected;
			const saved: string[] = [];
			(service as unknown as { _primaryBackend: Partial<ITerminalBackend> })._primaryBackend = { setTerminalLayoutInfo: async () => { saved.push('set'); } };

			await setPersistentSessions(configurationService, true);
			// eslint-disable-next-line @typescript-eslint/naming-convention
			(service as unknown as { _saveStateNow(): void })._saveStateNow();

			deepStrictEqual(saved, ['set']);
		});

		test('a title an escape sequence set is kept as the sequence, not as the label its template made of it (N-03)', async () => {
			const instance = { ...createTerminalInstance(), title: 'Fix it - @codex #a3', titleSource: TitleEventSource.Sequence, sequence: 'Fix it' } as ITerminalInstance;

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
			});

			strictEqual(backend.lastTitle, 'Fix it');
		});

		test('a title the process cleared by an escape sequence is kept cleared, not as the label its template made without it (N-59)', async () => {
			const instance = { ...createTerminalInstance(), title: '@codex #a3', titleSource: TitleEventSource.Sequence, sequence: '' } as ITerminalInstance;

			await runWithFakedTimers({}, async () => {
				updateTitle(terminalService, instance);
			});

			strictEqual(backend.lastTitle, '');
		});
	});
});

async function setConfirmOnKill(configurationService: TestConfigurationService, value: 'never' | 'always' | 'panel' | 'editor') {
	await configurationService.setUserConfiguration(TERMINAL_CONFIG_SECTION, { confirmOnKill: value });
	configurationService.onDidChangeConfigurationEmitter.fire({
		affectsConfiguration: () => true,
		affectedKeys: ['terminal.integrated.confirmOnKill']
	} as unknown as IConfigurationChangeEvent);
}

async function setPersistentSessions(configurationService: TestConfigurationService, value: boolean) {
	await configurationService.setUserConfiguration(TERMINAL_CONFIG_SECTION, { confirmOnKill: 'never', enablePersistentSessions: value });
	configurationService.onDidChangeConfigurationEmitter.fire({
		affectsConfiguration: () => true,
		affectedKeys: ['terminal.integrated.enablePersistentSessions']
	} as unknown as IConfigurationChangeEvent);
}

class TestPersistentTerminalBackend implements Partial<ITerminalBackend> {
	titleUpdateCount = 0;
	iconUpdateCount = 0;
	lastTitle: string | undefined;
	lastIconUserInitiated: boolean | undefined;

	async updateTitle(_id: number, title: string, _titleSource: TitleEventSource): Promise<void> {
		this.titleUpdateCount++;
		this.lastTitle = title;
	}

	async updateIcon(_id: number, userInitiated: boolean, _icon: TerminalIcon, _color?: string): Promise<void> {
		this.iconUpdateCount++;
		this.lastIconUserInitiated = userInitiated;
	}
}

function createTerminalInstance(options?: { customPtyImplementation?: boolean }): ITerminalInstance {
	return {
		persistentProcessId: 13,
		title: 'terminal title',
		titleSource: TitleEventSource.Process,
		staticTitle: undefined,
		icon: { id: 'remote' },
		color: undefined,
		isDisposed: false,
		shellLaunchConfig: options?.customPtyImplementation
			? { customPtyImplementation: () => { throw new Error('should not be called'); } }
			: {},
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
}

function updateTitle(terminalService: TerminalService, instance: ITerminalInstance): void {
	const fn = Reflect.get(terminalService, '_updateTitle') as (instance: ITerminalInstance) => void;
	fn.call(terminalService, instance);
}

function updateIcon(terminalService: TerminalService, instance: ITerminalInstance, userInitiated: boolean): void {
	const fn = Reflect.get(terminalService, '_updateIcon') as (instance: ITerminalInstance, userInitiated: boolean) => void;
	fn.call(terminalService, instance, userInitiated);
}
