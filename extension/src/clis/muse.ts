/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CliAdapter, sigintExit } from './adapter';
import * as fs from 'fs';
import * as path from 'path';
import { isJsonObject } from '../base/json';
import { homeOf } from './executable';
import { variableOf } from './environment';
import type { SessionIntegrationInput } from './identity';
import { museDataDir } from './history/muse';

/** Preserve the user's hook groups; managed and project hooks remain loaded by Muse itself. */
export function museSession({ file, hook, env, extra }: SessionIntegrationInput) {
	const xdg = variableOf(env, 'XDG_CONFIG_HOME');
	const settings = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), '.config'), 'muse', 'settings.json');
	let hooks: unknown;
	if (fs.existsSync(settings)) {
		let parsed: unknown;
		try { parsed = JSON.parse(fs.readFileSync(settings, 'utf8')); }
		catch { throw new Error(`Muse Code settings in ${settings} are not readable JSON.`); }
		hooks = isJsonObject(parsed) ? parsed.hooks : undefined;
	}
	const remaining: string[] = [];
	let overridden = false;
	for (let i = 0; i < extra.length; i++) {
		const start = i;
		const arg = extra[i] === '-c' || extra[i] === '--config' ? extra[++i] : extra[i].startsWith('--config=') ? extra[i].slice(9) : undefined;
		if (arg?.startsWith('hooks=')) {
			if (overridden) { throw new Error('Muse Code hooks configuration is repeated.'); }
			overridden = true;
			try { hooks = JSON.parse(arg.slice(6)); }
			catch { throw new Error('Muse Code per-launch hooks must be valid JSON.'); }
		} else { remaining.push(...extra.slice(start, i + 1)); }
	}
	if (hooks !== undefined && !isJsonObject(hooks)) { throw new Error(`Muse Code hooks in ${settings} must be an object.`); }
	const previous = isJsonObject(hooks) ? hooks : {};
	const merged = { ...previous };
	for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
		const groups = merged[event];
		if (groups !== undefined && !Array.isArray(groups)) { throw new Error(`Muse Code ${event} hooks in ${settings} must be an array.`); }
		merged[event] = [...(groups ?? []), { hooks: [{ type: 'command', command: hook, timeout: 5 }] }];
	}
	return { extra: remaining, args: ['-c', `hooks=${JSON.stringify(merged)}`],
		files: [{ file: path.join(file.replace(/\.json$/, '.d'), 'muse.json'), content: JSON.stringify({ data: museDataDir(env) }) }] };
}

/**
 * Muse Code in its own UI (CLIS-1.3). YOLO on: its tool approvals and its shell sandbox off for the run, `--disable-approval
 * --disable-sandbox` - not `--yolo`, which also withholds its question tool. YOLO off: its approvals and its sandbox as its own
 * configuration has them, the sandbox on unless that turns it off. Every launch trusts the folder it starts in for that launch alone
 * with `--trust-workspace`, as accepting its trust question would, writing nothing (CLIS-3.3, D62). On Windows its installer's
 * `muse.cmd` runs a PowerShell launcher that picks its current program, so it goes through cmd.exe, which takes these arguments
 * safely (CLIS-1.2). It reports its activity by OSC 7501 on Linux and macOS but sends nothing on Windows, where ptyd reads it from
 * its screen instead (CLIS-2.3, D80).
 */
export const museAdapter: CliAdapter = {
	id: 'muse',
	sessionIdentity: true,
	sessionIntegration: museSession,
	identityOptions: ['--no-session-log', '--continue', '--last'],
	displayName: 'Muse Code',
	setting: 'facade.muse',
	command: 'muse',
	groups: {
		resume: ['resume', '${sessionId}'],
		yoloOn: ['--disable-approval', '--disable-sandbox'],
		trust: ['--trust-workspace']
	},
	values: () => ({}),
	screenStatus: 'muse',
	title: { names: ['Muse Code', 'Muse', 'muse'] },
	sandbox: yolo => yolo ? { state: 'off', by: ['--disable-sandbox'] } : { state: 'native' },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--disable-approval'] } : { state: 'native' },
	interruptExit: sigintExit
};
