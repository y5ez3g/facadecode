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
import { ITerminalEnvironment } from '../../../../platform/terminal/common/terminal.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { agentIcon } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../worktrees/browser/worktrees.js';

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

	const { name, executable, args, env, cwd, agent, reveal } = candidate as Record<string, unknown>;
	return (isUndefined(name) || isString(name))
		&& (isUndefined(executable) || isString(executable))
		&& (isUndefined(args) || (Array.isArray(args) && args.every(isString)))
		&& (isUndefined(env) || (isObject(env) && Object.values(env).every(value => isUndefinedOrNull(value) || isString(value))))
		&& (isUndefined(cwd) || isString(cwd) || URI.isUri(cwd))
		&& (isUndefined(agent) || isString(agent))
		&& (isUndefined(reveal) || isBoolean(reveal));
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
// (`IFolderTerminalsService.openFor`). Answers with it as it is once its process is ready
// (`IFacadeTerminal`).
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
