/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyedMutex } from './async';
import { normalizePath } from './glob';

/*
 * The git the engine runs: always an argument array (ENGINEERING.md forbids command strings), in
 * English so output can be parsed, never prompting. Commands that move refs or add worktrees in one
 * repository queue behind each other, so parallel workers never race on `index.lock` or a ref lock.
 *
 * Nothing here rebases, resets hard or pushes (ENGINEERING.md), and the tests check it stays so.
 */

export class GitError extends Error {
	constructor(message: string, readonly args: readonly string[], readonly exitCode: number | string | null | undefined, readonly stderr: string) {
		super(message);
		this.name = 'GitError';
	}
}

export interface GitExecOptions {
	readonly env?: { readonly [name: string]: string };
	/** Exit codes that are answers rather than failures, such as 1 for `merge-base --is-ancestor`. */
	readonly okCodes?: readonly number[];
}

export class Git {

	private readonly locks = new KeyedMutex();

	constructor(private readonly gitPath: string = 'git', private readonly baseEnv: NodeJS.ProcessEnv = process.env) { }

	exec(cwd: string, args: readonly string[], options?: GitExecOptions): Promise<{ stdout: string; exitCode: number }> {
		const env: NodeJS.ProcessEnv = {
			...Object.fromEntries(Object.entries(this.baseEnv).filter(([name]) => !/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|ELECTRON_RUN_AS_NODE)$/i.test(name))),
			LC_ALL: 'C',
			LANGUAGE: 'en',
			GIT_TERMINAL_PROMPT: '0',
			GIT_OPTIONAL_LOCKS: '0',
			...options?.env
		};
		return new Promise((resolve, reject) => {
			execFile(this.gitPath, [...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
				const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
				if (error && !(typeof error.code === 'number' && options?.okCodes?.includes(error.code))) {
					reject(new GitError((stderr || error.message).trim(), args, error.code, stderr));
					return;
				}
				resolve({ stdout, exitCode });
			});
		});
	}

	/** Serializes ref and worktree changes in one repository. */
	exclusive<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
		return this.locks.run(normalizePath(path.resolve(repoRoot)).toLowerCase(), task);
	}

	async toplevel(cwd: string): Promise<string> {
		return (await this.exec(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
	}

	/** The commit `ref` names, or undefined if it names none. */
	async resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
		if (ref.startsWith('-')) {
			return undefined;
		}
		const { stdout, exitCode } = await this.exec(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { okCodes: [1] });
		return exitCode === 0 ? stdout.trim() : undefined;
	}

	async tree(cwd: string, commit: string): Promise<string> {
		return (await this.exec(cwd, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`])).stdout.trim();
	}

	async isValidBranchName(cwd: string, name: string): Promise<boolean> {
		if (name.startsWith('-')) {
			return false;
		}
		const { exitCode } = await this.exec(cwd, ['check-ref-format', '--branch', name], { okCodes: [1, 128] });
		return exitCode === 0;
	}

	async branchExists(cwd: string, name: string): Promise<boolean> {
		return (await this.resolveCommit(cwd, `refs/heads/${name}`)) !== undefined;
	}

	/** Creates `name` at `commit`. Fails if it exists. */
	async createBranch(repoRoot: string, name: string, commit: string): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['branch', '--no-track', '--end-of-options', name, commit]));
	}

	/**
	 * Moves `ref` from `expected` to `next`, and only from `expected`: git checks the old value under
	 * the ref's lock, so a ref someone else moved is never overwritten.
	 */
	async compareAndSwapRef(repoRoot: string, ref: string, next: string, expected: string, reason = 'facade: advance integration'): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['update-ref', '-m', reason, ref, next, expected]));
	}

	async mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
		const { stdout, exitCode } = await this.exec(cwd, ['merge-base', a, b], { okCodes: [1] });
		return exitCode === 0 ? stdout.trim() : undefined;
	}

	async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
		const { exitCode } = await this.exec(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [1] });
		return exitCode === 0;
	}

	/** Paths git tracks at `commit`, relative to the repository root. */
	async trackedFiles(cwd: string, commit: string): Promise<string[]> {
		const { stdout } = await this.exec(cwd, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit]);
		return stdout.split('\0').filter(Boolean);
	}

	/**
	 * Paths where the worktree's files differ from `base`, committed or not, untracked included, and
	 * renames counted twice. The files themselves are compared, so a merge in progress counts as what
	 * it leaves in the worktree.
	 */
	async changedPaths(worktree: string, base: string): Promise<string[]> {
		const tracked = (await this.exec(worktree, ['diff', '--name-only', '-z', '--no-renames', base, '--'])).stdout.split('\0');
		const untracked = (await this.exec(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0');
		return [...new Set([...tracked, ...untracked].filter(Boolean))].map(normalizePath).sort();
	}

	/** Paths changed between two commits. */
	async diffNames(cwd: string, from: string, to: string): Promise<string[]> {
		return (await this.exec(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'])).stdout.split('\0').filter(Boolean).map(normalizePath);
	}

	/** The patch between two commits, with `context` lines around each change. */
	async diffText(cwd: string, from: string, to: string, context = 3): Promise<string> {
		return (await this.exec(cwd, ['diff', '--no-color', '--no-ext-diff', `-U${context}`, from, to, '--'])).stdout;
	}

	async diffStat(cwd: string, from: string, to: string): Promise<string> {
		return (await this.exec(cwd, ['diff', '--no-color', '--stat=200', from, to, '--'])).stdout;
	}

	/** One line per commit reachable from `to` and not from `from`, oldest last. */
	async logOneline(cwd: string, from: string, to: string): Promise<string[]> {
		return (await this.exec(cwd, ['log', '--no-color', '--no-decorate', '--format=%h %s', `${from}..${to}`, '--'])).stdout.split('\n').filter(Boolean);
	}

	/** A commit's parents, in order. */
	async parents(cwd: string, commit: string): Promise<string[]> {
		return (await this.exec(cwd, ['rev-list', '--parents', '-n', '1', commit, '--'])).stdout.trim().split(/\s+/).slice(1);
	}

	/** A file's content at a commit, or undefined when it has none there. */
	async show(cwd: string, commit: string, file: string): Promise<string | undefined> {
		const { stdout, exitCode } = await this.exec(cwd, ['cat-file', '-p', `${commit}:${file}`], { okCodes: [128] });
		return exitCode === 0 ? stdout : undefined;
	}

	/** Lines of `commit` that contain `text`, as `path:line:content`. */
	async grep(cwd: string, commit: string, text: string, max = 50): Promise<string[]> {
		const { stdout } = await this.exec(cwd, ['grep', '-n', '-I', '-F', '--no-color', '-e', text, commit, '--'], { okCodes: [1] });
		return stdout.split('\n').filter(Boolean).slice(0, max).map(line => line.startsWith(`${commit}:`) ? line.slice(commit.length + 1) : line);
	}

	/** Whether a merge waits to be committed in this worktree. */
	async mergeInProgress(worktree: string): Promise<boolean> {
		const { exitCode } = await this.exec(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { okCodes: [1] });
		return exitCode === 0;
	}

	/** Paths git still marks as conflicted in this worktree. */
	async unmergedPaths(worktree: string): Promise<string[]> {
		return (await this.exec(worktree, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout.split('\0').filter(Boolean).map(normalizePath);
	}

	/**
	 * Merges `commit` into the worktree's branch with a merge commit. When it conflicts, the merge
	 * stays in progress, markers and all, for an agent to resolve, and the conflicted paths return.
	 */
	async merge(worktree: string, commit: string, message: string): Promise<{ conflicts: string[] }> {
		const { exitCode } = await this.exec(worktree, ['merge', '--no-ff', '--no-edit', '-m', message, commit], { okCodes: [1] });
		if (exitCode === 0) {
			return { conflicts: [] };
		}
		const conflicts = await this.unmergedPaths(worktree);
		if (!conflicts.length) {
			// Not a conflict: git refused, for example over local changes, and left nothing half done.
			throw new GitError(`git merge ${commit} did not merge and left no conflicts`, ['merge', commit], exitCode, '');
		}
		return { conflicts };
	}

	/** Moves the worktree's branch forward to `commit`; fails unless it is a fast-forward. */
	async fastForward(worktree: string, commit: string): Promise<void> {
		await this.exec(worktree, ['merge', '--ff-only', commit]);
	}

	/** Gives up a merge in progress, putting the worktree back as it was before it. */
	async abortMerge(worktree: string): Promise<void> {
		await this.exec(worktree, ['merge', '--abort']);
	}

	/**
	 * Checks `commit` out, detached, in a worktree that only Facade uses: whatever the last check left
	 * in tracked files is thrown away. Never used where a person or an agent works.
	 */
	async checkoutDetached(worktree: string, commit: string): Promise<void> {
		await this.exec(worktree, ['checkout', '--quiet', '--force', '--detach', commit]);
	}

	/** The worktree that has `branch` checked out, if any. */
	async branchCheckedOutAt(repoRoot: string, branch: string): Promise<string | undefined> {
		const { stdout } = await this.exec(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
		let current: string | undefined;
		for (const line of stdout.split('\0')) {
			if (line.startsWith('worktree ')) {
				current = line.slice('worktree '.length);
			} else if (line === `branch refs/heads/${branch}`) {
				return current;
			}
		}
		return undefined;
	}

	/** Whether tracked files in the worktree differ from its HEAD. Untracked files do not count. */
	async isDirty(worktree: string): Promise<string[]> {
		const { stdout } = await this.exec(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
		return stdout.split('\0').filter(entry => entry.length > 3).map(entry => normalizePath(entry.slice(3)));
	}

	/** Points an internal ref, such as `refs/facade/...`, at `commit`. Not for branches. */
	async setRef(repoRoot: string, ref: string, commit: string): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['update-ref', '-m', 'facade: stage a merge candidate', ref, commit]));
	}

	/** Deletes `ref`, and only while it still points at `expected`. */
	async deleteRef(repoRoot: string, ref: string, expected: string): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['update-ref', '-m', 'facade: clean up after shipping', '-d', ref, expected]));
	}

	/** Whether git tracks `file` in this worktree's index. */
	async isTracked(worktree: string, file: string): Promise<boolean> {
		const { exitCode } = await this.exec(worktree, ['ls-files', '--error-unmatch', '--', file], { okCodes: [1] });
		return exitCode === 0;
	}

	/** Puts one file of the worktree back as HEAD has it. For files Facade itself changed there. */
	async restoreFile(worktree: string, file: string): Promise<void> {
		await this.exec(worktree, ['restore', '--source=HEAD', '--worktree', '--', file]);
	}

	/** Removes a worktree git made; refuses one with changes in it. */
	async removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['worktree', 'remove', '--', worktreePath]));
	}

	/** Merges `commit` into the branch checked out in `worktree`: a merge commit, or one squashed commit. */
	async mergeWithMessage(worktree: string, commit: string, message: string, squash: boolean): Promise<void> {
		const file = path.join(os.tmpdir(), `facade-merge-${process.pid}-${Date.now()}.txt`);
		fs.writeFileSync(file, message);
		try {
			if (squash) {
				await this.exec(worktree, ['merge', '--squash', commit]);
				await this.exec(worktree, ['commit', '--quiet', '--no-verify', '-F', file]);
			} else {
				await this.exec(worktree, ['merge', '--no-ff', '--quiet', '-F', file, commit]);
			}
		} finally {
			fs.rmSync(file, { force: true });
		}
	}

	/** The remote `branch` tracks, else `origin` when there is one. */
	async remoteFor(repoRoot: string, branch: string): Promise<string | undefined> {
		const configured = (await this.exec(repoRoot, ['config', '--get', `branch.${branch}.remote`], { okCodes: [1] })).stdout.trim();
		if (configured) {
			return configured;
		}
		const remotes = (await this.exec(repoRoot, ['remote'])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
		return remotes.includes('origin') ? 'origin' : remotes[0];
	}

	/** Pushes `branch` to `remote` and makes it the upstream. Never forced. */
	async push(repoRoot: string, remote: string, branch: string): Promise<void> {
		await this.exec(repoRoot, ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
	}

	/** Lines added between two commits; for the secret scan. */
	async addedLines(cwd: string, from: string, to: string): Promise<string[]> {
		const { stdout } = await this.exec(cwd, ['diff', '--no-color', '--no-ext-diff', '-U0', from, to]);
		return stdout.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1));
	}

	async head(worktree: string): Promise<string> {
		return (await this.exec(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
	}

	async hasChanges(worktree: string): Promise<boolean> {
		return (await this.exec(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.length > 0;
	}

	/**
	 * Stages everything but `exclude` and commits it with the repository's own identity. Returns the
	 * new HEAD, or the old one when there was nothing to commit.
	 */
	async commitAll(worktree: string, message: string, exclude: readonly string[] = []): Promise<string> {
		await this.exec(worktree, ['add', '--all', '--', '.']);
		if (exclude.length) {
			// Files Facade put there for the agent never enter the feature's history.
			const present = exclude.filter(file => fs.existsSync(path.join(worktree, file)));
			if (present.length) {
				await this.exec(worktree, ['restore', '--staged', '--', ...present], { okCodes: [1] });
			}
		}
		const { exitCode } = await this.exec(worktree, ['diff', '--cached', '--quiet'], { okCodes: [1] });
		// A merge commits even when its tree is the one HEAD has: it records the other parent.
		if (exitCode === 0 && !await this.mergeInProgress(worktree)) {
			return this.head(worktree);
		}
		const file = path.join(os.tmpdir(), `facade-commit-${process.pid}-${Date.now()}.txt`);
		fs.writeFileSync(file, message);
		try {
			await this.exec(worktree, ['commit', '--quiet', '--no-verify', '-F', file]);
		} finally {
			fs.rmSync(file, { force: true });
		}
		return this.head(worktree);
	}

	/**
	 * Merges two commits without touching any worktree. Returns the merged tree, or the paths that
	 * conflict. Needs git 2.38 for `--write-tree`.
	 */
	async mergeTree(cwd: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
		const { stdout, exitCode } = await this.exec(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { okCodes: [1] });
		const [tree, ...rest] = stdout.split('\n').map(line => line.trim()).filter(Boolean);
		return { tree, conflicts: exitCode === 1 ? rest : [] };
	}

	/** Makes a commit of `tree` with these parents, touching no worktree and no ref. */
	async commitTree(cwd: string, tree: string, parents: readonly string[], message: string): Promise<string> {
		const file = path.join(os.tmpdir(), `facade-commit-${process.pid}-${Date.now()}.txt`);
		fs.writeFileSync(file, message);
		try {
			return (await this.exec(cwd, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-F', file])).stdout.trim();
		} finally {
			fs.rmSync(file, { force: true });
		}
	}

	/** `git worktree add -b <branch> <path> <startPoint>`, for tests and when the git extension is absent. */
	async addWorktree(repoRoot: string, worktreePath: string, branch: string, startPoint: string): Promise<void> {
		await this.exclusive(repoRoot, () => this.exec(repoRoot, ['worktree', 'add', '-b', branch, '--', worktreePath, startPoint], { env: { GIT_LFS_SKIP_SMUDGE: '1' } }));
	}

	/** Whether `worktreePath` is one of the repository's worktrees. */
	async hasWorktree(repoRoot: string, worktreePath: string): Promise<boolean> {
		const { stdout } = await this.exec(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
		const wanted = comparable(worktreePath);
		return stdout.split('\0').some(line => line.startsWith('worktree ') && comparable(line.slice('worktree '.length)) === wanted);
	}
}

function comparable(file: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(file);
	} catch {
		resolved = path.resolve(file);
	}
	const normalized = normalizePath(resolved);
	return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}
