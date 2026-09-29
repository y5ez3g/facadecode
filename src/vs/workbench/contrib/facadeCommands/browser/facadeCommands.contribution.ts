/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { isString } from '../../../../base/common/types.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalLauncherService } from '../../terminalLaunchers/browser/terminalLauncherService.js';
import { AGENT_TERMINAL_ICON } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../worktrees/browser/worktrees.js';
import { instanceByProcessId, lastTerminalInput, readTerminal, TerminalInputTracker } from './facadeTerminals.js';

// What the agents' extension needs of Facade's own parts of the window and cannot do through the
// extension API, as commands with no dialog (WORKTREE-AGENTS.md, section 18). Underscored, like the
// git extension's `_git.*`, so they stay out of the Command Palette.

/** How long `_facade.terminal.create` waits for the new terminal's process id. */
const PROCESS_READY_TIMEOUT_MS = 5_000;

/** A URI argument, as it arrives revived from the extension host, or as plain components. */
function uriOf(value: unknown, name: string): URI {
	if (URI.isUri(value)) {
		return value;
	}

	if (value && typeof value === 'object' && isString((value as UriComponents).scheme)) {
		return URI.revive(value as UriComponents);
	}

	throw new Error(`${name} must be a URI.`);
}

/** `()`: the folder the window is on, as the workspace bar shows it; undefined in an empty window. */
CommandsRegistry.registerCommand('_facade.folder.active', accessor => accessor.get(IActiveFolderService).activeFolder?.uri);

/**
 * `IWorktreeService.makeWorktree`: `(main, branch, startPoint?, show?)`, answering with the worktree's
 * folder. New Worktree's flow without its dialog, for an agent sending a child out.
 */
CommandsRegistry.registerCommand('_facade.worktree.create', async (accessor, main: unknown, branch: unknown, startPoint: unknown, show: unknown) => {
	if (!isString(branch) || !branch.trim()) {
		throw new Error('branch must be a branch name.');
	}

	const worktree = await accessor.get(IWorktreeService).makeWorktree(uriOf(main, 'main'), branch, { startPoint: isString(startPoint) && startPoint ? startPoint : undefined, show: show === true });
	return { uri: worktree, path: worktree.fsPath, branch: branch.trim() };
});

/** `IWorktreeService.removeWorktree`: `(worktree, force?)`. Delete Worktree's flow without its dialog. */
CommandsRegistry.registerCommand('_facade.worktree.delete', async (accessor, worktree: unknown, force: unknown) => {
	await accessor.get(IWorktreeService).removeWorktree(uriOf(worktree, 'worktree'), { force: force === true });
});

/**
 * `IFolderTerminalsService.openFor`: a terminal for a folder, running `executable` with `args` when
 * given, or the person's shell. `agent` gives it the robot icon, which makes it an agent terminal
 * everywhere L1 counts and keeps them, and keeps its name as its title across a reload. `args` can be
 * one string, a whole command line, which Windows takes as it is. Answers with its name and process
 * id, by which the extension host finds it among its own terminals - without the id when the process
 * has shown nothing within a few seconds.
 */
CommandsRegistry.registerCommand('_facade.terminal.create', async (accessor, folder: unknown, options: unknown) => {
	const folderTerminals = accessor.get(IFolderTerminalsService);
	const launchers = accessor.get(ITerminalLauncherService);
	const uri = uriOf(folder, 'folder');
	const given = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
	const env = given.env && typeof given.env === 'object'
		? Object.fromEntries(Object.entries(given.env as Record<string, unknown>).filter((entry): entry is [string, string] => isString(entry[1])))
		: undefined;
	const config: IShellLaunchConfig = {
		name: isString(given.name) ? given.name : undefined,
		executable: isString(given.executable) ? given.executable : undefined,
		// A string is a whole command line, as Windows takes it.
		args: Array.isArray(given.args) ? given.args.filter(isString) : isString(given.args) ? given.args : undefined,
		env,
		cwd: isString(given.cwd) ? given.cwd : uri,
		icon: given.agent === true ? AGENT_TERMINAL_ICON : undefined
	};

	const instance = await folderTerminals.openFor(uri, config);
	if (given.agent === true && config.name) {
		launchers.keepName(instance, config.name);
	}
	// On Windows the id comes with the process's first output (node-pty connects to the console late):
	// a process that shows nothing for a while is answered without it, to be found by its name.
	await raceTimeout(instance.processReady, PROCESS_READY_TIMEOUT_MS);
	return { name: instance.title, processId: instance.processId };
});

/** `(processId, lines?)`: the last lines a terminal shows. */
CommandsRegistry.registerCommand('_facade.terminal.read', (accessor, processId: unknown, lines: unknown) => readTerminal(accessor, processId, lines));

/**
 * `(processId)`: puts a terminal in front, moving the window onto the folder it is held for when it is
 * another's, as a click on that row would. False when there is no such terminal.
 */
CommandsRegistry.registerCommand('_facade.terminal.reveal', async (accessor, processId: unknown) => {
	const folderTerminals = accessor.get(IFolderTerminalsService);
	const instance = instanceByProcessId(accessor, processId);
	if (!instance) {
		return false;
	}

	await folderTerminals.reveal(instance);
	return true;
});

/** `(processId)`: when the person last typed into that terminal; undefined if they have not. */
CommandsRegistry.registerCommand('_facade.terminal.lastInput', (accessor, processId: unknown) => lastTerminalInput(accessor, processId));

registerWorkbenchContribution2(TerminalInputTracker.ID, TerminalInputTracker, WorkbenchPhase.AfterRestored);
