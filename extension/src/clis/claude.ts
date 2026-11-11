/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder, isEqualPath, realFolderOf } from '../base/files';
import { setOwn } from '../base/json';
import { CliAdapter, EntryEnvironment, mergeSettings, RunSettingsGiven, sigintExit } from './adapter';
import { Environment, setVariable, variableOf } from './environment';
import { homeOf } from './executable';
import { MCP_CONFIG, mcpConfigText, pluginManifest, SERVER_NAME, SKILL_FILE, ToolsIntegration } from './tools';
import type { TrustTarget } from './trust';

/** Claude Code has a sandbox on macOS and Linux, not on Windows. */
function hasSandbox(platform: NodeJS.Platform): boolean {
	return platform !== 'win32';
}

/** The switch of Claude Code's that turns off its terminal titles, and with them its OSC 7501 status reports (CLIS-2.3). */
const TITLE_SWITCH = 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE';

/**
 * The switch that keeps Claude Code from installing its VS Code extension. In a VS Code terminal without that extension, Claude Code
 * 2.1.316 installs it and then shows a welcome waiting for Enter in the agent's terminal, past which no message goes (RULES-1.4).
 * A run sets it where the person has not (CLIS-1.2).
 */
const AUTO_INSTALL_SWITCH = 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL';

/**
 * The variables Claude Code reads its key from, which it takes as unset where they are empty (CONFIGURATION-5.1): an entry that removes
 * one has it written empty in the run's settings, so that a key of the person's own settings files never goes with the entry's API.
 * Only these two are known to read so; another variable an entry removes is never written empty in their place.
 */
const CLAUDE_KEY_VARIABLES: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** The key variable `name` is, as `platform` compares variable names - Windows ignoring case - by its own spelling; none for another. */
function keyVariableOf(name: string, platform: NodeJS.Platform): string | undefined {
	return CLAUDE_KEY_VARIABLES.find(key => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name);
}

/**
 * Claude Code's settings for one run (CLIS-3.2, CONFIGURATION-5.1), which override the same keys of its settings files for that
 * session alone: no more than a run needs, so that the person's own settings stay in force (CLIS-1.3). Its entry's `env` is among
 * them - Claude Code's settings files' `env` would otherwise win over the run's environment - with its removed key variables empty.
 * It never takes a project's `facade` server from `.mcp.json`, which would ask about it at its start. Its title switch also turns off
 * its OSC 7501 status reports, which a run needs to show its activity (CLIS-2.3), and it reapplies `env` from its settings files
 * after launch, so the run's settings clear the switch too, whatever the entry sets. With YOLO off its sandbox is turned on where it
 * has one; with YOLO on its sandbox is its own setting's, as YOLO maps to the permission bypass alone.
 */
export function claudeRunSettings(yolo: boolean, platform: NodeJS.Platform, sessionHook?: string, entryEnv?: EntryEnvironment): { [key: string]: unknown } {
	// A key variable removed in any spelling the platform reads as it is written empty, by its own spelling
	const removed = (entryEnv?.removed ?? []).flatMap(name => keyVariableOf(name, platform) ?? []);
	return {
		env: { ...entryEnv?.set, ...Object.fromEntries(removed.map(name => [name, ''])), [TITLE_SWITCH]: '' },
		...(sessionHook ? { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].map(event => [event, [{ hooks: [{ type: 'command', command: sessionHook }] }]])) } : {}),
		// A project's own `facade` server - Muse Code's shared entry, on Windows - is never this run's: it has its own, and no question
		// about the project's stops it at its start
		disabledMcpjsonServers: [SERVER_NAME],
		...!yolo && hasSandbox(platform) ? { sandbox: { enabled: true } } : {}
	};
}

/** The `env` a Claude Code settings file `file` sets, as Claude Code reads it: none where the file is not there or not a JSON object. */
function settingsEnvOf(file: string): { readonly [name: string]: unknown } {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? envOf(value as { readonly [key: string]: unknown }) : {};
	} catch {
		return {};
	}
}

/** The variables a Claude Code settings object gives in its `env`: none where that is no object. */
function envOf(settings: { readonly [key: string]: unknown }): { readonly [name: string]: unknown } {
	const env = settings.env;
	return typeof env === 'object' && env !== null && !Array.isArray(env) ? env as { readonly [name: string]: unknown } : {};
}

/**
 * The `env` of Claude Code's settings `sources`, lowest precedence first: each variable as the last source that sets it gives it - in
 * a source, as the last of its properties that names it - names compared as `platform` compares them, on Windows in any case. One
 * name holds each variable, its last spelling: Claude Code is given one value for it, never two it would set in an order of its own.
 */
function mergedEnv(sources: readonly { readonly [name: string]: unknown }[], platform: NodeJS.Platform): { [name: string]: unknown } {
	const result: { [name: string]: unknown } = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source)) {
			Object.keys(result).filter(key => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name).forEach(key => delete result[key]);
			setOwn(result, name, value);
		}
	}
	return result;
}

/**
 * The Claude Code settings that would set again a variable `removed` that a launch's entry removes, other than its key variables
 * (CONFIGURATION-5.1): its user settings, in the folder `CLAUDE_CONFIG_DIR` names, else `~/.claude`; the working folder's shared and
 * local settings, `.claude/settings.json` and `.claude/settings.local.json` in `cwd`; and the person's own `--settings` of the entry,
 * `theirs`, each by the argument that gives it. The first that sets one, by the variable and where; none where none sets any.
 */
function claudeReadded(removed: readonly string[], env: Environment, cwd: string, platform: NodeJS.Platform, theirs: readonly RunSettingsGiven[]): { readonly name: string; readonly file: string } | undefined {
	const others = removed.filter(name => keyVariableOf(name, platform) === undefined);
	if (!others.length) {
		return undefined;
	}
	const set = variableOf(env, 'CLAUDE_CONFIG_DIR', platform);
	const configDir = set ? path.resolve(cwd, set) : path.join(homeOf(env, platform), '.claude');
	const files = [path.join(configDir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
	const sources: { readonly file: string; readonly env: { readonly [name: string]: unknown } }[] = [
		...files.map(file => ({ file, env: settingsEnvOf(file) })),
		...theirs.map(each => ({ file: each.place, env: envOf(each.settings) }))
	];
	for (const name of others) {
		const source = sources.find(each => Object.keys(each.env).some(key => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name));
		if (source) {
			return { name, file: source.file };
		}
	}
	return undefined;
}

/**
 * The file Claude Code keeps its global configuration in, found as Claude Code 2.1.312 finds it in the environment `env`:
 * `.config.json` in its folder - `CLAUDE_CONFIG_DIR`, else `~/.claude` - where an older version left one that holds something, else
 * `.claude.json`, named for a custom OAuth server where one is set, in `CLAUDE_CONFIG_DIR`, else in the home folder. A relative
 * `CLAUDE_CONFIG_DIR` is from the folder it starts in, `cwd`, as Claude Code reads it there.
 */
export function claudeConfigFile(env: Environment, platform: NodeJS.Platform, cwd?: string): string {
	const set = variableOf(env, 'CLAUDE_CONFIG_DIR', platform);
	const configured = set && cwd !== undefined ? path.resolve(cwd, set) : set;
	const home = homeOf(env, platform);
	const file = path.join(configured || home, variableOf(env, 'CLAUDE_CODE_CUSTOM_OAUTH_URL', platform) ? '.claude-custom-oauth.json' : '.claude.json');
	const legacy = path.join(configured || path.join(home, '.claude'), '.config.json');
	try {
		const stat = fs.statSync(legacy);
		// One left empty counts only where it may still be written and the current one is not there
		if (stat.isFile() && (stat.size > 0 || ((stat.mode & 0o222) !== 0 && !fs.existsSync(file)))) {
			return legacy;
		}
	} catch {
		// None was left
	}
	return file;
}

/** The folder at or above `folder` with a `.git` in it - a Git directory, or the file of a linked worktree - as Claude Code looks. */
function gitRootOf(folder: string): string | undefined {
	for (let at = folder; ; at = path.dirname(at)) {
		try {
			const stat = fs.statSync(path.join(at, '.git'));
			if (stat.isDirectory() || stat.isFile()) {
				return at;
			}
		} catch {
			// Not here
		}
		if (path.dirname(at) === at) {
			return undefined;
		}
	}
}

/**
 * The repository's main checkout for the checkout at `root`, as Claude Code 2.1.312 finds it: for a linked worktree - whose `.git`
 * file names a Git directory among the `worktrees` of a common one, which names that `.git` file back - the folder the common
 * directory is the `.git` of, or for a bare repository the common directory itself; for anything else `root`.
 */
function mainCheckoutOf(root: string): string {
	try {
		const pointer = /^gitdir:(?<dir>.*)$/.exec(fs.readFileSync(path.join(root, '.git'), 'utf8').trim())?.groups?.dir.trim();
		if (!pointer) {
			return root;
		}
		const gitDir = path.resolve(root, pointer);
		const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
		const back = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim());
		if (path.dirname(gitDir) !== path.join(common, 'worktrees') || !isEqualPath(realFolderOf(back), path.join(canonicalFolder(root), '.git'))) {
			return root;
		}
		if (path.basename(common) === '.git') {
			return path.dirname(common);
		}
		return fs.existsSync(path.join(common, '.git')) ? root : common;
	} catch {
		// A Git directory, not a file; or a worktree whose files do not name each other
		return root;
	}
}

/**
 * The folder Claude Code keys a project's configuration and trust on for a run in `cwd`. On macOS and Linux (2.1.312, 2.1.316): the
 * repository's main checkout - for a linked worktree, the checkout whose Git directory it shares - else, outside any repository, `cwd`
 * itself; its real path in Unicode NFC. On Windows (2.1.316) it neither follows a worktree to its main checkout nor respells a path:
 * the folder at or above `cwd` with a `.git` in it - a linked worktree's own - else `cwd` itself, as the run is given it, the case of
 * its drive and folders kept, with forward slashes (CLIS-3.3).
 */
export function claudeProjectKey(cwd: string, platform: NodeJS.Platform): string {
	if (platform === 'win32') {
		const given = path.win32.resolve(cwd);
		return (gitRootOf(given) ?? given).split('\\').join('/');
	}
	const real = canonicalFolder(cwd);
	const root = gitRootOf(real);
	return (root === undefined ? real : mainCheckoutOf(root)).normalize('NFC');
}

/**
 * Why Claude Code's trust is not written for its project folder `folder` (CLIS-3.3): its trust covers every folder below a
 * trusted one, so for a filesystem root, the home folder `home` or a folder above it, it would trust every project there. None for
 * any other folder.
 */
export function trustWithheld(folder: string, home: string, platform: NodeJS.Platform): string | undefined {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	// Compared as the platform compares them: Windows ignores case and takes either slash
	const spelled = (each: string) => paths.resolve(platform === 'win32' ? each.toLowerCase() : each);
	// A home folder reached through a link is that folder; one that is not here is compared as it is named
	const real = fs.existsSync(home) ? canonicalFolder(home) : home;
	const project = spelled(folder);
	if (paths.dirname(project) === project) {
		return 'it is a filesystem root, and Claude Code trusts every folder below a trusted one';
	}
	const below = paths.relative(project, spelled(real));
	if (below === '') {
		return 'it is the home folder, and Claude Code trusts every folder below a trusted one';
	}
	return !below.startsWith('..') && !paths.isAbsolute(below) ? 'the home folder is inside it, and Claude Code trusts every folder below a trusted one' : undefined;
}

/** The run's plugin of the skill, as `--plugin-dir` loads one: its manifest and its skill. */
const PLUGIN_DIR = 'plugin';

/**
 * Claude Code is given the server in a per-run `--mcp-config` file, which adds it to the person's own servers, and the skill in a
 * per-run `--plugin-dir` plugin: nothing in the project or the person's settings (CLIS-2.2). `--allowedTools mcp__facade` lets
 * Facade's own tools run without asking, with YOLO off too; the CLI's own commands and edits keep their approvals (CLIS-1.3).
 */
const claudeTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server in a per-run --mcp-config file, its tools allowed by --allowedTools, and the skill in a per-run --plugin-dir plugin' },
	where: runDir => `--mcp-config ${path.join(runDir, MCP_CONFIG)} and --plugin-dir ${path.join(runDir, PLUGIN_DIR)}, files of the run alone`,
	inject: ({ server, skill, runDir }) => ({
		values: { mcpConfig: path.join(runDir, MCP_CONFIG), pluginDir: path.join(runDir, PLUGIN_DIR), allowedTools: `mcp__${SERVER_NAME}` },
		runFiles: [
			{ path: path.join(runDir, MCP_CONFIG), content: mcpConfigText(server) },
			{ path: path.join(runDir, PLUGIN_DIR, '.claude-plugin', 'plugin.json'), content: `${JSON.stringify(pluginManifest(), undefined, 2)}\n` },
			{ path: path.join(runDir, PLUGIN_DIR, SKILL_FILE), content: skill }
		],
		project: [],
		env: {}
	})
};

/**
 * Claude Code in its own UI (CLIS-1.3). YOLO on: its permissions bypassed, its sandbox as its own settings have it. YOLO off: its
 * sandbox on where it has one, its permission mode and rules its own. Every launch trusts its repository - or, outside any, its
 * folder - as accepting its trust question does: `hasTrustDialogAccepted` for the project in its global configuration (CLIS-3.3,
 * CLIS-3.3).
 */
export const claudeAdapter: CliAdapter = {
	id: 'claude',
	sessionIdentity: true,
	displayName: 'Claude Code',
	setting: 'clis.claude',
	command: 'claude',
	// What its entry's args cannot hold (CONFIGURATION-3.1): approvals (yolo), model and effort (their fields), the session, the folder,
	// where it runs, a print mode and a task. Its `--settings` is merged into the run's own; its list options take several values.
	grammar: {
		reserved: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--session-id', '--resume', '-r', '--continue', '-c',
			'--fork-session', '--resume-session-at', '--no-session-persistence', '--from-pr', '--worktree', '-w', '--tmux', '--environment', '--cloud', '--teleport',
			'--desktop', '--bg', '--background', '--print', '-p', '--model', '--effort',
			// Modes that skip the run's hooks and servers, or refuse its permission bypass
			'--bare', '--safe-mode', '--restricted'],
		attached: ['-r', '-w'],
		variadic: ['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--mcp-config', '--betas', '--file'],
		clusters: { values: ['-d', '-n', '-r', '-w'] },
		// The options its help writes with `<value>`, whose value Commander takes whatever it looks like
		required: ['--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt', '--autocompact', '--betas', '--debug-file',
			'--disallowedTools', '--disallowed-tools', '--effort', '--environment', '--fallback-model', '--file', '--input-format', '--json-schema', '--max-budget-usd',
			'--mcp-config', '--model', '-n', '--name', '--output-format', '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url',
			'--remote-control-session-name-prefix', '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-snapshot', '--tools']
	},
	// The person's --settings merged into the run's, which a file of the run carries: never inline, where a process list shows it
	runSettings: {
		option: '--settings',
		name: 'claude-settings.json',
		build: (input, theirs) => {
			const readded = input.env ? claudeReadded(input.entryEnv?.removed ?? [], input.env, input.cwd, input.platform, theirs) : undefined;
			if (readded) {
				const at = `${input.setting ?? 'clis.claude'}.env.${readded.name}`;
				return {
					problem: `${at} removes ${readded.name}, but ${readded.file} sets it again for Claude Code; remove it there, or set it in env instead`,
					said: { kind: 'claude_env_readded', values: [at, readded.name, readded.file] }
				};
			}
			// Their settings in their order, then Facade's; the variables of each over those before it, by name as the platform reads it
			const ours = claudeRunSettings(input.yolo, input.platform, input.sessionHook, input.entryEnv);
			const settings = theirs.reduce<{ [key: string]: unknown }>((merged, each) => mergeSettings(merged, each.settings), {});
			return { settings: { ...mergeSettings(settings, ours), env: mergedEnv([...theirs.map(each => envOf(each.settings)), envOf(ours)], input.platform) } };
		},
		// Claude Code sets its settings' env over the environment it starts with, its session hook's included: a variable Facade gives
		// the run last that the entry's env or the person's --settings names holds the run's value, or goes where the run removes it
		finish: (settings, { last, platform }) => {
			const env: { [name: string]: unknown } = { ...settings.env as { readonly [name: string]: unknown } };
			for (const { name, value } of last) {
				const named = Object.keys(env).filter(key => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name);
				if (named.length) {
					named.forEach(key => delete env[key]);
					if (value !== undefined) {
						setOwn(env, name, value);
					}
				}
			}
			return { ...settings, env };
		}
	},
	// The person's tools and servers go with Facade's in one occurrence, so that Claude Code keeps both
	additive: [['--allowedTools', '--allowed-tools'], ['--mcp-config']],
	groups: {
		session: ['--session-id', '${sessionId}'],
		resume: ['--resume', '${sessionId}'],
		connect: ['--mcp-config', '${mcpConfig}', '--plugin-dir', '${pluginDir}', '--allowedTools', '${allowedTools}'],
		quiet: ['--settings', '${runSettings}'],
		yoloOn: ['--dangerously-skip-permissions'],
		model: ['--model', '${model}'],
		effort: ['--effort', '${effort}'],
		// After the end of its options: some of them, --mcp-config and --allowedTools among them, take every value up to the next option
		prompt: ['--', '${prompt}']
	},
	takes: { model: true, effort: true },
	values: input => ({
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {}
	}),
	tools: claudeTools,
	// Its input frame, recorded signed in on macOS with 2.1.312 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'claude-frame', evidence: 'its input frame between two rules: empty, a typed, pasted, multi-line, history or slash-command draft, and gone behind a permission or trust question' },
	initialPrompt: { state: 'unverified', reason: 'the prompt as its positional argument after --, which starts the interactive session with it' },
	trustTarget: (cwd, env, platform): TrustTarget => {
		const folder = claudeProjectKey(cwd, platform);
		const withheld = trustWithheld(folder, homeOf(env, platform), platform);
		return { file: claudeConfigFile(env, platform, cwd), keys: ['projects', folder, 'hasTrustDialogAccepted'], entry: { value: true }, folder, ...withheld ? { withheld } : {} };
	},
	// The title switch would also turn off its status reports; the run's --settings clears it for the files' copy (CLIS-2.3). No
	// install of its VS Code extension, and so no welcome in the way of messages, where the person set nothing (CLIS-1.2)
	adjustEnvironment: (env, platform) => {
		setVariable(env, TITLE_SWITCH, null, platform);
		if (variableOf(env, AUTO_INSTALL_SWITCH, platform) === undefined) {
			setVariable(env, AUTO_INSTALL_SWITCH, '1', platform);
		}
	},
	// YOLO off turns its sandbox on through the run's settings, where it has one; YOLO on leaves it to its own settings
	sandbox: (yolo, platform) => !hasSandbox(platform) ? { state: 'none' } : yolo ? { state: 'native' } : { state: 'on' },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--dangerously-skip-permissions'] } : { state: 'native' },
	interruptExit: sigintExit
};
