/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import { Catalog, GitState, Location, LocationId, RunFacts, WorkspaceFolderInfo } from '../ports';

// The one current-window catalog (WORKTREES-1.2) as a pure function of what was read: its order, deduplication, labels
// and identities are decided here, without Git, a disk or an editor.

/**
 * A location's identity (RULES-2.4, WORKTREES-1.2): `loc-` and the first 16 hex digits of the SHA-256 of its execution
 * environment and canonical path. The path is its comparison key, so links and the platform's case rules do not make
 * two identities of one directory; branch text never enters it.
 */
export function locationIdOf(environment: string, key: string): LocationId {
	return `loc-${crypto.createHash('sha256').update(`${environment}\0${key}`).digest('hex').slice(0, 16)}`;
}

/** A registered worktree as Git last listed it. */
export interface WorktreeFacts {
	/** Its path as Git lists it. */
	readonly path: string;
	/** Its canonical comparison key. */
	readonly key: string;
	/** Whether it is the repository's main checkout (Git lists that first; a bare repository has none). */
	readonly main: boolean;
	/** The branch checked out; none on a detached HEAD, which gets no invented branch (WORKTREES-1.2). */
	readonly branch?: string;
	readonly detached: boolean;
	/** Known before, not confirmed by the latest read: kept and marked stale, never taken for deletion (WORKTREES-1.1, 1.3). */
	readonly stale?: boolean;
}

export interface RepositoryFacts {
	readonly git: GitState;
	/** Its registered, usable worktrees, main first. */
	readonly worktrees: readonly WorktreeFacts[];
}

export interface FolderFacts {
	readonly folder: WorkspaceFolderInfo;
	/** The canonical comparison key of the folder's path. */
	readonly key: string;
	readonly git: GitState;
	/** Where Git places the folder: the key of the worktree root it is in and the key of its repository. */
	readonly checkout?: { readonly rootKey: string; readonly repository: string };
}

export interface CatalogInput {
	readonly environment: string;
	/** The workspace folders in editor order. */
	readonly folders: readonly FolderFacts[];
	/** What is known of each repository, by repository key. */
	readonly repositories: ReadonlyMap<string, RepositoryFacts>;
	/** The URI of `path`, derived from the URI of the folder it is listed under: never rebuilt as a local file URI (WORKTREES-3.1). */
	readonly uriOf: (folderUri: string, path: string) => string;
}

/** Which entry a physical path listed more than once keeps: an opened folder, then a registered worktree. */
type Tier = 0 | 1;

interface Candidate {
	readonly id: LocationId;
	readonly key: string;
	readonly path: string;
	readonly tier: Tier;
	readonly label: string;
	readonly kind: 'folder' | 'checkout';
	readonly git: GitState;
	readonly isMain: boolean;
	readonly branch?: string;
	readonly detached: boolean;
	/** The opened folder's own URI; the others derive theirs from the folder they are listed under. */
	readonly uri?: string;
}

/**
 * The catalog (WORKTREES-1.2): editor folder order; within a folder, its opened location first, then its main checkout if
 * different, then its repository's other registered worktrees - made by any tool, inside the folder or not - by display name
 * and path. A physical path is listed once, under the folder that opened it or else the first folder it belongs to, and keeps
 * every folder association. Discovery reads each repository's whole registration list, so no cutoff hides a location.
 */
export function buildCatalog(input: CatalogInput): Catalog {
	const groups = input.folders.map(folder => groupOf(folder, input));
	// The entry each key keeps, by tier first: an opened folder is first in its own group whichever group lists it earlier
	const owner = new Map<string, { readonly group: number; readonly candidate: Candidate }>();
	for (const tier of [0, 1] as const) {
		groups.forEach((group, index) => {
			for (const candidate of group) {
				if (candidate.tier === tier && !owner.has(candidate.key)) {
					owner.set(candidate.key, { group: index, candidate });
				}
			}
		});
	}
	const associations = new Map<string, number[]>();
	groups.forEach((group, index) => group.forEach(candidate => {
		const groupsOfKey = associations.get(candidate.key) ?? [];
		if (!groupsOfKey.includes(index)) {
			associations.set(candidate.key, [...groupsOfKey, index]);
		}
	}));
	const locations: Location[] = [];
	groups.forEach((group, index) => {
		for (const candidate of group) {
			if (owner.get(candidate.key)?.candidate !== candidate) {
				continue;
			}
			const folders = [index, ...(associations.get(candidate.key) ?? []).filter(each => each !== index)].map(each => input.folders[each].folder);
			locations.push({
				id: candidate.id,
				path: candidate.path,
				uri: candidate.uri ?? input.uriOf(input.folders[index].folder.uri, candidate.path),
				environment: input.environment,
				label: candidate.label,
				folders,
				kind: candidate.kind,
				...(candidate.kind === 'checkout' ? { isMain: candidate.isMain, detached: candidate.detached } : {}),
				...(candidate.branch !== undefined ? { branch: candidate.branch } : {}),
				opened: candidate.tier === 0,
				git: candidate.git
			});
		}
	});
	return {
		locations,
		folders: input.folders.map(each => each.folder),
		pending: input.folders.some(each => each.git === 'pending') || locations.some(each => each.git === 'pending')
	};
}

/** One folder's part of the catalog, before deduplication. */
function groupOf(folder: FolderFacts, input: CatalogInput): Candidate[] {
	const repository = folder.checkout ? input.repositories.get(folder.checkout.repository) : undefined;
	const own = folder.checkout && repository?.worktrees.find(each => each.key === folder.checkout?.rootKey);
	const opened = candidateOf(input, {
		key: folder.key,
		path: folder.folder.path,
		tier: 0,
		name: folder.folder.name,
		uri: folder.folder.uri,
		...(folder.checkout ? {
			kind: 'checkout' as const,
			git: own?.stale ? 'stale' : combined(folder.git, repository?.git ?? 'pending'),
			// An opened subfolder is a location of its own, named by its folder rather than by the branch of the checkout around it
			root: folder.key === folder.checkout.rootKey,
			isMain: !!own?.main && own.key === folder.key,
			...(own?.branch !== undefined ? { branch: own.branch } : {}),
			detached: own?.detached ?? false
		} : { kind: 'folder' as const, git: folder.git, root: false, isMain: false, detached: false })
	});
	const checkouts = [opened];
	if (repository) {
		const main = repository.worktrees.find(each => each.main);
		if (main && main.key !== folder.key) {
			checkouts.push(worktreeCandidate(input, main, repository));
		}
		checkouts.push(...repository.worktrees.filter(each => each !== main && each.key !== folder.key).map(each => worktreeCandidate(input, each, repository)).sort(byLabel));
	}
	return checkouts;
}

function worktreeCandidate(input: CatalogInput, worktree: WorktreeFacts, repository: RepositoryFacts): Candidate {
	return candidateOf(input, {
		key: worktree.key,
		path: worktree.path,
		tier: 1,
		name: path.basename(worktree.path),
		root: true,
		kind: 'checkout',
		git: worktree.stale ? 'stale' : repository.git,
		isMain: worktree.main,
		...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
		detached: worktree.detached
	});
}

/** A candidate with its identity and label: the branch for a checkout's root, else the folder name (WORKTREES-1.2). */
function candidateOf(input: CatalogInput, facts: Omit<Candidate, 'id' | 'label'> & { readonly name: string; readonly root: boolean }): Candidate {
	const id = locationIdOf(input.environment, facts.key);
	const { name, root, ...candidate } = facts;
	return { ...candidate, id, label: (root ? facts.branch : undefined) ?? name };
}

/** The opened location's state: the folder's own read, then what is known of its repository's worktrees. */
function combined(folder: GitState, repository: GitState): GitState {
	return folder === 'ok' ? repository : folder;
}

function byLabel(a: Candidate, b: Candidate): number {
	return a.label.localeCompare(b.label) || a.path.localeCompare(b.path);
}

/**
 * Whether `location` is a worktree the person may delete (WORKTREES-3.2, D73): a linked one - not the main checkout, not a plain
 * folder - that no workspace folder opened or is in, compared by canonical key. The picker offers it and deletion refuses it by
 * this one rule; deletion also asks Git again.
 */
export function isDeletableWorktree(location: Location, folders: readonly WorkspaceFolderInfo[], keyOf: (path: string) => string): boolean {
	if (location.kind !== 'checkout' || location.isMain || location.opened) {
		return false;
	}
	const key = keyOf(location.path);
	return !folders.some(each => isWithin(keyOf(each.path), key));
}

/**
 * The runs launched in the worktree at `root` (WORKTREES-3.2, 3.3): their launch location is the worktree or a location inside it - a
 * subdirectory where a conversation was resumed - as `locations` lists it, or, for one the catalog does not list yet, the run's own
 * launch directory, whose identity its location is. Never a process's current directory. A deletion counts them, closes them first
 * and waits for their processes.
 */
export function runsLaunchedIn<T extends Pick<RunFacts, 'location' | 'cwd' | 'environment'>>(runs: readonly T[], root: string, locations: readonly Location[], keyOf: (path: string) => string): T[] {
	const paths = new Map(locations.map(each => [each.id, each.path]));
	const rootKey = keyOf(root);
	return runs.filter(run => {
		const launched = paths.get(run.location) ?? (locationIdOf(run.environment, keyOf(run.cwd)) === run.location ? run.cwd : undefined);
		return launched !== undefined && isWithin(keyOf(launched), rootKey);
	});
}

/** Whether the key `inner` is `outer` or below it. */
export function isWithin(inner: string, outer: string): boolean {
	const relative = path.relative(outer, inner);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
