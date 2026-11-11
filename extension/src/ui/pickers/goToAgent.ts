/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, RunFacts, RunId } from '../../core/ports';
import { PanelModel, REPORT_COALESCE_MS } from '../model';
import { cliIcon, plainText } from '../presentation';
import { matchesCliSearch } from './search';

export interface GoToAgentDeps {
	readonly model: Pick<PanelModel, 'ordered' | 'placeOf' | 'placesShown'>;
	readonly agents: Pick<Agents, 'onDidChange'>;
	readonly media: vscode.Uri;
	readonly reveal: (run: RunId) => Promise<unknown>;
	readonly copyReference: (run: RunId) => Promise<void>;
	readonly close: (run: RunId) => Promise<void>;
	/** The icon each CLI shows, by its API ID (CONFIGURATION-2.4); none: each name's own. */
	readonly icons?: () => (cli: string) => string;
}

/**
 * The run a search names exactly (LIFECYCLE-2.3): a run ID, or a short ID - alone or ending a copied reference such as
 * `@Ada #a3`, whose name is only descriptive and may be stale. None where the search names no ID.
 */
export function referencedRun(search: string, runs: readonly Pick<RunFacts, 'id' | 'alias'>[]): Pick<RunFacts, 'id' | 'alias'> | undefined {
	const text = search.trim();
	const id = /^run-[0-9a-f]{32}$/.exec(text)?.[0];
	if (id) {
		return runs.find(run => run.id === id);
	}
	const alias = /(?:^|\s)(#a\d+)$/.exec(text)?.[1];
	return alias ? runs.find(run => run.alias === alias) : undefined;
}

type Item = vscode.QuickPickItem & { readonly run: RunId };

/**
 * Go to Agent (LIFECYCLE-2.3): this window's agents alone - starting, running and retained red ones - one line each, searched by name,
 * CLI, title, location, short ID and copied reference. Its name, then its short ID, location and conversation's title in its
 * description, so that duplicate names are told apart; never its state. Choosing one shows its own terminal; each item copies its reference or closes
 * it, the picker staying open.
 */
export function goToAgent(deps: GoToAgentDeps): Promise<void> {
	const copy: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t("Copy Agent Reference") };
	const close: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("End Agent") };
	const picker = vscode.window.createQuickPick<Item>();
	picker.title = vscode.l10n.t("Go to Agent");
	picker.placeholder = vscode.l10n.t("Search by name, CLI, title, location, or ID");
	picker.matchOnDescription = true;
	const icon = deps.icons?.() ?? ((cli: string) => cli);
	const itemOf = (facts: RunFacts, placesShown: boolean): Item => {
		const item: Item = {
			label: plainText(facts.name || facts.alias),
			// Where it works, unless every agent works in the window's one place to work (PANEL-1.3); its conversation's title, where its
			// CLI saved one (CLIS-2.4)
			// Its title's lines joined with a space, as the row is one line: the stored and searchable title stays whole (LIFECYCLE-2.3)
			description: plainText([facts.name ? facts.alias : undefined, placesShown ? deps.model.placeOf(facts).qualified : undefined, facts.title?.split(/\r?\n/).join(' ')].filter(Boolean).join(' · ')),
			iconPath: cliIcon(deps.media, icon(facts.cli)),
			buttons: [copy, close],
			run: facts.id
		};
		// The window's one place to work, left unsaid, still matches a search (LIFECYCLE-2.3)
		return { ...item, alwaysShow: matchesCliSearch(picker.value, facts.cli, facts.displayName, item, placesShown ? undefined : deps.model.placeOf(facts).qualified) };
	};
	/** The query used for the current items, including their hidden CLI matches. */
	let shownFor: string | undefined;
	const refresh = (agentsChanged: boolean) => {
		const runs = deps.model.ordered();
		// An ID typed or pasted decides, whatever name comes with it; other searches include the CLI behind each icon.
		const named = referencedRun(picker.value, runs)?.id;
		if (!agentsChanged && picker.value === shownFor) {
			return;
		}
		shownFor = picker.value;
		const active = picker.activeItems[0]?.run;
		const placesShown = deps.model.placesShown();
		picker.items = named ? [{ ...itemOf(runs.find(run => run.id === named)!, placesShown), alwaysShow: true }] : runs.map(run => itemOf(run, placesShown));
		const again = picker.items.find(item => item.run === active);
		if (again) {
			picker.activeItems = [again];
		}
	};
	refresh(true);
	/** A refresh for reported text and activity under way: they come at most once per {@link REPORT_COALESCE_MS}, as to the panel. */
	let reported: ReturnType<typeof setTimeout> | undefined;
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
				clearTimeout(reported);
				reported = undefined;
				refresh(true);
			}),
			picker.onDidChangeValue(() => refresh(false)),
			picker.onDidAccept(() => {
				const run = picker.activeItems[0]?.run;
				picker.hide();
				if (run) {
					void deps.reveal(run);
				}
			}),
			picker.onDidTriggerItemButton(({ item, button }) => void (button === copy ? deps.copyReference(item.run) : deps.close(item.run))),
			picker.onDidHide(() => {
				clearTimeout(reported);
				subscriptions.forEach(each => each.dispose());
				picker.dispose();
				resolve();
			})
		];
		picker.show();
	});
}
