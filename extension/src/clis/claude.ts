/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder, isEqualPath, realFolderOf } from '../base/files';
import { CliAdapter, sigintExit } from './adapter';
import { Environment, setVariable, variableOf } from './environment';
import { homeOf } from './executable';
import type { TrustTarget } from './trust';

/** Claude Code has a sandbox on macOS and Linux, not on Windows. */
function hasSandbox(platform: NodeJS.Platform): boolean {
	return platform !== 'win32';
}

/** The switch of Claude Code's that turns off its terminal titles, and with them its OSC 7501 status reports (CLIS-2.3). */
const TITLE_SWITCH = 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE';

/**
 * Claude Code's settings for one run, passed inline with `--settings`, which overrides the same keys of its settings files for
 * that session alone: no more than a run needs, so that the person's own settings stay in force (CLIS-1.3). Its title switch also
 * turns off its OSC 7501 status reports, which a run needs to show its activity (CLIS-2.3), and it reapplies `env` from its
 * settings files after launch, so the run's settings clear the switch too. With YOLO off its sandbox is turned on where it has one;
 * with YOLO on its sandbox is its own setting's, as YOLO maps to the permission bypass alone.
 */
export function claudeRunSettings(yolo: boolean, platform: NodeJS.Platform): object {
	return {
		env: { [TITLE_SWITCH]: '' },
		...!yolo && hasSandbox(platform) ? { sandbox: { enabled: true } } : {}
	};
}

/**
 * The file Claude Code keeps its global configuration in, found as Claude Code 2.1.312 finds it in the environment `env`:
 * `.config.json` in its folder - `CLAUDE_CONFIG_DIR`, else `~/.claude` - where an older version left one that holds something, else
 * `.claude.json`, named for a custom OAuth server where one is set, in `CLAUDE_CONFIG_DIR`, else in the home folder.
 */
export function claudeConfigFile(env: Environment, platform: NodeJS.Platform): string {
	const configured = variableOf(env, 'CLAUDE_CONFIG_DIR', platform);
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
 * The folder Claude Code keys a project's configuration and trust on for a run in `cwd` (2.1.312): the repository's main checkout -
 * for a linked worktree, the checkout whose Git directory it shares - else, outside any repository, `cwd` itself. Its real path in
 * Unicode NFC, with forward slashes and an upper-case drive on Windows.
 */
export function claudeProjectKey(cwd: string, platform: NodeJS.Platform): string {
	const real = canonicalFolder(cwd);
	const root = gitRootOf(real);
	const key = (root === undefined ? real : mainCheckoutOf(root)).normalize('NFC');
	return platform === 'win32' ? key.split('\\').join('/').replace(/^[a-z]:/, drive => drive.toUpperCase()) : key;
}

/**
 * Claude Code in its own UI (CLIS-1.3). YOLO on: its permissions bypassed, its sandbox as its own settings have it. YOLO off: its
 * sandbox on where it has one, its permission mode and rules its own. Every launch trusts its repository - or, outside any, its
 * folder - as accepting its trust question does: `hasTrustDialogAccepted` for the project in its global configuration (CLIS-3.3,
 * D62).
 */
export const claudeAdapter: CliAdapter = {
	id: 'claude',
	displayName: 'Claude Code',
	setting: 'facade.claude',
	command: 'claude',
	groups: {
		quiet: ['--settings', '${runSettings}'],
		yoloOn: ['--dangerously-skip-permissions']
	},
	values: input => ({
		runSettings: JSON.stringify(claudeRunSettings(input.yolo, input.platform))
	}),
	trustTarget: (cwd, env, platform): TrustTarget => {
		const folder = claudeProjectKey(cwd, platform);
		return { file: claudeConfigFile(env, platform), keys: ['projects', folder, 'hasTrustDialogAccepted'], entry: { value: true }, folder };
	},
	// The switch would also turn off its status reports; the run's --settings clears it for the files' copy (CLIS-2.3)
	adjustEnvironment: (env, platform) => setVariable(env, TITLE_SWITCH, null, platform),
	// ✳ while it waits, a Braille spinner frame while it works
	title: { decoration: /^[✳⠀-⣿]+\s*/u, names: ['Claude Code', 'claude'] },
	// YOLO off turns its sandbox on through the run's settings, where it has one; YOLO on leaves it to its own settings
	sandbox: (yolo, platform) => !hasSandbox(platform) ? { state: 'none' } : yolo ? { state: 'native' } : { state: 'on' },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--dangerously-skip-permissions'] } : { state: 'native' },
	interruptExit: sigintExit
};
