/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { compactPath, folderKeyOf, homeRelative } from '../../base/files';
import { isJsonObject } from '../../base/json';
import { isDeletableWorktree, runsLaunchedIn } from '../../core/locations/catalog';
import { WorktreeProblem, worktreeProblemOf } from '../../core/locations/problems';
import type { Agents, Catalog, HumanPort, Location, LocationId, LocationPort, LogPort, WorkspaceFolderInfo, WorktreePlan, WorktreePort } from '../../core/ports';
import { plainText } from '../presentation';
import { BACK, Flow, StepAction } from './stepping';

/**
 * Why a new worktree cannot be made, in the person's language where Facade says it (UX-2.4) - from an error or an unavailable
 * answer that carries its problem - Git's and the editor's own diagnostics as they said them; `otherwise` where there is no problem.
 */
export function worktreeProblemText(value: unknown, otherwise: string): string {
	const problem = worktreeProblemOf(value);
	return problem ? wordsOf(problem) : otherwise;
}

function wordsOf(problem: WorktreeProblem): string {
	switch (problem.kind) {
		case 'folder_name':
			// {0} is the folder name a branch would give its worktree
			return problem.why === 'unusable' ? vscode.l10n.t("\"{0}\" cannot be the name of a folder.", problem.name)
				: problem.why === 'trailing' ? vscode.l10n.t("\"{0}\" ends in a dot or a space, which Windows does not allow at the end of a folder's name.", problem.name)
					: vscode.l10n.t("\"{0}\" is a name Windows keeps for a device, so a folder cannot have it.", problem.name);
		case 'branch_required': return vscode.l10n.t("Enter a branch name.");
		case 'base_required': return vscode.l10n.t("Enter a commit, branch, or tag.");
		case 'branch_rejected': return vscode.l10n.t("Git rejects \"{0}\" as a branch name.", problem.branch);
		// {0} is an existing branch whose name is the new one's folder, or inside it
		case 'branch_prefix_clash': return vscode.l10n.t("The branch {0} already exists; Git cannot use the same name for both a branch and a branch-name prefix.", problem.clash);
		case 'branch_exists': return vscode.l10n.t("A branch named {0} already exists.", problem.branch);
		// {0} is why the regular expression cannot be read
		case 'pattern_invalid': return vscode.l10n.t("git.branchValidationRegex is not a valid regular expression: {0}", problem.detail);
		// {0} is the branch, {1} the regular expression of git.branchValidationRegex
		case 'pattern_mismatch': return vscode.l10n.t("{0} does not match git.branchValidationRegex ({1}).", problem.branch, problem.pattern);
		// {0} is the base asked for, {1} the working location's path
		case 'base_unknown': return vscode.l10n.t("{0} is not a commit in the repository at {1}.", problem.ref, problem.path);
		case 'no_location': return vscode.l10n.t("The working location is no longer available.");
		case 'git_missing': return vscode.l10n.t("Git is not available in this environment.");
		// {0} is the folder's path, the home folder as ~
		case 'not_repository': return vscode.l10n.t("{0} is not in a Git repository.", homeRelative(problem.path));
		case 'no_commit': return vscode.l10n.t("{0} has no commits yet.", homeRelative(problem.path));
		// {0} is the path, {1} what Git said
		case 'git_failed': return vscode.l10n.t("Git could not read {0}: {1}", problem.path, problem.detail);
		case 'git_extension_missing': return vscode.l10n.t("The editor's Git extension is not available, so worktrees cannot be created.");
		// {0} is what the editor said
		case 'git_extension_failed': return vscode.l10n.t("The editor's Git extension is not available: {0}", problem.detail);
		case 'no_native_creation': return vscode.l10n.t("This editor's Git extension cannot create worktrees.");
		case 'repository_not_open': return vscode.l10n.t("The editor's Git extension has not opened this repository, so no worktree of it can be created.");
		// {0} is what Git said
		case 'creation_failed': return vscode.l10n.t("Git could not create the worktree: {0}", problem.detail);
		// {0} is the worktree's path, {1} why Git could not be read
		case 'creation_unconfirmed': return problem.detail === undefined
			? vscode.l10n.t("The editor reported a new worktree at {0}, but Git does not list one there.", problem.path)
			: vscode.l10n.t("The editor reported a new worktree at {0}, but Git could not confirm it: {1}", problem.path, problem.detail);
		case 'created_elsewhere': return vscode.l10n.t("The worktree at {0} was created, but it is not among this window's working locations.", problem.path);
		// {0} is the name of the working location
		case 'not_deletable': return vscode.l10n.t("Cannot delete \"{0}\": only standalone linked worktrees can be deleted.", problem.name);
		// {0} is the worktree's name
		case 'worktree_changed': return vscode.l10n.t("Cannot delete worktree \"{0}\": uncommitted changes present. Commit or stash them with Git, then try again.", problem.name);
		// {0} is the worktree's name
		case 'worktree_locked': return vscode.l10n.t("Cannot delete worktree \"{0}\": worktree is locked. Unlock it with Git, then try again.", problem.name);
		// {0} is the worktree's name, {1} the name of the worktree inside it
		case 'worktree_nested': return vscode.l10n.t("Cannot delete worktree \"{0}\": worktree \"{1}\" is inside it. Delete or move that worktree first, then try again.", problem.name, problem.nested);
		// {0} is the worktree's name
		case 'agents_not_ended': return vscode.l10n.t("Cannot delete worktree \"{0}\": an agent's process in it could not be confirmed to have ended. Try again once it has.", problem.name);
		// {0} is the worktree's name, {1} the link inside it, as its path from the worktree's folder
		case 'worktree_linked': return vscode.l10n.t("Cannot delete worktree \"{0}\": it contains a link to another folder ({1}), which this version of Git would delete through. Remove the link, or update Git to 2.54 or later, then try again.", problem.name, problem.link);
		// {0} is the worktree's name, {1} its folder's full path
		case 'worktree_left': return vscode.l10n.t("Deleted worktree \"{0}\", but Git left its folder {1} behind.", problem.name, problem.folder);
		// {0} is the worktree's name, {1} what Git said
		case 'deletion_failed': return deletionFailed(problem.name, problem.detail);
	}
}

/** Why a worktree could not be deleted, in Git's own words (WORKTREES-3.2). */
function deletionFailed(name: string, detail: string): string {
	return vscode.l10n.t("Could not delete worktree \"{0}\": {1}", name, detail);
}

/** The checkout a new worktree starts from, even when the selected location is its subfolder (WORKTREES-2.1). */
export function worktreeSourceLabel(location: Location): string {
	return location.branch ?? (location.detached ? 'HEAD' : location.label);
}

/**
 * The environment a location runs in, as the New Agent picker and a card's hover say it beside the location (LIFECYCLE-1.1, D67):
 * as VS Code's remote indicator names it. `authority` is the window's remote authority, which only the local window component
 * sees: the workspace extension host has its folders as `file:` URIs.
 */
export function environmentLabel(environment: string, authority?: string): string {
	if (environment === 'local') {
		return vscode.l10n.t("Local");
	}
	const [kind, ...rest] = (authority || environment).split('+');
	const name = hostOf(rest.join('+'));
	switch (kind) {
		// {0} is the remote host's name
		case 'ssh-remote': return name ? vscode.l10n.t("SSH: {0}", name) : 'SSH';
		// {0} is the WSL distribution's name
		case 'wsl': return name ? vscode.l10n.t("WSL: {0}", name) : 'WSL';
		case 'dev-container':
		case 'attached-container': return vscode.l10n.t("Dev Container");
		default: return kind;
	}
}

/** The host a remote authority names: plain, or hex-encoded JSON with its `hostName`, as Remote - SSH writes one it cannot spell. */
function hostOf(encoded: string): string {
	if (encoded.length % 2 === 0 && /^[0-9a-f]+$/i.test(encoded)) {
		try {
			const value: unknown = JSON.parse(Buffer.from(encoded, 'hex').toString('utf8'));
			if (isJsonObject(value) && typeof value.hostName === 'string' && value.hostName) {
				return value.hostName;
			}
		} catch {
			// A plain name made of hex digits
		}
	}
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

/** A location's icon: a plain folder, a repository's main checkout, or another worktree. */
export function locationIcon(location: Location): vscode.ThemeIcon {
	return new vscode.ThemeIcon(location.kind === 'folder' ? 'folder' : location.isMain ? 'repo' : 'worktree');
}

type LocationItem = vscode.QuickPickItem & { readonly location?: Location };
type FolderItem = vscode.QuickPickItem & { readonly folder?: WorkspaceFolderInfo; readonly add?: true };

/** The locations of a workspace folder, in the catalog's order (WORKTREES-1.2): every one associated with it. */
export function locationsIn(catalog: Catalog, folder: WorkspaceFolderInfo): Location[] {
	return catalog.locations.filter(location => location.folders.some(each => each.uri === folder.uri));
}

/** A workspace folder's icon: that of the location it opened - a plain folder, a repository's main checkout or another worktree. */
export function folderIconOf(catalog: Catalog, folder: WorkspaceFolderInfo): vscode.ThemeIcon {
	const opened = locationsIn(catalog, folder).find(location => location.opened && location.uri === folder.uri);
	return opened ? locationIcon(opened) : new vscode.ThemeIcon('folder');
}

/**
 * `locations` of `folder` in the order its steps list them: the main checkout first, then the folder's opened location; the
 * catalog's order and launch defaults stay intact (WORKTREES-1.2).
 */
export function inStepOrder(locations: readonly Location[], folder: WorkspaceFolderInfo): Location[] {
	const rank = (location: Location) => location.isMain ? 0 : location.uri === folder.uri ? 1 : 2;
	return [...locations].sort((a, b) => rank(a) - rank(b));
}

function locationItems(locations: readonly Location[], folder: WorkspaceFolderInfo): LocationItem[] {
	return inStepOrder(locations, folder).map(location => ({ label: plainText(location.label), description: plainText(homeRelative(location.path)), iconPath: locationIcon(location), location }));
}

/**
 * Where a new agent starts (LIFECYCLE-1.3): an existing location, or a new worktree of one - made only once the person accepts a CLI,
 * its base the source checkout's HEAD (WORKTREES-2.1).
 */
export interface Destination {
	readonly location: Location;
	readonly worktree?: { readonly branch: string; readonly destination: string; readonly baseRef: string };
}

type StepItem = LocationItem & { readonly newWorktree?: 'available' | 'unavailable' };

/** What the folder step reads and changes: the window's folders and their locations, and the agents a removal closes. */
export interface FolderStepDeps {
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange'>;
	/** Counted in a removal's confirmation: the removal itself closes them (WORKTREES-3.3). */
	readonly agents: Pick<Agents, 'list'>;
	readonly log: LogPort;
}

/** What Change Working Location reads and changes: the folder step's, the window's worktrees, and the agents a deletion closes. */
export interface LocationDeps extends FolderStepDeps {
	readonly worktrees: WorktreePort;
	/** A deleted worktree's agents are closed first (WORKTREES-3.2, 3.3). */
	readonly agents: Pick<Agents, 'list' | 'close'>;
	readonly notifyError: HumanPort['error'];
}

/** How long a change of the workspace folders is waited for: the editor makes it after it is asked to. */
const FOLDERS_CHANGE_MS = 10_000;

/**
 * The folder step (LIFECYCLE-1.3, D73), Change Working Location's and New Worktree's alike (WORKTREES-2.1): every workspace folder - a
 * plain one too - by its name, the folder that holds it beside it, and an X that removes it from the workspace once the person
 * confirmed it; then Add Folder to Workspace..., the editor's own. Shown where the window has several folders, `at` selected; with one
 * there is nothing to choose, and that one is the answer at once - where a removal leaves one too. Answers the folder chosen, `BACK`
 * (none left, or the step's Back where `back` gives it one), or none where the person ended the flow.
 */
export async function chooseFolder(flow: Flow, deps: FolderStepDeps, title: string, at: WorkspaceFolderInfo | undefined, back: boolean): Promise<WorkspaceFolderInfo | typeof BACK | undefined> {
	let active = at;
	for (; ;) {
		// The folders as they are now: the step adds and removes them
		const catalog = deps.locations.snapshot();
		if (catalog.folders.length < 2) {
			return catalog.folders[0] ?? BACK;
		}
		const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("Remove Folder from Workspace") };
		const items: FolderItem[] = [
			// Its name, then the folder that holds it, as VS Code lists recent folders: the home folder as ~. Removing one is offered
			// where another stays (D73)
			...catalog.folders.map((each): FolderItem => ({ label: plainText(each.name), description: plainText(homeRelative(path.dirname(each.path))), iconPath: folderIconOf(catalog, each), folder: each, buttons: [remove] })),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t("Add Folder to Workspace..."), iconPath: new vscode.ThemeIcon('add'), add: true }
		];
		const shown = active;
		// The folder given selected, else the first
		const picked = await flow.pick({ title, placeholder: vscode.l10n.t("Select a folder"), items, active: items.find(item => item.folder !== undefined && item.folder.uri === shown?.uri) ?? items[0], back });
		if (picked === undefined || picked === BACK) {
			return picked;
		}
		if (picked.item.add) {
			// The first added selected; the step as it was where the editor added none
			active = await flow.aside(() => addFolder(deps)) ?? active;
			continue;
		}
		const chosen = picked.item.folder!;
		if (!picked.button) {
			return chosen;
		}
		await flow.aside(() => removeFolder(deps, chosen));
		const left = deps.locations.snapshot().folders;
		active = left.find(each => each.uri === shown?.uri) ?? left[0];
	}
}

/**
 * Change Working Location (LIFECYCLE-1.3): the workspace folder, then the location in it - with New Worktree where the folder's
 * repository can have one, else its reason - a step skipped where it has one choice. New Worktree asks its branch, checked as it is
 * typed. The folder step also adds folders to the workspace and removes them from it; the location step deletes a linked worktree,
 * each only once the person confirmed it (D73). Answers the destination chosen, `BACK` from its first step - the New Agent picker
 * again - or none where the person ended the flow.
 */
export async function chooseLocation(flow: Flow, deps: LocationDeps, title: string, current: Destination): Promise<Destination | typeof BACK | undefined> {
	const { locations, worktrees } = deps;
	const start = locations.snapshot().folders;
	let folder = start.find(each => current.location.folders.some(of => of.uri === each.uri)) ?? start[0];
	let step: 'folder' | 'location' | 'branch' = start.length > 1 ? 'folder' : 'location';
	/** The checkout a new worktree would be made of in the folder chosen, and what the branch step proposed last. */
	let source: Location | undefined;
	let branch = current.worktree?.branch;
	/** Whether New Worktree is the choice the location step shows: the destination's, or the person's before Back (UX-1.1). */
	let wantsWorktree = !!current.worktree;
	/** The worktree being deleted: not offered meanwhile, and the step busy until it is gone (WORKTREES-3.2). */
	let deleting: { readonly id: LocationId; readonly done: Promise<void> } | undefined;
	for (; ;) {
		if (!folder) {
			return BACK;
		}
		if (step === 'folder') {
			// One folder left after a removal: no folder step, but that folder's locations (LIFECYCLE-1.3)
			const chosen = await chooseFolder(flow, deps, title, folder, true);
			if (chosen === undefined || chosen === BACK) {
				return chosen;
			}
			if (chosen.uri !== folder.uri) {
				branch = undefined;
			}
			folder = chosen;
			step = 'location';
			continue;
		}
		if (step === 'branch' && source) {
			// Back keeps the branch typed, to be there again, and New Worktree chosen on the step it returns to (UX-1.1)
			const plan = await askWorktreeRef(flow, worktrees, source, { title, kind: 'branch', value: branch, back: true, typed: value => { branch = value; } });
			if (plan === undefined) {
				return undefined;
			}
			if (plan === BACK) {
				step = 'location';
				continue;
			}
			return { location: source, worktree: { branch: plan.branch, destination: plan.destination, baseRef: plan.baseRef } };
		}
		const inFolder = locationsIn(locations.snapshot(), folder);
		// The source of a new worktree: the current checkout where it is in this folder, else the folder's first (WORKTREES-2.1)
		source = inFolder.find(each => each.id === current.location.id && each.kind === 'checkout') ?? inFolder.find(each => each.kind === 'checkout');
		// Nothing to choose here: a lone plain folder, no Git to offer or explain a worktree (LIFECYCLE-1.3)
		if (inFolder.length <= 1 && !source) {
			return inFolder[0] ? { location: inFolder[0] } : BACK;
		}
		const of = folder;
		const from = source;
		// Shown at once; whether a new worktree can be made comes when its check does (LIFECYCLE-1.3)
		let availability: { readonly available: true } | { readonly available: false; readonly reason: string } | undefined;
		const checked = from ? worktrees.availability(from.id)
			.catch((err: unknown) => ({ available: false as const, reason: messageOf(err) }))
			.then(answer => { availability = answer.available ? answer : { available: false, reason: worktreeProblemText(answer, answer.reason) }; }) : undefined;
		const worktreeItems = (): StepItem[] => !from || !availability ? [] : [
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			availability.available
				? { label: vscode.l10n.t("New Worktree..."), description: vscode.l10n.t("from {0}", plainText(worktreeSourceLabel(from))), iconPath: new vscode.ThemeIcon('add'), newWorktree: 'available' }
				// Git is there but a prerequisite is not: why, where it would be offered - nothing at all for a plain folder (PANEL-1.2)
				: { label: vscode.l10n.t("New Worktree..."), detail: plainText(availability.reason), iconPath: new vscode.ThemeIcon('add'), newWorktree: 'unavailable' }
		];
		// A linked worktree can be deleted here, one at a time (D73)
		const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("Delete Worktree") };
		const itemsOf = (catalog: Catalog): StepItem[] => [
			...locationItems(locationsIn(catalog, of).filter(each => each.id !== deleting?.id), of)
				.map(item => !deleting && isDeletableWorktree(item.location!, catalog.folders, folderKeyOf) ? { ...item, buttons: [remove] } : item),
			...worktreeItems()
		];
		const items = itemsOf(locations.snapshot());
		const picked = await flow.pick<StepItem>({
			title,
			placeholder: from ? vscode.l10n.t("Select a branch or worktree") : vscode.l10n.t("Select a working location"),
			items,
			active: items.find(item => wantsWorktree ? item.newWorktree === 'available' : item.location?.id === current.location.id),
			back: true,
			busy: locations.snapshot().pending || checked !== undefined || deleting !== undefined,
			accepts: item => item.newWorktree !== 'unavailable',
			// Git metadata, the worktree check or a deletion arriving while the step is up: what they add offered, the choice where it
			// was (WORKTREES-1.1)
			live: picker => {
				let up = true;
				const refresh = () => {
					if (!up) {
						return;
					}
					const catalog = locations.snapshot();
					const active = picker.activeItems[0];
					picker.items = itemsOf(catalog);
					// The choice where it was; none yet - New Worktree offered only now - the step's own, never a line or two rows
					const kept = (item: StepItem) => active
						? active.newWorktree ? item.newWorktree === active.newWorktree : item.location !== undefined && item.location.id === active.location?.id
						: wantsWorktree ? item.newWorktree === 'available' : item.location?.id === current.location.id;
					picker.activeItems = picker.items.filter(kept).slice(0, 1);
					picker.busy = catalog.pending || (checked !== undefined && availability === undefined) || deleting !== undefined;
				};
				void checked?.then(refresh);
				void deleting?.done.then(refresh);
				const listening = locations.onDidChange(refresh);
				return { dispose: () => { up = false; listening.dispose(); } };
			}
		});
		if (picked === undefined) {
			return undefined;
		}
		if (picked === BACK) {
			if (locations.snapshot().folders.length > 1) {
				step = 'folder';
				continue;
			}
			return BACK;
		}
		if (picked.button && picked.item.location) {
			const target = picked.item.location;
			if (await flow.aside(() => confirmDeletion(deps, target))) {
				// The step again at once, without it; what the deletion comes to is said when it does
				const done = deleteWorktree(deps, target).then(() => {
					if (deleting?.id === target.id) {
						deleting = undefined;
					}
				});
				deleting = { id: target.id, done };
			}
			continue;
		}
		if (picked.item.newWorktree === 'available') {
			wantsWorktree = true;
			step = 'branch';
			continue;
		}
		return { location: picked.item.location! };
	}
}

/** The sentence a removal's confirmation adds where it closes agents (WORKTREES-3.3): none where it closes none. */
function closingText(count: number): string | undefined {
	// {0} is how many agents, two or more
	return count === 0 ? undefined : count === 1 ? vscode.l10n.t("Its agent will be closed.") : vscode.l10n.t("{0} associated agents will be closed.", count);
}

/** Whether the person confirmed `message` with `action`, asked in a modal warning: anything else is no (D73). */
async function confirmed(message: string, action: string, detail?: string): Promise<boolean> {
	return await vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) }, action) === action;
}

/** The editor's own Add Folder to Workspace... (LIFECYCLE-1.3): its folder dialog, and the folders chosen appended to the workspace. */
const ADD_FOLDER_COMMAND = 'workbench.action.addRootFolder';

/**
 * Add Folder to Workspace... (D73): the editor's own command, whose dialog and title are the editor's. Answers the first folder it
 * added, once the catalog has what it added; none where it added none - the dialog cancelled, or only folders open already chosen.
 */
async function addFolder(deps: FolderStepDeps): Promise<WorkspaceFolderInfo | undefined> {
	const open = () => (vscode.workspace.workspaceFolders ?? []).map(each => each.uri.toString());
	const before = new Set(open());
	try {
		await vscode.commands.executeCommand(ADD_FOLDER_COMMAND);
	} catch (err) {
		deps.log.event(`The editor could not add a folder to the workspace: ${messageOf(err)}`);
		return undefined;
	}
	const added = open().filter(uri => !before.has(uri));
	if (!added.length) {
		return undefined;
	}
	await foldersSettled(deps.locations, folders => added.every(uri => folders.some(each => each.uri === uri)));
	return deps.locations.snapshot().folders.find(each => each.uri === added[0]);
}

/**
 * Remove Folder from Workspace (D73), once the person confirmed it - the folder stays on disk. The agents whose locations go with it
 * are closed by the removal itself (WORKTREES-3.3). Removing the first folder restarts the extensions, which ends this flow.
 */
async function removeFolder(deps: FolderStepDeps, folder: WorkspaceFolderInfo): Promise<void> {
	// The locations no other folder keeps: those the removal takes, with their agents
	const gone = new Set(deps.locations.snapshot().locations.filter(each => each.folders.every(of => of.uri === folder.uri)).map(each => each.id));
	const closing = deps.agents.list().filter(run => gone.has(run.location)).length;
	// {0} is the workspace folder's name
	if (!await confirmed(vscode.l10n.t("Remove \"{0}\" from this workspace? Files stay on disk.", folder.name), vscode.l10n.t("Remove"), closingText(closing))) {
		return;
	}
	// Where it is now: the folders may have changed while the person was asked
	const folders = deps.locations.snapshot().folders;
	const at = folders.find(each => each.uri === folder.uri);
	if (!at || folders.length < 2) {
		return;
	}
	if (!vscode.workspace.updateWorkspaceFolders(at.index, 1)) {
		deps.log.event(`The editor did not remove ${folder.path} from the workspace`);
		return;
	}
	await foldersSettled(deps.locations, left => !left.some(each => each.uri === folder.uri));
}

/** Resolves once the catalog's workspace folders are as `settled` says, or after {@link FOLDERS_CHANGE_MS}. */
function foldersSettled(locations: FolderStepDeps['locations'], settled: (folders: readonly WorkspaceFolderInfo[]) => boolean): Promise<void> {
	return new Promise(resolve => {
		if (settled(locations.snapshot().folders)) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			listening.dispose();
			resolve();
		};
		const timer = setTimeout(done, FOLDERS_CHANGE_MS);
		const listening = locations.onDidChange(() => {
			if (settled(locations.snapshot().folders)) {
				done();
			}
		});
	});
}

/** Asks before Delete Worktree (D73): its folder, the branch kept - or that it has none - and the agents that will close. */
function confirmDeletion(deps: LocationDeps, worktree: Location): Promise<boolean> {
	// Those launched in a location inside it too, as a resumed conversation's subdirectory (WORKTREES-3.2)
	const closing = runsLaunchedIn(deps.agents.list(), worktree.path, deps.locations.snapshot().locations, folderKeyOf).length;
	const message = vscode.l10n.t("Delete worktree \"{0}\"?", worktree.label);
	// Keep the exact full path in the detail, separate from the short decision question.
	const target = worktree.branch !== undefined
		// {0} is the full folder path, {1} its branch
		? vscode.l10n.t("Folder {0} will be deleted; branch {1} is kept.", worktree.path, worktree.branch)
		: vscode.l10n.t("Folder {0} will be deleted (detached HEAD).", worktree.path);
	const detail = [target, closingText(closing)].filter(Boolean).join('\n\n');
	return confirmed(message, vscode.l10n.t("Delete"), detail);
}

/**
 * Deletes a confirmed worktree (WORKTREES-3.2, D73): refused with nothing touched where it has changes; else its agents closed, their
 * processes ended, before Git removes it. Why it was not deleted goes to the person. Never rejects.
 */
async function deleteWorktree(deps: LocationDeps, worktree: Location): Promise<void> {
	// Its locations as the catalog lists them now: while it is deleted they are out of the catalog (WORKTREES-3.2)
	const locations = deps.locations.snapshot().locations;
	// True only once every agent's process is known to have ended: Git removes nothing a process may still be writing in
	const closeAgents = async () => {
		const results = await Promise.all(runsLaunchedIn(deps.agents.list(), worktree.path, locations, folderKeyOf).map(run => deps.agents.close(run.id).then(
			result => {
				deps.log.event(`Closed ${run.alias} to delete its worktree: ${result}`);
				return result === 'terminated' || result === 'already_exited' || result === 'already_ended' || result === 'not_started';
			},
			err => {
				deps.log.event(`Could not close ${run.alias} to delete its worktree: ${messageOf(err)}`);
				return false;
			})));
		return results.every(Boolean);
	};
	try {
		await deps.worktrees.remove(worktree.id, closeAgents);
	} catch (err) {
		deps.notifyError(worktreeProblemText(err, deletionFailed(worktree.label, messageOf(err))), {});
	}
}

type WorktreeRefInput = {
	readonly title: string;
	readonly back: boolean;
	/** Told each text as it is typed: what Back keeps for the step's return (UX-1.1). */
	readonly typed?: (value: string) => void;
} & ({ readonly kind: 'branch'; readonly value?: string; readonly base?: string }
	| { readonly kind: 'base'; readonly value: string; readonly branch: string });

/** The source's configured branch prefix; shared by both creation entries (WORKTREES-2.1). */
function branchPrefixOf(source: Location): string {
	const prefix = vscode.workspace.getConfiguration('git', vscode.Uri.parse(source.uri)).get<unknown>('branchPrefix');
	return typeof prefix === 'string' ? prefix : '';
}

/** Only an implicit HEAD gets its known branch label; explicit refs retain their identity (WORKTREES-2.1). */
export function worktreeBaseLabel(plan: WorktreePlan, source: Location, explicitBase: string | undefined): string {
	return explicitBase ?? (plan.baseRef === 'HEAD' ? worktreeSourceLabel(source) : plan.baseRef);
}

/** One preview for both creation entries and Change Base (WORKTREES-2.1). */
function worktreePreview(plan: WorktreePlan, source: Location, explicitBase: string | undefined): string {
	return vscode.l10n.t("{0} (base: {1})", compactPath(plan.destination), worktreeBaseLabel(plan, source, explicitBase));
}

/** The whole planned destination remains available without submitting the input or opening another step. */
export function copyPathAction(destination: string): StepAction {
	return {
		button: { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t("Copy Path ({0})", destination) },
		run: () => {
			void vscode.env.clipboard.writeText(destination).then(undefined, err => {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not copy path: {0}", messageOf(err)));
			});
		}
	};
}

/**
 * Both creation entries and Change Base use one validated reference input (WORKTREES-4.3). Planning has no effect;
 * the caller decides when to create. Back and Escape return without accepting a plan or starting creation.
 */
export async function askWorktreeRef(flow: Flow, worktrees: WorktreePort, source: Location, asked: WorktreeRefInput): Promise<WorktreePlan | typeof BACK | undefined> {
	const value = asked.kind === 'branch' ? asked.value ?? branchPrefixOf(source) : asked.value;
	/** The plans the checks made, by the text each was for: the one taken is never planned twice. */
	const plans = new Map<string, WorktreePlan>();
	const typed = await flow.text({
		title: asked.title,
		value,
		// Append to a branch prefix; select the whole base so it can be replaced.
		...(asked.kind === 'branch' ? { valueSelection: [value.length, value.length] as const } : {}),
		placeholder: asked.kind === 'branch' ? vscode.l10n.t("Branch name") : vscode.l10n.t("Commit, branch, or tag (e.g. HEAD)"),
		prompt: asked.kind === 'branch' ? vscode.l10n.t("Starts from {0}", asked.base ?? worktreeSourceLabel(source)) : vscode.l10n.t("Base ref for {0}", asked.branch),
		back: asked.back,
		validate: value => {
			asked.typed?.(value);
			return value.trim() ? undefined : wordsOf({ kind: asked.kind === 'branch' ? 'branch_required' : 'base_required' });
		},
		check: async value => {
			try {
				const text = value.trim();
				const plan = asked.kind === 'branch' ? await worktrees.plan(source.id, text, asked.base) : await worktrees.plan(source.id, asked.branch, text);
				plans.set(value, plan);
				return { prompt: worktreePreview(plan, source, asked.kind === 'branch' ? asked.base : text), actions: [copyPathAction(plan.destination)] };
			} catch (err) {
				return { problem: worktreeProblemText(err, messageOf(err)) };
			}
		}
	});
	// Enter takes a text only once its check passed: the plan is that check's
	return typed === undefined || typed === BACK ? typed : plans.get(typed)!;
}
