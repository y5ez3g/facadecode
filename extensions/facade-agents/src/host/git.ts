/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Git, ListedWorktree, Repository } from '../core/ports';

/**
 * The core's Git port: git's own records, read with the git the git extension uses - the one the
 * person set, or the one on PATH - and worktrees made and deleted through the window's New Worktree
 * and Delete Worktree, without their dialogs (WORKTREE.md sections 7 and 10).
 */
export class HostGit implements Git {

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		const git = await gitPath();
		try {
			const [gitDir, commonDir, head] = (await run(git, ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', 'HEAD'])).split(/\r?\n/);
			const main = path.dirname(path.normalize(commonDir));
			if (comparable(gitDir) === comparable(commonDir)) {
				return { main, worktree: 'main', head };
			}
			const branch = (await run(git, ['-C', folder, 'branch', '--show-current'])).trim();
			return { main, worktree: branch || path.basename(folder), head };
		} catch {
			return undefined;
		}
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		const listed = await run(await gitPath(), ['-C', main, 'worktree', 'list', '--porcelain']);
		const worktrees: ListedWorktree[] = [];
		for (const record of listed.split(/\r?\n\r?\n/)) {
			const lines = record.split(/\r?\n/);
			const folder = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
			if (!folder) {
				continue;
			}
			const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '');
			// git lists the main worktree first.
			worktrees.push({ name: worktrees.length ? branch ?? path.basename(folder) : 'main', folder: path.normalize(folder) });
		}
		return worktrees;
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<string> {
		const made = await vscode.commands.executeCommand<{ readonly path: string }>('_facade.worktree.create', vscode.Uri.file(main), branch, startPoint, false);
		return made.path;
	}

	async deleteWorktree(folder: string, force: boolean): Promise<void> {
		await vscode.commands.executeCommand('_facade.worktree.delete', vscode.Uri.file(folder), force);
	}
}

function comparable(file: string | undefined): string {
	const resolved = path.resolve(file ?? '');
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function run(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile(command, [...args], { windowsHide: true, timeout: 10_000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())));
}

async function gitPath(): Promise<string> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
	try {
		const api = (extension?.isActive ? extension.exports : await extension?.activate())?.getAPI(1);
		return api?.git.path ?? 'git';
	} catch {
		return 'git';
	}
}
