/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, RunFacts, RunId } from '../../core/ports';
import { CardWords, statusOf } from '../cardView';
import { PanelModel } from '../model';
import { cliIcon, plainText } from '../presentation';

export interface GoToAgentDeps {
	readonly model: Pick<PanelModel, 'ordered' | 'placeOf'>;
	readonly agents: Pick<Agents, 'onDidChange'>;
	readonly words: CardWords;
	readonly media: vscode.Uri;
	readonly reveal: (run: RunId) => Promise<unknown>;
	readonly copyReference: (run: RunId) => Promise<void>;
	readonly close: (run: RunId) => Promise<void>;
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
 * CLI, title, location, short ID and copied reference. Its name, then its short ID, CLI, state, location and CLI title in its
 * description, so that duplicate names are told apart. Choosing one shows its own terminal; each item copies its reference or closes
 * it, the picker staying open.
 */
export function goToAgent(deps: GoToAgentDeps): Promise<void> {
	const copy: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t("Copy Agent Reference") };
	const close: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t("Close Agent") };
	const picker = vscode.window.createQuickPick<Item>();
	picker.title = vscode.l10n.t("Go to Agent");
	picker.placeholder = vscode.l10n.t("Search by name, CLI, title, location or ID");
	picker.matchOnDescription = true;
	const itemOf = (facts: RunFacts): Item => ({
		label: plainText(facts.name),
		description: plainText([facts.alias, facts.displayName, statusOf(facts, deps.words).stateText, deps.model.placeOf(facts).qualified, facts.title].filter(Boolean).join(' · ')),
		iconPath: cliIcon(deps.media, facts.cli),
		buttons: [copy, close],
		run: facts.id
	});
	/** The run the search names by ID, as the items show it now: the items change only as that, or the agents, change. */
	let shownFor: string | undefined;
	const refresh = (agentsChanged: boolean) => {
		const runs = deps.model.ordered();
		// An ID typed or pasted decides, whatever name comes with it; any other search is the picker's own
		const named = referencedRun(picker.value, runs)?.id;
		if (!agentsChanged && named === shownFor) {
			return;
		}
		shownFor = named;
		const active = picker.activeItems[0]?.run;
		picker.items = named ? [{ ...itemOf(runs.find(run => run.id === named)!), alwaysShow: true }] : runs.map(itemOf);
		const again = picker.items.find(item => item.run === active);
		if (again) {
			picker.activeItems = [again];
		}
	};
	refresh(true);
	return new Promise(resolve => {
		const subscriptions: vscode.Disposable[] = [
			deps.agents.onDidChange(() => refresh(true)),
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
				subscriptions.forEach(each => each.dispose());
				picker.dispose();
				resolve();
			})
		];
		picker.show();
	});
}
