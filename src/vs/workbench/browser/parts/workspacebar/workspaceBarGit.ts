/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { compareFileNames } from '../../../../base/common/comparers.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, IExtUri, joinPath } from '../../../../base/common/resources.js';
import { isBoolean, isObject, isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { gitPathToUri, IGitLocation, locateGitDirectories, readGitFile } from '../../../services/workspaces/common/gitFiles.js';
import { canonicalUri, FolderKey } from './workspaceBar.js';

/** A linked worktree of a repository, as git records it. */
export interface IWorkspaceBarWorktree {
	/** The worktree's folder, spelled the way git wrote it down. */
	readonly uri: URI;
	/** The branch checked out there, without `refs/heads/`. Undefined while its HEAD is detached. */
	readonly branch: string | undefined;
	/**
	 * What its row says: the branch, or the first seven characters of a detached HEAD. The folder's
	 * name where HEAD says neither - a reftable repository's HEAD names no branch.
	 */
	readonly label: string;
	/** False when git still records the worktree and its folder is gone. */
	readonly exists: boolean;
	/** The workspace folder it is, once somebody has gone to it. Undefined until then. */
	readonly folder: IWorkspaceFolder | undefined;
}

/** A repository: its main checkout, which is the folder row, and every worktree git records for it. */
export interface IWorkspaceBarRepository {
	readonly kind: 'repository';
	/** The main checkout. */
	readonly main: URI;
	/** The workspace folder the main checkout is. Undefined when only a worktree of it was added. */
	readonly folder: IWorkspaceFolder | undefined;
	/** The branch the main checkout is on, without `refs/heads/`. Undefined while its HEAD is detached. */
	readonly branch: string | undefined;
	/**
	 * Every folder of folders[] on this row, in their order there: the main checkout - under each
	 * spelling it was added by, as a folder is never two rows - and its worktrees in the workspace.
	 */
	readonly members: readonly IWorkspaceFolder[];
	/** In the order they were made, oldest first (WT-1.7). */
	readonly worktrees: readonly IWorkspaceBarWorktree[];
}

/** The worktree of `repository` whose folder is `uri`, if it has one there. */
export function findWorktree(repository: IWorkspaceBarRepository | undefined, uri: URI, extUri: IExtUri): IWorkspaceBarWorktree | undefined {
	return repository?.worktrees.find(worktree => extUri.isEqual(worktree.uri, uri));
}

/** A folder with no repository of its own. */
interface IWorkspaceBarPlainFolder {
	readonly kind: 'folder';
	readonly folder: IWorkspaceFolder;
}

/** A row of the bar's first level. */
export type WorkspaceBarGroup = IWorkspaceBarRepository | IWorkspaceBarPlainFolder;

/** What the reader needs of the folder list. `WorkspaceBarModel` is one. */
interface IWorkspaceBarFolders {
	readonly folders: readonly IWorkspaceFolder[];
	readonly onDidChange: Event<void>;
	readonly key: FolderKey;
}

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

	/** The directories git writes to, one watcher each, keyed like folders. */
	private readonly watchers = this._register(new DisposableMap<string>());

	/**
	 * Batched: one `git commit` writes several files, and a branch switch rewrites HEAD more than
	 * once. One read after they settle.
	 */
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.refresh().then(undefined, onUnexpectedError), 250));

	/** Which read is the latest. A slower, older read never overwrites a newer one. */
	private generation = 0;

	/** The latest read, which an older one hands its caller on to (`refresh`). */
	private latest: Promise<void> = Promise.resolve();

	/** What the last read found, to compare the next one with. */
	private signature = '';

	constructor(
		private readonly source: IWorkspaceBarFolders,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// WT-3.7: the rows the last window had, until this one's first read is in. That read comes after
		// the bar is first drawn, and a bar drawn without it showed every folder flat until then - a
		// worktree as a folder, then under its repository. One that finds the same changes nothing.
		const kept = keptGroups(this.storageService.get(GROUPS_STORAGE_KEY, StorageScope.WORKSPACE), this.source.folders, this.source.key);
		if (kept) {
			this._groups = kept;
			this._ready = true;
			this.signature = signatureOf(kept, this.source.key);
		}
		this._register(this.storageService.onWillSaveState(() => this.saveState()));

		// A change of folders is read at once; the batching is for git's own writes.
		this._register(this.source.onDidChange(() => this.refresh().then(undefined, onUnexpectedError)));
		this.refresh().then(undefined, onUnexpectedError);
	}

	/** Keeps the last read for the window that opens next (WT-3.7). */
	private saveState(): void {
		if (this._ready && this._groups.length) {
			this.storageService.store(GROUPS_STORAGE_KEY, JSON.stringify(storedGroupsOf(this._groups)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(GROUPS_STORAGE_KEY, StorageScope.WORKSPACE);
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
		const { groups, watch } = await readGroups(this.fileService, this.source.key, this.source.folders);
		if (this._store.isDisposed) {
			return;
		}
		if (generation !== this.generation) {
			return this.latest;
		}

		this.watch(watch);

		// Kept even when nothing changed: a workspace edit hands out new objects for the same folders.
		// Only the event depends on the comparison.
		this._groups = groups;

		const signature = signatureOf(groups, this.source.key);
		if (!this._ready || signature !== this.signature) {
			this._ready = true;
			this.signature = signature;
			this._onDidChange.fire();
		}
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
	if (!content) {
		return undefined;
	}

	const ref = /^ref:\s*(?<ref>.+)$/.exec(content)?.groups?.ref;
	if (!ref) {
		return { branch: undefined, label: content.slice(0, SHORT_HASH_LENGTH) };
	}

	if (ref === REFTABLE_HEAD) {
		return { branch: undefined, label: undefined };
	}

	// The prefix comes off here, once, so branch names compare the same everywhere.
	const branch = /^refs\/heads\/(?<branch>.+)$/.exec(ref)?.groups?.branch;
	return { branch, label: branch ?? ref };
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

/**
 * Every linked worktree git records under `<common>/worktrees`, oldest first, and the directories it
 * read them from.
 *
 * By the creation time of git's record of each (WT-1.7), since git keeps no date for a worktree. Ties,
 * and file systems without a creation time, go by name, numerically: `w2` before `w10`.
 */
async function readRecordedWorktrees(fileService: IFileService, commonDir: URI): Promise<{ worktrees: IRecordedWorktree[]; admin: URI[] }> {
	let children: readonly { resource: URI; isDirectory: boolean; ctime: number }[];
	try {
		children = (await fileService.resolve(joinPath(commonDir, 'worktrees'), { resolveMetadata: true })).children ?? [];
	} catch {
		return { worktrees: [], admin: [] };
	}

	const records = children.filter(child => child.isDirectory);
	const read = await Promise.all(records.map(async (record): Promise<IRecordedWorktree | undefined> => {
		const admin = record.resource;
		const gitdir = await readGitFile(fileService, joinPath(admin, 'gitdir'));
		const head = await readHead(fileService, admin);
		if (!gitdir || !head) {
			return undefined;
		}

		const uri = gitPathToUri(admin, gitdir.replace(/[\\/]\.git$/, ''));
		return { uri, branch: head.branch, label: head.label ?? basename(uri), exists: await fileService.exists(uri), made: record.ctime };
	}));

	const worktrees = coalesce(read);
	worktrees.sort((a, b) => a.made - b.made || compareFileNames(a.label, b.label));

	return { worktrees, admin: records.map(record => record.resource) };
}

interface IRepositoryDraft {
	readonly kind: 'draft';
	readonly commonDir: URI;
	readonly members: { readonly folder: IWorkspaceFolder; readonly location: IGitLocation }[];
}

/** The groups for `folders`, and the directories to watch to know when they change. */
async function readGroups(fileService: IFileService, key: FolderKey, folders: readonly IWorkspaceFolder[]): Promise<{ groups: WorkspaceBarGroup[]; watch: URI[] }> {
	const canonicalKey = async (uri: URI) => key(await canonicalUri(fileService, uri));
	const locations = await Promise.all(folders.map(folder => locateGitDirectories(fileService, folder.uri)));
	const commonKeys = await Promise.all(locations.map(location => location && canonicalKey(location.commonDir)));

	// First pass, in folders[] order: a plain folder is its own row, and every folder of one
	// repository joins the row made by the first of them. That is WT-1.6: a repository sits where its
	// first member is.
	const order: (IWorkspaceBarPlainFolder | IRepositoryDraft)[] = [];
	const drafts = new Map<string, IRepositoryDraft>();
	for (let index = 0; index < folders.length; index++) {
		const folder = folders[index];
		const location = locations[index];
		const common = commonKeys[index];
		if (!location || common === undefined) {
			order.push({ kind: 'folder', folder });
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

	// Every repository read at once, and the rows put back in folders[] order.
	const read = await Promise.all(order.map(async (entry): Promise<{ readonly groups: WorkspaceBarGroup[]; readonly watch: URI[] }> => {
		if (entry.kind === 'folder') {
			return { groups: [entry], watch: [] };
		}

		// The main checkout: the member that is one, or else the directory the shared git directory
		// sits in. A bare repository, or one whose git directory lives elsewhere, has none to find from a
		// worktree, and its worktrees stay plain rows.
		const mainMember = entry.members.find(member => member.location.isMain);
		const main = mainMember?.folder.uri ?? (basename(entry.commonDir) === '.git' ? dirname(entry.commonDir) : undefined);
		if (!main) {
			return { groups: entry.members.map(member => ({ kind: 'folder' as const, folder: member.folder })), watch: [] };
		}

		const [{ worktrees: recorded, admin }, memberKeys, mainKey, mainHead] = await Promise.all([
			readRecordedWorktrees(fileService, entry.commonDir),
			Promise.all(entry.members.map(member => canonicalKey(member.folder.uri))),
			canonicalKey(main),
			readHead(fileService, entry.commonDir)
		]);
		// By the first spelling of each folder: the one its row keeps (WT-1.6).
		const membersByKey = new Map<string, IWorkspaceFolder>();
		entry.members.forEach((member, index) => {
			if (!membersByKey.has(memberKeys[index])) {
				membersByKey.set(memberKeys[index], member.folder);
			}
		});

		const recordedKeys = await Promise.all(recorded.map(worktree => canonicalKey(worktree.uri)));
		const worktrees: IWorkspaceBarWorktree[] = recorded.map((worktree, index) => {
			// A worktree in the workspace goes by the workspace's spelling: git records the path with its
			// links resolved, and rows look up their mark, name and colour by the workspace's.
			const folder = membersByKey.get(recordedKeys[index]);
			return { uri: folder?.uri ?? worktree.uri, branch: worktree.branch, label: worktree.label, exists: worktree.exists, folder };
		});

		// A linked worktree in folders[] that git's own list does not carry yet: git writes the folder
		// before it writes its record, and a read can land between the two. Last: the one git has not
		// finished recording is the one being made now.
		const listed = new Set(recordedKeys);
		const unrecorded = entry.members.filter((member, index) => !member.location.isMain && !listed.has(memberKeys[index]));
		const heads = await Promise.all(unrecorded.map(member => readHead(fileService, member.location.gitDir)));
		for (let index = 0; index < unrecorded.length; index++) {
			const member = unrecorded[index];
			const head = heads[index];
			worktrees.push({ uri: member.folder.uri, branch: head?.branch, label: head?.label ?? basename(member.folder.uri), exists: true, folder: member.folder });
		}

		return {
			groups: [{ kind: 'repository', main, folder: membersByKey.get(mainKey), branch: mainHead?.branch, members: entry.members.map(member => member.folder), worktrees }],
			watch: [entry.commonDir, joinPath(entry.commonDir, 'worktrees'), ...admin]
		};
	}));

	return {
		groups: await adoptMissingWorktrees(read.flatMap(entry => entry.groups), canonicalKey),
		watch: read.flatMap(entry => entry.watch)
	};
}

/**
 * A worktree in folders[] whose folder was deleted by hand has no `.git` left to be recognised by, and
 * came out as a plain row as well as its greyed row under its repository: that folder is the worktree's.
 */
async function adoptMissingWorktrees(groups: WorkspaceBarGroup[], canonicalKey: (uri: URI) => Promise<string>): Promise<WorkspaceBarGroup[]> {
	const missing = groups.flatMap(group => group.kind === 'repository' ? group.worktrees.filter(worktree => !worktree.exists && !worktree.folder) : []);
	const plain = groups.filter((group): group is IWorkspaceBarPlainFolder => group.kind === 'folder');
	if (missing.length === 0 || plain.length === 0) {
		return groups;
	}

	const [missingKeys, plainKeys] = await Promise.all([
		Promise.all(missing.map(worktree => canonicalKey(worktree.uri))),
		Promise.all(plain.map(group => canonicalKey(group.folder.uri)))
	]);

	const adopted = new Map<IWorkspaceBarWorktree, IWorkspaceFolder>();
	plain.forEach((group, index) => {
		const at = missingKeys.indexOf(plainKeys[index]);
		if (at !== -1) {
			adopted.set(missing[at], group.folder);
		}
	});
	if (adopted.size === 0) {
		return groups;
	}

	// Each repository with its adopted folders, which then sits where the first of its members is
	// (WT-1.6) - an adopted folder listed before the rest of it, too.
	const rebuilt = new Map<WorkspaceBarGroup, WorkspaceBarGroup>();
	const ownerOf = new Map<IWorkspaceFolder, WorkspaceBarGroup>();
	for (const group of groups) {
		if (group.kind !== 'repository') {
			continue;
		}

		const repository = {
			...group,
			members: [...group.members, ...coalesce(group.worktrees.map(worktree => adopted.get(worktree)))].sort((a, b) => a.index - b.index),
			worktrees: group.worktrees.map(worktree => {
				const folder = adopted.get(worktree);
				return folder ? { ...worktree, uri: folder.uri, folder } : worktree;
			})
		};
		rebuilt.set(group, repository);
		for (const worktree of group.worktrees) {
			const folder = adopted.get(worktree);
			if (folder) {
				ownerOf.set(folder, repository);
			}
		}
	}

	const placed = new Set<WorkspaceBarGroup>();
	for (const group of groups) {
		placed.add((group.kind === 'folder' ? ownerOf.get(group.folder) : rebuilt.get(group)) ?? group);
	}
	return [...placed];
}

/** Everything a row draws, so that a read which found the same thing does not redraw the bar. */
function signatureOf(groups: readonly WorkspaceBarGroup[], key: FolderKey): string {
	return JSON.stringify(groups.map(group => group.kind === 'folder'
		? [key(group.folder.uri), group.folder.name]
		: [key(group.main), group.folder?.name, group.worktrees.map(worktree => [key(worktree.uri), worktree.label, worktree.exists, worktree.folder?.name])]));
}

/** Where the last read is kept, for the window that opens next to draw its rows from (WT-3.7). */
export const GROUPS_STORAGE_KEY = 'facade.workspaceBar.groups';

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
	| { readonly kind: 'folder'; readonly folder: string }
	| { readonly kind: 'repository'; readonly main: string; readonly folder?: string; readonly branch?: string; readonly members: readonly string[]; readonly worktrees: readonly IStoredWorktree[] };

function storedGroupsOf(groups: readonly WorkspaceBarGroup[]): StoredGroup[] {
	return groups.map<StoredGroup>(group => group.kind === 'folder'
		? { kind: 'folder', folder: group.folder.uri.toString() }
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

	const { kind, folder, main, branch, members, worktrees } = candidate as Record<string, unknown>;
	if (kind === 'folder') {
		return isString(folder);
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
					groups.push({ kind: 'folder', folder });
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
