/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { resolveActiveFolderTerminalCwd } from '../../terminal/browser/terminalActions.js';
import { agentIcon, agentLaunchOf, AGENT_TITLE_TEMPLATE, AGENTS_SETTING, BUILT_IN_LAUNCHERS, facadeCliOf, IAgentName, isAgentTerminalIcon, ITerminalLauncher, readAgentNames, readConfiguredLaunchers, restoreAgentLaunch, seedLaunchers, toConfiguredLaunchers } from '../common/terminalLaunchers.js';
import { TerminalLauncherDetection } from './terminalLauncherDetection.js';
import { showAgentsDialog } from './terminalLauncherDialog.js';

export const ITerminalLauncherService = createDecorator<ITerminalLauncherService>('terminalLauncherService');

/** Where the names of the agents a window has running are kept across a reload (`readAgentNames`). */
export const AGENT_NAMES_STORAGE_KEY = 'facade.agent.names';

/** Facade's switch, which its agents' extension contributes: whether Facade starts the agents. */
const FACADE_ENABLED_SETTING = 'facade.orchestration.enabled';

/** Facade: Start Agent, which takes the CLI to start as `{ cli }`. */
const START_AGENT_COMMAND = 'facade.agents.startAgent';

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
	 * Starts an agent in a terminal tab, in the folder the window is on - or, while Facade is on, one of the
	 * CLIs Facade starts with Facade: Start Agent, that CLI chosen.
	 */
	open(launcher: ITerminalLauncher): Promise<void>;

	/** Shows the dialog that decides which agents there are, and saves what it answers. */
	configure(): Promise<void>;

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

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IActiveFolderService private readonly _activeFolderService: IActiveFolderService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IHostService private readonly _hostService: IHostService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
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
		// Facade starts its CLIs itself, as agents it knows: Start Agent asks for the rest, the CLI's launch
		// settings say how it starts, and the launcher's command line goes unused (AGENT-FRAMEWORK.md, 2.9.8)
		const cli = facadeCliOf(launcher.command);
		if (cli && this._configurationService.getValue<boolean>(FACADE_ENABLED_SETTING) === true) {
			await this._commandService.executeCommand(START_AGENT_COMMAND, { cli });
			return;
		}

		const cwd = (await resolveActiveFolderTerminalCwd(this._activeFolderService, this._configurationService, this._configurationResolverService))?.cwd;

		const instance = await this._terminalService.createTerminal({
			cwd,
			location: { viewColumn: ACTIVE_GROUP },
			config: {
				// `name` is the fallback rather than the title: with a template set it becomes the
				// process name, which `computeLabel` returns whenever the template comes out empty.
				// So the tab reads `Claude Code` until the agent says otherwise, and never `powershell`.
				name: launcher.label,

				// The agent's own title wins, which is the whole point - a row of tabs all reading
				// `Claude Code` says nothing, while the titles an agent sets say what each is doing.
				//
				// Asked for here rather than left to `terminal.integrated.tabs.allowAgentCliTitle`,
				// which does this already but only for the five CLIs upstream recognises by name.
				// Anything somebody puts in the list is an agent as far as this button is concerned.
				titleTemplate: AGENT_TITLE_TEMPLATE,

				// The agent's logo, or the robot - and the thing that says this terminal is an agent's
				// (`isAgentTerminalIcon`), which is why it comes from the one function
				icon: agentIcon(launcher.command)
			}
		});

		await instance.focusWhenReady();

		const command = launcher.command.trim();
		if (!command) {
			return;
		}

		// Typed at the shell rather than launched as the process, so the command line is the one
		// somebody wrote - quoting, flags and all - and the shell is still there when the agent exits
		try {
			await instance.sendText(command, true);
		} catch (error) {
			this._logService.error(`[terminalLaunchers] could not start ${launcher.id}`, error);
		}
	}

	async configure(): Promise<void> {
		// No guard against a second one. Every way in - the menu item, the palette, the command -
		// needs focus, and taking focus dismisses the dialog that is up, so two of these cannot be
		// on screen together. A guard was tried and measured: it turned a legitimate second opening
		// into nothing at all, because the first promise was still settling when the second arrived.
		const launchers = readConfiguredLaunchers(this._configurationService.getValue(AGENTS_SETTING));

		const kept = await showAgentsDialog(launchers, () => this._detect(), {
			layoutService: this._layoutService,
			keybindingService: this._keybindingService,
			hostService: this._hostService,
			contextViewService: this._contextViewService
		});

		if (kept) {
			await this._configurationService.updateValue(AGENTS_SETTING, toConfiguredLaunchers(kept), ConfigurationTarget.USER);
		}
	}

	/**
	 * What this machine looks like it has, for the dialog to fill an empty list with.
	 *
	 * Asked for rather than run on opening. The scan sees the `PATH` this window was started with,
	 * which Windows does not refresh for a running process - measured here, an installed `agy` was
	 * absent from it while sitting on the stored `PATH` the whole time. A guess that stale should be
	 * something somebody reaches for, not something that happens to them.
	 */
	private async _detect(): Promise<readonly ITerminalLauncher[]> {
		const detection = this._instantiationService.createInstance(TerminalLauncherDetection);

		return seedLaunchers(await detection.detect(BUILT_IN_LAUNCHERS));
	}
}

// ⚠️ Eager: made with the agent menu, before the editors are restored, so that it is listening when
// the agents' terminals are made again (`restoreAgentLaunch`). Delayed, it was made on first use.
registerSingleton(ITerminalLauncherService, TerminalLauncherService, InstantiationType.Eager);
