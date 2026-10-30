/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable, WorkspaceFolderInfo } from '../../core/ports';
import { editorUriOf } from './workspaceFolders';

/**
 * Watches a repository's shared Git directory for what changes its part of the catalog (WORKTREES-1.3): a worktree's
 * registration coming or going (`worktrees/<name>`) or moving (its `gitdir`), and a HEAD - the main checkout's or a
 * worktree's - naming another branch. Index, log and object writes are no such change. Events only; nothing polls.
 */
export function watchGitDirectory(commonDir: string, folder: WorkspaceFolderInfo, onEvent: () => void): Disposable {
	const base = vscode.Uri.parse(editorUriOf(folder.uri, commonDir));
	// Compared as the platform compares paths, so a differently cased event path is still recognized
	const folded = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
	const [head, worktrees, gitdir] = ['HEAD', 'worktrees', 'gitdir'].map(folded);
	const relevant = (uri: vscode.Uri) => {
		const parts = path.posix.relative(folded(base.path), folded(uri.path)).split('/');
		return (parts.length === 1 && parts[0] === head) || (parts[0] === worktrees && (parts.length === 2 || (parts.length === 3 && (parts[2] === head || parts[2] === gitdir))));
	};
	const watchers = [
		vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, 'HEAD')),
		vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, 'worktrees/**'))
	];
	const changed = (uri: vscode.Uri) => {
		if (relevant(uri)) {
			onEvent();
		}
	};
	const subscriptions = watchers.flatMap(watcher => [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)]);
	return { dispose: () => [...subscriptions, ...watchers].forEach(each => each.dispose()) };
}
