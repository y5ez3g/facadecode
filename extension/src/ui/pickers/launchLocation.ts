/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { Catalog, Location, LocationPort, LogPort, WorkspaceFolderInfo } from '../../core/ports';
import { catalogStep, folderRow, inStepOrder, locationRow, locationsIn } from './location';
import { BACK, Flow } from './stepping';

/** An item: the location it chooses - a folder's own row choosing its only one - else the folder whose own step it opens. */
type Item = vscode.QuickPickItem & { readonly location?: Location; readonly folder?: WorkspaceFolderInfo };
type Locations = Pick<LocationPort, 'snapshot' | 'refresh' | 'onDidChange'>;

/** What an item stands for, whatever its step: a folder's row by the folder - whether it opens a step or chooses at once - else its location. */
function keyOf(item: Item): string | undefined {
	return item.folder ? `folder:${item.folder.uri}` : item.location && `location:${item.location.id}`;
}

/** The locations of `folder`, main checkout first, then the folder's opened location (WORKTREES-1.2). */
function folderItems(catalog: Catalog, folder: WorkspaceFolderInfo): Item[] {
	return inStepOrder(locationsIn(catalog, folder), folder).map(locationRow);
}

/**
 * The first step (CLIS-4.1, D84). In a window of several folders, the folders, as Change Working Location lists them - by name, the
 * folder that holds each beside it; one with a single location chooses it at once, one with more opens its own step. In a window
 * of one folder, its locations. No separator: every item is a choice of the same kind.
 */
function firstItems(catalog: Catalog): Item[] {
	if (catalog.folders.length < 2) {
		return catalog.folders.flatMap(folder => folderItems(catalog, folder));
	}
	return catalog.folders.flatMap((folder): Item[] => {
		const here = locationsIn(catalog, folder);
		if (!here.length) {
			return [];
		}
		return [{ ...folderRow(catalog, folder), ...here.length === 1 ? { location: here[0] } : {} }];
	});
}

function firstPlaceholder(catalog: Catalog): string {
	return catalog.folders.length > 1 ? vscode.l10n.t("Select a folder") : vscode.l10n.t("Select a working location");
}

/** One step, as the catalog is now and changes (WORKTREES-1.3): the item under the cursor stays under it where it still is. */
function step(flow: Flow, locations: Locations, title: string, placeholderOf: (catalog: Catalog) => string, itemsOf: (catalog: Catalog) => Item[], at: string | undefined, back: boolean): Promise<Item | typeof BACK | undefined> {
	return catalogStep(flow, locations, { title, placeholderOf, itemsOf, keyOf, ...at !== undefined ? { at } : {}, back, matchOnDescription: true });
}

/**
 * The location Show Agent Launch shows, the person's choice (CLIS-4.1, D84): native steps by folder, as Change Working Location
 * has them - a folder's own step titled with it, Back returning to the folders at it. Null where the person ends the flow.
 */
export async function chooseLaunchLocation(locations: Locations, log: LogPort): Promise<Location | null> {
	// A location catalog opened reads Git again where needed; its items follow (WORKTREES-1.3)
	locations.refresh().catch(err => log.event(`Could not refresh the working locations: ${messageOf(err)}`));
	const title = vscode.l10n.t("Show Agent Launch");
	const flow = new Flow();
	let at: string | undefined;
	let chosen: Location | null = null;
	for (; ;) {
		const first = await step(flow, locations, title, firstPlaceholder, firstItems, at, false);
		if (first === undefined || first === BACK) {
			break;
		}
		if (first.location) {
			chosen = first.location;
			break;
		}
		const folder = first.folder!;
		const inFolder = await step(flow, locations, `${title} · ${folder.name}`, () => vscode.l10n.t("Select a working location"), catalog => folderItems(catalog, folder), undefined, true);
		if (inFolder === BACK) {
			at = `folder:${folder.uri}`;
			continue;
		}
		chosen = inFolder?.location ?? null;
		break;
	}
	flow.close();
	return chosen;
}
