/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { AgentCli, HookEvent } from './cli';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The plugin that carries Facade's skills into a Claude launch (WORKTREE-AGENTS.md, WA-12.5). */
const PLUGIN = {
	name: 'facade',
	version: '1.0.0',
	description: 'How to work in Facade Code with your parent, your children and the person.',
	author: { name: 'Facade Code' }
};

/**
 * Claude Code in its own interactive UI: file edits and shell commands without asking, Facade's tools
 * allowed. `--strict-mcp-config` and `--setting-sources project,local` keep the user's own servers,
 * plugins and hooks out of it; the repository's own settings still apply. Its hooks and Facade's
 * skills come with each launch: `--settings` and `--plugin-dir`, files of its run.
 */
export const claudeCli: AgentCli = {
	id: 'claude',
	displayName: 'Claude Code',
	command: 'claude',
	models: ['sonnet', 'opus', 'haiku'],
	firstRun: {
		question: /Is this a project you created or one you trust|Do you trust the files in this folder/,
		answer: /Yes, (?:I trust this folder|proceed)/,
		// Claude's U+276F, Codex's U+203A, or a plain >
		cursor: /^\s*[\u276f\u203a>]\s/
	},
	launch(input, executable) {
		const configPath = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsPath = path.join(input.runDir, `${input.slug}.settings.json`);
		const pluginDir = path.join(input.runDir, `${input.slug}.plugin`);
		const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
		const hook = (event: string) => [{ type: 'command', command: `${input.hookCommand} event:${event}`, timeout: 30 }];
		const settings = {
			hooks: {
				SessionStart: [{ hooks: hook('start') }],
				UserPromptSubmit: [{ hooks: hook('prompt') }],
				Stop: [{ hooks: hook('stop') }],
				Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: hook('notification') }]
			}
		};
		return {
			executable,
			args: [
				// The prompt goes first: the list of tools after it would otherwise swallow it.
				...(input.prompt ? [input.prompt] : []),
				'--mcp-config', configPath,
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--settings', settingsPath,
				'--plugin-dir', pluginDir,
				'--permission-mode', 'acceptEdits',
				'--allowedTools', 'mcp__facade', 'Bash', 'PowerShell',
				'--model', input.model
			],
			env: {},
			cwd: input.folder,
			files: [
				{ path: configPath, content: JSON.stringify(config, undefined, '\t') },
				{ path: settingsPath, content: JSON.stringify(settings, undefined, '\t') },
				{ path: path.join(pluginDir, '.claude-plugin', 'plugin.json'), content: JSON.stringify(PLUGIN, undefined, '\t') },
				...input.skills.map(skill => ({
					path: path.join(pluginDir, 'skills', skill.name, 'SKILL.md'),
					content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`
				}))
			]
		};
	},
	readHook(event, payload): HookEvent | undefined {
		const given = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
		switch (event) {
			case 'start':
				return { kind: 'start' };
			case 'prompt':
				return { kind: 'prompt' };
			case 'stop':
				return { kind: 'stop', continuing: given.stop_hook_active === true };
			case 'notification': {
				const message = typeof given.message === 'string' && given.message ? given.message : undefined;
				switch (given.notification_type) {
					case 'idle_prompt':
						return { kind: 'idle' };
					case 'permission_prompt':
						return { kind: 'waiting', what: message ?? 'a permission prompt' };
					case 'elicitation_dialog':
						return { kind: 'waiting', what: message ?? 'a question' };
				}
				return undefined;
			}
		}
		return undefined;
	},
	openWith(text) {
		return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
	},
	continueWith(messages) {
		return JSON.stringify({ decision: 'block', reason: messages });
	},
	typing(text) {
		// Claude follows a pasted text only with a typed request ahead of it (WA-6.4): the first line is
		// typed, the rest pasted, in bracketed-paste mode so that its line breaks do not submit it.
		const [first, ...rest] = text.split('\n');
		return rest.length ? [first, `${PASTE_START}\n${rest.join('\n')}${PASTE_END}`] : [first];
	}
};
