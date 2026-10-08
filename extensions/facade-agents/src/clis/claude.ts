/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { isJsonObject } from '../base/json';
import { AgentCli, Environment, launchArgs, skillMarkdown } from './cli';
import { homeOf } from './executable';

/** The plugin that carries Facade's skills into a launch. */
const PLUGIN = {
	name: 'facade',
	version: '1.0.0',
	description: 'How to work in Facade Code with other agents and the person.',
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

/** Whether Claude Code has a sandbox here: on macOS and Linux, not on Windows. */
const HAS_SANDBOX = process.platform !== 'win32';

/**
 * Claude Code in its own UI. YOLO on: every command and edit without asking, its sandbox off. YOLO off:
 * its sandbox on, asking before its own commands and edits as it asks the person outside Facade, but
 * never before a call of Facade's tools, which `--allowedTools` lets through by their server's name. The
 * person's own settings apply - their hooks, rules, plugins and MCP servers, Facade's server beside theirs -
 * and a deny of theirs wins over Facade's allow. Facade's skills and the settings that keep it from
 * stopping at a question nobody asked for come with the launch, in its run folder and its environment;
 * its question tool is taken away, so that an agent asks in words. Wherever an agent starts, the person's
 * trust in its repository goes into Claude Code's global configuration, as it writes it when they answer
 * its question.
 */
export const claudeCli: AgentCli = {
	id: 'claude',
	displayName: 'Claude Code',
	setting: 'facade.agents.claude',
	command: 'claude',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				connect: ['--mcp-config', '${mcpConfig}', '--plugin-dir', '${pluginDir}'],
				// Its settings for the launch: tips, emoji, the warning about skipped permissions, its sandbox.
				quiet: ['--settings', '${settingsFile}'],
				// It would leave its terminal waiting for someone to pick an answer.
				questions: ['--disallowedTools', 'AskUserQuestion'],
				yoloOn: ['--dangerously-skip-permissions'],
				// Every tool of Facade's server, by the server's name.
				yoloOff: ['--allowedTools', 'mcp__facade'],
				model: ['--model', '${model}'],
				effort: ['--effort', '${effort}'],
				// After the end of the options, so that a notice starting with a dash is not read as one.
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
			// Claude Code keys trust on the repository's root - for a worktree, its main checkout's.
			trust: { file: '${configFile}', merge: { projects: { '${repository}': { hasTrustDialogAccepted: true } } } },
			// Only what no variable does: a value of a kind it does not take makes it drop the whole file. Its
			// sandbox is set apart, by the agent's YOLO.
			settings: {
				// With YOLO on it would otherwise warn about skipped permissions at each launch.
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
	sandbox: { yoloOn: 'off', yoloOff: HAS_SANDBOX ? 'on' : 'unavailable' },
	exemption: 'precise',
	launch(input, executable) {
		const configFile = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsFile = path.join(input.runDir, `${input.slug}.settings.json`);
		const pluginDir = path.join(input.runDir, `${input.slug}.plugin`);
		const { connection } = input;
		const settings = input.config.launch.settings ?? {};
		// Its sandbox by the agent's YOLO, unless the person's launch says otherwise.
		const withSandbox = HAS_SANDBOX && !isJsonObject(settings.sandbox) ? { ...settings, sandbox: { enabled: !input.yolo } } : settings;
		return {
			executable,
			args: launchArgs(claudeCli.setting + '.launch', input.config, {
				mcpConfig: configFile,
				settingsFile,
				pluginDir,
				...input.model !== undefined ? { model: input.model } : {},
				...input.effort !== undefined ? { effort: input.effort } : {},
				...input.task !== undefined ? { task: input.task } : {},
				...connection?.values
			}, { framework: !!connection, yolo: input.yolo, model: input.model !== undefined, effort: input.effort !== undefined, task: input.task !== undefined, trust: true }),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [
				{ path: settingsFile, content: JSON.stringify(withSandbox, undefined, '\t') },
				...connection ? [
					{ path: configFile, content: JSON.stringify({ mcpServers: { facade: { type: 'stdio', command: connection.mcp.command, args: connection.mcp.args, env: connection.mcp.env } } }, undefined, '\t') },
					{ path: path.join(pluginDir, '.claude-plugin', 'plugin.json'), content: JSON.stringify(PLUGIN, undefined, '\t') },
					...input.skills.map(skill => ({ path: path.join(pluginDir, 'skills', skill.name, 'SKILL.md'), content: skillMarkdown(skill) }))
				] : []
			],
			injected: []
		};
	}
};
