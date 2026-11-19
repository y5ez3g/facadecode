/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { WindowRef } from '../../base/coreProtocol';
import type { CliChoice, RunId } from '../../core/ports';
import { cliIcon, plainText, reasonOf } from '../presentation';
import { BACK, Flow } from './stepping';

export interface LaunchMachine {
	readonly id: string;
	readonly name: string;
	readonly unavailable?: 'unavailable' | 'ssh_interaction_required';
}

export interface RemoteLocation {
	readonly label: string;
	readonly cwd: string;
	readonly source?: WindowRef;
}

export interface RemoteLaunchRequest {
	readonly name: string;
	readonly cli: string;
	/** Omitted to use the running machine's login home. */
	readonly location?: RemoteLocation;
}

export interface MachineLaunch {
	readonly onDidChange?: vscode.Event<void>;
	machines(): { readonly local: LaunchMachine; readonly others: readonly LaunchMachine[] } | undefined;
	catalog(machine: string): Promise<{ readonly locations: readonly RemoteLocation[]; readonly clis: readonly CliChoice[] }>;
	preflight(machine: string, request: RemoteLaunchRequest): Promise<void>;
	launch(machine: string, request: RemoteLaunchRequest): RunId;
}

export interface RemoteDestination {
	readonly machine: LaunchMachine;
	readonly location?: RemoteLocation;
	readonly clis: readonly CliChoice[];
}

/** Change Working Location's machine step (LIFECYCLE-1.3). */
export async function chooseMachine(flow: Flow, title: string, network: MachineLaunch, current: string): Promise<LaunchMachine | typeof BACK | undefined> {
	const itemsOf = () => {
		const machines = network.machines();
		return machines ? [machines.local, ...machines.others].map(machine => {
			const local = machine.id === machines.local.id;
			return {
				machine,
				label: local ? vscode.l10n.t("This machine") : plainText(machine.name),
				description: local ? plainText(machine.name) : undefined,
				detail: machine.unavailable === 'ssh_interaction_required' ? vscode.l10n.t("Needs SSH login")
					: machine.unavailable ? vscode.l10n.t("Unavailable") : undefined,
				iconPath: new vscode.ThemeIcon(local ? 'device-desktop' : 'globe')
			};
		}) : [];
	};
	const items = itemsOf();
	const picked = await flow.pick({
		title: vscode.l10n.t("{0} · {1}", title, vscode.l10n.t("Machine")),
		items,
		active: items.find(item => item.machine.id === current) ?? items[0],
		matchOnDescription: true,
		back: true,
		accepts: item => !item.machine.unavailable,
		live: picker => network.onDidChange?.(() => {
			const focused = picker.activeItems[0]?.machine.id ?? current;
			const updated = itemsOf();
			const active = updated.find(item => item.machine.id === focused) ?? updated[0];
			picker.items = updated;
			picker.activeItems = active ? [active] : [];
		})
	});
	return picked && picked !== BACK ? picked.item.machine : picked;
}

type CliItem = vscode.QuickPickItem & { readonly does?: 'start' | 'location' | 'name'; readonly cli?: CliChoice };

/** New Agent's CLI step for a selected remote working location (LIFECYCLE-1.1). */
export async function chooseRemoteCli(flow: Flow, media: vscode.Uri, title: string, name: string, at: RemoteDestination, retry?: { readonly cli: string; readonly problem?: string }): Promise<CliItem | undefined> {
	const { machine, location } = at;
	const items: CliItem[] = at.clis.filter(cli => cli.available).map(cli => ({
		label: plainText(cli.displayName), cli, iconPath: cliIcon(media, cli.icon ?? cli.id), does: 'start',
		...(cli.id === retry?.cli && retry.problem ? { detail: plainText(retry.problem) } : {})
	}));
	const active = items.find(item => item.cli?.id === retry?.cli) ?? items[0];
	if (!active) {
		items.push({ label: vscode.l10n.t("Unavailable"), detail: vscode.l10n.t("Install a supported CLI in this environment, or configure its path.") });
	}
	items.push(
		{ label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator },
		{ label: vscode.l10n.t("Change Working Location..."), description: plainText(location?.cwd ?? '~'), iconPath: new vscode.ThemeIcon('folder'), does: 'location', alwaysShow: true },
		{ label: vscode.l10n.t("Change Name..."), description: plainText(name), iconPath: new vscode.ThemeIcon('edit'), does: 'name', alwaysShow: true }
	);
	const picked = await flow.pick({
		title: vscode.l10n.t("{0} · {1} · {2}", title, name, plainText(`${machine.name} · ${location?.label ?? '~'}`)),
		placeholder: vscode.l10n.t("Select a CLI"),
		items,
		active,
		accepts: item => item.does !== undefined
	});
	return picked && picked !== BACK ? picked.item : undefined;
}

/** The locations offered by the selected machine, including its login home (LIFECYCLE-1.3). */
export async function chooseRemoteLocation(flow: Flow, network: MachineLaunch, machine: LaunchMachine, current?: RemoteLocation): Promise<RemoteDestination | typeof BACK | undefined> {
	type Item = vscode.QuickPickItem & { readonly location?: RemoteLocation; readonly input?: true; readonly unavailable?: true };
	const catalog = network.catalog(machine.id).catch(error => new Error(reasonOf(error)));
	const title = vscode.l10n.t("New Agent · Working Location");
	const home: Item = { label: '~', iconPath: new vscode.ThemeIcon('home') };
	const direct: Item = { label: vscode.l10n.t("Change Working Location..."), iconPath: new vscode.ThemeIcon('edit'), input: true };
	let editing = false;
	for (;;) {
		const picked = await flow.pick<Item>({
			title, placeholder: vscode.l10n.t("Select a working location"),
			items: [], busy: true, matchOnDescription: true, back: true,
			accepts: item => !item.unavailable,
			live: picker => {
				let open = true;
				void catalog.then(found => {
					if (!open) { return; }
					if (found instanceof Error) {
						picker.items = [{ label: vscode.l10n.t("Unavailable"), detail: plainText(found.message), unavailable: true }];
					} else {
						const items: Item[] = found.locations.map(location => ({
							label: plainText(location.label), description: plainText(location.cwd), location, iconPath: new vscode.ThemeIcon('folder')
						}));
						const selected = current && items.find(({ location }) => location?.cwd === current.cwd
							&& location.source?.machine_id === current.source?.machine_id && location.source?.window_id === current.source?.window_id);
						picker.items = [home, ...items, direct];
						picker.activeItems = [editing ? direct : selected ?? (current ? direct : home)];
					}
					picker.busy = false;
				});
				return { dispose: () => { open = false; } };
			}
		});
		if (!picked || picked === BACK) { return picked; }
		const found = await catalog;
		if (found instanceof Error) { return BACK; }
		if (!picked.item.input) { return { machine, clis: found.clis, location: picked.item.location }; }
		const typed = await flow.text({ title, value: current?.cwd ?? '', back: true });
		if (typed === undefined) { return undefined; }
		if (typed === BACK) { editing = true; continue; }
		const cwd = typed.trim();
		return { machine, clis: found.clis, location: cwd ? { label: cwd, cwd } : undefined };
	}
}
