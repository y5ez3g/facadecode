/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { isEqualPath } from '../base/files';
import { Git, ListedWorktree, Repository, WorktreeChanges } from '../core/ports';
import { changedFilesIn, excludeIn, hasBranchIn, repositoryIn, trackedIn, untrackedIn, whyNotBranchNameIn, worktreesIn } from './gitCli';

/**
 * The core's Git port: git's own records, read with the git the git extension uses - the one the
 * person set, or the one on PATH - and worktrees made through the window's New Worktree, without its
 * dialog.
 */
export class HostGit implements Git {

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		return repositoryIn(await gitPath(), folder);
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		return worktreesIn(await gitPath(), main);
	}

	async hasBranch(main: string, branch: string): Promise<boolean> {
		return hasBranchIn(await gitPath(), main, branch);
	}

	async whyNotBranchName(main: string, branch: string): Promise<string | undefined> {
		return whyNotBranchNameIn(await gitPath(), main, branch);
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<string> {
		const worktree = await vscode.commands.executeCommand<vscode.Uri>('_facade.worktree.create', vscode.Uri.file(main), branch, startPoint, false);
		return worktree.fsPath;
	}

	async changesIn(folder: string): Promise<WorktreeChanges> {
		const files = await changedFilesIn(await gitPath(), folder);
		const unsaved = vscode.workspace.textDocuments
			.filter(document => document.isDirty && document.uri.scheme === 'file' && isInside(document.uri.fsPath, folder))
			.map(document => path.relative(folder, document.uri.fsPath).split(path.sep).join('/'));
		return { files, unsaved };
	}

	async deleteWorktree(folder: string): Promise<void> {
		await vscode.commands.executeCommand('_facade.worktree.delete', vscode.Uri.file(folder));
	}

	async excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
		return excludeIn(await gitPath(), folder);
	}

	async tracks(folder: string, files: readonly string[], commit?: string): Promise<ReadonlySet<string>> {
		return trackedIn(await gitPath(), folder, files, commit);
	}

	async untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		return untrackedIn(await gitPath(), folder, files);
	}
}

/** Whether `file` is inside `folder`. */
function isInside(file: string, folder: string): boolean {
	const relative = path.relative(folder, file);
	return !isEqualPath(file, folder) && !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The git the git extension uses: the one the person set, or the one on PATH. */
async function gitPath(): Promise<string> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
	try {
		const api = (extension?.isActive ? extension.exports : await extension?.activate())?.getAPI(1);
		return api?.git.path ?? 'git';
	} catch {
		return 'git';
	}
}
