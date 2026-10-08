/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { agentLaunchOf, BUILT_IN_LAUNCHERS, IAgentName, isAgentTerminalIcon, ITerminalLauncher, readAgentNames, restoreAgentLaunch } from '../common/terminalLaunchers.js';
import { TerminalLauncherDetection } from './terminalLauncherDetection.js';

export const ITerminalLauncherService = createDecorator<ITerminalLauncherService>('terminalLauncherService');

/** Where the names of the agents a window has running are kept across a reload (`readAgentNames`). */
export const AGENT_NAMES_STORAGE_KEY = 'facade.agent.names';

/** Agents: Start Agent..., which the agents' extension contributes: it takes the agent to start as `{ cli }`. */
const START_AGENT_COMMAND = 'facade.agents.startAgent';

/** The search Configure Agents opens the settings at, the same every time: the agents' extension's settings. */
const AGENT_SETTINGS_QUERY = '@ext:vscode.facade-agents';

/**
 * The agent button, as much of it as anything outside the tool bar needs.
 *
 * Narrow on purpose: the service holds these so a keybinding can reach one, and holding the view
 * item itself would make a service of the workbench depend on how the button is drawn.
 */
export interface IAgentMenuButton {
	/** Whether this is the button drawn in that window. */
	isIn(window: Window): boolean;

	/** Opens its dropdown. */
	show(): void;
}

/**
 * What the agent menu is built on: starting an agent, editing the list, and saying afterwards which
 * terminals are agents' - the ones it started, and any other drawn with an agent's icon, as Facade's
 * agents are.
 */
export interface ITerminalLauncherService {

	readonly _serviceBrand: undefined;

	/**
	 * Fires when the answer to `isAgentTerminal` may have moved for some terminal.
	 *
	 * A tab is active before its terminal exists to be asked about, so whoever is holding an answer
	 * has to be told to ask again.
	 */
	readonly onDidChangeAgentTerminals: Event<void>;

	/** Whether this terminal is an agent's: drawn with an agent's icon, as those the agent menu starts are. */
	isAgentTerminal(resource: URI | undefined): boolean;

	/**
	 * The agents' terminals open now (`isAgentTerminal`), in every folder: showing, and put away by a
	 * folder switch. Changes with `onDidChangeAgentTerminals`.
	 */
	readonly agentTerminals: readonly ITerminalInstance[];

	/**
	 * Starts the agent `launcher` is in the folder on screen, with Agents: Start Agent - asking VS Code's own
	 * question first in Restricted Mode, and nothing where the person does not trust the workspace.
	 */
	open(launcher: ITerminalLauncher): Promise<void>;

	/** Opens VS Code's settings at the agents' own, the same search every time. */
	configure(): Promise<void>;

	/** The built-ins this machine has and the person offers, by id, as last found. Changes with `onDidChangeAvailable`. */
	readonly available: ReadonlySet<string>;

	/** Fires when `available` changed. */
	readonly onDidChangeAvailable: Event<void>;

	/**
	 * Looks for the built-ins again, as a terminal in the folder on screen would find them: the path setting
	 * of each the person offers, else its command on the PATH a terminal gets. Nothing is written into the
	 * settings.
	 */
	refreshAvailable(): Promise<void>;

	/**
	 * Records a button as drawn, until the returned disposable says it is gone.
	 */
	registerButton(button: IAgentMenuButton): IDisposable;

	/** Opens the agent menu on the button that window has, and answers whether it had one on screen. */
	showMenu(window: Window): boolean;
}

export class TerminalLauncherService extends Disposable implements ITerminalLauncherService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeAgentTerminals: Event<void>;

	/**
	 * Every agent button on screen, across every window this workbench has.
	 *
	 * A command cannot reach a tool bar's dropdown, and the alternative - a second, keyboard-only
	 * way to list the same agents - is a second surface to keep in step with the first.
	 */
	private readonly _buttons = new Set<IAgentMenuButton>();

	/**
	 * The name and title template each agent's terminal was started with, by the terminal's shell
	 * integration nonce, to give back after a reload (`restoreAgentLaunch`).
	 *
	 * A terminal forgets both when a reload reconnects it, and the nonce is what it carries across:
	 * made once for each terminal, it goes with the process.
	 */
	private readonly _names: Map<string, IAgentName>;

	private _available: ReadonlySet<string> = new Set();
	private readonly _onDidChangeAvailable = this._register(new Emitter<void>());
	readonly onDidChangeAvailable = this._onDidChangeAvailable.event;
	/** Set while the built-ins are looked for; looked for again once that is done, where asked meanwhile. */
	private _looking: Promise<void> | undefined;
	private _lookAgain = false;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IActiveFolderService private readonly _activeFolderService: IActiveFolderService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceTrustRequestService private readonly _workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService
	) {
		super();

		// A terminal arriving or leaving, and an icon being changed on one that stayed - the second
		// because the icon is what says a terminal is an agent's, so changing it changes the answer.
		// Leaving is heard on its own as well: one put in the background by a folder switch ends
		// without `onDidChangeInstances`, and went on being counted among the agents.
		this.onDidChangeAgentTerminals = Event.any(
			this._terminalService.onDidChangeInstances,
			Event.map(this._terminalService.onDidDisposeInstance, () => undefined),
			Event.map(this._terminalService.onAnyInstanceIconChange, () => undefined)
		);

		// ⚠️ Given back as each terminal is made, which is before it works out its title - on the
		// terminal's own, from a reload's `attachPersistentProcess`. Afterwards is too late: its tab
		// would read the process's name until the agent next set a title. And kept as each agent's
		// terminal is started, whoever starts it - here, or anything that gives a terminal an agent's icon.
		this._names = readAgentNames(this._storageService.get(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE));
		this._register(this._terminalService.onDidCreateInstance(instance => {
			if (restoreAgentLaunch(instance.shellLaunchConfig, this._names)) {
				return;
			}

			const launch = agentLaunchOf(instance.shellLaunchConfig);
			if (launch) {
				this._names.set(instance.shellIntegrationNonce, launch);
			}
		}));

		// An agent ended is forgotten; one the window closing takes away comes back with a reload
		this._register(this._terminalService.onDidDisposeInstance(instance => {
			if (instance.exitReason !== TerminalExitReason.Shutdown) {
				this._names.delete(instance.shellIntegrationNonce);
			}
		}));
		this._register(this._storageService.onWillSaveState(() => this._saveNames()));

		// And so is one that did not come back
		this._forgetAgentsNotBack().then(undefined, onUnexpectedError);
	}

	/**
	 * Forgets the names of the agents that did not come back: an agent does not outlive the app. Asked
	 * once every terminal the window had is back, those of floating windows included, which come last.
	 */
	private async _forgetAgentsNotBack(): Promise<void> {
		await Promise.all([this._terminalService.whenConnected, this._lifecycleService.when(LifecyclePhase.Eventually)]);
		if (this._store.isDisposed) {
			return;
		}

		const running = new Set(this.agentTerminals.map(instance => instance.shellIntegrationNonce));
		for (const nonce of [...this._names.keys()]) {
			if (!running.has(nonce)) {
				this._names.delete(nonce);
			}
		}
	}

	private _saveNames(): void {
		if (this._names.size) {
			this._storageService.store(AGENT_NAMES_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._names)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(AGENT_NAMES_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	isAgentTerminal(resource: URI | undefined): boolean {
		return isAgentTerminalIcon(this._terminalService.getInstanceFromResource(resource)?.icon);
	}

	get agentTerminals(): readonly ITerminalInstance[] {
		// `instances` rather than the ones on screen: those a folder switch put away are in it too
		return this._terminalService.instances.filter(instance => isAgentTerminalIcon(instance.icon));
	}

	registerButton(button: IAgentMenuButton): IDisposable {
		this._buttons.add(button);

		return toDisposable(() => this._buttons.delete(button));
	}

	showMenu(window: Window): boolean {
		// The one in the window the key was pressed in. An auxiliary window draws a title bar of its
		// own, so more than one of these is on screen and the first is not always the right one.
		for (const button of this._buttons) {
			if (button.isIn(window)) {
				button.show();
				return true;
			}
		}

		return false;
	}

	async open(launcher: ITerminalLauncher): Promise<void> {
		// The agents' extension runs only in a trusted workspace: VS Code's own question first, and the same
		// start goes on once the person trusts it (AGENT-LAUNCHER.md, L3).
		if (!this._workspaceTrustManagementService.isWorkspaceTrusted()) {
			const trusted = await this._workspaceTrustRequestService.requestWorkspaceTrust({
				message: localize('facade.agent.trustToStart', "An agent works in the folders of this workspace. Trust the workspace to start {0}.", launcher.label)
			});
			if (!trusted) {
				return;
			}
		}

		// The agent starts at once in the folder on screen, asking nothing: its settings say how.
		await this._commandService.executeCommand(START_AGENT_COMMAND, { cli: launcher.id });
	}

	async configure(): Promise<void> {
		await this._commandService.executeCommand('workbench.action.openSettings', AGENT_SETTINGS_QUERY);
	}

	get available(): ReadonlySet<string> {
		return this._available;
	}

	refreshAvailable(): Promise<void> {
		if (this._looking) {
			this._lookAgain = true;
			return this._looking;
		}
		this._looking = this._lookForBuiltIns().finally(() => {
			this._looking = undefined;
			if (this._lookAgain) {
				this._lookAgain = false;
				this.refreshAvailable().catch(onUnexpectedError);
			}
		});
		return this._looking;
	}

	/** The built-ins the person offers, each at its path setting or its command, found as a terminal in the folder on screen finds them. */
	private async _lookForBuiltIns(): Promise<void> {
		const offered = BUILT_IN_LAUNCHERS
			.filter(launcher => this._configurationService.getValue(`${launcher.setting}.enabled`) !== false)
			.map(launcher => {
				const path = this._configurationService.getValue<unknown>(`${launcher.setting}.path`);
				return typeof path === 'string' && path.trim() ? { ...launcher, command: `"${path.trim()}"` } : launcher;
			});
		const env = await this._terminalEnvironment();
		const found = await this._instantiationService.createInstance(TerminalLauncherDetection).detect(offered, env);
		if (found.size !== this._available.size || [...found].some(id => !this._available.has(id))) {
			this._available = found;
			this._onDidChangeAvailable.fire();
		}
	}

	/** The environment a terminal in the folder on screen gets, as the workbench makes it; none where it cannot say. */
	private async _terminalEnvironment(): Promise<IProcessEnvironment | undefined> {
		const folder = (this._activeFolderService.activeFolder ?? this._workspaceContextService.getWorkspace().folders.at(0))?.uri;
		if (!folder || folder.scheme !== 'file') {
			return undefined;
		}
		try {
			return await this._commandService.executeCommand<IProcessEnvironment>('_facade.terminal.environment', folder);
		} catch (error) {
			this._logService.trace('[terminalLaunchers] the environment a terminal gets could not be read', error);
			return undefined;
		}
	}
}

// ⚠️ Eager: made with the agent menu, before the editors are restored, so that it is listening when
// the agents' terminals are made again (`restoreAgentLaunch`). Delayed, it was made on first use.
registerSingleton(ITerminalLauncherService, TerminalLauncherService, InstantiationType.Eager);
