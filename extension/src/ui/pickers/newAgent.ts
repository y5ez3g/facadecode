/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { normalizeName, suggestName } from '../../core/names';
import type { Agents, Catalog, CliCatalogPort, CliChoice, CliChoices, HumanPort, LaunchHistoryPort, Location, LocationId, LocationPort, LogPort, RunId, WorktreePort } from '../../core/ports';
import { locationLabel, onePlaceOf } from '../cardView';
import { COMMANDS } from '../catalog';
import { cliIcon, launchFailureText, openSettingsLabel, plainText, reasonOf, reasonText } from '../presentation';
import { chooseLocation, Destination, environmentLabel, type LocationDeps, worktreeSourceLabel } from './location';
import { chooseMachine, chooseRemoteCli, chooseRemoteLocation, type MachineLaunch, type RemoteDestination, type RemoteLaunchRequest } from './machineLaunch';
import { BACK, Flow } from './stepping';

export interface NewAgentDeps {
	/** Closes the agents a worktree deletion takes first (WORKTREES-3.2). */
	readonly agents: Pick<Agents, 'launch' | 'list' | 'close'>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'refresh' | 'onDidChange'>;
	readonly clis: CliCatalogPort;
	readonly worktrees: WorktreePort;
	readonly worktreeAgents?: LocationDeps['worktreeAgents'];
	readonly history: LaunchHistoryPort;
	/** Selects the new card: a person's own launch comes to the front (PANEL-2.1, LIFECYCLE-2.2). */
	readonly select: (run: RunId) => void;
	readonly notifyError: HumanPort['error'];
	readonly log: LogPort;
	readonly media: vscode.Uri;
	readonly suggest?: () => string;
	/** `names` of the settings file, where it has them: what the suggested name is picked from (LIFECYCLE-2.1). */
	readonly names?: () => readonly string[] | undefined;
	/** The window's remote authority, as the local window component sees it: how its environment is named (LIFECYCLE-1.1). */
	readonly remote?: string;
	readonly network?: MachineLaunch;
}

/**
 * Where the person's New Agent starts (LIFECYCLE-1.2): the location of their last launch whose CLI started, while it is still offered;
 * else the first workspace folder's first location. A filter never chooses it.
 */
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

/**
 * The CLIs New Agent offers (LIFECYCLE-1.1): those that can start, the last one used first and the rest in the catalog's order - the
 * built-ins in CLIS-1.1's order - and those whose configuration is invalid, with why. A CLI that is not installed is no problem to show.
 */
export function orderedClis(choices: readonly CliChoice[], last: string | undefined): { readonly available: CliChoice[]; readonly unavailable: CliChoice[] } {
	const available = choices.filter(choice => choice.available);
	const at = available.findIndex(choice => choice.id === last);
	if (at > 0) {
		available.unshift(...available.splice(at, 1));
	}
	return { available, unavailable: choices.filter(choice => !choice.available && !choice.notInstalled) };
}

type Does = 'start' | 'settings' | 'location' | 'name' | 'openFolder';
type Item = vscode.QuickPickItem & { readonly does?: Does; readonly cli?: CliChoice };

export function changeLocationItem(where?: string): vscode.QuickPickItem & { readonly does: 'location' } {
	return {
		label: vscode.l10n.t("Change Working Location..."),
		description: where === undefined ? undefined : plainText(where),
		iconPath: new vscode.ThemeIcon('folder'),
		alwaysShow: true,
		does: 'location'
	};
}

export function changeNameItem(name: string): vscode.QuickPickItem & { readonly does: 'name' } {
	return { label: vscode.l10n.t("Change Name..."), description: plainText(name), iconPath: new vscode.ThemeIcon('edit'), alwaysShow: true, does: 'name' };
}

/**
 * New Agent (LIFECYCLE-1.1–1.3) starts with the window's CLIs. Change Working Location can change the machine
 * as part of choosing the agent's working location. A CLI choice accepts the launch and any proposed worktree.
 * `startAt` is the filtered empty panel's location, while offered (LIFECYCLE-1.2).
 */
export async function newAgent(deps: NewAgentDeps, startAt?: LocationId): Promise<void> {
	const title = vscode.l10n.t("New Agent");
	const flow = new Flow();
	const network = deps.network;
	// None left, or an empty `names`: the box starts blank, and the agent is named by its ID (LIFECYCLE-2.1)
	let name = deps.suggest?.() ?? suggestName(deps.agents.list().map(run => run.name), deps.names?.()) ?? '';
	const catalog = deps.locations.snapshot();
	const found = catalog.folders.length ? (catalog.locations.find(each => each.id === startAt) ?? defaultLocation(catalog, deps.history.last().location)) : undefined;
	let local: Destination | undefined = found ? { location: found } : undefined;
	let remote: RemoteDestination | undefined;
	let retry: { readonly cli: string; readonly problem?: string } | undefined;
	// Opening a location catalog reads Git again where needed; plain folders are there meanwhile (WORKTREES-1.1, 1.3)
	if (catalog.folders.length) {
		deps.locations.refresh().catch(err => deps.log.event(`Could not refresh the working locations: ${messageOf(err)}`));
	}
	for (;;) {
		const picked = remote ? await chooseRemoteCli(flow, deps.media, title, name, remote, retry)
			: local ? await chooseCli(flow, deps, { title, destination: local, name })
				: await chooseOpenFolder(flow, title, network, false);
		if (!picked || picked === BACK) { return; }
		if (picked.does === 'start' && picked.cli) {
			if (remote && network) {
				const { machine, location } = remote;
				const cli = picked.cli;
				const request: RemoteLaunchRequest = { name, cli: cli.id, ...location ? { location } : {} };
				const checked = await flow.checking(() => network.preflight(machine.id, request).then(() => true as const, reasonOf));
				if (checked === undefined) { return; }
				if (checked !== true) {
					retry = { cli: cli.id, problem: checked };
					continue;
				}
				flow.close();
				try {
					deps.select(network.launch(machine.id, request));
				} catch (error) {
					deps.notifyError(launchFailureText(name || cli.displayName, reasonOf(error)), {});
				}
			} else if (local) {
				flow.close();
				start(deps, name, local, picked.cli);
			}
			return;
		}
		if (picked.does === 'openFolder') {
			await openFolder(flow);
			return;
		}
		if (picked.does === 'settings') {
			// The same page as Open Settings everywhere (UX-1.3)
			flow.close();
			await vscode.commands.executeCommand(COMMANDS.openSettings);
			return;
		}
		if (picked.does === 'name') {
			const typed = await flow.text({ title: vscode.l10n.t("New Agent · Change Name"), value: name, placeholder: vscode.l10n.t("Leave blank for an unused name, or its ID"), back: true });
			if (typed === undefined) { return; }
			if (typed !== BACK) {
				name = normalizeName(typed);
				if (retry) { retry = { cli: retry.cli }; }
			}
		} else if (picked.does === 'location') {
			const chosen = await chooseWorkingLocation(flow, deps, title, local, remote);
			if (chosen === undefined) { return; }
			if (chosen !== BACK) {
				if ('machine' in chosen) {
					retry = retry && remote?.machine.id === chosen.machine.id ? { cli: retry.cli } : undefined;
					remote = chosen;
				} else {
					local = chosen;
					remote = undefined;
					retry = undefined;
				}
			}
			local = localDestination(deps.locations.snapshot(), local);
		}
	}
}

/** After a location is removed, fall back to the window's first location (LIFECYCLE-1.3). */
function localDestination(catalog: Catalog, current?: Destination): Destination | undefined {
	if (!catalog.folders.length) { return undefined; }
	if (current && catalog.locations.some(location => location.id === current.location.id)) { return current; }
	const first = defaultLocation(catalog, undefined);
	return first ? { location: first } : undefined;
}

/** Back from the chosen machine's locations returns to the machine list. Only a completed location choice changes the CLI step. */
async function chooseWorkingLocation(flow: Flow, deps: NewAgentDeps, title: string, local?: Destination, remote?: RemoteDestination): Promise<Destination | RemoteDestination | typeof BACK | undefined> {
	const network = deps.network;
	const machines = network?.machines();
	if (network && !machines) { flow.close(); return undefined; }
	const localStep = () => chooseLocalLocation(flow, deps, title, localDestination(deps.locations.snapshot(), local));
	if (!network || !machines?.others.length) {
		return local || remote ? localStep() : BACK;
	}
	let focused = remote?.machine.id ?? machines.local.id;
	for (;;) {
		const machine = await chooseMachine(flow, title, network, focused);
		if (!machine || machine === BACK) { return machine; }
		focused = machine.id;
		const chosen = machine.id === machines.local.id ? await localStep()
			: await chooseRemoteLocation(flow, network, machine, remote?.machine.id === machine.id ? remote.location : undefined);
		if (chosen !== BACK) { return chosen; }
	}
}

async function chooseLocalLocation(flow: Flow, deps: NewAgentDeps, title: string, current?: Destination): Promise<Destination | typeof BACK | undefined> {
	if (current) {
		return chooseLocation(flow, deps, {
			folder: vscode.l10n.t("New Agent · Select Folder"),
			location: vscode.l10n.t("New Agent · Working Location"),
			branch: vscode.l10n.t("New Agent · New Worktree")
		}, current);
	}
	const picked = await chooseOpenFolder(flow, title, undefined, true);
	if (picked === BACK) { return BACK; }
	if (picked) { await openFolder(flow); }
	return undefined;
}

/**
 * Starts the person's agent: its card and terminal come at once, and its card is selected (LIFECYCLE-1.5, PANEL-2.1). A new worktree is
 * made from the source's HEAD as part of that launch (WORKTREES-2.1).
 */
function start(deps: NewAgentDeps, name: string, destination: Destination, cli: CliChoice): void {
	let run: RunId;
	try {
		run = deps.agents.launch({
			name, location: destination.location.id, cli: cli.id, origin: 'human',
			...(destination.worktree ? { worktree: { branch: destination.worktree.branch } } : {})
		});
	} catch (err) {
		deps.notifyError(launchFailureText(name || cli.displayName, reasonOf(err)), {});
		return;
	}
	deps.select(run);
}

/** The picker's CLI step: the item chosen, or none where the person ended the flow. */
async function chooseCli(flow: Flow, deps: NewAgentDeps, at: { readonly title: string; readonly destination: Destination; readonly name: string }): Promise<Item | undefined> {
	const catalog = deps.locations.snapshot();
	const { location, worktree } = at.destination;
	const place = worktree ? vscode.l10n.t("New worktree {0} from {1}", worktree.branch, locationLabel({ ...location, label: worktreeSourceLabel(location) }, catalog)) : locationLabel(location, catalog);
	// A planned worktree is compact in the title; its full source stays in the location row (LIFECYCLE-1.1).
	const titlePlace = worktree ? locationLabel({ ...location, label: vscode.l10n.t("{0} (new)", worktree.branch) }, catalog) : place;
	// The environment only where it is not this machine (LIFECYCLE-1.1): a remote window's, never `Local`
	const where = location.environment === 'local' ? place : `${place} · ${environmentLabel(location.environment, deps.remote)}`;
	const titleWhere = location.environment === 'local' ? titlePlace : `${titlePlace} · ${environmentLabel(location.environment, deps.remote)}`;
	// The current choices stay in sight while the CLIs are filtered or scrolled; the window's one place to work goes without saying
	// (LIFECYCLE-1.1), which Git read later may find to be no such place
	const summaryOf = (now: Catalog) => !worktree && onePlaceOf(now)?.id === location.id
		? vscode.l10n.t("{0} · {1}", at.title, at.name) : vscode.l10n.t("{0} · {1} · {2}", at.title, at.name, titleWhere);
	const settingsButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: openSettingsLabel() };
	/**
	 * A lone plain folder offers no local change. A discovered repository or another Facade machine adds the choice (LIFECYCLE-1.3).
	 */
	const bottomOf = (now: Catalog): Item[] => {
		const inFolder = now.locations.filter(each => !each.within && each.folders.some(folder => folder.uri === location.folders[0]?.uri));
		const changeable = now.folders.length > 1 || inFolder.length > 1 || inFolder.some(each => each.kind === 'checkout') || !!worktree
			|| !!deps.network?.machines()?.others.length;
		return [
			// A labeled line: the editor draws one without a label as all but invisible, and a label right of the item below it
			{ label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator },
			...changeable ? [changeLocationItem(where)] : [],
			changeNameItem(at.name)
		];
	};
	const itemsOf = (choices: CliChoices | Error, now: Catalog): { readonly items: Item[]; readonly active?: Item } => {
		const bottom = bottomOf(now);
		if (choices instanceof Error) {
			const item: Item = { label: openSettingsLabel(), detail: reasonOf(choices), iconPath: new vscode.ThemeIcon('gear'), alwaysShow: true, does: 'settings' };
			return { items: [item, ...bottom], active: item };
		}
		const { available, unavailable } = orderedClis(choices.clis, deps.history.last().cli);
		// An error no CLI stands for - the settings file wrong as a whole - is said by the file (CONFIGURATION-4.1)
		const settings = choices.problems.map((each): Item => ({ label: each.setting, detail: reasonText(each.said, each.problem), iconPath: new vscode.ThemeIcon('gear'), buttons: [settingsButton], does: 'settings' }));
		const items: Item[] = [
			...available.map((cli): Item => ({ label: cli.displayName, iconPath: cliIcon(deps.media, cli.icon ?? cli.id), does: 'start', cli })),
			// No CLI can start here: why, and the way to the settings (LIFECYCLE-1.1, EXPERIENCE-1.4)
			...available.length ? [] : [{ label: openSettingsLabel(), detail: vscode.l10n.t("Install a supported CLI in this environment, or configure its path."), iconPath: new vscode.ThemeIcon('gear'), alwaysShow: true, does: 'settings' as const }],
			...unavailable.length || settings.length ? [{ label: vscode.l10n.t("Unavailable"), kind: vscode.QuickPickItemKind.Separator }] : [],
			...unavailable.map((cli): Item => ({ label: cli.displayName, ...(cli.problem ? { detail: reasonText(cli.said, cli.problem) } : {}), iconPath: cliIcon(deps.media, cli.icon ?? cli.id), buttons: [settingsButton], does: 'settings', cli })),
			...settings,
			...bottom
		];
		return { items, active: items.find(item => item.does === 'start' || item.does === 'settings') };
	};
	const picked = await flow.pick<Item>({
		title: summaryOf(catalog),
		placeholder: vscode.l10n.t("Select a CLI"),
		// Nothing until the CLIs are found: the editor keeps the place of the item it had in focus when the items change, so a
		// Change item shown meanwhile would leave the focus on another CLI than the one preselected, which an Enter then starts
		items: [],
		busy: true,
		// The CLIs of the location's environment, found as the step shows (CLIS-1.1); the step up keeps its place meanwhile. Git metadata
		// read later changes the bottom alone, the item in focus kept, so that an Enter right then takes what the person sees (LIFECYCLE-1.1)
		live: picker => {
			let up = true;
			let found: CliChoices | Error | undefined;
			const show = () => {
				if (up && found) {
					const before = picker.activeItems[0];
					const now = deps.locations.snapshot();
					const { items, active } = itemsOf(found, now);
					picker.title = summaryOf(now);
					const kept = before && items.find(item => item.does === before.does && item.cli?.id === before.cli?.id && item.label === before.label);
					picker.items = items;
					picker.activeItems = kept ? [kept] : active ? [active] : [];
					picker.busy = false;
				}
			};
			deps.clis.list(location).then(choices => { found = choices; show(); }, err => { found = err instanceof Error ? err : new Error(messageOf(err)); show(); });
			const listening = deps.locations.onDidChange(show);
			const machines = deps.network?.onDidChange?.(show);
			return { dispose: () => { up = false; listening.dispose(); machines?.dispose(); } };
		}
	});
	return picked && picked !== BACK ? picked.item : undefined;
}

/** The folder prerequisite also allows changing to another machine from the first step (LIFECYCLE-1.1). */
async function chooseOpenFolder(flow: Flow, title: string, network: MachineLaunch | undefined, back: boolean): Promise<Item | typeof BACK | undefined> {
	const item: Item = { label: vscode.l10n.t("Open Folder..."), detail: vscode.l10n.t("A workspace folder is required to run agents."), iconPath: new vscode.ThemeIcon('folder-opened'), does: 'openFolder' };
	const change = changeLocationItem();
	const itemsOf = (): Item[] => network?.machines()?.others.length
		? [item, { label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator }, change] : [item];
	const picked = await flow.pick<Item>({
		title, placeholder: vscode.l10n.t("Open a folder to continue"), items: itemsOf(), active: item, back,
		live: picker => network?.onDidChange?.(() => {
			const active = picker.activeItems[0];
			const items = itemsOf();
			picker.items = items;
			picker.activeItems = [active && items.includes(active) ? active : item];
		})
	});
	return picked && picked !== BACK ? picked.item : picked;
}

async function openFolder(flow: Flow): Promise<void> {
	flow.close();
	await vscode.commands.executeCommand('vscode.openFolder');
}
