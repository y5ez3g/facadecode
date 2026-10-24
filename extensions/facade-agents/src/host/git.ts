/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { canonicalFolder, isInsideFolder } from '../base/files';
import { Git, ListedWorktree, MadeWorktreeFolder, OwnedFile, Repository, SetupOutcome, SetupProgress, WorktreeChanges, WorktreeDeleted, WorktreeDeletion } from '../core/ports';
import { TicketRegistry } from '../core/tickets';
import { worktreesRoot } from '../record/paths';
import { changedFilesIn, excludeIn, fileAtIn, hasBranchIn, leftoverWorkIn, repositoryIn, submodulesIn, trackedIn, untrackedIn, whyNotBranchNameIn, worktreeRootIn, worktreesIn } from './gitCli';

/** The options the window's `_facade.worktree.delete` and `_facade.worktree.removalLoss` take: its `IRemoveWorktreeOptions`. */
interface WindowDeletion {
	readonly discardChanges: boolean;
	readonly ownFiles: readonly OwnedFile[];
	readonly main: vscode.Uri;
	readonly runs: readonly { readonly workspace: string; readonly id: number }[];
	readonly leftover?: true;
	readonly by?: object;
}

/**
 * The core's Git port: git's own records, read with the git the git extension uses - the one the
 * person set, or the one on PATH - and worktrees made through the window's New Worktree, without its
 * dialog.
 */
export class HostGit implements Git {

	/** Where the window makes every worktree Facade makes: `~/.facade/worktrees`, or under `FACADE_HOME` (WORKTREE.md WT-2.1). */
	private readonly worktreesFolder = worktreesRoot();
	/** Its real path, worked out once it is there: it is under this machine's home, which does not change. */
	private realWorktreesFolder: string | undefined;

	/**
	 * `workspace` is the id of the record the agents are in: their runs are known by it; `tickets`,
	 * the tickets of the operations asked of the window.
	 */
	constructor(private readonly workspace: string, private readonly tickets: TicketRegistry) { }

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		return repositoryAt(folder);
	}

	async worktreeRootOf(folder: string): Promise<string | undefined> {
		return worktreeRootIn(await gitPath(), folder);
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		return worktreesIn(await gitPath(), main);
	}

	isFacadeWorktree(folder: string): boolean {
		// Their real paths, as the window compares them: a link to the folder is the folder. Until the worktrees folder is
		// there, nothing is in it, and its path as given serves as well as its real one
		if (this.realWorktreesFolder === undefined && fs.existsSync(this.worktreesFolder)) {
			this.realWorktreesFolder = canonicalFolder(this.worktreesFolder);
		}
		return isInsideFolder(canonicalFolder(folder), this.realWorktreesFolder ?? this.worktreesFolder);
	}

	async hasBranch(main: string, branch: string): Promise<boolean> {
		return hasBranchIn(await gitPath(), main, branch);
	}

	async whyNotBranchName(main: string, branch: string): Promise<string | undefined> {
		return whyNotBranchNameIn(await gitPath(), main, branch);
	}

	plannedWorktreeFolder(main: string, branch: string): string {
		return path.join(this.worktreesFolder, path.basename(main), worktreeFolderName(branch));
	}

	async makeWorktree(main: string, branch: string, startPoint: string, run: number): Promise<MadeWorktreeFolder | undefined> {
		const made = await this.tickets.runUnclaimedCreate(run, async ticket =>
			await vscode.commands.executeCommand<{ readonly worktree: vscode.Uri; readonly copyFailures: readonly string[]; readonly hookFailure?: string; readonly refused?: true }>('_facade.worktree.create', vscode.Uri.file(main), branch, startPoint, false, ticket));
		// Refused: the run was stopped while its worktree waited for the window - nothing was made (REMOTE.md R7)
		if (!made || made.refused) {
			return undefined;
		}
		return { folder: made.worktree.fsPath, copyFailures: made.copyFailures, ...(made.hookFailure ? { hookFailure: made.hookFailure } : {}) };
	}

	cancelPendingWorktreeCreate(run: number): void {
		this.tickets.cancelUnclaimedCreate(run);
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

	async deleteWorktree(folder: string, options: WorktreeDeletion, waitMs: number): Promise<WorktreeDeleted> {
		// Its ticket, for no run: the window claims it before it stops or deletes anything, granted while the caller waits
		const ticket = this.tickets.issue('delete', 0);
		const answer = Promise.resolve(vscode.commands.executeCommand<{ readonly refused?: true } | undefined>('_facade.worktree.delete', vscode.Uri.file(folder), this.deletionOf(options), ticket)).then(answered => {
			if (answered?.refused) {
				throw new Error(`${folder} was not deleted: the window took up the deletion only after its caller stopped waiting.`);
			}
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const over = await Promise.race([answer.then(() => false), new Promise<true>(resolve => timer = setTimeout(() => resolve(true), waitMs))]);
			if (!over) {
				this.tickets.answered(ticket);
				return { outcome: 'done' };
			}
		} catch (err) {
			this.tickets.answered(ticket);
			throw err;
		} finally {
			clearTimeout(timer);
		}
		// The caller's wait is over: never claimed, the window's late claim is refused and nothing is done; claimed, the
		// deletion is under way, and how it ends is told once the window answers (REMOTE.md R4)
		answer.catch(() => undefined);
		return this.tickets.timeout(ticket) === 'not_applied' ? { outcome: 'not_applied' } : { outcome: 'unknown', late: answer };
	}

	async deletionLoss(folder: string, options: WorktreeDeletion): Promise<readonly string[]> {
		// The same deletion's shared preflight alone: nothing stopped, closed or removed (O5)
		return await vscode.commands.executeCommand<readonly string[] | undefined>('_facade.worktree.removalLoss', vscode.Uri.file(folder), this.deletionOf(options)) ?? [];
	}

	/** The options `_facade.worktree.delete` and `_facade.worktree.removalLoss` take for a deletion `options` describe. */
	private deletionOf(options: WorktreeDeletion): WindowDeletion {
		return {
			discardChanges: options.discardChanges,
			ownFiles: options.ownFiles,
			main: vscode.Uri.file(options.main),
			runs: options.agents.map(id => ({ workspace: this.workspace, id })),
			...(options.leftover ? { leftover: true } : {}),
			...(options.by ? { by: options.by } : {})
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
