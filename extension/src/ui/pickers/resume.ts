/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { isEqualPath, isInsideFolder, realFolderOf } from '../../base/files';
import { conversationId } from '../../core/ports';
import type { Catalog, CliChoices, ConversationDiscoveryPort, ConversationEntry, ConversationKey, ConversationPager, HumanPort, Location, LocationPort, ResumeResult, RetainedConversation, RunId } from '../../core/ports';
import { COMMANDS } from '../catalog';
import { locationLabel, onePlaceOf } from '../cardView';
import { ago, cliDisplayName, cliIcon, openSettingsLabel, plainText, reasonOf, reasonText } from '../presentation';
import { BACK, Flow } from './stepping';
import { matchesCliSearch } from './search';

interface PickerDeps {
	readonly locations: Pick<LocationPort, 'snapshot'>;
	/**
	 * What is read before the conversations are: this window's agents, its locations and the conversations other windows hold. The
	 * picker shows at once, busy, meanwhile (UX-1.1); a failure ends it and is said.
	 */
	readonly prepared?: Promise<unknown>;
	/** Whether a run holds the conversation now, here or in another window: one already running is not offered again (LIFECYCLE-3.2). */
	readonly running: (key: ConversationKey) => boolean;
	/** Shows a run's own terminal and selects its card. */
	readonly reveal: (run: RunId) => Promise<unknown>;
	readonly select: (run: RunId) => void;
	/** The icon each CLI shows, by its API ID (CONFIGURATION-2.4); none: each name's own. */
	readonly icons?: () => (cli: string) => string;
	/** What is wrong with the settings file as a whole, which stops every resume (CONFIGURATION-4.1); none: nothing. */
	readonly settingsProblems?: () => CliChoices['problems'];
	readonly notifyError: HumanPort['error'];
	readonly media: vscode.Uri;
	readonly language: string;
	readonly now?: () => number;
}

type SessionDeps = PickerDeps & ({
	readonly kind: 'resume';
	readonly retained: () => readonly RetainedConversation[];
	readonly resume: (agent: string) => Promise<RunId>;
} | {
	readonly kind: 'continue';
	readonly conversations: ConversationDiscoveryPort;
	readonly savedName: (key: ConversationKey) => string | undefined;
	readonly continueSession: (entry: ConversationEntry) => ResumeResult | Promise<ResumeResult>;
});

/** How far down the list the person may come before the next batch is read: a page of the picker. */
const READ_AHEAD = 10;

/**
 * Where a conversation was, as the window names it: its location, a subdirectory of one after it, else its path; nothing for the
 * window's one place to work itself, which goes without saying (LIFECYCLE-3.2). Compared as the folders really are, `reals` each
 * location's: a CLI may record the other form - macOS's /var is /private/var.
 */
function placeOf(cwd: string, reals: readonly { readonly location: Location; readonly real: string }[], catalog: Catalog): string {
	const real = realFolderOf(cwd);
	const inside = reals
		.filter(each => isEqualPath(real, each.real) || isInsideFolder(real, each.real))
		.sort((a, b) => b.real.length - a.real.length)[0];
	if (!inside) {
		return cwd;
	}
	const rest = path.relative(inside.real, real).split(path.sep).join('/');
	if (!rest && onePlaceOf(catalog)?.id === inside.location.id) {
		return '';
	}
	return rest ? `${locationLabel(inside.location, catalog)}/${rest}` : locationLabel(inside.location, catalog);
}

interface Choice {
	readonly entry: ConversationEntry;
	readonly name?: string;
	readonly retained?: RetainedConversation;
}

type Item = vscode.QuickPickItem & { readonly choice?: Choice; readonly openFolder?: true; readonly settings?: true };

/** Picks an exact retained agent or a CLI history entry, according to the command (LIFECYCLE-3.2). */
export function pickSession(deps: SessionDeps): Promise<void> {
	const picker = vscode.window.createQuickPick<Item>();
	const title = deps.kind === 'resume' ? vscode.l10n.t("Resume Agent") : vscode.l10n.t("Continue Session");
	picker.title = title;
	picker.placeholder = vscode.l10n.t("Search by title, name, CLI, or location");
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	// Shown at once, busy until the conversations are there to read (UX-1.1)
	picker.busy = true;
	const now = deps.now ?? Date.now;
	/** The window's histories, open once what they depend on is read; none before, or where no folder is open. */
	let pager: ConversationPager | undefined;
	let catalog: Catalog = { locations: [], folders: [], pending: false };
	let reals: readonly { readonly location: Location; readonly real: string }[] = [];
	const choices: Choice[] = [];
	const seenSessions = new Set<string>();
	const recentFirst = (a: Choice, b: Choice): number =>
		(b.entry.activityAt ?? Number.NEGATIVE_INFINITY) - (a.entry.activityAt ?? Number.NEGATIVE_INFINITY);
	let done = false;
	let open = true;
	let reading: Promise<void> | undefined;
	const places = new Map<string, string>();
	const placeIn = (cwd: string) => places.get(cwd) ?? places.set(cwd, placeOf(cwd, reals, catalog)).get(cwd)!;
	const icon = deps.icons?.() ?? ((cli: string) => cli);
	// One line (LIFECYCLE-2.3): title first, then when, where and its saved name. Equal name/title fields remain independent.
	const itemOf = (choice: Choice): Item => {
		const { entry, name, retained } = choice;
		const item: Item = {
			label: plainText(entry.title?.trim() || vscode.l10n.t("Untitled conversation")),
			description: [entry.activityAt !== undefined ? ago(entry.activityAt, now(), deps.language) : undefined, (entry.cwdChoices ?? [entry.cwd]).map(placeIn).filter(Boolean).join(', '), name, retained?.alias].filter(Boolean).map(text => plainText(text!)).join(' · '),
			iconPath: cliIcon(deps.media, icon(entry.key.cli)),
			choice
		};
		// The window's one place to work, left unsaid, still matches a search (LIFECYCLE-3.2)
		const one = onePlaceOf(catalog);
		const unsaid = one && (entry.cwdChoices ?? [entry.cwd]).some(cwd => !placeIn(cwd)) ? locationLabel(one, catalog) : undefined;
		return { ...item, alwaysShow: matchesCliSearch(picker.value, entry.key.cli, cliDisplayName(entry.key.cli), item, unsaid) };
	};
	const show = () => {
		const active = picker.activeItems[0]?.choice;
		picker.items = choices.map(itemOf);
		const again = active && picker.items.find(item => item.choice === active);
		if (again) {
			picker.activeItems = [again];
		}
		if (done && !choices.length) {
			picker.placeholder = deps.kind === 'resume' ? vscode.l10n.t("No agents to resume in this window")
				: vscode.l10n.t("No saved conversations in this window's folders");
		}
	};
	/** Reads the next batch, once at a time; deduplicated by environment, CLI and session ID, most recent first. */
	const readNext = (): Promise<void> => deps.kind !== 'continue' || !pager ? Promise.resolve() : reading ??= (async (histories: ConversationPager) => {
		picker.busy = true;
		try {
			const before = choices.length;
			do {
				const batch = await histories.next();
				if (!open) {
					return;
				}
				for (const entry of batch.entries) {
					const id = conversationId(entry.key);
					// One that cannot be resumed now - its folder gone, its CLI off or not installed (LIFECYCLE-3.2) - or already runs is not offered (LIFECYCLE-3.2)
					if (!seenSessions.has(id) && entry.unavailable === undefined && !deps.running(entry.key)) {
						seenSessions.add(id);
						choices.push({ entry, name: deps.savedName(entry.key)?.trim() });
					}
				}
				choices.sort(recentFirst);
				done = batch.done;
			} while (open && !done && choices.length === before);
		} catch (err) {
			done = true;
			if (open) {
				deps.notifyError(vscode.l10n.t("Could not read the saved conversations: {0}", messageOf(err)), {});
			}
		} finally {
			reading = undefined;
			if (open) {
				picker.busy = false;
				show();
			}
		}
	})(pager);
	/** A search goes on past what was read, batch after batch, while it is typed (LIFECYCLE-3.2). */
	const readAll = async () => {
		while (open && pager && !done && picker.value.trim()) {
			await readNext();
		}
	};
	/** Reads just the source selected by the command. */
	const begin = async () => {
		await deps.prepared;
		if (!open) { return; }
		catalog = deps.locations.snapshot();
		const [location] = catalog.locations;
		if (deps.kind === 'continue' && !location) {
			picker.items = [{ label: vscode.l10n.t("Open Folder..."), detail: vscode.l10n.t("Open a folder to continue a saved session."), iconPath: new vscode.ThemeIcon('folder-opened'), openFolder: true }];
			picker.busy = false;
			return;
		}
		const problems = deps.settingsProblems?.() ?? [];
		if (problems.length) {
			const settingsButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: openSettingsLabel() };
			picker.items = problems.map((each): Item => ({ label: each.setting, detail: reasonText(each.said, each.problem), iconPath: new vscode.ThemeIcon('gear'), buttons: [settingsButton], settings: true }));
			picker.busy = false;
			return;
		}
		reals = catalog.locations.filter(location => !location.within).map(location => ({ location, real: realFolderOf(location.path) }));
		if (deps.kind === 'resume') {
			for (const retained of deps.retained()) {
				if (!deps.running(retained.entry.key)) {
					choices.push({ entry: retained.entry, name: retained.name.trim(), retained });
				}
			}
			choices.sort(recentFirst);
			done = true;
			picker.busy = false;
			show();
		} else {
			pager = deps.conversations.open({ environment: location.environment, directories: [...new Set(catalog.locations.map(location => location.path))] });
			await readNext();
			await readAll();
		}
	};
	/** The same page as Open Settings everywhere (UX-1.3). */
	const openSettings = () => {
		picker.hide();
		void vscode.commands.executeCommand(COMMANDS.openSettings);
	};
	return new Promise(resolve => {
		let accepting = false;
		const subscriptions: vscode.Disposable[] = [
			picker.onDidTriggerItemButton(({ item }) => {
				if (item.settings) {
					openSettings();
				}
			}),
			picker.onDidChangeValue(() => { if (pager || choices.length) { show(); } void readAll(); }),
			picker.onDidChangeActive(([active]) => {
				if (!done && active && picker.items.indexOf(active) >= picker.items.length - READ_AHEAD) {
					void readNext();
				}
			}),
			picker.onDidAccept(async () => {
				const active = picker.activeItems[0];
				if (active?.openFolder) {
					picker.hide();
					void vscode.commands.executeCommand('vscode.openFolder');
					return;
				}
				if (active?.settings) {
					openSettings();
					return;
				}
				const choice = active?.choice;
				if (!choice || accepting) { return; }
				accepting = true;
				picker.hide();
				const name = choice.entry.title?.trim() || choice.name || choice.retained?.alias || vscode.l10n.t("Untitled conversation");
				let result: ResumeResult;
				try {
					if (deps.kind === 'resume') {
						if (!choice.retained) { resolve(); return; }
						result = await deps.resume(choice.retained.agent);
					} else {
						let entry = choice.entry;
						if (entry.cwdChoices?.length) {
							const flow = new Flow();
							const chosen = await flow.pick({ title, placeholder: vscode.l10n.t("Select a working location"),
								items: entry.cwdChoices.map(cwd => ({ label: placeIn(cwd), description: cwd, cwd })), matchOnDescription: true });
							flow.close();
							if (!chosen || chosen === BACK) { resolve(); return; }
							entry = { ...entry, cwd: chosen.item.cwd, cwdChoices: undefined };
						}
						result = await deps.continueSession(entry);
					}
				} catch (err) {
					deps.notifyError(deps.kind === 'resume' ? vscode.l10n.t("Could not resume {0}: {1}", name, reasonOf(err))
						: vscode.l10n.t("Could not continue {0}: {1}", name, reasonOf(err)), {});
					resolve();
					return;
				}
				if (typeof result === 'string') {
					deps.select(result);
				} else if (result.running === 'elsewhere') {
					deps.notifyError(vscode.l10n.t("{0} is already running in another window.", name), {});
				} else {
					void deps.reveal(result.running);
				}
				resolve();
			}),
			picker.onDidHide(() => {
				open = false;
				subscriptions.forEach(each => each.dispose());
				pager?.dispose();
				picker.dispose();
				if (!accepting) { resolve(); }
			})
		];
		picker.show();
		void begin().catch(err => {
			if (open) {
				picker.hide();
				deps.notifyError(vscode.l10n.t("Could not read the saved conversations: {0}", messageOf(err)), {});
			}
		});
	});
}
