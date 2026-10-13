/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { canonicalFolder, isInsideFolder } from '../base/files';
import { Git, ListedWorktree, MadeWorktreeFolder, OwnedFile, Repository, SetupOutcome, SetupProgress, WorktreeChanges, WorktreeDeletion } from '../core/ports';
import { changedFilesIn, excludeIn, fileAtIn, hasBranchIn, leftoverWorkIn, repositoryIn, submodulesIn, trackedIn, untrackedIn, whyNotBranchNameIn, worktreeRootIn, worktreesIn } from './gitCli';

/** The options the window's `_facade.worktree.delete` and `_facade.worktree.removalLoss` take: its `IRemoveWorktreeOptions`. */
interface WindowDeletion {
	readonly discardChanges: boolean;
	readonly ownFiles: readonly OwnedFile[];
	readonly main: vscode.Uri;
	readonly runs: readonly { readonly workspace: string; readonly id: number }[];
	readonly leftover?: true;
}

/**
 * The core's Git port: git's own records, read with the git the git extension uses - the one the
 * person set, or the one on PATH - and worktrees made through the window's New Worktree, without its
 * dialog.
 */
export class HostGit implements Git {

	/** `workspace` is the id of the record the agents are in: their runs are known by it. */
	constructor(private readonly workspace: string) { }

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		return repositoryAt(folder);
	}

	async worktreeRootOf(folder: string): Promise<string | undefined> {
		return worktreeRootIn(await gitPath(), folder);
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

	plannedWorktreeFolder(main: string, branch: string): string {
		return path.join(os.homedir(), '.facade', 'worktrees', path.basename(main), worktreeFolderName(branch));
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<MadeWorktreeFolder> {
		const made = await vscode.commands.executeCommand<{ readonly worktree: vscode.Uri; readonly copyFailures: readonly string[]; readonly hookFailure?: string }>('_facade.worktree.create', vscode.Uri.file(main), branch, startPoint, false);
		return { folder: made.worktree.fsPath, copyFailures: made.copyFailures, ...(made.hookFailure ? { hookFailure: made.hookFailure } : {}) };
	}

	async setupOutcome(folder: string): Promise<SetupOutcome> {
		return await vscode.commands.executeCommand<SetupOutcome>('_facade.worktree.setupOutcome', vscode.Uri.file(folder)) ?? { kind: 'none' };
	}

	async setupState(folder: string): Promise<SetupProgress | undefined> {
		return await vscode.commands.executeCommand<SetupProgress | undefined>('_facade.worktree.setupState', vscode.Uri.file(folder)) ?? undefined;
	}

	stopSetup(folder: string): void {
		void vscode.commands.executeCommand('_facade.worktree.stopSetup', vscode.Uri.file(folder)).then(undefined, () => undefined);
	}

	async changesIn(folder: string): Promise<WorktreeChanges> {
		const git = await gitPath();
		const [files, submodules] = await Promise.all([changedFilesIn(git, folder), submodulesIn(git, folder)]);
		// Editors and notebooks alike, by either spelling of the folder - as it was given, and its real path - and
		// of each file: one opened through a link to the folder is in it by its real path alone (X-71; SP-25)
		const real = canonicalFolder(folder);
		const unsaved = [...vscode.workspace.textDocuments, ...vscode.workspace.notebookDocuments]
			.filter(document => document.isDirty && document.uri.scheme === 'file')
			.map(document => document.uri.fsPath)
			.flatMap(file => [file, canonicalFolder(file)].flatMap(each => [folder, real].filter(at => isInsideFolder(each, at)).map(at => path.relative(at, each).split(path.sep).join('/'))).slice(0, 1));
		return { files, unsaved, submodules };
	}

	async deleteWorktree(folder: string, options: WorktreeDeletion): Promise<void> {
		await vscode.commands.executeCommand('_facade.worktree.delete', vscode.Uri.file(folder), this.deletionOf(options));
	}

	async deletionLoss(folder: string, options: WorktreeDeletion): Promise<readonly string[]> {
		// The same deletion's shared preflight alone: nothing stopped, closed or removed (O5 step 2)
		return await vscode.commands.executeCommand<readonly string[] | undefined>('_facade.worktree.removalLoss', vscode.Uri.file(folder), this.deletionOf(options)) ?? [];
	}

	/** The options `_facade.worktree.delete` and `_facade.worktree.removalLoss` take for a deletion `options` describe. */
	private deletionOf(options: WorktreeDeletion): WindowDeletion {
		return {
			discardChanges: options.discardChanges,
			ownFiles: options.ownFiles,
			main: vscode.Uri.file(options.main),
			runs: options.agents.map(id => ({ workspace: this.workspace, id })),
			...(options.leftover ? { leftover: true } : {})
		};
	}

	async excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
		return excludeIn(await gitPath(), folder);
	}

	async tracks(folder: string, files: readonly string[], commit?: string): Promise<ReadonlySet<string>> {
		return trackedIn(await gitPath(), folder, files, commit);
	}

	async leftoverWorkIn(main: string, branch: string, folder: string): Promise<readonly string[]> {
		return leftoverWorkIn(await gitPath(), main, branch, folder);
	}

	async fileAt(main: string, commit: string, file: string): Promise<string | undefined> {
		return fileAtIn(await gitPath(), main, commit, file);
	}

	async untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		return untrackedIn(await gitPath(), folder, files);
	}
}


/** The repository `folder` is in, by the git the git extension uses; undefined for a folder in none. */
export async function repositoryAt(folder: string): Promise<Repository | undefined> {
	return repositoryIn(await gitPath(), folder);
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

/**
 * The name of a worktree's folder for `branch`: `/` and every character Windows forbids in a file name
 * replaced by `-`, on every OS (WORKTREE.md, WT-2.2), as the window names it.
 */
function worktreeFolderName(branch: string): string {
	return branch.trim().replace(/[\\/<>:"|?*]/g, '-');
}
