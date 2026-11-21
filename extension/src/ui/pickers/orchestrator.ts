/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { DaemonOperations, DaemonTopics } from '../../base/coreProtocol';
import { normalizeName } from '../../core/names';
import type { Location, LocationId, LocationPort, RunId } from '../../core/ports';
import { COMMANDS } from '../catalog';
import { cliIcon, openSettingsLabel, plainText } from '../presentation';
import { askLaunchBranch, chooseWorkspaceLocation, launchWorktreeButton } from './launchLocation';
import { changeLocationItem, changeNameItem, defaultLocation } from './newAgent';
import { BACK, Flow } from './stepping';

type AgentListResult = DaemonOperations['agent.list']['result'];
type AgentListEntry = AgentListResult['agents'][number];
type CliListArgs = DaemonOperations['cli.list']['args'];
type CliListResult = DaemonOperations['cli.list']['result'];
type CliInfo = CliListResult['clis'][number];
type LocationListArgs = DaemonOperations['location.list']['args'];
type LocationListResult = DaemonOperations['location.list']['result'];
type ResumeListArgs = DaemonOperations['agent.resume_list']['args'];
type ResumeListResult = DaemonOperations['agent.resume_list']['result'];
type ResumeCandidate = ResumeListResult['items'][number];
type MachineInfo = DaemonTopics['machines']['snapshot'][number];
type StartArgs = DaemonOperations['agent.start']['args'];

export interface RustPickerDeps {
	readonly media: vscode.Uri;
	readonly locations: LocationPort;
	readonly hostMachineId: () => string;
	readonly machines: () => readonly MachineInfo[];
	readonly listAgents: () => Promise<AgentListResult>;
	readonly listLocations: (args: LocationListArgs) => Promise<LocationListResult>;
	readonly listClis: (args: CliListArgs) => Promise<CliListResult>;
	readonly listResumes: (args: ResumeListArgs) => Promise<ResumeListResult>;
	readonly start: (args: StartArgs) => Promise<RunId>;
	readonly open: (entry: AgentListEntry) => Promise<RunId>;
	readonly resume: (candidate: ResumeCandidate) => Promise<RunId>;
	readonly select: (run: RunId) => void;
	readonly notifyError: (error: unknown) => void;
	readonly icons: (cli: string) => string;
}

/** Orchestrator-backed commands use the same public candidates as Shell (RULES-6.2, 6.5). */
export function createRustPickers(deps: RustPickerDeps): {
	readonly newAgent: (startAt?: LocationId) => Promise<void>;
	readonly goToAgent: () => Promise<void>;
	readonly resumeAgent: () => Promise<void>;
} {
	const run = async (command: (flow: Flow) => Promise<void>) => {
		const flow = new Flow();
		try {
			await command(flow);
		} catch (error) {
			deps.notifyError(error);
		} finally {
			flow.close();
		}
	};
	return {
		newAgent: startAt => run(flow => newAgent(deps, flow, startAt)),
		goToAgent: () => run(flow => goToAgent(deps, flow)),
		resumeAgent: () => run(flow => resumeAgent(deps, flow))
	};
}

interface LoadedRows<T> {
	readonly items: readonly T[];
	readonly active?: T;
	readonly title?: string;
	readonly placeholder?: string;
}

/** Shows the native picker while its request is pending, and ignores answers after it is dismissed. */
function pickLoaded<T extends vscode.QuickPickItem>(flow: Flow, deps: RustPickerDeps, options: {
	readonly title: string;
	readonly placeholder: string;
	readonly load: () => Promise<LoadedRows<T>>;
	readonly accepts?: (row: T) => boolean;
	readonly back?: boolean;
}) {
	return flow.pick<T>({
		title: options.title, placeholder: options.placeholder, items: [], busy: true,
		matchOnDescription: true, accepts: options.accepts, back: options.back,
		live: picker => {
			let open = true;
			void Promise.resolve().then(() => open ? options.load() : undefined).then(found => {
				if (!open || !found) { return; }
				picker.items = found.items;
				if (found.active) { picker.activeItems = [found.active]; }
				picker.title = found.title ?? options.title;
				picker.placeholder = found.placeholder ?? options.placeholder;
				picker.busy = false;
			}, error => {
				if (open) {
					if (options.back) { picker.busy = false; } else { flow.close(); }
					deps.notifyError(error);
				}
			});
			return { dispose: () => { open = false; } };
		}
	});
}

function rowText(...parts: readonly (string | undefined)[]): string {
	return plainText(parts.filter(Boolean).join(' · ').replace(/\r?\n/g, ' '));
}

async function goToAgent(deps: RustPickerDeps, flow: Flow): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: vscode.l10n.t("Go to Agent"),
		placeholder: vscode.l10n.t("Search by name, CLI, title, location, or ID"),
		load: async () => {
			const { agents } = await deps.listAgents();
			const items = agents.filter(agent => agent.type === 'managed').map(agent => ({
				label: rowText(agent.name || agent.address),
				description: rowText(agent.name ? agent.address : undefined, agent.cli, agent.folder, agent.title),
				iconPath: cliIcon(deps.media, deps.icons(agent.cli)), agent
			}));
			return { items, placeholder: items.length ? undefined : vscode.l10n.t("No running agents to attach to") };
		}
	});
	if (picked && picked !== BACK) {
		flow.close();
		deps.select(await deps.open(picked.item.agent));
	}
}

function resumeKey(candidate: ResumeCandidate): string {
	const ref = candidate.target.kind === 'agent' ? candidate.target.reference : undefined;
	return ref ? JSON.stringify([ref.machine_id, ref.agent_id]) : JSON.stringify([candidate.machine_id, candidate.cli, candidate.session]);
}

async function resumeAgent(deps: RustPickerDeps, flow: Flow): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: vscode.l10n.t("Resume Agent"),
		placeholder: vscode.l10n.t("Search by title, name, CLI, or location"),
		load: async () => {
			const folders = deps.locations.snapshot().folders;
			// With no workspace folder, the host resolves its default directory.
			const queries = folders.length ? folders.map(({ path }) => ({ folder: path })) : [{}];
			const results = await Promise.all(queries.map(query => deps.listResumes({ ...query, scope: { kind: 'local' }, folder_scope: 'cwd' })));
			const seen = new Set<string>();
			const timeOf = (candidate: ResumeCandidate) => candidate.at === undefined ? -Infinity : Date.parse(candidate.at);
			const candidates = results.flatMap(({ items, machines }) => items.map(candidate => ({
				candidate, selector: machines.find(machine => machine.machine_id === candidate.machine_id)?.selector
			})));
			const items = candidates.sort((a, b) => timeOf(b.candidate) - timeOf(a.candidate)).flatMap(({ candidate, selector }) => {
				const { target } = candidate;
				if (target.kind !== 'agent' && target.kind !== 'session') { return []; }
				const key = resumeKey(candidate);
				if (seen.has(key)) { return []; }
				seen.add(key);
				const reference = target.kind === 'agent'
					? [target.reference.agent_id, selector].filter(Boolean).join('@')
					: `${target.cli}:${target.session}`;
				return [{
					label: rowText(candidate.title?.trim() || vscode.l10n.t("Untitled session")),
					description: rowText(candidate.cli, candidate.folder, reference),
					iconPath: cliIcon(deps.media, deps.icons(candidate.cli)), candidate
				}];
			});
			return { items, placeholder: items.length ? undefined : vscode.l10n.t("No agents or saved sessions to resume") };
		}
	});
	if (picked && picked !== BACK) {
		flow.close();
		deps.select(await deps.resume(picked.item.candidate));
	}
}

interface LaunchPlace {
	readonly folder: string;
	readonly label: string;
	readonly machine?: MachineInfo;
	readonly local?: Location;
	readonly worktree?: string;
}

function localPlace(location: Location, worktree?: string): LaunchPlace {
	return { folder: location.path, label: location.label, local: location, worktree };
}

function initialLocation(locations: LocationPort, startAt: LocationId | undefined): Location | undefined {
	const catalog = locations.snapshot();
	return catalog.locations.find(location => location.id === startAt)
		?? catalog.locations.find(location => location.uri === catalog.folders[0]?.uri)
		?? defaultLocation(catalog, undefined);
}

type CliRow = vscode.QuickPickItem & { readonly does?: 'start' | 'location' | 'name' | 'openFolder' | 'settings'; readonly cli?: CliInfo };

function cliRows(deps: RustPickerDeps, place: LaunchPlace | undefined, name: string, result?: CliListResult): LoadedRows<CliRow> {
	const title = vscode.l10n.t("New Agent");
	const options: CliRow = { label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator };
	if (!place || !result) {
		return { placeholder: vscode.l10n.t("Open a folder to continue"), items: [
			{ label: vscode.l10n.t("Open Folder..."), detail: vscode.l10n.t("A workspace folder is required to run agents."), iconPath: new vscode.ThemeIcon('folder-opened'), does: 'openFolder' },
			options, changeLocationItem()
		] };
	}
	const where = place.machine ? `${place.machine.name} · ${place.label}` : place.label;
	const { worktree } = place;
	const destination = worktree ? vscode.l10n.t("New worktree {0} from {1}", worktree, where) : where;
	const available = result.clis.filter(cli => cli.available);
	const unavailable = result.clis.filter(cli => !cli.available);
	const settings: CliRow = {
		label: place.machine ? vscode.l10n.t("Unavailable") : openSettingsLabel(),
		detail: plainText(result.settings_problem ?? vscode.l10n.t("Install a supported CLI in this environment, or configure its path.")),
		iconPath: new vscode.ThemeIcon('gear'),
		does: place.machine ? undefined : 'settings'
	};
	return {
		title: [title, name, worktree ? vscode.l10n.t("{0} (new)", worktree) : where].filter(Boolean).join(' · '),
		items: [
			...available.map((cli): CliRow => ({ label: plainText(cli.display_name), iconPath: cliIcon(deps.media, deps.icons(cli.cli)), does: 'start', cli })),
			...(!available.length || result.settings_problem ? [settings] : []),
			...(unavailable.length ? [{ label: vscode.l10n.t("Unavailable"), kind: vscode.QuickPickItemKind.Separator }] : []),
			...unavailable.map((cli): CliRow => ({ label: plainText(cli.display_name),
				detail: plainText(cli.problem ?? (cli.not_installed ? vscode.l10n.t("Not installed") : vscode.l10n.t("Unavailable"))),
				iconPath: cliIcon(deps.media, deps.icons(cli.cli)), does: place.machine ? undefined : 'settings' })),
			options, changeLocationItem(destination), changeNameItem(name)
		]
	};
}

async function newAgent(deps: RustPickerDeps, flow: Flow, startAt?: LocationId): Promise<void> {
	let place: LaunchPlace | undefined;
	let name = '';
	let loaded = false;
	let clis: { readonly machine?: string; readonly folder: string; readonly result: CliListResult } | undefined;
	for (;;) {
		const choice = await pickLoaded<CliRow>(flow, deps, {
			title: vscode.l10n.t("New Agent"), placeholder: vscode.l10n.t("Select a CLI"), accepts: row => row.does !== undefined,
			load: async () => {
				if (!loaded) {
					await deps.locations.refresh();
					const local = initialLocation(deps.locations, startAt);
					place = local && localPlace(local);
					loaded = true;
				}
				const machine = place?.machine?.selector;
				if (place && (!clis || clis.machine !== machine || clis.folder !== place.folder)) {
					const folder = place.folder;
					clis = { machine, folder, result: await deps.listClis({ folder, scope: machine ? { kind: 'machine', machine } : undefined }) };
				}
				return cliRows(deps, place, name, clis?.result);
			}
		});
		if (!choice || choice === BACK) { return; }
		const picked = choice.item;
		if (picked.does === 'start' && place && picked.cli) {
			flow.close();
			deps.select(await deps.start({
				cli: picked.cli.cli, folder: place.folder, size: { cols: 80, rows: 24 },
				...(place.machine ? { scope: { kind: 'machine', machine: place.machine.selector } } : {}),
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
			}
		} else if (picked.does === 'name') {
			const typed = await flow.text({ title: vscode.l10n.t("New Agent · Change Name"), value: name,
				placeholder: vscode.l10n.t("Leave blank to choose a name automatically"), back: true });
			if (typed === undefined) { return; }
			if (typed !== BACK) { name = normalizeName(typed); }
		}
	}
}

async function chooseWorkingLocation(deps: RustPickerDeps, flow: Flow, current?: LaunchPlace): Promise<LaunchPlace | typeof BACK | undefined> {
	const host = deps.hostMachineId();
	const machines = deps.machines();
	const local = machines.find(machine => machine.machine_id === host);
	const remotes = machines.filter(machine => machine.machine_id !== host);
	const chooseLocal = async (): Promise<LaunchPlace | typeof BACK | undefined> => {
		const location = current?.local ?? initialLocation(deps.locations, undefined);
		const picked = await chooseWorkspaceLocation(flow, deps.locations, location && { location, worktree: current?.worktree });
		return picked && picked !== BACK ? localPlace(picked.location, picked.worktree) : picked;
	};
	if (!remotes.length) { return chooseLocal(); }
	let active = current?.machine?.machine_id ?? host;
	const items = [
		{ label: vscode.l10n.t("This machine"), description: local && plainText(local.name), iconPath: new vscode.ThemeIcon('device-desktop'), id: host, machine: undefined },
		...remotes.map(machine => ({ label: plainText(machine.name), id: machine.machine_id, machine, iconPath: new vscode.ThemeIcon('globe'),
			description: machine.selector === machine.name ? undefined : plainText(machine.selector),
			detail: machine.state === 'ssh_interaction_required' ? vscode.l10n.t("Needs SSH login") : machine.state === 'unreachable' ? vscode.l10n.t("Unavailable") : undefined }))
	];
	for (;;) {
		const picked = await flow.pick({ title: vscode.l10n.t("{0} · {1}", vscode.l10n.t("New Agent"), vscode.l10n.t("Machine")),
			items, active: items.find(item => item.id === active), back: true, matchOnDescription: true });
		if (!picked || picked === BACK) { return picked; }
		const { id, machine } = picked.item;
		active = id;
		const chosen = machine ? await chooseRemoteLocation(deps, flow, machine, current?.machine?.machine_id === id ? current : undefined) : await chooseLocal();
		if (chosen !== BACK) { return chosen; }
	}
}

async function chooseRemoteLocation(deps: RustPickerDeps, flow: Flow, machine: MachineInfo, current?: LaunchPlace): Promise<LaunchPlace | typeof BACK | undefined> {
	type Row = vscode.QuickPickItem & { readonly place?: LaunchPlace };
	const title = vscode.l10n.t("New Agent · Working Location");
	const worktree = launchWorktreeButton();
	const direct: Row = { label: vscode.l10n.t("Enter Path..."), iconPath: new vscode.ThemeIcon('edit') };
	let catalog: Promise<LocationListResult> | undefined;
	let focused = current?.folder;
	let directPath = current?.folder ?? '';
	for (;;) {
		const picked = await pickLoaded<Row>(flow, deps, {
			title, placeholder: vscode.l10n.t("Select a working location"), back: true,
			load: async () => {
				const result = await (catalog ??= deps.listLocations({ scope: { kind: 'machine', machine: machine.selector }, folders: [] }));
				const items: Row[] = result.locations.map(row => ({
					label: plainText(row.label), description: plainText(row.path),
					iconPath: new vscode.ThemeIcon(row.kind === 'main' ? 'repo' : row.kind === 'worktree' ? 'worktree' : 'folder'),
					place: { folder: row.path, label: row.label, machine }, buttons: row.kind === 'folder' ? [] : [worktree]
				}));
				const active = focused === undefined ? items[0] ?? direct : items.find(item => item.place?.folder === focused) ?? direct;
				return { items: [...items, direct], active };
			}
		});
		if (!picked || picked === BACK) { return picked; }
		let place = picked.item.place;
		let createWorktree = picked.button === worktree;
		if (!place) {
			focused = '';
			const typed = await flow.text({ title, value: directPath, placeholder: vscode.l10n.t("Enter a path."), back: true,
				validate: value => value.trim() ? undefined : vscode.l10n.t("Enter a path.") });
			if (typed === undefined) { return undefined; }
			if (typed === BACK) { continue; }
			directPath = typed.trim();
			place = { folder: directPath, label: directPath, machine };
			const choice = await chooseEnteredPath(deps, flow, title, machine.selector, directPath);
			if (choice === undefined) { return undefined; }
			if (choice === BACK) { continue; }
			createWorktree = choice;
		} else {
			focused = place.folder;
		}
		if (!createWorktree) { return place; }
		const branch = await askLaunchBranch(flow, current?.folder === place.folder ? current.worktree : undefined);
		if (branch === BACK) { continue; }
		return branch === undefined ? undefined : { ...place, worktree: branch };
	}
}

/** Ask the same machine about the entered directory before offering a new worktree (WORKTREES-5.1). */
async function chooseEnteredPath(deps: RustPickerDeps, flow: Flow, title: string, machine: string, folder: string): Promise<boolean | typeof BACK | undefined> {
	const picked = await pickLoaded<vscode.QuickPickItem & { readonly worktree: boolean }>(flow, deps, {
		title, placeholder: vscode.l10n.t("Select a working location"), back: true,
		load: async () => {
			const { locations } = await deps.listLocations({ scope: { kind: 'machine', machine }, folders: [folder] });
			const current = { label: plainText(folder), iconPath: new vscode.ThemeIcon('folder'), worktree: false };
			const items = [current];
			if (locations.some(location => location.kind !== 'folder')) {
				items.push({ label: vscode.l10n.t("New Worktree..."), iconPath: new vscode.ThemeIcon('git-branch'), worktree: true });
			}
			return { items, active: current };
		}
	});
	return picked && picked !== BACK ? picked.item.worktree : picked;
}
