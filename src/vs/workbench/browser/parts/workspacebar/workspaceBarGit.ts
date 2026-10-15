/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { compareFileNames } from '../../../../base/common/comparers.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, IExtUri, joinPath } from '../../../../base/common/resources.js';
import { isBoolean, isObject, isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { gitPathToUri, IGitLocation, locateGitDirectories, readGitFile, repositoryFolderOf } from '../../../services/workspaces/common/gitFiles.js';
import { canonicalUri, FolderKey, worktreesFolderOf } from './workspaceBar.js';

/** A linked worktree of a repository, as git records it. */
export interface IWorkspaceBarWorktree {
	/** The worktree's folder, spelled the way git wrote it down. */
	readonly uri: URI;
	/**
	 * The branch checked out there, without `refs/heads/`. Undefined while its HEAD is detached, but by a rebase or a
	 * bisect, which keep the branch they work on (WT-3.3).
	 */
	readonly branch: string | undefined;
	/**
	 * What its row says: the branch, or the first seven characters of a detached HEAD. The folder's
	 * name where HEAD says neither - a reftable repository's HEAD names no branch.
	 */
	readonly label: string;
	/**
	 * False when git still records the worktree and its folder is gone (WT-1.9), and while its repository's git
	 * directory cannot be reached (WT-3.8): its row is then marked, in its place.
	 */
	readonly exists: boolean;
	/** The workspace folder it is, once somebody has gone to it. Undefined until then. */
	readonly folder: IWorkspaceFolder | undefined;
}

/** A repository: its main checkout, which is the folder row, and the worktrees of it that Facade made (WT-1.3). */
export interface IWorkspaceBarRepository {
	readonly kind: 'repository';
	/** The main checkout. */
	readonly main: URI;
	/** The workspace folder the main checkout is. Undefined when only a worktree of it was added. */
	readonly folder: IWorkspaceFolder | undefined;
	/**
	 * The branch the main checkout is on, without `refs/heads/`. Undefined while its HEAD is detached, but by a rebase or
	 * a bisect (WT-3.3).
	 */
	readonly branch: string | undefined;
	/**
	 * Every folder of folders[] on this row, in their order there: the main checkout - under each
	 * spelling it was added by, as a folder is never two rows - and its worktrees in the workspace.
	 */
	readonly members: readonly IWorkspaceFolder[];
	/**
	 * Those Facade made, in the order they were made, oldest first (WT-1.3, WT-1.7). Never one another tool made, in
	 * `folders[]` or not: a script's scratch checkout, another agent's own.
	 */
	readonly worktrees: readonly IWorkspaceBarWorktree[];
}

/** The worktree of `repository` whose folder is `uri`, if it has one there. */
export function findWorktree(repository: IWorkspaceBarRepository | undefined, uri: URI, extUri: IExtUri): IWorkspaceBarWorktree | undefined {
	return repository?.worktrees.find(worktree => extUri.isEqual(worktree.uri, uri));
}

/** A folder with no repository of its own, or a worktree another tool made. */
interface IWorkspaceBarPlainFolder {
	readonly kind: 'folder';
	readonly folder: IWorkspaceFolder;
	/**
	 * A worktree another tool made (WT-1.3). Facade takes it for a folder: it is on no repository's row, and is
	 * offered no worktree of its own.
	 */
	readonly foreign?: boolean;
	/**
	 * A worktree git no longer records, on its way out of `folders[]` (WT-3.8): drawn nowhere until it has left, so that
	 * it is never a folder of its own.
	 */
	readonly leaving?: boolean;
}

/** A row of the bar's first level. */
export type WorkspaceBarGroup = IWorkspaceBarRepository | IWorkspaceBarPlainFolder;

/** What a worktree's row says. */
interface IWorktreeLabel {
	readonly branch: string | undefined;
	readonly label: string;
}

/** A folder of the workspace that was a worktree git no longer records: deleted outside the window, or its repository gone (WT-3.8). */
export interface IDeletedWorktree {
	readonly folder: IWorkspaceFolder;
	/** The main checkout of the repository it was a worktree of. */
	readonly main: URI;
}

/** What the reader needs of the window: its folders - `WorkspaceBarModel` is one - and a way to take one out. */
interface IWorkspaceBarFolders {
	readonly folders: readonly IWorkspaceFolder[];
	readonly onDidChange: Event<void>;
	readonly key: FolderKey;
	/**
	 * Takes out of the workspace the folders that were worktrees git no longer records (WT-3.8), and resolves with
	 * whether they left. Their rows are drawn nowhere meanwhile; those that do not leave are drawn in their place,
	 * marked, as they are without it.
	 */
	readonly removeDeleted?: (deleted: readonly IDeletedWorktree[]) => Promise<boolean>;
}

/** How long a window waits for its first read before it draws the last window's groups (WT-3.7). */
const FIRST_READ_WAIT = 500;

/** How long a worktree whose folder has gone is drawn as it was before it is marked (WT-3.8). */
const SETTLE_DELAY = 1000;

/**
 * How soon a repository whose git directory cannot be reached is looked for again (WT-3.8), and how seldom at most: each
 * time it is still not there, the wait doubles, so that a repository gone for good costs nearly nothing.
 */
const UNREACHABLE_INTERVAL = 10_000;
const UNREACHABLE_MAX_INTERVAL = 300_000;

/**
 * Which folders of the workspace are one repository, and which worktrees git records for it.
 *
 * Read from the files git writes, not from `ISCMService`: the git extension closes and reopens its
 * repositories as the window changes folder, and a list built on them would refill on every switch.
 * Upstream reads worktrees the same way (`getWorktreesFS`), and the renderer cannot run git.
 *
 * ```
 * <folder>/.git                       a directory: a main checkout. A file "gitdir: X": see X
 * <git dir>/commondir                 in a linked worktree's git dir: the shared git directory
 * <common>/HEAD                       the main checkout's HEAD
 * <common>/worktrees/<name>/HEAD      each linked worktree's HEAD
 * <common>/worktrees/<name>/gitdir    each linked worktree's folder, with /.git at the end
 * <git dir>/rebase-merge/head-name    the branch a rebase works on, while it has HEAD detached
 * <git dir>/BISECT_START              the branch a bisect began on, while it has HEAD detached
 * ```
 */
export class WorkspaceBarGit extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the groups changed. Not when a read found what the last one did. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _groups: readonly WorkspaceBarGroup[] = [];

	/**
	 * The first level of the bar, in `folders[]` order. The last window's until the first read finishes
	 * (WT-3.7), and empty until then when none was kept.
	 */
	get groups(): readonly WorkspaceBarGroup[] {
		return this._groups;
	}

	private _ready = false;

	/**
	 * Whether there are groups to draw: a read has finished, or the last window's were kept. Until then
	 * `groups` is empty, and the bar draws `folders[]` flat rather than start blank.
	 */
	get ready(): boolean {
		return this._ready;
	}

	private _waiting = false;

	/**
	 * Whether the bar waits a moment for the first read with the last window's groups in hand (WT-3.7): it draws no rows
	 * meanwhile, rather than rows the first read may change at once. Everything else goes by the last window's groups,
	 * the window's title among them.
	 */
	get waiting(): boolean {
		return this._waiting;
	}

	/** The directories git writes to, one watcher each, keyed like folders. */
	private readonly watchers = this._register(new DisposableMap<string>());

	/**
	 * Batched: one `git commit` writes several files, and a branch switch rewrites HEAD more than
	 * once. One read after they settle.
	 */
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.refresh().then(undefined, onUnexpectedError), 250));

	/**
	 * Reads again now and then while a repository's git directory cannot be reached - a drive not mounted, a share not
	 * reached - whose folders are drawn as the last read had them, marked, until it is back (WT-3.8). No watcher reaches
	 * a directory that is not there. Each of its own reads that finds it still gone puts the next one off longer.
	 */
	private readonly unreachableScheduler = this._register(new RunOnceScheduler(() => {
		this.unreachableInterval = Math.min(this.unreachableInterval * 2, UNREACHABLE_MAX_INTERVAL);
		this.refresh().then(undefined, onUnexpectedError);
	}, UNREACHABLE_INTERVAL));

	/** How long `unreachableScheduler` waits next. */
	private unreachableInterval = UNREACHABLE_INTERVAL;

	/**
	 * The worktrees whose folder has just gone, by key, and when each was first found gone: drawn as they were for
	 * `SETTLE_DELAY` (WT-3.8). `git worktree remove` deletes the folder before it deletes the record, and a read between
	 * the two would mark a row that is on its way out.
	 */
	private readonly settling = new Map<string, number>();

	/** Reads again once a worktree in `settling` has stayed gone long enough to be marked. */
	private readonly settleScheduler = this._register(new RunOnceScheduler(() => this.refresh().then(undefined, onUnexpectedError), SETTLE_DELAY));

	/** Which read is the latest. A slower, older read never overwrites a newer one. */
	private generation = 0;

	/** The latest read, which an older one hands its caller on to (`refresh`). */
	private latest: Promise<void> = Promise.resolve();

	/** What the last read found, to compare the next one with. */
	private signature = '';

	/**
	 * The folders `removeDeleted` could not take out, by key, as they were handed over: drawn in their place under their
	 * repository, marked, and not handed over again until they have left and come back (WT-3.8).
	 */
	private readonly notRemoved = new Map<string, IDeletedWorktree>();

	/** The folders handed to `removeDeleted` that it has not answered for yet, by key. */
	private readonly leaving = new Set<string>();

	/**
	 * What each worktree of `folders[]` was last read as, by key: its row drawn in its place once git's files no longer
	 * say, while it cannot leave or a record of it is being written (WT-3.8).
	 */
	private readonly lastLabels = new Map<string, IWorktreeLabel>();

	/** Where Facade makes worktrees (`worktreesFolderOf`), worked out once. */
	private own: Promise<URI> | undefined;

	/**
	 * The groups of the last read that had folders to read, which say what a folder git's files no longer lead to was
	 * (WT-3.8): through reads with worktrees switched off, which read none (WT-9.1), as well.
	 */
	private previous: readonly WorkspaceBarGroup[] = [];

	constructor(
		private readonly source: IWorkspaceBarFolders,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IPathService private readonly pathService: IPathService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();

		// WT-3.7: the rows the last window had, for a first read that is slow in coming. That read comes after the bar
		// is first drawn, and a bar drawn without it showed every folder flat until then - a worktree as a folder, then
		// under its repository. It is waited for a moment first: it is quick, and it is what is there now, which the
		// last window's rows may not be - a worktree deleted since would be drawn, then gone.
		const kept = keptGroups(this.storageService.get(GROUPS_STORAGE_KEY, StorageScope.WORKSPACE), this.source.folders, this.source.key);
		if (kept) {
			this._groups = kept;
			this.previous = kept;
			this.rememberLabels(new Set(this.source.folders.map(folder => this.source.key(folder.uri))));
			this._ready = true;
			this._waiting = true;
			this.signature = signatureOf(kept, this.source.key);
			this._register(disposableTimeout(() => this.stopWaiting(), FIRST_READ_WAIT));
		}
		// WT-3.8: what could not leave, which is not handed over again in this window either
		for (const deleted of keptNotRemoved(this.storageService.get(NOT_REMOVED_STORAGE_KEY, StorageScope.WORKSPACE), this.source.folders, this.source.key)) {
			this.notRemoved.set(this.source.key(deleted.folder.uri), deleted);
		}
		this._register(this.storageService.onWillSaveState(() => this.saveState()));

		// A change of folders is read at once; the batching is for git's own writes.
		this._register(this.source.onDidChange(() => this.refresh().then(undefined, onUnexpectedError)));
		this.refresh().then(undefined, onUnexpectedError);
	}

	/** Has the bar draw the last window's groups, the first read not in yet (WT-3.7). A first read that finds the same changes nothing. */
	private stopWaiting(): void {
		if (this._waiting) {
			this._waiting = false;
			this._onDidChange.fire();
		}
	}

	/** Keeps the last read for the window that opens next (WT-3.7), and what it knows that its rows do not say. */
	private saveState(): void {
		this.storeOrRemove(GROUPS_STORAGE_KEY, this._ready && this._groups.length ? storedGroupsOf(this._groups) : undefined);
		this.storeOrRemove(NOT_REMOVED_STORAGE_KEY, this.notRemoved.size ? storedNotRemovedOf(this.notRemoved) : undefined);
	}

	/** Keeps `value` under `key` in the workspace's storage, this machine's paths; none removes it. */
	private storeOrRemove(key: string, value: object | undefined): void {
		if (value) {
			this.storageService.store(key, JSON.stringify(value), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(key, StorageScope.WORKSPACE);
		}
	}

	/**
	 * Reads everything again, now, and resolves once `groups` holds a read at least as new as this
	 * call - so a caller that awaits it can act on the groups (`WorkspaceBarPart.show`).
	 *
	 * A read overtaken by a newer one resolves with the newer one, rather than write older groups
	 * over it or resolve with nothing written.
	 */
	refresh(): Promise<void> {
		const read = this.read(++this.generation);
		this.latest = read;
		return read;
	}

	private async read(generation: number): Promise<void> {
		// WT-3.8: a folder that could not leave the workspace is drawn in its place until it has left and come back. A
		// read with worktrees switched off, of no folders, says nothing of that (WT-9.1).
		const present = new Set(this.source.folders.map(folder => this.source.key(folder.uri)));
		for (const key of present.size ? [...this.notRemoved.keys()] : []) {
			if (!present.has(key)) {
				this.notRemoved.delete(key);
			}
		}

		this.own ??= worktreesFolderOf(this.fileService, this.pathService);
		const context: IReadContext = {
			fileService: this.fileService,
			key: this.source.key,
			extUri: this.uriIdentityService.extUri,
			own: await this.own,
			previous: this.previous,
			notRemoved: this.notRemoved,
			labels: this.lastLabels
		};
		const read = await readGroups(context, this.source.folders);
		if (this._store.isDisposed) {
			return;
		}
		if (generation !== this.generation) {
			return this.latest;
		}

		this.watch(read.watch);
		if (!read.unreachable) {
			this.unreachableScheduler.cancel();
			this.unreachableInterval = UNREACHABLE_INTERVAL;
		} else if (!this.unreachableScheduler.isScheduled()) {
			// Not put off by the reads in between: its own come at their time
			this.unreachableScheduler.schedule(this.unreachableInterval);
		}

		// Kept even when nothing changed: a workspace edit hands out new objects for the same folders.
		// Only the event depends on the comparison.
		this._groups = this.settle(read.groups);
		if (this._groups.length) {
			this.previous = this._groups;
		}
		this.rememberLabels(present);

		// The bar draws once it stops waiting, whatever this read found
		const signature = signatureOf(this._groups, this.source.key);
		if (!this._ready || this._waiting || signature !== this.signature) {
			this._ready = true;
			this._waiting = false;
			this.signature = signature;
			this._onDidChange.fire();
		}

		// WT-3.8: a worktree git no longer records leaves the workspace, drawn nowhere meanwhile
		const deleted = read.deleted.filter(({ folder }) => !this.leaving.has(this.source.key(folder.uri)));
		if (deleted.length && this.source.removeDeleted) {
			this.leave(this.source.removeDeleted, deleted).then(undefined, onUnexpectedError);
		}
	}

	/** Keeps what each worktree of `folders[]` - `present`, by key - is drawn as, for when git's files no longer say. */
	private rememberLabels(present: ReadonlySet<string>): void {
		for (const group of this._groups) {
			for (const worktree of group.kind === 'repository' ? group.worktrees : []) {
				if (worktree.folder) {
					this.lastLabels.set(this.source.key(worktree.folder.uri), { branch: worktree.branch, label: worktree.label });
				}
			}
		}
		for (const key of present.size ? [...this.lastLabels.keys()] : []) {
			if (!present.has(key)) {
				this.lastLabels.delete(key);
			}
		}
	}

	/**
	 * Hands `deleted` to `removeDeleted`. Those that do not leave - its failing included - are drawn in their place, marked,
	 * from the next read, rather than nowhere.
	 */
	private async leave(removeDeleted: (deleted: readonly IDeletedWorktree[]) => Promise<boolean>, deleted: readonly IDeletedWorktree[]): Promise<void> {
		const keys = deleted.map(({ folder }) => this.source.key(folder.uri));
		keys.forEach(key => this.leaving.add(key));
		let left = false;
		try {
			left = await removeDeleted(deleted);
		} catch (error) {
			onUnexpectedError(error);
		} finally {
			keys.forEach(key => this.leaving.delete(key));
		}

		// Leaving changed the folders, which reads them again
		if (!left && !this._store.isDisposed) {
			deleted.forEach((entry, index) => this.notRemoved.set(keys[index], entry));
			await this.refresh();
		}
	}

	/**
	 * `groups`, with a worktree whose folder has just gone drawn as it was for `SETTLE_DELAY` (WT-3.8): `git worktree
	 * remove` deletes the folder first and the record after, and a read between the two would mark a row on its way
	 * out. One still gone after that is marked: deleted by hand, or its repository out of reach.
	 */
	private settle(groups: readonly WorkspaceBarGroup[]): WorkspaceBarGroup[] {
		const drawn = new Set<string>();
		for (const group of this._waiting ? [] : this._groups) {
			for (const worktree of group.kind === 'repository' ? group.worktrees : []) {
				if (worktree.exists) {
					drawn.add(this.source.key(worktree.uri));
				}
			}
		}

		const now = Date.now();
		const gone = new Set<string>();
		let pending = false;
		const settled = groups.map(group => group.kind === 'folder' ? group : {
			...group,
			worktrees: group.worktrees.map(worktree => {
				const key = this.source.key(worktree.uri);
				if (worktree.exists || !drawn.has(key)) {
					return worktree;
				}

				gone.add(key);
				const since = this.settling.get(key) ?? now;
				this.settling.set(key, since);
				if (now - since >= SETTLE_DELAY) {
					return worktree;
				}

				pending = true;
				return { ...worktree, exists: true };
			})
		});

		for (const key of [...this.settling.keys()]) {
			if (!gone.has(key)) {
				this.settling.delete(key);
			}
		}
		if (pending) {
			this.settleScheduler.schedule();
		}
		return settled;
	}

	/**
	 * Watches exactly the directories git writes to: never the checkouts themselves, whose files have
	 * nothing to say about which worktrees exist.
	 *
	 * Correlated (`createWatcher`), so these events reach this listener and nothing else.
	 */
	private watch(targets: readonly URI[]): void {
		const wanted = new Map<string, URI>();
		for (const uri of targets) {
			wanted.set(this.source.key(uri), uri);
		}

		for (const key of [...this.watchers.keys()]) {
			if (!wanted.has(key)) {
				this.watchers.deleteAndDispose(key);
			}
		}

		for (const [key, uri] of wanted) {
			if (this.watchers.has(key)) {
				continue;
			}

			// In `worktrees` every entry is a worktree's record. Elsewhere only the files the groups are read
			// from: not the index, a lock or a fetch's, which a stage, a commit or a fetch rewrites without
			// changing which worktrees there are (upstream's own watcher leaves `index.lock` out too).
			const isRecords = basename(uri) === 'worktrees';
			const store = new DisposableStore();
			const watcher = store.add(this.fileService.createWatcher(uri, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(e => {
				if (isRecords || [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted].some(resource => READ_FILES.has(basename(resource)))) {
					this.scheduler.schedule();
				}
			}));
			this.watchers.set(key, store);
		}
	}
}

interface IHead {
	readonly branch: string | undefined;
	/** The branch, or the start of the commit HEAD is detached at; undefined when the file does not say. */
	readonly label: string | undefined;
}

/** A detached HEAD shows this many characters of its hash, as `git log --oneline` does. */
const SHORT_HASH_LENGTH = 7;

/** The entries of the directories git writes to that the groups are read from (see `WorkspaceBarGit`). */
const READ_FILES = new Set(['HEAD', 'gitdir', 'commondir', 'worktrees']);

/**
 * What a reftable repository's `HEAD` file says, whatever is checked out: its refs are kept elsewhere,
 * and the file is there so that a git without reftable still sees a repository (upstream's `getHEAD`).
 */
const REFTABLE_HEAD = 'refs/heads/.invalid';

async function readHead(fileService: IFileService, gitDir: URI): Promise<IHead | undefined> {
	const content = await readGitFile(fileService, joinPath(gitDir, 'HEAD'));
	// WT-3.3: a worktree git is still making, whose HEAD is the placeholder `git worktree add` writes first
	if (!content || NULL_HASH.test(content)) {
		return undefined;
	}

	const ref = /^ref:\s*(?<ref>.+)$/.exec(content)?.groups?.ref;
	if (!ref) {
		// WT-3.3: a rebase or a bisect detaches HEAD while it runs, and the row stays on the branch it works on
		const branch = await branchInProgress(fileService, gitDir);
		return branch ? { branch, label: branch } : { branch: undefined, label: content.slice(0, SHORT_HASH_LENGTH) };
	}

	if (ref === REFTABLE_HEAD) {
		return { branch: undefined, label: undefined };
	}

	// The prefix comes off here, once, so branch names compare the same everywhere.
	const branch = /^refs\/heads\/(?<branch>.+)$/.exec(ref)?.groups?.branch;
	return { branch, label: branch ?? ref };
}

/** A commit's full name in a repository of either hash: 40 hex digits for SHA-1, 64 for SHA-256. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** No commit: what `git worktree add` writes as a new worktree's HEAD, before it checks a commit out there. */
const NULL_HASH = /^(?:0{40}|0{64})$/;

/**
 * The branch a rebase or a bisect running in `gitDir` works on, as `git status` names it: both detach HEAD until they
 * are done. Undefined when neither runs, or the one running began on a detached HEAD.
 */
async function branchInProgress(fileService: IFileService, gitDir: URI): Promise<string | undefined> {
	const [merge, apply, bisect] = await Promise.all([
		readGitFile(fileService, joinPath(gitDir, 'rebase-merge', 'head-name')),
		readGitFile(fileService, joinPath(gitDir, 'rebase-apply', 'head-name')),
		readGitFile(fileService, joinPath(gitDir, 'BISECT_START'))
	]);

	// `refs/heads/<branch>`, or "detached HEAD"
	const rebased = /^refs\/heads\/(?<branch>.+)$/.exec(merge ?? apply ?? '')?.groups?.branch;
	if (rebased) {
		return rebased;
	}

	// The branch without `refs/heads/`, or the commit a bisect began at
	return bisect && !FULL_HASH.test(bisect) ? bisect : undefined;
}

interface IRecordedWorktree {
	readonly uri: URI;
	readonly branch: string | undefined;
	/** Its HEAD's label, or its folder's name where HEAD does not say. */
	readonly label: string;
	readonly exists: boolean;
	/** When git made its record of it: the creation time of `<common>/worktrees/<name>`. */
	readonly made: number;
}

/** What a repository's records under `<common>/worktrees` say. */
interface IRecords {
	/** The linked worktrees, oldest first (WT-1.7), each once git has written what it checked out (WT-3.3). */
	readonly worktrees: IRecordedWorktree[];
	/** The folder each record names, those git is still making included. */
	readonly named: URI[];
	/** The records' directories, to watch. */
	readonly admin: URI[];
	/**
	 * Whether every record was read: one git is writing has a file missing for a moment. A record names its folder by its
	 * `gitdir` alone, so one git has written no HEAD for yet - or never will, its `git worktree add` killed - is read whole.
	 */
	readonly complete: boolean;
}

/**
 * Every linked worktree git records under `<common>/worktrees`, and what else its records say.
 *
 * Oldest first, by the creation time of git's record of each (WT-1.7), since git keeps no date for a worktree. Ties,
 * and file systems without a creation time, go by name, numerically: `w2` before `w10`.
 */
async function readRecordedWorktrees(fileService: IFileService, commonDir: URI): Promise<IRecords> {
	let children: readonly { resource: URI; isDirectory: boolean; ctime: number }[];
	try {
		children = (await fileService.resolve(joinPath(commonDir, 'worktrees'), { resolveMetadata: true })).children ?? [];
	} catch (error) {
		// None recorded, or none that could be read
		return { worktrees: [], named: [], admin: [], complete: toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND };
	}

	const records = children.filter(child => child.isDirectory);
	const read = await Promise.all(records.map(async record => {
		const admin = record.resource;
		const gitdir = await readGitFile(fileService, joinPath(admin, 'gitdir'));
		if (!gitdir) {
			return undefined;
		}

		const uri = gitPathToUri(admin, gitdir.replace(/[\\/]\.git$/, ''));
		const head = await readHead(fileService, admin);
		const worktree: IRecordedWorktree | undefined = head && { uri, branch: head.branch, label: head.label ?? basename(uri), exists: await fileService.exists(uri), made: record.ctime };
		return { uri, worktree };
	}));

	const worktrees = coalesce(read.map(entry => entry?.worktree));
	worktrees.sort((a, b) => a.made - b.made || compareFileNames(a.label, b.label));

	return { worktrees, named: coalesce(read).map(entry => entry.uri), admin: records.map(record => record.resource), complete: read.every(entry => entry !== undefined) };
}

interface IRepositoryDraft {
	readonly kind: 'draft';
	readonly commonDir: URI;
	readonly members: { readonly folder: IWorkspaceFolder; readonly location: IGitLocation }[];
}

/**
 * A folder of `folders[]` with no `.git` git could open: a folder of no repository, or one of Facade's worktrees that
 * is gone, or whose repository cannot be reached (WT-3.8).
 */
interface IUnlocatedFolder {
	readonly kind: 'unlocated';
	readonly folder: IWorkspaceFolder;
	/** Its path with links resolved. */
	readonly canonical: URI;
}

/** A repository's row as read, and the worktrees on it by key - their folders' paths with links resolved. */
interface IRepositoryRead {
	readonly commonDir: URI;
	readonly group: IWorkspaceBarRepository;
	readonly worktrees: ReadonlyMap<string, IWorkspaceBarWorktree>;
	/** Whether every record of it was read: what one cannot be read says, nothing does (WT-3.8). */
	readonly complete: boolean;
	/** The worktrees Facade made that its records name, by key, those git is still making included. */
	readonly named: ReadonlyMap<string, URI>;
	readonly watch: readonly URI[];
}

/** What a read found. */
interface IRead {
	readonly groups: WorkspaceBarGroup[];
	/** The directories to watch to know when they change. */
	readonly watch: URI[];
	/** The folders of `folders[]` that were worktrees git no longer records, to leave it (WT-3.8). */
	readonly deleted: IDeletedWorktree[];
	/** Whether a repository's git directory could not be reached, whose rows are drawn as the last read had them. */
	readonly unreachable: boolean;
}

/** What a read goes by besides the folders it reads. */
interface IReadContext {
	readonly fileService: IFileService;
	readonly key: FolderKey;
	readonly extUri: IExtUri;
	/**
	 * Where Facade makes worktrees, `<own>/<repository>/<name>`, canonical (WT-2.1): a worktree anywhere else is another
	 * tool's (WT-1.3).
	 */
	readonly own: URI;
	/** The last read's groups, which say what a folder git's files no longer lead to was (WT-3.8). */
	readonly previous: readonly WorkspaceBarGroup[];
	/** The folders that could not leave the workspace, by key, as they were handed over: drawn in their place, marked. */
	readonly notRemoved: ReadonlyMap<string, IDeletedWorktree>;
	/** What each worktree in `folders[]` was last drawn as, by key, for when git's files no longer say. */
	readonly labels: ReadonlyMap<string, IWorktreeLabel>;
}

/** Whether `canonical` is in Facade's worktrees folder: a worktree there is one Facade made (WT-1.3). */
function isOwn(context: IReadContext, canonical: URI): boolean {
	return context.extUri.isEqualOrParent(canonical, context.own);
}

async function canonicalKeyOf(context: IReadContext, uri: URI): Promise<string> {
	return context.key(await canonicalUri(context.fileService, uri));
}

/**
 * The row of the repository whose shared git directory is `commonDir`, with `members` on it, the folders of `folders[]`
 * in it; undefined for one with no main checkout to hang worktrees under (WT-3.2). Its worktrees are those Facade made
 * (WT-1.3).
 */
async function readRepository(context: IReadContext, commonDir: URI, members: IRepositoryDraft['members']): Promise<IRepositoryRead | undefined> {
	const { fileService, key } = context;
	// The main checkout: the member that is one, or else the directory the shared git directory
	// sits in. A bare repository, or one whose git directory lives elsewhere, has none to find from a
	// worktree, and its worktrees stay plain rows.
	const mainMember = members.find(member => member.location.isMain);
	const main = mainMember?.folder.uri ?? (basename(commonDir) === '.git' ? dirname(commonDir) : undefined);
	if (!main) {
		return undefined;
	}

	const [records, memberKeys, mainKey, mainHead] = await Promise.all([
		readRecordedWorktrees(fileService, commonDir),
		Promise.all(members.map(member => canonicalKeyOf(context, member.folder.uri))),
		canonicalKeyOf(context, main),
		readHead(fileService, commonDir)
	]);
	// By the first spelling of each folder: the one its row keeps (WT-1.6).
	const membersByKey = new Map<string, IWorkspaceFolder>();
	members.forEach((member, index) => {
		if (!membersByKey.has(memberKeys[index])) {
			membersByKey.set(memberKeys[index], member.folder);
		}
	});

	const [recordedUris, namedUris] = await Promise.all([
		Promise.all(records.worktrees.map(worktree => canonicalUri(fileService, worktree.uri))),
		Promise.all(records.named.map(uri => canonicalUri(fileService, uri)))
	]);
	const worktrees: IWorkspaceBarWorktree[] = [];
	const byKey = new Map<string, IWorkspaceBarWorktree>();
	records.worktrees.forEach((worktree, index) => {
		// WT-1.3: Facade's own alone. One another tool makes for itself - a script's scratch checkout of a commit
		// to test, another agent's own - is that tool's, and comes and goes with its work.
		if (!isOwn(context, recordedUris[index])) {
			return;
		}

		// A worktree in the workspace goes by the workspace's spelling: git records the path with its
		// links resolved, and rows look up their mark, name and colour by the workspace's.
		const recordedKey = key(recordedUris[index]);
		const folder = membersByKey.get(recordedKey);
		const listed = { uri: folder?.uri ?? worktree.uri, branch: worktree.branch, label: worktree.label, exists: worktree.exists, folder };
		worktrees.push(listed);
		byKey.set(recordedKey, listed);
	});
	const named = new Map<string, URI>();
	records.named.forEach((uri, index) => {
		if (isOwn(context, namedUris[index])) {
			named.set(key(namedUris[index]), uri);
		}
	});

	// A linked worktree in folders[] that git's own list does not carry yet: git writes the folder
	// before it writes its record, and a read can land between the two. Last: the one git has not
	// finished recording is the one being made now.
	const unrecorded = members.filter((member, index) => !member.location.isMain && !byKey.has(memberKeys[index]));
	const heads = await Promise.all(unrecorded.map(member => readHead(fileService, member.location.gitDir)));
	unrecorded.forEach((member, index) => {
		worktrees.push({ uri: member.folder.uri, branch: heads[index]?.branch, label: heads[index]?.label ?? basename(member.folder.uri), exists: true, folder: member.folder });
	});

	return {
		commonDir,
		group: { kind: 'repository', main, folder: membersByKey.get(mainKey), branch: mainHead?.branch, members: members.map(member => member.folder), worktrees },
		worktrees: byKey,
		complete: records.complete,
		named,
		watch: [commonDir, joinPath(commonDir, 'worktrees'), ...records.admin]
	};
}

/** The groups for `folders`, the directories to watch, and the folders to take out of the workspace. */
async function readGroups(context: IReadContext, folders: readonly IWorkspaceFolder[]): Promise<IRead> {
	const { fileService, key, previous, notRemoved } = context;
	const [locations, canonicals] = await Promise.all([
		Promise.all(folders.map(folder => locateGitDirectories(fileService, folder.uri))),
		Promise.all(folders.map(folder => canonicalUri(fileService, folder.uri)))
	]);
	const commonKeys = await Promise.all(locations.map(location => location && canonicalKeyOf(context, location.commonDir)));

	// First pass, in folders[] order: a plain folder is its own row, and every folder of one
	// repository joins the row made by the first of them. That is WT-1.6: a repository sits where its
	// first member is.
	const order: (IWorkspaceBarPlainFolder | IRepositoryDraft | IUnlocatedFolder)[] = [];
	const drafts = new Map<string, IRepositoryDraft>();
	for (let index = 0; index < folders.length; index++) {
		const folder = folders[index];
		const location = locations[index];
		const common = commonKeys[index];
		if (!location || common === undefined) {
			order.push({ kind: 'unlocated', folder, canonical: canonicals[index] });
			continue;
		}

		// WT-1.3: a worktree another tool made is a folder to the bar, wherever its repository is
		if (!location.isMain && !isOwn(context, canonicals[index])) {
			order.push({ kind: 'folder', folder, foreign: true });
			continue;
		}

		let draft = drafts.get(common);
		if (!draft) {
			draft = { kind: 'draft', commonDir: location.commonDir, members: [] };
			drafts.set(common, draft);
			order.push(draft);
		}

		draft.members.push({ folder, location });
	}

	// Every repository read at once.
	const commonOf = new Map([...drafts].map(([common, draft]) => [draft, common]));
	const reads = new Map<string, IRepositoryRead | undefined>();
	await Promise.all([...drafts].map(async ([common, draft]) => {
		reads.set(common, await readRepository(context, draft.commonDir, draft.members));
	}));

	const unlocated = order.filter((entry): entry is IUnlocatedFolder => entry.kind === 'unlocated');
	const placed = await placeUnlocated(context, unlocated, reads);
	// Another tool's worktree is a folder whatever becomes of it, and offers no worktree (WT-1.3)
	const foreign = new Set(previous.flatMap(group => group.kind === 'folder' && group.foreign ? [key(group.folder.uri)] : []));

	// The rows, in folders[] order: each repository where the first of its folders is, a folder found by its record
	// among them (WT-1.6), and a folder on its way out drawn nowhere.
	const rows = new Set<WorkspaceBarGroup>();
	for (const entry of order) {
		if (entry.kind === 'folder') {
			rows.add(entry);
		} else if (entry.kind === 'draft') {
			const repository = placed.repositories.get(commonOf.get(entry)!);
			if (repository) {
				rows.add(repository);
			} else {
				// No main checkout to hang them under (WT-3.2): plain rows
				entry.members.forEach(member => rows.add({ kind: 'folder', folder: member.folder }));
			}
		} else {
			const place = placed.places.get(entry);
			rows.add(place?.kind === 'repository' ? placed.repositories.get(place.common)!
				: place?.kind === 'deleted' ? { kind: 'folder', folder: entry.folder, leaving: true }
					: { kind: 'folder', folder: entry.folder, foreign: foreign.has(key(entry.folder.uri)) || undefined });
		}
	}

	return {
		groups: [...rows],
		watch: placed.watch,
		// Not one that could not leave already: it is not handed over again until it has left and come back
		deleted: [...placed.places].flatMap(([entry, place]) => place.kind === 'deleted' && !notRemoved.has(key(entry.folder.uri)) ? [{ folder: entry.folder, main: place.main }] : []),
		unreachable: placed.unreachable
	};
}

/** Where an unlocated folder goes: on a repository's row, by its common key, or out of the workspace. */
type UnlocatedPlace =
	| { readonly kind: 'repository'; readonly common: string }
	| { readonly kind: 'deleted'; readonly main: URI };

/**
 * The folders git's files no longer lead to, told by what is on disk and what the last read had them as, never by a
 * read that merely missed a file git was rewriting (WT-3.8):
 *
 * - its repository is the one its `.git` names a record in, `<common>/worktrees/<name>`, else the one the last read put
 *   it on, else the one it was handed over with when it could not leave, else - gone from Facade's worktrees folder,
 *   `<own>/<repository>/<name>` - the repository of that name that records it;
 * - git still records it there: its row, in its place, marked while its folder is gone (WT-1.9);
 * - the repository's git directory is there and records it no more: it leaves the workspace, or, one that could not,
 *   is drawn in its place, marked;
 * - the repository was deleted, its folder there without a `.git`: its worktrees leave, and its main checkout is a
 *   folder of its own;
 * - the git directory cannot be reached: the repository is drawn as the last read had it, every worktree marked;
 * - a main checkout, as the last read had it, stays its repository's while the repository can be read.
 *
 * Any other is a folder of its own, marked as not on disk once it is gone (W9.3): nothing says that git dropped it.
 * The rows come back with every repository's, those of `reads` with their folders found by their records added.
 */
async function placeUnlocated(context: IReadContext, unlocated: readonly IUnlocatedFolder[], reads: ReadonlyMap<string, IRepositoryRead | undefined>): Promise<{ places: Map<IUnlocatedFolder, UnlocatedPlace>; repositories: Map<string, IWorkspaceBarRepository>; watch: URI[]; unreachable: boolean }> {
	const { fileService, key, extUri, previous, notRemoved, labels } = context;
	// What each was in the last read: the repository whose row it was on, and the worktree it was there
	const lastRead = new Map<string, { readonly repository: IWorkspaceBarRepository; readonly worktree: IWorkspaceBarWorktree | undefined }>();
	for (const group of previous) {
		if (group.kind === 'repository') {
			for (const member of group.members) {
				lastRead.set(key(member.uri), { repository: group, worktree: group.worktrees.find(worktree => worktree.folder && key(worktree.folder.uri) === key(member.uri)) });
			}
		}
	}

	const byRepository = new Map<string, { readonly commonDir: URI; readonly folders: { readonly entry: IUnlocatedFolder; readonly isMain: boolean }[] }>();
	const places = new Map<IUnlocatedFolder, UnlocatedPlace>();
	// A name alone is no repository: two of one name share `<own>/<name>`
	const recordedBy = (name: string, canonical: URI) => coalesce([...reads.values()]).find(read => basename(read.group.main) === name && read.named.has(key(canonical)));
	await Promise.all(unlocated.map(async entry => {
		const was = lastRead.get(key(entry.folder.uri));
		// WT-1.3: another tool's worktree is a folder, whatever becomes of it. A main checkout is told by the last read.
		const own = isOwn(context, entry.canonical);
		if (!own && (!was || was.worktree)) {
			return;
		}

		const record = own ? await worktreeRecordNamedBy(fileService, entry.folder.uri) : undefined;
		let commonDir = record && dirname(dirname(record));
		const main = was?.repository.main ?? notRemoved.get(key(entry.folder.uri))?.main;
		if (!commonDir && main) {
			commonDir = (await locateGitDirectories(fileService, main))?.commonDir ?? joinPath(main, '.git');
		}
		// One of Facade's worktrees with nothing left to tell its repository by but where it was made (WT-2.1)
		if (!commonDir && own && extUri.isEqual(dirname(dirname(entry.canonical)), context.own)) {
			commonDir = recordedBy(basename(dirname(entry.canonical)), entry.canonical)?.commonDir;
		}
		if (!commonDir) {
			return;
		}

		const common = await canonicalKeyOf(context, commonDir);
		const folders = byRepository.get(common)?.folders ?? [];
		byRepository.set(common, { commonDir, folders: [...folders, { entry, isMain: !own }] });
	}));

	const repositories = new Map<string, IWorkspaceBarRepository>();
	for (const [common, read] of reads) {
		if (read) {
			repositories.set(common, read.group);
		}
	}
	const watch = [...reads.values()].flatMap(read => read?.watch ?? []);
	let isUnreachable = false;

	for (const [common, { commonDir, folders: found }] of byRepository) {
		const folders = found.map(({ entry }) => entry);
		// Read with the rest of the workspace, or now: a repository none of whose folders git's files lead to
		let read = reads.get(common);
		if (!reads.has(common)) {
			if (!await fileService.exists(joinPath(commonDir, 'HEAD'))) {
				const main = repositoryFolderOf(commonDir);
				const [folderThere, gitThere] = await Promise.all([fileService.exists(main), fileService.exists(joinPath(main, '.git'))]);
				if (folderThere && !gitThere) {
					// Its folder there without a `.git`: the repository was deleted, its records with it. Its main checkout
					// is a folder of its own now, and its worktrees leave - one that could not drawn in its place, marked.
					const staying: IUnlocatedFolder[] = [];
					for (const entry of folders) {
						if (key(entry.folder.uri) === key(main)) {
							continue;
						}
						if (notRemoved.has(key(entry.folder.uri))) {
							staying.push(entry);
							places.set(entry, { kind: 'repository', common });
						} else {
							places.set(entry, { kind: 'deleted', main });
						}
					}
					if (staying.length) {
						repositories.set(common, frozenRepository(context, commonDir, staying));
					}
					continue;
				}

				// WT-3.8: nothing tells whether git still records them - a drive not mounted, the repository moved
				isUnreachable = true;
				repositories.set(common, frozenRepository(context, commonDir, folders));
				folders.forEach(entry => places.set(entry, { kind: 'repository', common }));
				continue;
			}

			read = await readRepository(context, commonDir, []);
			watch.push(...read?.watch ?? []);
		}
		if (!read) {
			// A bare repository's, or one whose git directory lives elsewhere: no main checkout to hang them under (WT-3.2)
			continue;
		}

		// Gone only when no record of the repository names it, every one of them read: one git is writing has a file
		// missing for a moment, and git gives a name that is free again to the next worktree.
		const [keys, onDisk] = await Promise.all([
			Promise.all(folders.map(entry => canonicalKeyOf(context, entry.folder.uri))),
			Promise.all(folders.map(entry => fileService.exists(entry.folder.uri)))
		]);
		const members: IWorkspaceFolder[] = [];
		const added: IWorkspaceBarWorktree[] = [];
		const adopted = new Map<IWorkspaceBarWorktree, IWorkspaceFolder>();
		let mainCheckout: IWorkspaceFolder | undefined;
		folders.forEach((entry, index) => {
			const worktree = read.worktrees.get(keys[index]);
			const label = labels.get(key(entry.folder.uri));
			const was = { uri: entry.folder.uri, branch: label?.branch, label: label?.label ?? basename(entry.folder.uri), folder: entry.folder };
			if (found[index].isMain) {
				// Its `.git` not read this time, its repository read all the same: still its main checkout, never a
				// worktree that is gone
				mainCheckout ??= entry.folder;
			} else if (worktree) {
				adopted.set(worktree, entry.folder);
			} else if (!read.complete || read.named.has(keys[index])) {
				// Nothing says it is gone - a record names it still, its HEAD not read - drawn as it was, marked while its
				// folder is gone
				added.push({ ...was, exists: onDisk[index] });
			} else if (notRemoved.has(key(entry.folder.uri))) {
				added.push({ ...was, exists: false });
			} else {
				places.set(entry, { kind: 'deleted', main: read.group.main });
				return;
			}
			members.push(entry.folder);
			places.set(entry, { kind: 'repository', common });
		});
		if (members.length) {
			const group = repositories.get(common) ?? read.group;
			repositories.set(common, {
				...group,
				folder: group.folder ?? mainCheckout,
				members: [...group.members, ...members].sort((a, b) => a.index - b.index),
				worktrees: [...group.worktrees.map(worktree => {
					const folder = adopted.get(worktree);
					return folder ? { ...worktree, uri: folder.uri, folder } : worktree;
				}), ...added]
			});
		}
	}

	return { places, repositories, watch, unreachable: isUnreachable };
}

/**
 * The row of a repository that cannot be read - its git directory not reached, or gone with it - with `folders` on it,
 * its folders of `folders[]`: as the last read had it, every worktree marked, until it can be read again (WT-3.8).
 */
function frozenRepository(context: IReadContext, commonDir: URI, folders: readonly IUnlocatedFolder[]): IWorkspaceBarRepository {
	const { key, previous, labels } = context;
	const present = new Map(folders.map(entry => [key(entry.folder.uri), entry.folder]));
	const last = previous.find((group): group is IWorkspaceBarRepository => group.kind === 'repository' && group.members.some(member => present.has(key(member.uri))));
	const main = last?.main ?? repositoryFolderOf(commonDir);
	const worktrees: IWorkspaceBarWorktree[] = (last?.worktrees ?? []).map(worktree => ({ ...worktree, exists: false, folder: worktree.folder && present.get(key(worktree.folder.uri)) }));
	for (const entry of folders) {
		if (key(entry.folder.uri) !== key(main) && !worktrees.some(worktree => worktree.folder === entry.folder)) {
			const label = labels.get(key(entry.folder.uri));
			worktrees.push({ uri: entry.folder.uri, branch: label?.branch, label: label?.label ?? basename(entry.folder.uri), exists: false, folder: entry.folder });
		}
	}

	return { kind: 'repository', main, folder: present.get(key(main)), branch: last?.branch, members: folders.map(entry => entry.folder), worktrees };
}

/** The worktree record `folder`'s `.git` file names, `<common>/worktrees/<name>`, there or not; undefined for any other `.git`. */
async function worktreeRecordNamedBy(fileService: IFileService, folder: URI): Promise<URI | undefined> {
	const content = await readGitFile(fileService, joinPath(folder, '.git'));
	const target = content && /^gitdir:\s*(?<path>.+)$/m.exec(content)?.groups?.path;
	if (!target) {
		return undefined;
	}

	const record = gitPathToUri(folder, target.trim());
	return basename(dirname(record)) === 'worktrees' ? record : undefined;
}

/** Everything a row draws, so that a read which found the same thing does not redraw the bar. */
function signatureOf(groups: readonly WorkspaceBarGroup[], key: FolderKey): string {
	return JSON.stringify(groups.map(group => group.kind === 'folder'
		? [key(group.folder.uri), group.folder.name, !!group.foreign, !!group.leaving]
		: [key(group.main), group.folder?.name, group.worktrees.map(worktree => [key(worktree.uri), worktree.label, worktree.exists, worktree.folder?.name])]));
}

/** Where the last read is kept, for the window that opens next to draw its rows from (WT-3.7). */
export const GROUPS_STORAGE_KEY = 'facade.workspaceBar.groups';

/** Where the folders that could not leave the workspace are kept, for the window that opens next (WT-3.8). */
const NOT_REMOVED_STORAGE_KEY = 'facade.workspaceBar.notRemoved';

/** A worktree as it is kept: its URI as a string, and its folder by its URI. */
interface IStoredWorktree {
	readonly uri: string;
	readonly branch?: string;
	readonly label: string;
	readonly exists: boolean;
	readonly folder?: string;
}

/** A group as it is kept: URIs as strings, and folders by their URI, found again in `folders[]` when read back. */
type StoredGroup =
	| { readonly kind: 'folder'; readonly folder: string; readonly foreign?: boolean }
	| { readonly kind: 'repository'; readonly main: string; readonly folder?: string; readonly branch?: string; readonly members: readonly string[]; readonly worktrees: readonly IStoredWorktree[] };

function storedGroupsOf(groups: readonly WorkspaceBarGroup[]): StoredGroup[] {
	// Not a folder on its way out of the workspace (WT-3.8): it is gone by the time the next window opens
	return groups.filter(group => group.kind === 'repository' || !group.leaving).map<StoredGroup>(group => group.kind === 'folder'
		? { kind: 'folder', folder: group.folder.uri.toString(), foreign: group.foreign }
		: {
			kind: 'repository',
			main: group.main.toString(),
			folder: group.folder?.uri.toString(),
			branch: group.branch,
			members: group.members.map(member => member.uri.toString()),
			worktrees: group.worktrees.map(worktree => ({ uri: worktree.uri.toString(), branch: worktree.branch, label: worktree.label, exists: worktree.exists, folder: worktree.folder?.uri.toString() }))
		});
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || isString(value);
}

function isStoredWorktree(candidate: unknown): candidate is IStoredWorktree {
	if (!isObject(candidate)) {
		return false;
	}

	const { uri, branch, label, exists, folder } = candidate as Record<string, unknown>;
	return isString(uri) && isString(label) && isBoolean(exists) && isOptionalString(branch) && isOptionalString(folder);
}

function isStoredGroup(candidate: unknown): candidate is StoredGroup {
	if (!isObject(candidate)) {
		return false;
	}

	const { kind, folder, foreign, main, branch, members, worktrees } = candidate as Record<string, unknown>;
	if (kind === 'folder') {
		return isString(folder) && (foreign === undefined || isBoolean(foreign));
	}

	return kind === 'repository' && isString(main) && isOptionalString(folder) && isOptionalString(branch)
		&& Array.isArray(members) && members.every(isString)
		&& Array.isArray(worktrees) && worktrees.every(isStoredWorktree);
}

/**
 * The groups the last window read, found again among `folders`: a folder no longer in the workspace is
 * left out, as a read leaves it out, and a repository none of whose folders are is not a row. Undefined
 * when nothing usable was kept - a record that cannot be read is not a partial one.
 */
function keptGroups(value: string | undefined, folders: readonly IWorkspaceFolder[], key: FolderKey): WorkspaceBarGroup[] | undefined {
	if (!value) {
		return undefined;
	}

	// ⚠️ All of it inside the `try`, not only the `JSON.parse`: `URI.parse` throws on a string that is
	// not a URI, and a record somebody edited by hand must cost the kept rows, never the bar.
	try {
		const stored: unknown = JSON.parse(value);
		if (!Array.isArray(stored) || !stored.every(isStoredGroup)) {
			return undefined;
		}

		const present = new Map(folders.map(folder => [key(folder.uri), folder]));
		const folderAt = (uri: string | undefined) => uri === undefined ? undefined : present.get(key(URI.parse(uri)));

		const groups: WorkspaceBarGroup[] = [];
		for (const group of stored) {
			if (group.kind === 'folder') {
				const folder = folderAt(group.folder);
				if (folder) {
					groups.push({ kind: 'folder', folder, foreign: group.foreign });
				}
				continue;
			}

			const members = coalesce(group.members.map(folderAt));
			if (members.length) {
				groups.push({
					kind: 'repository',
					main: URI.parse(group.main),
					folder: folderAt(group.folder),
					branch: group.branch,
					members,
					worktrees: group.worktrees.map(worktree => ({ uri: URI.parse(worktree.uri), branch: worktree.branch, label: worktree.label, exists: worktree.exists, folder: folderAt(worktree.folder) }))
				});
			}
		}

		return groups.length ? groups : undefined;
	} catch {
		return undefined;
	}
}

function storedNotRemovedOf(notRemoved: ReadonlyMap<string, IDeletedWorktree>): { readonly folder: string; readonly main: string }[] {
	return [...notRemoved.values()].map(({ folder, main }) => ({ folder: folder.uri.toString(), main: main.toString() }));
}

/** The folders that could not leave the workspace as the last window kept them, those still in `folders`; none from a record that cannot be read. */
function keptNotRemoved(value: string | undefined, folders: readonly IWorkspaceFolder[], key: FolderKey): IDeletedWorktree[] {
	try {
		const stored: unknown = JSON.parse(value ?? '[]');
		const present = new Map(folders.map(folder => [key(folder.uri), folder]));
		return Array.isArray(stored) ? coalesce(stored.map(entry => {
			const { folder, main } = (isObject(entry) ? entry : {}) as Record<string, unknown>;
			const kept = isString(folder) ? present.get(key(URI.parse(folder))) : undefined;
			return kept && isString(main) ? { folder: kept, main: URI.parse(main) } : undefined;
		})) : [];
	} catch {
		return [];
	}
}
