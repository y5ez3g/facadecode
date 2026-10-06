/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Git, ListedWorktree, Repository } from '../core/ports';
import { excludeIn, repositoryIn, trackedIn, untrackedIn, worktreesIn } from './gitCli';

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

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<string> {
		const worktree = await vscode.commands.executeCommand<vscode.Uri>('_facade.worktree.create', vscode.Uri.file(main), branch, startPoint, false);
		return worktree.fsPath;
	}

	async excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
		return excludeIn(await gitPath(), folder);
	}

	async tracks(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		return trackedIn(await gitPath(), folder, files);
	}

	async untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		return untrackedIn(await gitPath(), folder, files);
	}
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
