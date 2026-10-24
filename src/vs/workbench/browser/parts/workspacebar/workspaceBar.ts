/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { env } from '../../../../base/common/process.js';
import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

/**
 * Whether two paths name one folder. ⚠️ Not `uri.toString()`: a file system that ignores case gives
 * every directory a family of spellings. `canonicalUri` handles symlinks, this the rest.
 */
export type FolderKey = (uri: URI) => string;

export function folderKey(uriIdentityService: IUriIdentityService, uri: URI): string {
	return uriIdentityService.extUri.getComparisonKey(uri);
}

/**
 * Fires with a scheme as its file system registers, leaves or changes: the rule `folderKey` keys its folders by can
 * change then. ⚠️ A remote window's workbench is up before the remote's file system registers (REMOTE.md R7): until
 * then a key keeps the case of the path, which a Windows or macOS remote's ignores once it is there. What was keyed
 * before is keyed again then (`rekeyFolders`), or it is never found again.
 */
export function onDidChangeFolderKeys(fileService: IFileService): Event<string> {
	return Event.any(
		Event.map(fileService.onDidChangeFileSystemProviderRegistrations, e => e.scheme),
		Event.map(fileService.onDidChangeFileSystemProviderCapabilities, e => e.scheme)
	);
}

/**
 * `key` as `folderKey` makes it now, for one it made before `scheme`'s file system changed (`onDidChangeFolderKeys`):
 * a key is the folder's URI, its path lowercased where case is ignored, so it is read back as one. Any other as it is -
 * another scheme's, or one that is no folder's.
 */
export function rekeyFolder(key: string, scheme: string, folderKey: FolderKey): string {
	return key.startsWith(`${scheme}:`) ? folderKey(URI.parse(key)) : key;
}

/**
 * Keys `map` again in place (`rekeyFolder`), and says whether a key changed. Two that become one keep what `merge`
 * makes of them: by default the value of the one keyed before, which was set since the other was loaded.
 */
export function rekeyFolders<T>(map: Map<string, T>, scheme: string, folderKey: FolderKey, merge: (kept: T, rekeyed: T) => T = (_kept, rekeyed) => rekeyed): boolean {
	let changed = false;
	for (const [key, value] of [...map]) {
		const now = rekeyFolder(key, scheme, folderKey);
		if (now === key) {
			continue;
		}

		map.delete(key);
		const kept = map.get(now);
		map.set(now, kept === undefined ? value : merge(kept, value));
		changed = true;
	}
	return changed;
}

/** Where the product makes worktrees: `<home>/.facade/worktrees/<repository>/<name>` - or under `FACADE_HOME`, for an isolated test window (WORKTREE.md WT-2.1). */
export const WORKTREES_FOLDER: readonly string[] = ['.facade', 'worktrees'];

/**
 * `FACADE_HOME`, when the window runs with it: the Facade home of an isolated test window, in place of
 * `<home>/.facade` - its worktrees here, and, for the agents' extension, its records, counters and window key
 * (AGENT-ORCHESTRATION.md O8). Undefined for an ordinary window. Read from the window process's environment,
 * which the sandbox preload applies to the renderer's own.
 */
export function facadeHomeOverride(): URI | undefined {
	// An absolute path alone, as the agents' extension takes it: a window and its extension agree on one home
	const value = env.FACADE_HOME;
	return value && isAbsolute(value) ? URI.file(value) : undefined;
}

/**
 * `WORKTREES_FOLDER` under the Facade home on the target machine. A remote server reports its own `FACADE_HOME`;
 * the renderer's environment belongs to the client and cannot select a remote path. Links are not followed.
 */
export async function worktreesRootOf(pathService: IPathService, remoteAgentService: IRemoteAgentService): Promise<URI> {
	const home = await pathService.userHome();
	let override: URI | undefined;
	if (home.scheme === Schemas.file) {
		override = facadeHomeOverride();
	} else if (home.scheme === Schemas.vscodeRemote) {
		const remoteHome = (await remoteAgentService.getEnvironment())?.facadeHome;
		if (remoteHome?.scheme === home.scheme && remoteHome.authority === home.authority) {
			override = remoteHome;
		}
	}
	return override ? joinPath(override, 'worktrees') : joinPath(home, ...WORKTREES_FOLDER);
}

/**
 * A repository's worktrees in the order the bar draws them (WORKTREE.md WT-1.7): the ones somebody has
 * placed, in their order, then the rest in the order given - oldest first, as git's files
 * are read. So a worktree made after the last move comes after the ones that were moved.
 *
 * Shared by the rows and by Move Worktree Up and Down, so "one up" is worked out on the order on screen.
 */
export function orderWorktrees<T>(items: readonly T[], placed: readonly URI[] | undefined, uriOf: (item: T) => URI, key: FolderKey): T[] {
	if (!placed || placed.length === 0) {
		return [...items];
	}

	const rank = new Map(placed.map((uri, index) => [key(uri), index]));
	const at = (item: T) => rank.get(key(uriOf(item)));

	return [
		...items.filter(item => at(item) !== undefined).sort((a, b) => (at(a) ?? 0) - (at(b) ?? 0)),
		...items.filter(item => at(item) === undefined)
	];
}

/** A row of the bar, and the folders of `folders[]` it stands for, in their order there. */
interface IRowOfFolders {
	readonly uri: URI;
	readonly folders: readonly URI[];
}

/**
 * The bar's rows over `folders`, in their order: a folder of a repository (`repositoryOf` answers its
 * main checkout) is on that repository's row, which sits where its first folder is (WT-1.6); any
 * other folder is a row of its own.
 */
export function rowsOfFolders(folders: readonly URI[], repositoryOf: (folder: URI) => URI | undefined, key: FolderKey): IRowOfFolders[] {
	const rows = new Map<string, { readonly uri: URI; readonly folders: URI[] }>();
	for (const folder of folders) {
		const uri = repositoryOf(folder) ?? folder;
		const row = rows.get(key(uri)) ?? { uri, folders: [] };
		rows.set(key(uri), row);
		row.folders.push(folder);
	}

	return [...rows.values()];
}

/**
 * `folders[]` with the row `uri` is - named by its own folder or any it stands for - moved `offset`
 * rows along, taking all its folders with it: a repository's row is where its first folder is (WT-1.6),
 * so moving that one folder alone could leave the row where it was. Undefined when nothing moves.
 */
export function moveRow(rows: readonly IRowOfFolders[], uri: URI, offset: number, key: FolderKey): URI[] | undefined {
	const wanted = key(uri);
	const from = rows.findIndex(row => key(row.uri) === wanted || row.folders.some(folder => key(folder) === wanted));
	const to = from + offset;
	if (from === -1 || offset === 0 || to < 0 || to >= rows.length) {
		return undefined;
	}

	const moved = [...rows];
	const [row] = moved.splice(from, 1);
	moved.splice(to, 0, row);
	return moved.flatMap(candidate => candidate.folders);
}

/** Deep enough for any path, and a stop if a file system answers a parent with itself. */
const MAX_CANONICAL_DEPTH = 32;

/** Why a folder cannot be reached: nothing is there, or the read itself failed. */
export type Unreachable =
	| { readonly kind: 'missing' }
	| { readonly kind: 'unreadable'; readonly reason: string };

/** Why `uri` cannot be reached, telling a missing folder from one that cannot be read (WORKSPACE.md WS-63). */
export async function unreachable(fileService: IFileService, uri: URI): Promise<Unreachable | undefined> {
	try {
		await fileService.stat(uri);
		return undefined;
	} catch (error) {
		return toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND
			? { kind: 'missing' }
			: { kind: 'unreadable', reason: toErrorMessage(error) };
	}
}

/** `uri` as a person reads it in a message: a path on this machine, the whole URI anywhere else. */
export function pathOf(uri: URI): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

/**
 * One spelling per directory, resolved once when a folder enters the workspace.
 *
 * ⚠️ On macOS `/tmp` is a symlink to `/private/tmp`, so the folder the window was opened with and
 * the same folder picked from a dialog arrive under different names.
 *
 * ⚠️ Resolved from the nearest ancestor that does exist, not abandoned when the folder itself does
 * not. A `.code-workspace` can list folders nobody has cloned yet; taking the spelling those arrived
 * with leaves a row that stops matching the moment the folder appears, and adding it again makes a
 * second row for one directory.
 */
export async function canonicalUri(fileService: IFileService, uri: URI): Promise<URI> {
	const missing: string[] = [];
	let candidate = uri;

	for (let depth = 0; depth < MAX_CANONICAL_DEPTH; depth++) {
		try {
			const real = await fileService.realpath(candidate);
			if (real) {
				return missing.length ? joinPath(real, ...missing.reverse()) : real;
			}
		} catch {
			// Not there, or a file system that cannot answer. Either way, try its parent.
		}

		const parent = dirname(candidate);
		if (isEqual(parent, candidate)) {
			break;	// the root, and it did not answer either
		}

		missing.push(basename(candidate));
		candidate = parent;
	}

	// Nothing on the way up could be resolved. The uri as given still makes a row, and a folder that
	// is gone shows as one that is gone.
	return uri;
}

/**
 * `WORKTREES_FOLDER` under the Facade home, canonical - `FACADE_HOME` for an isolated test window, `<home>/.facade`
 * otherwise (`worktreesRootOf`). A worktree inside it is one Facade made; any other is another
 * tool's, which Facade takes for a folder and never acts on as a worktree (WORKTREE.md WT-1.3).
 */
export async function worktreesFolderOf(fileService: IFileService, pathService: IPathService, remoteAgentService: IRemoteAgentService): Promise<URI> {
	return canonicalUri(fileService, await worktreesRootOf(pathService, remoteAgentService));
}

