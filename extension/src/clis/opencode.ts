/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CliAdapter, sigintExit } from './adapter';
import * as fs from 'fs';
import * as path from 'path';
import { parse, ParseError } from 'jsonc-parser';
import { isJsonObject } from '../base/json';
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
export function openCodeSession({ file, env }: SessionIntegrationInput) {
	const read = (text: string, source: string) => {
		const errors: ParseError[] = [];
		const value: unknown = parse(text, errors, { allowTrailingComma: true });
		if (errors.length || !isJsonObject(value)) { throw new Error(`OpenCode configuration in ${source} is not a valid object.`); }
		return value;
	};
	const xdg = variableOf(env, 'XDG_CONFIG_HOME');
	const configDir = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), '.config'), 'opencode');
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
		yoloOn: ['--auto']
	},
	values: () => ({}),
	// `OpenCode` until a session has a title, then `OC | {title}`. Its reports title a session it has not named yet with its own
	// default, `New session - {ISO time}` - `Child session` for a subagent's - which its terminal title never shows
	title: { names: ['OpenCode', 'opencode', 'OC'], placeholder: /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
	sandbox: () => ({ state: 'none' }),
	// Its own permission configuration, whose defaults allow every tool, where YOLO is off (D79)
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--auto'] } : { state: 'native' },
	interruptExit: sigintExit
};
