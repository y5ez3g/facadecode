/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { isEqualPath } from '../../base/files';
import type { AgentRef, DaemonOperations, DaemonTopics } from '../../base/frameworkProtocol';
import { normalizeName } from '../../core/names';
import type { LocationId, LocationPort, RunId } from '../../core/ports';
import { COMMANDS } from '../catalog';
import { cliDisplayName, cliIcon, openSettingsLabel, plainText, reasonOf } from '../presentation';
import { checkedPlace, chooseWorkingLocation, machineScope, workspacePlace, type LaunchPlace } from './launchLocation';
import { changeNameItem, defaultLocation } from './newAgent';
import { matchesCliSearch } from './search';
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
type LaunchStart = LocationId | { readonly machineId: string; readonly folder: string };

export interface FrameworkPickerDeps {
	readonly media: vscode.Uri;
	readonly locations: LocationPort;
	readonly hostMachineId: () => string;
	readonly machines: () => readonly MachineInfo[];
	readonly listAgents: () => Promise<AgentListResult>;
	readonly listLocations: (args: LocationListArgs) => Promise<LocationListResult>;
	readonly recentLocations?: (machineId: string) => readonly string[];
	readonly listClis: (args: CliListArgs) => Promise<CliListResult>;
	readonly listResumes: (args: ResumeListArgs) => Promise<ResumeListResult>;
	readonly start: (args: StartArgs) => Promise<RunId>;
	readonly stop: (entry: AgentListEntry) => Promise<void>;
	readonly resume: (candidate: ResumeCandidate) => Promise<RunId>;
	readonly select: (run: RunId) => void;
	readonly notifyError: (error: unknown) => void;
	readonly icons: (cli: string) => string;
}

/** Orchestrator-backed commands use the same public candidates as Shell (RULES-6.2, 6.5). */
export function createFrameworkPickers(deps: FrameworkPickerDeps): {
	readonly newAgent: (startAt?: LaunchStart) => Promise<void>;
	readonly stopAgent: () => Promise<void>;
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
		stopAgent: () => run(flow => pickRunningAgent(deps, flow, {
			title: vscode.l10n.t("Stop Agent"),
			empty: vscode.l10n.t("No running agents to stop"),
			act: async entry => {
				try {
					await deps.stop(entry);
				} catch (error) {
					throw new Error(vscode.l10n.t("Could not stop {0}: {1}", entry.address, reasonOf(error)));
				}
			}
		})),
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
function pickLoaded<T extends vscode.QuickPickItem>(flow: Flow, deps: FrameworkPickerDeps, options: {
	readonly title: string;
	readonly placeholder: string;
	readonly load: () => Promise<LoadedRows<T>>;
	readonly accepts?: (row: T) => boolean;
	readonly back?: boolean;
	readonly matchesHidden?: (row: T, query: string) => boolean;
}) {
	return flow.pick<T>({
		title: options.title, placeholder: options.placeholder, items: [], busy: true,
		matchOnDescription: true, accepts: options.accepts, back: options.back,
		live: picker => {
			let open = true;
			let rows: readonly T[] = [];
			const matchesHidden = options.matchesHidden;
			const showRows = (query: string) => {
				picker.items = matchesHidden ? rows.map(row => matchesHidden(row, query) ? { ...row, alwaysShow: true } : row) : rows;
			};
			const search = matchesHidden && picker.onDidChangeValue(showRows);
			void Promise.resolve().then(() => open ? options.load() : undefined).then(found => {
				if (!open || !found) { return; }
				rows = found.items;
				showRows(picker.value);
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
			return { dispose: () => { open = false; search?.dispose(); } };
		}
	});
}

function rowText(...parts: readonly (string | undefined)[]): string {
	return plainText(parts.filter(Boolean).join(' · ').replace(/\r?\n/g, ' '));
}

function exactReferenceSearch(ref: AgentRef): string {
	const machine = ref.machine_id.replace(/-/gu, '');
	return `${ref.agent_id}@${ref.machine_id} #${ref.agent_id}@id:${machine}`;
}

function matchesAgentRow(row: vscode.QuickPickItem & { readonly cli: string; readonly searchText: string }, query: string): boolean {
	return matchesCliSearch(query, row.cli, cliDisplayName(row.cli), row, row.searchText);
}

/** Stop selects a running Managed Agent by its original Framework reference (LIFECYCLE-5.3). */
async function pickRunningAgent(deps: FrameworkPickerDeps, flow: Flow, action: {
	readonly title: string;
	readonly empty: string;
	readonly act: (entry: AgentListEntry) => Promise<void>;
}): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: action.title,
		placeholder: vscode.l10n.t("Search by name, CLI, title, location, or ID"),
		matchesHidden: matchesAgentRow,
		load: async () => {
			const { agents } = await deps.listAgents();
			const items = agents.filter(agent => agent.type === 'managed').map(agent => {
				const name = agent.name.trim();
				return {
					label: rowText(name || agent.address),
					description: rowText(name ? agent.address : undefined, agent.folder),
					iconPath: cliIcon(deps.media, deps.icons(agent.cli)),
					cli: agent.cli,
					searchText: [exactReferenceSearch(agent.reference), agent.title, agent.session_name].join(' '),
					agent
				};
			});
			return { items, placeholder: items.length ? undefined : action.empty };
		}
	});
	if (picked && picked !== BACK) {
		flow.close();
		await action.act(picked.item.agent);
	}
}

function resumeKey(candidate: ResumeCandidate): string {
	const ref = candidate.target.kind === 'agent' ? candidate.target.reference : undefined;
	return ref ? JSON.stringify([ref.machine_id, ref.agent_id]) : JSON.stringify([candidate.machine_id, candidate.cli, candidate.session]);
}

async function resumeAgent(deps: FrameworkPickerDeps, flow: Flow): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: vscode.l10n.t("Resume Agent"),
		placeholder: vscode.l10n.t("Search by name, CLI, title, location, or ID"),
		matchesHidden: matchesAgentRow,
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
				const name = candidate.name?.trim();
				const title = candidate.title?.trim();
				const reference = target.kind === 'agent'
					? `${target.reference.agent_id}@${selector ?? target.reference.machine_id.slice(0, 8)}`
					: `${target.cli}:${candidate.session_selector ?? target.session.slice(0, 8)}`;
				const exact = target.kind === 'agent' ? exactReferenceSearch(target.reference) : `${target.cli}:${target.session}`;
				return [{
					label: rowText(name || title || vscode.l10n.t("Untitled session")),
					description: rowText(name && title !== name ? title : undefined, candidate.folder, reference),
					iconPath: cliIcon(deps.media, deps.icons(candidate.cli)),
					cli: candidate.cli,
					searchText: [exact, candidate.session, candidate.session_name].join(' '),
					candidate
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

async function initialPlace(deps: FrameworkPickerDeps, startAt: LaunchStart | undefined): Promise<LaunchPlace | undefined> {
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

function cliRows(deps: FrameworkPickerDeps, place: LaunchPlace | undefined, name: string, result?: CliListResult, problem?: string): LoadedRows<CliRow> {
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

async function newAgent(deps: FrameworkPickerDeps, flow: Flow, startAt?: LaunchStart): Promise<void> {
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
