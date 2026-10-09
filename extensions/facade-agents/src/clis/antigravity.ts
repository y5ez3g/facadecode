/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalFolder } from '../base/files';
import { AgentCli, launchArgs, skillMarkdown } from './cli';

/** Where Facade's plugin goes in a folder: Antigravity finds plugins under `.agents/plugins/`. */
const PLUGIN_DIR = '.agents/plugins/facade';

/**
 * Antigravity's CLI in its own UI, running every command without asking. It reads MCP servers only from
 * its global configuration or a plugin, so Facade's server and skills go into the folder as a plugin,
 * which every agent there shares: the server finds the agent from its environment. Its background update
 * is turned off for the launch. In a worktree Facade made, the person's trust goes into the
 * `trustedWorkspaces` of its settings, as Antigravity writes it when they answer its question.
 */
export const antigravityCli: AgentCli = {
	id: 'agy',
	displayName: 'Antigravity',
	section: 'antigravity',
	command: 'agy',
	defaults: {
		path: '',
		launch: {
			arguments: {
				// Its first conversation, during which it connects its MCP servers; that conversation goes on
				// without them, and the next one has them. Its first line, typed once Facade's server said
				// hello, waits behind this one and is that next conversation.
				warmUp: ['-i', 'Reply with the single word ready, and nothing else.'],
				// The record's folder of long messages, in its workspace: else it asks whether to read a file there
				// One folder a flag
				messages: ['--add-dir', '${messagesDir}', '--add-dir', '${screensDir}'],
				fullAccess: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
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
	launch(input, executable) {
		return {
			executable,
			// Its first line is typed into its terminal, never given as an argument.
			args: launchArgs(antigravityCli, input.config, { messagesDir: input.messagesDir, screensDir: input.screensDir, model: input.model, effort: input.effort }, { trust: input.trusted, task: false }),
			env: input.config.launch.environment,
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
