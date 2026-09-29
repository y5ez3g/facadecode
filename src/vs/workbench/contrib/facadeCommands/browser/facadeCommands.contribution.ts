/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { isString } from '../../../../base/common/types.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { AGENT_TERMINAL_ICON } from '../../terminalLaunchers/common/terminalLaunchers.js';
import { readTerminal } from './facadeTerminals.js';

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

/** `(processId, lines?)`: the last lines a terminal shows. */
CommandsRegistry.registerCommand('_facade.terminal.read', (accessor, processId: unknown, lines: unknown) => readTerminal(accessor, processId, lines));
