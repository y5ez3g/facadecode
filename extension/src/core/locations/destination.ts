/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { FolderNameProblem } from './problems';

// Where a new worktree goes (WORKTREES-2.2): pure, so the caller says which paths are taken.

/** The folder beside the main checkout `main` that its new worktrees go in: `<main-folder>.worktrees`. */
export function worktreesFolderOf(main: string): string {
	const resolved = path.resolve(main);
	return path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
}

/** The names Windows keeps for devices, with an extension or none: no folder can have one. */
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * The folder name of a worktree on `branch`: `prefix` (`git.branchPrefix`) taken off where the branch starts with it, then
 * `/` and every character Windows forbids in a file name replaced by `-`, on every OS, so one branch makes one folder name.
 */
export function branchFolderOf(branch: string, prefix: string): string {
	const unprefixed = prefix && branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
	// eslint-disable-next-line no-control-regex
	return unprefixed.replace(/[\\/<>:"|?*\x00-\x1f]/g, '-');
}

/** Why a worktree on `branch` cannot have a folder on some OS; undefined where it can. */
export function whyNotFolderName(branch: string, prefix: string): FolderNameProblem | undefined {
	const name = branchFolderOf(branch, prefix);
	const why = !name || name === '.' || name === '..' ? 'unusable' : /[. ]$/.test(name) ? 'trailing' : DEVICE_NAMES.test(name) ? 'device' : undefined;
	return why ? { kind: 'folder_name', name, why } : undefined;
}

/**
 * `<main-folder>.worktrees/<branch-folder>` for a new worktree on `branch` of the repository whose main checkout is `main`, with
 * `-1`, `-2` and so on after it while `taken` says a path is in use: nothing is ever overwritten.
 */
export function plannedDestination(main: string, branch: string, prefix: string, taken: (candidate: string) => boolean): string {
	const base = path.join(worktreesFolderOf(main), branchFolderOf(branch, prefix));
	let candidate = base;
	for (let n = 1; taken(candidate); n++) {
		candidate = `${base}-${n}`;
	}
	return candidate;
}
