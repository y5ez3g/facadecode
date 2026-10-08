/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalFolder } from '../base/files';
import { AgentCli, launchArgs, skillMarkdown } from './cli';

/** Where Facade's plugin goes in a folder: Antigravity finds plugins under `.agents/plugins/`. */
const PLUGIN_DIR = '.agents/plugins/facade';

/**
 * Antigravity's CLI in its own UI. YOLO on: every command without asking, edits accepted. YOLO off: it
 * has no way to let Facade's server alone through unasked, so it asks for nothing (AGENT-LAUNCHER.md, L4);
 * it has no sandbox of its own. It reads MCP servers only from its global configuration or a plugin, so
 * Facade's server and skills go into the folder as a plugin, which every agent there shares: the server
 * finds the agent from its environment. Its background update is turned off for the launch. Wherever an
 * agent starts, the person's trust in its folder goes into the `trustedWorkspaces` of its settings, as
 * Antigravity writes it when they answer its question. With the agent framework on it always has its
 * warm-up turn, with no task too: its MCP servers connect only after its first turn.
 */
export const antigravityCli: AgentCli = {
	id: 'agy',
	displayName: 'Antigravity',
	setting: 'facade.agents.antigravity',
	command: 'agy',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				// Its first conversation, during which it connects its MCP servers; that conversation goes on
				// without them, and the next one has them. The notice of its task, typed once Facade's server
				// said hello, waits behind this one and is that next conversation.
				warmUp: ['-i', 'Reply with the single word ready, and nothing else.'],
				yoloOn: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
				yoloOff: ['--dangerously-skip-permissions'],
				// A model's base name, as `gemini-3.8-flash`, which `--effort` picks a variant of. One it does not
				// have it puts aside for its own default, and its effort with it, without a word.
				model: ['--model', '${model}'],
				effort: ['--effort', '${effort}']
			},
			// Only the literal true turns its background update off.
			environment: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
			// It trusts exact folders, so each worktree needs an entry of its own.
			trust: { file: '${home}/.gemini/antigravity-cli/settings.json', merge: { trustedWorkspaces: ['${folder}'] } },
			// It takes a fast burst of keys for a paste.
			enterDelay: 400,
			taskDelay: 2000
		}
	},
	trustValues: ({ folder }) => ({ folder: canonicalFolder(folder) }),
	sharedServer: true,
	task: 'terminal',
	sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' },
	exemption: 'all',
	launch(input, executable) {
		const { connection } = input;
		return {
			executable,
			// The notice of its task is typed into its terminal, never given as an argument.
			args: launchArgs(antigravityCli.setting + '.launch', input.config, {
				...input.model !== undefined ? { model: input.model } : {},
				...input.effort !== undefined ? { effort: input.effort } : {},
				...connection?.values
			}, { framework: !!connection, yolo: input.yolo, model: input.model !== undefined, effort: input.effort !== undefined, task: false, trust: true }),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: connection ? [
				{ path: `${PLUGIN_DIR}/plugin.json`, content: JSON.stringify({ name: 'facade' }, undefined, '\t') },
				{ path: `${PLUGIN_DIR}/mcp_config.json`, content: JSON.stringify({ mcpServers: { facade: { command: connection.mcp.command, args: connection.mcp.args, env: connection.mcp.env } } }, undefined, '\t') },
				...input.skills.map(skill => ({ path: `${PLUGIN_DIR}/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
			] : []
		};
	}
};
