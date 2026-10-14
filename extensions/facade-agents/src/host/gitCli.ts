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

/**
 * A git command's output - trimmed, unless `trim` is false: output whose first character counts, as a
 * status's - it rejects with git's own words when the command fails.
 */
function runGit(git: string, args: readonly string[], trim = true): Promise<string> {
	// Every command of Facade's reads, so none takes a lock that is optional: the index's, which `status`
	// takes to refresh it, would make the person's own git command fail meanwhile (X-69)
	return new Promise((resolve, reject) => execFile(git, [...args], { windowsHide: true, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
		if (err) {
			reject(new GitError(String(stderr).trim() || err.message, typeof err.code === 'number' && !err.killed ? err.code : undefined));
		} else {
			resolve(trim ? String(stdout).trim() : String(stdout));
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
		throw new Error(`Git did not return a repository path for '${folder}'.`);
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
	// The main checkout, and a folder in it, has the repository's own git directory; a worktree git added has one of its own.
	const mainCheckout = isEqualPath(gitDir, commonDir);
	return { main, mainCheckout, worktree: await branchIn(git, folder) ?? path.basename(mainCheckout ? main : folder), head };
}

/**
 * The folder of the worktree `folder` is in, its top level: the way up from `folder` git gives, so that it is written as
 * `folder` is, links and all, not as git resolves them; undefined outside a work tree - in no repository, or in one's git
 * directory or a bare one (O5 step 1; OR-09).
 */
export async function worktreeRootIn(git: string, folder: string): Promise<string | undefined> {
	let answer: string;
	try {
		answer = await runGit(git, ['-C', folder, 'rev-parse', '--is-inside-work-tree', '--show-cdup']);
	} catch (err) {
		if (inNoRepository(err)) {
			return undefined;
		}
		throw err;
	}
	// Outside a work tree in a repository git does not fail: it says so, and gives no way up
	const [inside, up] = answer.split(/\r?\n/);
	return inside === 'true' ? path.resolve(folder, up ?? '') : undefined;
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
		throw new Error(`Git did not return the info/exclude path and worktree path for '${folder}'.`);
	}
	return { file: path.normalize(file), root: path.normalize(root) };
}

/**
 * Which of `files`, paths relative to `folder`, git tracks there - or, with `commit`, that commit of its
 * repository has, `folder` the root of a worktree of it: none in a folder git says is in no repository.
 * git failing otherwise rejects with why: taken for "none tracked", a file the repository tracks would
 * be written into.
 */
export async function trackedIn(git: string, folder: string, files: readonly string[], commit?: string): Promise<ReadonlySet<string>> {
	const posix = (file: string) => file.split(path.sep).join('/');
	let listed: string[];
	try {
		// Relative to the folder, as it lists them; each file taken as it is, not as a pattern. A commit's,
		// from the root of the repository.
		listed = (await runGit(git, commit === undefined
			? ['-C', folder, 'ls-files', '-z', '--', ...files.map(file => `:(literal)${posix(file)}`)]
			: ['-C', folder, 'ls-tree', '-r', '-z', '--name-only', '--full-tree', commit, '--', ...files.map(posix)])).split('\0');
	} catch (err) {
		if (inNoRepository(err)) {
			return new Set();
		}
		throw err;
	}
	return new Set(files.filter(file => listed.includes(posix(file))));
}

/** How many files a leftover's are checked against its branch: past that, none is taken as the branch's. */
const LEFTOVER_CHECKED = 200;

/**
 * The files what a deletion left of the worktree of `branch` at `folder` holds that the branch - of the
 * repository whose main checkout is `main` - does not hold as they are, relative to `folder` with forward
 * slashes: work, as its deletion would lose it. A link, and every file of a leftover too big to look at, is
 * counted as work; so is everything, where the branch is gone or git cannot read it.
 */
export async function leftoverWorkIn(git: string, main: string, branch: string, folder: string): Promise<readonly string[]> {
	const files: { readonly path: string; readonly link: boolean }[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else {
				files.push({ path: path.relative(folder, full).split(path.sep).join('/'), link: entry.isSymbolicLink() });
			}
		}
	};
	walk(folder);
	if (files.length > LEFTOVER_CHECKED) {
		return files.map(file => file.path);
	}
	const committed = new Map<string, string>();
	try {
		// `<mode> <type> <id>\t<path>\0` for each
		for (const entry of (await runGit(git, ['-C', main, 'ls-tree', '-r', '-z', '--full-tree', `refs/heads/${branch}`], false)).split('\0').filter(Boolean)) {
			const [meta, file] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
			committed.set(file, meta.split(' ')[2]);
		}
	} catch {
		return files.map(file => file.path);
	}
	const work: string[] = [];
	for (const file of files) {
		// As the branch would have it checked out there: its attributes' filters by its path
		const id = file.link ? undefined : await runGit(git, ['-C', main, 'hash-object', `--path=${file.path}`, '--', path.join(folder, file.path)]).catch(() => undefined);
		if (id === undefined || committed.get(file.path) !== id) {
			work.push(file.path);
		}
	}
	return work;
}

/** What `file`, a path from the repository's root, holds at `commit` of the repository of `folder`; undefined where the commit has no such file. */
export async function fileAtIn(git: string, folder: string, commit: string, file: string): Promise<string | undefined> {
	const posix = file.split(path.sep).join('/');
	if (!(await trackedIn(git, folder, [posix], commit)).has(posix)) {
		return undefined;
	}
	return runGit(git, ['-C', folder, 'cat-file', 'blob', `${commit}:${posix}`], false);
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

/**
 * Why `branch` cannot be a branch's name, as `git check-ref-format --branch` says - `a..b`, `x.lock`, a
 * name ending with a dot; undefined where it can.
 */
export async function whyNotBranchNameIn(git: string, main: string, branch: string): Promise<string | undefined> {
	try {
		await runGit(git, ['-C', main, 'check-ref-format', '--branch', branch]);
	} catch (err) {
		// git's no is its exit code; anything else - its time over, git missing - is no answer, and says so (X-57)
		if (err instanceof GitError && err.exitCode !== undefined) {
			return `Git rejects ${JSON.stringify(branch)} as a branch name`;
		}
		throw err;
	}
	// A branch is a file, and the branches under its name a folder of the same name: `a` and `a/b` cannot both be
	const branches = (await runGit(git, ['-C', main, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n').filter(Boolean).map(ref => ref.slice('refs/heads/'.length));
	const clash = branches.find(each => branch.startsWith(`${each}/`) || each.startsWith(`${branch}/`));
	return clash === undefined ? undefined : `branch '${clash}' already exists; Git cannot use the same name for both a branch and a branch-name prefix`;
}

/**
 * The submodules of the worktree `folder`, as git's own test before it removes one finds them: those checked
 * out, by path; else - none checked out - those whose repositories its git directory keeps, by name. Deleting
 * it takes them with it, with any of their commits not pushed.
 */
export async function submodulesIn(git: string, folder: string): Promise<readonly string[]> {
	let declared = '';
	try {
		declared = await runGit(git, ['-C', folder, 'config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'], false);
	} catch {
		// No .gitmodules, or no submodule in it
	}
	// `submodule.<name>.path\n<path>\0` for each
	const submodules = declared.split('\0').filter(entry => entry.length > 0).map(entry => {
		const key = entry.slice(0, entry.indexOf('\n'));
		return { name: key.slice('submodule.'.length, -'.path'.length), path: entry.slice(entry.indexOf('\n') + 1) };
	});
	const checkedOut = submodules.filter(submodule => fs.existsSync(path.join(folder, submodule.path, '.git'))).map(submodule => submodule.path);
	if (checkedOut.length) {
		return checkedOut;
	}
	const modules = path.resolve(folder, await runGit(git, ['-C', folder, 'rev-parse', '--git-path', 'modules']));
	if (!fs.existsSync(modules)) {
		return [];
	}
	// A name may hold slashes, its repository kept as folders within folders; one no longer declared, by what is there
	const kept = submodules.filter(submodule => fs.existsSync(path.join(modules, submodule.name))).map(submodule => submodule.name);
	return kept.length ? kept : fs.readdirSync(modules);
}

/**
 * The files deleting the worktree `folder` would lose: changed, staged and untracked, as `git status`
 * lists them - ignored files are git's to drop - relative to the worktree, with forward slashes.
 */
export async function changedFilesIn(git: string, folder: string): Promise<readonly string[]> {
	// Untrimmed: each entry starts with its two status columns, the first a space for a change not staged.
	const out = await runGit(git, ['-C', folder, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], false);
	const files: string[] = [];
	const entries = out.split('\0');
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) {
			continue;
		}
		files.push(entry.slice(3));
		// A rename or a copy names where it came from next.
		if (entry[0] === 'R' || entry[0] === 'C') {
			index++;
		}
	}
	return files;
}
