/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { CliAdapter, sigintExit } from './adapter';
import { NO_TOOLS } from './tools';
import { Environment, variableOf } from './environment';
import { homeOf } from './executable';
import type { TrustTarget } from './trust';

/** The file Antigravity's CLI keeps its settings in, the folders it trusts among them, in the home folder of the environment `env`. */
export function antigravitySettingsFile(env: Environment, platform: NodeJS.Platform): string {
	return path.join(homeOf(env, platform), '.gemini', 'antigravity-cli', 'settings.json');
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
	displayName: 'Antigravity',
	setting: 'facade.antigravity',
	command: 'agy',
	groups: {
		yoloOn: ['--mode', 'accept-edits', '--dangerously-skip-permissions']
	},
	takes: { model: false, effort: false },
	values: () => ({}),
	tools: NO_TOOLS,
	trustTarget: (cwd, env, platform): TrustTarget => {
		const folder = workingDirectoryOf(cwd, env, platform);
		return { file: antigravitySettingsFile(env, platform), keys: ['trustedWorkspaces'], entry: { item: folder }, folder };
	},
	title: { names: ['Antigravity', 'agy'] },
	interruptExit: sigintExit
};
