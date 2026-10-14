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
 * (WORKTREE.md WT-4). All the logic is here, so an upstream merge meets two hunks in `commands.ts`:
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

/** Failures git has no code for. The workbench says each in its own words. */
type WorktreeAtErrorCode =
	| 'InvalidArgument'
	| 'InheritedGitEnvironment'
	| 'UnreadableGitDirectory'
	| 'InitialBranch'
	| 'UnbornBranch'
	| 'NoIdentity';

/** A failure, in git's words, with a code when one is known. */
interface IWorktreeAtError {
	readonly kind: 'error';
	readonly code: GitErrorCode | WorktreeAtErrorCode | undefined;
	readonly message: string;
}

/**
 * `created`: what `.worktreeinclude` named that could not be copied, and git's words when its
 * post-checkout hook failed - which fails the command, though the worktree was made and git keeps it.
 */
export type CreateWorktreeAtResult =
	| { readonly kind: 'created'; readonly copyFailures: readonly string[]; readonly hookFailure: string | undefined }
	| IWorktreeAtError;

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

export type DeleteWorktreeMode = 'check' | 'remove' | 'force';

/** A lock git holds a removal back for, with its reason. */
interface IWorktreeRestriction {
	readonly kind: 'locked';
	readonly reason: string;
}

/**
 * What `check` finds a removal would lose, or how a removal ended (WORKTREE.md WT-8.1).
 */
export type DeleteWorktreeAtResult =
	| { readonly kind: 'checked'; readonly files: readonly string[]; readonly ignoredPaths: readonly string[]; readonly submodules: boolean; readonly restrictions: readonly IWorktreeRestriction[] }
	| { readonly kind: 'removed' }
	| IWorktreeAtError;

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

/** The commit `ref` names, or undefined when it names none; git's other failures are thrown. */
async function resolveCommit(git: IWorktreeGit, root: string, ref: string): Promise<string | undefined> {
	if (!ref || ref.startsWith('-')) {
		return undefined;
	}

	try {
		const { stdout } = await git.exec(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
		return stdout.trim() || undefined;
	} catch (err) {
		// With --quiet, git says "no such commit" by exit code 1 and no output
		const failure = err as { exitCode?: number; stderr?: string };
		if (failure.exitCode === 1 && !failure.stderr?.trim()) {
			return undefined;
		}
		throw err;
	}
}

/**
 * Deletes the branch a failed create made, unless it is checked out or has moved from `expected`.
 * Returns its name when it is kept.
 */
async function dropBranchMadeHere(git: IWorktreeGit, root: string, branch: string, expected: string | undefined): Promise<string | undefined> {
	try {
		if (!(await hasBranch(git, root, branch))) {
			return undefined;
		}

		const { stdout } = await git.exec(root, ['worktree', 'list', '--porcelain']);
		const checkedOut = stdout.split(/\r?\n/).some(line => line === `branch refs/heads/${branch}`);
		if (checkedOut || !expected) {
			return branch;
		}

		await git.exec(root, ['update-ref', '-d', `refs/heads/${branch}`, expected]);
		return undefined;
	} catch {
		// Moved meanwhile, or git cannot say: kept.
		return branch;
	}
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
 * `git worktree add -b <branch> <worktreePath> <startPoint>` in `root`, then `.worktreeinclude`.
 * The start point is `HEAD` unless a commit is given, as Facade's agents do for a child's worktree,
 * which starts at its parent worktree's HEAD (WORKTREE.md, WT-5.11).
 *
 * With `GIT_LFS_SKIP_SMUDGE=1`, so an LFS object that is missing does not fail the whole checkout
 * (WORKTREE.md WT-4), then `git lfs checkout` to put back the objects that are here - it
 * downloads nothing.
 */
export async function createWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, branch: string, startPoint?: string): Promise<CreateWorktreeAtResult> {
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

	// Read first: a failed create deletes the branch only while it is still at this commit
	let startCommit: string | undefined;
	try {
		startCommit = await resolveCommit(git, root, startPoint ?? 'HEAD');
	} catch (err) {
		return toError(err);
	}
	if (!startCommit) {
		return invalidArgument(`Not a commit: ${startPoint ?? 'HEAD'}`);
	}

	// `worktree add -b` makes the branch before it checks out, so a failure can leave the branch behind
	let existed: boolean;
	let listedBefore: boolean | undefined;
	try {
		existed = await hasBranch(git, root, branch);
		listedBefore = await isListed(git, root, worktreePath);
	} catch (err) {
		return toError(err);
	}

	let hookFailure: string | undefined;
	try {
		await git.exec(root, ['worktree', 'add', '-b', branch, '--', worktreePath, startCommit], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
	} catch (err) {
		// Only the post-checkout hook fails after git keeps a worktree: listed now and not before, it was made
		if (listedBefore === false && await isListed(git, root, worktreePath) === true) {
			hookFailure = toError(err).message;
		} else {
			const failure = toError(err);
			const kept = !existed ? await dropBranchMadeHere(git, root, branch, startCommit) : undefined;
			return kept ? { ...failure, message: `${failure.message} The branch '${kept}' was preserved.` } : failure;
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

	return { kind: 'created', copyFailures, hookFailure };
}

/**
 * Removes a worktree, or with `check`, lists the files with changes that removing it would lose.
 * `remove` and `force` run `git worktree remove`, without and with `--force`.
 */
export async function deleteWorktreeAt(git: IWorktreeGit, root: string, worktreePath: string, mode: DeleteWorktreeMode): Promise<DeleteWorktreeAtResult> {
	const refused = validateArguments([root, worktreePath]);
	if (refused) {
		return refused;
	}
	if (mode !== 'check' && mode !== 'remove' && mode !== 'force') {
		return invalidArgument(`Not a mode: ${String(mode)}`);
	}

	const present = await exists(worktreePath);

	if (mode === 'check') {
		try {
			const restrictions = await restrictionsOf(git, root, worktreePath);
			if (!present) {
				return { kind: 'checked', files: [], ignoredPaths: [], submodules: false, restrictions };
			}

			// Read only, so without the index lock - as the extension's own status runs.
			const readOnly = { env: { GIT_OPTIONAL_LOCKS: '0' } };
			const { stdout } = await git.exec(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=all'], readOnly);
			// Ignored files go with the directory; a wholly ignored directory is one entry (WT-8.2)
			const ignored = await git.exec(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], readOnly);
			return {
				kind: 'checked',
				files: parsePorcelain(stdout),
				ignoredPaths: ignored.stdout.split('\0').filter(entry => entry.length > 0),
				submodules: await hasSubmodules(git, worktreePath),
				restrictions
			};
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
		// has open - the shell of a terminal disposed a moment ago, still exiting (WORKTREE.md
		// WT-4.5). The directory is deleted below, waiting for it to be let go of - but only if this remove
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
			return toError(err);
		}
	}

	return { kind: 'removed' };
}

/** The lock git holds on `worktreePath`, if any, read from `git worktree list`. */
async function restrictionsOf(git: IWorktreeGit, root: string, worktreePath: string): Promise<IWorktreeRestriction[]> {
	const { stdout } = await git.exec(root, ['worktree', 'list', '--porcelain']);
	const wanted = await comparablePath(worktreePath);
	for (const entry of stdout.split(/\r?\n\r?\n/)) {
		const lines = entry.split(/\r?\n/);
		const head = lines.find(line => line.startsWith('worktree '));
		if (!head || await comparablePath(head.slice('worktree '.length)) !== wanted) {
			continue;
		}

		const lock = lines.find(line => line === 'locked' || line.startsWith('locked '));
		return lock !== undefined ? [{ kind: 'locked', reason: lock.slice('locked'.length).trim() }] : [];
	}

	return [];
}

/**
 * Whether `git worktree list` names `worktreePath`, or `undefined` when git cannot say. It decides
 * whether a directory may be deleted, so "not sure" is neither answer.
 */
async function isListed(git: IWorktreeGit, root: string, worktreePath: string): Promise<boolean | undefined> {
	let stdout: string;
	try {
		({ stdout } = await git.exec(root, ['worktree', 'list', '--porcelain']));
	} catch {
		return undefined;
	}

	const listed = stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
	const [wanted, ...candidates] = await Promise.all([worktreePath, ...listed].map(comparablePath));
	return candidates.includes(wanted);
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
	/** The pattern as a glob from the repository's root; one with no `/` of its own matches at any depth. */
	readonly glob: string;
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
			const glob = anchored ? pattern : `**/${pattern}`;
			rules.push({ negated, directoryOnly, glob, matches: picomatch(glob, { dot: true }) });
		}
	}

	return rules;
}

/**
 * Whether `file`, relative to the repository, is included: as in gitignore, the last rule matching it
 * or a directory above it decides (WORKTREE.md WT-6.2).
 */
export function isWorktreeIncluded(rules: readonly IIncludeRule[], file: string, isDirectory: boolean): boolean {
	const parts = file.split('/');
	const directories = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
	let included = false;
	for (const rule of rules) {
		if (directories.some(directory => rule.matches(directory)) || ((!rule.directoryOnly || isDirectory) && rule.matches(file))) {
			included = !rule.negated;
		}
	}

	return included;
}

/** Pathspecs for the files the rules could include, so that git lists only those (WORKTREE.md WT-6.5). */
function includePathspecs(rules: readonly IIncludeRule[]): string[] {
	return rules.filter(rule => !rule.negated).flatMap(rule => rule.directoryOnly
		? [`:(glob)${rule.glob}/**`]
		: [`:(glob)${rule.glob}`, `:(glob)${rule.glob}/**`]);
}

/** Whether `relative` under `base` passes through a link or a junction, the path itself too with `itself` (WORKTREE.md WT-6.3). */
export async function reachesThroughLink(base: string, relative: string, itself: boolean): Promise<boolean> {
	const parts = relative.split('/');
	const depth = itself ? parts.length : parts.length - 1;
	for (let index = 1; index <= depth; index++) {
		let stat;
		try {
			stat = await fs.lstat(path.join(base, ...parts.slice(0, index)));
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				return false;
			}
			throw err;
		}
		if (stat.isSymbolicLink()) {
			return true;
		}
	}

	return false;
}

/**
 * Copies into the new worktree the ignored files `.worktreeinclude` names, never over a file or through
 * a link (WORKTREE.md WT-6). Returns what failed to copy.
 */
async function copyWorktreeInclude(git: IWorktreeGit, root: string, worktreePath: string): Promise<readonly string[]> {
	let content: string;
	try {
		content = await fs.readFile(path.join(root, '.worktreeinclude'), 'utf8');
	} catch (err) {
		// A file that is there but cannot be read is reported (WT-6.1)
		if ((err as { code?: string }).code === 'ENOENT') {
			return [];
		}
		return [`.worktreeinclude: ${toError(err).message}`];
	}

	const rules = parseWorktreeInclude(content);
	const pathspecs = includePathspecs(rules);
	if (pathspecs.length === 0) {
		return [];
	}

	const { stdout } = await git.exec(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...pathspecs]);
	const candidates = stdout.split('\0').filter(entry => entry.length > 0);

	const failures: string[] = [];
	for (const relative of candidates) {
		if (!isWorktreeIncluded(rules, relative, false)) {
			continue;
		}

		try {
			if (await reachesThroughLink(root, relative, true) || await reachesThroughLink(worktreePath, relative, false)) {
				continue;
			}

			const target = path.join(worktreePath, relative);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.copyFile(path.join(root, relative), target, fsConstants.COPYFILE_EXCL);
		} catch (err) {
			if ((err as { code?: string }).code !== 'EEXIST') {
				failures.push(relative);
			}
		}
	}

	return failures;
}
