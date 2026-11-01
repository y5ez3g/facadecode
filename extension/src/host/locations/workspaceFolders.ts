/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { checkoutOf, folderLinkIn, gitExecutableOf, gitVersionOf, hasChanges, removeWorktree, worktreesOf } from './gitRead';
import { FolderSource } from './service';
import { GitCreationSettings, WorktreeGit } from './worktrees';

export { editorEnvironment } from '../editorEnvironment';

/** The window's workspace folders, in editor order, each with its original URI and its path in its environment. */
export function editorFolders(): FolderSource {
	return {
		folders: () => (vscode.workspace.workspaceFolders ?? []).map(folder => ({ index: folder.index, name: folder.name, uri: folder.uri.toString(), path: folder.uri.fsPath })),
		onDidChange: listener => vscode.workspace.onDidChangeWorkspaceFolders(() => listener())
	};
}

/**
 * Git for discovery and worktree deletion: `git.path` read on use in the folder's scope, as the editor's Git integration reads it, run
 * where this extension runs - the workspace's own environment, a remote host's too (UX-4.2, WORKTREES-4.1).
 */
export function editorGit(): WorktreeGit {
	return {
		executable: folder => gitExecutableOf(vscode.workspace.getConfiguration('git', vscode.Uri.parse(folder.uri)).get<unknown>('path')),
		checkoutOf,
		worktreesOf,
		hasChanges,
		removeWorktree,
		versionOf: gitVersionOf,
		folderLinkIn
	};
}

/**
 * The URI of `path` in the window's environment, derived from a folder's original URI: its scheme and remote authority
 * kept, never rebuilt as a local file URI (WORKTREES-3.1).
 */
export function editorUriOf(folderUri: string, path: string): string {
	return vscode.Uri.parse(folderUri).with({ path: vscode.Uri.file(path).path }).toString();
}

/** `git.branchPrefix` and `git.branchValidationRegex`, read on use in the folder's scope: the native flow's own rules (WORKTREES-2.1). */
export function editorGitCreationSettings(): GitCreationSettings {
	const text = (key: string, uri: string) => {
		const value = vscode.workspace.getConfiguration('git', vscode.Uri.parse(uri)).get<unknown>(key);
		return typeof value === 'string' ? value : '';
	};
	return {
		branchPrefix: folder => text('branchPrefix', folder.uri),
		branchValidationRegex: folder => text('branchValidationRegex', folder.uri)
	};
}
