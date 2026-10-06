/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatJson, jsonLayoutOf, parseJson } from '../base/files';
import { isJsonObject } from '../base/json';
import { AgentCli, launchArgs, skillMarkdown } from './cli';

/**
 * Muse Code in its own UI at full access: no approvals and no sandbox. It reads MCP servers and skills
 * from its folder - `.mcp.json` and `.agents/skills/` - once the folder is trusted: a worktree Facade
 * made by `--trust-workspace`, for the launch alone. Its server finds the agent through `${VAR}`
 * references to its environment. It starts through its own launcher, a `.cmd` on Windows, so its task
 * goes into a file, and a line in its terminal tells it to read it.
 */
export const museCli: AgentCli = {
	id: 'muse',
	displayName: 'Muse Code',
	section: 'muse',
	command: 'muse',
	defaults: {
		path: '',
		launch: {
			arguments: {
				fullAccess: ['--disable-approval', '--disable-sandbox'],
				model: ['--model', '${model}'],
				effort: ['--reasoning-effort', '${effort}']
			},
			// One version for the agent's whole run: its launcher would otherwise update it as it starts it.
			environment: { MUSE_NO_AUTO_UPDATE: '1' },
			// For the launch alone: it stores nothing.
			trust: { arguments: ['--trust-workspace'] },
			// It takes a fast burst of keys for a paste, and an Enter that comes with them for a new line.
			enterDelay: 900,
			taskDelay: 2000
		}
	},
	sharedServer: true,
	task: 'terminal',
	launch(input, executable) {
		// Expanded from the agent's own environment when its MCP server starts.
		const servers = { facade: { command: input.mcp.command, args: input.mcp.args, env: { ...input.mcp.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS}' } } };
		return {
			executable,
			// Its task is typed into its terminal, never given as an argument.
			args: launchArgs(museCli, input.config, { model: input.model, effort: input.effort }, { trust: input.trusted, task: false }),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: [
				{ path: '.mcp.json', content: JSON.stringify({ mcpServers: servers }, undefined, '\t'), merge: theirs => withEntries(theirs, 'mcpServers', servers) },
				...input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
			]
		};
	}
};

/**
 * The person's JSON file with `entries` added under `key` beside theirs, laid out as theirs is; undefined
 * where they cannot be added without changing what is theirs: a file that is not a JSON object, or an
 * entry of theirs with the same name.
 */
function withEntries(theirs: string, key: string, entries: { readonly [name: string]: unknown }): string | undefined {
	let file: unknown;
	try {
		file = parseJson(theirs);
	} catch {
		return undefined;
	}
	const existing = isJsonObject(file) ? file[key] ?? {} : undefined;
	if (!isJsonObject(file) || !isJsonObject(existing) || Object.keys(entries).some(name => existing[name] !== undefined)) {
		return undefined;
	}
	return formatJson({ ...file, [key]: { ...existing, ...entries } }, jsonLayoutOf(theirs));
}
