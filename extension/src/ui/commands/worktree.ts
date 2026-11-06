/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { folderKeyOf } from '../../base/files';
import { messageOf } from '../../base/errors';
import { isJsonObject } from '../../base/json';
import { invalid } from '../../core/errors';
import { worktreeCreationEffects } from '../../core/locations/problems';
import { Agents, Catalog, HumanPort, Location, LocationPort, LogPort, WorkspaceFolderInfo, WorktreeError, WorktreePlan, WorktreePort } from '../../core/ports';
import { COMMANDS, PANEL_VIEW } from '../catalog';
import { worktreeFailureText } from '../presentation';
import { askWorktreeBranch, chooseFolder, worktreeProblemText } from '../pickers/location';
import { BACK, Flow } from '../pickers/stepping';

export interface WorktreeCommandDeps {
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange'>;
	readonly worktrees: WorktreePort;
	/** Counted in the confirmation of a folder's removal from the folder step (WORKTREES-3.3). */
	readonly agents: Pick<Agents, 'list'>;
	/** A human-operation error, in this window (RULES-1.8). */
	readonly notifyError: HumanPort['error'];
	readonly log: LogPort;
}

/** What a New Worktree made: its location, path and branch (WORKTREES-4.3). Native preparation after it is not claimed. */
export interface NewWorktreeResult {
	readonly location_id: string;
	readonly destination: string;
	readonly branch: string;
}

/**
 * `facade.newWorktree` (WORKTREES-2.1, 4.3): `{location_id, branch, base_ref?}` creates at once, from that location's HEAD where
 * no base is named; without arguments, the person chooses in this window's own pickers. Either way the worktree becomes a location
 * of the catalog - no window opens, no workspace folder is added (WORKTREES-2.2) - and an error goes to the person.
 */
export function registerWorktreeCommands(deps: WorktreeCommandDeps): vscode.Disposable[] {
	return [
		// New Worktree... in the view menu only, hidden from the Command Palette (UX-3.1)
		vscode.commands.registerCommand(COMMANDS.newWorktree, async (arg?: unknown): Promise<NewWorktreeResult | undefined> => {
			// No request where the editor's own menu runs it: the person chooses
			if (!fromEditorMenu(arg)) {
				const request = requestOf(arg);
				return createAs(deps, request.branch, () => deps.worktrees.plan(request.location_id, request.branch, request.base_ref));
			}
			const plan = await choosePlan(deps);
			return plan ? createAs(deps, plan.branch, async () => plan) : undefined;
		})
	];
}

/**
 * Whether `arg` is all the editor gives a command its own menu runs (WORKTREES-4.3): nothing, `null`, or, for an item clicked
 * with the mouse, `{ preserveFocus }` - VS Code's context for an item with none of its own.
 */
function fromEditorMenu(arg: unknown): boolean {
	return arg === undefined || arg === null || (isJsonObject(arg) && Object.keys(arg).length === 1 && typeof arg.preserveFocus === 'boolean');
}

/** The command's arguments, exactly (WORKTREES-4.3): anything else fails without a guess. */
function requestOf(arg: unknown): { readonly location_id: string; readonly branch: string; readonly base_ref?: string } {
	const given = arg as { readonly [key: string]: unknown } | null;
	if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(given).some(key => !['location_id', 'branch', 'base_ref'].includes(key))
		|| typeof given.location_id !== 'string' || typeof given.branch !== 'string' || (given.base_ref !== undefined && typeof given.base_ref !== 'string')) {
		throw invalid('invalid_argument', 'Expected { "location_id": string, "branch": string, "base_ref"?: string }.');
	}
	return { location_id: given.location_id, branch: given.branch, ...(given.base_ref !== undefined ? { base_ref: given.base_ref } : {}) };
}

/** Plans and creates with the view's progress; a failure, with what it actually left, goes to the person. */
async function createAs(deps: WorktreeCommandDeps, branch: string, plan: () => Promise<WorktreePlan>): Promise<NewWorktreeResult | undefined> {
	try {
		const made = await vscode.window.withProgress({ location: { viewId: PANEL_VIEW } }, async () => deps.worktrees.create(await plan(), () => true));
		return { location_id: made.id, destination: made.path, branch };
	} catch (err) {
		deps.notifyError(failureText(err, branch), {});
		return undefined;
	}
}

function failureText(err: unknown, branch: string): string {
	return worktreeFailureText(worktreeProblemText(err, messageOf(err)), err instanceof WorktreeError ? worktreeCreationEffects(branch, err.effects) : undefined);
}

/** The selected workspace folder itself is the source, including a linked checkout or a subfolder (WORKTREES-2.1). */
export function sourceIn(catalog: Catalog, folder: WorkspaceFolderInfo): Location | undefined {
	return catalog.locations.find(each => !each.within && each.folders.some(other => other.uri === folder.uri)
		&& (each.uri === folder.uri || folderKeyOf(each.path) === folderKeyOf(folder.path)));
}

/** Folder where needed, then a validated branch input. Accepting it creates directly from that source's HEAD. */
async function choosePlan(deps: WorktreeCommandDeps): Promise<WorktreePlan | undefined> {
	if (!deps.locations.snapshot().folders.length) {
		deps.notifyError(vscode.l10n.t("New Worktree requires a working location in a Git repository with at least one commit."), {});
		return undefined;
	}
	const flow = new Flow();
	let folder: WorkspaceFolderInfo | undefined;
	let branch: string | undefined;
	for (; ;) {
		const chosen = await chooseFolder(flow, deps, vscode.l10n.t("New Worktree · Select Folder"), folder, false);
		if (chosen === undefined || chosen === BACK) {
			flow.close();
			return undefined;
		}
		if (folder && chosen.uri !== folder.uri) {
			branch = undefined;
		}
		folder = chosen;
		const source = sourceIn(deps.locations.snapshot(), folder);
		const state = await flow.checking(async () => source ? vscode.window.withProgress({ location: { viewId: PANEL_VIEW } }, () => deps.worktrees.availability(source.id))
			.then(answer => answer, (err: unknown) => ({ available: false as const, reason: messageOf(err) })) : undefined);
		if (!source || state === undefined || !state.available) {
			flow.close();
			if (!source) {
				deps.notifyError(vscode.l10n.t("New Worktree requires a working location in a Git repository with at least one commit."), {});
			} else if (state !== undefined && !state.available) {
				deps.notifyError(vscode.l10n.t("New Worktree is unavailable: {0}", worktreeProblemText(state, state.reason)), {});
			}
			return undefined;
		}
		const plan = await askWorktreeBranch(flow, deps.worktrees, source, {
			title: vscode.l10n.t("New Worktree"), value: branch, back: deps.locations.snapshot().folders.length > 1,
			typed: value => { branch = value; }
		});
		if (plan === BACK) {
			continue;
		}
		flow.close();
		return plan;
	}
}
