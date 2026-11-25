/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { LocationInfo, LocationListArgs, LocationListResult, MachineInfo } from '../../base/frameworkProtocol';
import { messageOf } from '../../base/errors';
import { isEqualPath, isInsideFolder } from '../../base/files';
import type { Catalog, Location, LocationPort, LogPort, WorkspaceFolderInfo } from '../../core/ports';
import { plainText } from '../presentation';
import { addFolder, addFolderItem, catalogStep, folderRow, inStepOrder, locationRow, locationsIn, removeFolderButton, removeWorkspaceFolder } from './location';
import { BACK, Flow } from './stepping';

/** An item: the location it chooses - a folder's own row choosing its only one - else the folder whose own step it opens. */
type Item = vscode.QuickPickItem & { readonly location?: Location; readonly folder?: WorkspaceFolderInfo };
type Locations = Pick<LocationPort, 'snapshot' | 'refresh' | 'onDidChange'>;

export interface LaunchPlace {
	readonly folder: string;
	readonly label: string;
	readonly machine?: MachineInfo;
	readonly kind: LocationInfo['kind'];
	readonly canCreateWorktree: boolean;
	readonly worktree?: string;
}

export interface LaunchLocationDeps {
	readonly locations: Locations;
	readonly hostMachineId: () => string;
	readonly machines: () => readonly MachineInfo[];
	readonly listLocations: (args: LocationListArgs) => Promise<LocationListResult>;
	readonly recentLocations?: (machineId: string) => readonly string[];
}

export function machineScope(machine: MachineInfo | undefined): LocationListArgs['scope'] {
	return machine && { kind: 'machine', machine: machine.selector };
}

export function workspacePlace(location: Location, catalog: Catalog): LaunchPlace {
	return {
		folder: location.path, label: location.label,
		kind: location.kind === 'folder' ? 'folder' : location.isMain ? 'main' : 'worktree',
		canCreateWorktree: location.kind === 'checkout' || catalog.locations.some(other => other.kind === 'checkout'
			&& isInsideFolder(location.path, other.path) && other.folders.some(folder => location.folders.some(source => source.uri === folder.uri)))
	};
}

/** The target's catalog validates the exact entered directory before it can become a choice (LIFECYCLE-5.1). */
export async function checkedPlace(deps: LaunchLocationDeps, folder: string, machine?: MachineInfo): Promise<LaunchPlace> {
	const { locations } = await deps.listLocations({ scope: machineScope(machine), folders: [folder] });
	if (locations.length === 0) {
		throw new Error(vscode.l10n.t("Could not read folder {0}.", folder));
	}
	const exact = locations.find(row => machine ? row.path === folder : isEqualPath(row.path, folder));
	return {
		folder, label: exact?.label ?? folder, machine, kind: exact?.kind ?? 'folder',
		canCreateWorktree: locations.some(row => row.kind !== 'folder')
	};
}

/** Change Location starts with the selected machine's directories. Back from a substep keeps its selection (LIFECYCLE-5.1). */
export async function chooseWorkingLocation(deps: LaunchLocationDeps, flow: Flow, current?: LaunchPlace): Promise<LaunchPlace | typeof BACK | undefined> {
	const host = deps.hostMachineId();
	let machine = current?.machine;
	const states = new Map<string, DirectoryChoices>();
	for (;;) {
		const id = machine?.machine_id ?? host;
		let choices = states.get(id);
		if (!choices) {
			choices = new DirectoryChoices(deps, machine, current?.machine?.machine_id === machine?.machine_id ? current : undefined);
			states.set(id, choices);
		}
		const chosen = await choices.pick(flow);
		if (chosen !== CHANGE_MACHINE) { return chosen; }
		const next = await chooseMachine(deps, flow, machine);
		if (!next) { return undefined; }
		if (next !== BACK) { machine = next.machine; }
	}
}

const CHANGE_MACHINE = Symbol('change machine');
const locationTitle = () => vscode.l10n.t("New Agent · Working Location");

type DirectoryRow = vscode.QuickPickItem & {
	readonly place?: LaunchPlace;
	readonly folder?: WorkspaceFolderInfo;
	readonly action?: 'add' | 'enter' | 'machine';
};

/** The directory step owns its focus, validated entries, and branch drafts for one machine. */
class DirectoryChoices {
	private readonly entered = new Map<string, LaunchPlace>();
	private readonly branches = new Map<string, string>();
	private readonly recents: readonly string[];
	private remote?: Promise<readonly LocationInfo[]>;
	private focused?: string;
	private pathDraft: string;

	constructor(private readonly deps: LaunchLocationDeps, private readonly machine?: MachineInfo, current?: LaunchPlace) {
		this.recents = deps.recentLocations?.(machine?.machine_id ?? deps.hostMachineId()) ?? [];
		this.focused = current?.folder ?? this.recents[0];
		this.pathDraft = current?.folder ?? '';
		if (current) {
			this.entered.set(current.folder, current);
			if (current.worktree) { this.branches.set(current.folder, current.worktree); }
		}
	}

	async pick(flow: Flow): Promise<LaunchPlace | typeof CHANGE_MACHINE | typeof BACK | undefined> {
		const worktree = { iconPath: new vscode.ThemeIcon('git-branch'), tooltip: vscode.l10n.t("New Worktree...") };
		const remove = removeFolderButton();
		for (;;) {
			const picked = await this.directoryStep(flow, worktree, remove);
			if (!picked || picked === BACK) { return picked; }
			const { item, button } = picked;
			if (item.action === 'machine') { return CHANGE_MACHINE; }
			if (item.action === 'add') {
				const added = await flow.aside(() => addFolder(this.deps.locations));
				if (added) { this.focused = added.path; }
			} else if (item.action === 'enter') {
				const place = await this.enterPath(flow);
				if (place === undefined) { return undefined; }
				if (place !== BACK) {
					this.entered.set(place.folder, place);
					this.focused = place.folder;
				}
			} else if (item.place) {
				this.focused = item.place.folder;
				const folder = item.folder;
				if (folder && button === remove) {
					await flow.aside(() => removeWorkspaceFolder(this.deps.locations, folder));
				} else if (button === worktree) {
					const branch = await this.askBranch(flow, item.place.folder);
					if (branch === BACK) { continue; }
					return branch === undefined ? undefined : { ...item.place, worktree: branch };
				} else {
					return item.place;
				}
			}
		}
	}

	private directoryStep(flow: Flow, worktree: vscode.QuickInputButton, remove: vscode.QuickInputButton) {
		const placeholder = vscode.l10n.t("Select a working location");
		const { locations } = this.deps;
		const machine = this.machine;
		const rows = (remote: readonly LocationInfo[] = []): DirectoryRow[] => {
			const catalog = locations.snapshot();
			const places = new Map<string, DirectoryRow>();
			const add = (place: LaunchPlace, row?: vscode.QuickPickItem, folder?: WorkspaceFolderInfo) => {
				if (places.has(place.folder)) { return; }
				const icon = place.kind === 'main' ? 'repo' : place.kind === 'worktree' ? 'worktree' : 'folder';
				places.set(place.folder, {
					...(row ?? {
						label: plainText(place.label), description: place.label === place.folder ? undefined : plainText(place.folder),
						iconPath: new vscode.ThemeIcon(icon)
					}),
					place, folder, buttons: [...(place.canCreateWorktree ? [worktree] : []), ...(folder ? [remove] : [])]
				});
			};
			if (!machine) {
				for (const location of catalog.locations) {
					const folder = catalog.folders.length > 1 ? catalog.folders.find(folder => folder.uri === location.uri) : undefined;
					add(workspacePlace(location, catalog), locationRow(location), folder);
				}
			}
			for (const place of this.entered.values()) { add({ ...place, worktree: undefined }); }
			for (const row of remote) {
				add({ folder: row.path, label: row.label, kind: row.kind, machine, canCreateWorktree: row.kind !== 'folder' });
			}
			for (const folder of this.recents) { add({ folder, label: folder, kind: 'folder', machine, canCreateWorktree: false }); }
			return [
				...places.values(),
				...(places.size ? [{ label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
				{ label: vscode.l10n.t("Change Machine..."), iconPath: new vscode.ThemeIcon('globe'), action: 'machine' },
				...(machine ? [] : [{ ...addFolderItem(), action: 'add' } as const]),
				{ label: vscode.l10n.t("Enter Path..."), iconPath: new vscode.ThemeIcon('edit'), action: 'enter' }
			];
		};
		const activeRow = (items: readonly DirectoryRow[], from?: DirectoryRow) => {
			const folder = from?.place?.folder ?? this.focused;
			const action = from?.action;
			return (action && items.find(item => item.action === action))
				|| (folder !== undefined && (items.find(item => item.place?.folder === folder)
					?? (!machine && items.find(item => item.place && isEqualPath(item.place.folder, folder)))))
				|| items.find(item => item.place) || items.find(item => item.action === 'enter');
		};
		const items = rows();
		return flow.pick<DirectoryRow>({
			title: machine ? `${locationTitle()} · ${plainText(machine.name)}` : locationTitle(),
			placeholder, items, active: activeRow(items), back: true, matchOnDescription: true,
			busy: machine !== undefined || locations.snapshot().pending,
			accepts: row => row.action !== undefined || row.place !== undefined,
			live: picker => {
				let active = true;
				const publish = (items: readonly DirectoryRow[], preserveFocus: boolean) => {
					const focused = preserveFocus ? picker.activeItems[0] : undefined;
					const next = activeRow(items, focused);
					picker.items = items;
					if (next) { picker.activeItems = [next]; }
				};
				if (!machine) {
					return locations.onDidChange(() => {
						publish(rows(), true);
						picker.busy = locations.snapshot().pending;
					});
				}
				const remote = this.remote ??= Promise.resolve().then(() => this.deps.listLocations({ scope: machineScope(machine), folders: [] }))
					.then(result => result.locations);
				void remote.then(found => {
					if (!active) { return; }
					publish(rows(found), false);
					picker.busy = false;
				}, error => {
					if (this.remote === remote) { this.remote = undefined; }
					if (!active) { return; }
					picker.placeholder = plainText(messageOf(error));
					picker.busy = false;
				});
				return { dispose: () => { active = false; } };
			}
		});
	}

	private async enterPath(flow: Flow): Promise<LaunchPlace | typeof BACK | undefined> {
		let checked: LaunchPlace | undefined;
		let request = 0;
		const typed = await flow.text({ title: locationTitle(), value: this.pathDraft, pristine: true,
			placeholder: vscode.l10n.t("Enter a path."), back: true,
			validate: value => {
				this.pathDraft = value;
				if (!value.trim()) { return vscode.l10n.t("Enter a path."); }
				const posix = value.startsWith('/');
				const windows = /^[a-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]/i.test(value);
				const absolute = this.machine ? posix || windows : process.platform === 'win32' ? windows : posix;
				return absolute ? undefined : vscode.l10n.t("Enter an absolute path.");
			},
			check: async value => {
				const id = ++request;
				const place = await checkedPlace(this.deps, value, this.machine);
				if (id === request) { checked = place; }
				return {};
			}
		});
		return typeof typed === 'string' ? checked : typed;
	}

	/** The runtime creates the branch from the selected folder's HEAD when the person accepts a CLI (WORKTREES-5.1). */
	private async askBranch(flow: Flow, folder: string): Promise<string | typeof BACK | undefined> {
		const branch = await flow.text({
			title: vscode.l10n.t("New Agent · New Worktree"), value: this.branches.get(folder) ?? '',
			placeholder: vscode.l10n.t("Branch name"), back: true, prompt: vscode.l10n.t("Starts from {0}", 'HEAD'),
			validate: value => {
				this.branches.set(folder, value);
				return value.trim() ? undefined : vscode.l10n.t("Enter a branch name.");
			}
		});
		return typeof branch === 'string' ? branch.trim() : branch;
	}
}

function chooseMachine(deps: LaunchLocationDeps, flow: Flow, current?: MachineInfo) {
	const host = deps.hostMachineId();
	const machines = deps.machines();
	const local = machines.find(machine => machine.machine_id === host);
	const items = [
		{ label: vscode.l10n.t("This machine"), description: local && plainText(local.name), iconPath: new vscode.ThemeIcon('device-desktop'), id: host, machine: undefined },
		...machines.filter(machine => machine.machine_id !== host).map(machine => ({
			label: plainText(machine.name), id: machine.machine_id, machine, iconPath: new vscode.ThemeIcon('globe'),
			description: machine.selector === machine.name ? undefined : plainText(machine.selector),
			detail: machine.state === 'ssh_interaction_required' ? vscode.l10n.t("Needs SSH login") : machine.state === 'unreachable' ? vscode.l10n.t("Unavailable") : undefined
		}))
	];
	return flow.pick({ title: vscode.l10n.t("{0} · {1}", vscode.l10n.t("New Agent"), vscode.l10n.t("Machine")),
		items, active: items.find(item => item.id === (current?.machine_id ?? host)), back: true, matchOnDescription: true
	}).then(picked => picked && picked !== BACK ? picked.item : picked);
}

/** What an item stands for, whatever its step: a folder's row by the folder - whether it opens a step or chooses at once - else its location. */
function keyOf(item: Item): string | undefined {
	return item.folder ? `folder:${item.folder.uri}` : item.location && `location:${item.location.id}`;
}

/** The locations of `folder`, main checkout first, then the folder's opened location (WORKTREES-1.2). */
function folderItems(catalog: Catalog, folder: WorkspaceFolderInfo): Item[] {
	return inStepOrder(locationsIn(catalog, folder), folder).map(locationRow);
}

/**
 * The first step (CLIS-4.1). In a window of several folders, the folders, as Change Working Location lists them - by name, the
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
 * The location Show Agent Command Line shows, the person's choice (CLIS-4.1): native steps by folder, as Change Working Location
 * has them - a folder's own step titled with it, Back returning to the folders at it. Null where the person ends the flow.
 */
export async function chooseLaunchLocation(locations: Locations, log: LogPort): Promise<Location | null> {
	// A location catalog opened reads Git again where needed; its items follow (WORKTREES-1.3)
	locations.refresh().catch(err => log.event(`Could not refresh the working locations: ${messageOf(err)}`));
	const title = vscode.l10n.t("Show Agent Command Line");
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
