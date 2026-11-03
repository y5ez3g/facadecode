/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { CliAdapter, configOverrides, sigintExit } from './adapter';
import * as fs from 'fs';
import { codeOf, messageOf } from '../base/errors';
import { isEqualPath, readJsonFile } from '../base/files';
import { isJsonObject, type JsonObject } from '../base/json';
import { executableAt, launchTarget, LaunchTarget, xdgDirOf } from './executable';
import { sessionDirOf, type SessionIntegration, type SessionIntegrationInput } from './identity';
import { museDataDir } from './history/muse';
import { RUN_VARIABLE, variableOf, type Environment } from './environment';
import { SERVER_NAME, serverEntry, sharedServer, type ToolsConflict, ToolsIntegration } from './tools';

/** The installer's active native program avoids cmd.exe/PowerShell changing JSON arguments (CLIS-2.4). */
export function museTarget(file: string, platform: NodeJS.Platform, env: Environment, cwd: string): LaunchTarget {
	const target = launchTarget(file, platform, env, cwd);
	if (platform !== 'win32' || !target.throughCmd) { return target; }
	try {
		const shim = fs.readFileSync(file, 'utf8');
		if (!/-File\s+"%~dp0\.muse-launcher\.ps1"\s+%\*/i.test(shim)) { return target; }
		const dir = path.dirname(file);
		const launcher = fs.readFileSync(path.join(dir, '.muse-launcher.ps1'), 'utf8');
		if (!launcher.includes('function Get-ActiveBinary') || !launcher.includes('"muse-bin-$version.exe"')) { return target; }
		const version = fs.readFileSync(path.join(dir, '.muse-version'), 'utf8').trim();
		if (!/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(version)) { return target; }
		const channelFile = path.join(dir, '.muse-channel');
		const channel = fs.existsSync(channelFile) ? fs.readFileSync(channelFile, 'utf8').trim() : 'muse-stable';
		if (channel !== (variableOf(env, 'MUSE_CHANNEL', platform)?.trim() || 'muse-stable')) { return target; }
		const executable = executableAt(path.join(dir, `muse-bin-${version}.exe`), env, platform);
		return executable ? { executable, args: [], throughCmd: false } : target;
	} catch { return target; }
}

/** The person's own Muse Code settings file, as the environment `env` it starts with places it: hooks and MCP servers among the rest. */
function museSettingsFile(env: Environment, platform: NodeJS.Platform): string {
	return path.join(xdgDirOf('config', env, platform), 'muse', 'settings.json');
}

/**
 * Preserve the user's hook groups; managed and project hooks remain loaded by Muse itself. Settings or per-launch hooks it cannot read -
 * its settings file read as such files are, comments and trailing commas allowed - stay as they are, for Muse Code to say what is wrong
 * with them, and the launch claims no identity tracking (CLIS-2.4).
 */
export function museSession({ file, hook, env, extra, throughCmd, platform, instructions }: SessionIntegrationInput): SessionIntegration {
	if (throughCmd) { return { unavailable: true }; }
	const settings = readJsonFile(museSettingsFile(env, platform));
	if (settings.kind === 'other') { return { unavailable: true }; }
	let hooks = settings.kind === 'object' ? settings.value.hooks : undefined;
	const overrides = configOverrides(extra).filter(each => each.key === 'hooks' && each.value !== undefined);
	if (overrides.length > 1) { return { unavailable: true }; }
	for (const { value } of overrides) {
		try { hooks = JSON.parse(value!) as unknown; }
		catch { return { unavailable: true }; }
	}
	if (hooks !== undefined && !isJsonObject(hooks)) { return { unavailable: true }; }
	const merged = { ...isJsonObject(hooks) ? hooks : {} };
	for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
		const groups = merged[event];
		if (groups !== undefined && !Array.isArray(groups)) { return { unavailable: true }; }
		merged[event] = [...(groups ?? []), { hooks: [{ type: 'command', command: hook, timeout: 5 }] }];
	}
	// The per-launch override consumed: its hooks go in the run's own, once
	const consumed = new Set(overrides.flatMap(({ index, span }) => span === 2 ? [index, index + 1] : [index]));
	return { extra: extra.filter((_, index) => !consumed.has(index)), args: ['-c', `hooks=${JSON.stringify(merged)}`],
		files: [{ file: path.join(sessionDirOf(file), 'muse.json'), content: JSON.stringify({ data: museDataDir(env, platform) }) },
			...(instructions ? [{ file: path.join(sessionDirOf(file), 'context.json'), content: JSON.stringify({ instructions }) }] : [])] };
}

/** The project's MCP file Muse Code reads in a trusted folder, and where it reads skills there (CLIS-2.2). */
const MCP_FILE = '.mcp.json';
const SKILL_PATH = path.join('.agents', 'skills', SERVER_NAME, 'SKILL.md');

/** The variable a run's own entry names for the server's runtime variable: Muse Code takes only references in a run's entry. */
const RUNTIME_REFERENCE = 'FACADE_ELECTRON_RUN_AS_NODE';

/**
 * The project MCP files a run of Muse Code in `cwd` reads, nearest first: `.mcp.json` in each folder from `cwd` up to the top of
 * its repository - the folder with `.git` - and outside a repository in `cwd` alone, as Muse Code 1.4.14 reads them (CLIS-2.2).
 */
export function museProjectMcpFiles(cwd: string): string[] {
	const start = path.resolve(cwd);
	const folders: string[] = [];
	for (let folder = start; ; folder = path.dirname(folder)) {
		folders.push(folder);
		if (fs.existsSync(path.join(folder, '.git'))) {
			return folders.map(each => path.join(each, MCP_FILE));
		}
		if (path.dirname(folder) === folder) {
			return [path.join(start, MCP_FILE)];
		}
	}
}

/**
 * Why Muse Code 1.4.14 cannot load the project MCP file `text`, as it was seen to fail: text that is not plain JSON - a byte order
 * mark, a comment, a trailing comma, nothing at all - no JSON object, an `mcpServers` that is no object, or a server in it that is
 * no object with a `command` or `url` string. Undefined where it loads, as far as these go (CLIS-2.2).
 */
function unloadableBy(text: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// JSON parse errors can quote configuration values; diagnostics identify the file, never its contents.
		return 'is not plain JSON, as Muse Code reads it';
	}
	if (!isJsonObject(value)) {
		return 'holds no JSON object';
	}
	const servers = value.mcpServers;
	if (servers === undefined) {
		return undefined;
	}
	if (!isJsonObject(servers)) {
		return 'has an mcpServers that is not a JSON object';
	}
	const odd = Object.keys(servers).find(name => {
		const each = servers[name];
		return !isJsonObject(each) || (typeof each.command !== 'string' && typeof each.url !== 'string');
	});
	return odd === undefined ? undefined : `names a server ${JSON.stringify(odd)} with neither a command nor a url`;
}

/**
 * How a run of Muse Code in `cwd` can be given the server (CLIS-2.2). Muse Code refuses a run whose `-c mcpServers.facade` names a
 * server its own settings or a project MCP file it reads already names, and one whose project MCP file it cannot load: by `-c`
 * where neither is so. Where `cwd`'s own `.mcp.json` names it, the project entry instead, which takes the place of a Facade's
 * there - another installation's, or the Facade Code IDE's (CLIS-2.2) - and is a conflict where the server is the person's own
 * (CLIS-2.2). Anything else in the way is a conflict: the person's settings naming one, a project file it cannot load or a folder
 * above naming one. A file in `cwd` is named relative to it.
 */
function museRoute(cwd: string, env: Environment, platform: NodeJS.Platform): 'argument' | 'project' | ToolsConflict {
	const shown = (file: string) => path.dirname(file) === path.resolve(cwd) ? path.basename(file) : file;
	const settingsFile = museSettingsFile(env, platform);
	const settings = readJsonFile(settingsFile);
	if (settings.kind === 'object' && isJsonObject(settings.value.mcpServers) && Object.hasOwn(settings.value.mcpServers, SERVER_NAME)) {
		return { conflict: { file: settingsFile, reason: `${settingsFile} names a ${SERVER_NAME} server in mcpServers, beside which Muse Code refuses to run with Facade's; Facade leaves it as it is` } };
	}
	const own = path.join(path.resolve(cwd), MCP_FILE);
	let route: 'argument' | 'project' = 'argument';
	for (const file of museProjectMcpFiles(cwd)) {
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch (err) {
			if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') {
				continue;
			}
			return { conflict: { file: shown(file), reason: `${file} could not be read: ${messageOf(err)}; Facade leaves it as it is` } };
		}
		const why = unloadableBy(text);
		if (why !== undefined) {
			return { conflict: { file: shown(file), reason: `${file} ${why}, and Muse Code refuses to run with Facade's server beside a project MCP file it cannot load; Facade leaves it as it is` } };
		}
		const servers = (JSON.parse(text) as JsonObject).mcpServers;
		if (isJsonObject(servers) && Object.hasOwn(servers, SERVER_NAME)) {
			if (!isEqualPath(file, own)) {
				return { conflict: { file: shown(file), reason: `${file} names a ${SERVER_NAME} server in mcpServers, beside which Muse Code refuses to run with Facade's in ${cwd}; Facade leaves it as it is` } };
			}
			route = 'project';
		}
	}
	return route;
}

/**
 * Muse Code is given the server for the run alone by `-c mcpServers.facade=<entry>`, and the skill in the project's
 * `.agents/skills/facade`, shared by the folder's runs; every launch trusts the folder, so it reads it (CLIS-2.2, 3.3). A run's
 * entry may name variables only by references to the CLI's environment, which carries the run's own. It is optional: Muse Code
 * fails a whole run over a required server that does not start, and requires one by default (CLIS-2.2). On Windows Facade starts its
 * installed native program, which takes the entry's JSON as an argument as it takes its hooks'; only a program that starts through
 * cmd.exe, which cannot carry it, is given the `facade` entry of the project's `.mcp.json` instead, merged into the person's file
 * and shared by the folder's runs, its variables `${NAME:-}` references - empty in a session the person starts there by hand,
 * whose server then serves nothing, where an unset reference would turn off every server of theirs - and with no `mode`: Muse
 * Code 1.4.14 refuses one in a project's file, as a configuration error that turns off all its MCP servers (CLIS-2.2). So is a run
 * whose own folder's `.mcp.json` already names a `facade` server, beside which Muse Code refuses a `-c` one; a run whose `-c`
 * server Muse Code would refuse over anything else of the person's starts without the tools (CLIS-2.2).
 */
const museTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server by -c mcpServers.facade for the run alone - where Windows starts it through cmd.exe, or the folder\'s .mcp.json already names a facade server, a facade entry merged into the project\'s .mcp.json, shared by the folder\'s runs - with references to the run\'s variables in the CLI\'s environment, and the skill in the project\'s .agents/skills/facade' },
	where: (_runDir, cwd) => `-c mcpServers.${SERVER_NAME} of the launch alone - where Windows starts it through cmd.exe, or the folder's ${MCP_FILE} already names a ${SERVER_NAME} server, mcpServers.${SERVER_NAME} in ${path.join(cwd, MCP_FILE)} - and the skill in ${path.join(cwd, SKILL_PATH)}, shared by the runs there`,
	inject: ({ server, skill, platform, throughCmd, cwd, env: cliEnv }) => {
		const shared = sharedServer(server);
		const skillFile = { kind: 'file', path: SKILL_PATH, content: skill } as const;
		const route = platform === 'win32' && throughCmd ? 'project' : cwd === undefined ? 'argument' : museRoute(cwd, cliEnv ?? {}, platform ?? process.platform);
		if (typeof route !== 'string') {
			return route;
		}
		if (route === 'project') {
			const references = Object.fromEntries([...Object.keys(shared.env), RUN_VARIABLE].map(name => [name, `\${${name}:-}`]));
			const entry = serverEntry({ ...shared.server, env: { ...shared.server.env, ...references } });
			return { values: {}, runFiles: [], project: [{ kind: 'entry', path: MCP_FILE, keys: ['mcpServers', SERVER_NAME], value: entry }, skillFile], env: shared.env };
		}
		// Every variable a reference to the CLI's environment, the runtime's under a name of its own, which no program but the server reads
		const runtime = Object.fromEntries(Object.entries(shared.server.env).map(([name, value]) => [name === 'ELECTRON_RUN_AS_NODE' ? RUNTIME_REFERENCE : name, value]));
		const env = { ...runtime, ...shared.env };
		const references = Object.fromEntries([...Object.keys(server.env), RUN_VARIABLE].map(name => [name, `\${${name === 'ELECTRON_RUN_AS_NODE' ? RUNTIME_REFERENCE : name}}`]));
		const entry = { ...serverEntry({ command: server.command, args: server.args, env: references }), mode: 'optional' };
		return { values: {}, args: ['-c', `mcpServers.${SERVER_NAME}=${JSON.stringify(entry)}`], runFiles: [], project: [skillFile], env };
	}
};

/**
 * Muse Code in its own UI (CLIS-1.3). YOLO on: its tool approvals and its shell sandbox off for the run, `--disable-approval
 * --disable-sandbox` - not `--yolo`, which also withholds its question tool. YOLO off: its approvals and its sandbox as its own
 * configuration has them, the sandbox on unless that turns it off. Every launch trusts the folder it starts in for that launch alone
 * with `--trust-workspace`, as accepting its trust question would, writing nothing (CLIS-3.3). On Windows its installer's
 * `muse.cmd` runs a PowerShell launcher that picks its current program, whose installed native program is resolved directly to preserve JSON hook arguments (CLIS-2.4). It reports its activity by OSC 7501 on Linux and macOS but sends nothing on Windows, where ptyd reads it from
 * its screen instead (CLIS-2.3).
 */
export const museAdapter: CliAdapter = {
	id: 'muse',
	sessionIdentity: true,
	sessionIntegration: museSession,
	identityOptions: ['--no-session-log', '--continue', '--last'],
	displayName: 'Muse Code',
	setting: 'facade.muse',
	command: 'muse',
	launchTarget: museTarget,
	groups: {
		resume: ['resume', '${sessionId}'],
		yoloOn: ['--disable-approval', '--disable-sandbox'],
		model: ['--model', '${model}'],
		// For the run alone, its values JSON: its own --reasoning-effort is kept in the person's settings, and the efforts its settings
		// keep for each model would win over this one
		effort: ['-c', 'reasoning_effort=${effortJson}', '-c', 'model_reasoning_efforts={}'],
		trust: ['--trust-workspace'],
		// After the end of its options, so that a prompt is never read as an option or a command
		prompt: ['--', '${prompt}']
	},
	takes: { model: true, effort: true },
	values: input => ({
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effortJson: JSON.stringify(input.effort) } : {}
	}),
	tools: museTools,
	initialPrompt: { state: 'unverified', reason: 'the prompt as its positional argument after --, which starts the interactive session with it' },
	// 1.4.14 reads a prompt that is one of its commands' names as that command, even after --, and refuses to start (CLIS-2.2)
	promptProblem: prompt => /^[a-z][a-z0-9-]*$/.test(prompt) ? 'Muse Code reads a prompt of one lowercase word as one of its commands, even after --' : undefined,
	screenStatus: 'muse',
	// Its input, recorded on macOS with Muse Code 1.4.14 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'muse-frame', evidence: 'its input frame between two rules, its upper one labeled where it offers voice input: empty, a typed, pasted, multi-line, history or slash-command draft, and gone behind its trust question' },
	sandbox: yolo => yolo ? { state: 'off', by: ['--disable-sandbox'] } : { state: 'native' },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--disable-approval'] } : { state: 'native' },
	interruptExit: sigintExit
};
