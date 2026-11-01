/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { clauseOf, messageOf } from '../../base/errors';
import { folderKeyOf } from '../../base/files';
import { withLongFileLock } from '../../base/lock';
import { isDeletableWorktree, isWithin } from '../../core/locations/catalog';
import { plannedDestination, whyNotFolderName } from '../../core/locations/destination';
import { WorktreeProblem, WorktreeProblemError } from '../../core/locations/problems';
import { Catalog, Location, LocationId, LogPort, WorkspaceFolderInfo, WorktreeError, WorktreePlan, WorktreePort } from '../../core/ports';
import { Checkout, followsFolderLinks, GitError, hasBranch, ListedWorktree, resolveCommit, whyNotBranchName } from './gitRead';
import { GitAccess } from './service';

/** The editor's repository object for creating a worktree: the Git extension API's `Repository.createWorktree` (WORKTREES-4.1). */
export interface NativeCreator {
	/** Creates it and answers the path Git made it at; native preparation (links, copies, tasks) runs on unwaited (WORKTREES-2.4). */
	createWorktree(options: { readonly path: string; readonly branch: string; readonly commitish: string }): Promise<string>;
}

/** The editor's native Git integration, feature-detected (WORKTREES-4.1). */
export interface NativeGit {
	/** Why this editor cannot create worktrees natively, as far as it can be told without opening a repository; undefined where it can. */
	unsupported(): Promise<WorktreeProblem | undefined>;
	/** The editor's repository for the checkout roots `uris` (the source's first), opened natively where it is not yet; or why there is none. */
	repository(uris: readonly string[]): Promise<NativeCreator | WorktreeProblem>;
}

/** The editor's Git settings creation follows (UX-4.2), read on use in a folder's scope. */
export interface GitCreationSettings {
	/** `git.branchPrefix`: taken off a branch for its folder's name (WORKTREES-2.2). */
	branchPrefix(folder: WorkspaceFolderInfo): string;
	/** `git.branchValidationRegex`: empty for none. */
	branchValidationRegex(folder: WorkspaceFolderInfo): string;
}

/** Git as worktrees are made and deleted with it: discovery's reads, and the calls deletion makes (WORKTREES-3.2, 4.1). */
export interface WorktreeGit extends GitAccess {
	/** Whether `git status --porcelain` in the worktree at `folder` lists anything. */
	hasChanges(git: string, folder: string): Promise<boolean>;
	/** `git worktree remove` of `worktree`, without `--force`. */
	removeWorktree(git: string, commonDir: string, worktree: string): Promise<void>;
	/** What `git --version` answers: on Windows, whether Git would delete through a link to a folder. */
	versionOf?(git: string): Promise<string>;
	/** The first link to a folder within `folder`, as its path from it; undefined where there is none. */
	folderLinkIn?(folder: string): Promise<string | undefined>;
}

/** The locations as worktree creation and deletion need them: the location service of this window. */
export interface CreationLocations {
	snapshot(): Catalog;
	resolve(id: LocationId): Location | undefined;
	refresh(): Promise<void>;
	locationAt(directory: string): Location | undefined;
	/** Takes the location out of the catalog and of `resolve` while it is deleted: no launch goes there meanwhile. Undone by the result. */
	markDeleting?(id: LocationId): () => void;
}

export interface WorktreeServiceDeps {
	readonly locations: CreationLocations;
	readonly git: WorktreeGit;
	readonly native: NativeGit;
	readonly settings: GitCreationSettings;
	/** Where creations take their per-destination-parent locks, shared by the environment's windows. */
	readonly locks: string;
	readonly log: LogPort;
	/** How long a creation waits for another window creating in the same folder: 120 seconds where not given. */
	readonly lockWaitMs?: number;
	/** The platform Git runs on, this one's where not given: Git for Windows alone follows a junction as it deletes. */
	readonly platform?: NodeJS.Platform;
}

/** What a creation is checked against, read from Git as it stands (WORKTREES-1.2: revalidated on use). */
interface Source {
	readonly location: Location;
	readonly folder: WorkspaceFolderInfo;
	readonly git: string;
	readonly checkout: Checkout;
}

/**
 * New worktrees (WORKTREES-2) through the editor's native Git API, in the execution environment that owns the repository
 * (WORKTREES-4.1). `plan` validates and proposes without effects; `create` makes what was planned, one creation at a time per
 * destination folder, confirms it with Git and reports actual partial effects without rolling anything back (WORKTREES-2.2, 4.2).
 * Facade never initializes a repository or makes a first commit (WORKTREES-2.3). `remove` deletes a linked worktree the person
 * chose, never one with changes Git has not committed (WORKTREES-3.2, D73).
 */
export class WorktreeService implements WorktreePort {
	private readonly creating = new Map<string, Promise<unknown>>();

	constructor(private readonly deps: WorktreeServiceDeps) { }

	/** Available, or why not: in English, and as its problem for the person's own words (UX-2.4). */
	async availability(source: LocationId): Promise<{ readonly available: true } | { readonly available: false; readonly reason: string; readonly problem?: WorktreeProblem }> {
		try {
			await this.sourceOf(source);
			return { available: true };
		} catch (err) {
			return { available: false, reason: messageOf(err), ...(err instanceof WorktreeProblemError ? { problem: err.problem } : {}) };
		}
	}

	async plan(source: LocationId, branch: string, baseRef?: string): Promise<WorktreePlan> {
		if (typeof branch !== 'string' || branch === '') {
			throw problemError({ kind: 'branch_required' });
		}
		if (baseRef !== undefined && (typeof baseRef !== 'string' || baseRef === '')) {
			throw problemError({ kind: 'base_required' });
		}
		const at = await this.sourceOf(source);
		const prefix = this.deps.settings.branchPrefix(at.folder);
		// The branch is taken as given and judged by Git's own rules (WORKTREES-2.1)
		const problem = whyNotFolderName(branch, prefix) ?? this.patternProblem(at.folder, branch) ?? await this.gitRead(at, async () => await whyNotBranchName(at.git, at.checkout.root, branch)
			?? (await hasBranch(at.git, at.checkout.root, branch) ? { kind: 'branch_exists', branch } : undefined));
		if (problem) {
			throw problemError(problem);
		}
		// The base is resolved at the selected source checkout: its HEAD unless another ref is named (WORKTREES-2.1)
		const ref = baseRef ?? 'HEAD';
		const baseCommit = await this.gitRead(at, () => resolveCommit(at.git, at.location.path, ref));
		if (!baseCommit) {
			throw problemError({ kind: 'base_unknown', ref, path: at.location.path });
		}
		const { destination } = await this.destinationOf(at, branch, prefix);
		return { source, branch, baseRef: ref, baseCommit, destination };
	}

	create(plan: WorktreePlan, stillWanted: () => boolean): Promise<Location> {
		return this.serialized(path.dirname(plan.destination), async () => {
			// Closed while it waited its turn: nothing is made for a launch that no longer wants it (WORKTREES-2.5)
			if (!stillWanted()) {
				throw new WorktreeError('The launch was closed before its worktree was created.', 'cancelled');
			}
			const at = await this.sourceOf(plan.source);
			const prefix = this.deps.settings.branchPrefix(at.folder);
			// Another creation may have taken the planned folder meanwhile: the next free one, never an existing directory (WORKTREES-2.2)
			const { destination, listed } = await this.destinationOf(at, plan.branch, prefix);
			if (await this.gitRead(at, () => hasBranch(at.git, at.checkout.root, plan.branch))) {
				throw problemError({ kind: 'branch_exists', branch: plan.branch });
			}
			const main = listed.find(each => each.main && !each.bare)?.path;
			const uris = [at.location.uri, ...[at.checkout.root, main].flatMap(each => each ? [this.deps.locations.locationAt(each)?.uri] : [])]
				.filter((uri, index, all): uri is string => uri !== undefined && all.indexOf(uri) === index);
			const native = await this.deps.native.repository(uris);
			if ('kind' in native) {
				throw problemError(native);
			}
			let created: string;
			try {
				created = await native.createWorktree({ path: destination, branch: plan.branch, commitish: plan.baseCommit });
			} catch (err) {
				throw await this.failure(at, plan.branch, destination, { kind: 'creation_failed', detail: nativeDiagnostic(err) });
			}
			// Git recognizes it: then it is a location, whatever native preparation still does (WORKTREES-2.4)
			let worktrees: readonly ListedWorktree[];
			try {
				worktrees = await this.deps.git.worktreesOf(at.git, at.checkout.commonDir);
			} catch (err) {
				throw await this.failure(at, plan.branch, created, { kind: 'creation_unconfirmed', path: created, detail: messageOf(err) });
			}
			if (!worktrees.some(each => !each.prunable && folderKeyOf(each.path) === folderKeyOf(created))) {
				throw await this.failure(at, plan.branch, created, { kind: 'creation_unconfirmed', path: created });
			}
			try {
				await this.deps.locations.refresh();
			} catch (err) {
				this.deps.log.event(`Could not read every working location after creating ${created}: ${messageOf(err)}`);
			}
			const location = this.deps.locations.locationAt(created);
			if (!location) {
				throw problemError({ kind: 'created_elsewhere', path: created }, { branchCreated: true, destinationCreated: created });
			}
			this.deps.log.event(`Created a worktree on ${plan.branch} at ${created}`);
			return location;
		});
	}

	/**
	 * Deletes the linked worktree `id` (WORKTREES-3.2, D73), with the Git and in the environment its creation would use. Only a
	 * registered worktree other than the main one, whose root it is and with no workspace folder in it, as Git and the window say now.
	 * Refused with nothing touched where it is locked, holds another worktree, has a change Git lists - not committed, or untracked - or
	 * holds a link to a folder this Git would delete through; else out of the catalog while `closeAgents` closes its agents - true once
	 * every process is known to have ended - then checked again, and removed by `git worktree remove` without `--force`: Git's own
	 * refusal is reported as Git said it, and so is a folder it left behind, which Facade never deletes itself. The branch is kept. The
	 * catalog is read again, which confirms the deletion (WORKTREES-1.3).
	 */
	async remove(id: LocationId, closeAgents: () => Promise<boolean>): Promise<void> {
		const location = this.deps.locations.resolve(id);
		const folder = location?.folders[0];
		if (!location || !folder) {
			throw problemError({ kind: 'no_location', id });
		}
		const notDeletable = problemError({ kind: 'not_deletable', name: location.label });
		const key = folderKeyOf(location.path);
		if (!isDeletableWorktree(location, this.deps.locations.snapshot().folders, folderKeyOf)) {
			throw notDeletable;
		}
		const git = await this.deps.git.executable(folder);
		if (git === undefined) {
			throw problemError({ kind: 'git_missing' });
		}
		const checkout = await this.gitRead({ location }, () => this.deps.git.checkoutOf(git, location.path));
		const listed = checkout && folderKeyOf(checkout.root) === key ? await this.gitRead({ location }, () => this.deps.git.worktreesOf(git, checkout.commonDir)) : [];
		const worktree = listed.find(each => folderKeyOf(each.path) === key);
		if (!checkout || !worktree || worktree.main || worktree.bare) {
			throw notDeletable;
		}
		if (worktree.locked) {
			throw problemError({ kind: 'worktree_locked', name: location.label });
		}
		// Git removes the whole folder: another worktree inside it would go too, with what it has not committed
		const nested = listed.find(each => folderKeyOf(each.path) !== key && isWithin(folderKeyOf(each.path), key));
		if (nested) {
			throw problemError({ kind: 'worktree_nested', name: location.label, nested: path.basename(nested.path) });
		}
		if (await this.gitRead({ location }, () => this.deps.git.hasChanges(git, location.path))) {
			throw problemError({ kind: 'worktree_changed', name: location.label });
		}
		const followsLinks = await this.followsFolderLinks(git);
		await this.refuseFolderLinks(followsLinks, location);
		const release = this.deps.locations.markDeleting?.(id) ?? (() => undefined);
		try {
			if (!await closeAgents()) {
				throw problemError({ kind: 'agents_not_ended', name: location.label });
			}
			// What its agents wrote as they ended is checked too: Git's own check may not see an untracked file, nor a link at all
			if (await this.gitRead({ location }, () => this.deps.git.hasChanges(git, location.path))) {
				throw problemError({ kind: 'worktree_changed', name: location.label });
			}
			await this.refuseFolderLinks(followsLinks, location);
			try {
				await this.deps.git.removeWorktree(git, checkout.commonDir, worktree.path);
			} catch (err) {
				throw err instanceof GitError && err.missing ? problemError({ kind: 'git_missing' }) : problemError({ kind: 'deletion_failed', name: location.label, detail: messageOf(err) });
			}
			// Read again while it is still out of the catalog: it does not come back in between
			try {
				await this.deps.locations.refresh();
			} catch (err) {
				this.deps.log.event(`Could not read every working location after deleting ${worktree.path}: ${messageOf(err)}`);
			}
			// Git can succeed and leave the folder - a link it does not go through keeps it - which Facade does not delete itself
			if (isOccupied(worktree.path)) {
				this.deps.log.event(`Git removed the worktree at ${worktree.path} from its repository but left its folder behind`);
				throw problemError({ kind: 'worktree_left', name: location.label, folder: worktree.path });
			}
			this.deps.log.event(`Deleted the worktree at ${worktree.path}${worktree.branch !== undefined ? `; its branch ${worktree.branch} is kept` : ''}`);
		} finally {
			release();
		}
	}

	/**
	 * Whether the Git deletion runs, `git`, deletes through a link to a folder: Git for Windows before 2.54 does; one whose version
	 * cannot be read is taken to. Never elsewhere (WORKTREES-3.2).
	 */
	private async followsFolderLinks(git: string): Promise<boolean> {
		const { versionOf, folderLinkIn } = this.deps.git;
		if ((this.deps.platform ?? process.platform) !== 'win32' || !versionOf || !folderLinkIn) {
			return false;
		}
		return followsFolderLinks(await versionOf(git).catch(() => undefined));
	}

	/** Refuses, with nothing touched, a worktree holding a link to a folder that this Git would delete through (WORKTREES-3.2). */
	private async refuseFolderLinks(followsLinks: boolean, location: Location): Promise<void> {
		const link = followsLinks ? await this.deps.git.folderLinkIn!(location.path) : undefined;
		if (link !== undefined) {
			throw problemError({ kind: 'worktree_linked', name: location.label, link });
		}
	}

	/** The source as Git says it is now, or why no worktree can be made from it (WORKTREES-2.3: prerequisites only, no setup). */
	private async sourceOf(id: LocationId): Promise<Source> {
		const location = this.deps.locations.resolve(id);
		const folder = location?.folders[0];
		if (!location || !folder) {
			throw problemError({ kind: 'no_location', id });
		}
		const git = await this.deps.git.executable(folder);
		if (git === undefined) {
			throw problemError({ kind: 'git_missing' });
		}
		const checkout = await this.gitRead({ location }, () => this.deps.git.checkoutOf(git, location.path));
		if (!checkout) {
			throw problemError({ kind: 'not_repository', path: location.path });
		}
		const at = { location, folder, git, checkout };
		if (!await this.gitRead(at, () => resolveCommit(git, location.path, 'HEAD'))) {
			throw problemError({ kind: 'no_commit', path: location.path });
		}
		const unsupported = await this.deps.native.unsupported();
		if (unsupported) {
			throw problemError(unsupported);
		}
		return at;
	}

	/** A Git read for the source; missing Git is `unavailable`, any other failure keeps Git's diagnostic (WORKTREES-4.2). */
	private async gitRead<T>(at: Pick<Source, 'location'>, read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (err) {
			if (err instanceof GitError && err.missing) {
				throw problemError({ kind: 'git_missing' });
			}
			throw problemError({ kind: 'git_failed', path: at.location.path, detail: messageOf(err) });
		}
	}

	private patternProblem(folder: WorkspaceFolderInfo, branch: string): WorktreeProblem | undefined {
		const pattern = this.deps.settings.branchValidationRegex(folder);
		if (!pattern) {
			return undefined;
		}
		let valid: RegExp;
		try {
			valid = new RegExp(pattern);
		} catch (err) {
			return { kind: 'pattern_invalid', detail: messageOf(err) };
		}
		return valid.test(branch) ? undefined : { kind: 'pattern_mismatch', branch, pattern };
	}

	/** `<main-folder>.worktrees/<branch-folder>` free now: no file, folder or link there, and no worktree registered there. */
	private async destinationOf(at: Source, branch: string, prefix: string): Promise<{ readonly destination: string; readonly listed: readonly ListedWorktree[] }> {
		const listed = await this.gitRead(at, () => this.deps.git.worktreesOf(at.git, at.checkout.commonDir));
		// A bare repository has no main checkout: its worktrees go beside its own directory
		const main = listed.find(each => each.main)?.path ?? at.checkout.commonDir;
		const registered = new Set(listed.map(each => folderKeyOf(each.path)));
		return { destination: plannedDestination(main, branch, prefix, candidate => isOccupied(candidate) || registered.has(folderKeyOf(candidate))), listed };
	}

	/** What a failed creation actually left, kept as it is: never rolled back (WORKTREES-2.2, 4.2). An effect that cannot be read stays unknown. */
	private async failure(at: Source, branch: string, destination: string, problem: WorktreeProblem): Promise<WorktreeError> {
		const branchCreated = await hasBranch(at.git, at.checkout.root, branch).catch(() => undefined);
		return problemError(problem, { ...(branchCreated !== undefined ? { branchCreated } : {}), ...(isOccupied(destination) ? { destinationCreated: destination } : {}) });
	}

	/** Runs `make` alone for its destination folder: after this window's earlier creations there, and holding the environment's lock on it. */
	private serialized<T>(parent: string, make: () => Promise<T>): Promise<T> {
		const key = folderKeyOf(parent);
		const lock = path.join(this.deps.locks, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32));
		const before = this.creating.get(key) ?? Promise.resolve();
		const run = before.then(() => undefined, () => undefined).then(() => withLongFileLock(lock, make, this.deps.lockWaitMs ?? 120_000));
		this.creating.set(key, run);
		const forget = () => {
			if (this.creating.get(key) === run) {
				this.creating.delete(key);
			}
		};
		run.then(forget, forget);
		return run;
	}
}

/** The error of `problem`: its English words for agents and the log, its reason code, and what was actually left (WORKTREES-2.2). */
function problemError(problem: WorktreeProblem, effects: WorktreeError['effects'] = {}): WorktreeProblemError {
	const [message, reason] = englishOf(problem);
	return new WorktreeProblemError(problem, message, reason, effects);
}

/** What agents and the log are told of a problem (UX-1.3: API and system text is English), with its reason code. */
function englishOf(problem: WorktreeProblem): [message: string, reason: string] {
	switch (problem.kind) {
		case 'folder_name': return [problem.why === 'unusable' ? `"${problem.name}" cannot be the name of a folder`
			: problem.why === 'trailing' ? `"${problem.name}" ends in a dot or a space, which Windows does not allow at the end of a folder's name`
				: `"${problem.name}" is a name Windows keeps for a device, so a folder cannot have it`, 'invalid_argument'];
		case 'branch_required': return ['A branch name is required for a new worktree.', 'invalid_argument'];
		case 'base_required': return ['base_ref must name a commit, such as HEAD or a branch.', 'invalid_argument'];
		case 'branch_rejected': return [`Git rejects ${JSON.stringify(problem.branch)} as a branch name`, 'invalid_argument'];
		case 'branch_prefix_clash': return [`branch '${problem.clash}' already exists; Git cannot use the same name for both a branch and a branch-name prefix`, 'invalid_argument'];
		case 'branch_exists': return [`A branch named ${problem.branch} already exists.`, 'invalid_argument'];
		case 'pattern_invalid': return [`git.branchValidationRegex is not a valid regular expression: ${problem.detail}`, 'invalid_argument'];
		case 'pattern_mismatch': return [`${problem.branch} does not match git.branchValidationRegex (${problem.pattern}).`, 'invalid_argument'];
		case 'base_unknown': return [`${problem.ref} is not a commit in the repository at ${problem.path}.`, 'invalid_argument'];
		case 'no_location': return [`No working location ${problem.id} in this window.`, 'invalid_argument'];
		case 'git_missing': return ['Git is not available in this environment.', 'unavailable'];
		case 'not_repository': return [`${problem.path} is not in a Git repository.`, 'repository_required'];
		case 'no_commit': return [`${problem.path} has no commits yet.`, 'commit_required'];
		case 'git_failed': return [`Git could not read ${problem.path}: ${problem.detail}`, 'git_failed'];
		case 'git_extension_missing': return ['The editor\'s Git extension is not available, so worktrees cannot be created.', 'unavailable'];
		case 'git_extension_failed': return [`The editor's Git extension is not available: ${problem.detail}`, 'unavailable'];
		case 'no_native_creation': return ['This editor\'s Git extension cannot create worktrees: its API has no worktree creation.', 'unavailable'];
		case 'repository_not_open': return ['The editor\'s Git extension has not opened this repository, so no worktree of it can be created.', 'unavailable'];
		case 'creation_failed': return [`Git could not create the worktree: ${clauseOf(problem.detail)}.`, 'creation_failed'];
		case 'creation_unconfirmed': return [problem.detail === undefined
			? `Git could not create the worktree: the editor reported ${problem.path}, but Git does not list a worktree there.`
			: `Git could not create the worktree: the editor reported ${problem.path}, but Git could not confirm it: ${clauseOf(problem.detail)}.`, 'creation_failed'];
		case 'created_elsewhere': return [`The worktree at ${problem.path} was created, but it is not among this window's working locations.`, 'creation_failed'];
		case 'not_deletable': return [`"${problem.name}" cannot be deleted: only a linked worktree with no workspace folder in it can be.`, 'invalid_argument'];
		case 'worktree_changed': return [`Worktree "${problem.name}" has changes that are not committed, so it was not deleted. Commit or discard them with Git, then delete it again.`, 'worktree_changed'];
		case 'worktree_locked': return [`Worktree "${problem.name}" is locked, so it was not deleted. Unlock it with Git, then delete it again.`, 'worktree_locked'];
		case 'worktree_nested': return [`Worktree "${problem.name}" holds worktree "${problem.nested}", so it was not deleted. Delete or move that worktree first, then delete it again.`, 'worktree_nested'];
		case 'agents_not_ended': return [`Worktree "${problem.name}" was not deleted: an agent's process in it could not be confirmed to have ended. Delete it again once it has.`, 'agents_not_ended'];
		case 'worktree_linked': return [`Worktree "${problem.name}" contains a link to another folder (${problem.link}), which this version of Git would delete through, so it was not deleted. Remove the link, or update Git to 2.54 or later, then delete it again.`, 'worktree_linked'];
		case 'worktree_left': return [`Git removed worktree "${problem.name}" from its repository but left its folder ${problem.folder} behind.`, 'deletion_incomplete'];
		case 'deletion_failed': return [`Could not delete worktree "${problem.name}": ${clauseOf(problem.detail)}.`, 'deletion_failed'];
	}
}

/** Whether anything is at `file`: a file, a folder, or a link, even one to nothing. */
function isOccupied(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/** Git's own words where the editor's Git extension carries them (its errors keep Git's stderr), else the error's message. */
function nativeDiagnostic(err: unknown): string {
	const stderr: unknown = err instanceof Error ? Reflect.get(err, 'stderr') : undefined;
	return typeof stderr === 'string' && stderr.trim() ? stderr.trim() : messageOf(err);
}
