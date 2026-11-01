/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { isJsonObject, JsonObject } from '../base/json';
import { nodeValue, parseJsonc } from '../base/jsonc';
import { CliAdapter, sigintExit } from './adapter';
import * as fs from 'fs';
import { parse, ParseError } from 'jsonc-parser';
import { homeOf } from './executable';
import { variableOf } from './environment';
import type { SessionIntegrationInput } from './identity';

/** Reads the selected TUI route, not shared server activity or subagent reports. No dependency on Solid internals. */
export const OPENCODE_SESSION_PLUGIN = `import fs from 'node:fs';
import path from 'node:path';
export default { id: 'facade.session', setup(ctx) {
  const file = process.env.FACADE_CODE_SESSION_FILE;
  if (!file || !path.isAbsolute(file)) return;
  let last;
  const capture = () => { try {
    const route = ctx.ui.router.current();
    if (route.type === 'plugin') return;
    const selected = route.type === 'session' && /^ses_[a-zA-Z0-9]+$/.test(route.sessionID) ? route.sessionID : null;
    const info = selected ? ctx.data.session.get(selected) : undefined;
    const cwd = info?.location?.directory ?? info?.directory;
    const session = typeof cwd === 'string' && path.isAbsolute(cwd) ? selected : null;
    const key = JSON.stringify([session, cwd]);
    if (key === last) return;
    const temp = file + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(temp, JSON.stringify({session_id: session, cwd, source: 'route'}), {mode: 0o600});
    fs.renameSync(temp, file);
    last = key;
  } catch {} };
  capture();
  const timer = setInterval(capture, 200);
  timer.unref?.();
  return () => clearInterval(timer);
} };
`;

/** CLI config's native merge replaces arrays. Carry its effective directives forward before adding this run's plugin. */
export function openCodeSession({ file, env, platform }: SessionIntegrationInput) {
	const read = (text: string, source: string) => {
		const errors: ParseError[] = [];
		const value: unknown = parse(text, errors, { allowTrailingComma: true });
		if (errors.length || !isJsonObject(value)) { throw new Error(`OpenCode configuration in ${source} is not a valid object.`); }
		return value;
	};
	const xdg = variableOf(env, 'XDG_CONFIG_HOME');
	const configDir = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env, platform), '.config'), 'opencode');
	const configFile = path.join(configDir, 'cli.json');
	const legacyFile = path.join(configDir, 'tui.json');
	const config = fs.existsSync(configFile) ? read(fs.readFileSync(configFile, 'utf8'), configFile) : {};
	const legacy = !fs.existsSync(configFile) && fs.existsSync(legacyFile) ? read(fs.readFileSync(legacyFile, 'utf8'), legacyFile) : {};
	const content = variableOf(env, 'OPENCODE_CLI_CONFIG_CONTENT');
	const overlay = content ? read(content, 'OPENCODE_CLI_CONFIG_CONTENT') : {};
	const legacyPlugins = Array.isArray(legacy.plugin) ? legacy.plugin.map(item => Array.isArray(item) ? { package: item[0], options: item[1] } : item) : [];
	if (isJsonObject(legacy.plugin_enabled)) {
		legacyPlugins.push(...Object.entries(legacy.plugin_enabled).map(([id, enabled]) => enabled ? id : `-${id}`));
	}
	const plugins = overlay.plugins ?? config.plugins ?? legacyPlugins;
	if (!Array.isArray(plugins)) { throw new Error(`OpenCode plugins in ${configFile} must be an array.`); }
	const directory = file.replace(/\.json$/, '.d');
	return {
		env: { OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ ...overlay, plugins: [...plugins, directory] }) },
		files: [
			{ file: path.join(directory, 'package.json'), content: JSON.stringify({ name: 'facade-session', type: 'module', exports: { './tui': './tui.mjs' } }) },
			{ file: path.join(directory, 'tui.mjs'), content: OPENCODE_SESSION_PLUGIN }
		]
	};
}
import { McpServer, SERVER_NAME, ToolsIntegration } from './tools';

/** OpenCode's inline configuration: read after its configuration files, it goes on them for the run alone (CLIS-1.2). */
export const OPENCODE_CONFIG = 'OPENCODE_CONFIG_CONTENT';

/** The run's skill, which its configuration names as instructions: a file of the run alone. */
const SKILL_PATH = path.join('skills', SERVER_NAME, 'SKILL.md');

/** How long one call to the server may take, in milliseconds: its default 30 seconds is shorter than a start may be. */
const CALL_MS = 3_600_000;

/**
 * The run's inline configuration: the server, its tools - named `facade_<tool>` - allowed whatever the person's own rules say, a rule
 * read later taking precedence, and the skill as instructions (CLIS-1.3, 2.2).
 */
export function openCodeConfig(server: McpServer, skill: string): JsonObject {
	return {
		mcp: { [SERVER_NAME]: { type: 'local', command: [server.command, ...server.args], environment: { ...server.env }, enabled: true, timeout: CALL_MS } },
		permission: { [`${SERVER_NAME}_*`]: 'allow' },
		instructions: [skill]
	};
}

/**
 * The inline configuration a run starts with: `ours` on the person's own `theirs`, where they set one - their servers, rules and
 * instructions kept, Facade's rule after theirs - and ours alone where they set none. Theirs is read as OpenCode reads it, comments
 * and trailing commas allowed; one that cannot be read so, or is no object, is undefined: it stays as it is, the run without the tools.
 */
export function mergedOpenCodeConfig(ours: string, theirs: string | undefined): string | undefined {
	if (theirs === undefined || theirs.trim() === '') {
		return ours;
	}
	let mine: unknown;
	try {
		mine = nodeValue(parseJsonc(theirs));
	} catch {
		return undefined;
	}
	const facade = JSON.parse(ours) as JsonObject;
	if (!isJsonObject(mine)) {
		return undefined;
	}
	const permission = typeof mine.permission === 'string' ? { '*': mine.permission } : isJsonObject(mine.permission) ? mine.permission : {};
	return JSON.stringify({
		...mine,
		mcp: { ...isJsonObject(mine.mcp) ? mine.mcp : {}, ...facade.mcp as JsonObject },
		permission: { ...permission, ...facade.permission as JsonObject },
		instructions: [...Array.isArray(mine.instructions) ? mine.instructions : [], ...facade.instructions as string[]]
	});
}

/**
 * OpenCode is given the server, its tools' permission and the skill in the run's own inline configuration, `OPENCODE_CONFIG_CONTENT`,
 * and runs with `--standalone`: its own server process, which reads that configuration - the background service the person's other
 * sessions share would not - and ends with the run (CLIS-2.2).
 */
const openCodeTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server, its tools allowed and the skill as instructions in the run\'s own OPENCODE_CONFIG_CONTENT, with --standalone so that the run has its own server process' },
	where: runDir => `${OPENCODE_CONFIG} of the run alone with --standalone, and the skill in ${path.join(runDir, SKILL_PATH)}`,
	inject: ({ server, skill, runDir }) => ({
		values: {},
		runFiles: [{ path: path.join(runDir, SKILL_PATH), content: skill }],
		project: [],
		env: { [OPENCODE_CONFIG]: JSON.stringify(openCodeConfig(server, path.join(runDir, SKILL_PATH))) }
	})
};

/**
 * OpenCode in its own UI, its 2.x line (CLIS-1.3, D78). YOLO on: `--auto`, which answers each of its permission questions for the
 * run - its `--yolo` and `--dangerously-skip-permissions` are the same switch - while a rule its configuration denies still holds.
 * YOLO off: its own permission configuration, whose defaults allow every tool (D79). It has no sandbox and asks no trust question,
 * so a launch is given none (CLIS-3.3). From 2.x it reports by OSC 7501 itself - its own record, and one for each session with the
 * session's `id`, which is not the run's (CLIS-2.3); 1.x sends no reports. npm's shim starts its native program (CLIS-1.2).
 */
export const openCodeAdapter: CliAdapter = {
	id: 'opencode',
	sessionIdentity: true,
	sessionIntegration: openCodeSession,
	displayName: 'OpenCode',
	setting: 'facade.opencode',
	command: 'opencode',
	identityOptions: ['--session', '-s', '--continue', '-c', '--fork'],
	groups: {
		resume: ['--session', '${sessionId}'],
		connect: ['--standalone'],
		yoloOn: ['--auto'],
		prompt: ['--prompt', '${prompt}']
	},
	// Its interface takes no model or effort option; its configuration's model applies
	takes: { model: false, effort: false },
	values: () => ({}),
	tools: openCodeTools,
	mergeVariable: (name, ours, theirs) => name === OPENCODE_CONFIG ? mergedOpenCodeConfig(ours, theirs) : ours,
	initialPrompt: { state: 'unverified', reason: 'the prompt as the value of --prompt, which starts the interactive session with it' },
	promptProblem: prompt => prompt.startsWith('-') ? 'OpenCode would read a prompt that starts with - as an option' : undefined,
	// Its input, recorded on macOS with OpenCode 2.1.4 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'opencode-frame', evidence: 'its input box, on its start screen and in a session: empty or its placeholder, a typed, pasted, long-paste, history or slash-command draft, while working, and gone behind its permission question and command palette' },
	sandbox: () => ({ state: 'none' }),
	// Its own permission configuration, whose defaults allow every tool, where YOLO is off (D79)
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--auto'] } : { state: 'native' },
	interruptExit: sigintExit
};
