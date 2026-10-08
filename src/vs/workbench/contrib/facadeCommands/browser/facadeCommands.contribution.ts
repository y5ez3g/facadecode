/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IProcessEnvironment, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { assertType, isBoolean, isNumber, isObject, isString, isUndefined, isUndefinedOrNull } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITerminalEnvironment, TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ILifecycleService, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalConfigurationService, ITerminalInstanceService } from '../../terminal/browser/terminal.js';
import { IEnvironmentVariableService } from '../../terminal/common/environmentVariable.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { createTerminalEnvironment, createVariableResolver, getWorkspaceForTerminal, mergeEnvironments } from '../../terminal/common/terminalEnvironment.js';
import { agentIcon } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../worktrees/browser/worktrees.js';
import { facadeRunProperties, IFacadeRun, isFacadeRun } from '../common/facadeRun.js';
import { IFacadeRunsService } from './facadeRuns.js';

/** How long `_facade.terminal.create` waits for the new terminal's process id. */
const PROCESS_READY_TIMEOUT_MS = 5_000;

/** How long `_facade.terminal.stop` waits for a run's process to end before it answers that it has not yet. */
const STOP_TIMEOUT_MS = 5_000;

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

	/** The agent's run it is made for, which it is marked with: the process it starts is that run's own (`IFacadeRunsService`). */
	readonly run?: IFacadeRun;
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

	const { name, executable, args, env, cwd, agent, reveal, run } = candidate as Record<string, unknown>;
	return (isUndefined(name) || isString(name))
		&& (isUndefined(executable) || isString(executable))
		&& (isUndefined(args) || (Array.isArray(args) && args.every(isString)))
		&& (isUndefined(env) || (isObject(env) && Object.values(env).every(value => isUndefinedOrNull(value) || isString(value))))
		&& (isUndefined(cwd) || isString(cwd) || URI.isUri(cwd))
		&& (isUndefined(agent) || isString(agent))
		&& (isUndefined(reveal) || isBoolean(reveal))
		&& (isUndefined(run) || isFacadeRun(run));
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

// `()`: settles once the window has its terminals back - those reconnected to their processes, the
// editor area's and floating windows' restored - so that a run not found is gone (`IFacadeRunsService`).
CommandsRegistry.registerCommand('_facade.terminal.whenRestored', async accessor => {
	await accessor.get(IFacadeRunsService).whenRestored;
});

// `(main, branch, startPoint?, show?)`: a worktree of the repository whose main checkout is `main`, made
// as New Worktree makes one, without its dialog, for an agent sending a child out
// (`IWorktreeService.makeWorktree`). Answers with its folder, once its setup has run.
CommandsRegistry.registerCommand('_facade.worktree.create', async (accessor, ...args) => {
	const [main, branch, startPoint, show] = args;
	assertType(URI.isUri(main), 'URI');
	assertType(isString(branch), 'string');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(startPoint) || isString(startPoint), 'string');
	assertType(isUndefinedOrNull(show) || isBoolean(show), 'boolean');

	return accessor.get(IWorktreeService).makeWorktree(main, branch, { startPoint: startPoint ?? undefined, show: show ?? undefined });
});

// `(worktree)`: deletes the worktree as Delete Worktree does, with nothing asked - its changes with it, its
// branch kept - for an agent stopping the agents in it (`IWorktreeService.removeWorktree`). Rejects with why
// it could not, in the product's words: a main checkout is never deleted.
CommandsRegistry.registerCommand('_facade.worktree.delete', async (accessor, ...args) => {
	const [worktree] = args;
	assertType(URI.isUri(worktree), 'URI');

	await accessor.get(IWorktreeService).removeWorktree(worktree);
});

// `(folder, options?)`: a terminal for `folder`, opened without disturbing the window
// (`IFolderTerminalsService.openFor`), and registered under the agent's run it is for. Answers with it as
// it is once its process is ready (`IFacadeTerminal`).
CommandsRegistry.registerCommand('_facade.terminal.create', async (accessor, ...args): Promise<IFacadeTerminal> => {
	const [folder, options] = args;
	assertType(URI.isUri(folder), 'URI');
	assertType(isUndefinedOrNull(options) || isFacadeTerminalOptions(options), 'IFacadeTerminalOptions');
	const folderTerminals = accessor.get(IFolderTerminalsService);
	const runs = accessor.get(IFacadeRunsService);

	const instance = await folderTerminals.openFor(folder, {
		name: options?.name,
		// An agent's tab reads what its CLI says it is doing, then which agent it is - `Fix the login bug -
		// @claude #a1` - and only the latter until the CLI sets a title (AGENT-LAUNCHER.md, L3)
		titleTemplate: options?.agent !== undefined && options.name ? `\${sequence}\${separator}${options.name}` : undefined,
		executable: options?.executable,
		args: options?.args,
		env: options?.env,
		cwd: options?.cwd ?? folder,
		icon: options?.agent !== undefined ? agentIcon(options.agent) : undefined,
		reconnectionProperties: options?.run ? facadeRunProperties(options.run) : undefined
	});
	if (options?.run) {
		runs.register(instance, options.run);
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

// `(workspace, ids?)`: what the window knows of the own processes of `workspace`'s runs - those numbered
// `ids`, in their order, or every one it holds: present, gone, or unknown (`IFacadeRunsService.processes`).
CommandsRegistry.registerCommand('_facade.terminal.processes', (accessor, ...args) => {
	const [workspace, ids] = args;
	assertType(isString(workspace), 'string');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(ids) || (Array.isArray(ids) && ids.every(isNumber)), 'number[]');

	return accessor.get(IFacadeRunsService).processes(workspace, ids ?? undefined);
});

// `(run)`: ends the run's own process, as closing its tab ends it, and answers once it is gone: true;
// false while it is not, a few seconds on - or while the window cannot tell yet where it is.
CommandsRegistry.registerCommand('_facade.terminal.stop', async (accessor, ...args) => {
	const [run] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	const runs = accessor.get(IFacadeRunsService);

	const [where] = runs.processes(run.workspace, [run.id]);
	const instance = runs.terminalOf(run);
	if (!instance) {
		return where.state === 'gone';
	}

	// ⚠️ Not closed outright where it can be helped: the terminal's process manager lets go of the process
	// as it closes, and nothing would say when it is gone. Sent the hang-up closing its tab sends, it ends as
	// it would then, and its terminal closes after it. Windows has no signals: there its console is closed,
	// with every process attached to it.
	if (isWindows) {
		instance.dispose(TerminalExitReason.Extension);
		return true;
	}
	const store = new DisposableStore();
	try {
		const gone = Promise.race([Event.toPromise(instance.onExit, store), Event.toPromise(instance.onDisposed, store)]);
		await instance.sendSignal('SIGHUP');
		return await raceTimeout(gone.then(() => true), STOP_TIMEOUT_MS) ?? false;
	} finally {
		store.dispose();
	}
});

// `(run, text)`: types `text`, as it is, into the terminal the run's own process runs in, and answers once
// VS Code has passed it on: true; false when its process runs in none.
CommandsRegistry.registerCommand('_facade.terminal.type', async (accessor, ...args) => {
	const [run, text] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	assertType(isString(text), 'string');

	const instance = accessor.get(IFacadeRunsService).terminalOf(run);
	if (!instance) {
		return false;
	}
	await instance.sendText(text, false);
	return true;
});

// `(run)`: puts the terminal the run's own process runs in in front, moving the window onto the folder it
// is held for when that is another's, as a click on its row would (`IFolderTerminalsService.reveal`).
// Answers whether it is in front.
CommandsRegistry.registerCommand('_facade.terminal.reveal', async (accessor, ...args) => {
	const [run] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	const folderTerminals = accessor.get(IFolderTerminalsService);

	const instance = accessor.get(IFacadeRunsService).terminalOf(run);
	return instance ? folderTerminals.reveal(instance) : false;
});

// `(folder)`: the environment a terminal opened in `folder` gets, as VS Code makes one: the window's, with
// `terminal.integrated.env.<platform>` over it, its variables resolved, and what extensions add to it
// (`TerminalProcessManager._resolveEnvironment`). Where an agent's CLI keeps its files can depend on it.
CommandsRegistry.registerCommand('_facade.terminal.environment', async (accessor, ...args): Promise<IProcessEnvironment> => {
	const [folder] = args;
	assertType(URI.isUri(folder), 'URI');
	const profileResolverService = accessor.get(ITerminalProfileResolverService);
	const instanceService = accessor.get(ITerminalInstanceService);
	const configurationResolverService = accessor.get(IConfigurationResolverService);
	const environmentVariableService = accessor.get(IEnvironmentVariableService);
	const workspaceFolder = getWorkspaceForTerminal(folder, accessor.get(IWorkspaceContextService), accessor.get(IActiveFolderService));
	const envFromConfig = accessor.get(IConfigurationService).getValue<ITerminalEnvironment | undefined>(`terminal.integrated.env.${isWindows ? 'windows' : isMacintosh ? 'osx' : 'linux'}`);
	const version = accessor.get(IProductService).version;
	const detectLocale = accessor.get(ITerminalConfigurationService).config.detectLocale;

	const baseEnv = await profileResolverService.getEnvironment(undefined);
	const envForResolver = { ...baseEnv };
	mergeEnvironments(envForResolver, await (await instanceService.getBackend())?.getShellEnvironment());
	const variableResolver = createVariableResolver(workspaceFolder, envForResolver, configurationResolverService);
	const env = await createTerminalEnvironment({ cwd: folder }, envFromConfig, variableResolver, version, detectLocale, baseEnv);
	await environmentVariableService.mergedCollection.applyToProcessEnvironment(env, { workspaceFolder }, variableResolver);
	return env;
});
