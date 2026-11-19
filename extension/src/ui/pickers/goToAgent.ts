/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { canDismiss, type Agents, type Event, type OtherAgent, type RunFacts, type RunId } from '../../core/ports';
import { PanelModel, REPORT_COALESCE_MS } from '../model';
import { cliIcon, plainText } from '../presentation';
import { matchesCliSearch } from './search';

export interface GoToAgentDeps {
	readonly model: Pick<PanelModel, 'ordered' | 'placeOf' | 'placesShown'>;
	readonly agents: Pick<Agents, 'onDidChange'>;
	readonly media: vscode.Uri;
	readonly reveal: (run: RunId) => Promise<unknown>;
	readonly copyReference: (run: RunId) => Promise<void>;
	readonly stop: (run: RunId) => Promise<unknown>;
	readonly dismiss: (run: RunId) => Promise<unknown>;
	readonly others?: {
		list(): readonly OtherAgent[];
		/** Network candidates, in addition to those already known by this window. */
		query?(): Promise<readonly OtherAgent[]>;
		readonly onDidChange: Event<void>;
		open(agent: string): Promise<void>;
		copyReference(facts: RunFacts): Promise<void>;
		stop(facts: RunFacts): Promise<boolean>;
	};
	/** The icon each CLI shows, by its API ID (CONFIGURATION-2.4); none: each name's own. */
	readonly icons?: () => (cli: string) => string;
}

/**
 * The run a search names exactly (LIFECYCLE-2.3): a run ID, or a short ID - alone or ending a copied reference such as
 * `@Ada #a3`, whose name is only descriptive and may be stale. None where the search names no ID.
 */
export function referencedRun<T extends Pick<RunFacts, 'id' | 'alias' | 'address'>>(search: string, runs: readonly T[]): T | undefined {
	const text = search.trim();
	const id = /^(?:run-[0-9a-f]{32}|a\d+)$/.exec(text)?.[0];
	if (id) {
		return runs.find(run => run.id === id || (run.address !== undefined && run.alias === `#${id}`));
	}
	const address = /(?:^|\s)(#a\d+(?:@[a-z0-9][a-z0-9:-]*)?)$/i.exec(text)?.[1]?.toLowerCase();
	return address ? runs.find(run => run.alias === address || run.address === address) : undefined;
}

type Item = vscode.QuickPickItem & { readonly run: RunId; readonly other?: RunFacts };

/** Checks fuzzy matches against the agent text before the window names are added. */
function matchesText(query: string, text: string): boolean {
	const lower = text.toLowerCase();
	let from = 0;
	for (const char of query) {
		const found = lower.indexOf(char, from);
		if (found < 0) {
			return false;
		}
		from = found + char.length;
	}
	return true;
}

/**
 * Go to Agent (LIFECYCLE-2.3) lists this window's agents and available running agents from other windows. Search by name, CLI,
 * title, location, short ID or copied reference. Choosing an agent opens its terminal in this window, adopting it when needed.
 * The row buttons copy its reference, stop its process or dismiss its ended card. They keep the picker open.
 */
export function goToAgent(deps: GoToAgentDeps): Promise<void> {
	const copy: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t("Copy Agent Reference") };
	const stop: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("Stop Agent") };
	const dismiss: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("Dismiss Agent") };
	const picker = vscode.window.createQuickPick<Item>();
	picker.title = vscode.l10n.t("Go to Agent");
	picker.placeholder = vscode.l10n.t("Search by name, CLI, title, location, or ID");
	picker.matchOnDescription = true;
	const icon = deps.icons?.() ?? ((cli: string) => cli);
	const others = deps.others;
	let network: readonly OtherAgent[] = [];
	const stopped = new Set<RunId>();
	let open = true;
	const itemOf = (facts: RunFacts, placesShown: boolean, cwd?: string): Item => {
		const place = deps.model.placeOf(facts).qualified;
		const item: Item = {
			label: plainText(facts.name || facts.alias),
			// Where it works, unless every agent works in the window's one place to work (PANEL-1.3); its conversation's title, where its
			// CLI saved one (CLIS-2.4)
			// Its title's lines joined with a space, as the row is one line: the stored and searchable title stays whole (LIFECYCLE-2.3)
			description: plainText([facts.name ? facts.alias : undefined, placesShown ? place : undefined, facts.title?.split(/\r?\n/).join(' ')].filter(Boolean).join(' · ')),
			iconPath: cliIcon(deps.media, icon(facts.cli)),
			buttons: [copy, canDismiss(facts) ? dismiss : stop],
			run: facts.id
		};
		// The window's one place to work, left unsaid, still matches a search (LIFECYCLE-2.3)
		return { ...item, alwaysShow: matchesCliSearch(picker.value, facts.cli, facts.displayName, item, cwd ?? (placesShown ? undefined : place)) };
	};
	/** The query used for the current items, including their hidden CLI matches. */
	let shownFor: string | undefined;
	const refresh = (agentsChanged: boolean) => {
		if (!agentsChanged && picker.value === shownFor) {
			return;
		}
		shownFor = picker.value;
		const runs = deps.model.ordered();
		const here = new Set(runs.map(run => run.id));
		const elsewhere: OtherAgent[] = [];
		for (const candidate of [...(others?.list() ?? []), ...network]) {
			if (!here.has(candidate.facts.id) && !stopped.has(candidate.facts.id)) {
				here.add(candidate.facts.id);
				elsewhere.push(candidate);
			}
		}
		// An ID typed or pasted decides, whatever name comes with it.
		const named = referencedRun(picker.value, [...runs, ...elsewhere.map(agent => agent.facts)]);
		const active = picker.activeItems[0]?.run;
		const placesShown = deps.model.placesShown();
		const items = runs.filter(run => !named || named === run).map(run => {
			const item = itemOf(run, placesShown);
			return named ? { ...item, alwaysShow: true } : item;
		});
		if (elsewhere.length) {
			const disconnected = vscode.l10n.t("Window disconnected");
			const query = picker.value.trim().toLowerCase();
			for (const { facts, windows } of elsewhere) {
				if (named && named !== facts) {
					continue;
				}
				const item = itemOf(facts, true, facts.cwd);
				// Filter these rows first because the native picker matches the whole description, including its window suffix.
				if (!named && !item.alwaysShow && !matchesText(query, item.label) && !matchesText(query, item.description ?? '')) {
					continue;
				}
				const labels = windows.map(({ label, connected }) => plainText(connected === false ? `${label} (${disconnected})` : label).replace(/\r?\n/g, ' '));
				items.push({ ...item, description: [item.description, labels.join(', ')].filter(Boolean).join(' · '), alwaysShow: !!query, buttons: [copy, stop], other: facts });
			}
		}
		picker.items = items;
		const again = items.find(item => item.run === active);
		if (again) {
			picker.activeItems = [again];
		}
	};
	refresh(true);
	/** A refresh for reported text and activity under way: they come at most once per {@link REPORT_COALESCE_MS}, as to the panel. */
	let reported: ReturnType<typeof setTimeout> | undefined;
	const refreshNow = () => {
		clearTimeout(reported);
		reported = undefined;
		refresh(true);
	};
	return new Promise(resolve => {
		const subscriptions: vscode.Disposable[] = [
			// An agent added, gone, renamed or changing state at once; what its CLI reports coalesced, as the panel has it (PANEL-3.1, UX-5.2)
			deps.agents.onDidChange(change => {
				if (change.kind === 'reported') {
					reported ??= setTimeout(() => {
						reported = undefined;
						refresh(true);
					}, REPORT_COALESCE_MS);
					return;
				}
				refreshNow();
			}),
			picker.onDidChangeValue(() => refresh(false)),
			picker.onDidAccept(() => {
				const item = picker.activeItems[0];
				picker.hide();
				if (item?.other) {
					void others?.open(item.run);
				} else if (item) {
					void deps.reveal(item.run);
				}
			}),
			picker.onDidTriggerItemButton(({ item, button }) => {
				if (item.other && others) {
					if (button === copy) {
						void others.copyReference(item.other);
					} else if (button === stop) {
						void others.stop(item.other).then(ended => {
							if (ended && open) {
								stopped.add(item.run);
								refreshNow();
							}
						});
					}
				} else if (button === copy) {
					void deps.copyReference(item.run);
				} else if (button === stop) {
					void deps.stop(item.run);
				} else if (button === dismiss) {
					void deps.dismiss(item.run);
				}
			}),
			picker.onDidHide(() => {
				open = false;
				clearTimeout(reported);
				subscriptions.forEach(each => each.dispose());
				picker.dispose();
				resolve();
			})
		];
		if (others) {
			subscriptions.push(others.onDidChange(refreshNow));
		}
		picker.show();
		if (others?.query) {
			picker.busy = true;
			void others.query().then(rows => {
				if (open) {
					network = rows;
					picker.busy = false;
					refreshNow();
				}
			}, () => {
				if (open) { picker.busy = false; }
			});
		}
	});
}
