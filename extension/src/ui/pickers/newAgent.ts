/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { FacadeError } from '../../core/errors';
import { normalizeName, suggestName } from '../../core/names';
import { PlanError, type Agents, type Catalog, type CliCatalogPort, type CliChoice, type HumanPort, type LaunchHistoryPort, type Location, type LocationId, type LocationPort, type LogPort, type RunId, type WorktreePort } from '../../core/ports';
import { COMMANDS } from '../catalog';
import { cliIcon, configureAgentsLabel, launchFailureText, reasonText } from '../presentation';
import { chooseLocation, Destination, environmentLabel, locationLabel, worktreeSourceLabel } from './location';
import { BACK, Flow } from './stepping';

export interface NewAgentDeps {
	/** Closes the agents a worktree deletion takes first (WORKTREES-3.2). */
	readonly agents: Pick<Agents, 'launch' | 'list' | 'close'>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'refresh' | 'onDidChange'>;
	readonly clis: CliCatalogPort;
	readonly worktrees: WorktreePort;
	readonly history: LaunchHistoryPort;
	/** Selects the new card: a person's own launch comes to the front (PANEL-2.1, LIFECYCLE-2.2). */
	readonly select: (run: RunId) => void;
	readonly notifyError: HumanPort['error'];
	readonly log: LogPort;
	readonly media: vscode.Uri;
	readonly suggest?: () => string;
	/** The window's remote authority, as the local window component sees it: how its environment is named (LIFECYCLE-1.1). */
	readonly remote?: string;
}

/**
 * Where the person's New Agent starts (LIFECYCLE-1.2): the location of their last launch whose CLI started, while it is still offered;
 * else the first workspace folder's first location. A filter never chooses it.
 */
export function defaultLocation(catalog: Catalog, last: LocationId | undefined): Location | undefined {
	const remembered = last === undefined ? undefined : catalog.locations.find(location => location.id === last);
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

type Does = 'start' | 'configure' | 'location' | 'name' | 'openFolder';
type Item = vscode.QuickPickItem & { readonly does?: Does; readonly cli?: CliChoice };

/**
 * New Agent (LIFECYCLE-1.1-1.3): one native picker titled `New Agent` with the CLIs to choose from - the last one used first and
 * selected, never started until chosen - and, at its bottom, `Change Working Location...` showing the location and its environment and
 * `Change Name...` showing an editable suggested name. Escape anywhere ends it with nothing done. Choosing a CLI closes it and starts
 * the agent - in a new worktree where one was chosen, made only now - whose card and terminal show at once.
 */
export async function newAgent(deps: NewAgentDeps): Promise<void> {
	const title = vscode.l10n.t("New Agent");
	const flow = new Flow();
	const catalog = deps.locations.snapshot();
	if (!catalog.folders.length) {
		return openFolder(flow, title);
	}
	// Opening a location catalog reads Git again where needed; plain folders are there meanwhile (WORKTREES-1.1, 1.3)
	deps.locations.refresh().catch(err => deps.log.event(`Could not refresh the working locations: ${messageOf(err)}`));
	const found = defaultLocation(catalog, deps.history.last().location);
	if (!found) {
		return openFolder(flow, title);
	}
	let destination: Destination = { location: found };
	let name = deps.suggest?.() ?? suggestName(deps.agents.list().map(run => run.name));
	for (; ;) {
		const picked = await chooseCli(flow, deps, { title, destination, name });
		if (!picked) {
			return;
		}
		if (picked.does === 'start' && picked.cli) {
			flow.close();
			start(deps, name, destination, picked.cli);
			return;
		}
		if (picked.does === 'configure') {
			// The same page as Configure Agents... everywhere (UX-1.3)
			flow.close();
			await vscode.commands.executeCommand(COMMANDS.configureAgents);
			return;
		}
		if (picked.does === 'name') {
			const typed = await flow.text({ title, value: name, placeholder: vscode.l10n.t("Agent name"), back: true });
			if (typed === undefined) {
				return;
			}
			if (typed !== BACK) {
				name = normalizeName(typed);
			}
		} else if (picked.does === 'location') {
			const chosen = await chooseLocation(flow, deps, title, destination);
			if (chosen === undefined) {
				return;
			}
			if (chosen !== BACK) {
				destination = chosen;
			} else if (!deps.locations.snapshot().locations.some(each => each.id === destination.location.id)) {
				// Its folder removed or its worktree deleted in the flow (D73): the first folder's first location, as at first use
				const found = defaultLocation(deps.locations.snapshot(), undefined);
				if (!found) {
					return;
				}
				destination = { location: found };
			}
		}
	}
}

/**
 * Starts the person's agent: its card and terminal come at once, and its card is selected (LIFECYCLE-1.5, PANEL-2.1). A new worktree is
 * made from the source's HEAD as part of that launch (WORKTREES-2.1).
 */
function start(deps: NewAgentDeps, name: string, destination: Destination, cli: CliChoice): void {
	let run: RunId;
	try {
		run = deps.agents.launch({
			name, location: destination.location.id, cli: cli.id,
			...(destination.worktree ? { worktree: { branch: destination.worktree.branch } } : {})
		});
	} catch (err) {
		const reason = err instanceof FacadeError && err.reason === 'ownership_lost'
			? vscode.l10n.t("This workspace is owned by another window. Reload this window to take ownership.")
			: err instanceof PlanError ? reasonText(err.said, err.message) : messageOf(err);
		deps.notifyError(launchFailureText(name || cli.displayName, reason), {});
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
	// The environment only where it is not this machine (LIFECYCLE-1.1, D67): a remote window's, never `Local`
	const where = location.environment === 'local' ? place : `${place} · ${environmentLabel(location.environment, deps.remote)}`;
	const titleWhere = location.environment === 'local' ? titlePlace : `${titlePlace} · ${environmentLabel(location.environment, deps.remote)}`;
	// The current choices stay in sight while the CLIs are filtered or scrolled
	const summary = vscode.l10n.t("{0} · {1} · {2}", at.title, at.name, titleWhere);
	const configure: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: configureAgentsLabel() };
	// Nothing to change it to - one folder whose only location is a plain folder - is said as a label, never an action that does
	// nothing (LIFECYCLE-1.3)
	const inFolder = catalog.locations.filter(each => each.folders.some(folder => folder.uri === location.folders[0]?.uri));
	const changeable = catalog.folders.length > 1 || inFolder.length > 1 || inFolder.some(each => each.kind === 'checkout') || !!worktree;
	const bottom: Item[] = [
		// A labeled line: the editor draws one without a label as all but invisible. The location said as a label is its own line.
		...!changeable
			? [{ label: where, kind: vscode.QuickPickItemKind.Separator }]
			: [{ label: vscode.l10n.t("Options"), kind: vscode.QuickPickItemKind.Separator }, {
				label: vscode.l10n.t("Change Working Location..."),
				description: where,
				iconPath: new vscode.ThemeIcon('folder'),
				alwaysShow: true,
				does: 'location' as const
			}],
		{ label: vscode.l10n.t("Change Name..."), description: at.name, iconPath: new vscode.ThemeIcon('edit'), alwaysShow: true, does: 'name' }
	];
	const itemsOf = (choices: readonly CliChoice[] | Error): { readonly items: Item[]; readonly active?: Item } => {
		if (choices instanceof Error) {
			const item: Item = { label: vscode.l10n.t("Configure Agents..."), detail: choices.message, iconPath: new vscode.ThemeIcon('gear'), alwaysShow: true, does: 'configure' };
			return { items: [item, ...bottom], active: item };
		}
		const { available, unavailable } = orderedClis(choices, deps.history.last().cli);
		const items: Item[] = [
			...available.map((cli): Item => ({ label: cli.displayName, iconPath: cliIcon(deps.media, cli.id), does: 'start', cli })),
			// No CLI can start here: why, and the way to the settings (LIFECYCLE-1.1, EXPERIENCE-1.4)
			...available.length ? [] : [{ label: vscode.l10n.t("Configure Agents..."), detail: vscode.l10n.t("Install a supported CLI in this environment, or configure its path."), iconPath: new vscode.ThemeIcon('gear'), alwaysShow: true, does: 'configure' as const }],
			...unavailable.length ? [{ label: vscode.l10n.t("Unavailable"), kind: vscode.QuickPickItemKind.Separator }] : [],
			...unavailable.map((cli): Item => ({ label: cli.displayName, ...(cli.problem ? { detail: reasonText(cli.said, cli.problem) } : {}), iconPath: cliIcon(deps.media, cli.id), buttons: [configure], does: 'configure', cli })),
			...bottom
		];
		return { items, active: items.find(item => item.does === 'start' || item.does === 'configure') };
	};
	const picked = await flow.pick<Item>({
		title: summary,
		placeholder: vscode.l10n.t("Select a CLI"),
		// Nothing until the CLIs are found: the editor keeps the place of the item it had in focus when the items change, so a
		// Change item shown meanwhile would leave the focus on another CLI than the one preselected, which an Enter then starts
		items: [],
		busy: true,
		// The CLIs of the location's environment, found as the step shows (CLIS-1.1); the step up keeps its place meanwhile
		live: picker => {
			let up = true;
			const show = (choices: readonly CliChoice[] | Error) => {
				if (up) {
					const { items, active } = itemsOf(choices);
					picker.items = items;
					picker.activeItems = active ? [active] : [];
					picker.busy = false;
				}
			};
			deps.clis.list(location).then(show, err => show(err instanceof Error ? err : new Error(messageOf(err))));
			return { dispose: () => { up = false; } };
		}
	});
	return picked && picked !== BACK ? picked.item : undefined;
}

/** No folder is open: the picker offers Open Folder (LIFECYCLE-1.1). */
async function openFolder(flow: Flow, title: string): Promise<void> {
	const item: Item = { label: vscode.l10n.t("Open Folder..."), detail: vscode.l10n.t("A workspace folder is required to run agents."), iconPath: new vscode.ThemeIcon('folder-opened'), does: 'openFolder' };
	const picked = await flow.pick<Item>({ title, placeholder: vscode.l10n.t("Open a folder to continue"), items: [item], active: item });
	flow.close();
	if (picked && picked !== BACK) {
		await vscode.commands.executeCommand('vscode.openFolder');
	}
}
