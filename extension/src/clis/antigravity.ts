/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import { nodeValue, parseJsonc } from '../base/jsonc';
import { CliAdapter, sigintExit } from './adapter';
import { Environment, variableOf } from './environment';
import { homeOf } from './executable';
import { mcpConfigText, pluginManifest, SERVER_NAME, sharedServer, SKILL_FILE, ToolsIntegration } from './tools';
import type { TrustTarget } from './trust';

/** The file Antigravity's CLI keeps its settings in, the folders it trusts among them, in the home folder of the environment `env`. */
export function antigravitySettingsFile(env: Environment, platform: NodeJS.Platform): string {
	return path.join(homeOf(env, platform), '.gemini', 'antigravity-cli', 'settings.json');
}

/** The plugin Antigravity is given in the folder: it reads plugins from `.agents/plugins/` (CLIS-2.2). */
const PLUGIN = path.join('.agents', 'plugins', SERVER_NAME);

/** The server as Antigravity names a plugin's server, `<plugin>_<server>`: in its permission rules and its MCP panel. */
const PLUGIN_SERVER = `${SERVER_NAME}_${SERVER_NAME}`;

/** The permission rule that lets every tool of the server run without asking (CLIS-1.3). */
const ALLOW_TOOLS = `mcp(${PLUGIN_SERVER}/*)`;

/**
 * Antigravity is given the server and the skill as a plugin in the folder, `.agents/plugins/facade`, shared by the folder's runs:
 * its manifest, its `mcp_config.json` and its skill (CLIS-2.2). It reads MCP servers only from its own configuration or a plugin. A
 * shared entry holds no run's identity, so the run's variables reach the server it starts through its environment.
 */
const antigravityTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'a plugin in the folder\'s .agents/plugins/facade with its mcp_config.json and the skill, shared by the folder\'s runs, the server given the run\'s variables through the CLI\'s environment; its tools allowed for the session by --settings, and started before the first turn through its MCP panel' },
	where: (_runDir, cwd) => `the plugin ${path.join(cwd, PLUGIN)}, shared by the runs there, with the run's variables in its environment`,
	inject: ({ server, skill }) => {
		const shared = sharedServer(server);
		return {
			values: {},
			runFiles: [],
			project: [
				{ kind: 'file', path: path.join(PLUGIN, 'plugin.json'), content: `${JSON.stringify(pluginManifest(), undefined, 2)}\n` },
				{ kind: 'file', path: path.join(PLUGIN, 'mcp_config.json'), content: mcpConfigText(shared.server) },
				{ kind: 'file', path: path.join(PLUGIN, SKILL_FILE), content: skill }
			],
			env: shared.env
		};
	}
};

/**
 * The permission rules of the person's Antigravity settings in the environment `env`, with Facade's tools allowed: `--settings`
 * replaces a key of the settings whole for its session, so the rules the person keeps there go with it unchanged (CLIS-1.3).
 * Settings it cannot read give the rule alone, as Antigravity itself would have none of theirs.
 */
export function antigravityPermissions(env: Environment | undefined, platform: NodeJS.Platform): JsonObject {
	let theirs: unknown;
	try {
		theirs = env && nodeValue(parseJsonc(fs.readFileSync(antigravitySettingsFile(env, platform), 'utf8')));
	} catch {
		theirs = undefined;
	}
	const permissions = isJsonObject(theirs) && isJsonObject(theirs.permissions) ? theirs.permissions : {};
	const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
	return { ...permissions, allow: allow.includes(ALLOW_TOOLS) ? allow : [...allow, ALLOW_TOOLS] };
}

/**
 * The folder a run of Antigravity, a Go program, takes for its working directory when started in `cwd` with the environment `env`:
 * on Windows `cwd` as it is given; elsewhere the `PWD` its environment carries where that names the same folder, else the real path
 * the system gives.
 */
function workingDirectoryOf(cwd: string, env: Environment, platform: NodeJS.Platform): string {
	const folder = path.resolve(cwd);
	if (platform === 'win32') {
		return folder;
	}
	const pwd = variableOf(env, 'PWD', platform);
	try {
		if (pwd !== undefined && path.isAbsolute(pwd)) {
			const [named, actual] = [fs.statSync(pwd), fs.statSync(folder)];
			if (named.ino === actual.ino && named.dev === actual.dev) {
				return pwd;
			}
		}
	} catch {
		// Its PWD names nothing there
	}
	return canonicalFolder(folder);
}

/**
 * Antigravity's CLI in its own UI (CLIS-1.3). YOLO on: edits accepted and permissions bypassed, `--mode accept-edits
 * --dangerously-skip-permissions`. YOLO off: its approvals its own. It has no sandbox of its own. Every launch trusts the folder it
 * starts in as accepting its trust question does: the folder an item of the `trustedWorkspaces` of its settings, which trust exact
 * folders, so a worktree has its own (CLIS-3.3, D62).
 */
export const antigravityAdapter: CliAdapter = {
	id: 'agy',
	sessionIdentity: true,
	sessionIntegration: ({ hook, env, platform, cwd, extra, tools }) => {
		const settingsFile = antigravitySettingsFile(env, platform);
		let native;
		try { native = fs.existsSync(settingsFile) ? nodeValue(parseJsonc(fs.readFileSync(settingsFile, 'utf8'))) : {}; }
		catch { return { unavailable: true }; }
		if (!isJsonObject(native)) { return { unavailable: true }; }
		let overlay: Record<string, unknown> = {};
		const remaining: string[] = [];
		for (let i = 0; i < extra.length; i++) {
			const arg = extra[i] === '--settings' ? extra[++i] : extra[i].startsWith('--settings=') ? extra[i].slice(11) : undefined;
			if (arg !== undefined) {
				let value: unknown;
				try { value = JSON.parse(arg.trim().startsWith('{') ? arg : fs.readFileSync(path.resolve(cwd, arg), 'utf8')); }
				catch { throw new Error('Antigravity per-launch settings must be a readable JSON object.'); }
				if (!isJsonObject(value)) { throw new Error('Antigravity per-launch settings must be a JSON object.'); }
				overlay = { ...overlay, ...value };
			} else if (extra[i] !== undefined) { remaining.push(extra[i]); }
		}
		if (tools) {
			const permissions = isJsonObject(overlay.permissions) ? overlay.permissions : antigravityPermissions(env, platform);
			const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
			overlay.permissions = { ...permissions, allow: allow.includes(ALLOW_TOOLS) ? allow : [...allow, ALLOW_TOOLS] };
		}
		const title = { ...isJsonObject(native.title) ? native.title : {}, ...isJsonObject(overlay.title) ? overlay.title : {} };
		return { extra: remaining, args: ['--settings', JSON.stringify({ ...overlay, title: { ...title, type: 'command', enabled: true, command: hook } })],
			env: { FACADE_CODE_TITLE_COMMAND: title.enabled !== false && typeof title.command === 'string' ? title.command : '' } };
	},
	identityOptions: ['--continue', '-c'],
	displayName: 'Antigravity',
	setting: 'facade.antigravity',
	command: 'agy',
	groups: {
		resume: ['--conversation', '${sessionId}'],
		// Its own settings for the session alone, never saved: Facade's tools allowed beside the person's own rules
		connect: ['--settings', '${settings}'],
		yoloOn: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
		model: ['--model', '${model}'],
		effort: ['--effort', '${effort}']
	},
	takes: { model: true, effort: true },
	values: input => ({
		settings: JSON.stringify({ permissions: antigravityPermissions(input.env, input.platform) }),
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {}
	}),
	tools: antigravityTools,
	// It starts a folder's plugin servers with its first turn, which is planned before they connect, or with its MCP panel: opened
	// and closed before the first turn, every turn has the tools (COLLABORATION-2.2)
	warmUp: { text: '/mcp', typed: '^> /mcp\\s*$', ready: `✓\\s+${PLUGIN_SERVER}\\b`, opened: '^MCP Servers\\s*$|\\besc Exit\\b', close: 'Escape' },
	promptAfterStart: 'Antigravity starts the Facade tools of a folder only with its first turn, so its first task goes in as its first message once they are ready',
	trustTarget: (cwd, env, platform): TrustTarget => {
		const folder = workingDirectoryOf(cwd, env, platform);
		return { file: antigravitySettingsFile(env, platform), keys: ['trustedWorkspaces'], entry: { item: folder }, folder };
	},
	// Its input, recorded on macOS with Antigravity 1.4.12 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'agy-frame', evidence: 'its input frame between two rules, its own earlier messages above it: empty, a typed, pasted, multi-line, long-paste, history or slash-command draft, while working, and gone behind its trust and permission questions' },
	title: { names: ['Antigravity', 'agy'] },
	sandbox: () => ({ state: 'none' }),
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--mode', 'accept-edits', '--dangerously-skip-permissions'] } : { state: 'native' },
	interruptExit: sigintExit
};
