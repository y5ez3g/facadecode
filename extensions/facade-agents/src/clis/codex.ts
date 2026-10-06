/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { canonicalFolder } from '../base/files';
import { AgentCli, skillMarkdown } from './cli';

/** A TOML value for Codex's `-c`: a JSON string is a TOML basic string. */
function toml(value: string | readonly string[] | { readonly [name: string]: string }): string {
	if (typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
	}
	return `{ ${Object.entries(value).map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(item)}`).join(', ')} }`;
}

/** A folder as Codex keys its trust: its real path, with only ASCII letters lower-cased on Windows, as Codex does. */
function projectKey(folder: string): string {
	const real = canonicalFolder(folder);
	return process.platform === 'win32' ? real.replace(/[A-Z]/g, letter => letter.toLowerCase()) : real;
}

/**
 * Codex in its own UI at full access: no approvals and no sandbox. Facade's MCP server comes as `-c`
 * overrides, and so do the settings that would stop it at a question with nobody at the keyboard, and,
 * in a worktree Facade made, the person's trust in the folder, for the launch alone. Nothing is written
 * into the person's own config.toml.
 */
export const codexCli: AgentCli = {
	id: 'codex',
	displayName: 'Codex',
	command: 'codex',
	// Only models its catalog offers no upgrade for: for one it does, Codex starts at a screen that offers
	// the newer model, even with --model, and takes Enter or Esc there as a yes.
	models: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
	fullAccess: () => l10n.t("Codex will run every command without asking you and outside its sandbox: it can edit any file on this computer and reach the network. Facade starts it with {0}, and with {1}, which runs the project's hooks without Codex's review. In the worktrees Facade makes, Facade tells Codex to trust the folder for that run alone, and writes nothing into {2}.", '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '~/.codex/config.toml'),
	task: 'argument',
	enterDelayMs: 300,
	launch(input, executable) {
		const server = (key: string, value: string) => ['-c', `mcp_servers.facade.${key}=${value}`];
		return {
			executable,
			args: [
				...server('command', toml(input.mcp.command)),
				...server('args', toml(input.mcp.args)),
				...server('env', toml(input.mcp.env)),
				...server('startup_timeout_sec', '30'),
				// spawn may wait minutes for a child to come up.
				...server('tool_timeout_sec', '3600'),
				...server('required', 'true'),
				...server('default_tools_approval_mode', '"approve"'),
				// The whole table: in `projects.<folder>` the folder would be split at its dots.
				...(input.trusted ? ['-c', `projects={ ${toml(projectKey(input.folder))} = { trust_level = "trusted" } }`] : []),
				'-c', 'check_for_update_on_startup=false',
				'-c', 'tui.show_tooltips=false',
				'-c', 'notice.hide_rate_limit_model_nudge=true',
				'--dangerously-bypass-approvals-and-sandbox',
				// A process of its own: a session of the shared background server would run with the
				// environment of whoever started that server.
				'--no-daemon',
				// The project's hooks would otherwise stop it at their review screen.
				'--dangerously-bypass-hook-trust',
				'--model', input.model,
				...(input.prompt ? ['--', input.prompt] : [])
			],
			env: {},
			cwd: input.folder,
			files: [],
			injected: input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
		};
	}
};
