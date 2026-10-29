/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { AgentCli, launchArgs, launchUses, launchValues, skillMarkdown } from './cli';

/** Where Facade's plugin goes in a folder: Antigravity finds plugins under `.agents/plugins/`. */
const PLUGIN_DIR = '.agents/plugins/facade';

/**
 * Antigravity's CLI in its own UI. YOLO on: every command without asking, edits accepted. YOLO off: it
 * has no way to let Facade's server alone through unasked, so it asks for nothing either - edits accepted
 * too (AGENT-LAUNCHER.md, L4, rule 3; X-42); it has no sandbox of its own. It reads MCP servers only from
 * its global configuration or a plugin, so Facade's server and skills go into the folder as a plugin,
 * which every agent there shares: the server finds the agent from its environment. Through `start_agent`
 * its background update is turned off for the launch, and its warm-up tells it who it is and to ask
 * through Facade's messages - its opening, `${opening}` (AGENT-LAUNCHER.md, L4, L9; N-71). Wherever an
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
				// without them, and the next one has them. Its first line, typed by its doorbell once Facade's
				// server said hello, waits behind this one and is that next conversation (AGENT-MESSAGES.md, M7).
				warmUp: ['-i', 'Reply only with ready.'],
				// The files of its messages and of agents' screens, outside its folder: else it asks whether to read
				// one there, and the next doorbell's Enter would answer for the person. One folder an option.
				messages: ['--add-dir', '${messagesDir}', '--add-dir', '${screensDir}'],
				yoloOn: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
				yoloOff: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
				// A model's base name, as `gemini-3.8-flash`, which `--effort` picks a variant of. One it does not
				// have it puts aside for its own default, and its effort with it, without a word.
				model: ['--model', '${model}'],
				effort: ['--effort', '${effort}']
			},
			environment: {},
			// It trusts exact folders, so each worktree needs an entry of its own.
			trust: { file: '${home}/.gemini/antigravity-cli/settings.json', merge: { trustedWorkspaces: ['${folder}'] } },
			// It takes a fast burst of keys for a paste.
			enterDelay: 400,
			taskDelay: 2000,
			unattended: {
				arguments: {
					// Its first conversation tells it what it must not do while nobody may be watching: no tool of its
					// takes its question tool away, and its model may not be given its server's instructions (L4; N-71)
					warmUp: ['-i', 'Reply only with ready. Your terminal may be unattended. ${opening}']
				},
				// Only the literal true turns its background update off.
				environment: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
			}
		}
	},
	// The folder as its agent starts in it, not its real path: Antigravity takes its workspace from its working
	// directory as the terminal names it (PWD) - a folder opened through a link is the link to it - and trusts exact
	// folders (N-85)
	trustValues: ({ folder }) => ({ folder: path.resolve(folder) }),
	sharedServer: true,
	// A model's name may carry an effort - its --model gemini-3.8-flash-high runs High whatever --effort says (AS-13) - so an
	// effort given with a model, passed on as every value is, is not known to be the one it runs at (OR-01)
	modelCarriesEffort: true,
	task: 'terminal',
	sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' },
	exemption: 'all',
	// No setting or argument of its takes its question tool away (YO-07)
	questionTool: 'kept',
	verified: '1.3.2',
	launch(input, executable) {
		const { connection } = input;
		return {
			executable,
			// Its first line is typed into its terminal by its doorbell, never given as an argument (M7).
			args: launchArgs(antigravityCli.setting + '.launch', input.config, launchValues(input), launchUses(input, false)),
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
