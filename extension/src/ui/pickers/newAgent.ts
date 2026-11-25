/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { isEqualPath } from '../../base/files';
import type { DaemonOperations } from '../../base/frameworkProtocol';
import { normalizeName } from '../../core/names';
import type { Catalog, Location, LocationId, LocationPort, RunId } from '../../core/ports';
import { COMMANDS } from '../catalog';
import { cliIcon, openSettingsLabel, plainText } from '../presentation';
import { checkedPlace, chooseWorkingLocation, machineScope, workspacePlace, type LaunchPlace, type LaunchLocationDeps } from './launchLocation';
import { BACK, Flow, pickLoaded, type LoadedRows } from './stepping';

type CliListArgs = DaemonOperations['cli.list']['args'];
type CliListResult = DaemonOperations['cli.list']['result'];
type CliInfo = CliListResult['clis'][number];
type StartArgs = DaemonOperations['agent.start']['args'];

export type LaunchStart = LocationId | { readonly machineId: string; readonly folder: string };

export interface LaunchPickerDeps extends LaunchLocationDeps {
	readonly media: vscode.Uri;
	readonly locations: LocationPort;
	readonly hostMachineId: () => string;
	readonly listClis: (args: CliListArgs) => Promise<CliListResult>;
	readonly start: (args: StartArgs) => Promise<RunId>;
	readonly select: (run: RunId) => void;
	readonly notifyError: (error: unknown) => void;
	readonly icons: (cli: string) => string;
}

export function defaultLocation(catalog: Catalog, last: LocationId | undefined): Location | undefined {
	const found = last === undefined ? undefined : catalog.locations.find(location => location.id === last);
	// A folder inside a location - a resumed conversation's own - is no launch choice: the location it is inside (WORKTREES-1.2)
	const remembered = found?.within ? catalog.locations.find(location => location.id === found.within) : found;
	if (remembered) {
		return remembered;
	}
	const first = catalog.folders[0];
	return (first && catalog.locations.find(each => each.folders.some(folder => folder.uri === first.uri))) ?? catalog.locations[0];
}

export function changeNameItem(name: string): vscode.QuickPickItem & { readonly does: 'name' } {
	return { label: vscode.l10n.t("Change Name..."), description: plainText(name), iconPath: new vscode.ThemeIcon('edit'), alwaysShow: true, does: 'name' };
}

async function initialPlace(deps: LaunchPickerDeps, startAt: LaunchStart | undefined): Promise<LaunchPlace | undefined> {
	if (typeof startAt === 'object') {
		if (startAt.machineId === deps.hostMachineId()) {
			return checkedPlace(deps, startAt.folder);
		}
		const machine = deps.machines().find(row => row.machine_id === startAt.machineId);
		if (!machine) {
			throw new Error(vscode.l10n.t("The working location {0} is not available in this window.", startAt.folder));
		}
		return checkedPlace(deps, startAt.folder, machine);
	}
	try {
		await deps.locations.refresh();
	} catch (error) {
		deps.notifyError(error);
	}
	const catalog = deps.locations.snapshot();
	const requested = catalog.locations.find(location => location.id === startAt);
	if (requested) { return workspacePlace(requested, catalog); }
	const last = deps.recentLocations?.(deps.hostMachineId())[0];
	if (last !== undefined) {
		const remembered = catalog.locations.find(location => isEqualPath(location.path, last));
		if (remembered) { return workspacePlace(remembered, catalog); }
		try {
			return await checkedPlace(deps, last);
		} catch {
			// A previous successful directory may have moved or been removed.
		}
	}
	const fallback = catalog.locations.find(location => location.uri === catalog.folders[0]?.uri) ?? defaultLocation(catalog, undefined);
	return fallback && workspacePlace(fallback, catalog);
}

type CliRow = vscode.QuickPickItem & { readonly does?: 'start' | 'location' | 'name' | 'openFolder' | 'settings'; readonly cli?: CliInfo };

function cliRows(deps: LaunchPickerDeps, place: LaunchPlace | undefined, name: string, result?: CliListResult, problem?: string): LoadedRows<CliRow> {
	const title = vscode.l10n.t("New Agent");
	const options: CliRow = { label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator };
	const changeLocation = (where?: string): CliRow => ({
		label: vscode.l10n.t("Change Location..."), description: where === undefined ? undefined : plainText(where),
		iconPath: new vscode.ThemeIcon('folder'), alwaysShow: true, does: 'location'
	});
	const changeName = changeNameItem(name || vscode.l10n.t("Auto-assign"));
	if (!place) {
		return { placeholder: vscode.l10n.t("Select a working location"), items: [
			problem === undefined
				? { label: vscode.l10n.t("Open Folder..."), iconPath: new vscode.ThemeIcon('folder-opened'), does: 'openFolder' }
				: { label: vscode.l10n.t("Unavailable"), detail: plainText(problem) },
			options, changeLocation(), changeName
		] };
	}
	const where = place.machine ? `${place.machine.name} · ${place.label}` : place.label;
	const { worktree } = place;
	const destination = worktree ? vscode.l10n.t("New worktree {0} from {1}", worktree, where) : where;
	const heading = [title, name, worktree ? vscode.l10n.t("{0} (new)", worktree) : where].filter(Boolean).join(' · ');
	if (!result) {
		return { title: heading, items: [
			{ label: vscode.l10n.t("Unavailable"), detail: problem === undefined ? undefined : plainText(problem) },
			options, changeLocation(destination), changeName
		] };
	}
	const available = result.clis.filter(cli => cli.available);
	const unavailable = result.clis.filter(cli => !cli.available);
	const settings: CliRow = {
		label: place.machine ? vscode.l10n.t("Unavailable") : openSettingsLabel(),
		detail: plainText(result.settings_problem ?? vscode.l10n.t("Install a supported CLI in this environment, or configure its path.")),
		iconPath: new vscode.ThemeIcon('gear'),
		does: place.machine ? undefined : 'settings'
	};
	return {
		title: heading,
		items: [
			...available.map((cli): CliRow => ({ label: plainText(cli.display_name), iconPath: cliIcon(deps.media, deps.icons(cli.cli)), does: 'start', cli })),
			...(!available.length || result.settings_problem ? [settings] : []),
			...(unavailable.length ? [{ label: vscode.l10n.t("Unavailable"), kind: vscode.QuickPickItemKind.Separator }] : []),
			...unavailable.map((cli): CliRow => ({ label: plainText(cli.display_name),
				detail: plainText(cli.problem ?? (cli.not_installed ? vscode.l10n.t("Not installed") : vscode.l10n.t("Unavailable"))),
				iconPath: cliIcon(deps.media, deps.icons(cli.cli)), does: place.machine ? undefined : 'settings' })),
			options, changeLocation(destination), changeName
		]
	};
}

export async function newAgent(deps: LaunchPickerDeps, flow: Flow, startAt?: LaunchStart): Promise<void> {
	let place: LaunchPlace | undefined;
	let locationProblem: string | undefined;
	let name = '';
	let loaded = false;
	let clis: { readonly machine?: string; readonly folder: string; readonly result: CliListResult } | undefined;
	for (;;) {
		const choice = await pickLoaded<CliRow>(flow, deps, {
			title: vscode.l10n.t("New Agent"), placeholder: vscode.l10n.t("Select a CLI"), accepts: row => row.does !== undefined,
			load: async () => {
				if (!loaded) {
					try {
						place = await initialPlace(deps, startAt);
					} catch (error) {
						locationProblem = messageOf(error);
					}
					loaded = true;
				}
				const machine = place?.machine?.selector;
				if (place && (!clis || clis.machine !== machine || clis.folder !== place.folder)) {
					const folder = place.folder;
					try {
						clis = { machine, folder, result: await deps.listClis({ folder, scope: machineScope(place.machine) }) };
					} catch (error) {
						return cliRows(deps, place, name, undefined, messageOf(error));
					}
				}
				return cliRows(deps, place, name, clis?.result, locationProblem);
			}
		});
		if (!choice || choice === BACK) { return; }
		const picked = choice.item;
		if (picked.does === 'start' && place && picked.cli) {
			flow.close();
			deps.select(await deps.start({
				cli: picked.cli.cli, folder: place.folder, size: { cols: 80, rows: 24 },
				...(place.machine ? { scope: machineScope(place.machine) } : {}),
				...(name ? { name } : {}), ...(place.worktree ? { worktree: place.worktree } : {})
			}));
			return;
		}
		if (picked.does === 'openFolder' || picked.does === 'settings') {
			flow.close();
			await vscode.commands.executeCommand(picked.does === 'settings' ? COMMANDS.openSettings : 'vscode.openFolder');
			return;
		}
		if (picked.does === 'location') {
			const chosen = await chooseWorkingLocation(deps, flow, place);
			if (chosen === undefined) { return; }
			if (chosen !== BACK) {
				place = chosen;
				locationProblem = undefined;
			}
		} else if (picked.does === 'name') {
			const typed = await flow.text({ title: vscode.l10n.t("New Agent · Change Name"), value: name,
				placeholder: vscode.l10n.t("Auto-assign"), back: true });
			if (typed === undefined) { return; }
			if (typed !== BACK) { name = normalizeName(typed); }
		}
	}
}
