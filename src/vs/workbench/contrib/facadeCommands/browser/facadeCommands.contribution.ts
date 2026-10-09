/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { assertType, isBoolean, isNumber, isObject, isString, isUndefined, isUndefinedOrNull } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalEnvironment } from '../../../../platform/terminal/common/terminal.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { agentIcon } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../worktrees/browser/worktrees.js';
import { isAgentKey } from './facadeAgentKeys.js';
import { MOST_SCREEN_LINES } from './facadeAgentScreen.js';
import { FacadeAgentTerminal, IAgentInputEffect, IAgentInputState, IAgentScreenRead, IAgentTerminalOptions } from './facadeAgentTerminal.js';
import { FacadeNotifications } from './facadeNotifications.js';

/** How long `_facade.terminal.create` waits for the new terminal's process id. */
const PROCESS_READY_TIMEOUT_MS = 5_000;

/** The terminal `_facade.terminal.create` opens. What is left out is as for a terminal opened in the window. */
interface IFacadeTerminalOptions {
	/** Its name, which it keeps as its title. */
	readonly name?: string;
	/** What it runs: the person's shell when left out. */
	readonly executable?: string;
	/** The executable's arguments. */
	readonly args?: string[];
	/** Changes to its environment: a variable set to `null` is taken out. */
	readonly env?: ITerminalEnvironment;
	/** Where it starts: its folder when left out. */
	readonly cwd?: string | URI;
	/**
	 * The command of the agent's CLI that runs in it, as `PATH` knows it - `claude`, `codex`, `muse`,
	 * `agy`. That makes it an agent's terminal, drawn with the CLI's logo as the agent button draws one
	 * (the robot for a CLI without one), and counted and kept as agents' terminals are, its name kept as
	 * its title across a reload.
	 */
	readonly agent?: string;
	/**
	 * Whether it is put in front once it is open, as `_facade.terminal.reveal` puts one: for an agent
	 * the person started, who is there to watch it.
	 */
	readonly reveal?: boolean;
	/**
	 * The number of the agent whose run it is: given with `finalScreen`, the terminal is registered as
	 * that agent's (`FacadeAgentTerminal.register`).
	 */
	readonly run?: number;
	/** The file its final screen is written to as it ends. */
	readonly finalScreen?: URI;
}

/** What `_facade.terminal.read` answers with: the bottom lines of a terminal's screen, and what they are. */
interface IFacadeTerminalScreen extends IAgentScreenRead {
	/** Whether its process has ended, its terminal kept open. */
	readonly exited: boolean;
}

/** What `_facade.terminal.create` answers with: the terminal once its process is ready, or a few seconds on. */
interface IFacadeTerminal {
	/**
	 * Its process's id, by which the extension host finds it among its own terminals. None while the
	 * process has shown nothing, which on Windows is when the id comes.
	 */
	readonly processId: number | undefined;
	/** Whether it has closed already, as one whose process could not start does. */
	readonly closed: boolean;
	/** The code its process exited with, once it has. */
	readonly exitCode: number | undefined;
}

/** What `_facade.window.loaded` answers with. */
interface IFacadeWindowLoad {
	/** This load of the window's own id: the same through the extension host's restarts, another after a reload. */
	readonly id: string;
	/** Whether a reload of the window before loaded this one. */
	readonly reloaded: boolean;
}

/** Whether `candidate` is `IFacadeTerminalOptions`: an object whose every option is of its own kind. */
function isFacadeTerminalOptions(candidate: unknown): candidate is IFacadeTerminalOptions {
	if (!isObject(candidate)) {
		return false;
	}

	const { name, executable, args, env, cwd, agent, reveal, run, finalScreen } = candidate as Record<string, unknown>;
	return (isUndefined(name) || isString(name))
		&& (isUndefined(executable) || isString(executable))
		&& (isUndefined(args) || (Array.isArray(args) && args.every(isString)))
		&& (isUndefined(env) || (isObject(env) && Object.values(env).every(value => isUndefinedOrNull(value) || isString(value))))
		&& (isUndefined(cwd) || isString(cwd) || URI.isUri(cwd))
		&& (isUndefined(agent) || isString(agent))
		&& (isUndefined(reveal) || isBoolean(reveal))
		&& (isUndefined(run) || isNumber(run))
		&& (isUndefined(finalScreen) || URI.isUri(finalScreen));
}

/** Whether `candidate` is `IAgentTerminalOptions`: the agent's number, and its final screen's file. */
function isAgentTerminalOptions(candidate: unknown): candidate is IAgentTerminalOptions {
	if (!isObject(candidate)) {
		return false;
	}
	const { run, finalScreen } = candidate as Record<string, unknown>;
	return isNumber(run) && URI.isUri(finalScreen);
}

/** Whether `candidate` is a number of milliseconds a call can wait: none, or a finite number from 0. */
function isWait(candidate: unknown): candidate is number | null | undefined {
	return isUndefinedOrNull(candidate) || (isNumber(candidate) && Number.isFinite(candidate) && candidate >= 0);
}

/** Whether `instance` is the terminal `_facade.terminal.create` opened as `name`, which keeps it as its title. */
function isNamed(instance: ITerminalInstance, name: string): boolean {
	return instance.shellLaunchConfig.name === name || instance.title === name;
}

/**
 * The agent's terminal the extension host names: by its process's id, `processId` - where more than one
 * terminal has had it, the one named `name`, else the one running it - or, with `processId` null, the one
 * terminal named `name`, whose process has not shown its id yet. Ended processes count: a terminal kept
 * open shows how its process ended. None where no one terminal answers: a remote machine's ids and this
 * one's can be the same.
 */
function agentTerminalOf(accessor: ServicesAccessor, processId: number | null, name: string | null | undefined): FacadeAgentTerminal | undefined {
	const instances = accessor.get(ITerminalService).instances.filter(instance => !instance.isDisposed);
	let instance: ITerminalInstance | undefined;
	if (processId === null) {
		const named = isString(name) ? instances.filter(each => isNamed(each, name)) : [];
		instance = named.length === 1 ? named[0] : undefined;
	} else {
		const found = instances.filter(each => each.processId === processId);
		const named = isString(name) ? found.filter(each => isNamed(each, name)) : [];
		const running = found.filter(each => each.exitCode === undefined);
		instance = named.length === 1 ? named[0] : running.length === 1 ? running[0] : found.length === 1 ? found[0] : undefined;
	}
	return instance && FacadeAgentTerminal.get(instance) || undefined;
}

// `()`: the folder the window is on, as the workspace bar shows it; none in an empty window
CommandsRegistry.registerCommand('_facade.folder.active', accessor => accessor.get(IActiveFolderService).activeFolder?.uri);

/** This load of the window: the same through the extension host's restarts, another after a reload. */
const WINDOW_LOAD = generateUuid();

// `()`: how the window was loaded (`IFacadeWindowLoad`): an id of this load's own, and whether a reload of
// the window before loaded it, as VS Code tells itself (`ILifecycleService.startupKind`) - not after it was
// closed, the app quit, or the window crashed.
CommandsRegistry.registerCommand('_facade.window.loaded', (accessor): IFacadeWindowLoad => ({
	id: WINDOW_LOAD,
	reloaded: accessor.get(ILifecycleService).startupKind === StartupKind.ReloadedWindow
}));

// `()`: settles once the window has its terminals back - those reconnected to their processes, and
// the editor area's restored - so that one the extension host does not find is gone.
CommandsRegistry.registerCommand('_facade.terminal.whenRestored', async accessor => {
	const terminalService = accessor.get(ITerminalService);
	const lifecycleService = accessor.get(ILifecycleService);
	await Promise.all([terminalService.whenConnected, lifecycleService.when(LifecyclePhase.Restored)]);
});

// `(main, branch, startPoint?, show?)`: a worktree of the repository whose main checkout is `main`, made
// as New Worktree makes one, without its dialog, for an agent sending a child out
// (`IWorktreeService.makeWorktree`). Answers with its folder.
CommandsRegistry.registerCommand('_facade.worktree.create', async (accessor, ...args) => {
	const [main, branch, startPoint, show] = args;
	assertType(URI.isUri(main), 'URI');
	assertType(isString(branch), 'string');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(startPoint) || isString(startPoint), 'string');
	assertType(isUndefinedOrNull(show) || isBoolean(show), 'boolean');

	return accessor.get(IWorktreeService).makeWorktree(main, branch, { startPoint: startPoint ?? undefined, show: show ?? undefined });
});

// `(folder, options?)`: a terminal for `folder`, opened without disturbing the window
// (`IFolderTerminalsService.openFor`), and registered as the agent `options.run`'s where it is one. Answers
// with it as it is once its process is ready (`IFacadeTerminal`).
CommandsRegistry.registerCommand('_facade.terminal.create', async (accessor, ...args): Promise<IFacadeTerminal> => {
	const [folder, options] = args;
	assertType(URI.isUri(folder), 'URI');
	assertType(isUndefinedOrNull(options) || isFacadeTerminalOptions(options), 'IFacadeTerminalOptions');
	const folderTerminals = accessor.get(IFolderTerminalsService);

	const instance = await folderTerminals.openFor(folder, {
		name: options?.name,
		executable: options?.executable,
		args: options?.args,
		env: options?.env,
		cwd: options?.cwd ?? folder,
		icon: options?.agent !== undefined ? agentIcon(options.agent) : undefined
	});
	if (isNumber(options?.run) && options.finalScreen) {
		FacadeAgentTerminal.get(instance)?.register({ run: options.run, finalScreen: options.finalScreen });
	}

	// The terminal made, the command answers with it from here on, whatever becomes of it: a failure would
	// end the agent starting in it as one that did not start. Put in front on its own, then, as that waits
	// for the window to go there.
	if (options?.reveal) {
		folderTerminals.reveal(instance).then(undefined, onUnexpectedError);
	}

	// Its process is started once the terminal is set up, and on Windows its id comes with the process's
	// first output (node-pty connects to the console late). A terminal that closes, its process not
	// started, has nothing more to wait for.
	if (!instance.isDisposed) {
		const store = new DisposableStore();
		try {
			await raceTimeout(Promise.race([instance.processReady, Event.toPromise(instance.onDisposed, store)]), PROCESS_READY_TIMEOUT_MS);
		} finally {
			store.dispose();
		}
	}
	return { processId: instance.processId, closed: instance.isDisposed, exitCode: instance.exitCode };
});

// `(processId)`: puts the terminal running `processId` in front, moving the window onto the folder it is
// held for when that is another's, as a click on its row would (`IFolderTerminalsService.reveal`).
// Answers whether it is in front.
CommandsRegistry.registerCommand('_facade.terminal.reveal', async (accessor, ...args) => {
	const [processId] = args;
	assertType(isNumber(processId), 'number');
	const folderTerminals = accessor.get(IFolderTerminalsService);

	// Only a terminal whose process runs - an ended one's id can be another process's by now - and only
	// one: a remote machine's ids and this one's can be the same
	const running = accessor.get(ITerminalService).instances.filter(instance => instance.processId === processId && instance.exitCode === undefined);
	return running.length === 1 ? folderTerminals.reveal(running[0]) : false;
});

// Before the extension host starts, which asks once whether the window keeps Facade's notifications
registerWorkbenchContribution2(FacadeNotifications.ID, FacadeNotifications, WorkbenchPhase.BlockStartup);

// `(processId, options, name?)`: registers the terminal of `processId` - `name`, as `agentTerminalOf` finds
// it - as the terminal of the agent `options.run`, its final screen going to `options.finalScreen`
// (`FacadeAgentTerminal.register`): for a terminal the window gave back after a reload, which keeps nothing
// of how it was opened. Answers whether there is such a terminal.
CommandsRegistry.registerCommand('_facade.terminal.register', async (accessor, ...args) => {
	const [processId, options, name] = args;
	assertType(isNumber(processId) || processId === null, 'number');
	assertType(isAgentTerminalOptions(options), 'IAgentTerminalOptions');
	assertType(isUndefinedOrNull(name) || isString(name), 'string');
	const terminal = agentTerminalOf(accessor, processId, name);
	terminal?.register(options);
	return !!terminal;
});

// `(processId, lines, name?)`: the bottom `lines` lines of the screen of the terminal of `processId` - `name`,
// as `agentTerminalOf` finds it - as it draws them, and whether its process has ended
// (`IFacadeTerminalScreen`). Reading changes nothing of it: not its focus, scroll, size, nor where the
// window is. None where there is no such terminal, or it has no screen yet.
CommandsRegistry.registerCommand('_facade.terminal.read', async (accessor, ...args): Promise<IFacadeTerminalScreen | undefined> => {
	const [processId, lines, name] = args;
	assertType(isNumber(processId) || processId === null, 'number');
	assertType(isNumber(lines) && Number.isInteger(lines) && lines >= 1 && lines <= MOST_SCREEN_LINES, 'number');
	assertType(isUndefinedOrNull(name) || isString(name), 'string');
	const terminal = agentTerminalOf(accessor, processId, name);
	const screen = await terminal?.read(lines);
	return terminal && screen && { ...screen, exited: terminal.exited };
});

// `(processId, text, options, name?)`: pastes `text` into the terminal of `processId` - `name`, as
// `agentTerminalOf` finds it - with Enter `options.enterDelayMs` milliseconds later where `options.enter`,
// once the person's typing there lets it, `options.queueTimeoutMs` milliseconds at most
// (`FacadeAgentTerminal.type`). Answers with what went in (`IAgentInputEffect`); none where there is no
// such terminal.
CommandsRegistry.registerCommand('_facade.terminal.type', async (accessor, ...args): Promise<IAgentInputEffect | undefined> => {
	const [processId, text, options, name] = args;
	assertType(isNumber(processId) || processId === null, 'number');
	assertType(isString(text), 'string');
	assertType(isObject(options), 'object');
	const { enter, enterDelayMs, queueTimeoutMs } = options as Record<string, unknown>;
	assertType(isUndefinedOrNull(enter) || isBoolean(enter), 'boolean');
	assertType(isWait(enterDelayMs) && isWait(queueTimeoutMs), 'number');
	assertType(isUndefinedOrNull(name) || isString(name), 'string');
	// Only into a terminal registered as an agent's: one found by its name alone can be a shell opened under it
	const terminal = agentTerminalOf(accessor, processId, name);
	return terminal?.isAgent ? terminal.type(text, { enter: enter === true, enterDelayMs: Math.round(enterDelayMs ?? 0), queueTimeoutMs: queueTimeoutMs ?? undefined }) : undefined;
});

// `(processId, keys, options, name?)`: presses `keys` in the terminal of `processId` - `name`, as
// `agentTerminalOf` finds it - each as the terminal sends it for a key the person presses (`isAgentKey`
// says which it takes), once the person's typing there lets it, `options.queueTimeoutMs` milliseconds at
// most (`FacadeAgentTerminal.keys`). Answers with what went in (`IAgentInputEffect`); none where there is
// no such terminal.
CommandsRegistry.registerCommand('_facade.terminal.keys', async (accessor, ...args): Promise<IAgentInputEffect | undefined> => {
	const [processId, keys, options, name] = args;
	assertType(isNumber(processId) || processId === null, 'number');
	assertType(Array.isArray(keys) && keys.length > 0 && keys.every(key => isString(key) && isAgentKey(key)), 'string[]');
	assertType(isObject(options), 'object');
	const { queueTimeoutMs } = options as Record<string, unknown>;
	assertType(isWait(queueTimeoutMs), 'number');
	assertType(isUndefinedOrNull(name) || isString(name), 'string');
	// Only into a terminal registered as an agent's: one found by its name alone can be a shell opened under it
	const terminal = agentTerminalOf(accessor, processId, name);
	return terminal?.isAgent ? terminal.keys(keys, { queueTimeoutMs: queueTimeoutMs ?? undefined }) : undefined;
});

// `(processId, name?)`: what the person typed into the terminal of `processId` - `name`, as
// `agentTerminalOf` finds it - since they last pressed Enter or Ctrl+C there, and when they last typed; and
// whether Facade's own input goes in there or waits its turn: what holds `_facade.terminal.type` and
// `_facade.terminal.keys` back (`IAgentInputState`). None where there is no such terminal, or it is not
// registered as an agent's: the person's keys are watched there alone.
CommandsRegistry.registerCommand('_facade.terminal.input', (accessor, ...args): IAgentInputState | undefined => {
	const [processId, name] = args;
	assertType(isNumber(processId) || processId === null, 'number');
	assertType(isUndefinedOrNull(name) || isString(name), 'string');
	const terminal = agentTerminalOf(accessor, processId, name);
	return terminal?.isAgent ? terminal.inputState() : undefined;
});
