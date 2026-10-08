/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { AgentCli, Environment, launchArgs, skillMarkdown } from './cli';
import { homeOf } from './executable';

/** The plugin that carries Facade's skills into a launch. */
const PLUGIN = {
	name: 'facade',
	version: '1.0.0',
	description: 'How to work in Facade Code with your children and the person.',
	author: { name: 'Facade Code' }
};

/**
 * The file Claude Code keeps its global configuration in, found as Claude Code finds it: `.config.json`
 * in its folder - `CLAUDE_CONFIG_DIR`, else `~/.claude` - where an older version left one there, else
 * `.claude.json` in `CLAUDE_CONFIG_DIR`, else in the home folder.
 */
export function claudeConfigFile(env: Environment = process.env): string {
	const legacy = path.join(env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude'), '.config.json');
	return fs.existsSync(legacy) ? legacy : path.join(env.CLAUDE_CONFIG_DIR || homeOf(env), '.claude.json');
}

/** A folder as Claude Code names a project in its configuration: its real path, with forward slashes and an upper-case drive on Windows. */
function claudeProjectKey(folder: string): string {
	const real = canonicalFolder(folder);
	if (process.platform !== 'win32') {
		return real;
	}
	return real.split(path.win32.sep).join('/').replace(/^(?<drive>[a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

/**
 * Claude Code in its own UI at full access: every command and edit without asking, outside any
 * sandbox. The person's own settings apply - their hooks, rules and plugins - but not their MCP
 * servers: `--strict-mcp-config` loads Facade's alone. Facade's skills and the settings that keep it
 * from stopping at a question come with the launch, in its run folder and its environment. In a worktree
 * Facade made, the person's trust goes into its global configuration, as Claude Code writes it when they
 * answer its question - where its documentation allows it to be set by hand.
 */
export const claudeCli: AgentCli = {
	id: 'claude',
	displayName: 'Claude Code',
	section: 'claude',
	command: 'claude',
	defaults: {
		path: '',
		launch: {
			arguments: {
				connect: ['--mcp-config', '${mcpConfig}', '--strict-mcp-config', '--settings', '${settingsFile}', '--plugin-dir', '${pluginDir}'],
				// A question asked with buttons waits in its terminal for someone to click, where a doorbell's Enter
				// would answer it: every agent asks in plain text, or by message.
				questions: ['--disallowedTools', 'AskUserQuestion'],
				// Each takes one or more values: what follows them is another option.
				messages: ['--add-dir', '${messagesDir}'],
				fullAccess: ['--dangerously-skip-permissions'],
				model: ['--model', '${model}'],
				effort: ['--effort', '${effort}'],
				// After the end of the options, so that a task starting with a dash is not read as one.
				task: ['--', '${task}']
			},
			environment: {
				// What it would show in or over its input box, or ask with a key, while nobody may be there.
				// Variables outrank the settings of the person's own files and environment, and one that a
				// version no longer knows leaves the others as they are.
				CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
				CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
				CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
				// One version for the agent's whole run.
				DISABLE_AUTOUPDATER: '1',
				// In the window's terminal it would connect to an IDE extension, and install one, and send the
				// person's selection with the agent's prompts.
				CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
				CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1'
			},
			// Claude Code keys trust on the repository's root - for a worktree, its main checkout's - so one
			// entry covers all of the repository's worktrees.
			trust: { file: '${configFile}', merge: { projects: { '${repository}': { hasTrustDialogAccepted: true } } } },
			// Only what no variable does: a value of a kind it does not take makes it drop the whole file.
			settings: {
				// Facade starts it at full access, which it would otherwise warn about at each launch.
				skipDangerousModePermissionPrompt: true,
				spinnerTipsEnabled: false,
				emojiCompletionEnabled: false
			},
			enterDelay: 300,
			taskDelay: 2000
		}
	},
	trustValues: ({ repository }, env) => ({ configFile: claudeConfigFile(env), repository: claudeProjectKey(repository) }),
	task: 'argument',
	launch(input, executable) {
		const configFile = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsFile = path.join(input.runDir, `${input.slug}.settings.json`);
		const pluginDir = path.join(input.runDir, `${input.slug}.plugin`);
		const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
		return {
			executable,
			args: launchArgs(claudeCli, input.config, {
				mcpConfig: configFile,
				settingsFile,
				pluginDir,
				messagesDir: input.messagesDir,
				model: input.model,
				effort: input.effort,
				task: input.prompt ?? ''
			}, { trust: input.trusted, task: !!input.prompt }),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [
				{ path: configFile, content: JSON.stringify(config, undefined, '\t') },
				{ path: settingsFile, content: JSON.stringify(input.config.launch.settings ?? {}, undefined, '\t') },
				{ path: path.join(pluginDir, '.claude-plugin', 'plugin.json'), content: JSON.stringify(PLUGIN, undefined, '\t') },
				...input.skills.map(skill => ({ path: path.join(pluginDir, 'skills', skill.name, 'SKILL.md'), content: skillMarkdown(skill) }))
			],
			injected: []
		};
	}
};
