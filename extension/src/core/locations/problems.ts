/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorktreeCreationEffects, WorktreeError } from '../ports';

/** Preserve only effects the creation operation confirmed; both entry flows use these same facts. */
export function worktreeCreationEffects(branch: string, effects: WorktreeError['effects']): WorktreeCreationEffects | undefined {
	return effects.branchCreated || effects.destinationCreated ? {
		...(effects.branchCreated ? { branch } : {}),
		...(effects.destinationCreated ? { folder: effects.destinationCreated } : {})
	} : undefined;
}

// Why a new worktree cannot be made, or one cannot be deleted, as data (UX-2.4): the host says it in English to agents and the log, the UI in the person's
// language. Git's own diagnostics stay as Git said them.

/** Why a branch's folder name cannot be one on some OS (WORKTREES-2.2): no name, a trailing dot or space, a Windows device name. */
export interface FolderNameProblem {
	readonly kind: 'folder_name';
	readonly name: string;
	readonly why: 'unusable' | 'trailing' | 'device';
}

export type WorktreeProblem =
	| FolderNameProblem
	| { readonly kind: 'branch_required' }
	| { readonly kind: 'base_required' }
	| { readonly kind: 'branch_rejected'; readonly branch: string }
	/** `clash` exists, and Git cannot have a branch named as another's folder of branches. */
	| { readonly kind: 'branch_prefix_clash'; readonly clash: string }
	| { readonly kind: 'branch_exists'; readonly branch: string }
	| { readonly kind: 'pattern_invalid'; readonly detail: string }
	| { readonly kind: 'pattern_mismatch'; readonly branch: string; readonly pattern: string }
	| { readonly kind: 'base_unknown'; readonly ref: string; readonly path: string }
	| { readonly kind: 'no_location'; readonly id: string }
	| { readonly kind: 'git_missing' }
	| { readonly kind: 'not_repository'; readonly path: string }
	| { readonly kind: 'no_commit'; readonly path: string }
	| { readonly kind: 'git_failed'; readonly path: string; readonly detail: string }
	| { readonly kind: 'git_extension_missing' }
	| { readonly kind: 'git_extension_failed'; readonly detail: string }
	| { readonly kind: 'no_native_creation' }
	| { readonly kind: 'repository_not_open' }
	| { readonly kind: 'creation_failed'; readonly detail: string }
	/** The editor reported `path`, but Git could not be read to confirm it (`detail`), or does not list it (no `detail`). */
	| { readonly kind: 'creation_unconfirmed'; readonly path: string; readonly detail?: string }
	| { readonly kind: 'created_elsewhere'; readonly path: string }
	/** Deletion (WORKTREES-3.2, D73): `name` is no linked worktree, or a workspace folder is in it. */
	| { readonly kind: 'not_deletable'; readonly name: string }
	/** Git lists a change that is not committed, or an untracked file, in the worktree `name`: nothing was touched. */
	| { readonly kind: 'worktree_changed'; readonly name: string }
	/** Git lists the worktree as locked: no agent or file was touched. */
	| { readonly kind: 'worktree_locked'; readonly name: string }
	/** Another registered worktree, `nested`, is inside the worktree `name`, which would go with it: nothing was touched. */
	| { readonly kind: 'worktree_nested'; readonly name: string; readonly nested: string }
	/** An agent of the worktree `name` was closed, but its process could not be confirmed to have ended: nothing was deleted. */
	| { readonly kind: 'agents_not_ended'; readonly name: string }
	/** `git worktree remove` refused or failed; `detail` is what Git said. */
	| { readonly kind: 'deletion_failed'; readonly name: string; readonly detail: string };

/** A WorktreeError that says its problem as data too; its message is the English one. */
export class WorktreeProblemError extends WorktreeError {
	constructor(readonly problem: WorktreeProblem, message: string, reason: string, effects: WorktreeError['effects'] = {}) {
		super(message, reason, effects);
	}
}

/** The problem an error or an unavailable answer carries, where it carries one. */
export function worktreeProblemOf(value: unknown): WorktreeProblem | undefined {
	if (value instanceof WorktreeProblemError) {
		return value.problem;
	}
	const problem: unknown = value !== null && typeof value === 'object' ? (value as { readonly problem?: unknown }).problem : undefined;
	return problem !== null && typeof problem === 'object' && typeof (problem as { readonly kind?: unknown }).kind === 'string' ? problem as WorktreeProblem : undefined;
}
