/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { antigravityCli } from './antigravity';
import { claudeCli } from './claude';
import { AgentCli, CliConfig, Environment, InstalledCli } from './cli';
import { codexCli } from './codex';
import { which } from './executable';
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
export function installedClis(configFor: (cli: AgentCli) => CliConfig = cli => cli.defaults, env: Environment = process.env): InstalledCli[] {
	const installed: InstalledCli[] = [];
	for (const cli of AGENT_CLIS) {
		const config = configFor(cli);
		const found = config.enabled ? locateCli(cli, config, env) : undefined;
		if (found) {
			installed.push(found);
		}
	}
	return installed;
}

/**
 * `cli`, started as `config` says, where the environment `env` finds it: the file its `path` names, else
 * its command where that environment's PATH has it; undefined where it finds none.
 */
export function locateCli(cli: AgentCli, config: CliConfig, env: Environment): InstalledCli | undefined {
	const program = config.path || cli.command;
	const executable = program ? which(program, env) : undefined;
	return executable ? { cli, config, executable } : undefined;
}
