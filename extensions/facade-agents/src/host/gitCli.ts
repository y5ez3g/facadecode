/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isEqualPath } from '../base/files';
import { ListedWorktree, Repository } from '../core/ports';

/** How long a git command may take. */
const GIT_TIMEOUT_MS = 10_000;

/** A git command that failed, with what git said. */
class GitError extends Error {
	constructor(
		message: string,
		/** The code git exited with; undefined where it did not exit by itself - it did not start, or ran out of time. */
		readonly exitCode: number | undefined
	) {
		super(message);
		this.name = 'GitError';
	}
}

/** A git command's output, trimmed; it rejects with git's own words when the command fails. */
function runGit(git: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile(git, [...args], { windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
		if (err) {
			reject(new GitError(String(stderr).trim() || err.message, typeof err.code === 'number' && !err.killed ? err.code : undefined));
		} else {
			resolve(String(stdout).trim());
		}
	}));
}

/** Whether git failed for the folder being in no repository: the one failure that means none. */
function inNoRepository(err: unknown): boolean {
	return err instanceof GitError && /not a git repository/i.test(err.message);
}

/**
 * The repository `folder` is in, with `git`; undefined for a folder git says is in none. Its checkout
 * on a branch with no commit yet - in a repository with none, or a branch made with none - has no HEAD,
 * as has one whose branch git cannot read: no worktree is made from either. git failing for another
 * reason rejects with why: it is not "no repository", which would start a child beside its parent
 * instead.
 */
export async function repositoryIn(git: string, folder: string): Promise<Repository | undefined> {
	let dirs: string;
	try {
		dirs = await runGit(git, ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
	} catch (err) {
		if (inNoRepository(err)) {
			return undefined;
		}
		throw err;
	}
	const [gitDir, commonDir] = dirs.split(/\r?\n/);
	if (!gitDir || !commonDir) {
		throw new Error(`git did not say where the repository of ${folder} is.`);
	}
	let head: string | undefined;
	try {
		head = await runGit(git, ['-C', folder, 'rev-parse', '-q', '--verify', 'HEAD']);
	} catch (err) {
		// Its HEAD names no commit: git says so by its exit code alone. A timeout, or git failing otherwise,
		// is git's to say.
		if (!(err instanceof GitError && err.exitCode === 1)) {
			throw err;
		}
	}
	const main = path.dirname(path.normalize(commonDir));
	// The main checkout's worktree is its branch too; on a detached HEAD, it is its folder's name
	return { main, worktree: await branchIn(git, folder) ?? path.basename(isEqualPath(gitDir, commonDir) ? main : folder), head };
}

/**
 * The branch checked out in `folder`, as its HEAD names it - whether or not that branch has a commit, or
 * one git can read; undefined on a detached HEAD. git failing otherwise rejects with why.
 */
async function branchIn(git: string, folder: string): Promise<string | undefined> {
	try {
		return await symbolicHead(git, folder, ['--no-recurse']);
	} catch (err) {
		// A git before 2.41 does not know --no-recurse, and names the branch only where it can read it
		if (err instanceof GitError && err.exitCode === 129) {
			return symbolicHead(git, folder, []);
		}
		throw err;
	}
}

/** The branch HEAD names, `git symbolic-ref` given `options`; undefined on a detached HEAD, which git says by its exit code alone. */
async function symbolicHead(git: string, folder: string, options: readonly string[]): Promise<string | undefined> {
	try {
		return await runGit(git, ['-C', folder, 'symbolic-ref', ...options, '--short', '-q', 'HEAD']) || undefined;
	} catch (err) {
		if (err instanceof GitError && err.exitCode === 1) {
			return undefined;
		}
		throw err;
	}
}

/**
 * The worktrees of the repository whose main checkout is `main`, main first, as git lists them. One git
 * lists until it is pruned - its folder gone, or left without its `.git`, as git removing a worktree a
 * process is in leaves it on Windows - is a worktree no more: git 2.31 and later say it is prunable, and
 * its folder without a `.git` says so on any git.
 */
export async function worktreesIn(git: string, main: string): Promise<readonly ListedWorktree[]> {
	const listed = await runGit(git, ['-C', main, 'worktree', 'list', '--porcelain']);
	const worktrees: ListedWorktree[] = [];
	listed.split(/\r?\n\r?\n/).forEach(record => {
		const lines = record.split(/\r?\n/);
		const folder = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
		// A bare repository has no checkout of its own: its worktrees are those checked out of it.
		if (!folder || lines.includes('bare') || !fs.existsSync(path.join(folder, '.git'))) {
			return;
		}
		const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '');
		worktrees.push({ name: branch ?? path.basename(folder), ...(branch ? { branch } : {}), folder: path.normalize(folder) });
	});
	return worktrees;
}

/** Whether the repository whose main checkout is `main` has a branch called `branch`; git failing otherwise rejects with why. */
export async function hasBranchIn(git: string, main: string, branch: string): Promise<boolean> {
	try {
		await runGit(git, ['-C', main, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch (err) {
		// That there is none, git says by its exit code alone
		if (err instanceof GitError && err.exitCode === 1) {
			return false;
		}
		throw err;
	}
}

/**
 * The `info/exclude` of the repository `folder` is in, and the root of its worktree; undefined for a
 * folder in none. git failing otherwise rejects with why.
 */
export async function excludeIn(git: string, folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
	let found: string;
	try {
		found = await runGit(git, ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', '--show-toplevel']);
	} catch (err) {
		if (inNoRepository(err)) {
			return undefined;
		}
		throw err;
	}
	const [file, root] = found.split(/\r?\n/);
	if (!file || !root) {
		throw new Error(`git did not say where the info/exclude and the worktree of ${folder} are.`);
	}
	return { file: path.normalize(file), root: path.normalize(root) };
}

/**
 * Which of `files`, paths relative to `folder`, git tracks there: none in a folder git says is in no
 * repository. git failing otherwise rejects with why: taken for "none tracked", a file the repository
 * tracks would be written into.
 */
export async function trackedIn(git: string, folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
	const posix = (file: string) => file.split(path.sep).join('/');
	let listed: string[];
	try {
		// Relative to the folder, as it lists them; each file taken as it is, not as a pattern.
		listed = (await runGit(git, ['-C', folder, 'ls-files', '-z', '--', ...files.map(file => `:(literal)${posix(file)}`)])).split('\0');
	} catch (err) {
		if (inNoRepository(err)) {
			return new Set();
		}
		throw err;
	}
	return new Set(files.filter(file => listed.includes(posix(file))));
}

/**
 * Which of `files`, paths relative to `folder`, some worktree of its repository has - at the same place
 * from that worktree's root - as a file git neither tracks nor ignores. A worktree whose folder is gone,
 * or left without its `.git`, has none. git failing otherwise rejects with why: taken for none, a line in
 * the repository's `info/exclude` would leave a file of the person's for git to write over.
 */
export async function untrackedIn(git: string, folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
	let root: string;
	try {
		root = path.normalize(await runGit(git, ['-C', folder, 'rev-parse', '--show-toplevel']));
	} catch (err) {
		if (inNoRepository(err)) {
			return new Set();
		}
		throw err;
	}
	// Each file from its worktree's root, as every worktree has it; one outside the worktree has no line.
	const fromRoot = new Map<string, string>();
	for (const file of files) {
		const relative = path.relative(root, path.join(folder, file));
		if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
			fromRoot.set(relative.split(path.sep).join('/'), file);
		}
	}
	const found = new Set<string>();
	if (!fromRoot.size) {
		return found;
	}
	// Only worktrees there are: asked in a folder left without its `.git`, git would answer for whichever
	// repository holds the folder, if any
	for (const worktree of await worktreesIn(git, folder)) {
		const listed = await runGit(git, ['-C', worktree.folder, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...[...fromRoot.keys()].map(file => `:(literal)${file}`)]);
		for (const each of listed.split('\0')) {
			const file = fromRoot.get(each);
			if (file !== undefined) {
				found.add(file);
			}
		}
	}
	return found;
}
