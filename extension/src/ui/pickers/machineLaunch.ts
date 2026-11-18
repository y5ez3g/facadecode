/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { WindowRef } from '../../base/coreProtocol';
import { normalizeName } from '../../core/names';
import type { CliChoice, HumanPort, RunId } from '../../core/ports';
import { cliIcon, launchFailureText, plainText, reasonOf } from '../presentation';
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
	machines(): { readonly local: LaunchMachine; readonly others: readonly LaunchMachine[] } | undefined;
	catalog(machine: string): Promise<{ readonly locations: readonly RemoteLocation[]; readonly clis: readonly CliChoice[] }>;
	preflight(machine: string, request: RemoteLaunchRequest): Promise<void>;
	launch(machine: string, request: RemoteLaunchRequest): RunId;
}

/** Which Facade machine runs the new agent (LIFECYCLE-1.1). */
export async function chooseMachine(flow: Flow, title: string, machines: NonNullable<ReturnType<MachineLaunch['machines']>>, current: string): Promise<LaunchMachine | undefined> {
	const items = [machines.local, ...machines.others].map(machine => {
		const local = machine.id === machines.local.id;
		return {
			machine,
			label: local ? vscode.l10n.t("This machine") : plainText(machine.name),
			description: local ? plainText(machine.name) : undefined,
			detail: machine.unavailable === 'ssh_interaction_required' ? vscode.l10n.t("Needs SSH login")
				: machine.unavailable ? vscode.l10n.t("Unavailable") : undefined,
			iconPath: new vscode.ThemeIcon(local ? 'device-desktop' : 'remote')
		};
	});
	const picked = await flow.pick({
		title: vscode.l10n.t("{0} · {1}", title, vscode.l10n.t("Machine")),
		items,
		active: items.find(item => item.machine.id === current),
		matchOnDescription: true,
		accepts: item => !item.machine.unavailable
	});
	return picked && picked !== BACK ? picked.item.machine : undefined;
}

type CliItem = vscode.QuickPickItem & { readonly action?: 'location' | 'name'; readonly cli?: CliChoice };

/** The CLI and location choices of one running machine, with preflight immediately before launch (LIFECYCLE-1.1). */
export async function launchOnMachine(flow: Flow, deps: {
	readonly network: MachineLaunch;
	readonly media: vscode.Uri;
	readonly notifyError: HumanPort['error'];
	readonly select: (run: RunId) => void;
}, title: string, machine: LaunchMachine, draft: { name: string }): Promise<typeof BACK | undefined> {
	let location: RemoteLocation | undefined;
	let activeCli: string | undefined;
	let problem: string | undefined;
	const catalog = deps.network.catalog(machine.id).catch(error => new Error(reasonOf(error)));
	for (;;) {
		const picked = await flow.pick<CliItem>({
			title: vscode.l10n.t("{0} · {1} · {2}", title, draft.name, plainText(`${machine.name} · ${location?.label ?? '~'}`)),
			placeholder: vscode.l10n.t("Select a CLI"),
			items: [],
			back: true,
			busy: true,
			accepts: item => item.action !== undefined || item.cli !== undefined,
			live: picker => {
				let open = true;
				void catalog.then(found => {
					if (!open) { return; }
					const items: CliItem[] = found instanceof Error ? [{
						label: vscode.l10n.t("Unavailable"), detail: plainText(found.message)
					}] : found.clis.filter(cli => cli.available).map(cli => ({
						label: plainText(cli.displayName), cli, iconPath: cliIcon(deps.media, cli.icon ?? cli.id),
						...(cli.id === activeCli && problem ? { detail: plainText(problem) } : {})
					}));
					const first = items.find(item => item.cli?.id === activeCli) ?? items.find(item => item.cli);
					if (!(found instanceof Error)) {
						if (!items.length) {
							items.push({ label: vscode.l10n.t("Unavailable"), detail: vscode.l10n.t("Install a supported CLI in this environment, or configure its path.") });
						}
						items.push(
							{ label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator },
							{ label: vscode.l10n.t("Change Working Location..."), description: plainText(location?.cwd ?? '~'), iconPath: new vscode.ThemeIcon('folder'), action: 'location', alwaysShow: true },
							{ label: vscode.l10n.t("Change Name..."), description: plainText(draft.name), iconPath: new vscode.ThemeIcon('edit'), action: 'name', alwaysShow: true }
						);
					}
					picker.items = items;
					picker.activeItems = first ? [first] : [];
					picker.busy = false;
				});
				return { dispose: () => { open = false; } };
			}
		});
		if (!picked || picked === BACK) { return picked; }
		const { action, cli } = picked.item;
		if (action === 'location') {
			const found = await catalog;
			if (found instanceof Error) { continue; }
			const chosen = await chooseRemoteLocation(flow, found.locations, location);
			if (!chosen) { return undefined; }
			if (chosen !== BACK) { location = chosen.location; problem = undefined; }
		} else if (action === 'name') {
			const typed = await flow.text({ title: vscode.l10n.t("New Agent · Change Name"), value: draft.name, placeholder: vscode.l10n.t("Leave blank for an unused name, or its ID"), back: true });
			if (typed === undefined) { return undefined; }
			if (typed !== BACK) { draft.name = normalizeName(typed); problem = undefined; }
		} else if (cli) {
			activeCli = cli.id;
			const request: RemoteLaunchRequest = { name: draft.name, cli: cli.id, ...location ? { location } : {} };
			const checked = await flow.checking(() => deps.network.preflight(machine.id, request).then(() => true as const, reasonOf));
			if (checked === undefined) { return undefined; }
			if (checked !== true) { problem = checked; continue; }
			flow.close();
			try {
				deps.select(deps.network.launch(machine.id, request));
			} catch (error) {
				deps.notifyError(launchFailureText(draft.name || cli.displayName, reasonOf(error)), {});
			}
			return undefined;
		}
	}
}

async function chooseRemoteLocation(flow: Flow, locations: readonly RemoteLocation[], current: RemoteLocation | undefined): Promise<{ readonly location?: RemoteLocation } | typeof BACK | undefined> {
	type Item = vscode.QuickPickItem & { readonly location?: RemoteLocation; readonly input?: true };
	const home: Item = { label: '~', iconPath: new vscode.ThemeIcon('home') };
	const direct: Item = { label: vscode.l10n.t("Change Working Location..."), iconPath: new vscode.ThemeIcon('edit'), input: true };
	const items: Item[] = [home, ...locations.map(location => ({
		label: plainText(location.label), description: plainText(location.cwd), location, iconPath: new vscode.ThemeIcon('folder')
	})), direct];
	const picked = await flow.pick({
		title: vscode.l10n.t("New Agent · Working Location"), placeholder: vscode.l10n.t("Select a working location"),
		items, active: current ? items.find(item => item.location === current) ?? direct : home, matchOnDescription: true, back: true
	});
	if (!picked || picked === BACK) { return picked; }
	if (!picked.item.input) { return { location: picked.item.location }; }
	const typed = await flow.text({ title: vscode.l10n.t("New Agent · Working Location"), value: current?.cwd ?? '', back: true });
	if (typed === undefined || typed === BACK) { return typed; }
	const cwd = typed.trim();
	return cwd ? { location: { label: cwd, cwd } } : {};
}
