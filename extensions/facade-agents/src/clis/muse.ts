/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { formatJson, jsonLayoutOf, parseJson } from '../base/files';
import { isJsonObject } from '../base/json';
import { AgentCli, skillMarkdown } from './cli';

/** How hard it thinks where the person chose nothing. */
const DEFAULT_EFFORT = 'high';

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
	command: 'muse',
	models: ['muse-spark-1.3-contributor', 'muse-spark-1.3', 'muse-spark-1.2'],
	fullAccess: () => l10n.t("Muse Code will run every command without asking you and outside its sandbox: it can do whatever you can on this computer. Facade starts it with {0}. In the worktrees Facade makes, and nowhere else, Facade also tells Muse Code to trust the folder for that run alone, with {1}, which stores nothing: the project's own hooks, MCP servers and skills load there without Muse Code asking.", '--disable-approval --disable-sandbox', '--trust-workspace'),
	sharedServer: true,
	task: 'terminal',
	// It takes a fast burst of keys for a paste, and an Enter that comes with them for a new line.
	enterDelayMs: 900,
	// Its contributor models would think at max unless told otherwise, for minutes a step.
	efforts: { levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], byDefault: DEFAULT_EFFORT },
	launch(input, executable) {
		// Expanded from the agent's own environment when its MCP server starts.
		const servers = { facade: { command: input.mcp.command, args: input.mcp.args, env: { ...input.mcp.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}' } } };
		return {
			executable,
			args: [
				'--model', input.model,
				'--reasoning-effort', input.effort ?? DEFAULT_EFFORT,
				'--disable-approval',
				'--disable-sandbox',
				...(input.trusted ? ['--trust-workspace'] : [])
			],
			env: {},
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
