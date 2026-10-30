/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { WorktreeProblem } from '../../core/locations/problems';
import { NativeCreator, NativeGit } from './worktrees';

/** As much of the VS Code Git extension's API (version 1) as worktree creation uses. */
interface GitApi {
	readonly repositories: readonly ApiRepository[];
	getRepository(uri: vscode.Uri): ApiRepository | null;
	openRepository?(uri: vscode.Uri): Promise<ApiRepository | null>;
}

interface ApiRepository {
	readonly rootUri: vscode.Uri;
	/** Present only where the editor's Git extension supplies native worktree creation. */
	readonly createWorktree?: (options: { path?: string; commitish?: string; branch?: string }) => Promise<string>;
}

const NO_NATIVE_CREATION: WorktreeProblem = { kind: 'no_native_creation' };

/** The Git extension's API, or why there is none (WORKTREES-4.1: feature-detected in each editor). */
async function gitApi(): Promise<GitApi | WorktreeProblem> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!extension) {
		return { kind: 'git_extension_missing' };
	}
	try {
		return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	} catch (err) {
		return { kind: 'git_extension_failed', detail: messageOf(err) };
	}
}

/**
 * Worktree creation by the editor's own Git extension (WORKTREES-4.1): `Repository.createWorktree` with an explicit path, branch
 * and commit. Any repository object of the same repository can make it; the source's own is asked first, and a repository the
 * extension has not opened is opened natively.
 */
export function editorNativeGit(): NativeGit {
	return {
		unsupported: async () => {
			const api = await gitApi();
			if ('kind' in api) {
				return api;
			}
			// Feature detection needs an instance: with none opened yet, creation finds out once it opens the source's
			const any = api.repositories[0];
			return any && typeof any.createWorktree !== 'function' ? NO_NATIVE_CREATION : undefined;
		},
		repository: async uris => {
			const api = await gitApi();
			if ('kind' in api) {
				return api;
			}
			let found = uris.map(uri => api.getRepository(vscode.Uri.parse(uri))).find(each => !!each) ?? undefined;
			if (!found && uris.length && api.openRepository) {
				found = await api.openRepository(vscode.Uri.parse(uris[0])) ?? undefined;
			}
			if (!found) {
				return { kind: 'repository_not_open' };
			}
			const repository = found;
			if (typeof repository.createWorktree !== 'function') {
				return NO_NATIVE_CREATION;
			}
			const creator: NativeCreator = { createWorktree: options => repository.createWorktree!.call(repository, options) };
			return creator;
		}
	};
}
