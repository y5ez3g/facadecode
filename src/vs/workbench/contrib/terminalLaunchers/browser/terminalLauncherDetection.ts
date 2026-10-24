/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment, isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { commandExecutable, executableFileNames, isPathLike, ITerminalLauncher, searchPathEntries, WINDOWS_PATH_EXTENSIONS } from '../common/terminalLaunchers.js';

/** `_facade.agents.detectClis(folder?)`: the ids of the built-in agent CLIs the agents' extension host finds. */
export const DETECT_CLIS_COMMAND = '_facade.agents.detectClis';

/**
 * Reports which launchers can be started on this machine.
 *
 * One question, asked the way a shell asks it: is this command on the `PATH`? That is the same
 * question on Windows, macOS and Linux, and it is the only one here - a table of install
 * directories per launcher would have to be written per platform and would be wrong the next time
 * an installer moved, while `PATH` is what the installer edited.
 *
 * The renderer cannot read the environment itself: it is sandboxed with no `process`, and the
 * environment the application was started with is the wrong answer anyway, because a desktop
 * launcher never runs a login shell and `~/.local/bin` is a directory the login shell adds.
 * `IConfigurationResolverService` already holds the answer - on the desktop it is built from
 * `shellEnvironmentService.getShellEnv()` - so `${env:PATH}` through it is the resolved one.
 *
 * The result is a guess, so nothing is hidden when there is nothing to look in.
 */
export class TerminalLauncherDetection {

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService
	) { }

	/**
	 * The ids of the built-ins the agents' extension host finds on its machine - the remote's, in a
	 * remote window - asked in one command (`_facade.agents.detectClis`): the window cannot look on a
	 * remote itself (REMOTE.md R3). Undefined when the extension host cannot be asked - not up yet,
	 * the command being internal and activating nothing - which is not none found.
	 */
	async detectRemote(folder: URI | undefined): Promise<Set<string> | undefined> {
		try {
			const found = await this._commandService.executeCommand<string[]>(DETECT_CLIS_COMMAND, ...(folder ? [folder] : []));
			return new Set((found ?? []).filter(isString));
		} catch (error) {
			this._logService.trace('[terminalLauncherDetection] Could not ask the agents\' extension host which agents it finds', error);
			return undefined;
		}
	}

	/**
	 * The ids of the launchers whose command was found.
	 */
	async detect(launchers: readonly ITerminalLauncher[], env?: IProcessEnvironment): Promise<Set<string>> {
		const [searchPath, extensions] = await Promise.all([this._searchPath(env), this._pathExtensions(env)]);
		const found = new Set<string>();

		if (searchPath.length === 0) {
			// No `PATH` at all, which is what a remote or web window comes out as. An empty menu
			// would be worse than an optimistic one.
			this._logService.trace('[terminalLaunchers] No readable PATH, reporting all detected launchers');
			for (const launcher of launchers) {
				found.add(launcher.id);
			}
			return found;
		}

		await Promise.all(launchers.map(async launcher => {
			if (await this._isPresent(launcher, searchPath, extensions)) {
				found.add(launcher.id);
			}
		}));

		return found;
	}

	private async _isPresent(launcher: ITerminalLauncher, searchPath: readonly URI[], extensions: readonly string[]): Promise<boolean> {
		const executable = commandExecutable(launcher.command);
		if (!executable) {
			// A launcher with no command is the shell itself
			return true;
		}

		if (isPathLike(executable)) {
			return this._exists(URI.file(executable));
		}

		const names = executableFileNames(executable, extensions);
		for (const directory of searchPath) {
			for (const name of names) {
				if (await this._exists(joinPath(directory, name))) {
					return true;
				}
			}
		}

		return false;
	}

	private async _exists(resource: URI): Promise<boolean> {
		try {
			return await this._fileService.exists(resource);
		} catch {
			// A directory this window cannot read is the same answer as one that is not there
			return false;
		}
	}

	/**
	 * The directories on the `PATH` a terminal gets - `env`'s, where the caller has it - else on the
	 * resolved shell `PATH`, in order and without repeats.
	 */
	private async _searchPath(env: IProcessEnvironment | undefined): Promise<URI[]> {
		const resolved = env ? env.PATH ?? env.Path : await this._resolveVariables('${env:PATH}');
		if (!resolved) {
			return [];
		}

		return searchPathEntries(resolved, isWindows ? ';' : ':', !isWindows).map(entry => URI.file(entry));
	}

	/**
	 * The extensions a bare command can carry, which is `PATHEXT` on Windows and nothing anywhere
	 * else. Falls back to the usual four only when the variable cannot be read.
	 */
	private async _pathExtensions(env: IProcessEnvironment | undefined): Promise<readonly string[]> {
		if (!isWindows) {
			return [];
		}

		const resolved = env ? env.PATHEXT : await this._resolveVariables('${env:PATHEXT}');
		const extensions = (resolved ?? '')
			.split(';')
			.map(entry => entry.trim().toLowerCase())
			.filter(entry => entry.startsWith('.'));

		return extensions.length ? extensions : WINDOWS_PATH_EXTENSIONS;
	}

	private async _resolveVariables(value: string): Promise<string | undefined> {
		try {
			const resolved = await this._configurationResolverService.resolveAsync(undefined, value);

			// An unknown variable is handed back unresolved
			return resolved.includes('${env:') ? undefined : resolved;
		} catch (error) {
			this._logService.trace(`[terminalLaunchers] Could not resolve ${value}: ${error}`);
			return undefined;
		}
	}
}
