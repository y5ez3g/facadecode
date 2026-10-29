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
 * references to its environment. The notice of its task is its argument - through `start_agent`, its opening
 * alone where it has no task, which tells it to ask through Facade messages: no setting takes its question
 * tool away, and its model is not given its server's instructions (L4; N-71). Through `start_agent` its
 * update is off.
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
				// For the run alone: its `--reasoning-effort` it keeps in the person's settings, their own from then on
				// (N-75). The efforts their settings keep for each model would win over this one, and go for the run.
				effort: ['-c', 'reasoning_effort=${effortJson}', '-c', 'model_reasoning_efforts={}'],
				// After the end of the options, so that a notice starting with a dash is not read as one.
				task: ['--', '${task}']
			},
			environment: {},
			// For the launch alone: it stores nothing.
			trust: { arguments: ['--trust-workspace'] },
			// It takes a fast burst of keys for a paste, and an Enter that comes with them for a new line.
			enterDelay: 900,
			taskDelay: 2000,
			unattended: {
				arguments: {},
				// One version for the agent's whole run: its launcher would otherwise update it as it starts it.
				environment: { MUSE_NO_AUTO_UPDATE: '1' }
			}
		}
	},
	sharedServer: true,
	task: 'argument',
	sandbox: { yoloOn: 'off', yoloOff: 'on' },
	exemption: 'all',
	// Its settings turn off only artifact, web_fetch and web_search (YO-07)
	questionTool: 'kept',
	verified: '1.4.4',
	launch(input, executable) {
		const { connection } = input;
		// Expanded from the agent's own environment when its MCP server starts - empty where it is not set: a
		// Muse run by hand in the folder refuses a variable with no value, and turns off every server of the
		// person's with it (O9: no Facade tools and no startup noise; N-42). Empty, the server is not Facade's.
		const servers = connection && { facade: { command: connection.mcp.command, args: connection.mcp.args, env: { ...connection.mcp.env, FACADE_AGENTS_RECORD: '${FACADE_AGENTS_RECORD:-}', FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE:-}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN:-}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS:-}' } } };
		return {
			executable,
			// Its `-c` values are JSON
			args: launchArgs(museCli.setting + '.launch', input.config, { ...launchValues(input), ...input.effort !== undefined ? { effortJson: JSON.stringify(input.effort) } : {} }, launchUses(input)),
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
