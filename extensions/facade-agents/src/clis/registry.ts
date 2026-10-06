/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { antigravityCli } from './antigravity';
import { claudeCli } from './claude';
import { AgentCli, Environment, InstalledCli } from './cli';
import { codexCli } from './codex';
import { which } from './executable';
import { museCli } from './muse';

const AGENT_CLIS: readonly AgentCli[] = [claudeCli, codexCli, antigravityCli, museCli];

/** Every CLI Facade knows, installed or not. */
export function knownClis(): readonly AgentCli[] {
	return AGENT_CLIS;
}

/** The CLIs Facade knows that this machine has. */
export function installedClis(env: Environment = process.env): InstalledCli[] {
	const installed: InstalledCli[] = [];
	for (const cli of AGENT_CLIS) {
		const executable = which(cli.command, env);
		if (executable) {
			installed.push({ cli, executable });
		}
	}
	return installed;
}
