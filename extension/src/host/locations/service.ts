/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../../base/errors';
import { folderKeyOf } from '../../base/files';
import { isJsonObject } from '../../base/json';
import { buildCatalog, isWithin, locationIdOf, WorktreeFacts } from '../../core/locations/catalog';
import { Catalog, Disposable, Event, GitState, Location, LocationId, LocationPort, LocationRemoval, LogPort, WorkspaceFolderInfo } from '../../core/ports';
import { Checkout, GitError, ListedWorktree } from './gitRead';

/** The window's workspace folders in editor order, and when they change (WORKTREES-1.3). */
export interface FolderSource {
	folders(): readonly WorkspaceFolderInfo[];
	readonly onDidChange: Event<void>;
}

/** Git as discovery reads it (WORKTREES-4.1, 4.2). */
export interface GitAccess {
	/** The Git to run for `folder` (`git.path` in its scope, else the PATH's); undefined where there is none. */
	executable(folder: WorkspaceFolderInfo): Promise<string | undefined>;
	checkoutOf(git: string, folder: string): Promise<Checkout | undefined>;
	worktreesOf(git: string, commonDir: string): Promise<readonly ListedWorktree[]>;
}

/**
 * Where the window keeps what it last knew of its locations, across extension-host restarts (RULES-2.4): removing the
 * first workspace folder restarts the host, so the next activation tells a removal from a reload by it. The composition
 * root backs it with workspace storage; what `get` returns is validated, never trusted.
 */
export interface KnownLocations {
	get(): unknown;
	set(state: KnownState): void;
}

export interface KnownState {
	readonly folders: readonly KnownFolder[];
	readonly repositories: readonly KnownRepository[];
}

interface KnownFolder extends WorkspaceFolderInfo {
	readonly key: string;
	readonly checkout?: FolderCheckout;
}

interface KnownRepository {
	readonly key: string;
	readonly commonDir: string;
	readonly worktrees: readonly WorktreeFacts[];
}

/** Whether a path is there: `missing` only for ENOENT/ENOTDIR; a permission error or anything else is no answer. */
export type PathState = 'missing' | 'present' | 'unknown';

export interface LocationServiceDeps {
	/** `local`, or the remote environment the window's workspace runs in. */
	readonly environment: string;
	readonly folders: FolderSource;
	readonly git: GitAccess;
	/** Watches a repository's shared Git directory for worktrees coming and going and HEADs moving (WORKTREES-1.3). */
	readonly watch: (commonDir: string, folder: WorkspaceFolderInfo, onEvent: () => void) => Disposable;
	/** The URI of `path`, derived from the URI of a folder of the window (WORKTREES-3.1). */
	readonly uriOf: (folderUri: string, path: string) => string;
	readonly known: KnownLocations;
	readonly log: LogPort;
	/** A path's canonical comparison key: its real path, case-folded where the platform ignores case. */
	readonly keyOf?: (path: string) => string;
	readonly probe?: (path: string) => Promise<PathState>;
	/** Whether a directory is at `path`, checked on use (WORKTREES-1.2). */
	readonly isDirectory?: (path: string) => boolean;
	/** How long a burst of Git directory events is gathered into one read. */
	readonly eventDelayMs?: number;
}

/** What a refresh could not read, for whoever asked for it (WORKTREES-1.1): never a notification of the service's own. */
export class LocationRefreshError extends Error {
	constructor(readonly failures: readonly Failure[]) {
		super(failures.map(failure => `Git could not read ${failure.path}: ${failure.message}`).join('\n'));
		this.name = 'LocationRefreshError';
	}
}

export interface Failure {
	readonly path: string;
	/** Git's own diagnostic (WORKTREES-4.2). */
	readonly message: string;
}

interface FolderCheckout {
	readonly root: string;
	readonly rootKey: string;
	readonly repository: string;
}

interface FolderState {
	info: WorkspaceFolderInfo;
	readonly key: string;
	git: GitState;
	checkout?: FolderCheckout;
}

interface RepositoryState {
	readonly key: string;
	commonDir: string;
	/** The folder whose Git, settings and URI it is read and watched with. */
	via: WorkspaceFolderInfo;
	git: GitState;
	worktrees: WorktreeFacts[];
	failure?: Failure;
	readonly reads: Coalesced;
	watcher?: Disposable;
	timer?: ReturnType<typeof setTimeout>;
}

const EVENT_DELAY_MS = 150;

/**
 * The window's one location service (WORKTREES-4.1). `snapshot()` answers at once with every workspace folder; Git
 * metadata follows (WORKTREES-1.1). Reads are coalesced per repository and run on folder changes, `refresh()` (a picker
 * opening, a worktree made or deleted) and Git directory events - never on a timer (WORKTREES-1.3). A failed read keeps what was known
 * as stale. `onDidRemove` reports only removed workspace folders' locations and confirmed deletions (RULES-2.4).
 */
export class LocationService implements LocationPort, Disposable {
	private readonly changedEmitter: Emitter<void>;
	private readonly removedEmitter: Emitter<LocationRemoval>;
	readonly onDidChange: Event<void>;
	readonly onDidRemove: Event<LocationRemoval>;

	private readonly keyOf: (path: string) => string;
	private readonly probe: (path: string) => Promise<PathState>;
	private readonly isDirectory: (path: string) => boolean;
	private folderStates: FolderState[];
	private readonly repositories = new Map<string, RepositoryState>();
	private catalog: Catalog;
	private byId = new Map<LocationId, Location>();
	/** Locations whose worktrees are being deleted, and the catalog without them that others see meanwhile. */
	private readonly deleting = new Set<LocationId>();
	private visible: Catalog | undefined;
	private keys = new Map<LocationId, string>();
	private readonly removals = new Map<LocationId, LocationRemoval['cause']>();
	private readonly full = new Coalesced();
	private readonly subscription: Disposable;
	private knownText: string | undefined;
	private disposed = false;

	constructor(private readonly deps: LocationServiceDeps) {
		const failed = (err: unknown) => deps.log.event(`A working-location listener failed: ${messageOf(err)}`);
		this.changedEmitter = new Emitter(failed);
		this.removedEmitter = new Emitter(failed);
		this.onDidChange = this.changedEmitter.event;
		this.onDidRemove = this.removedEmitter.event;
		this.keyOf = deps.keyOf ?? folderKeyOf;
		this.probe = deps.probe ?? probePath;
		this.isDirectory = deps.isDirectory ?? isDirectoryAt;
		const known = knownStateOf(deps.known.get(), () => deps.log.event('Ignored stored working locations this build does not read, as from an earlier build'));
		// What was known of the same folders seeds the first snapshot as pending; the first reads confirm or correct it
		this.folderStates = deps.folders.folders().map(info => {
			const key = this.keyOf(info.path);
			const was = known?.folders.find(each => each.uri === info.uri && each.key === key);
			return { info, key, git: 'pending', ...(was?.checkout ? { checkout: was.checkout } : {}) };
		});
		for (const repository of known?.repositories ?? []) {
			const via = this.folderStates.find(each => each.checkout?.repository === repository.key)?.info;
			if (via) {
				this.repositories.set(repository.key, { key: repository.key, commonDir: repository.commonDir, via, git: 'pending', worktrees: [...repository.worktrees], reads: new Coalesced() });
			}
		}
		const present = new Set(this.folderStates.map(each => each.info.uri));
		this.catalog = this.build();
		this.index();
		// Locations known last time whose every workspace folder is gone now: removed while no host ran, as removing the first
		// folder restarts it (RULES-2.4)
		const previous = known && buildCatalog({
			environment: deps.environment,
			folders: known.folders.map(({ key, checkout, ...folder }) => ({ folder, key, git: 'ok', ...(checkout ? { checkout } : {}) })),
			repositories: new Map(known.repositories.map(each => [each.key, { git: 'ok', worktrees: each.worktrees }])),
			uriOf: deps.uriOf
		});
		const gone = previous?.locations.filter(each => !this.byId.has(each.id) && each.folders.every(folder => !present.has(folder.uri))).map(each => each.id) ?? [];
		this.subscription = deps.folders.onDidChange(() => this.foldersChanged());
		this.syncWatchers();
		void this.start(gone);
	}

	snapshot(): Catalog {
		if (!this.deleting.size) {
			return this.catalog;
		}
		return this.visible ??= { ...this.catalog, locations: this.catalog.locations.filter(each => !this.deleting.has(each.id)) };
	}

	/**
	 * Takes `id` out of the catalog others see and out of `resolve` while its worktree is deleted (WORKTREES-3.2): no launch goes
	 * there meanwhile. Its removal, once confirmed, is still told. The result puts it back where it is not gone.
	 */
	markDeleting(id: LocationId): () => void {
		this.deleting.add(id);
		this.visible = undefined;
		this.changedEmitter.fire();
		let done = false;
		return () => {
			if (!done) {
				done = true;
				this.deleting.delete(id);
				this.visible = undefined;
				this.changedEmitter.fire();
			}
		};
	}

	resolve(id: LocationId): Location | undefined {
		if (this.deleting.has(id)) {
			return undefined;
		}
		const location = this.byId.get(id);
		// Revalidated on use (WORKTREES-1.2): a location whose directory is gone is no place to start a CLI
		return location && this.isDirectory(location.path) ? location : undefined;
	}

	/** Reads every folder and repository again; rejects with a `LocationRefreshError` for what could not be read (WORKTREES-1.1, 1.3). */
	refresh(): Promise<void> {
		return this.full.run(() => this.readAll());
	}

	/**
	 * Whether this service reported `id` removed in this session: for a run found again after a reload, whose removal may have
	 * been reported before it was known (RULES-2.4).
	 */
	removalOf(id: LocationId): LocationRemoval['cause'] | undefined {
		return this.removals.get(id);
	}

	/** The location of this window's catalog at `directory`, compared by canonical path; undefined where there is none. */
	locationAt(directory: string): Location | undefined {
		return this.byId.get(locationIdOf(this.deps.environment, this.keyOf(path.resolve(directory))));
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		for (const repository of this.repositories.values()) {
			this.forgetWatch(repository);
		}
		this.changedEmitter.dispose();
		this.removedEmitter.dispose();
	}

	private async start(gone: readonly LocationId[]): Promise<void> {
		// After construction, so whoever subscribes right after constructing hears it
		await Promise.resolve();
		if (this.disposed) {
			return;
		}
		if (gone.length) {
			this.report({ ids: gone, cause: 'folder' });
		}
		try {
			await this.refresh();
		} catch (err) {
			// No one asked for this read: what failed is kept stale and logged, not shown (WORKTREES-1.1)
			this.deps.log.event(messageOf(err));
		}
	}

	private foldersChanged(): void {
		this.syncFolders();
		this.refresh().catch(err => this.deps.log.event(messageOf(err)));
	}

	/** Takes the editor's folders as they are now; the locations of removed folders are reported at once (WORKTREES-3.3). */
	private syncFolders(): void {
		const infos = this.deps.folders.folders();
		if (infos.length === this.folderStates.length && infos.every((info, at) => sameFolder(info, this.folderStates[at].info))) {
			return;
		}
		const byUri = new Map(this.folderStates.map(each => [each.info.uri, each]));
		this.folderStates = infos.map(info => {
			const state = byUri.get(info.uri);
			if (state) {
				state.info = info;
				return state;
			}
			return { info, key: this.keyOf(info.path), git: 'pending' };
		});
		const present = new Set(infos.map(info => info.uri));
		const after = new Set(this.build().locations.map(each => each.id));
		const gone = this.catalog.locations.filter(each => !after.has(each.id) && each.folders.every(folder => !present.has(folder.uri))).map(each => each.id);
		this.publish(gone.length ? { ids: gone, cause: 'folder' } : undefined);
	}

	private async readAll(): Promise<void> {
		this.syncFolders();
		const failures: Failure[] = [];
		await Promise.all(this.folderStates.map(async folder => {
			const failure = await this.readFolder(folder);
			if (failure) {
				failures.push(failure);
			}
		}));
		// Every repository known before or found now: one no folder refers to any more is read once more, so that deletions of its
		// worktrees are still confirmed, and then forgotten
		const repositories = [...this.repositories.values()];
		await Promise.all(repositories.map(repository => repository.reads.run(() => this.readRepository(repository))));
		failures.push(...repositories.flatMap(repository => repository.failure ? [repository.failure] : []));
		for (const repository of repositories.filter(each => !this.isReferenced(each.key))) {
			this.forgetWatch(repository);
			this.repositories.delete(repository.key);
		}
		this.publish();
		if (failures.length) {
			throw new LocationRefreshError(failures);
		}
	}

	/** Where Git places `folder` now. */
	private async readFolder(folder: FolderState): Promise<Failure | undefined> {
		// A folder gone from the disk has no Git metadata: Git would only fail to enter it
		if (await this.probe(folder.info.path) === 'missing') {
			folder.git = 'none';
			folder.checkout = undefined;
			return undefined;
		}
		try {
			const git = await this.deps.git.executable(folder.info);
			const checkout = git === undefined ? 'missing' : await this.deps.git.checkoutOf(git, folder.info.path);
			if (checkout === 'missing') {
				folder.git = 'missing';
				folder.checkout = undefined;
			} else if (!checkout) {
				folder.git = 'none';
				folder.checkout = undefined;
			} else {
				const repository = this.repositoryOf(checkout.commonDir, folder.info);
				folder.checkout = { root: checkout.root, rootKey: this.keyOf(checkout.root), repository: repository.key };
				folder.git = 'ok';
			}
			return undefined;
		} catch (err) {
			// Missing Git is normal and silent; a failed read keeps what was known, as stale (WORKTREES-1.1)
			if (err instanceof GitError && err.missing) {
				folder.git = 'missing';
				folder.checkout = undefined;
				return undefined;
			}
			folder.git = folder.checkout ? 'stale' : 'failed';
			return { path: folder.info.path, message: messageOf(err) };
		}
	}

	private repositoryOf(commonDir: string, via: WorkspaceFolderInfo): RepositoryState {
		const key = this.keyOf(commonDir);
		const known = this.repositories.get(key);
		if (known) {
			known.commonDir = commonDir;
			known.via = via;
			return known;
		}
		const repository: RepositoryState = { key, commonDir, via, git: 'pending', worktrees: [], reads: new Coalesced() };
		this.repositories.set(key, repository);
		return repository;
	}

	/** Lists the repository's registered worktrees again; confirms deletions; never throws, keeping its failure for the caller. */
	private async readRepository(repository: RepositoryState): Promise<void> {
		let listed: readonly ListedWorktree[];
		try {
			const git = await this.deps.git.executable(repository.via);
			if (git === undefined) {
				throw new GitError('Git was not found.', undefined, true);
			}
			listed = await this.deps.git.worktreesOf(git, repository.commonDir);
		} catch (err) {
			// Kept as known, marked stale: a failed read, a permission error or a timeout is never deletion (WORKTREES-1.3)
			repository.git = repository.git === 'pending' && !repository.worktrees.length || repository.git === 'failed' ? 'failed' : 'stale';
			repository.worktrees = repository.worktrees.map(each => ({ ...each, stale: true }));
			repository.failure = err instanceof GitError && err.missing ? undefined : { path: repository.commonDir, message: messageOf(err) };
			this.publish();
			return;
		}
		repository.failure = undefined;
		const now: WorktreeFacts[] = listed.filter(each => !each.bare && !each.prunable).map(each => ({
			path: each.path,
			key: this.keyOf(each.path),
			main: each.main,
			...(each.branch !== undefined ? { branch: each.branch } : {}),
			detached: each.detached
		}));
		const listedKeys = new Set(now.map(each => each.key));
		const gone: string[] = [];
		for (const before of repository.worktrees.filter(each => !listedKeys.has(each.key))) {
			// Confirmed deletion: this successful read no longer lists it, or lists it prunable, and its root path does not
			// exist (WORKTREES-1.3). Anything else keeps it, stale.
			if (await this.probe(before.path) === 'missing') {
				gone.push(before.key);
			} else {
				now.push({ ...before, stale: true });
			}
		}
		repository.worktrees = now;
		repository.git = 'ok';
		this.publish(this.deletionOf(gone));
	}

	/**
	 * The removal of worktrees confirmed deleted, with the locations that belong to them - opened folders inside them - so that the
	 * agents launched there close (WORKTREES-3.3). Another registered worktree inside one goes only on its own confirmation. A folder
	 * keeps its place as a plain folder: no workspace root is removed.
	 */
	private deletionOf(roots: readonly string[]): LocationRemoval | undefined {
		if (!roots.length) {
			return undefined;
		}
		const worktrees = new Set([...this.repositories.values()].flatMap(each => each.worktrees.map(worktree => worktree.key)));
		const removal = this.removalWhere(key => roots.some(root => key === root || (isWithin(key, root) && !worktrees.has(key))));
		const inside = (key: string) => roots.some(root => isWithin(key, root));
		for (const folder of this.folderStates.filter(each => each.checkout && inside(each.checkout.rootKey))) {
			folder.checkout = undefined;
			folder.git = 'none';
		}
		return removal;
	}

	private removalWhere(removed: (key: string) => boolean): LocationRemoval | undefined {
		const ids = this.catalog.locations.filter(each => {
			const key = this.keys.get(each.id);
			return key !== undefined && removed(key);
		}).map(each => each.id);
		return ids.length ? { ids, cause: 'deleted' } : undefined;
	}

	private gitChanged(repository: RepositoryState): void {
		// One read for a burst: the first event of it schedules it, the rest join it
		if (repository.timer !== undefined || this.disposed) {
			return;
		}
		repository.timer = setTimeout(() => {
			repository.timer = undefined;
			repository.reads.run(() => this.readRepository(repository)).then(() => {
				if (repository.failure) {
					this.deps.log.event(`Git could not read ${repository.failure.path}: ${repository.failure.message}`);
				}
			}, err => this.deps.log.event(messageOf(err)));
		}, this.deps.eventDelayMs ?? EVENT_DELAY_MS);
	}

	private publish(removal?: LocationRemoval): void {
		if (this.disposed) {
			return;
		}
		const next = this.build();
		const changed = JSON.stringify(next) !== JSON.stringify(this.catalog);
		this.catalog = next;
		this.visible = undefined;
		this.index();
		this.syncWatchers();
		this.persist();
		if (removal) {
			this.report(removal);
		}
		if (changed) {
			this.changedEmitter.fire();
		}
	}

	private build(): Catalog {
		return buildCatalog({
			environment: this.deps.environment,
			folders: this.folderStates.map(folder => ({ folder: folder.info, key: folder.key, git: folder.git, ...(folder.checkout ? { checkout: folder.checkout } : {}) })),
			repositories: this.repositories,
			uriOf: this.deps.uriOf
		});
	}

	/** The published catalog by ID, and each location's comparison key. */
	private index(): void {
		this.byId = new Map(this.catalog.locations.map(each => [each.id, each]));
		const keys = [
			...this.folderStates.map(each => each.key),
			...[...this.repositories.values()].flatMap(each => each.worktrees.map(worktree => worktree.key))
		];
		this.keys = new Map(keys.map(key => [locationIdOf(this.deps.environment, key), key]));
	}

	private report(removal: LocationRemoval): void {
		for (const id of removal.ids) {
			this.removals.set(id, removal.cause);
		}
		this.deps.log.event(`Working locations ${removal.cause === 'folder' ? 'removed with their workspace folder' : 'deleted'}: ${removal.ids.join(', ')}`);
		this.removedEmitter.fire(removal);
	}

	private isReferenced(repository: string): boolean {
		return this.folderStates.some(each => each.checkout?.repository === repository);
	}

	private syncWatchers(): void {
		for (const repository of this.repositories.values()) {
			if (!this.isReferenced(repository.key)) {
				this.forgetWatch(repository);
			} else if (!repository.watcher) {
				try {
					repository.watcher = this.deps.watch(repository.commonDir, repository.via, () => this.gitChanged(repository));
				} catch (err) {
					this.deps.log.event(`Could not watch ${repository.commonDir}: ${messageOf(err)}`);
				}
			}
		}
	}

	private forgetWatch(repository: RepositoryState): void {
		repository.watcher?.dispose();
		repository.watcher = undefined;
		clearTimeout(repository.timer);
		repository.timer = undefined;
	}

	/** Saves what the window knows now, for the next activation's reconciliation. */
	private persist(): void {
		const state: KnownState = {
			folders: this.folderStates.map(each => ({ ...each.info, key: each.key, ...(each.checkout ? { checkout: each.checkout } : {}) })),
			repositories: [...this.repositories.values()].filter(each => this.isReferenced(each.key)).map(each => ({
				key: each.key,
				commonDir: each.commonDir,
				worktrees: each.worktrees.map(worktree => ({ path: worktree.path, key: worktree.key, main: worktree.main, ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}), detached: worktree.detached }))
			}))
		};
		const text = JSON.stringify(state);
		if (text === this.knownText) {
			return;
		}
		this.knownText = text;
		try {
			this.deps.known.set(state);
		} catch (err) {
			this.deps.log.event(`Could not save the known working locations: ${messageOf(err)}`);
		}
	}
}

function sameFolder(a: WorkspaceFolderInfo, b: WorkspaceFolderInfo): boolean {
	return a.uri === b.uri && a.index === b.index && a.name === b.name && a.path === b.path;
}

async function probePath(file: string): Promise<PathState> {
	try {
		await fs.promises.lstat(file);
		return 'present';
	} catch (err) {
		const code = codeOf(err);
		return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
	}
}

function isDirectoryAt(file: string): boolean {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

/**
 * What the store held, if it is a known state; anything else - an earlier build's record, a damaged one - is none, and an entry
 * of another shape is left out, either said once by `ignored` (S1, ARCHITECTURE-4.2).
 */
function knownStateOf(value: unknown, ignored: () => void): KnownState | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isJsonObject(value) || !Array.isArray(value.folders) || !Array.isArray(value.repositories)) {
		ignored();
		return undefined;
	}
	const text = (each: unknown): each is string => typeof each === 'string';
	const isCheckout = (each: unknown): each is FolderCheckout => isJsonObject(each) && text(each.root) && text(each.rootKey) && text(each.repository);
	const isFolder = (each: unknown): each is KnownFolder => isJsonObject(each) && typeof each.index === 'number' && text(each.name) && text(each.uri) && text(each.path) && text(each.key)
		&& (each.checkout === undefined || isCheckout(each.checkout));
	const isWorktree = (each: unknown): each is WorktreeFacts => isJsonObject(each) && text(each.path) && text(each.key) && typeof each.main === 'boolean'
		&& (each.branch === undefined || text(each.branch)) && typeof each.detached === 'boolean';
	const isRepository = (each: unknown): each is KnownRepository => isJsonObject(each) && text(each.key) && text(each.commonDir) && Array.isArray(each.worktrees) && each.worktrees.every(isWorktree);
	const state = {
		folders: value.folders.filter(isFolder),
		repositories: value.repositories.filter(isRepository)
	};
	if (state.folders.length !== value.folders.length || state.repositories.length !== value.repositories.length) {
		ignored();
	}
	return state;
}

/** Runs a read once at a time: a request during a read gets the one read that starts after it, shared by every such request. */
class Coalesced {
	private running: Promise<void> | undefined;
	private queued: Promise<void> | undefined;

	run(read: () => Promise<void>): Promise<void> {
		if (this.queued) {
			return this.queued;
		}
		if (this.running) {
			this.queued = this.running.then(() => undefined, () => undefined).then(() => {
				this.queued = undefined;
				return this.start(read);
			});
			return this.queued;
		}
		return this.start(read);
	}

	private start(read: () => Promise<void>): Promise<void> {
		const running = read();
		this.running = running;
		const clear = () => {
			if (this.running === running) {
				this.running = undefined;
			}
		};
		running.then(clear, clear);
		return running;
	}
}

class Emitter<T> {
	private readonly listeners = new Set<(value: T) => void>();

	constructor(private readonly failed: (err: unknown) => void) { }

	readonly event: Event<T> = listener => {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(value);
			} catch (err) {
				this.failed(err);
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}
