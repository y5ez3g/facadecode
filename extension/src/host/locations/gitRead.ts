/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WorktreeProblem } from '../../core/locations/problems';

// The Git calls of location discovery, worktree planning and worktree deletion (WORKTREES-3.2, 4.1, 4.2): argument arrays,
// never a shell; missing Git told apart from a failed read; Git's own diagnostic kept. All but `removeWorktree` only read.

/** How long one Git read may take before it counts as failed: a timeout leaves metadata stale (WORKTREES-1.3). */
const GIT_TIMEOUT_MS = 10_000;

/** How long `git worktree remove` may take: it deletes the worktree's whole folder, ignored files such as dependencies too. */
const GIT_REMOVE_TIMEOUT_MS = 300_000;

/** The variables that point Git at another repository than the one it finds from `-C`: an editor started from a hook can carry them. */
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX'];

/**
 * The program Git for Windows asks whether to try again to delete a file another program holds - a dialog, where a Git tool set one.
 * Without it Git asks no one, as no terminal is there, and fails as it does: no prompt is Facade's (WORKTREES-3.2, UX-1.1).
 */
const PROMPT_VARIABLES = ['GIT_ASK_YESNO'];

/** What Facade's Git reads its messages in, and how it takes the repository: answers in English, its optional locks not taken. */
const SET_VARIABLES: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', LANGUAGE: 'en' };

/**
 * The environment Facade runs Git in: `env` without the variables that would point it at another repository or have it ask anyone, with
 * its own language and locks. Their names are compared whatever their case, as Windows compares them.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const dropped = new Set([...REPOSITORY_VARIABLES, ...PROMPT_VARIABLES, ...Object.keys(SET_VARIABLES)]);
	return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !dropped.has(name.toUpperCase()))), ...SET_VARIABLES };
}

/**
 * `git worktree remove` of `worktree` in the repository whose shared Git directory is `commonDir`, without `--force` (WORKTREES-3.2): its
 * own check sees untracked files whatever the repository's status.showUntrackedFiles says, and on Windows it reaches the files deeper
 * than the 260 characters a path long had, as `node_modules` holds them.
 */
export function removeWorktreeArgs(commonDir: string, worktree: string, platform: NodeJS.Platform = process.platform): string[] {
	return [...platform === 'win32' ? ['-c', 'core.longpaths=true'] : [], '-C', commonDir, '-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove', '--', worktree];
}

/** The Git command `args` run, such as `worktree`: the first that is neither an option nor the value of `-C` or `-c`. */
function commandOf(args: readonly string[]): string | undefined {
	for (let at = 0; at < args.length; at++) {
		if (args[at] === '-C' || args[at] === '-c') {
			at++;
		} else if (!args[at].startsWith('-')) {
			return args[at];
		}
	}
	return undefined;
}

/** A Git call that failed, with what Git said. */
export class GitError extends Error {
	constructor(
		message: string,
		/** The code Git exited with; undefined where it did not exit by itself: it did not start, or ran out of time. */
		readonly exitCode: number | undefined,
		/** Whether there is no Git to run at all (WORKTREES-1.1): normal and silent, never a failed read. */
		readonly missing = false
	) {
		super(message);
		this.name = 'GitError';
	}
}

/**
 * The Git to run, as the editor's Git integration finds it (UX-4.2): the first `git.path` entry that is a file, else
 * `git` on the PATH; undefined where that is no Git. On macOS, `/usr/bin/git` without the Command Line Tools only offers
 * to install them, which is no setup prompt Facade may cause (WORKTREES-1.1, VERIFICATION J01).
 */
export async function gitExecutableOf(setting: unknown, isFile: (file: string) => boolean = isFileAt): Promise<string | undefined> {
	const hints = (typeof setting === 'string' ? [setting] : Array.isArray(setting) ? setting : []).filter((hint): hint is string => typeof hint === 'string' && hint.trim() !== '');
	const configured = hints.find(hint => isFile(hint));
	if (configured) {
		return configured;
	}
	return await isInstallerStub() ? undefined : 'git';
}

function isFileAt(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** Whether `git` on the PATH is macOS's installer stub: `/usr/bin/git` while `xcode-select -p` says no developer directory. */
let installerStub: Promise<boolean> | undefined;
function isInstallerStub(): Promise<boolean> {
	if (process.platform !== 'darwin') {
		return Promise.resolve(false);
	}
	const found = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'git')).find(isFileAt);
	if (found !== '/usr/bin/git') {
		return Promise.resolve(false);
	}
	installerStub ??= new Promise(resolve => execFile('xcode-select', ['-p'], { timeout: GIT_TIMEOUT_MS }, err => resolve(typeof err?.code === 'number' && err.code === 2)));
	return installerStub;
}

/** Git's output; rejects with a `GitError` carrying Git's own words. `input`, where given, is what Git reads on its standard input. */
function runGit(git: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS, input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(git, [...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: gitEnvironment() }, (err, stdout, stderr) => {
			if (!err) {
				resolve(String(stdout));
			} else if (err.code === 'ENOENT') {
				reject(new GitError(`Git was not found: ${git}`, undefined, true));
			} else if (typeof err.code === 'number') {
				reject(new GitError(String(stderr).trim() || err.message, err.code));
			} else if (err.killed && err.code === null) {
				reject(new GitError(`Git did not answer within ${timeoutMs / 1000} seconds (git ${commandOf(args)}).`, undefined));
			} else {
				reject(new GitError(String(stderr).trim() || err.message, undefined));
			}
		});
		if (input !== undefined) {
			// Git that ends before it read everything closes its end: that is its answer, not a failure of this write
			child.stdin?.on('error', () => undefined);
			child.stdin?.end(input);
		}
	});
}

/** The lines of Git's output, without the line break that ends the last. */
function linesOf(output: string): string[] {
	return output.replace(/\r?\n$/, '').split(/\r?\n/);
}

/** Whether Git answered that the folder is in no repository: normal and silent (WORKTREES-1.1). */
function isNoRepository(err: unknown): boolean {
	return err instanceof GitError && err.exitCode === 128 && /not a git repository/i.test(err.message);
}

/** Where Git places a folder that is in a work tree. */
export interface Checkout {
	/** The root of the worktree the folder is in, written as the folder was given - links kept - with Git's way up. */
	readonly root: string;
	/** The worktree's own Git directory. */
	readonly gitDir: string;
	/** The Git directory every worktree of the repository shares. */
	readonly commonDir: string;
}

/**
 * The checkout `folder` is in; undefined where it is in none: in no repository, or in a Git directory or a bare
 * repository, which have no work tree. Missing Git and a failed read reject with a `GitError`.
 */
export async function checkoutOf(git: string, folder: string): Promise<Checkout | undefined> {
	let answer: string;
	try {
		answer = await runGit(git, ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--is-inside-work-tree', '--show-cdup']);
	} catch (err) {
		if (isNoRepository(err)) {
			return undefined;
		}
		throw err;
	}
	let lines = linesOf(answer);
	// Git before 2.31 takes --path-format for a revision's flag and says it back, every answer a line down: asked again without
	// it, the directories it gives are from the folder asked in
	if (lines[0] === '--path-format=absolute') {
		try {
			lines = linesOf(await runGit(git, ['-C', folder, 'rev-parse', '--git-dir', '--git-common-dir', '--is-inside-work-tree', '--show-cdup']));
		} catch (err) {
			if (isNoRepository(err)) {
				return undefined;
			}
			throw err;
		}
	}
	const [gitDir, commonDir, inside, up] = lines;
	if (inside !== 'true') {
		return undefined;
	}
	if (!gitDir || !commonDir) {
		throw new GitError(`Git did not return the Git directories of '${folder}'.`, 0);
	}
	return { root: path.resolve(folder, up ?? ''), gitDir: path.resolve(folder, gitDir), commonDir: path.resolve(folder, commonDir) };
}

/** A registered worktree, as `git worktree list --porcelain` describes it. */
export interface ListedWorktree {
	readonly path: string;
	/** Whether it is the repository's main worktree: Git lists that first. */
	readonly main: boolean;
	/** A bare repository's own entry: no checkout. */
	readonly bare: boolean;
	readonly head?: string;
	/** The branch checked out, without `refs/heads/`; none on a detached HEAD. */
	readonly branch?: string;
	readonly detached: boolean;
	readonly locked: boolean;
	/** Git would prune it: its directory or its `.git` is gone. */
	readonly prunable: boolean;
}

/**
 * The worktrees registered in the repository whose shared Git directory is `commonDir`, from any tool (WORKTREES-1.2):
 * read in that directory, so a deleted worktree's own folder is not needed to ask. NUL-separated where Git can (2.36),
 * so a path may hold any character.
 */
export async function worktreesOf(git: string, commonDir: string): Promise<readonly ListedWorktree[]> {
	try {
		return parseWorktreeList(await runGit(git, ['-C', commonDir, 'worktree', 'list', '--porcelain', '-z']), true);
	} catch (err) {
		// A Git before 2.36 knows no `-z`: its usage error is its exit code alone
		if (err instanceof GitError && err.exitCode === 129) {
			return parseWorktreeList(await runGit(git, ['-C', commonDir, 'worktree', 'list', '--porcelain']), false);
		}
		throw err;
	}
}

/** `git worktree list --porcelain` output, NUL-separated (`-z`) or by lines. */
export function parseWorktreeList(output: string, nul: boolean): ListedWorktree[] {
	const records = nul ? output.split('\0\0') : output.split(/\r?\n\r?\n/);
	return records.map(record => record.split(nul ? '\0' : /\r?\n/).filter(Boolean)).filter(lines => lines.some(line => line.startsWith('worktree '))).map((lines, index) => {
		const value = (name: string) => lines.find(line => line === name || line.startsWith(`${name} `))?.slice(name.length + 1);
		const has = (name: string) => lines.some(line => line === name || line.startsWith(`${name} `));
		const branch = value('branch')?.replace(/^refs\/heads\//, '');
		const head = value('HEAD');
		return {
			path: path.normalize(value('worktree') ?? ''),
			main: index === 0,
			bare: has('bare'),
			...(head ? { head } : {}),
			...(branch ? { branch } : {}),
			detached: has('detached'),
			locked: has('locked'),
			prunable: has('prunable')
		};
	});
}

/**
 * The commit `ref` names at the checkout `folder`, as it stands now; undefined where it names none. A ref beginning with
 * `-` is never taken for an option (WORKTREES-2.1, 4.2).
 */
export async function resolveCommit(git: string, folder: string, ref: string): Promise<string | undefined> {
	try {
		const commit = (await runGit(git, ['-C', folder, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
		return /^[0-9a-f]{40,64}$/.test(commit) ? commit : undefined;
	} catch (err) {
		// That it names none, Git says by its exit code alone
		if (err instanceof GitError && err.exitCode === 1) {
			return undefined;
		}
		throw err;
	}
}

/** Whether the repository of `folder` has a branch called `branch`. */
export async function hasBranch(git: string, folder: string, branch: string): Promise<boolean> {
	try {
		await runGit(git, ['-C', folder, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch (err) {
		if (err instanceof GitError && err.exitCode === 1) {
			return false;
		}
		throw err;
	}
}

/**
 * Why `branch` cannot name a new branch of the repository of `folder`, as `git check-ref-format --branch` and the
 * existing branches say; undefined where it can. A name beginning with `-` is refused before Git could read it as an option.
 */
export async function whyNotBranchName(git: string, folder: string, branch: string): Promise<WorktreeProblem | undefined> {
	if (branch.startsWith('-')) {
		return { kind: 'branch_rejected', branch };
	}
	try {
		await runGit(git, ['-C', folder, 'check-ref-format', '--branch', branch]);
	} catch (err) {
		// Git's no is its exit code; anything else - a timeout, no Git - is no answer, and says so
		if (err instanceof GitError && err.exitCode !== undefined && !err.missing) {
			return { kind: 'branch_rejected', branch };
		}
		throw err;
	}
	// A branch is a file and the branches below its name a folder of that name: `a` and `a/b` cannot both be
	const branches = linesOf(await runGit(git, ['-C', folder, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).filter(Boolean).map(ref => ref.slice('refs/heads/'.length));
	const clash = branches.find(each => branch.startsWith(`${each}/`) || each.startsWith(`${branch}/`));
	return clash === undefined ? undefined : { kind: 'branch_prefix_clash', clash };
}

/**
 * Whether the worktree at `folder` holds anything not committed (D73): what `git status --porcelain` lists - a change or an
 * untracked file, whatever `status.showUntrackedFiles` says, and changes in submodules too, as `git worktree remove` checks - and a
 * file Git is told to assume unchanged or to skip whose content is not what its index holds, which `git status` does not show.
 */
export async function hasChanges(git: string, folder: string): Promise<boolean> {
	if ((await runGit(git, ['-C', folder, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'])).trim() !== '') {
		return true;
	}
	// `S` is skip-worktree, a lower-case tag assume-unchanged; one with no file in the folder - a sparse checkout's - is no edit
	const hidden = new Set((await runGit(git, ['-C', folder, 'ls-files', '-v', '-z'])).split('\0')
		.filter(entry => entry.length > 2 && (entry[0] === 'S' || (entry[0] >= 'a' && entry[0] <= 'z')))
		.map(entry => entry.slice(2))
		.filter(file => fs.existsSync(path.join(folder, file))));
	if (!hidden.size) {
		return false;
	}
	// Their index entries in one read, each found by its own name: a name given as a pathspec could match others, as `a[1]` does `a1`
	const indexed = new Map<string, { readonly mode: string; readonly object: string }>();
	for (const entry of (await runGit(git, ['-C', folder, 'ls-files', '-s', '-z'])).split('\0')) {
		const fields = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
		if (fields && hidden.has(fields[3])) {
			indexed.set(fields[3], { mode: fields[1], object: fields[2] });
		}
	}
	// A submodule's entry is its commit, not a file's content
	const files = [...hidden].filter(file => indexed.get(file)?.mode !== '160000');
	// Their content as Git would store it: in one call for every name a line can hold, a name with a line break alone
	const listed = files.filter(file => !/[\r\n]/.test(file));
	const now = listed.length ? linesOf(await runGit(git, ['-C', folder, 'hash-object', '--stdin-paths'], GIT_TIMEOUT_MS, `${listed.join('\n')}\n`)) : [];
	if (listed.some((file, at) => now[at] !== indexed.get(file)?.object)) {
		return true;
	}
	for (const file of files.filter(each => /[\r\n]/.test(each))) {
		if ((await runGit(git, ['-C', folder, 'hash-object', '--', file])).trim() !== indexed.get(file)?.object) {
			return true;
		}
	}
	return false;
}

/**
 * Removes the linked worktree at `worktree` from the repository whose shared Git directory is `commonDir`: `git worktree remove`
 * without `--force`, so Git itself refuses one with changes, a locked one and the main worktree (WORKTREES-3.2, D73). Its branch
 * is kept. Rejects with a `GitError` carrying Git's own words.
 */
export async function removeWorktree(git: string, commonDir: string, worktree: string): Promise<void> {
	await runGit(git, removeWorktreeArgs(commonDir, worktree), GIT_REMOVE_TIMEOUT_MS);
}
