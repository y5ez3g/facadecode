/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The location, CLI and worktree ports of the Rust engine (ARCHITECTURE-1.1): the window's `WindowInfo` from core, read as the types the
// UI already takes. Core decides every location, CLI and worktree; nothing here reads Git, except what deleting a worktree has always read.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CliInfo, LocationInfo, WindowInfo } from '../../base/coreProtocol';
import { folderKeyOf, realFolderOf } from '../../base/files';
import { isWithin } from '../../core/locations/catalog';
import { plannedDestination, whyNotFolderName } from '../../core/locations/destination';
import { WorktreeProblem, WorktreeProblemError } from '../../core/locations/problems';
import { Catalog, CliCatalogPort, CliChoices, Disposable, Event, Location, LocationId, LocationPort, LocationRemoval, WorkspaceFolderInfo, WorktreeError, WorktreePlan, WorktreePort } from '../../core/ports';
import { SETTINGS_FILE } from '../../clis/settingsFile';
import { facadeRoot } from '../../record/paths';
import { shownFile } from '../facadeSettings';
import { editorNativeGit } from '../locations/nativeGit';
import { WorktreeService } from '../locations/worktrees';
import { editorGit, editorGitCreationSettings, editorUriOf } from '../locations/workspaceFolders';
import { DaemonError, DaemonLink } from './types';

// ---------------------------------------------------------------------------------------------------------------------------
// Locations

interface Built {
	readonly catalog: Catalog;
	readonly byId: ReadonlyMap<LocationId, Location>;
}

/** The ID core gives the location at `path`: `loc-` and the first 16 hexadecimal digits of the SHA-256 of the path. */
function coreLocationId(realPath: string): LocationId {
	return `loc-${crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 16)}`;
}

/** The window's locations as core lists them (WORKTREES-1.1): none is made or read here, and Git is never asked. */
export class RustLocations implements LocationPort, Disposable {
	readonly onDidChange: Event<void>;
	readonly onDidRemove: Event<LocationRemoval>;
	private readonly changedEmitter = new vscode.EventEmitter<void>();
	private readonly removedEmitter = new vscode.EventEmitter<LocationRemoval>();
	private readonly removals = new Map<LocationId, LocationRemoval['cause']>();
	private readonly subscription: Disposable;
	private memo?: { readonly info: WindowInfo | undefined; readonly folders: string; readonly built: Built };
	private previous: Built;

	constructor(
		private readonly windowInfo: () => WindowInfo | undefined,
		changed: Event<void>,
		private readonly folders: () => readonly WorkspaceFolderInfo[],
		private readonly remote: string | undefined,
		private readonly reread: () => Promise<void>
	) {
		this.onDidChange = this.changedEmitter.event;
		this.onDidRemove = this.removedEmitter.event;
		this.previous = this.current();
		// Removals are told before the change, so a listener of the change finds `removalOf` answering
		this.subscription = changed(() => {
			this.diff();
			this.changedEmitter.fire();
		});
	}

	snapshot(): Catalog {
		return this.current().catalog;
	}

	resolve(id: LocationId): Location | undefined {
		return this.current().byId.get(id);
	}

	/** Core reads Git itself whenever the window is described again: `reread` is that `window.update`, answered once core has read. */
	refresh(): Promise<void> {
		return this.reread();
	}

	removalOf(id: LocationId): LocationRemoval['cause'] | undefined {
		return this.removals.get(id);
	}

	/** A conversation's cwd inside this window: a location of core's, else a folder inside the innermost one, which is its `within`. */
	conversationLocation(cwd: string): Location | undefined {
		if (!path.isAbsolute(cwd) || !isDirectory(cwd)) {
			return undefined;
		}
		const at = folderKeyOf(cwd);
		let anchor: { readonly location: Location; readonly key: string } | undefined;
		for (const each of this.current().catalog.locations) {
			const key = folderKeyOf(each.path);
			if (isWithin(at, key) && (!anchor || key.length > anchor.key.length)) {
				anchor = { location: each, key };
			}
		}
		if (!anchor) {
			return undefined;
		}
		if (anchor.key === at) {
			return anchor.location;
		}
		const { location } = anchor;
		return { id: coreLocationId(realFolderOf(cwd)), path: cwd, uri: editorUriOf(location.uri, cwd), environment: location.environment, label: path.basename(cwd),
			folders: location.folders, kind: 'folder', opened: false, git: 'ok', within: location.id };
	}

	dispose(): void {
		this.subscription.dispose();
		this.changedEmitter.dispose();
		this.removedEmitter.dispose();
	}

	/** Tells what the window's locations lost since the last change: a workspace folder's, or a worktree core no longer lists. */
	private diff(): void {
		if (!this.windowInfo()) {
			return;
		}
		const now = this.current();
		const present = new Set(this.folders().map(folder => folder.uri));
		const gone = [...this.previous.byId.values()].filter(each => !now.byId.has(each.id));
		this.previous = now;
		for (const id of now.byId.keys()) {
			this.removals.delete(id);
		}
		for (const cause of ['folder', 'deleted'] as const) {
			const ids = gone.filter(each => (each.folders[0] === undefined || !present.has(each.folders[0].uri) ? 'folder' : 'deleted') === cause).map(each => each.id);
			if (ids.length) {
				ids.forEach(id => this.removals.set(id, cause));
				this.removedEmitter.fire({ ids, cause });
			}
		}
	}

	private current(): Built {
		const info = this.windowInfo();
		const folders = this.folders();
		const key = JSON.stringify(folders.map(folder => [folder.uri, folder.path]));
		let memo = this.memo;
		if (!memo || memo.info !== info || memo.folders !== key) {
			memo = this.memo = { info, folders: key, built: this.build(info?.locations ?? [], info?.environment ?? this.remote ?? 'local', folders) };
		}
		return memo.built;
	}

	private build(infos: readonly LocationInfo[], environment: string, folders: readonly WorkspaceFolderInfo[]): Built {
		const keys = new Map<string, string>();
		const keyOf = (each: string) => keys.get(each) ?? (keys.set(each, folderKeyOf(each)), keys.get(each)!);
		// A `main`, or a `folder` outside the location before it, starts the group of a workspace folder (core lists the main checkout first)
		const groups: LocationInfo[][] = [];
		for (const each of infos) {
			const group = groups.at(-1);
			const before = group?.at(-1);
			if (!group || !before || each.kind === 'main' || (each.kind === 'folder' && !isWithin(keyOf(each.path), keyOf(before.path)))) {
				groups.push([each]);
			} else {
				group.push(each);
			}
		}
		// Each group goes to the first workspace folder not yet taken that is at or inside one of its paths
		const taken = new Set<number>();
		const locations = groups.flatMap(group => {
			let at = folders.findIndex((folder, index) => !taken.has(index) && group.some(each => isWithin(keyOf(folder.path), keyOf(each.path))));
			at = at >= 0 ? at : folders.findIndex((_, index) => !taken.has(index));
			taken.add(at);
			return group.map((each): Location => {
				const inside = folders.filter(folder => isWithin(keyOf(folder.path), keyOf(each.path)));
				const own = [...at >= 0 ? [folders[at]] : [], ...inside.filter(folder => folder !== folders[at])];
				const opened = own.find(folder => keyOf(folder.path) === keyOf(each.path));
				return { id: each.location_id, path: each.path, uri: opened?.uri ?? this.uriOf(each.path), environment, label: each.label, folders: own,
					kind: each.kind === 'folder' ? 'folder' : 'checkout', ...each.kind === 'main' ? { isMain: true } : {}, opened: opened !== undefined, git: 'ok' };
			});
		});
		return { catalog: { locations, folders, pending: false }, byId: new Map(locations.map(each => [each.id, each])) };
	}

	/** The URI of `path` in the window's environment, its remote authority kept (WORKTREES-3.1). */
	private uriOf(file: string): string {
		return this.remote === undefined ? vscode.Uri.file(file).toString()
			: vscode.Uri.from({ scheme: 'vscode-remote', authority: this.remote, path: vscode.Uri.file(file).path }).toString();
	}
}

function isDirectory(folder: string): boolean {
	try {
		return fs.statSync(folder).isDirectory();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------------------
// CLIs

/** Whether a built-in is only not installed here (CLIS-1.1): New Agent does not list it, as it lists one that is wrong. */
function notInstalled(cli: CliInfo): boolean {
	return cli.not_installed === true;
}

/** The CLIs core finds for the window (CONFIGURATION-4.1), from the environment the window described: one for the whole window. */
export class RustClis implements CliCatalogPort {
	constructor(private readonly windowInfo: () => WindowInfo | undefined, private readonly icons: () => (cli: string) => string) { }

	async list(_location: Location): Promise<CliChoices> {
		const icon = this.icons();
		const clis = (this.windowInfo()?.clis ?? []).map(each => ({
			id: each.cli,
			displayName: each.display_name,
			icon: icon(each.cli),
			available: each.available,
			...each.problem !== undefined ? { problem: each.problem } : {},
			...notInstalled(each) ? { notInstalled: true } : {}
		}));
		return { clis, problems: this.problems() };
	}

	/** The settings file wrong as a whole, said by the file (CONFIGURATION-4.1). */
	problems(): CliChoices['problems'] {
		const problem = this.windowInfo()?.settings_problem;
		return problem === undefined ? [] : [{ setting: shownFile(path.join(facadeRoot(), SETTINGS_FILE)), problem }];
	}
}

// ---------------------------------------------------------------------------------------------------------------------------
// Worktrees

function problemError(problem: WorktreeProblem, message: string, reason: string): WorktreeProblemError {
	return new WorktreeProblemError(problem, message, reason);
}

/** New worktrees by core's `worktree.create`; deleting one is the old engine's, through the editor's Git (WORKTREES-3.2). */
export class RustWorktrees implements WorktreePort {
	private readonly deletion: WorktreeService;
	private readonly settings = editorGitCreationSettings();

	/** `changed` is told once a worktree was deleted: the window is described again, so that core reads its locations. */
	constructor(private readonly link: DaemonLink, private readonly locations: LocationPort, private readonly changed: () => void) {
		this.deletion = new WorktreeService({
			locations: { snapshot: () => locations.snapshot(), resolve: id => locations.resolve(id), refresh: () => locations.refresh(),
				locationAt: directory => locations.snapshot().locations.find(each => each.path === directory) },
			git: editorGit(), native: editorNativeGit(), settings: this.settings, locks: '', log: { event: () => undefined }
		});
	}

	/** Available where the location is a Git checkout core lists; Git's own refusals come back from `worktree.create`. */
	async availability(source: LocationId): Promise<{ readonly available: true } | { readonly available: false; readonly reason: string; readonly problem?: WorktreeProblem }> {
		try {
			this.sourceOf(source);
			return { available: true };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message : String(err), ...err instanceof WorktreeProblemError ? { problem: err.problem } : {} };
		}
	}

	/** Validates what needs no Git and proposes where core will put it; a branch that exists or a base that is unknown is core's to refuse. */
	async plan(source: LocationId, branch: string, baseRef?: string): Promise<WorktreePlan> {
		if (typeof branch !== 'string' || branch === '') {
			throw problemError({ kind: 'branch_required' }, 'A branch name is required.', 'invalid_argument');
		}
		if (baseRef !== undefined && (typeof baseRef !== 'string' || baseRef === '')) {
			throw problemError({ kind: 'base_required' }, 'A base commit, branch or tag is required.', 'invalid_argument');
		}
		const at = this.sourceOf(source);
		const folder = at.folders[0];
		const prefix = folder ? this.settings.branchPrefix(folder) : '';
		const unusable = whyNotFolderName(branch, prefix);
		if (unusable) {
			throw problemError(unusable, `"${unusable.name}" cannot be used as a worktree folder name.`, 'invalid_argument');
		}
		const refused = this.patternError(folder, branch);
		if (refused) {
			throw refused;
		}
		const catalog = this.locations.snapshot().locations;
		const main = catalog.find(each => each.isMain && folder && each.folders.some(other => other.uri === folder.uri)) ?? at;
		const listed = new Set(catalog.map(each => folderKeyOf(each.path)));
		const destination = plannedDestination(main.path, branch, prefix, candidate => fs.existsSync(candidate) || listed.has(folderKeyOf(candidate)));
		return { source, branch, baseRef: baseRef ?? 'HEAD', baseCommit: '', destination };
	}

	async create(plan: WorktreePlan, stillWanted: () => boolean): Promise<Location> {
		if (!stillWanted()) {
			throw new WorktreeError('The launch was closed before its worktree was created.', 'cancelled');
		}
		const source = this.sourceOf(plan.source);
		let made;
		try {
			made = await this.link.call<LocationInfo>('worktree.create', { window_id: this.link.window.window_id, cwd: source.path, branch: plan.branch, base_ref: plan.baseRef });
		} catch (err) {
			if (!(err instanceof DaemonError)) {
				throw err;
			}
			const kept = err.data.kept;
			const effects = { ...kept?.branch !== undefined ? { branchCreated: true } : {}, ...kept?.path !== undefined ? { destinationCreated: kept.path } : {} };
			throw err.reason === 'worktree_failed' ? new WorktreeProblemError({ kind: 'creation_failed', detail: err.message }, err.message, err.reason, effects) : new WorktreeError(err.message, err.reason, effects);
		}
		// Core lists it among the window's locations in its own time; this is it, in the folders of the checkout it came from
		return { id: made.location_id, path: made.path, uri: editorUriOf(source.uri, made.path), environment: source.environment, label: made.label, folders: source.folders,
			kind: 'checkout', opened: false, git: 'ok' };
	}

	async remove(id: LocationId, closeAgents: () => Promise<boolean>): Promise<void> {
		try {
			await this.deletion.remove(id, closeAgents);
		} finally {
			this.changed();
		}
	}

	/** The checkout a worktree is made from: a location of core's that is a checkout. */
	private sourceOf(id: LocationId): Location {
		const location = this.locations.resolve(id);
		if (!location) {
			throw problemError({ kind: 'no_location', id }, 'The working location is no longer available.', 'not_found');
		}
		if (location.kind !== 'checkout') {
			throw problemError({ kind: 'not_repository', path: location.path }, `${location.path} is not in a Git repository.`, 'repository_required');
		}
		return location;
	}

	/** `git.branchValidationRegex` judges the branch, as the editor's own flow does (WORKTREES-2.1). */
	private patternError(folder: WorkspaceFolderInfo | undefined, branch: string): WorktreeProblemError | undefined {
		const pattern = folder ? this.settings.branchValidationRegex(folder) : '';
		if (!pattern) {
			return undefined;
		}
		try {
			return new RegExp(pattern).test(branch) ? undefined : problemError({ kind: 'pattern_mismatch', branch, pattern }, `${branch} does not match git.branchValidationRegex (${pattern}).`, 'invalid_argument');
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return problemError({ kind: 'pattern_invalid', detail }, `git.branchValidationRegex is not a valid regular expression: ${detail}`, 'invalid_argument');
		}
	}
}
