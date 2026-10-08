/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatJson, jsonLayoutOf, parseJson } from '../base/files';
import { isJsonObject } from '../base/json';
import { AgentCli, launchArgs, launchUses, launchValues, skillMarkdown } from './cli';

/**
 * Muse Code in its own UI. YOLO on: no approvals and no sandbox. YOLO off: its sandbox on; it has no way
 * to let Facade's server alone through unasked, so it asks for nothing (AGENT-LAUNCHER.md, L4). It reads
 * MCP servers and skills from its folder - `.mcp.json` and `.agents/skills/` - once the folder is trusted,
 * which `--trust-workspace` does for the launch alone. Its server finds the agent through `${VAR}`
 * references to its environment. The notice of its task is its argument.
 */
export const museCli: AgentCli = {
	id: 'muse',
	displayName: 'Muse Code',
	setting: 'facade.agents.muse',
	command: 'muse',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				yoloOn: ['--disable-approval', '--disable-sandbox'],
				yoloOff: ['--disable-approval'],
				model: ['--model', '${model}'],
				effort: ['--reasoning-effort', '${effort}'],
				// After the end of the options, so that a notice starting with a dash is not read as one.
				task: ['--', '${task}']
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
	task: 'argument',
	sandbox: { yoloOn: 'off', yoloOff: 'on' },
	exemption: 'all',
	launch(input, executable) {
		const { connection } = input;
		// Expanded from the agent's own environment when its MCP server starts.
		const servers = connection && { facade: { command: connection.mcp.command, args: connection.mcp.args, env: { ...connection.mcp.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS}' } } };
		return {
			executable,
			args: launchArgs(museCli.setting + '.launch', input.config, launchValues(input), launchUses(input)),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: servers ? [
				{ path: '.mcp.json', content: JSON.stringify({ mcpServers: servers }, undefined, '\t'), merge: theirs => withEntries(theirs, 'mcpServers', servers) },
				...input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
			] : []
		};
	}
};

/**
 * The folder's JSON file with `entries` added under `key` beside what it has, laid out as it is; undefined
 * where they cannot be added without changing what is there: a file that is not a JSON object, or an
 * entry with the same name.
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
