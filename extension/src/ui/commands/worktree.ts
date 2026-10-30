/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { invalid } from '../../core/errors';
import { worktreeCreationEffects } from '../../core/locations/problems';
import { Agents, Catalog, HumanPort, Location, LocationPort, LogPort, WorkspaceFolderInfo, WorktreeError, WorktreePlan, WorktreePort } from '../../core/ports';
import { COMMANDS, PANEL_VIEW } from '../catalog';
import { worktreeFailureText } from '../presentation';
import { askWorktreeRef, chooseFolder, copyPathAction, worktreeBaseLabel, worktreeProblemText } from '../pickers/location';
import { BACK, Flow } from '../pickers/stepping';

/** New Worktree... in the view menu only, hidden from the Command Palette (UX-3.1). */
export const NEW_WORKTREE_COMMAND = COMMANDS.newWorktree;

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
		vscode.commands.registerCommand(NEW_WORKTREE_COMMAND, async (arg?: unknown): Promise<NewWorktreeResult | undefined> => {
			// The view's own menu gives `null`: no request, the person chooses
			if (arg !== undefined && arg !== null) {
				const request = requestOf(arg);
				return createAs(deps, request.branch, () => deps.worktrees.plan(request.location_id, request.branch, request.base_ref));
			}
			const plan = await choosePlan(deps);
			return plan ? createAs(deps, plan.branch, async () => plan) : undefined;
		})
	];
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

/**
 * The checkout a new worktree of the workspace folder `folder` is made from (WORKTREES-2.1): its repository's main checkout, whose
 * HEAD a creation starts from; for a bare repository, which has none, the folder's first checkout. Where the catalog knows no checkout
 * of the folder - a plain folder, or one whose Git is still being read - the location the folder opened, which Git is then asked about.
 */
function sourceIn(catalog: Catalog, folder: WorkspaceFolderInfo): Location | undefined {
	const of = catalog.locations.filter(each => each.folders.some(other => other.uri === folder.uri));
	const checkouts = of.filter(each => each.kind === 'checkout');
	return checkouts.find(each => each.isMain) ?? checkouts[0] ?? of.find(each => each.opened) ?? of[0];
}

/**
 * The person's New Worktree (WORKTREES-2.1), one flow with Back (UX-1.1): the workspace folder where there are several - Change
 * Working Location's own folder step - its repository the source; the folder's prerequisite missing ends the flow with why, such as
 * a folder that is no Git repository; then a branch prefilled with `git.branchPrefix` and checked as it is typed, and a last step
 * showing branch, base and destination before anything is made, where the base, the source's HEAD at first, can be changed. Escape
 * at any step ends it with no effect.
 */
async function choosePlan(deps: WorktreeCommandDeps): Promise<WorktreePlan | undefined> {
	if (!deps.locations.snapshot().folders.length) {
		deps.notifyError(vscode.l10n.t("New Worktree needs a working location in a Git repository with a commit."), {});
		return undefined;
	}
	const flow = new Flow();
	const title = vscode.l10n.t("New Worktree");
	let folder: WorkspaceFolderInfo | undefined;
	let source: Location | undefined;
	let branch: string | undefined;
	let base: string | undefined;
	let plan: WorktreePlan | undefined;
	let step: 'folder' | 'branch' | 'confirm' | 'base' = 'folder';
	for (; ;) {
		if (step === 'folder') {
			// One folder: no step, that folder (WORKTREES-2.1)
			const chosen = await chooseFolder(flow, deps, title, folder, false);
			if (chosen === undefined || chosen === BACK) {
				flow.close();
				return undefined;
			}
			const found = sourceIn(deps.locations.snapshot(), chosen);
			// Git asked now, with the folder step busy meanwhile: the folder's prerequisite, as it stands (WORKTREES-2.3)
			const state = await flow.checking(async () => found ? deps.worktrees.availability(found.id).catch((err: unknown) => ({ available: false as const, reason: messageOf(err) })) : undefined);
			if (!found || state === undefined || !state.available) {
				flow.close();
				if (!found) {
					deps.notifyError(vscode.l10n.t("New Worktree needs a working location in a Git repository with a commit."), {});
				} else if (state !== undefined && !state.available) {
					// Report the requested operation's missing prerequisite; cancellation has no effect (WORKTREES-2.3).
					deps.notifyError(vscode.l10n.t("New Worktree is unavailable: {0}", worktreeProblemText(state, state.reason)), {});
				}
				return undefined;
			}
			if (found.id !== source?.id) {
				base = undefined;
			}
			folder = chosen;
			source = found;
			step = 'branch';
		} else if (step === 'branch') {
			// Back to the folder step where there is one
			const several = deps.locations.snapshot().folders.length > 1;
			const answer = await askWorktreeRef(flow, deps.worktrees, source!, { title, kind: 'branch', value: branch, base, back: several });
			if (answer === undefined) {
				return undefined;
			}
			if (answer === BACK) {
				step = 'folder';
				continue;
			}
			plan = answer;
			branch = answer.branch;
			step = 'confirm';
		} else if (step === 'base') {
			const answer = await askWorktreeRef(flow, deps.worktrees, source!, { title, kind: 'base', value: plan!.baseRef, branch: plan!.branch, back: true });
			if (answer === undefined) {
				return undefined;
			}
			if (answer !== BACK) {
				plan = answer;
				base = answer.baseRef;
			}
			step = 'confirm';
		} else {
			const chosen = await confirm(flow, title, plan!, source!, base);
			if (chosen === undefined) {
				return undefined;
			}
			if (chosen === BACK) {
				step = 'branch';
			} else if (chosen === 'base') {
				step = 'base';
			} else {
				flow.close();
				return plan;
			}
		}
	}
}

type ConfirmItem = vscode.QuickPickItem & { readonly does: 'create' | 'base' };

/** The last step: what will be made, before it is (WORKTREES-2.1). */
async function confirm(flow: Flow, title: string, plan: WorktreePlan, source: Location, explicitBase: string | undefined): Promise<'create' | 'base' | typeof BACK | undefined> {
	const base = worktreeBaseLabel(plan, source, explicitBase);
	const items: ConfirmItem[] = [
		// {0} the branch, {1} its base, {2} the base's commit
		{ label: vscode.l10n.t("Create Worktree"), description: plan.destination, detail: vscode.l10n.t("Branch {0} · Base: {1} ({2})", plan.branch, base, plan.baseCommit.slice(0, 12)), iconPath: new vscode.ThemeIcon('add'), does: 'create' },
		{ label: vscode.l10n.t("Change Base..."), description: base, detail: vscode.l10n.t("Commit, branch, or tag to start from"), iconPath: new vscode.ThemeIcon('git-commit'), does: 'base' }
	];
	const picked = await flow.pick({ title, placeholder: vscode.l10n.t("Confirm worktree details or change base"), items, active: items[0], back: true, actions: [copyPathAction(plan.destination)] });
	return picked === undefined || picked === BACK ? picked : picked.item.does;
}
