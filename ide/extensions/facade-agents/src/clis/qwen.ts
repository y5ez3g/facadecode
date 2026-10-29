/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import { AgentCli, CliConfig, Environment, launchArgs, launchUses, launchValues, settingsWithValues, skillMarkdown, variableName, withVariables } from './cli';
import { HOME_VARIABLE, homeOf, LaunchTarget } from './executable';

/** How long a call of one of Facade's tools may take, in milliseconds: start_agent may wait as long as Facade's longest wait (L7). */
const TOOL_TIMEOUT_MS = 3_600_000;
/** How long Qwen Code lets a call of an MCP tool go without word from its server, by default, in milliseconds. */
const TOOL_IDLE_TIMEOUT_MS = 300_000;
/** The variables Qwen Code takes from the .env file of its own folder or of the home folder where its environment has none (0.25.3). */
const HOME_ENV_VARIABLES = ['QWEN_HOME', 'QWEN_RUNTIME_DIR', 'QWEN_CODE_MCP_APPROVALS_PATH', 'QWEN_CODE_TRUSTED_FOLDERS_PATH'];
/** The fields of an MCP server's configuration that Qwen Code leaves out of what its approval of the server is bound to (0.25.3). */
const NON_BEHAVIORAL_FIELDS = new Set(['scope', 'extensionName', 'description']);

/**
 * How Qwen Code merges a setting of a higher scope over a lower one's where not as by default - a list replaced, an object
 * merged key by key: the lists it adds together, `concat` keeping both whole and `union` each entry once, and the objects it
 * merges one level deep, `shallow` (0.25.3). Its hooks' lists, all `concat`, are found by where they are.
 */
const MERGE_STRATEGIES = new Map<string, 'concat' | 'union' | 'shallow'>([
	...['mcpServers', 'channels', 'serve', 'env', 'agents.modelGrades', 'agents.maxParallelAgentsByModel', 'omni.processing.fixedPolicies', 'omni.processing.transportGuard.policies', 'omni.processing.policyTools'].map(key => [key, 'shallow'] as const),
	...['context.includeDirectories', 'mcp.allowed', 'mcp.excluded'].map(key => [key, 'concat'] as const),
	...['slashCommands.disabled', 'skills.disabledLevels', 'skills.disabled', 'skills.defaultDisabled', 'skills.enabled', 'skills.directories', 'permissions.allow', 'permissions.ask', 'permissions.deny', 'permissions.autoMode.hints.allow', 'permissions.autoMode.hints.softDeny', 'permissions.autoMode.hints.hardDeny', 'permissions.autoMode.hints.deny', 'permissions.autoMode.environment', 'tools.exclude', 'tools.disabled', 'tools.visible', 'advanced.excludedEnvVars'].map(key => [key, 'union'] as const)
]);

/** The value of the variable `name` in `env`: on Windows, which takes a variable's name in any case, whatever its case there. */
function variable(env: Environment, name: string): string | undefined {
	return env[variableName(env, name)];
}

/**
 * A path the person set for Qwen Code, as it takes it for an agent starting in `folder`: a `~` it starts with the home
 * folder in `env`, a relative one from the folder.
 */
function qwenPath(set: string, env: Environment, folder: string): string {
	return set === '~' || /^~[\\/]/.test(set) ? path.join(homeOf(env), ...set.slice(2).split(/[\\/]+/).filter(Boolean)) : path.resolve(folder, set);
}

/** Qwen Code's own folder, as it finds it for an agent in `folder` in the environment `env`: `QWEN_HOME`, else `.qwen` in the home folder. */
function qwenHome(env: Environment, folder: string): string {
	const set = variable(env, 'QWEN_HOME');
	return set ? qwenPath(set, env, folder) : path.join(homeOf(env), '.qwen');
}

/** The variables a .env file sets, as Qwen Code reads one - by dotenv's rules; none where there is no such file. */
function dotenvValues(file: string): { [name: string]: string } {
	const values: { [name: string]: string } = {};
	const line = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/mg;
	for (const [, name, raw = ''] of textOf(file).replace(/\r\n?/g, '\n').matchAll(line)) {
		const value = raw.trim();
		const unquoted = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
		values[name] = value.startsWith('"') ? unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : unquoted;
	}
	return values;
}

/**
 * `env` as Qwen Code completes it as it starts in `folder` (0.25.3): each of `HOME_ENV_VARIABLES` it has none of taken from
 * the .env of Qwen Code's own folder, then - where QWEN_HOME is not set - of the folder that holds that one, then of the
 * folder a QWEN_HOME found so names.
 */
function withHomeEnv(env: Environment, folder: string): Environment {
	if (HOME_ENV_VARIABLES.every(name => variable(env, name))) {
		return env;
	}
	const initialHome = variable(env, 'QWEN_HOME');
	const initialDir = qwenHome(env, folder);
	let completed = env;
	const take = (file: string) => {
		const values = dotenvValues(file);
		completed = withVariables(completed, Object.fromEntries(HOME_ENV_VARIABLES.filter(name => values[name] && variable(completed, name) === undefined).map(name => [name, values[name]])));
	};
	take(path.join(initialDir, '.env'));
	if (!initialHome) {
		take(path.join(path.dirname(initialDir), '.env'));
	}
	const foundHome = variable(completed, 'QWEN_HOME');
	if (foundHome && foundHome !== initialHome && qwenHome(completed, folder) !== initialDir) {
		take(path.join(qwenHome(completed, folder), '.env'));
	}
	return completed;
}

/** The file Qwen Code keeps the person's trust in folders in: `QWEN_CODE_TRUSTED_FOLDERS_PATH`, else `trustedFolders.json` in its own folder. */
function trustFile(env: Environment, folder: string): string {
	const completed = withHomeEnv(env, folder);
	const set = variable(completed, 'QWEN_CODE_TRUSTED_FOLDERS_PATH');
	return set ? path.resolve(folder, set) : path.join(qwenHome(completed, folder), 'trustedFolders.json');
}

/** The file Qwen Code keeps the person's approvals of projects' MCP servers in: `QWEN_CODE_MCP_APPROVALS_PATH`, else `mcpApprovals.json` in its own folder. */
function approvalsFile(env: Environment, folder: string): string {
	const completed = withHomeEnv(env, folder);
	const set = variable(completed, 'QWEN_CODE_MCP_APPROVALS_PATH');
	return set ? path.resolve(folder, set) : path.join(qwenHome(completed, folder), 'mcpApprovals.json');
}

/** Where Qwen Code reads the administrator's settings - the scope over all its others - for an agent in `folder`, in `env`. */
function systemSettingsFile(env: Environment, folder: string): string {
	const set = variable(env, 'QWEN_CODE_SYSTEM_SETTINGS_PATH');
	if (set) {
		return path.resolve(folder, set);
	}
	switch (process.platform) {
		case 'darwin': return '/Library/Application Support/QwenCode/settings.json';
		case 'win32': return 'C:\\ProgramData\\qwen-code\\settings.json';
		default: return '/etc/qwen-code/settings.json';
	}
}

/** Where it reads the system defaults - the scope under all its others: `QWEN_CODE_SYSTEM_DEFAULTS_PATH`, else beside the administrator's settings. */
function systemDefaultsFile(env: Environment, folder: string): string {
	const set = variable(env, 'QWEN_CODE_SYSTEM_DEFAULTS_PATH');
	return set ? path.resolve(folder, set) : path.join(path.dirname(systemSettingsFile(env, folder)), 'system-defaults.json');
}

/** Settings Qwen Code merges, and the scope it reads them in: the system defaults', the person's, the project's - which it takes no sandbox from - or the administrator's. */
interface Layer {
	/** The file they are read from, or the setting of Facade's that a launch's own come from. */
	readonly source: string;
	readonly settings: JsonObject;
	readonly scope: 'defaults' | 'user' | 'project' | 'system';
}

/**
 * The settings Qwen Code merges for an agent in `folder` - or anywhere, without one - in the environment `env`, lowest first:
 * the system defaults, the person's, the project's and the administrator's. A file it cannot be read from counts as none.
 */
function settingsLayers(env: Environment, folder: string | undefined): Layer[] {
	const at = folder ?? homeOf(env);
	const files: { readonly file: string; readonly scope: Layer['scope'] }[] = [
		{ file: systemDefaultsFile(env, at), scope: 'defaults' },
		{ file: path.join(qwenHome(withHomeEnv(env, at), at), 'settings.json'), scope: 'user' },
		...folder === undefined ? [] : [{ file: path.join(folder, '.qwen', 'settings.json'), scope: 'project' as const }],
		{ file: systemSettingsFile(env, at), scope: 'system' }
	];
	return files.flatMap(({ file, scope }) => {
		const read = readJsonFile(file);
		return read.kind === 'object' ? [{ source: file, settings: read.value, scope }] : [];
	});
}

/** How Qwen Code merges the setting at `key`, a dotted path: as `MERGE_STRATEGIES` says, or as by default. */
function strategyOf(key: string): 'concat' | 'union' | 'shallow' | undefined {
	return MERGE_STRATEGIES.get(key) ?? (/^hooks\.\w+$/.test(key) ? 'concat' : undefined);
}

/** `over` merged over `under` as Qwen Code merges a higher scope's settings over a lower one's; `at`, the dotted path of both. */
function mergedAsQwen(under: JsonObject, over: JsonObject, at?: string): JsonObject {
	const merged: { [key: string]: unknown } = { ...under };
	for (const [key, value] of Object.entries(over)) {
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
			continue;
		}
		const where = at === undefined ? key : `${at}.${key}`;
		const strategy = strategyOf(where);
		const theirs = merged[key];
		if (strategy === 'shallow' && isJsonObject(theirs) && isJsonObject(value)) {
			merged[key] = { ...theirs, ...value };
		} else if (Array.isArray(theirs) && (strategy === 'concat' || strategy === 'union')) {
			const both = theirs.concat(Array.isArray(value) ? value : [value]);
			merged[key] = strategy === 'union' ? [...new Set(both)] : both;
		} else {
			merged[key] = isJsonObject(value) ? mergedAsQwen(isJsonObject(theirs) ? theirs : {}, value, where) : value;
		}
	}
	return merged;
}

/**
 * What of `under` stands beside `over` merged over it as Qwen Code merges them, each read as settings of their own: what
 * `over` sets taken out of `under`, but for a list it adds to, which stays - so that lists read from both together, and any
 * other value read from `over` first, come to what the merge holds.
 */
function underneath(under: JsonObject, over: JsonObject, at?: string): JsonObject {
	return Object.fromEntries(Object.entries(under).flatMap(([key, value]) => {
		if (!Object.hasOwn(over, key)) {
			return [[key, value]];
		}
		const where = at === undefined ? key : `${at}.${key}`;
		const strategy = strategyOf(where);
		const theirs = over[key];
		if (Array.isArray(value) && (strategy === 'concat' || strategy === 'union')) {
			return [[key, value]];
		}
		if (strategy === 'shallow' && isJsonObject(value) && isJsonObject(theirs)) {
			return [[key, Object.fromEntries(Object.entries(value).filter(([inner]) => !Object.hasOwn(theirs, inner)))]];
		}
		return isJsonObject(value) && isJsonObject(theirs) ? [[key, underneath(value, theirs, where)]] : [];
	}));
}

/**
 * The settings Qwen Code merges for an agent of a launch as `config` has it, lowest first: those `settingsLayers` finds, the
 * launch's own over them - in the administrator's scope, merged over the administrator's settings into the file it reads in
 * their place, what they replace of the administrator's taken out from under them. Their `${model}` and `${effort}` are left
 * out, which set neither servers nor rules.
 */
function launchLayers(config: CliConfig, env: Environment, folder: string | undefined): Layer[] {
	const layers = settingsLayers(env, folder);
	const own = settingsWithValues(config.launch.settings ?? {}, {});
	if (!Object.keys(own).length) {
		return layers;
	}
	return [
		...layers.map(layer => layer.scope === 'system' ? { ...layer, settings: underneath(layer.settings, own) } : layer),
		{ source: `${qwenCli.setting}.launch.settings`, settings: own, scope: 'system' as const }
	];
}

/** The value at `key`, a dotted path, in `settings`; undefined where there is none. */
function valueAt(settings: JsonObject, key: string): unknown {
	return key.split('.').reduce<unknown>((at, part) => isJsonObject(at) ? at[part] : undefined, settings);
}

/** The texts of the lists at `keys` in `settings`: the dotted paths of one setting, by its name now and its older ones. */
function listOf(settings: JsonObject, ...keys: string[]): string[] {
	return keys.flatMap(key => {
		const value = valueAt(settings, key);
		return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
	});
}

/** Whether `pattern` - a name, or a pattern of names with `*` and `?` - names `name`, as Qwen Code matches the names in its settings' lists. */
function namesIt(pattern: string, name: string): boolean {
	const source = [...pattern].map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
	return new RegExp(`^${source}$`).test(name);
}

/**
 * The values `args` give Qwen Code's option `name`, which takes a list, as it reads them: those after it up to the next option,
 * or after its `=`, each split at its commas - all of them where it is given more than once, by its name or its camel-case
 * one; undefined where it is not given.
 */
function optionValues(args: readonly string[], name: string): string[] | undefined {
	const names = [name, name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())].map(each => `--${each}`);
	let values: string[] | undefined;
	for (let i = 0; i < args.length; i++) {
		const equals = args[i].indexOf('=');
		if (!names.includes(equals === -1 ? args[i] : args[i].slice(0, equals))) {
			continue;
		}
		values ??= [];
		if (equals !== -1) {
			values.push(args[i].slice(equals + 1));
		} else {
			while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
				values.push(args[++i]);
			}
		}
	}
	return values?.flatMap(value => value.split(',')).map(each => each.trim()).filter(Boolean);
}

/** Whether a value of Qwen Code's sandbox setting, or of `QWEN_SANDBOX`, turns its sandbox on: true, or a sandbox's name. */
function turnsSandboxOn(value: unknown): boolean {
	return value === true || (typeof value === 'string' && !['', '0', 'false'].includes(value.trim().toLowerCase()));
}

/**
 * How long Qwen Code lets a call of an MCP tool go without word for an agent of a launch as `config` has it, in `folder` and
 * the environment `env`: as the highest scope that sets it has it - a setting goes over its variable - else as its variable
 * has it, else its default (0.25.3).
 */
function idleTimeout(config: CliConfig, env: Environment, folder: string): number {
	for (const { settings } of launchLayers(config, env, folder).reverse()) {
		const set = valueAt(settings, 'mcp.toolIdleTimeoutMs');
		if (typeof set === 'number') {
			return set;
		}
	}
	const given = variable(env, 'QWEN_CODE_MCP_TOOL_IDLE_TIMEOUT_MS');
	const fromVariable = given === undefined ? NaN : Number(given);
	return Number.isFinite(fromVariable) && fromVariable >= 0 ? fromVariable : TOOL_IDLE_TIMEOUT_MS;
}

/**
 * The administrator's settings in `file`, which a launch's own go over: none where there is no file. One that cannot be read
 * as settings refuses the start - its settings would be lost for the run - and is left as it is (L11).
 */
function administratorSettings(file: string): JsonObject {
	const read = readJsonFile(file);
	if (read.kind === 'other') {
		throw new Error(`${file} ${read.why}. Facade gives Qwen Code its launch settings over the settings in that file, and left the file unchanged. Correct the file, or remove the settings from ${qwenCli.setting}.launch.`);
	}
	return read.kind === 'object' ? read.value : {};
}

/** A server of a project's MCP configuration that Qwen Code would ask the person about: its name, and its configuration as the approval of it is bound to it. */
interface ProjectServer {
	readonly name: string;
	readonly server: JsonObject;
}

/** A server of a .mcp.json, written as Claude Code reads one, as Qwen Code takes it: its `type` left out, its `url` an `httpUrl` where the type is HTTP (0.25.3). */
function asQwenServer(server: JsonObject): JsonObject {
	const without = (...keys: string[]) => Object.fromEntries(Object.entries(server).filter(([key]) => !keys.includes(key)));
	if (server.command || server.httpUrl || server.tcp) {
		return server.type === undefined || server.type === 'sdk' ? server : without('type');
	}
	if (typeof server.url === 'string') {
		return { ...without('url', ...server.type === 'sdk' ? [] : ['type']), ...server.type === 'http' ? { httpUrl: server.url } : { url: server.url } };
	}
	return server;
}

/** `value` with each `$NAME` and `${NAME}` in its texts the variable's value in `env`, as Qwen Code expands its settings; one `env` has none of, or its session's, left as it is (0.25.3). */
function expanded(value: unknown, env: Environment): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$(?:(\w+)|\{([^}]+)\})/g, (whole, bare: string | undefined, braced: string | undefined) => {
			const name = bare ?? braced ?? '';
			return ['SESSION_ID', 'QWEN_CODE_SESSION_ID'].includes(name.toUpperCase()) ? whole : variable(env, name) ?? whole;
		});
	}
	if (Array.isArray(value)) {
		return value.map(each => expanded(each, env));
	}
	return isJsonObject(value) ? expandedServer(value, env) : value;
}

/** An MCP server's configuration in the project's settings with its variables expanded, as Qwen Code expands its settings. */
function expandedServer(server: JsonObject, env: Environment): JsonObject {
	return Object.fromEntries(Object.entries(server).map(([key, value]) => [key, expanded(value, env)]));
}

/** The hash Qwen Code binds its approval of an MCP server to: of what the server's configuration does, every object's keys in order (0.25.3). */
function approvalHash(server: JsonObject): string {
	const behavior = Object.fromEntries(Object.entries(server).filter(([key]) => !NON_BEHAVIORAL_FIELDS.has(key)));
	const stable = JSON.stringify(behavior, (_key, value: unknown) => isJsonObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
	return crypto.createHash('sha256').update(stable).digest('hex');
}

/** A project's folder as Qwen Code keys the person's approvals of its MCP servers: its absolute path, in lower case on Windows. */
function approvalsKey(folder: string): string {
	const resolved = path.resolve(folder);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** A project's approvals `incoming` merged into its `existing` ones: one of a server it has none of added, and where the two differ, a rejection kept (0.25.3). */
function mergedApprovals(existing: JsonObject, incoming: JsonObject): JsonObject {
	const merged: { [name: string]: unknown } = { ...existing };
	for (const [name, record] of Object.entries(incoming)) {
		if (!isJsonObject(record)) {
			continue;
		}
		const current = merged[name];
		const status = isJsonObject(current) ? current.status : undefined;
		if (!current) {
			merged[name] = record;
		} else if (status !== record.status) {
			merged[name] = status === 'rejected' ? current : record;
		}
	}
	return merged;
}

/**
 * The person's approvals of projects' MCP servers in `file`, as Qwen Code reads them: by project - on Windows its absolute
 * paths in lower case, the approvals of one written in two cases merged; none where the file holds no object (0.25.3).
 */
function approvalsIn(file: string): { [project: string]: unknown } {
	const read = readJsonFile(file);
	const approvals: { [project: string]: unknown } = {};
	for (const [key, value] of Object.entries(read.kind === 'object' ? read.value : {})) {
		const project = process.platform === 'win32' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(key) ? key.toLowerCase() : key;
		const existing = approvals[project];
		approvals[project] = isJsonObject(existing) && isJsonObject(value) ? mergedApprovals(existing, value) : isJsonObject(value) || !isJsonObject(existing) ? value : existing;
	}
	return approvals;
}

/**
 * The servers of the MCP configuration of the project in `folder` that Qwen Code stops to ask about as it starts with YOLO
 * off, for an agent of a launch as `config` has it in the environment `env` (0.25.3): those of its .mcp.json - written as
 * Claude Code reads one - and of the project's settings, their variables expanded, that the person's approvals of the folder
 * do not decide; Facade's own, which its launch gives it, and one the administrator's settings or the launch's own name,
 * which it runs as theirs, aside.
 */
function undecidedProjectServers(config: CliConfig, folder: string, env: Environment): ProjectServer[] {
	const servers = new Map<string, JsonObject>();
	const file = readJsonFile(path.join(folder, '.mcp.json'));
	for (const [name, server] of Object.entries(file.kind === 'object' && isJsonObject(file.value.mcpServers) ? file.value.mcpServers : {})) {
		if (isJsonObject(server)) {
			servers.set(name, asQwenServer(server));
		}
	}
	const layers = launchLayers(config, env, folder);
	const serversOf = (scope: Layer['scope']) => layers.filter(layer => layer.scope === scope).flatMap(({ settings }) => isJsonObject(settings.mcpServers) ? Object.entries(settings.mcpServers) : []);
	for (const [name, server] of serversOf('project')) {
		if (isJsonObject(server)) {
			servers.set(name, expandedServer(server, env));
		}
	}
	for (const name of ['facade', ...serversOf('system').map(([each]) => each)]) {
		servers.delete(name);
	}
	const approvals = approvalsIn(approvalsFile(env, folder))[approvalsKey(folder)];
	return [...servers].filter(([name, server]) => {
		const record = isJsonObject(approvals) ? approvals[name] : undefined;
		return !isJsonObject(record) || record.hash !== approvalHash(server) || record.status === 'pending';
	}).map(([name, server]) => ({ name, server }));
}

/** The person's approvals in `file` as Qwen Code reads them, with `rejected` rejected for the project in `folder`: what an agent's run reads in their place. */
function approvalsForRun(file: string, folder: string, rejected: readonly ProjectServer[]): JsonObject {
	const approvals = approvalsIn(file);
	const key = approvalsKey(folder);
	const project = approvals[key];
	return { ...approvals, [key]: { ...isJsonObject(project) ? project : {}, ...Object.fromEntries(rejected.map(({ name, server }) => [name, { hash: approvalHash(server), status: 'rejected' }])) } };
}

/** The environment an agent of a launch as `config` has it starts in where its terminal's is not known: Facade's, with the home folder as its terminal has it, `home`, and the launch's variables over it. */
function launchEnvironment(config: CliConfig, home: string | undefined): Environment {
	return withVariables(withVariables({ ...process.env }, home !== undefined ? { [HOME_VARIABLE]: home } : {}), config.launch.environment);
}

/** What the file `file` holds; nothing where it cannot be read. */
function textOf(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/**
 * How Qwen Code's own Windows installer starts it, from `file`: its launcher on PATH, `bin\qwen.cmd`, calls the package's
 * `bin\qwen.cmd`, which runs the package's script with the Node it brings, telling it the path of that launcher - given so
 * directly, with no cmd.exe in between to take the person's Ctrl+C for its own and ask whether to end a batch job (L10).
 * Undefined for any other file.
 */
function installedTarget(file: string, platform: NodeJS.Platform): LaunchTarget | undefined {
	if (platform !== 'win32' || !/\.cmd$/i.test(file)) {
		return undefined;
	}
	const text = textOf(file);
	let called = /^\s*call\s+"(?<shim>[^"%]+\.cmd)"\s+%\*\s*$/im.exec(text)?.groups?.shim;
	// Written as the installer writes it, which in a folder whose name is not all ASCII need not be UTF-8: then the package's
	// where the installer puts it, in the folder beside the launcher's
	if (called !== undefined && !fs.existsSync(called) && /[\\/]qwen-code[\\/]bin[\\/]qwen\.cmd$/i.test(called)) {
		const beside = path.resolve(path.dirname(file), '..', 'qwen-code', 'bin', 'qwen.cmd');
		called = fs.existsSync(beside) ? beside : called;
	}
	const shim = called ?? file;
	const shimText = called === undefined ? text : textOf(called);
	if (!/^\s*set\s+"ROOT=%~dp0\.\."\s*$/im.test(shimText) || !/^\s*"%ROOT%\\node\\node\.exe"\s+"%ROOT%\\lib\\cli-entry\.js"\s+%\*\s*$/im.test(shimText)) {
		return undefined;
	}
	const root = path.resolve(path.dirname(shim), '..');
	const node = path.join(root, 'node', 'node.exe');
	const script = path.join(root, 'lib', 'cli-entry.js');
	return fs.existsSync(node) && fs.existsSync(script) ? { executable: node, args: [script], throughCmd: false, env: { QWEN_CODE_LAUNCHER_PATH: path.join(root, 'bin', 'qwen.cmd') } } : undefined;
}

/**
 * Qwen Code in its own UI. YOLO on: every tool without asking, its sandbox off - its --yolo leaves on the one the person's
 * QWEN_SANDBOX or tools.sandbox turns on, so the launch turns it off. YOLO off: Facade's server is trusted in its config, so
 * Facade's tools go unasked, and the rest is asked as the person's approval mode has it; its sandbox stays as the person set
 * it. It has no way to refuse unasked: an agent of it started through `start_agent` asks too, and can wait at an approval
 * nobody answers (AGENT-LAUNCHER.md, L4). Such an agent runs without the project's MCP servers the person has not approved
 * for its folder, which it would stop to ask about: they are rejected for its run in a copy of the person's approvals, theirs
 * left as they are (rule 3). Facade's server comes with the launch, in its run folder, and its skills go into the folder,
 * where it reads skills from `.agents/skills/`. Its MCP servers are connected before its first prompt, the notice of its
 * task, goes to the model, which it would otherwise send without them (QW-01). Its settings for the launch go in the scope
 * over all its others, merged over the administrator's as it merges its scopes: its effort, which no option of its takes; a
 * longer wait for a tool call than its settings give, where Facade waits longer; and - through `start_agent` - what keeps its
 * tips, its feedback survey and its questions about the IDE and the project's last session from it, and its update check
 * off; through `start_agent` its question tool is taken away too. Wherever an agent starts, the person's trust in its folder
 * goes into its trusted folders, as Qwen Code writes it when they answer its question - which it asks only where they turned
 * its folder trust on.
 */
export const qwenCli: AgentCli = {
	id: 'qwen',
	displayName: 'Qwen Code',
	setting: 'facade.agents.qwen',
	command: 'qwen',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				connect: ['--mcp-config', '${mcpConfig}'],
				// The files of its messages and of agents' screens, outside its folder: with YOLO off it would ask before reading one
				// there, and the next doorbell's Enter would answer for the person. One folder an option.
				messages: ['--include-directories', '${messagesDir}', '--include-directories', '${screensDir}'],
				yoloOn: ['--yolo'],
				model: ['--model', '${model}'],
				// With its option, as one argument: a notice is no option of its own, whatever it starts with. Not as its query,
				// which runs one prompt and exits.
				task: ['--prompt-interactive=${task}']
			},
			environment: {},
			// It trusts a folder and the folders inside it, so each worktree needs an entry of its own.
			trust: { file: '${configFile}', merge: { '${folder}': 'TRUST_FOLDER' } },
			// No option of its takes an effort.
			settings: { model: { reasoningEffort: '${effort}' } },
			// On Windows it ignores an Enter for half a second after a paste, which is how a line typed into it arrives (0.25.3).
			// Elsewhere, on the Node 20 or later it runs on, it does not: the one delay costs a line there the rest of a second.
			enterDelay: 1000,
			taskDelay: 2000,
			unattended: {
				arguments: {
					// Its ask_user_question would leave its terminal waiting for someone to pick an answer (L4)
					questions: ['--exclude-tools', 'ask_user_question']
				},
				environment: {},
				settings: {
					// What it would show over its input box - its tips, a next prompt it suggests and works on ahead, which an Enter in
					// an empty input box sends, and its survey of the session, which takes the keys of its scores - and its question
					// about the project's last session, which its first prompt waits behind
					ui: { hideTips: true, enableFollowupSuggestions: false, enableUserFeedback: false, enableWelcomeBack: false },
					// Its question whether to connect to the window, which it takes for the editor it would integrate with
					ide: { hasSeenNudge: true },
					// One version for the agent's whole run: it would check for a newer one, and install it, as it starts.
					general: { enableAutoUpdate: false }
				}
			}
		}
	},
	trustValues: ({ folder }, env) => ({ configFile: trustFile(env, folder) }),
	// What would keep Facade's server - named facade in its config - from it, as it reads them for the launch: the person's own
	// options of its MCP servers, or else the settings' lists, the launch's own over the administrator's (AGENT-ORCHESTRATION.md, O9)
	conflict(args, folder, env, config) {
		if (!args.includes('--mcp-config')) {
			return undefined;
		}
		const options = `${qwenCli.setting}.launch.arguments`;
		const disabled = optionValues(args, 'disable-mcp-server')?.find(each => namesIt(each, 'facade'));
		if (disabled !== undefined) {
			return `${options} turns off the MCP server named facade (--disable-mcp-server ${disabled}), so Qwen Code would not load Facade tools. Remove that value.`;
		}
		const layers = launchLayers(config, env, folder);
		// The servers its option allows, whose list it takes in place of its settings' lists
		const allowed = optionValues(args, 'allowed-mcp-server-names');
		if (allowed !== undefined) {
			if (!allowed.some(each => namesIt(each, 'facade'))) {
				return `${options} limits Qwen Code to the MCP servers in --allowed-mcp-server-names, which does not include facade, so Qwen Code would not load Facade tools. Add "facade" to --allowed-mcp-server-names.`;
			}
		} else {
			for (const { source, settings } of layers) {
				const pattern = listOf(settings, 'mcp.excluded', 'excludeMCPServers').find(each => namesIt(each, 'facade'));
				if (pattern !== undefined) {
					return `${source} excludes the MCP server named facade (mcp.excluded contains ${JSON.stringify(pattern)}), so Qwen Code would not load Facade tools. Remove that entry.`;
				}
			}
			// The lists of all its scopes together, an empty one among them, allow only the servers in them
			const allowing = layers.filter(({ settings }) => ['mcp.allowed', 'allowMCPServers'].some(key => Array.isArray(valueAt(settings, key))));
			if (allowing.length && !allowing.some(({ settings }) => listOf(settings, 'mcp.allowed', 'allowMCPServers').some(each => namesIt(each, 'facade')))) {
				return `${allowing.map(each => each.source).join(' and ')} ${allowing.length === 1 ? 'limits' : 'limit'} Qwen Code to the MCP servers in mcp.allowed, which does not include facade, so Qwen Code would not load Facade tools. Add "facade" to mcp.allowed.`;
			}
		}
		// Its tool sandbox, which the project's settings cannot set, refuses to start with an MCP server, a task or more folders (0.25.3)
		const sandboxed = layers.find(({ settings, scope }) => scope !== 'project' && valueAt(settings, 'tools.executionSandbox') !== undefined);
		if (sandboxed) {
			return `${sandboxed.source} sets tools.executionSandbox, with which Qwen Code refuses to start with Facade's MCP server, task and folders. Remove that setting to use Qwen Code as a Facade agent.`;
		}
		return undefined;
	},
	// A rule that denies one of Facade's tools in the settings it reads for the launch: the launch's own first, then the highest scope's
	exemptionOverride: (config, env, folder) => {
		for (const { source, settings } of launchLayers(config, env, folder).reverse()) {
			const rule = listOf(settings, 'permissions.deny', 'tools.exclude', 'excludeTools').find(each => /^mcp__facade(?:__|$)/.test(each) || namesIt(each, 'mcp__facade__read_messages'));
			if (rule !== undefined) {
				return `${source} denies ${rule}`;
			}
		}
		return undefined;
	},
	// Those it would stop to ask about, with YOLO off through start_agent, which its launch rejects for the run (L4, rule 3)
	projectServersOff: (config, place, home, yolo, unattended) => yolo || !unattended ? [] : undecidedProjectServers(config, place.folder, launchEnvironment(config, home)).map(({ name }) => name),
	launchTarget: installedTarget,
	// Its sandbox as it decides it for the launch: by QWEN_SANDBOX in the environment it starts with - Facade's false with YOLO
	// on, the launch's own environment over that - else by the setting of the highest scope that has one, never the project's,
	// the launch's own over the administrator's; none where it runs in one already
	ownSandbox(config, yolo, env, folder) {
		const started = withVariables(withVariables(env, yolo ? { QWEN_SANDBOX: 'false' } : {}), config.launch.environment);
		if (variable(started, 'SANDBOX')) {
			return undefined;
		}
		const fromEnvironment = variable(started, 'QWEN_SANDBOX');
		if (fromEnvironment?.trim()) {
			return turnsSandboxOn(fromEnvironment) ? `QWEN_SANDBOX=${fromEnvironment.trim()} in its environment` : undefined;
		}
		for (const { source, settings, scope } of launchLayers(config, started, folder).reverse()) {
			const value = scope === 'project' ? undefined : valueAt(settings, 'tools.sandbox') ?? valueAt(settings, 'sandbox');
			if (value !== undefined && value !== null) {
				return turnsSandboxOn(value) ? `tools.sandbox in ${source}` : undefined;
			}
		}
		return undefined;
	},
	task: 'argument',
	// Its effort, which no option of its takes (L9)
	settingsTakeValues: true,
	// Its own, which the person turns on; neither launch does
	sandbox: { yoloOn: 'off', yoloOff: 'off' },
	exemption: 'precise',
	// No mode of its denies unasked what would ask: its auto mode lets a classifier decide, and asks where it cannot (L4)
	unattendedApprovals: 'asked',
	questionTool: 'removed',
	verified: '0.25.3',
	launch(input, executable) {
		const { connection } = input;
		const env = input.env ?? launchEnvironment(input.config, input.home);
		const mcpConfig = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsFile = path.join(input.runDir, `${input.slug}.settings.json`);
		const approvals = path.join(input.runDir, `${input.slug}.approvals.json`);
		const values = launchValues(input);
		// A wait of Facade's with no word for longer than its settings let a tool call go so - start_agent's - not cut off: its
		// setting, which goes over its variable, under the launch's own
		const waitMs = Number(connection?.values.waitMs ?? 0);
		const waits = connection && waitMs + 60_000 > idleTimeout(input.config, env, input.folder) ? { mcp: { toolIdleTimeoutMs: Math.min(TOOL_TIMEOUT_MS, waitMs + 60_000) } } : {};
		const own = mergedAsQwen(waits, settingsWithValues(input.config.launch.settings ?? {}, values));
		// Its launch's settings over the administrator's, which it reads from this file instead - and writes back to, as it reads
		// any: theirs is read, never given it
		const settings = Object.keys(own).length ? mergedAsQwen(administratorSettings(systemSettingsFile(env, input.folder)), own) : undefined;
		// The project's MCP servers nobody approved for the folder, with YOLO off through start_agent: rejected for the run, so
		// that it neither waits at its question about them nor has a doorbell's Enter approve one (L4, rule 3)
		const undecided = !input.yolo && input.unattended ? undecidedProjectServers(input.config, input.folder, env) : [];
		const computed: { [name: string]: string } = {
			// Its MCP servers connected before its first prompt goes: 0.25.3 otherwise connects them while that prompt runs,
			// which then goes to the model without Facade's tools (QW-01)
			...connection ? { QWEN_CODE_LEGACY_MCP_BLOCKING: '1' } : {},
			// With YOLO on, no sandbox: this variable wins over its --sandbox and its tools.sandbox (L4)
			...input.yolo ? { QWEN_SANDBOX: 'false' } : {}
		};
		// The run's files it reads in place of those the person's would name - over the launch's own variables, whose files are
		// read into them - and the system defaults where they were, beside the administrator's settings that file replaces
		const files: { [name: string]: string } = {
			...settings ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile, QWEN_CODE_SYSTEM_DEFAULTS_PATH: systemDefaultsFile(env, input.folder) } : {},
			...undecided.length ? { QWEN_CODE_MCP_APPROVALS_PATH: approvals } : {}
		};
		return {
			executable,
			args: launchArgs(qwenCli.setting + '.launch', input.config, { ...values, mcpConfig }, launchUses(input)),
			env: withVariables(withVariables(computed, input.config.launch.environment), files),
			cwd: input.folder,
			files: [
				...settings ? [{ path: settingsFile, content: JSON.stringify(settings, undefined, '\t') }] : [],
				...undecided.length ? [{ path: approvals, content: JSON.stringify(approvalsForRun(approvalsFile(env, input.folder), input.folder, undecided), undefined, '\t') }] : [],
				// Trusted: its tools go unasked whatever its approval mode, as each of its tools does that the person approved. Loaded
				// from the start: an MCP server's tools otherwise wait behind a search for them, and the first call of one fails (0.25.3)
				...connection ? [{ path: mcpConfig, content: JSON.stringify({ mcpServers: { facade: { command: connection.mcp.command, args: connection.mcp.args, env: connection.mcp.env, timeout: TOOL_TIMEOUT_MS, trust: true, alwaysLoadTools: true } } }, undefined, '\t') }] : []
			],
			injected: connection ? input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) })) : []
		};
	}
};
