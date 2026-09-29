/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { AgentCli } from './cli';

/**
 * Claude Code in its own interactive UI: file edits and shell commands without asking, Facade's tools
 * allowed. `--strict-mcp-config` and `--setting-sources project,local` keep the user's own servers,
 * plugins and hooks out of it; the repository's own settings still apply.
 */
export const claudeCli: AgentCli = {
	id: 'claude',
	displayName: 'Claude Code',
	command: 'claude',
	models: ['sonnet', 'opus', 'haiku'],
	launch(input, executable) {
		const configPath = path.join(input.runDir, `${input.slug}.mcp.json`);
		const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
		return {
			executable,
			args: [
				// The prompt goes first: the list of tools after it would otherwise swallow it.
				...(input.prompt ? [input.prompt] : []),
				'--mcp-config', configPath,
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--permission-mode', 'acceptEdits',
				'--allowedTools', 'mcp__facade', 'Bash', 'PowerShell',
				'--model', input.model
			],
			env: {},
			cwd: input.folder,
			files: [{ path: configPath, content: JSON.stringify(config, undefined, '\t') }]
		};
	}
};
