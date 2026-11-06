/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from '../base/json';
import { messageOf } from '../base/errors';
import type { Catalog } from '../core/ports';
import { ArgumentError } from '../schema/validate';
import { cliOf, Data, defined, isoOf, locationOf, ToolWindow } from './facts';
import type { CliFacts, StartCatalog } from './facts';

export interface WindowSnapshot extends Data {
	readonly window_id: string;
	readonly label: string;
	readonly environment: string;
	readonly folders: readonly Data[];
	readonly locations: readonly Data[];
	readonly clis: readonly Data[];
	readonly counts: { readonly folders: number; readonly locations: number; readonly worktrees: number; readonly agents: number };
	readonly complete: boolean;
}

/** Discover each destination in its own environment, coalescing equal CLI facts without assuming window-wide settings. */
export async function windowSnapshot(options: {
	readonly window: ToolWindow;
	readonly catalog: Catalog;
	readonly clis: StartCatalog;
	readonly yolo: boolean;
	readonly now: () => number;
	readonly agentCount: number;
	readonly location?: string;
	readonly targeted?: boolean;
	readonly details?: boolean;
	readonly logFile?: string;
}): Promise<WindowSnapshot> {
	const { window, catalog } = options;
	// The window's places to work: never a folder inside one, which no picker offers either (WORKTREES-1.2)
	const locations = catalog.locations.filter(each => !each.within && (options.location === undefined || each.id === options.location));
	const folders = options.location === undefined ? catalog.folders : catalog.folders.filter(folder => locations.some(location => location.folders.some(each => each.uri === folder.uri)));
	const choices = new Map<string, { value: Data; locations: string[] }>();
	const problems = new Map<string, { value: Data; locations: string[] }>();
	const scanErrors: Data[] = [];
	if (!options.targeted) {
		// The CLI catalog resolves files/configuration only; it never launches a CLI to discover it.
		for (const location of locations) {
			try {
				const found = await options.clis.list(location, options.details);
				let facts: readonly CliFacts[] = [];
				try { facts = found.launches ?? options.clis.describe(location, options.yolo).launches; } catch { /* Explicitly unknown overrides. */ }
				for (const choice of found.clis) {
					const fact = facts.find(each => each.cli === choice.id);
					const value = defined({ ...cliOf(choice), overrides: { model: fact?.takes?.model ?? 'unknown', effort: fact?.takes?.effort ?? 'unknown' },
						...options.details && fact ? { version: fact.version?.version, message_input: fact.input?.capability, initial_prompt: fact.initialPrompt?.capability } : {} });
					const key = JSON.stringify(value);
					const group = choices.get(key) ?? { value, locations: [] as string[] };
					group.locations.push(location.id); choices.set(key, group);
				}
				for (const problem of found.problems) {
					const value = { setting: problem.setting, problem: problem.problem };
					const key = JSON.stringify(value);
					const group = problems.get(key) ?? { value, locations: [] as string[] };
					group.locations.push(location.id); problems.set(key, group);
				}
			} catch (err) { scanErrors.push({ location_id: location.id, reason: 'cli_scan_failed', message: messageOf(err) }); }
		}
	}
	const scoped = (group: { value: Data; locations: string[] }): Data => ({ ...group.value,
		...group.locations.length === locations.length ? {} : { location_ids: group.locations } });
	return {
		window_id: window.id, label: window.label, environment: window.environment,
		observed_at: isoOf(options.now()),
		folders: folders.map(folder => ({ name: folder.name, uri: folder.uri, path: folder.path })),
		locations: locations.map(location => ({ ...locationOf(location, true), folder_uris: location.folders.map(folder => folder.uri) })),
		clis: [...choices.values()].map(scoped),
		...options.targeted || !locations.length ? { clis_queried: false } : {},
		problems: [...problems.values()].map(scoped),
		...scanErrors.length ? { unavailable_locations: scanErrors } : {},
		counts: { folders: folders.length, locations: locations.length, worktrees: locations.filter(each => each.kind === 'checkout' && each.isMain === false).length, agents: options.agentCount },
		complete: !catalog.pending && !scanErrors.length,
		...options.logFile ? { history_log: { path: options.logFile, environment: window.environment } } : {}
	};
}

/** A remote catalog is validated before using its identifiers/counts; malformed is unavailable, never silently empty. */
export function isWindowSnapshot(value: unknown, id: string): value is WindowSnapshot {
	if (!isJsonObject(value) || value.window_id !== id || typeof value.label !== 'string' || typeof value.environment !== 'string'
		|| typeof value.complete !== 'boolean' || !Array.isArray(value.folders) || !Array.isArray(value.locations) || !Array.isArray(value.clis)
		|| !isJsonObject(value.counts)) { return false; }
	const counts = value.counts;
	return ['folders', 'locations', 'worktrees', 'agents'].every(key => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0)
		&& value.locations.every(each => isJsonObject(each) && typeof each.location_id === 'string' && typeof each.path === 'string')
		&& value.clis.every(each => isJsonObject(each) && typeof each.cli === 'string' && typeof each.available === 'boolean');
}

type AgentPosition = readonly [number, string];
type LocationPosition = readonly [string, string];
interface Cursor { selection: string; agent: AgentPosition | null; location: LocationPosition | null; agents_done: boolean; locations_done: boolean }
export const createdOf = (agent: Data): number => {
	const at = typeof agent.created_at === 'string' ? Date.parse(agent.created_at) : NaN;
	return Number.isFinite(at) ? at : 0;
};

/** One cursor advances both lists independently. Window summaries/counts remain present on every page. */
export function snapshotPage(windows: readonly WindowSnapshot[], agents: readonly Data[], limit: number, selection: string, token?: string): {
	windows: Data[]; agents: Data[]; next_cursor?: string;
} {
	const cursor = token ? readCursor(token, selection) : undefined;
	const afterAgent = cursor?.agent;
	const remainingAgents = cursor?.agents_done ? [] : [...agents].sort((a, b) => createdOf(a) - createdOf(b) || compare(String(a.agent_id), String(b.agent_id)))
		.filter(each => !afterAgent || createdOf(each) > afterAgent[0] || createdOf(each) === afterAgent[0] && String(each.agent_id) > afterAgent[1]);
	const locations = windows.flatMap(window => window.locations.map(location => ({ window: window.window_id, location })))
		.sort((a, b) => compare(a.window, b.window) || compare(String(a.location.location_id), String(b.location.location_id)));
	const afterLocation = cursor?.location;
	const remainingLocations = cursor?.locations_done ? [] : locations.filter(each => !afterLocation || each.window > afterLocation[0]
		|| each.window === afterLocation[0] && String(each.location.location_id) > afterLocation[1]);
	const agentPage = remainingAgents.slice(0, limit), locationPage = remainingLocations.slice(0, limit);
	const lastAgent = agentPage.at(-1), lastLocation = locationPage.at(-1);
	const moreAgents = remainingAgents.length > limit, moreLocations = remainingLocations.length > limit;
	const next: Cursor = { selection, agent: lastAgent ? [createdOf(lastAgent), String(lastAgent.agent_id)] : afterAgent ?? null,
		location: lastLocation ? [lastLocation.window, String(lastLocation.location.location_id)] : afterLocation ?? null,
		agents_done: !moreAgents, locations_done: !moreLocations };
	return { windows: windows.map(window => ({ ...window, locations: locationPage.filter(each => each.window === window.window_id).map(each => each.location) })),
		agents: agentPage, ...moreAgents || moreLocations ? { next_cursor: Buffer.from(JSON.stringify(next)).toString('base64url') } : {} };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function readCursor(token: string, selection: string): Cursor {
	try {
		const value = token.length <= 8192 ? JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) : undefined;
		if (value?.selection === selection && typeof value.agents_done === 'boolean' && typeof value.locations_done === 'boolean'
			&& (value.agent === null || Array.isArray(value.agent) && value.agent.length === 2 && Number.isFinite(value.agent[0]) && typeof value.agent[1] === 'string')
			&& (value.location === null || Array.isArray(value.location) && value.location.length === 2 && value.location.every((part: unknown) => typeof part === 'string'))) { return value; }
	} catch { /* Invalid or from another selection. */ }
	throw new ArgumentError('list_agents', { missing: [], invalid: [{ field: 'cursor', problem: '`cursor` must be a next_cursor for the same window, location, limit and caller scope.' }] });
}
