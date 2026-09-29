/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeCli } from './claude';
import { AgentCli } from './cli';
import { Environment, which } from './which';

/** The agent CLIs Facade starts: Claude Code for now; the others come with their milestones. */
const AGENT_CLIS: readonly AgentCli[] = [claudeCli];

export interface InstalledCli {
	readonly cli: AgentCli;
	readonly executable: string;
}

/** The CLIs Facade can start that this machine has. */
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

/** A CLI's name for people: `Claude Code` for `claude`; the id itself for one Facade does not know. */
export function cliName(id: string): string {
	return AGENT_CLIS.find(cli => cli.id === id)?.displayName ?? id;
}

/** The name of an agent's terminal: its handle, unique per incarnation, kept across a reload. */
export function terminalName(name: string, incarnation: number, cliId: string): string {
	return `@${name} · ${cliName(cliId)}${incarnation > 1 ? ` (${incarnation})` : ''}`;
}
