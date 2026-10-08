/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalFolder } from '../base/files';
import { AgentCli, launchArgs, launchUses, launchValues, skillMarkdown } from './cli';

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
 * Codex in its own UI. YOLO on: no approvals and no sandbox. YOLO off: its workspace-write sandbox, asking
 * before what the sandbox does not allow, while its server setting lets Facade's tools through unasked.
 * Facade's MCP server comes as `-c` overrides, and so do the settings that would stop it at a question
 * nobody asked for, and the person's trust in the folder it starts in, for the launch alone. Nothing is
 * written into the person's own config.toml.
 */
export const codexCli: AgentCli = {
	id: 'codex',
	displayName: 'Codex',
	setting: 'facade.agents.codex',
	command: 'codex',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				connect: [
					'-c', 'mcp_servers.facade.command=${mcpCommand}',
					'-c', 'mcp_servers.facade.args=${mcpArgs}',
					'-c', 'mcp_servers.facade.env=${mcpEnv}',
					'-c', 'mcp_servers.facade.startup_timeout_sec=30',
					// start_agent may wait minutes for a child to come up.
					'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
					'-c', 'mcp_servers.facade.required=true',
					// Facade's tools unasked, whatever the agent's YOLO.
					'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
					// A process of its own: a session of the shared background server would run with the
					// environment of whoever started that server.
					'--no-daemon'
				],
				quiet: ['-c', 'check_for_update_on_startup=false', '-c', 'tui.show_tooltips=false', '-c', 'notice.hide_rate_limit_model_nudge=true'],
				// The project's hooks would otherwise stop it at their review screen.
				yoloOn: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
				yoloOff: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
				model: ['--model', '${model}'],
				// A whole TOML string, so that an effort with a quote or a line break in it stays one.
				effort: ['-c', 'model_reasoning_effort=${effortToml}'],
				task: ['--', '${task}']
			},
			environment: {},
			// The whole table: in `projects.<folder>` the folder would be split at its dots.
			trust: { arguments: ['-c', 'projects={ ${folderToml} = { trust_level = "trusted" } }'] },
			enterDelay: 300,
			taskDelay: 2000
		}
	},
	task: 'argument',
	sandbox: { yoloOn: 'off', yoloOff: process.platform === 'win32' ? 'unavailable' : 'on' },
	exemption: 'precise',
	launch(input, executable) {
		const { connection } = input;
		return {
			executable,
			args: launchArgs(codexCli.setting + '.launch', input.config, {
				...launchValues(input),
				// The forms its `-c` arguments take: TOML values, and the folder as it keys its trust.
				...connection ? { mcpCommand: toml(connection.mcp.command), mcpArgs: toml(connection.mcp.args), mcpEnv: toml(connection.mcp.env) } : {},
				folderToml: toml(projectKey(input.folder)),
				...input.effort !== undefined ? { effortToml: toml(input.effort) } : {}
			}, launchUses(input)),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: connection ? input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) })) : []
		};
	}
};
