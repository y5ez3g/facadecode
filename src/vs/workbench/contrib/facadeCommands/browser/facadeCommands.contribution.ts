/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { isString } from '../../../../base/common/types.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IFolderCustomization, isFolderColor, isFolderIcon, IWorkspaceBarCustomizationService } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { AGENT_TERMINAL_ICON } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../worktrees/browser/worktrees.js';
import { instanceByProcessId, lastTerminalInput, readTerminal, TerminalInputTracker } from './facadeTerminals.js';

/*
 * What the person can do in Facade's own parts of the window, as commands with no dialog, for the
 * built-in extension that gives agents the IDE (L2-PLAN, step 31). Underscored, like the git
 * extension's `_git.*`, so they stay out of the Command Palette. Arguments arrive revived: a URI sent
 * from the extension host is a URI here.
 */

/** How long `_facade.terminal.create` waits for the new terminal's process id. */
const PROCESS_READY_TIMEOUT_MS = 5_000;

function uriOf(value: unknown, name: string): URI {
	if (URI.isUri(value)) {
		return value;
	}

	if (value && typeof value === 'object' && isString((value as UriComponents).scheme)) {
		return URI.revive(value as UriComponents);
	}

	throw new Error(`${name} must be a URI.`);
}

/** Puts a folder in the workspace and moves the window onto it, as a click on its row does. */
CommandsRegistry.registerCommand('_facade.folder.show', async (accessor, folder: unknown) => {
	await accessor.get(IWorkspaceBarService).show(uriOf(folder, 'folder'));
});

/** Takes a folder out of the workspace; it stays on disk. */
CommandsRegistry.registerCommand('_facade.folder.remove', async (accessor, folder: unknown) => {
	await accessor.get(IWorkspaceBarService).remove([uriOf(folder, 'folder')]);
});

/** `IWorktreeService.makeWorktree`: `(main, branch, startPoint?, show?)`, answering with the worktree. */
CommandsRegistry.registerCommand('_facade.worktree.create', async (accessor, main: unknown, branch: unknown, startPoint: unknown, show: unknown) => {
	const worktreeService = accessor.get(IWorktreeService);
	if (!isString(branch) || !branch.trim()) {
		throw new Error('branch must be a branch name.');
	}

	const worktree = await worktreeService.makeWorktree(uriOf(main, 'main'), branch, { startPoint: isString(startPoint) && startPoint ? startPoint : undefined, show: show === true });
	return { uri: worktree, path: worktree.fsPath, branch: branch.trim() };
});

/** `IWorktreeService.removeWorktree`: `(worktree, force?)`. */
CommandsRegistry.registerCommand('_facade.worktree.delete', async (accessor, worktree: unknown, force: unknown) => {
	await accessor.get(IWorktreeService).removeWorktree(uriOf(worktree, 'worktree'), { force: force === true });
});

/**
 * `IFolderTerminalsService.openFor`: a terminal for a folder, running `executable` with `args` when
 * given, or the person's shell. `agent` gives it the robot icon, which makes it an agent terminal
 * everywhere L1 counts and keeps them. `args` can be one string, a whole command line, which Windows
 * takes as it is. Answers with its name and process id, by which the extension host finds it among
 * its own terminals - without the id when the process has shown nothing within a few seconds.
 */
CommandsRegistry.registerCommand('_facade.terminal.create', async (accessor, folder: unknown, options: unknown) => {
	const folderTerminals = accessor.get(IFolderTerminalsService);
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
	// On Windows the id comes with the process's first output (node-pty connects to the console late):
	// a process that shows nothing for a while is answered without it, to be found by its name.
	await raceTimeout(instance.processReady, PROCESS_READY_TIMEOUT_MS);
	return { name: instance.title, processId: instance.processId };
});

/**
 * `(processId)`: puts a terminal in front, moving the window onto the folder it is held for when it
 * is another's, as a click on that row would. False when there is no such terminal.
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

/**
 * `()`: every terminal and where it is, which the extension host cannot tell. Its name, its process id,
 * the folder it belongs to - the worktree of a row it is held under included - and whether it is a
 * `tab` or in the `panel` on screen, or in the `background`, held for that folder.
 */
CommandsRegistry.registerCommand('_facade.terminal.list', accessor => {
	const terminalService = accessor.get(ITerminalService);
	const folderTerminals = accessor.get(IFolderTerminalsService);
	return terminalService.instances.map(instance => {
		const folder = folderTerminals.folderOf(instance)?.uri ?? folderTerminals.rowOf(instance);
		const where = !terminalService.foregroundInstances.includes(instance) ? 'background' : instance.target === TerminalLocation.Editor ? 'tab' : 'panel';
		return { name: instance.shellLaunchConfig.name ?? instance.title, processId: instance.processId, folder: folder?.fsPath, where };
	});
});

/** `(processId, lines?)`: the last lines a terminal shows. */
CommandsRegistry.registerCommand('_facade.terminal.read', (accessor, processId: unknown, lines: unknown) => readTerminal(accessor, processId, lines));

/** `(processId)`: when the person last typed into that terminal; undefined if they have not. */
CommandsRegistry.registerCommand('_facade.terminal.lastInput', (accessor, processId: unknown) => lastTerminalInput(accessor, processId));

/** `(folder, { name?, color?, icon? })`: what Customize... sets, field by field; `''` or null clears one. */
CommandsRegistry.registerCommand('_facade.row.set', (accessor, folder: unknown, value: unknown) => {
	const customizationService = accessor.get(IWorkspaceBarCustomizationService);
	const uri = uriOf(folder, 'folder');
	const given = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const current = customizationService.get(uri) ?? {};
	let { name, color, icon }: IFolderCustomization = current;

	if (given.name !== undefined) {
		name = isString(given.name) && given.name.trim() ? given.name.trim() : undefined;
	}

	if (given.color !== undefined) {
		if (given.color === null || given.color === '') {
			color = undefined;
		} else if (isFolderColor(given.color)) {
			color = given.color;
		} else {
			throw new Error(`color is one of the bar's colours, not ${String(given.color)}.`);
		}
	}

	if (given.icon !== undefined) {
		if (given.icon === null || given.icon === '') {
			icon = undefined;
		} else if (isFolderIcon(given.icon)) {
			icon = given.icon;
		} else {
			throw new Error(`icon is one of the bar's folder icons, not ${String(given.icon)}.`);
		}
	}

	// `set` replaces the whole record: what was not given is kept from what was there.
	customizationService.set(uri, { name, color, icon });
});

/**
 * `([{ folder, note }])`: `IWorkspaceBarService.setNotes`. Every note at once, so that an extension
 * host started again clears the notes the one before left.
 */
CommandsRegistry.registerCommand('_facade.row.notes', (accessor, notes: unknown) => {
	if (!Array.isArray(notes)) {
		throw new Error('notes must be a list of { folder, note }.');
	}

	accessor.get(IWorkspaceBarService).setNotes(notes.map(entry => {
		const given = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
		return { uri: uriOf(given.folder, 'folder'), note: isString(given.note) ? given.note : '' };
	}));
});

registerWorkbenchContribution2(TerminalInputTracker.ID, TerminalInputTracker, WorkbenchPhase.AfterRestored);
