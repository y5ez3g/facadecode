/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { antigravityCli } from './antigravity';
import { claudeCli } from './claude';
import { AgentCli, CliConfig, Environment, InstalledCli } from './cli';
import { codexCli } from './codex';
import { homeOf, which } from './executable';
import { museCli } from './muse';

/** The built-ins, in the order the agent menu lists them (AGENT-LAUNCHER.md, L3). */
const AGENT_CLIS: readonly AgentCli[] = [claudeCli, codexCli, antigravityCli, museCli];

/** Every built-in Facade knows, installed or not. */
export function knownClis(): readonly AgentCli[] {
	return AGENT_CLIS;
}

/**
 * The built-ins this machine has and the person offers, each as `configFor` says the person has Facade
 * start it: the file its `path` names, else its command where PATH has it.
 */
export function installedClis(configFor: (cli: AgentCli) => CliConfig = cli => cli.defaults, env: Environment = process.env, folder?: string): InstalledCli[] {
	const installed: InstalledCli[] = [];
	for (const cli of AGENT_CLIS) {
		const config = configFor(cli);
		// In the environment its launch gives it, as a start finds it
		const found = config.enabled ? locateCli(cli, config, { ...env, ...config.launch.environment }, folder) : undefined;
		if (found) {
			installed.push(found);
		}
	}
	return installed;
}

/**
 * `cli`, started as `config` says, where the environment `env` finds it for a terminal starting in `folder`:
 * the file its `path` names, else its command where that environment's PATH has it; undefined where it finds
 * none.
 */
export function locateCli(cli: AgentCli, config: CliConfig, env: Environment, folder?: string): InstalledCli | undefined {
	const program = config.path ? terminalPath(config.path, env, folder) : cli.command;
	const executable = program ? which(program, env) : undefined;
	return executable ? { cli, config, executable } : undefined;
}

/**
 * The file `file` names as a terminal starting in `folder` takes it - `~` its home, a relative path from the
 * folder, not from the extension host's (X-59) - a bare name being a command, which PATH finds. Undefined for
 * a relative one with no folder to start from.
 */
function terminalPath(file: string, env: Environment, folder: string | undefined): string | undefined {
	const separators = process.platform === 'win32' ? /[\\/]/ : /\//;
	if (file === '~' || /^~[\\/]/.test(file)) {
		return path.join(homeOf(env), file.slice(1));
	}
	if (!separators.test(file) || path.isAbsolute(file)) {
		return file;
	}
	return folder === undefined ? undefined : path.resolve(folder, file);
}
