/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
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
import { ITerminalEnvironment, TerminalExitReason, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ILifecycleService, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalConfigurationService, ITerminalInstanceService } from '../../terminal/browser/terminal.js';
import { IEnvironmentVariableService } from '../../terminal/common/environmentVariable.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { createTerminalEnvironment, createVariableResolver, getWorkspaceForTerminal, mergeEnvironments } from '../../terminal/common/terminalEnvironment.js';
import { agentIcon } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IOwnedWorktreeFile, IRemoveWorktreeOptions, IWorktreeService, IWorktreeSetupState } from '../../worktrees/browser/worktrees.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { facadeRunOf, facadeRunProperties, IFacadeRun, isFacadeRun, isPreparingRun } from '../common/facadeRun.js';
import { isAgentKey } from './facadeAgentKeys.js';
import { MOST_SCREEN_LINES } from './facadeAgentScreen.js';
import { FacadeAgentTerminal, IAgentInputEffect, IAgentInputState, IAgentScreenRead } from './facadeAgentTerminal.js';
import { FacadeNotifications } from './facadeNotifications.js';
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
	 * `agy`, `qwen`. That makes it an agent's terminal, drawn with the CLI's logo as the agent button draws one
	 * (the robot for a CLI without one), and counted and kept as agents' terminals are, its name kept as
	 * its title across a reload.
	 */
	readonly agent?: string;
	/** Whether the agent is one of the person's custom agents: drawn with the robot, whatever program it runs (X-60). */
	readonly custom?: boolean;
	/**
	 * Whether it is put in front once it is open, as `_facade.terminal.reveal` puts one: for an agent
	 * the person started, who is there to watch it.
	 */
	readonly reveal?: boolean;

	/** The agent's run it is made for, which it is marked with: the process it starts is that run's own (`IFacadeRunsService`). */
	readonly run?: IFacadeRun;
	/** The file the run's final screen is written to as its terminal ends (`FacadeAgentTerminal.register`). */
	readonly finalScreen?: URI;
}

/** What `_facade.terminal.read` answers with: the bottom lines of an agent's terminal's screen, and what they are. */
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
	/** The agents' record this load of the window has, once the extension said which (`_facade.window.record`). */
	readonly record?: IFacadeWindowRecord;
}

/** The record of a window's agents: its id under ~/.facade/workspaces, and who the window is to its ledger. */
interface IFacadeWindowRecord {
	readonly id: string;
	readonly owner: string;
}

function isFacadeWindowRecord(candidate: unknown): candidate is IFacadeWindowRecord {
	if (!isObject(candidate)) {
		return false;
	}
	const { id, owner } = candidate as Record<string, unknown>;
	return isString(id) && !!id && isString(owner) && !!owner;
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
		&& (isUndefined(run) || isFacadeRun(run))
		&& (isUndefined(finalScreen) || URI.isUri(finalScreen));
}

/** Whether `candidate` is a number of milliseconds a call can wait: none, or a finite number from 0. */
function isWait(candidate: unknown): candidate is number | null | undefined {
	return isUndefinedOrNull(candidate) || (isNumber(candidate) && Number.isFinite(candidate) && candidate >= 0);
}

/** The terminal of a run's own process, as an agent's terminal reads, types and keeps its screens; none where it runs in none. */
function agentTerminalOf(accessor: ServicesAccessor, run: IFacadeRun): FacadeAgentTerminal | undefined {
	const instance = accessor.get(IFacadeRunsService).terminalOf(run);
	return instance && FacadeAgentTerminal.get(instance) || undefined;
}

/** Whether a terminal's process starts from the window's resolved shell environment (`terminal.integrated.inheritEnv`). */
function inheritsShellEnvironment(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(TerminalSettingId.InheritEnv) !== false;
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
	reloaded: accessor.get(ILifecycleService).startupKind === StartupKind.ReloadedWindow,
	...(windowRecord ? { record: windowRecord } : {})
}));

/**
 * The record this load of the window has. Kept here, in the window, because the extension host can start
 * again under it: a folder window becoming a workspace, Save Workspace As, a restart or a crash of the
 * extension host. VS Code then gives the extension the new workspace's storage, which knows nothing of the
 * record, while the agents of the window run on (AGENT-LAUNCHER.md, L12). A reload starts with none.
 */
let windowRecord: IFacadeWindowRecord | undefined;

// `(record)`: the record this load of the window has, as the extension chose it (`IFacadeWindowRecord`)
CommandsRegistry.registerCommand('_facade.window.record', (_accessor, ...args) => {
	const [record] = args;
	assertType(isFacadeWindowRecord(record), 'IFacadeWindowRecord');
	windowRecord = { id: record.id, owner: record.owner };
});

// `()`: settles once the window has its terminals back - those reconnected to their processes, the
// editor area's and floating windows' restored - so that a run not found is gone (`IFacadeRunsService`).
CommandsRegistry.registerCommand('_facade.terminal.whenRestored', async accessor => {
	await accessor.get(IFacadeRunsService).whenRestored;
});

// `(main, branch, startPoint?, show?)`: a worktree of the repository whose main checkout is `main`, made
// as New Worktree makes one, without its dialog, for an agent sending a child out
// (`IWorktreeService.makeWorktree`). Answers with its folder - and what could not be copied into it, how a
// git hook failed - once its setup has started (WT-5.11); `_facade.worktree.setupOutcome` says how that went.
CommandsRegistry.registerCommand('_facade.worktree.create', async (accessor, ...args) => {
	const [main, branch, startPoint, show] = args;
	assertType(URI.isUri(main), 'URI');
	assertType(isString(branch), 'string');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(startPoint) || isString(startPoint), 'string');
	assertType(isUndefinedOrNull(show) || isBoolean(show), 'boolean');

	return accessor.get(IWorktreeService).makeWorktree(main, branch, { startPoint: startPoint ?? undefined, show: show ?? undefined });
});

// `(worktree)`: how the setup of a worktree `_facade.worktree.create` made came out, once it has
// (`IWorktreeService.setupOutcome`).
CommandsRegistry.registerCommand('_facade.worktree.setupOutcome', async (accessor, ...args) => {
	const [worktree] = args;
	assertType(URI.isUri(worktree), 'URI');

	return accessor.get(IWorktreeService).setupOutcome(worktree);
});

// `(worktree)`: how the setup of a worktree `_facade.worktree.create` made stands now - the line running, where shell
// integration says so, and the last lines of its terminal as plain text - for a start still waiting on it to say what
// it is doing (O3); none where the window knows no setup of it (`IWorktreeService.setupState`).
CommandsRegistry.registerCommand('_facade.worktree.setupState', (accessor, ...args): IWorktreeSetupState | undefined => {
	const [worktree] = args;
	assertType(URI.isUri(worktree), 'URI');

	return accessor.get(IWorktreeService).setupState(worktree);
});

// `(worktree)`: closes the setup terminal of a worktree `_facade.worktree.create` made, its agent's start
// cancelled; the worktree stays (`IWorktreeService.stopSetup`).
CommandsRegistry.registerCommand('_facade.worktree.stopSetup', (accessor, ...args) => {
	const [worktree] = args;
	assertType(URI.isUri(worktree), 'URI');

	accessor.get(IWorktreeService).stopSetup(worktree);
});

// `(worktree, options?)`: deletes the worktree as Delete Worktree does, with nothing asked, its branch
// kept, for an agent's stop_agent, which stops the agents in it in the same order (`IWorktreeService.removeWorktree`):
// changes git would lose, what git ignores, unsaved editors and submodules refuse it unless `options.discardChanges` -
// all but `options.ownFiles`, what Facade put there and nobody changed, by hash. `options.main` is its main checkout,
// for a bar that lists no worktrees; `options.runs` the agents' runs working in it that the caller looked at, the only
// agents' terminals it closes; `options.leftover` says it is what a deletion in this window left of one, which git no
// longer lists. Rejects with why it could not, in the product's words, and what was done all the same: a main checkout
// is never deleted.
CommandsRegistry.registerCommand('_facade.worktree.delete', async (accessor, ...args) => {
	const [worktree, options] = args;
	assertType(URI.isUri(worktree), 'URI');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(options) || isRemoveWorktreeOptions(options), 'IRemoveWorktreeOptions');

	await accessor.get(IWorktreeService).removeWorktree(worktree, options ?? undefined);
});

// `(worktree, options?)`: what `_facade.worktree.delete` with these options would lose, each named as its refusal
// names it, for an agent's deletion to be refused before it stops anything (O5): nothing is done
// (`IWorktreeService.removalLoss`).
CommandsRegistry.registerCommand('_facade.worktree.removalLoss', (accessor, ...args): Promise<readonly string[]> => {
	const [worktree, options] = args;
	assertType(URI.isUri(worktree), 'URI');
	assertType(isUndefinedOrNull(options) || isRemoveWorktreeOptions(options), 'IRemoveWorktreeOptions');

	return accessor.get(IWorktreeService).removalLoss(worktree, options ?? undefined);
});

function isRemoveWorktreeOptions(candidate: unknown): candidate is IRemoveWorktreeOptions {
	if (!isObject(candidate)) {
		return false;
	}

	const { discardChanges, ownFiles, main, runs, leftover } = candidate as Record<string, unknown>;
	return (isUndefined(discardChanges) || isBoolean(discardChanges))
		&& (isUndefined(leftover) || isBoolean(leftover))
		&& (isUndefined(ownFiles) || (Array.isArray(ownFiles) && ownFiles.every(isOwnedWorktreeFile)))
		&& (isUndefined(main) || URI.isUri(main))
		&& (isUndefined(runs) || (Array.isArray(runs) && runs.every(isFacadeRun)));
}

function isOwnedWorktreeFile(candidate: unknown): candidate is IOwnedWorktreeFile {
	if (!isObject(candidate)) {
		return false;
	}

	const { path, sha256 } = candidate as Record<string, unknown>;
	return isString(path) && isString(sha256);
}

// `(workspace, ids, preparing?)`: the runs of the record `workspace` that are live now - starting, running or stopping -
// as the agents' extension says each time its record changes: what the agent button counts (X-51); `preparing`, those
// of them with no terminal yet - their worktrees being made or set up - listed as active agents too (L3).
CommandsRegistry.registerCommand('_facade.agents.live', (accessor, ...args) => {
	const [workspace, ids, preparing] = args;
	assertType(isString(workspace), 'string');
	assertType(Array.isArray(ids) && ids.every(isNumber), 'number[]');
	assertType(isUndefinedOrNull(preparing) || (Array.isArray(preparing) && preparing.every(isPreparingRun)), 'IPreparingRun[]');

	accessor.get(IFacadeRunsService).setLive(workspace, ids, preparing ?? []);
});

// `(folder)`: the agents' runs whose terminals work inside `folder` - where they are now, or where they started
// - with their processes still running: those deleting it would close (`IWorktreeService.terminalsInside`).
CommandsRegistry.registerCommand('_facade.terminal.inside', async (accessor, ...args): Promise<IFacadeRun[]> => {
	const [folder] = args;
	assertType(URI.isUri(folder), 'URI');

	return coalesce((await accessor.get(IWorktreeService).terminalsInside(folder)).map(instance => instance.exitCode === undefined ? facadeRunOf(instance) : undefined));
});

// `(folder)`: the titles of other windows' agents whose processes run inside `folder` - an agent's deletion of a
// worktree that would leave one without its folder is refused before anything is stopped (N-53)
CommandsRegistry.registerCommand('_facade.terminal.elsewhere', async (accessor, ...args): Promise<string[]> => {
	const [folder] = args;
	assertType(URI.isUri(folder), 'URI');

	return accessor.get(IWorktreeService).otherWindowsAgentsIn(folder);
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
	const activeFolder = accessor.get(IActiveFolderService);
	const uriIdentity = accessor.get(IUriIdentityService);

	const instance = await folderTerminals.openFor(folder, {
		name: options?.name,
		// An agent's tab reads what its CLI says it is doing, then which agent it is - `Fix the login bug -
		// @claude #a1` - and only the latter until the CLI sets a title (AGENT-LAUNCHER.md, L3)
		titleTemplate: options?.agent !== undefined && options.name ? `\${sequence}\${separator}${options.name}` : undefined,
		executable: options?.executable,
		args: options?.args,
		env: options?.env,
		// The agent's CLI is started as itself, not through a login shell: it gets the environment a
		// terminal's shell would set up - the window's resolved shell environment - as VS Code's own
		// terminals do (`terminal.integrated.inheritEnv`). Started from the Dock, the window's own PATH is
		// launchd's, without the person's CLIs on it.
		useShellEnvironment: inheritsShellEnvironment(accessor.get(IConfigurationService)),
		cwd: options?.cwd ?? folder,
		icon: options?.agent !== undefined ? agentIcon(options.agent, options.custom) : undefined,
		reconnectionProperties: options?.run ? facadeRunProperties(options.run, { name: options.name, folder: folder.fsPath, finalScreen: options.finalScreen?.toString() }) : undefined
	});
	if (options?.run) {
		runs.register(instance, options.run);
		// Where its final screen goes as it ends (AGENT-DEBUGGING.md, D6)
		if (options.finalScreen) {
			FacadeAgentTerminal.get(instance)?.register({ run: options.run, finalScreen: options.finalScreen });
		}
	}

	// The terminal made, the command answers with it from here on, whatever becomes of it: a failure would
	// end the agent starting in it as one that did not start. Put in front on its own, then, as that waits
	// for the window to go there - but never by putting a row's folder in the workspace, which would make a
	// single folder window a workspace nobody picked: one held for a row that has not joined stays there.
	// Only where the person still is: moved on to another folder while it was made, they stay there, and it is
	// held for its own (PS-15; X-34) - putting it in front would take the window back.
	const stillThere = !activeFolder.activeFolder || uriIdentity.extUri.isEqual(activeFolder.activeFolder.uri, folder);
	if (options?.reveal && stillThere) {
		folderTerminals.reveal(instance, { join: false }).then(undefined, onUnexpectedError);
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

// `(run, signal?)`: ends the run's own process, as closing its tab ends it - with the hang-up, or the
// `signal` a stop that outlived its time escalates to - and answers once it is gone: how it ended, its exit code
// where the window saw one; false while it is not, a few seconds on - or while the window cannot tell yet where it is.
CommandsRegistry.registerCommand('_facade.terminal.stop', async (accessor, ...args) => {
	const [run, signal] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	// An argument the extension host gives as undefined comes as null
	assertType(isUndefinedOrNull(signal) || signal === 'SIGHUP' || signal === 'SIGTERM' || signal === 'SIGKILL', 'SIGHUP | SIGTERM | SIGKILL');
	const runs = accessor.get(IFacadeRunsService);

	const [where] = runs.processes(run.workspace, [run.id]);
	const instance = runs.terminalOf(run);
	if (!instance) {
		return where.state === 'gone' ? { ...(where.end?.exitCode !== undefined ? { exitCode: where.end.exitCode } : {}) } : false;
	}

	// Its queued input, and what is left of an operation going in, go in no more: not into the stopping CLI (D3)
	FacadeAgentTerminal.get(instance)?.closeInput();

	// ⚠️ Not closed outright where it can be helped: the terminal's process manager lets go of the process
	// as it closes, and nothing would say when it is gone. Sent the hang-up closing its tab sends, it ends as
	// it would then, and its terminal closes after it. Windows has no signals: there its console is closed,
	// with every process attached to it.
	if (isWindows) {
		instance.dispose(TerminalExitReason.Extension);
		return {};
	}
	const store = new DisposableStore();
	try {
		// How it exited goes with the answer: a CLI that exits as it is stopped is recorded with its code (N-19)
		const gone = Promise.race([Event.toPromise(instance.onExit, store).then(exit => typeof exit === 'number' ? exit : undefined), Event.toPromise(instance.onDisposed, store).then(() => instance.exitCode)]);
		await instance.sendSignal(signal ?? 'SIGHUP');
		return await raceTimeout(gone.then(exitCode => ({ ...(exitCode !== undefined ? { exitCode } : {}) })), STOP_TIMEOUT_MS) ?? false;
	} finally {
		store.dispose();
	}
});

// `(run, finalScreen)`: tells the terminal the run's own process runs in where its final screen goes as it ends
// (`FacadeAgentTerminal.register`): for a terminal the window gave back after a reload, which keeps nothing of how it
// was opened. Answers whether there is such a terminal.
CommandsRegistry.registerCommand('_facade.terminal.register', (accessor, ...args) => {
	const [run, finalScreen] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	assertType(URI.isUri(finalScreen), 'URI');
	const terminal = agentTerminalOf(accessor, run);
	terminal?.register({ run, finalScreen });
	return !!terminal;
});

// `(run, lines)`: the bottom `lines` lines of the screen of the terminal the run's own process runs in, as it draws
// them, and whether its process has ended (`IFacadeTerminalScreen`). Reading changes nothing of it: not its focus,
// scroll, size, nor where the window is. None where it runs in none, or the terminal has no screen yet (D2).
CommandsRegistry.registerCommand('_facade.terminal.read', async (accessor, ...args): Promise<IFacadeTerminalScreen | undefined> => {
	const [run, lines] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	assertType(isNumber(lines) && Number.isInteger(lines) && lines >= 1 && lines <= MOST_SCREEN_LINES, 'number');
	const terminal = agentTerminalOf(accessor, run);
	const screen = await terminal?.read(lines);
	return terminal && screen && { ...screen, exited: terminal.exited };
});

// `(run, text, options)`: pastes `text` into the terminal the run's own process runs in, with Enter
// `options.enterDelayMs` milliseconds later where `options.enter`, once its turn comes - behind Facade's own input
// there, and the person's typing - `options.queueTimeoutMs` milliseconds at most (`FacadeAgentTerminal.type`; D3, D4).
// With `options.requiresFramework` - a doorbell - not at all if the agent framework is off when its turn comes (M10).
// Answers with what went in (`IAgentInputEffect`); none where it runs in none.
CommandsRegistry.registerCommand('_facade.terminal.type', async (accessor, ...args): Promise<IAgentInputEffect | undefined> => {
	const [run, text, options] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	assertType(isString(text), 'string');
	assertType(isObject(options), 'object');
	const { enter, enterDelayMs, queueTimeoutMs, requiresFramework } = options as Record<string, unknown>;
	assertType(isUndefinedOrNull(enter) || isBoolean(enter), 'boolean');
	assertType(isUndefinedOrNull(requiresFramework) || isBoolean(requiresFramework), 'boolean');
	assertType(isWait(enterDelayMs) && isWait(queueTimeoutMs), 'number');
	return agentTerminalOf(accessor, run)?.type(text, { enter: enter === true, enterDelayMs: Math.round(enterDelayMs ?? 0), queueTimeoutMs: queueTimeoutMs ?? undefined, requiresFramework: requiresFramework === true });
});

// `(run, keys, options)`: presses `keys` in the terminal the run's own process runs in, each as the terminal sends
// it for a key the person presses (`isAgentKey` says which it takes), in its turn as `_facade.terminal.type` types,
// `options.queueTimeoutMs` milliseconds at most (`FacadeAgentTerminal.keys`; D5). Answers with what went in
// (`IAgentInputEffect`); none where it runs in none.
CommandsRegistry.registerCommand('_facade.terminal.keys', async (accessor, ...args): Promise<IAgentInputEffect | undefined> => {
	const [run, keys, options] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	assertType(Array.isArray(keys) && keys.length > 0 && keys.every(key => isString(key) && isAgentKey(key)), 'string[]');
	assertType(isObject(options), 'object');
	const { queueTimeoutMs } = options as Record<string, unknown>;
	assertType(isWait(queueTimeoutMs), 'number');
	return agentTerminalOf(accessor, run)?.keys(keys, { queueTimeoutMs: queueTimeoutMs ?? undefined });
});

// `(run)`: what holds Facade's input into the terminal the run's own process runs in back now: what the person typed
// there since they last pressed Enter or Ctrl+C, and when they last typed; and whether Facade's own input goes in
// there or waits its turn (`IAgentInputState`; D3). None where it runs in none.
CommandsRegistry.registerCommand('_facade.terminal.input', (accessor, ...args): IAgentInputState | undefined => {
	const [run] = args;
	assertType(isFacadeRun(run), 'IFacadeRun');
	return agentTerminalOf(accessor, run)?.inputState();
});

// Before the extension host starts, which asks once whether the window keeps Facade's notifications
registerWorkbenchContribution2(FacadeNotifications.ID, FacadeNotifications, WorkbenchPhase.BlockStartup);

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
	const configurationService = accessor.get(IConfigurationService);
	const envFromConfig = configurationService.getValue<ITerminalEnvironment | undefined>(`terminal.integrated.env.${isWindows ? 'windows' : isMacintosh ? 'osx' : 'linux'}`);
	const version = accessor.get(IProductService).version;
	const detectLocale = accessor.get(ITerminalConfigurationService).config.detectLocale;

	// The base an agent's terminal gets (`_facade.terminal.create`): the resolved shell environment where
	// terminals inherit it, as `TerminalProcessManager._resolveEnvironment` chooses.
	const backend = await instanceService.getBackend();
	const shellEnv = await backend?.getShellEnvironment();
	const baseEnv = inheritsShellEnvironment(configurationService) && shellEnv ? shellEnv : await profileResolverService.getEnvironment(undefined);
	const envForResolver = { ...baseEnv };
	mergeEnvironments(envForResolver, shellEnv);
	const variableResolver = createVariableResolver(workspaceFolder, envForResolver, configurationResolverService);
	const env = await createTerminalEnvironment({ cwd: folder }, envFromConfig, variableResolver, version, detectLocale, baseEnv);
	await environmentVariableService.mergedCollection.applyToProcessEnvironment(env, { workspaceFolder }, variableResolver);
	return env;
});
