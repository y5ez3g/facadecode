/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

/**
 * Facade Code: a checkout's own git directory, where its HEAD is, and the repository's common one, where the
 * branches are. The IDE can be nested below the checkout root. In a linked worktree, `.git` is a file
 * naming its own directory.
 */
function gitDirectoriesOf(repo: string): { git: string; common: string } {
	let checkout = path.resolve(repo);
	while (!fs.existsSync(path.join(checkout, '.git')) && path.dirname(checkout) !== checkout) {
		checkout = path.dirname(checkout);
	}
	const dotGit = path.join(checkout, '.git');
	let pointer: string;

	try {
		pointer = fs.readFileSync(dotGit, 'utf8');
	} catch (e) {
		// A folder, as a checkout of its own has, or none
		return { git: dotGit, common: dotGit };
	}

	const match = /^gitdir: (?<dir>.+)$/m.exec(pointer);
	if (!match?.groups) {
		return { git: dotGit, common: dotGit };
	}

	const git = path.resolve(checkout, match.groups.dir.trim());
	try {
		return { git, common: path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()) };
	} catch (e) {
		// A submodule's git directory is one of its own
		return { git, common: git };
	}
}

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
export function getVersion(repo: string): string | undefined {
	const { git, common } = gitDirectoriesOf(repo);
	const headPath = path.join(git, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];
	const refPath = path.join(common, ref);

	try {
		return fs.readFileSync(refPath, 'utf8').trim();
	} catch (e) {
		// noop
	}

	const packedRefsPath = path.join(common, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}
