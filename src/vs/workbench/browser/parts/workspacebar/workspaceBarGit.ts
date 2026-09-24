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
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { canonicalUri, FolderKey } from './workspaceBar.js';

/** A linked worktree of a repository, as git records it. */
export interface IWorkspaceBarWorktree {
	/** The worktree's folder, spelled the way git wrote it down. */
	readonly uri: URI;
	/** The branch checked out there, without `refs/heads/`. Undefined while its HEAD is detached. */
	readonly branch: string | undefined;
	/** What its row says: the branch, or the first seven characters of a detached HEAD. */
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
	/** The shared git directory. It is what makes folders one repository. */
	readonly commonDir: URI;
	/** Sorted by label, numerically: `w2` before `w10`. */
	readonly worktrees: readonly IWorkspaceBarWorktree[];
}

/** A folder with no repository of its own. */
export interface IWorkspaceBarPlainFolder {
	readonly kind: 'folder';
	readonly folder: IWorkspaceFolder;
}

/** A row of the bar's first level. */
export type WorkspaceBarGroup = IWorkspaceBarRepository | IWorkspaceBarPlainFolder;

/** What the reader needs of the folder list. `WorkspaceBarModel` is one. */
export interface IWorkspaceBarFolders {
	readonly folders: readonly IWorkspaceFolder[];
	readonly onDidChange: Event<void>;
	readonly key: FolderKey;
}

/**
 * Which folders of the workspace are one repository, and which worktrees git records for it.
 *
 * ⚠️ Read from the files git writes, never from `ISCMService`. That service holds whichever
 * repositories the git extension happens to have open, and the extension closes and reopens them as
 * the window changes folder - a list built on it collapses and refills on every switch (L1-PLAN.md,
 * step 2). Reading the files is also what upstream does for itself (`getWorktreesFS` in the git
 * extension), and it runs no git: the renderer cannot.
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

	/** The first level of the bar, in `folders[]` order. Empty until the first read finishes. */
	get groups(): readonly WorkspaceBarGroup[] {
		return this._groups;
	}

	private _ready = false;

	/**
	 * Whether a read has finished. ⚠️ Until then `groups` is empty rather than wrong, and a bar drawn
	 * from it would start blank and fill in; the bar draws `folders[]` flat instead until this is true.
	 */
	get ready(): boolean {
		return this._ready;
	}

	/** The directories git writes to, one watcher each, keyed like folders. */
	private readonly watchers = this._register(new DisposableMap<string>());

	/**
	 * ⚠️ Batched: one `git commit` writes several files under the git directory, and a switch of
	 * branch rewrites HEAD more than once. One read after they settle, not one per write.
	 */
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.refresh().then(undefined, onUnexpectedError), 250));

	/** Which read is the latest. A slower, older read never overwrites a newer one. */
	private generation = 0;

	/** What the last read found, to compare the next one with. */
	private signature = '';

	constructor(
		private readonly source: IWorkspaceBarFolders,
		@IFileService private readonly fileService: IFileService,
	) {
		super();

		// ⚠️ Now, not batched: a folder somebody just added should be on the bar in the same moment as
		// before this reader existed. The batching is for git's own writes.
		this._register(this.source.onDidChange(() => this.refresh().then(undefined, onUnexpectedError)));
		this.refresh().then(undefined, onUnexpectedError);
	}

	/** Reads everything again, now. */
	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const { groups, watch } = await readGroups(this.fileService, this.source.key, this.source.folders);
		if (generation !== this.generation || this._store.isDisposed) {
			return;
		}

		this.watch(watch);

		// ⚠️ Kept even when nothing changed: a workspace edit hands out new folder objects for the same
		// folders, and the groups must hold the current ones. Only the event depends on the comparison.
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
	 * ⚠️ Correlated (`createWatcher`), so these events reach this listener and nothing else.
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

			const store = new DisposableStore();
			const watcher = store.add(this.fileService.createWatcher(uri, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(() => this.scheduler.schedule()));
			this.watchers.set(key, store);
		}
	}
}

/** Where a folder's repository keeps its git directory, when the folder has one of its own. */
interface IGitLocation {
	/** The shared git directory. */
	readonly commonDir: URI;
	/** This folder's own git directory: the common one for a main checkout. */
	readonly gitDir: URI;
	/** A main checkout, rather than a linked worktree. */
	readonly isMain: boolean;
}

interface IHead {
	readonly branch: string | undefined;
	readonly label: string;
}

/** A detached HEAD shows this many characters of its hash, as `git log --oneline` does. */
const SHORT_HASH_LENGTH = 7;

async function readText(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		return (await fileService.readFile(uri)).value.toString().trim();
	} catch {
		return undefined;
	}
}

/**
 * A path git wrote into one of its files, as a URI next to `base`.
 *
 * ⚠️ Absolute unless `worktree.useRelativePaths` is set, and then relative to the file's own
 * directory. The test for absolute is the path's own shape rather than this machine's `path` module:
 * a folder on a remote can be written by another operating system than the one reading it.
 *
 * ⚠️ `joinPath`, not `resolvePath`, for the relative case: both fold `..` away, but `resolvePath`
 * resolves a `file:` path against this machine as well and gives it a drive letter on Windows, so one
 * repository reached through a relative `commondir` came out as two.
 */
function toUri(base: URI, path: string): URI {
	if (!/^(?:[a-zA-Z]:)?[\\/]/.test(path)) {
		return joinPath(base, path.replace(/\\/g, '/'));
	}

	const file = URI.file(path);
	return base.scheme === Schemas.file ? file : base.with({ path: file.path });
}

async function readHead(fileService: IFileService, gitDir: URI): Promise<IHead | undefined> {
	const content = await readText(fileService, joinPath(gitDir, 'HEAD'));
	if (!content) {
		return undefined;
	}

	const ref = /^ref:\s*(?<ref>.+)$/.exec(content)?.groups?.ref;
	if (!ref) {
		return { branch: undefined, label: content.slice(0, SHORT_HASH_LENGTH) };
	}

	// ⚠️ The prefix comes off here, once. Branch names compared anywhere else with it still on never
	// match - which is how Kumite's "checked out elsewhere" check never fired.
	const branch = /^refs\/heads\/(?<branch>.+)$/.exec(ref)?.groups?.branch;
	return { branch, label: branch ?? ref };
}

async function locate(fileService: IFileService, folder: URI): Promise<IGitLocation | undefined> {
	const dotGit = joinPath(folder, '.git');

	let isDirectory: boolean;
	try {
		isDirectory = (await fileService.stat(dotGit)).isDirectory;
	} catch {
		return undefined;
	}

	if (isDirectory) {
		return { commonDir: dotGit, gitDir: dotGit, isMain: true };
	}

	const content = await readText(fileService, dotGit);
	const target = content && /^gitdir:\s*(?<path>.+)$/m.exec(content)?.groups?.path;
	if (!target) {
		return undefined;
	}

	const gitDir = toUri(folder, target.trim());
	const common = await readText(fileService, joinPath(gitDir, 'commondir'));

	// No `commondir`: a main checkout whose git directory lives elsewhere (`--separate-git-dir`).
	return common
		? { commonDir: toUri(gitDir, common), gitDir, isMain: false }
		: { commonDir: gitDir, gitDir, isMain: true };
}

interface IRecordedWorktree {
	readonly uri: URI;
	readonly head: IHead;
	readonly exists: boolean;
}

/** Every linked worktree git records under `<common>/worktrees`, and the directories it read them from. */
async function readRecordedWorktrees(fileService: IFileService, commonDir: URI): Promise<{ worktrees: IRecordedWorktree[]; admin: URI[] }> {
	let children: readonly { resource: URI; isDirectory: boolean }[];
	try {
		children = (await fileService.resolve(joinPath(commonDir, 'worktrees'))).children ?? [];
	} catch {
		return { worktrees: [], admin: [] };
	}

	const directories = children.filter(child => child.isDirectory).map(child => child.resource);
	const read = await Promise.all(directories.map(async (admin): Promise<IRecordedWorktree | undefined> => {
		const gitdir = await readText(fileService, joinPath(admin, 'gitdir'));
		const head = await readHead(fileService, admin);
		if (!gitdir || !head) {
			return undefined;
		}

		const uri = toUri(admin, gitdir.replace(/[\\/]\.git$/, ''));
		return { uri, head, exists: await fileService.exists(uri) };
	}));

	return { worktrees: coalesce(read), admin: directories };
}

interface IRepositoryDraft {
	readonly kind: 'draft';
	readonly commonDir: URI;
	readonly members: { readonly folder: IWorkspaceFolder; readonly location: IGitLocation }[];
}

/** The groups for `folders`, and the directories to watch to know when they change. */
async function readGroups(fileService: IFileService, key: FolderKey, folders: readonly IWorkspaceFolder[]): Promise<{ groups: WorkspaceBarGroup[]; watch: URI[] }> {
	const canonicalKey = async (uri: URI) => key(await canonicalUri(fileService, uri));
	const locations = await Promise.all(folders.map(folder => locate(fileService, folder.uri)));

	// First pass, in folders[] order: a plain folder is its own row, and every folder of one
	// repository joins the row made by the first of them. That is WT-1.6: a repository sits where its
	// first member is.
	const order: (IWorkspaceBarPlainFolder | IRepositoryDraft)[] = [];
	const drafts = new Map<string, IRepositoryDraft>();
	for (let index = 0; index < folders.length; index++) {
		const folder = folders[index];
		const location = locations[index];
		if (!location) {
			order.push({ kind: 'folder', folder });
			continue;
		}

		const common = await canonicalKey(location.commonDir);
		let draft = drafts.get(common);
		if (!draft) {
			draft = { kind: 'draft', commonDir: location.commonDir, members: [] };
			drafts.set(common, draft);
			order.push(draft);
		}

		draft.members.push({ folder, location });
	}

	const watch: URI[] = [];
	const groups: WorkspaceBarGroup[] = [];
	for (const entry of order) {
		if (entry.kind === 'folder') {
			groups.push(entry);
			continue;
		}

		// The main checkout: the member that is one, or else the directory the shared git directory
		// sits in. ⚠️ A bare repository, or one whose git directory lives elsewhere, has none to find
		// from a worktree - its worktrees then stay plain rows rather than hang under a guess.
		const mainMember = entry.members.find(member => member.location.isMain);
		const main = mainMember?.folder.uri ?? (basename(entry.commonDir) === '.git' ? dirname(entry.commonDir) : undefined);
		if (!main) {
			groups.push(...entry.members.map(member => ({ kind: 'folder' as const, folder: member.folder })));
			continue;
		}

		const { worktrees: recorded, admin } = await readRecordedWorktrees(fileService, entry.commonDir);
		watch.push(entry.commonDir, joinPath(entry.commonDir, 'worktrees'), ...admin);

		const memberKeys = new Map<string, IWorkspaceFolder>();
		for (const member of entry.members) {
			memberKeys.set(await canonicalKey(member.folder.uri), member.folder);
		}

		const worktrees: IWorkspaceBarWorktree[] = [];
		const listed = new Set<string>();
		for (const worktree of recorded) {
			const worktreeKey = await canonicalKey(worktree.uri);
			listed.add(worktreeKey);
			worktrees.push({ uri: worktree.uri, branch: worktree.head.branch, label: worktree.head.label, exists: worktree.exists, folder: memberKeys.get(worktreeKey) });
		}

		// A linked worktree in folders[] that git's own list does not carry yet: git writes the folder
		// before it writes its record, and a read can land between the two.
		for (const member of entry.members) {
			if (member.location.isMain || listed.has(await canonicalKey(member.folder.uri))) {
				continue;
			}

			const head = await readHead(fileService, member.location.gitDir);
			worktrees.push({ uri: member.folder.uri, branch: head?.branch, label: head?.label ?? basename(member.folder.uri), exists: true, folder: member.folder });
		}

		worktrees.sort((a, b) => compareFileNames(a.label, b.label));

		const mainKey = await canonicalKey(main);
		const mainHead = await readHead(fileService, entry.commonDir);
		groups.push({ kind: 'repository', main, folder: memberKeys.get(mainKey), branch: mainHead?.branch, commonDir: entry.commonDir, worktrees });
	}

	return { groups, watch };
}

/** Everything a row draws, so that a read which found the same thing does not redraw the bar. */
function signatureOf(groups: readonly WorkspaceBarGroup[], key: FolderKey): string {
	return JSON.stringify(groups.map(group => group.kind === 'folder'
		? [key(group.folder.uri), group.folder.name]
		: [key(group.main), group.folder?.name, group.worktrees.map(worktree => [key(worktree.uri), worktree.label, worktree.exists, worktree.folder?.name])]));
}
