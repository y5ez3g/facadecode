/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, constants as fsConstants, lstatSync } from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';

/*
 * Creating and removing a worktree for the workspace bar, without asking anything.
 *
 * Upstream's `git.createWorktree` and `git.deleteWorktree` open their own pickers and their own
 * modal, which cannot sit inside the bar's flow; the bar asks its questions itself and calls these.
 * They are Facade Code's only change to this extension, and the logic is all in this file so that a
 * merge from upstream has one line in `commands.ts` to look at (WORKTREE.md section 6).
 *
 * ⚠️ No runtime import of `./git`: that module imports `vscode`, and keeping this file free of it is
 * what lets its tests run in plain Node.
 */

/** What these commands need of git: the command centre's own runner, `Git.exec`. */
export interface IWorktreeGit {
	exec(cwd: string, args: string[], options?: { env?: { [key: string]: string }; input?: string }): Promise<{ stdout: string }>;
}

/** A failure, said in git's words. `code` is the extension's `GitErrorCodes` value when it recognised one. */
export interface IWorktreeAtError {
	readonly kind: 'error';
	readonly code: string | undefined;
	readonly message: string;
}

export type CreateWorktreeAtResult =
	| { readonly kind: 'created'; readonly path: string; readonly copyFailures: readonly string[] }
	| IWorktreeAtError;

export type DeleteWorktreeMode = 'check' | 'remove' | 'force';

export type DeleteWorktreeAtResult =
	| { readonly kind: 'dirty'; readonly files: readonly string[] }
	| { readonly kind: 'removed' }
	| IWorktreeAtError;

/**
 * ⚠️ The command centre wraps every command it registers, and a thrown error becomes its own modal
 * error box. These answer instead, so the bar can say what went wrong in its own words.
 */
function toError(err: unknown): IWorktreeAtError {
	const failure = err as { gitErrorCode?: string; stderr?: string; message?: string } | undefined;
	const output = (failure?.stderr || failure?.message || String(err)).trim();

	// ⚠️ Upstream's `getGitErrorCode` looks for "A branch named '...' already exists", and git writes
	// it with a lower-case "a" now - measured with git 2.55. Without this the bar cannot tell a taken
	// branch from any other failure, and cannot offer to go to it.
	const code = failure?.gitErrorCode ?? (/a branch named '.+' already exists/i.test(output) ? 'BranchAlreadyExists' : undefined);

	// Git's own sentence, without the progress it printed before it: "Preparing worktree (new branch
	// ...)" is what it was doing, not what went wrong.
	const reasons = output.split(/\r?\n/).filter(line => /^(?:fatal|error):/.test(line)).map(line => line.replace(/^(?:fatal|error):\s*/, ''));

	return { kind: 'error', code, message: reasons.length > 0 ? reasons.join(' ') : output };
}

/**
 * `git worktree add -b <branch> <worktreePath> HEAD` in `root`, then `.worktreeinclude`.
 *
 * ⚠️ With `GIT_LFS_SKIP_SMUDGE=1`: LFS files arrive as pointers, which is what a main checkout holds
 * when its LFS objects were never fetched - and a required smudge filter otherwise fails the whole
 * checkout on one missing object (WORKTREE.md section 18.1). Codex and Claude Code do the same.
 */
export async function createWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, branch: string): Promise<CreateWorktreeAtResult> {
	try {
		await git.exec(root, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
	} catch (err) {
		return toError(err);
	}

	let copyFailures: readonly string[];
	try {
		copyFailures = await copyWorktreeInclude(git, root, worktreePath);
	} catch (err) {
		// The worktree exists and is usable; only the copy went wrong, and that is said, not fatal.
		copyFailures = [`.worktreeinclude: ${toError(err).message}`];
	}

	return { kind: 'created', path: worktreePath, copyFailures };
}

/**
 * Removes a worktree, or says what removing it would lose.
 *
 * `check` removes nothing: it lists every file with changes, so the bar can name them before anyone
 * confirms. `remove` and `force` run `git worktree remove`, without and with `--force`.
 */
export async function deleteWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, mode: DeleteWorktreeMode): Promise<DeleteWorktreeAtResult> {
	const present = await exists(worktreePath);

	if (mode === 'check') {
		if (!present) {
			// A worktree whose folder is already gone has nothing left to lose.
			return { kind: 'dirty', files: [] };
		}

		try {
			const { stdout } = await git.exec(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=all']);
			return { kind: 'dirty', files: parsePorcelain(stdout) };
		} catch (err) {
			return toError(err);
		}
	}

	if (!present) {
		// Git's record without the folder, which deleting the folder by hand leaves behind.
		// `prune` is what forgets it (WT-1.9).
		try {
			await git.exec(root, ['worktree', 'prune']);
			return { kind: 'removed' };
		} catch (err) {
			return toError(err);
		}
	}

	const listed = await isListed(git, root, worktreePath);
	try {
		await git.exec(root, mode === 'force' ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath]);
	} catch (err) {
		// ⚠️ On Windows git can delete a worktree's files and its record and then fail on the directory
		// itself, because something still has it open - a shell whose working directory it was, an
		// indexer, the antivirus. Measured live: "error: failed to delete '...': Permission denied",
		// exit 1, and `git worktree list` without it. What is left is a directory git has let go of;
		// it is deleted below, with the waiting git does not do. Only when this remove is what took the
		// path off git's list: a path git never listed fails the same way and is not a worktree at all.
		// Any other failure is git's to report.
		if (listed !== true || (await isListed(git, root, worktreePath)) !== false || !(await exists(worktreePath))) {
			return toError(err);
		}
	}

	// ⚠️ Git can also report success and leave the directory behind: links it did not follow are left
	// where they were (WORKTREE.md section 18.7). Either way git has just confirmed the path was a
	// worktree, which is the only reason this ever deletes a directory (WT-4.5). `fs.rm` does not follow
	// links, so nothing outside the worktree is touched (section 18.5), and it retries a directory
	// that is still busy - for about five seconds, one tenth of a second longer each time.
	if (await exists(worktreePath)) {
		try {
			await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (err) {
			return toError(err);
		}
	}

	try {
		await git.exec(root, ['worktree', 'prune']);
	} catch {
		// The worktree is gone; a record prune could not clear is cleared by the next one.
	}

	return { kind: 'removed' };
}

/**
 * Whether `git worktree list` names `worktreePath`, or `undefined` when git cannot say. This decides
 * whether a directory may be deleted, so "not sure" is neither answer.
 */
async function isListed(git: IWorktreeGit, root: string, worktreePath: string): Promise<boolean | undefined> {
	const normalize = (file: string) => {
		const resolved = path.resolve(file).replace(/[\\/]+$/, '');
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};

	try {
		const { stdout } = await git.exec(root, ['worktree', 'list', '--porcelain']);
		const wanted = normalize(worktreePath);
		return stdout.split(/\r?\n/).some(line => line.startsWith('worktree ') && normalize(line.slice('worktree '.length)) === wanted);
	} catch {
		return undefined;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** The paths in `git status --porcelain -z`. A rename carries its old path as a second entry. */
function parsePorcelain(stdout: string): string[] {
	const files: string[] = [];
	const entries = stdout.split('\0');
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) {
			continue;
		}

		files.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') {
			index++;
		}
	}

	return files;
}

interface IIncludeRule {
	readonly negated: boolean;
	readonly directoryOnly: boolean;
	readonly matches: (file: string) => boolean;
}

/**
 * `.worktreeinclude`, read as gitignore reads a pattern file: `#` comments, `!` to negate, a trailing
 * `/` for directories only, and a pattern with no other `/` matching at any depth.
 */
export function parseWorktreeInclude(content: string): readonly IIncludeRule[] {
	const rules: IIncludeRule[] = [];
	for (const raw of content.split(/\r?\n/)) {
		let pattern = raw.trim();
		if (!pattern || pattern.startsWith('#')) {
			continue;
		}

		const negated = pattern.startsWith('!');
		if (negated) {
			pattern = pattern.slice(1);
		}

		const directoryOnly = pattern.endsWith('/');
		if (directoryOnly) {
			pattern = pattern.slice(0, -1);
		}

		const anchored = pattern.includes('/');
		if (pattern.startsWith('/')) {
			pattern = pattern.slice(1);
		}

		if (pattern) {
			rules.push({ negated, directoryOnly, matches: picomatch(anchored ? pattern : `**/${pattern}`, { dot: true }) });
		}
	}

	return rules;
}

/**
 * Whether `file` - a path relative to the repository, with `/` - is included.
 *
 * As gitignore decides: the last rule that matches wins, and a directory that is included brings
 * everything under it with it.
 */
export function isWorktreeIncluded(rules: readonly IIncludeRule[], file: string, isDirectory: boolean): boolean {
	const parts = file.split('/');
	for (let depth = 1; depth < parts.length; depth++) {
		if (decide(rules, parts.slice(0, depth).join('/'), true)) {
			return true;
		}
	}

	return decide(rules, file, isDirectory);
}

function decide(rules: readonly IIncludeRule[], file: string, isDirectory: boolean): boolean {
	let included = false;
	for (const rule of rules) {
		if ((!rule.directoryOnly || isDirectory) && rule.matches(file)) {
			included = !rule.negated;
		}
	}

	return included;
}

/**
 * Copies into the new worktree what is both ignored by the repository and named by its
 * `.worktreeinclude` - the file Claude Code, Codex and Trae read too (WORKTREE.md section 8).
 *
 * ⚠️ The candidates are what `git ls-files --others --ignored --exclude-standard --directory` lists: a
 * wholly ignored directory is one entry, so a pattern like `*.local.json` does not reach into
 * `node_modules`. Listing every ignored file instead took 9.8 s and 22 MB of output on this
 * repository. Claude Code draws its candidates the same way.
 *
 * ⚠️ Never over something git checked out, and never through a link. Returns what failed to copy.
 */
async function copyWorktreeInclude(git: IWorktreeGit, root: string, worktreePath: string): Promise<readonly string[]> {
	let content: string;
	try {
		content = await fs.readFile(path.join(root, '.worktreeinclude'), 'utf8');
	} catch {
		return [];
	}

	const rules = parseWorktreeInclude(content);
	if (rules.length === 0) {
		return [];
	}

	const { stdout } = await git.exec(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
	const candidates = stdout.split('\0').filter(entry => entry.length > 0);

	const failures: string[] = [];
	for (const candidate of candidates) {
		const isDirectory = candidate.endsWith('/');
		const relative = isDirectory ? candidate.slice(0, -1) : candidate;
		if (!isWorktreeIncluded(rules, relative, isDirectory)) {
			continue;
		}

		const source = path.join(root, relative);
		const target = path.join(worktreePath, relative);
		try {
			if ((await fs.lstat(source)).isSymbolicLink()) {
				continue;
			}

			await fs.mkdir(path.dirname(target), { recursive: true });
			if (isDirectory) {
				await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false, filter: from => !lstatSync(from).isSymbolicLink() });
			} else {
				await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
			}
		} catch (err) {
			if ((err as { code?: string }).code !== 'EEXIST') {
				failures.push(relative);
			}
		}
	}

	return failures;
}
