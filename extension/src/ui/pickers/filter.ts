/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { Catalog, Location, LocationPort, LogPort, WorkspaceFolderInfo } from '../../core/ports';
import type { PanelFilter } from '../../webview/protocol';
import { locationLabel } from '../cardView';
import { PanelModel } from '../model';
import { agentCountText, plainText } from '../presentation';
import { folderIconOf, inStepOrder, locationIcon, locationsIn } from './location';
import { BACK, Flow } from './stepping';

/** An item: the filter it sets - `all`, every card - or the folder whose own step it opens. */
type Item = vscode.QuickPickItem & { readonly filter?: PanelFilter | 'all'; readonly folder?: WorkspaceFolderInfo };
type Model = Pick<PanelModel, 'count' | 'currentFilter'>;
type Locations = Pick<LocationPort, 'snapshot' | 'refresh' | 'onDidChange'>;

/** What an item stands for, whatever its step: a folder by its URI - opening its step or filtering by it - else its filter. */
function keyOf(item: Item): string | undefined {
	if (item.folder) {
		return `folder:${item.folder.uri}`;
	}
	return item.filter === 'all' ? 'all' : item.filter && `${item.filter.kind}:${item.filter.id}`;
}

/** Every card in `folder`, whichever of its locations. */
function wholeOf(folder: WorkspaceFolderInfo): PanelFilter {
	return { kind: 'folder', id: folder.uri, label: folder.name };
}

/** Whether `folder` is in Git: a location of it is a repository's checkout, not a plain folder. */
function inGit(catalog: Catalog, folder: WorkspaceFolderInfo): boolean {
	return locationsIn(catalog, folder).some(location => location.kind !== 'folder');
}

/**
 * The locations of `folder` the picker lists (PANEL-2.3), in its steps' order - the main checkout first, then the folder's opened
 * location (WORKTREES-1.2): those with cards, starting and failed ones included, and the current filter's.
 */
function listedIn(model: Model, catalog: Catalog, folder: WorkspaceFolderInfo): { readonly location: Location; readonly filter: PanelFilter }[] {
	const current = model.currentFilter();
	return inStepOrder(locationsIn(catalog, folder), folder)
		.map(location => ({ location, filter: { kind: 'location' as const, id: location.id, label: locationLabel(location, catalog) } }))
		.filter(({ filter }) => model.count(filter) > 0 || (current?.kind === filter.kind && current.id === filter.id));
}

/** A step: `first`, then one separator and `rest` where there is any (PANEL-2.3, D82). */
function stepOf(first: Item, rest: readonly Item[]): Item[] {
	return rest.length ? [first, { label: '', kind: vscode.QuickPickItemKind.Separator }, ...rest] : [first];
}

function locationItem(model: Model, location: Location, filter: PanelFilter): Item {
	return { label: plainText(location.label), description: agentCountText(model.count(filter)), iconPath: locationIcon(location), filter };
}

/**
 * The first step of Filter by Working Location (PANEL-2.3, D82). In a window of several folders: All Locations, then each folder
 * with cards. One opens its own step where two or more of its locations are listed, or where the filtered location is one of
 * several it has - so that the filter stays in sight and Enter keeps it; any other filters by the folder at once. In a window of
 * one folder: that folder's step alone, its first item every card - All Worktrees, or All Locations outside Git. A filtered
 * location the catalog does not list now - temporarily unavailable - stays choosable, last, by the label it had.
 */
export function filterItems(model: Model, catalog: Catalog): Item[] {
	const current = model.currentFilter();
	const lost: Item[] = current?.kind === 'location' && !catalog.locations.some(location => location.id === current.id)
		? [{ label: plainText(current.label), description: agentCountText(model.count(current)), iconPath: new vscode.ThemeIcon('worktree'), filter: current }]
		: [];
	if (catalog.folders.length < 2) {
		const folder = catalog.folders.at(0);
		const locations = folder ? listedIn(model, catalog, folder).map(({ location, filter }) => locationItem(model, location, filter)) : [];
		const label = folder && inGit(catalog, folder) ? vscode.l10n.t("All Worktrees") : vscode.l10n.t("All Locations");
		return stepOf({ label, description: agentCountText(model.count(undefined)), iconPath: new vscode.ThemeIcon('list-flat'), filter: 'all' }, [...locations, ...lost]);
	}
	const folders = catalog.folders.flatMap((folder): Item[] => {
		const whole = wholeOf(folder);
		const listed = listedIn(model, catalog, folder);
		if (!listed.length && !(current?.kind === 'folder' && current.id === folder.uri)) {
			return [];
		}
		const holdsFilter = current?.kind === 'location' && listed.some(each => each.filter.id === current.id) && locationsIn(catalog, folder).length > 1;
		const does = listed.length > 1 || holdsFilter ? { folder } : { filter: whole };
		return [{ label: plainText(folder.name), description: agentCountText(model.count(whole)), iconPath: folderIconOf(catalog, folder), ...does }];
	});
	return stepOf({ label: vscode.l10n.t("All Locations"), description: agentCountText(model.count(undefined)), iconPath: new vscode.ThemeIcon('list-flat'), filter: 'all' }, [...folders, ...lost]);
}

/** A folder's step (PANEL-2.3, D82): All Worktrees - the whole folder - then its locations listed, each with its count. */
export function folderItems(model: Model, catalog: Catalog, folder: WorkspaceFolderInfo): Item[] {
	const whole = wholeOf(folder);
	const locations = listedIn(model, catalog, folder).map(({ location, filter }) => locationItem(model, location, filter));
	return stepOf({ label: vscode.l10n.t("All Worktrees"), description: agentCountText(model.count(whole)), iconPath: new vscode.ThemeIcon('list-flat'), filter: whole }, locations);
}

/** The first step's hint: a worktree where its items are one repository's worktrees, else a working location. */
function firstPlaceholder(catalog: Catalog): string {
	const folder = catalog.folders.length < 2 ? catalog.folders.at(0) : undefined;
	return folder && inGit(catalog, folder) ? worktreePlaceholder() : vscode.l10n.t("Select a working location to show its agents");
}

function worktreePlaceholder(): string {
	return vscode.l10n.t("Select a worktree to show its agents");
}

/** Where the first step is at: the current filter - through its folder where the window has several - else every card. */
function firstAt(catalog: Catalog, current: PanelFilter | undefined): string {
	if (!current) {
		return 'all';
	}
	if (catalog.folders.length < 2) {
		return current.kind === 'folder' ? 'all' : `location:${current.id}`;
	}
	if (current.kind === 'folder') {
		return `folder:${current.id}`;
	}
	const location = catalog.locations.find(each => each.id === current.id);
	const folder = location && catalog.folders.find(each => location.folders.some(other => other.uri === each.uri));
	return folder ? `folder:${folder.uri}` : `location:${current.id}`;
}

/** Where a folder's step is at: the filtered location where it lists it, else All Worktrees. */
function folderAt(model: Model, catalog: Catalog, folder: WorkspaceFolderInfo): string {
	const current = model.currentFilter();
	return current?.kind === 'location' && listedIn(model, catalog, folder).some(each => each.filter.id === current.id) ? `location:${current.id}` : `folder:${folder.uri}`;
}

interface StepOptions {
	readonly title: string;
	readonly itemsOf: (catalog: Catalog) => Item[];
	readonly placeholderOf: (catalog: Catalog) => string;
	/** Where the step opens, by `keyOf`. */
	readonly at: string;
	/** Where it is at once the item under the cursor is gone. */
	readonly atOf: (catalog: Catalog) => string;
	readonly back: boolean;
}

/**
 * One step: busy while the locations are first read, its items and hint read again as they change - the item under the cursor
 * staying under it, else the step back where it would open (PANEL-2.3).
 */
async function step(flow: Flow, locations: Locations, options: StepOptions): Promise<Item | typeof BACK | undefined> {
	const catalog = locations.snapshot();
	const items = options.itemsOf(catalog);
	const picked = await flow.pick<Item>({
		title: options.title,
		placeholder: options.placeholderOf(catalog),
		items,
		active: items.find(item => keyOf(item) === options.at),
		back: options.back,
		busy: catalog.pending,
		live: picker => locations.onDidChange(() => {
			const active = picker.activeItems.at(0);
			const now = locations.snapshot();
			const next = options.itemsOf(now);
			const at = active && next.some(item => keyOf(item) === keyOf(active)) ? keyOf(active) : options.atOf(now);
			picker.items = next;
			picker.placeholder = options.placeholderOf(now);
			picker.busy = now.pending;
			picker.activeItems = next.filter(item => keyOf(item) === at);
		})
	});
	return picked === undefined || picked === BACK ? picked : picked.item;
}

/**
 * Filter by Working Location (PANEL-2.3, D82): native steps by folder, the current filter highlighted - through its folder in the
 * first. Choosing shows only that folder's or location's cards - the first step's first item every card - kept in workspace
 * storage; Back returns to the first step at the folder chosen; Escape changes nothing.
 */
export async function pickFilter(model: PanelModel, locations: Locations, log: LogPort): Promise<void> {
	locations.refresh().catch(err => log.event(`Could not refresh the working locations: ${messageOf(err)}`));
	const current = model.currentFilter();
	const title = vscode.l10n.t("Filter by Working Location");
	const firstOf = (catalog: Catalog) => firstAt(catalog, current);
	const flow = new Flow();
	let at = firstOf(locations.snapshot());
	let chosen: PanelFilter | 'all' | undefined;
	for (; ;) {
		const first = await step(flow, locations, { title, itemsOf: catalog => filterItems(model, catalog), placeholderOf: firstPlaceholder, at, atOf: firstOf, back: false });
		if (first === undefined || first === BACK) {
			break;
		}
		const folder = first.folder;
		if (!folder) {
			chosen = first.filter;
			break;
		}
		const inFolder = await step(flow, locations, {
			// The folder named as New Agent names its choices
			title: `${title} · ${folder.name}`,
			itemsOf: catalog => folderItems(model, catalog, folder),
			placeholderOf: worktreePlaceholder,
			at: folderAt(model, locations.snapshot(), folder),
			atOf: catalog => folderAt(model, catalog, folder),
			back: true
		});
		if (inFolder === BACK) {
			at = `folder:${folder.uri}`;
			continue;
		}
		chosen = inFolder?.filter;
		break;
	}
	flow.close();
	if (chosen !== undefined) {
		model.setFilter(chosen === 'all' ? undefined : chosen);
	}
}
