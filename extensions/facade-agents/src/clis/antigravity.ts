/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { canonicalFolder, isEqualPath, updateJsonFile } from '../base/files';
import { JsonObject } from '../base/json';
import { FileLock } from '../base/lock';
import { AgentCli, Environment, skillMarkdown } from './cli';
import { homeOf } from './executable';

/** Where Facade's plugin goes in a folder: Antigravity finds plugins under `.agents/plugins/`. */
const PLUGIN_DIR = '.agents/plugins/facade';
/**
 * Its first conversation, during which it connects its MCP servers; that conversation goes on without
 * them, and the next one has them. Its task, typed once Facade's server said hello, waits behind this
 * one and is that next conversation.
 */
const WARM_UP = 'Reply with the single word ready, and nothing else.';

/** The file Antigravity keeps its settings in, which it reads as it starts: in the home folder `env` gives. */
export function antigravitySettingsFile(env: Environment = process.env): string {
	return path.join(homeOf(env), '.gemini', 'antigravity-cli', 'settings.json');
}

/** What became of the trust: written, already there, or the file left alone - one that cannot be read, or is not as Antigravity writes it. */
export type AntigravityTrust = 'written' | 'there' | 'unreadable';

/**
 * Records the person's trust in a folder as Antigravity does when they answer its question: the folder's
 * real path in the `trustedWorkspaces` list of its settings. It trusts exact folders, so each worktree
 * needs an entry of its own. The rest of the file is kept, and its layout too; a file that is not a
 * JSON object, or whose list is not a list, is left alone. Antigravity writes the file too: what it
 * writes meanwhile is read again, and kept.
 */
export function trustAntigravityWorkspace(folder: string, lock: FileLock, settingsFile: string): AntigravityTrust {
	const entry = canonicalFolder(folder);
	return lock(settingsFile, () => updateJsonFile(settingsFile, (file): { readonly outcome: AntigravityTrust; readonly write?: JsonObject } => {
		if (file.kind === 'other') {
			return { outcome: 'unreadable' };
		}
		const settings = file.kind === 'object' ? file.value : {};
		const listed = settings.trustedWorkspaces ?? [];
		if (!Array.isArray(listed)) {
			return { outcome: 'unreadable' };
		}
		if (listed.some(item => typeof item === 'string' && isEqualPath(canonicalFolder(item), entry))) {
			return { outcome: 'there' };
		}
		return { outcome: 'written', write: { ...settings, trustedWorkspaces: [...listed, entry] } };
	}));
}

/**
 * Antigravity's CLI in its own UI, running every command without asking. It reads MCP servers only from
 * its global configuration or a plugin, so Facade's server and skills go into the folder as a plugin,
 * which every agent there shares: the server finds the agent from its environment. Its background update
 * is turned off for the launch.
 */
export const antigravityCli: AgentCli = {
	id: 'agy',
	displayName: 'Antigravity',
	command: 'agy',
	models: [
		'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
		'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
		'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
		'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
		'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'
	],
	// Given a model it does not have, it silently starts with its own. `agy models` prints an id and a name a line, a tab between.
	listModels: { args: ['models'], parse: output => [...output.matchAll(/^(?<id>[\w.-]+)\t/gm)].flatMap(match => match.groups?.id ? [match.groups.id] : []) },
	trust: {
		write: ({ folder }, lock, env) => {
			const file = antigravitySettingsFile(env);
			switch (trustAntigravityWorkspace(folder, lock, file)) {
				case 'written': return `Antigravity trusts ${folder} now, in the trustedWorkspaces of ${file}.`;
				case 'there': return `Antigravity trusted ${folder} already.`;
				case 'unreadable': return `${file} could not be read, or is not as Antigravity writes it, and was left alone: Antigravity will ask whether to trust ${folder}.`;
			}
		}
	},
	fullAccess: () => l10n.t("Antigravity will run every command and make every edit without asking you: it can do whatever you can on this computer. Facade starts it with {0}. Before Antigravity starts in a worktree Facade made, Facade adds the worktree to {1} in {2}, and nowhere else.", '--mode accept-edits --dangerously-skip-permissions', 'trustedWorkspaces', antigravitySettingsFile()),
	sharedServer: true,
	task: 'terminal',
	// It takes a fast burst of keys for a paste.
	enterDelayMs: 400,
	launch(input, executable) {
		return {
			executable,
			args: ['-i', WARM_UP, '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', input.model],
			env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
			cwd: input.folder,
			files: [],
			injected: [
				{ path: `${PLUGIN_DIR}/plugin.json`, content: JSON.stringify({ name: 'facade' }, undefined, '\t') },
				{ path: `${PLUGIN_DIR}/mcp_config.json`, content: JSON.stringify({ mcpServers: { facade: { command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } }, undefined, '\t') },
				...input.skills.map(skill => ({ path: `${PLUGIN_DIR}/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
			]
		};
	}
};
