/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/*
 * Facade Code: git's own files, read as git writes them, for the workspace bar's rows (WORKTREE.md WT-3). The renderer
 * cannot run git.
 *
 * <folder>/.git                       a directory: a main checkout. A file "gitdir: X": see X
 * <git dir>/commondir                 in a linked worktree's git dir: the shared git directory
 * <common>/worktrees/<name>/gitdir    each linked worktree's folder, with /.git at the end
 */

/** Where a folder's git directories are. */
export interface IGitLocation {
	/** The shared git directory. */
	readonly commonDir: URI;
	/** This folder's own git directory: the common one for a main checkout. */
	readonly gitDir: URI;
	/** A main checkout, rather than a linked worktree. */
	readonly isMain: boolean;
}

/** One of git's files, trimmed; undefined when it cannot be read. */
export async function readGitFile(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		return (await fileService.readFile(uri)).value.toString().trim();
	} catch {
		return undefined;
	}
}

/**
 * A path git wrote into one of its files, as a URI next to `base`.
 *
 * Absolute, or with `worktree.useRelativePaths` relative to the file's directory. Absolute is judged
 * by the path's shape, not this machine's `path` module: a remote may run another OS. `joinPath`, not
 * `resolvePath`, which would give a `file:` path a drive letter on Windows.
 */
export function gitPathToUri(base: URI, path: string): URI {
	if (!/^(?:[a-zA-Z]:)?[\\/]/.test(path)) {
		return joinPath(base, path.replace(/\\/g, '/'));
	}

	const file = URI.file(path);
	return base.scheme === Schemas.file ? file : base.with({ path: file.path });
}

/** The git directories `folder`'s `.git` leads to; undefined for a folder in no repository git could open there. */
export async function locateGitDirectories(fileService: IFileService, folder: URI): Promise<IGitLocation | undefined> {
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

	const content = await readGitFile(fileService, dotGit);
	const target = content && /^gitdir:\s*(?<path>.+)$/m.exec(content)?.groups?.path;
	if (!target) {
		return undefined;
	}

	const gitDir = gitPathToUri(folder, target.trim());
	const common = await readGitFile(fileService, joinPath(gitDir, 'commondir'));
	if (common) {
		return { commonDir: gitPathToUri(gitDir, common), gitDir, isMain: false };
	}

	// No `commondir`: a main checkout whose git directory lives elsewhere (`--separate-git-dir`) - or a
	// git directory that is gone, the repository moved or the worktree's record pruned, and then no
	// repository at all.
	return await fileService.exists(joinPath(gitDir, 'HEAD')) ? { commonDir: gitDir, gitDir, isMain: true } : undefined;
}
