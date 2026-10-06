/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { canonicalFolder, updateJsonFile } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import { FileLock } from '../base/lock';
import { AgentCli, Environment, skillMarkdown } from './cli';
import { homeOf } from './executable';

/** The plugin that carries Facade's skills into a launch. */
const PLUGIN = {
	name: 'facade',
	version: '1.0.0',
	description: 'How to work in Facade Code with your children and the person.',
	author: { name: 'Facade Code' }
};

/** How hard a model thinks: Sonnet at high and Opus at xhigh, by alias or full name; any other model at Claude Code's own default. */
function effortArgs(model: string): string[] {
	return /opus/i.test(model) ? ['--effort', 'xhigh'] : /sonnet/i.test(model) ? ['--effort', 'high'] : [];
}

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

/** What became of the trust: written, already there, or the file left alone - one that cannot be read, or is not as Claude Code writes it. */
export type ClaudeTrust = 'written' | 'there' | 'unreadable';

/**
 * Records the person's trust in a repository as Claude Code does when they answer its question:
 * `projects["<root>"].hasTrustDialogAccepted` in its global configuration, where its documentation
 * allows it to be set by hand. Claude Code keys trust on the repository's root - for a worktree, its main
 * checkout's - so one entry covers all of the repository's worktrees. The rest of the file is kept, and
 * its layout too; a file that is not a JSON object is left alone. Claude Code writes the file too: it
 * locks it at the path `lock` does - `<file>.lock`, a folder of its own - so that the two take turns,
 * and what it writes all the same between the read and the write is read again, and kept.
 */
export function trustClaudeProject(root: string, lock: FileLock, configFile: string): ClaudeTrust {
	return lock(configFile, () => updateJsonFile(configFile, (file): { readonly outcome: ClaudeTrust; readonly write?: JsonObject } => {
		if (file.kind === 'other') {
			return { outcome: 'unreadable' };
		}
		const config = file.kind === 'object' ? file.value : {};
		const projects = config.projects ?? {};
		const key = claudeProjectKey(root);
		const project = isJsonObject(projects) ? projects[key] ?? {} : undefined;
		if (!isJsonObject(projects) || !isJsonObject(project)) {
			return { outcome: 'unreadable' };
		}
		if (project.hasTrustDialogAccepted === true) {
			return { outcome: 'there' };
		}
		return { outcome: 'written', write: { ...config, projects: { ...projects, [key]: { ...project, hasTrustDialogAccepted: true } } } };
	}));
}

/**
 * Claude Code in its own UI at full access: every command and edit without asking, outside any
 * sandbox. The person's own settings apply - their hooks, rules and plugins - but not their MCP
 * servers: `--strict-mcp-config` loads Facade's alone. Facade's skills and the settings that keep it
 * from stopping at a question come with the launch, in its run folder and its environment.
 */
export const claudeCli: AgentCli = {
	id: 'claude',
	displayName: 'Claude Code',
	command: 'claude',
	models: ['sonnet', 'opus', 'haiku'],
	trust: {
		write: ({ repository }, lock, env) => {
			const file = claudeConfigFile(env);
			switch (trustClaudeProject(repository, lock, file)) {
				case 'written': return `Claude Code trusts the repository ${repository} now, in ${file}.`;
				case 'there': return `Claude Code trusted the repository ${repository} already.`;
				case 'unreadable': return `${file} could not be read, or is not as Claude Code writes it, and was left alone: Claude Code will ask whether to trust ${repository}.`;
			}
		}
	},
	fullAccess: () => l10n.t("Claude Code will run every command and make every edit without asking you, outside any sandbox: it can do whatever you can on this computer. Facade starts it with {0} and tells each launch that you agreed here, so Claude Code does not warn you again. In the worktrees Facade makes, Facade also tells Claude Code that you trust the repository they belong to: Claude Code keeps that trust for the whole repository, its main checkout included, in its own configuration ({1}).", '--dangerously-skip-permissions', claudeConfigFile()),
	task: 'argument',
	enterDelayMs: 300,
	launch(input, executable) {
		const configFile = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsFile = path.join(input.runDir, `${input.slug}.settings.json`);
		const pluginDir = path.join(input.runDir, `${input.slug}.plugin`);
		const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
		const settings = {
			// The person agreed to full access in Facade's question.
			skipDangerousModePermissionPrompt: true,
			// What it would show in or over its input box, or ask with a key, while nobody may be there.
			promptSuggestionEnabled: false,
			spinnerTipsEnabled: false,
			feedbackSurveyRate: 0,
			awaySummaryEnabled: false,
			emojiCompletionEnabled: false
		};
		return {
			executable,
			args: [
				'--mcp-config', configFile,
				'--strict-mcp-config',
				'--settings', settingsFile,
				'--plugin-dir', pluginDir,
				'--dangerously-skip-permissions',
				'--model', input.model,
				...effortArgs(input.model),
				// After the end of the options, so that a task starting with a dash is not read as one.
				...(input.prompt ? ['--', input.prompt] : [])
			],
			env: {
				// These outrank the settings of the person's own files and environment.
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
			cwd: input.folder,
			files: [
				{ path: configFile, content: JSON.stringify(config, undefined, '\t') },
				{ path: settingsFile, content: JSON.stringify(settings, undefined, '\t') },
				{ path: path.join(pluginDir, '.claude-plugin', 'plugin.json'), content: JSON.stringify(PLUGIN, undefined, '\t') },
				...input.skills.map(skill => ({ path: path.join(pluginDir, 'skills', skill.name, 'SKILL.md'), content: skillMarkdown(skill) }))
			],
			injected: []
		};
	}
};
