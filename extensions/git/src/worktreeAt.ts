/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import picomatch from 'picomatch';
import type { Uri } from 'vscode';
import { GitErrorCodes } from './api/git.constants';

/*
 * Facade Code: non-interactive worktree commands for the workspace bar, which asks its own questions
 * (WORKTREE.md section 6). All the logic is here, so an upstream merge meets two hunks in `commands.ts`:
 * the import, and the three commands.
 *
 * Nothing here needs `vscode` at runtime, so besides the extension host its tests also run under plain
 * mocha: `node ../../node_modules/mocha/bin/mocha --ui tdd out/test/worktreeAt.test.js`.
 */

/** What these commands need of git: the command centre's own runner, `Git.exec`. */
export interface IWorktreeGit {
	exec(cwd: string, args: string[], options?: { env?: { [key: string]: string } }): Promise<{ stdout: string }>;
}

type GitErrorCode = typeof GitErrorCodes[keyof typeof GitErrorCodes];

/**
 * Failures git has no code for. The workbench says each in its own words. `WorktreeLocked`'s message is why
 * the worktree was locked, empty where no reason was given.
 */
type WorktreeAtErrorCode =
	| 'InvalidArgument'
	| 'InheritedGitEnvironment'
	| 'UnreadableGitDirectory'
	| 'InitialBranch'
	| 'UnbornBranch'
	| 'NoIdentity'
	| 'WorktreeLocked';

/** A failure, in git's words, with a code when one is known. */
interface IWorktreeAtError {
	readonly kind: 'error';
	readonly code: GitErrorCode | WorktreeAtErrorCode | undefined;
	readonly message: string;
}

/**
 * `created`: what `.worktreeinclude` named that could not be copied, and git's words when its
 * post-checkout hook failed - which fails the command, though the worktree was made and git keeps it.
 * A failure says `branchKept` where the branch `-b` made is left, which could not be taken back.
 */
export type CreateWorktreeAtResult =
	| { readonly kind: 'created'; readonly copyFailures: readonly string[]; readonly hookFailure: string | undefined }
	| IWorktreeAtError & { readonly branchKept?: string };

/** `inspect` reports whether a worktree can be made from a folder; `initialize` makes it so. */
export type WorktreeBaseMode = 'inspect' | 'initialize';

/**
 * - `ready`: a repository with a commit to branch off from.
 * - `uninitialized`: no repository of its own; `enclosing` is the repository it sits inside, if any.
 * - `unborn`: a repository without a commit.
 *
 * `files` is how many files the initial commit would take, and `identity` whether git knows who would
 * make it - for a folder without a repository, undefined when that is for the repository to decide.
 */
export type WorktreeBaseAtResult =
	| { readonly kind: 'ready' }
	| { readonly kind: 'uninitialized'; readonly files: number; readonly identity: boolean | undefined; readonly enclosing: string | undefined }
	| { readonly kind: 'unborn'; readonly files: number; readonly identity: boolean }
	| IWorktreeAtError;

/**
 * `check`, `remove` and `force` act on a worktree; `leftover` on what a deletion left of one: a folder git no
 * longer lists, whose files could not all be deleted then.
 */
export type DeleteWorktreeMode = 'check' | 'remove' | 'force' | 'leftover';

/**
 * `checked` is what `check` returns: the files whose changes removing the worktree would lose, and whether it
 * has submodules checked out - which git removes only by force, with their git directories and any
 * commits in them that were not pushed. A failure says `partial` where the deletion went part way: git let go
 * of the worktree, and what is left of its folder is no worktree but what a deletion left, which `leftover` finishes.
 */
export type DeleteWorktreeAtResult =
	| { readonly kind: 'checked'; readonly files: readonly string[]; readonly submodules: boolean }
	| { readonly kind: 'removed' }
	| IWorktreeAtError & { readonly partial?: boolean };

/**
 * These commands return failures rather than throw: the command centre turns a thrown error into
 * a modal of its own, and the bar wants to say what went wrong itself.
 */
function toError(err: unknown): IWorktreeAtError {
	const failure = err as { gitErrorCode?: GitErrorCode; stderr?: string; message?: string } | undefined;
	const output = (failure?.stderr || failure?.message || String(err)).trim();

	// Upstream's `getGitErrorCode` expects "A branch named", which git 2.55 writes in lower case.
	const code = failure?.gitErrorCode ?? (/a branch named '.+' already exists/i.test(output) ? GitErrorCodes.BranchAlreadyExists : undefined);

	// Only git's reasons, not the progress it printed first.
	const reasons = output.split(/\r?\n/).filter(line => /^(?:fatal|error):/.test(line)).map(line => line.replace(/^(?:fatal|error):\s*/, ''));

	return { kind: 'error', code, message: reasons.length > 0 ? reasons.join(' ') : output };
}

/**
 * The path of a folder the workbench passed as a URI, spelled for the machine this extension host runs
 * on. The window may be on another OS than git, so it passes URIs, not paths. Anything that is not a
 * `file` URI is passed on as is, for `validateArguments` to refuse.
 */
export function folderPath(uri: Pick<Uri, 'scheme' | 'fsPath'> | undefined): string {
	return uri?.scheme === 'file' ? uri.fsPath : String(uri);
}

/** Variables that point git at a repository other than the one it runs in. */
const INHERITED_REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

/**
 * Why a command may not run, or `undefined` when it may.
 *
 * Paths must be absolute: any extension can run these commands, and a relative path would mean one
 * directory to git (relative to `root`) and another to `fs`. And the window must not have inherited
 * the variables above - git sets them for the editor it starts as `core.editor` - or every command
 * would act on that repository.
 */
function validateArguments(paths: readonly unknown[]): IWorktreeAtError | undefined {
	for (const candidate of paths) {
		if (typeof candidate !== 'string' || !isWholePath(candidate)) {
			return invalidArgument(`Not an absolute path: ${String(candidate)}`);
		}
	}

	const inherited = INHERITED_REPOSITORY_VARIABLES.filter(name => process.env[name]);
	if (inherited.length > 0) {
		return { kind: 'error', code: 'InheritedGitEnvironment', message: `This window was started with ${inherited.join(', ')} set, which points git at another repository.` };
	}

	return undefined;
}

function invalidArgument(message: string): IWorktreeAtError {
	return { kind: 'error', code: 'InvalidArgument', message };
}

/**
 * Whether a path is absolute. On Windows with its drive or share: `path.isAbsolute` also takes `\wt\x`,
 * which is relative to whichever drive is current.
 */
function isWholePath(candidate: string): boolean {
	return process.platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(candidate) : path.isAbsolute(candidate);
}

/** Whether an argument is a branch name at all; git decides whether it is a valid one. */
function isBranchName(branch: unknown): branch is string {
	return typeof branch === 'string' && branch.length > 0;
}

/** A full commit id, SHA-1 or SHA-256: never a ref name, and never something git could read as an option. */
function isCommitId(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/**
 * How a directory is deleted: whole, and retried while something still has a file in it open - for
 * about five and a half seconds, a tenth of a second longer each time.
 */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** Whether this OS's file systems ignore case by default. */
const IGNORES_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** The top level of the repository `root` is in, spelled the OS's way (git writes `/` on Windows too). */
async function getTopLevel(git: IWorktreeGit, root: string): Promise<string | undefined> {
	const { stdout } = await git.exec(root, ['rev-parse', '--show-toplevel']);
	// Only the line break comes off, as upstream's `getRepositoryRoot` has it: a folder's name can end in a space.
	const top = stdout.replace(/[\r\n]+$/, '');
	return top ? path.normalize(top) : undefined;
}

/**
 * A path to compare with another: links, junctions and short names resolved - git records a
 * worktree by its real path - and case folded where the OS ignores it. A path that is gone is resolved
 * through its parent.
 */
async function comparablePath(file: string): Promise<string> {
	let resolved: string;
	try {
		resolved = await fs.realpath(file);
	} catch {
		try {
			resolved = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
		} catch {
			resolved = path.resolve(file);
		}
	}

	resolved = resolved.replace(/[\\/]+$/, '');
	return IGNORES_CASE ? resolved.toLowerCase() : resolved;
}

async function isSameDirectory(a: string, b: string): Promise<boolean> {
	return await comparablePath(a) === await comparablePath(b);
}

/**
 * Whether `root` has a commit to branch a worktree off from, and with `initialize`, gives it one:
 * `git init` if it has no repository of its own, then an initial commit of everything `.gitignore`
 * does not exclude (WORKTREE.md WT-5.8).
 *
 * `inspect` changes nothing: without a repository, the files are counted against a scratch git
 * directory in the temp folder.
 *
 * "Of its own" is as git reads it: a folder inside another repository has none, and neither has one
 * whose `.git` git cannot read - there, git would find the repository above it instead.
 */
export async function prepareWorktreeBaseAt(git: IWorktreeGit, root: string, mode: WorktreeBaseMode, branch?: string): Promise<WorktreeBaseAtResult> {
	const refused = validateArguments([root]);
	if (refused) {
		return refused;
	}
	if (mode !== 'inspect' && mode !== 'initialize') {
		return invalidArgument(`Not a mode: ${String(mode)}`);
	}
	if (mode === 'initialize' && !isBranchName(branch)) {
		return invalidArgument(`Not a branch name: ${String(branch)}`);
	}

	try {
		const hasGitDirectory = await exists(path.join(root, '.git'));
		let top: string | undefined;
		try {
			top = await getTopLevel(git, root);
		} catch (err) {
			// A repository git refuses to open (dubious ownership) is git's to explain.
			const failure = toError(err);
			if (hasGitDirectory && failure.code === GitErrorCodes.NotASafeGitRepository) {
				return failure;
			}
		}
		const own = !!top && await isSameDirectory(top, root);
		if (hasGitDirectory && !own) {
			return { kind: 'error', code: 'UnreadableGitDirectory', message: `${path.join(root, '.git')} is not a repository git can read.` };
		}

		if (own && await hasHead(git, root)) {
			return { kind: 'ready' };
		}

		// A repository with history whose HEAD is on a branch without commits (`switch --orphan`) is not
		// one to give a first commit: that commit would take the folder's files onto somebody's branch.
		if (own && await hasCommits(git, root)) {
			return { kind: 'error', code: 'UnbornBranch', message: 'HEAD is on a branch with no commits, and the repository has commits on other branches.' };
		}

		if (mode === 'initialize' && branch) {
			return await initialize(git, root, own, branch);
		}

		if (own) {
			const { stdout } = await git.exec(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
			return { kind: 'unborn', files: countPaths(stdout), identity: await hasIdentity(git, root) };
		}

		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'facade-worktree-base-'));
		try {
			await git.exec(scratch, ['init', '-q']);
			const { stdout } = await git.exec(root, ['--git-dir', path.join(scratch, '.git'), '--work-tree', root, 'ls-files', '--others', '--exclude-standard', '-z']);
			return { kind: 'uninitialized', files: countPaths(stdout), identity: await identityBeforeInit(git, root), enclosing: top };
		} finally {
			try {
				await fs.rm(scratch, REMOVE_OPTIONS);
			} catch {
				// Still open (an indexer, say); the temp folder's to clear, and not a failure of this.
			}
		}
	} catch (err) {
		return toError(err);
	}
}

/**
 * `git init` if `root` has no repository of its own, then the initial commit.
 *
 * All or nothing for a folder without a repository: on any failure the `.git` this made is removed.
 * The branch is checked first - one git refuses, or the one the initial commit goes on - because the
 * worktree is only made after all this. The identity is asked again because the new repository's
 * configuration can answer differently.
 */
async function initialize(git: IWorktreeGit, root: string, own: boolean, branch: string): Promise<WorktreeBaseAtResult> {
	try {
		await git.exec(root, ['check-ref-format', '--branch', branch]);
	} catch (err) {
		return { ...toError(err), code: GitErrorCodes.InvalidBranchName };
	}

	try {
		if (!own) {
			await git.exec(root, ['init']);
		}

		// Case-insensitive where refs are: `Master` beside `master` is one file on Windows and macOS.
		const initial = (await git.exec(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
		if (IGNORES_CASE ? initial.toLowerCase() === branch.toLowerCase() : initial === branch) {
			return { kind: 'error', code: 'InitialBranch', message: `The initial commit goes on "${branch}", so the worktree needs a branch of another name.` };
		}

		if (!await hasIdentity(git, root)) {
			return { kind: 'error', code: 'NoIdentity', message: 'Git user name and email are not configured, and a commit requires them.' };
		}

		await git.exec(root, ['add', '-A']);
		await git.exec(root, ['commit', '--allow-empty', '-m', 'Initial commit']);
		return { kind: 'ready' };
	} catch (err) {
		return toError(err);
	} finally {
		if (!own && !await hasHead(git, root)) {
			try {
				await fs.rm(path.join(root, '.git'), REMOVE_OPTIONS);
			} catch {
				// The failure above is the one reported.
			}
		}
	}
}

/** How many paths a `-z` listing names. */
function countPaths(stdout: string): number {
	let paths = 0;
	for (let at = stdout.indexOf('\0'); at !== -1; at = stdout.indexOf('\0', at + 1)) {
		paths++;
	}
	return paths;
}

/**
 * Whether git knows who would make the first commit in `root`, which has no repository yet: undefined
 * when configuration is included on conditions (`includeIf`) that the repository `git init` has not
 * made yet decides. `initialize` asks again once it has.
 */
async function identityBeforeInit(git: IWorktreeGit, root: string): Promise<boolean | undefined> {
	if (await hasIdentity(git, root)) {
		return true;
	}

	try {
		await git.exec(root, ['config', '--get-regexp', '^includeif\\.']);
		return undefined;
	} catch {
		return false;
	}
}

/** Whether git knows the author and committer a commit here would need. */
async function hasIdentity(git: IWorktreeGit, root: string): Promise<boolean> {
	try {
		await git.exec(root, ['var', 'GIT_AUTHOR_IDENT']);
		await git.exec(root, ['var', 'GIT_COMMITTER_IDENT']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `ref` names a commit. Throws when git fails otherwise than to say it does not - an answer
 * that decides what is deleted, so "not sure" is never taken for "no".
 */
async function hasRef(git: IWorktreeGit, root: string, ref: string): Promise<boolean> {
	try {
		await git.exec(root, ['rev-parse', '--verify', '--quiet', ref]);
		return true;
	} catch (err) {
		// `--quiet` says "no" by failing with 1 and nothing else; anything else is git failing.
		const failure = err as { exitCode?: number; stderr?: string } | undefined;
		if (failure?.exitCode === 1 && !failure.stderr?.trim()) {
			return false;
		}
		throw err;
	}
}

function hasBranch(git: IWorktreeGit, root: string, branch: string): Promise<boolean> {
	return hasRef(git, root, `refs/heads/${branch}`);
}

function hasHead(git: IWorktreeGit, root: string): Promise<boolean> {
	return hasRef(git, root, 'HEAD');
}

/** Whether any ref names a commit. Throws when git fails. */
async function hasCommits(git: IWorktreeGit, root: string): Promise<boolean> {
	const { stdout } = await git.exec(root, ['rev-list', '-n', '1', '--all']);
	return stdout.trim().length > 0;
}

/**
 * `git worktree add -b <branch> <worktreePath> <startPoint>` in `root`, then `.worktreeinclude` - and
 * what `included` names: the paths in `root` that VS Code's `git.worktreeIncludeFiles` names, as the
 * repository finds them for its own Create Worktree, so that a worktree gets the same files whichever
 * way it is made (AGENT-ORCHESTRATION.md, O4). The start point is `HEAD` unless a commit is given, as
 * Facade's agents do for a child's worktree, which starts at its parent worktree's HEAD (WORKTREE.md,
 * WT-5.11).
 *
 * With `GIT_LFS_SKIP_SMUDGE=1`, so an LFS object that is missing does not fail the whole checkout
 * (WORKTREE.md section 2), then `git lfs checkout` to put back the objects that are here - it
 * downloads nothing.
 */
export async function createWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, branch: string, startPoint?: string, included?: () => Promise<Iterable<string>>): Promise<CreateWorktreeAtResult> {
	const refused = validateArguments([root, worktreePath]);
	if (refused) {
		return refused;
	}
	if (!isBranchName(branch)) {
		return invalidArgument(`Not a branch name: ${String(branch)}`);
	}
	if (startPoint !== undefined && !isCommitId(startPoint)) {
		return invalidArgument(`Not a commit id: ${String(startPoint)}`);
	}

	// `worktree add -b` makes the branch before it checks the path and checks out, and a failure after
	// that leaves the branch - which the next try, with the same name, is refused for.
	let existed: boolean;
	try {
		existed = await hasBranch(git, root, branch);
	} catch (err) {
		return toError(err);
	}
	// The commit the branch is made at, which it points at still unless something moved it since
	let start = startPoint;
	if (start === undefined) {
		try {
			start = (await git.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).stdout.trim() || undefined;
		} catch {
			// No commit at HEAD: git makes no branch at it either.
		}
	}

	let hookFailure: string | undefined;
	try {
		await git.exec(root, ['worktree', 'add', '-b', branch, '--', worktreePath, startPoint ?? 'HEAD'], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
	} catch (err) {
		// A failed checkout takes the half-made worktree away with it; only the post-checkout hook runs
		// after git has kept it. Listed now, it was made, and the hook's failure is said as a warning.
		const listed = await isListed(git, root, worktreePath);
		if (listed === true) {
			hookFailure = toError(err).message;
		} else {
			// The branch the failed checkout left is taken back where it is as `-b` made it, and no worktree has it -
			// by `update-ref` with that commit: `branch -d` refuses one whose commits no other branch has, as a child's
			// at its parent worktree's HEAD. Moved since, or with git unable to say, it is kept, and said (O4; OR-07).
			let branchKept: string | undefined;
			try {
				if (!existed && await hasBranch(git, root, branch)) {
					branchKept = branch;
					if (listed === false && start !== undefined) {
						await git.exec(root, ['update-ref', '-d', `refs/heads/${branch}`, start]);
						branchKept = undefined;
					}
				}
			} catch {
				// Not taken back: kept, and the failure above is the one reported, with it.
			}
			return { ...toError(err), ...(branchKept !== undefined ? { branchKept } : {}) };
		}
	}

	try {
		await git.exec(worktreePath, ['lfs', 'checkout']);
	} catch {
		// No Git LFS: the worktree keeps the pointers.
	}

	let copyFailures: readonly string[];
	try {
		copyFailures = await copyWorktreeInclude(git, root, worktreePath);
	} catch (err) {
		// The worktree is usable; a failed copy is reported, not fatal.
		copyFailures = [`.worktreeinclude: ${toError(err).message}`];
	}

	if (included) {
		try {
			copyFailures = [...copyFailures, ...await copyIntoWorktree(root, worktreePath, inRepository(root, await included()))];
		} catch (err) {
			copyFailures = [...copyFailures, `git.worktreeIncludeFiles: ${toError(err).message}`];
		}
	}

	return { kind: 'created', copyFailures, hookFailure };
}

/**
 * Removes a worktree, or with `check`, lists the files with changes that removing it would lose.
 * `remove` and `force` run `git worktree remove`, without and with `--force`. `leftover` deletes what a
 * deletion git finished left behind - only where git lists no worktree there and no repository or worktree
 * is in it, so that it never takes one that is still git's.
 */
export async function deleteWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, mode: DeleteWorktreeMode): Promise<DeleteWorktreeAtResult> {
	const refused = validateArguments([root, worktreePath]);
	if (refused) {
		return refused;
	}
	if (mode !== 'check' && mode !== 'remove' && mode !== 'force' && mode !== 'leftover') {
		return invalidArgument(`Not a mode: ${String(mode)}`);
	}

	const present = await exists(worktreePath);

	if (mode === 'leftover') {
		if (!present) {
			return { kind: 'removed' };
		}
		if (await isListed(git, root, worktreePath) !== false) {
			return toError(new Error(`${worktreePath} is a worktree git still lists, or git cannot say: it is not deleted as what a deletion left.`));
		}
		if (await holdsGit(worktreePath)) {
			return toError(new Error(`${worktreePath} has a repository or a worktree in it: it is not deleted as what a deletion left.`));
		}
		try {
			await fs.rm(await fs.realpath(worktreePath), REMOVE_OPTIONS);
			return { kind: 'removed' };
		} catch (err) {
			return { ...toError(err), partial: true };
		}
	}

	if (mode === 'check') {
		// Git deletes no locked worktree, by force or not: said here, before anything is closed or moved for it -
		// one whose folder went with the disk it is on too, as a lock is often for (OR-11)
		const listing = await listedAs(git, root, worktreePath);
		if (listing?.listed && listing.locked !== undefined) {
			return { kind: 'error', code: 'WorktreeLocked', message: listing.locked };
		}
		if (!present) {
			return { kind: 'checked', files: [], submodules: false };
		}

		try {
			// Read only, so without the index lock - as the extension's own status runs.
			const { stdout } = await git.exec(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=all'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
			return { kind: 'checked', files: parsePorcelain(stdout), submodules: await hasSubmodules(git, worktreePath) };
		} catch (err) {
			return toError(err);
		}
	}

	// `--force` only when asked for, for a missing folder too: git can see a folder this could not - one
	// it spells another way, or one this may not read - and then checks it for changes as for any other.
	const remove = mode === 'force' ? ['worktree', 'remove', '--force', '--', worktreePath] : ['worktree', 'remove', '--', worktreePath];

	if (!present) {
		// The record of a worktree whose folder was deleted by hand (WT-1.9). `worktree remove` forgets
		// this one; `worktree prune` would forget every worktree whose folder is missing right now.
		try {
			await git.exec(root, remove);
			return { kind: 'removed' };
		} catch (err) {
			return toError(err);
		}
	}

	// The directory itself, where `worktreePath` names it through a link: the link is not what git made,
	// and `fs.rm` would take only the link.
	let directory = worktreePath;
	try {
		directory = await fs.realpath(worktreePath);
	} catch {
		// Taken as given.
	}

	const listed = await isListed(git, root, worktreePath);
	try {
		await git.exec(root, remove);
	} catch (err) {
		// On Windows git can remove the files and the record, then fail on a directory something still
		// has open - the shell of a terminal disposed a moment ago, still exiting (WORKTREE.md section
		// 18.7). The directory is deleted below, waiting for it to be let go of - but only if this remove
		// is what took it off git's list.
		if (listed !== true || (await isListed(git, root, worktreePath)) !== false || !(await exists(directory))) {
			return toError(err);
		}
	}

	// Git can also succeed and leave the directory behind, with the links it did not follow. It is
	// deleted only when git listed it as a worktree before this (WT-4.5); `fs.rm` does not follow links.
	if (listed === true && await exists(directory)) {
		try {
			await fs.rm(directory, REMOVE_OPTIONS);
		} catch (err) {
			// Git let go of it: what is left is no worktree, but what a deletion left
			return { ...toError(err), partial: true };
		}
	}

	return { kind: 'removed' };
}

/** Whether `folder`, or a folder in it - links not followed - has a `.git`: a repository, or a worktree. */
async function holdsGit(folder: string): Promise<boolean> {
	for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
		if (entry.name === '.git' || (entry.isDirectory() && await holdsGit(path.join(folder, entry.name)))) {
			return true;
		}
	}
	return false;
}

/**
 * Whether `git worktree list` names `worktreePath`, or `undefined` when git cannot say. It decides
 * whether a directory may be deleted, so "not sure" is neither answer.
 */
async function isListed(git: IWorktreeGit, root: string, worktreePath: string): Promise<boolean | undefined> {
	return (await listedAs(git, root, worktreePath))?.listed;
}

/**
 * Whether `git worktree list --porcelain` names `worktreePath`, and where it does, why it is locked where it is - empty
 * for no reason given; undefined where git cannot say.
 */
async function listedAs(git: IWorktreeGit, root: string, worktreePath: string): Promise<{ readonly listed: false } | { readonly listed: true; readonly locked?: string } | undefined> {
	let stdout: string;
	try {
		({ stdout } = await git.exec(root, ['worktree', 'list', '--porcelain']));
	} catch {
		return undefined;
	}

	// A worktree's lines follow its `worktree <path>`: `locked`, or `locked <reason>`, among them
	const listed: { path: string; locked?: string }[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			listed.push({ path: line.slice('worktree '.length) });
		} else if (listed.length && (line === 'locked' || line.startsWith('locked '))) {
			listed[listed.length - 1].locked = line.slice('locked '.length);
		}
	}
	const [wanted, ...candidates] = await Promise.all([worktreePath, ...listed.map(each => each.path)].map(comparablePath));
	const index = candidates.indexOf(wanted);
	if (index === -1) {
		return { listed: false };
	}
	const found = listed[index];
	return { listed: true, ...(found.locked !== undefined ? { locked: found.locked } : {}) };
}

/**
 * Whether a worktree has submodules, by git's own test before a remove: its git directory has a
 * `modules` folder, or a submodule it declares is checked out.
 */
async function hasSubmodules(git: IWorktreeGit, worktreePath: string): Promise<boolean> {
	const modules = (await git.exec(worktreePath, ['rev-parse', '--git-path', 'modules'])).stdout.replace(/[\r\n]+$/, '');
	if (await exists(path.resolve(worktreePath, modules))) {
		return true;
	}

	let declared: string;
	try {
		declared = (await git.exec(worktreePath, ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'])).stdout;
	} catch {
		// No `.gitmodules`, or no submodule in it.
		return false;
	}

	// `<key>\n<path>\0` for each.
	const submodules = declared.split('\0').filter(entry => entry.length > 0).map(entry => entry.slice(entry.indexOf('\n') + 1));
	for (const submodule of submodules) {
		if (await exists(path.join(worktreePath, submodule, '.git'))) {
			return true;
		}
	}

	return false;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * The paths in `git status --porcelain -z`. A rename or copy, in either column, is followed by its
 * old path as an entry of its own.
 *
 * Not upstream's `GitStatusParser`, which leaves out a nested repository (`dir/`): removing the
 * worktree deletes that too, so it is among what would be lost.
 */
function parsePorcelain(stdout: string): string[] {
	const files: string[] = [];
	const entries = stdout.split('\0');
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) {
			continue;
		}

		files.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
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
 * Whether `file`, relative to the repository and with `/`, is included: as in gitignore, the last
 * matching rule wins, and an included directory includes everything under it.
 */
export function isWorktreeIncluded(rules: readonly IIncludeRule[], file: string, isDirectory: boolean): boolean {
	const parts = file.split('/');
	for (let depth = 1; depth < parts.length; depth++) {
		if (matchRules(rules, parts.slice(0, depth).join('/'), true)) {
			return true;
		}
	}

	return matchRules(rules, file, isDirectory);
}

function matchRules(rules: readonly IIncludeRule[], file: string, isDirectory: boolean): boolean {
	let included = false;
	for (const rule of rules) {
		if ((!rule.directoryOnly || isDirectory) && rule.matches(file)) {
			included = !rule.negated;
		}
	}

	return included;
}

/** Whether the worktree at `worktreePath` is there: its folder, with the `.git` file git gave it. */
async function isWorktreeThere(worktreePath: string): Promise<boolean> {
	try {
		await fs.lstat(path.join(worktreePath, '.git'));
		return true;
	} catch {
		return false;
	}
}

/**
 * Copies into the new worktree what the repository ignores and `.worktreeinclude` names (WORKTREE.md
 * section 8). Returns what failed to copy.
 *
 * The candidates are `git ls-files --others --ignored --exclude-standard --directory`, where a wholly
 * ignored directory is one entry, so a pattern does not reach into `node_modules`; copied as
 * `copyIntoWorktree` copies.
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

	const included: string[] = [];
	for (const candidate of candidates) {
		const isDirectory = candidate.endsWith('/');
		const relative = isDirectory ? candidate.slice(0, -1) : candidate;
		if (isWorktreeIncluded(rules, relative, isDirectory)) {
			included.push(relative);
		}
	}

	return copyIntoWorktree(root, worktreePath, included);
}

/** `paths`, absolute, relative to `root` with `/`: those in it alone. */
function inRepository(root: string, paths: Iterable<string>): string[] {
	const relatives: string[] = [];
	for (const each of paths) {
		const relative = path.relative(root, each);
		if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
			relatives.push(relative.split(path.sep).join('/'));
		}
	}
	return relatives;
}

/**
 * Copies `files` - each relative to `root` with `/`, a file or a folder with what is in it - into the new worktree:
 * over nothing that is there already, and nothing through a link - nor into a folder that is no worktree any more,
 * deleted while git made it: copying would make it again, holding the copies (N-66). Returns what failed to copy.
 */
async function copyIntoWorktree(root: string, worktreePath: string, files: readonly string[]): Promise<readonly string[]> {
	const failures: string[] = [];
	for (const relative of files) {
		const source = path.join(root, relative);
		const target = path.join(worktreePath, relative);
		if (!await isWorktreeThere(worktreePath)) {
			break;
		}
		try {
			const stat = await fs.lstat(source);
			if (stat.isSymbolicLink()) {
				continue;
			}

			await fs.mkdir(path.dirname(target), { recursive: true });
			if (stat.isDirectory()) {
				await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false, filter: async from => !(await fs.lstat(from)).isSymbolicLink() });
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
