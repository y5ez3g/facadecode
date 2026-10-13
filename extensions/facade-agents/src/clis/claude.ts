/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import { AgentCli, CliConfig, Environment, launchArgs, launchUses, launchValues, skillMarkdown } from './cli';
import { HOME_VARIABLE, homeOf } from './executable';

/** The plugin that carries Facade's skills into a launch. */
const PLUGIN = {
	name: 'facade',
	version: '1.0.0',
	description: 'How to work in Facade Code with other agents and the person.',
	author: { name: 'Facade Code' }
};

/** Claude Code's own folder in the environment `env`: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
function claudeConfigDir(env: Environment): string {
	return env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude');
}

/**
 * The files Claude Code reads its settings from in the environment `env`: the person's own, then - for a project in
 * `folder` - the project's and their local ones of the project.
 */
function claudeSettingsFiles(env: Environment, folder: string | undefined): string[] {
	return [
		path.join(claudeConfigDir(env), 'settings.json'),
		...folder === undefined ? [] : [path.join(folder, '.claude', 'settings.json'), path.join(folder, '.claude', 'settings.local.json')]
	];
}

/** What the JSON file `file` holds; undefined where it is not there, or holds no JSON. */
function jsonIn(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Where a deny rule of Claude Code's settings takes Facade's tools - a deny wins over Facade's `--allowedTools`,
 * so with YOLO off it asks for them all the same (AGENT-LAUNCHER.md, L4): the settings of its launch, which the
 * run's settings file has, then the person's own and the project's in `folder`. Which, and the rule; else undefined.
 */
export function claudeDenyOf(config: CliConfig, env: Environment, folder: string | undefined): { readonly where: string; readonly rule: string } | undefined {
	const inLaunch = denyRule(config.launch.settings);
	if (inLaunch !== undefined) {
		return { where: `${claudeCli.setting}.launch.settings`, rule: inLaunch };
	}
	for (const file of claudeSettingsFiles(env, folder)) {
		const rule = denyRule(jsonIn(file));
		if (rule !== undefined) {
			return { where: file, rule };
		}
	}
	return undefined;
}

/** The rule of Claude Code's `settings` that denies Facade's tools, all or one of them; undefined for none. */
function denyRule(settings: unknown): string | undefined {
	const deny = isJsonObject(settings) && isJsonObject(settings.permissions) ? settings.permissions.deny : undefined;
	const rule = Array.isArray(deny) ? deny.find(each => typeof each === 'string' && /^mcp__facade(?:__|$)/.test(each)) : undefined;
	return typeof rule === 'string' ? rule : undefined;
}

/**
 * The file Claude Code keeps its global configuration in, found as Claude Code finds it: `.config.json`
 * in its folder - `CLAUDE_CONFIG_DIR`, else `~/.claude` - where an older version left one there, else
 * `.claude.json` in `CLAUDE_CONFIG_DIR`, else in the home folder.
 */
export function claudeConfigFile(env: Environment = process.env): string {
	const legacy = path.join(claudeConfigDir(env), '.config.json');
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
 * The servers of the MCP configuration of the project in `folder` - its `.mcp.json`, and those of the folders above it,
 * which Claude Code reads too - that the person has not approved for its project, Facade's own entry excepted: those it
 * stops to ask about as it starts, "New MCP server found in this project". Approved by `enabledMcpjsonServers`, or all of
 * them by `enableAllProjectMcpServers`: in `settings`, its launch's; in the person's own settings, the project's and their
 * local ones of the project; or in Claude Code's configuration for the project - the folder's, or its repository's, the
 * file its trust goes into - in the environment `env`.
 */
function unapprovedProjectServers(folder: string, repository: string, settings: JsonObject | undefined, env: Environment): string[] {
	const servers = new Set<string>();
	for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
		const config = jsonIn(path.join(dir, '.mcp.json'));
		if (isJsonObject(config) && isJsonObject(config.mcpServers)) {
			Object.keys(config.mcpServers).forEach(name => servers.add(name));
		}
		if (path.dirname(dir) === dir) {
			break;
		}
	}
	// Given Facade's server by its own config, this launch turns that entry off anyway (N-69)
	servers.delete('facade');
	if (!servers.size) {
		return [];
	}
	const global = jsonIn(claudeConfigFile(env));
	const projects = isJsonObject(global) && isJsonObject(global.projects) ? global.projects : {};
	const approvals = [
		settings,
		...claudeSettingsFiles(env, folder).map(jsonIn),
		...[folder, repository].map(each => projects[claudeProjectKey(each)])
	].filter(isJsonObject);
	if (approvals.some(each => each.enableAllProjectMcpServers === true)) {
		return [];
	}
	const approved = new Set(approvals.flatMap(each => Array.isArray(each.enabledMcpjsonServers) ? each.enabledMcpjsonServers : []));
	return [...servers].filter(name => !approved.has(name));
}

/**
 * The servers of the folder's project MCP configuration a launch of Claude Code turns off for its run (AGENT-LAUNCHER.md,
 * L4, rule 3; LV-02): with YOLO off, for an agent started through `start_agent`, where nobody may be watching, those the
 * person has not approved for the project, so that it neither waits at its question about them nor runs one nobody
 * reviewed. One the person starts asks about them as Claude Code does, and with YOLO on it asks nothing. In the
 * environment its launch's own files are found in: Facade's, with its home as its terminal has it, `home`, and the
 * variables of its launch, `config`, over it.
 */
function projectServersTurnedOff(config: CliConfig, place: { readonly folder: string; readonly repository: string }, home: string | undefined, yolo: boolean, unattended: boolean): string[] {
	if (yolo || !unattended) {
		return [];
	}
	const env: Environment = { ...process.env, ...home !== undefined ? { [HOME_VARIABLE]: home } : {}, ...config.launch.environment };
	return unapprovedProjectServers(place.folder, place.repository, config.launch.settings, env);
}

/** Whether Claude Code has a sandbox here: on macOS and Linux, not on Windows. */
const HAS_SANDBOX = process.platform !== 'win32';

/**
 * Claude Code in its own UI. YOLO on: every command and edit without asking, its sandbox off. YOLO off: its
 * sandbox on, and Facade's tools never asked for - `--allowedTools` lets them through by their server's name. The
 * person's own agent asks them as Claude Code does, in the permission mode they set it to, leaving its sandbox
 * included; one started through `start_agent`, where nobody may be watching, is refused unasked whatever would
 * ask - its edits in its folder let through - its sandbox has no way out, its question tool is taken away, so that
 * it asks through Facade messages, and what would show in its input box, survey the person or update it is off, in
 * its environment and its settings (AGENT-LAUNCHER.md, L4). The person's own settings apply - their hooks, rules,
 * plugins and MCP servers, Facade's server beside theirs - and a deny of theirs wins over Facade's allow; with YOLO
 * off, one started through `start_agent` runs without the project's MCP servers they have not approved for it,
 * which Claude Code would stop to ask about (rule 3; LV-02). Facade's skills come with the launch, in its run
 * folder. Wherever an agent starts, the person's trust in its repository goes into Claude Code's global
 * configuration, as it writes it when they answer its question.
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
				// Its settings for the launch: its sandbox and the warning about skipped permissions, by the agent's YOLO.
				quiet: ['--settings', '${settingsFile}'],
				// The files of its messages and of agents' screens are outside its folder, where it would ask before
				// reading them with YOLO off. The option takes one or more folders: what follows it is another option.
				messages: ['--add-dir', '${messagesDir}', '${screensDir}'],
				yoloOn: ['--dangerously-skip-permissions'],
				// Every tool of Facade's server by the server's name, and nothing more: anything else asks the person as
				// Claude Code does, in their own permission mode, a command run outside its sandbox included (L4; N-70)
				yoloOff: ['--allowedTools', 'mcp__facade'],
				model: ['--model', '${model}'],
				effort: ['--effort', '${effort}'],
				// After the end of the options, so that a notice starting with a dash is not read as one.
				task: ['--', '${task}']
			},
			environment: {},
			// Claude Code keys trust on the repository's root - for a worktree, its main checkout's.
			trust: { file: '${configFile}', merge: { projects: { '${repository}': { hasTrustDialogAccepted: true } } } },
			// Only what no variable does: a value of a kind it does not take makes it drop the whole file. Its
			// sandbox, and the warning about skipped permissions, are set apart, by the agent's YOLO.
			settings: {
				// The folder's `.mcp.json` entry of Facade's own - put there for another CLI's agent - is no server of
				// the person's to be asked about: this launch is given Facade's server by its own config (N-69)
				disabledMcpjsonServers: ['facade']
			},
			enterDelay: 300,
			taskDelay: 2000,
			unattended: {
				arguments: {
					// It would leave its terminal waiting for someone to pick an answer.
					questions: ['--disallowedTools', 'AskUserQuestion'],
					// What would ask is refused unasked: its edits in its folder, and Facade's tools, go through.
					yoloOff: ['--permission-mode', 'dontAsk', '--allowedTools', 'mcp__facade', 'Edit(./**)']
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
				settings: {
					spinnerTipsEnabled: false,
					emojiCompletionEnabled: false
				}
			}
		}
	},
	trustValues: ({ folder, repository }, env) => ({ configFile: claudeConfigFile(env), folder: claudeProjectKey(folder), repository: claudeProjectKey(repository) }),
	exemptionOverride: (config, env, folder) => {
		const deny = claudeDenyOf(config, env, folder);
		return deny && `${deny.where} denies ${deny.rule}, which wins over Facade's allow`;
	},
	projectServersOff: projectServersTurnedOff,
	task: 'argument',
	sandbox: { yoloOn: 'off', yoloOff: HAS_SANDBOX ? 'on' : 'unavailable' },
	// Its sandbox is a setting of the launch's settings file
	sandboxIn: 'settingsFile',
	exemption: 'precise',
	questionTool: 'removed',
	verified: '2.1.296',
	launch(input, executable) {
		const configFile = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsFile = path.join(input.runDir, `${input.slug}.settings.json`);
		const pluginDir = path.join(input.runDir, `${input.slug}.plugin`);
		const { connection } = input;
		const settings = input.config.launch.settings ?? {};
		// The project's MCP servers nobody approved, with YOLO off through start_agent: turned off for the run beside those
		// its launch turns off, so that it does not wait at Claude Code's question about them (L4, rule 3; LV-02)
		const serversOff = projectServersTurnedOff(input.config, input, input.home, input.yolo, input.unattended);
		const withSandbox = {
			...settings,
			...serversOff.length ? { disabledMcpjsonServers: [...new Set([...Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers : [], ...serversOff])] } : {},
			// Its sandbox by the agent's YOLO - with YOLO off, for an agent started through start_agent, with no way out:
			// a command run outside it would ask (L4, rule 2; N-70) - merged under a sandbox setting of the person's
			// launch, whose own keys win, said where they decide it (rule 4)
			...HAS_SANDBOX ? { sandbox: { enabled: !input.yolo, ...input.unattended && !input.yolo ? { allowUnsandboxedCommands: false } : {}, ...isJsonObject(settings.sandbox) ? settings.sandbox : {} } } : {},
			// With YOLO on it would warn about skipped permissions at each launch, and wait for a key
			...input.yolo && !Object.hasOwn(settings, 'skipDangerousModePermissionPrompt') ? { skipDangerousModePermissionPrompt: true } : {}
		};
		return {
			executable,
			args: launchArgs(claudeCli.setting + '.launch', input.config, { ...launchValues(input), mcpConfig: configFile, settingsFile, pluginDir }, launchUses(input)),
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
