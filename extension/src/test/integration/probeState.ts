/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Real probes use temporary CLI state; an opt-in test must not opt out of ARCHITECTURE-5.3. */
export function probeEnvironment(values: unknown, keepHome: boolean, claudeConfig?: string): { [name: string]: string } {
	if (keepHome) {
		throw new Error('FACADE_IT_REAL_HOME=keep is not supported: real probes require an isolated temporary CLI home.');
	}
	if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) {
		throw new Error('The real probe environment must be an object of string values.');
	}
	const env = { ...values } as { [name: string]: string };
	if (claudeConfig !== undefined) {
		env.CLAUDE_CONFIG_DIR = claudeConfig;
	}
	for (const [name, value] of Object.entries(env)) {
		if (/^(HOME|USERPROFILE|FACADE_.*|VSCODE_.*)$/i.test(name)) {
			throw new Error(`${name} cannot override the probe's isolated home or editor state.`);
		}
		if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|MUSE_CONFIG_DIR|PI_CODING_AGENT_DIR|OPENCODE_CONFIG(?:_DIR)?|XDG_(?:CONFIG|DATA|CACHE|STATE)_HOME)$/i.test(name)) {
			assertTemporaryState(value, name);
		}
	}
	return env;
}

export function assertTemporaryState(value: string, name: string): void {
	const temporary = [os.tmpdir(), ...(process.platform !== 'win32' ? ['/tmp'] : [])].filter(dir => fs.existsSync(dir)).map(dir => fs.realpathSync(dir));
	let target = path.resolve(value);
	const tail: string[] = [];
	while (!fs.existsSync(target)) {
		const parent = path.dirname(target);
		if (parent === target) {
			break;
		}
		tail.unshift(path.basename(target));
		target = parent;
	}
	const real = path.join(fs.realpathSync(target), ...tail);
	const inside = temporary.some(dir => {
		const relative = path.relative(dir, real);
		return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	});
	if (!value || !path.isAbsolute(value) || !inside) {
		throw new Error(`${name} must name isolated state beneath the temporary directory; the owner's configuration is never used.`);
	}
}
