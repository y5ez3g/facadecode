/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { isEqualPath, isInsideFolder, realFolderOf } from '../../base/files';
import { conversationId } from '../../core/ports';
import type { Catalog, ConversationDiscoveryPort, ConversationEntry, ConversationKey, HumanPort, Location, LocationPort, RunId } from '../../core/ports';
import { locationLabel } from '../cardView';
import { cliIcon, plainText } from '../presentation';
import { BACK, Flow } from './stepping';

export interface ResumeDeps {
	/** Opens a folder the person chooses, returning to the Facade Code view once it has (PANEL-1.2); the editor's own otherwise. */
	readonly openFolder?: () => Promise<void>;
	readonly conversations: ConversationDiscoveryPort;
	readonly locations: Pick<LocationPort, 'snapshot'>;
	/** Whether a run holds the conversation now, here or in another window: one already running is not offered again (D69). */
	readonly running: (key: ConversationKey) => boolean;
	/** `agents.resume(entry, { reveal: true })`: a new run, or the run already holding that conversation (LIFECYCLE-3.2, 3.3). */
	readonly resume: (entry: ConversationEntry) => RunId | { readonly running: RunId | 'elsewhere' };
	/** Shows a run's own terminal and selects its card. */
	readonly reveal: (run: RunId) => Promise<unknown>;
	readonly select: (run: RunId) => void;
	readonly notifyError: HumanPort['error'];
	readonly media: vscode.Uri;
	readonly language: string;
	readonly now?: () => number;
}


/** How far down the list the person may come before the next batch is read: a page of the picker. */
const READ_AHEAD = 10;

/** How long ago `time` was, in the window's language, as briefly as it says it: now, 5 min. ago, yesterday (UX-2.4). */
export function ago(time: number, now: number, language: string): string {
	const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
	const minutes = Math.floor(Math.max(0, now - time) / 60_000);
	if (minutes < 1) {
		return format.format(0, 'second');
	}
	if (minutes < 60) {
		return format.format(-minutes, 'minute');
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? format.format(-hours, 'hour') : format.format(-Math.floor(hours / 24), 'day');
}

/**
 * Where a conversation was, as the window names it: its location, a subdirectory of one after it, else its path. Compared as the
 * folders really are, `reals` each location's: a CLI may record the other form - macOS's /var is /private/var.
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
	return rest ? `${locationLabel(inside.location, catalog)}/${rest}` : locationLabel(inside.location, catalog);
}

type Item = vscode.QuickPickItem & { readonly entry?: ConversationEntry; readonly openFolder?: true };

/**
 * Resume Agent (LIFECYCLE-3.2): this window's folders' saved conversations, from the CLIs' own histories, most recent first - title,
 * CLI, original location, activity time and source - read 100 at a time as the person scrolls toward the end, and on to the last as
 * they search, what was read kept. One that cannot be resumed says why and cannot be chosen. Choosing one closes the picker and
 * resumes it; one already running here is shown instead, one running in another window is said to be. The panel's filter does not
 * narrow it; nothing is deleted or hidden.
 */
export function resumeAgent(deps: ResumeDeps): Promise<void> {
	const catalog = deps.locations.snapshot();
	const picker = vscode.window.createQuickPick<Item>();
	picker.title = vscode.l10n.t("Resume Agent");
	picker.placeholder = vscode.l10n.t("Search saved conversations by title or location");
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	if (!catalog.locations.length) {
		const item: Item = { label: vscode.l10n.t("Open Folder..."), detail: vscode.l10n.t("Open a folder to resume its conversations."), iconPath: new vscode.ThemeIcon('folder-opened'), openFolder: true };
		picker.items = [item];
		return new Promise(resolve => {
			picker.onDidAccept(() => {
				picker.hide();
				void (deps.openFolder ? deps.openFolder() : vscode.commands.executeCommand('vscode.openFolder'));
			});
			picker.onDidHide(() => {
				picker.dispose();
				resolve();
			});
			picker.show();
		});
	}
	const now = deps.now ?? Date.now;
	const pager = deps.conversations.open({ environment: catalog.locations[0].environment, directories: [...new Set(catalog.locations.map(location => location.path))] });
	const entries: ConversationEntry[] = [];
	const seen = new Set<string>();
	let done = false;
	let open = true;
	let reading: Promise<void> | undefined;
	const reals = catalog.locations.map(location => ({ location, real: realFolderOf(location.path) }));
	const places = new Map<string, string>();
	const placeIn = (cwd: string) => places.get(cwd) ?? places.set(cwd, placeOf(cwd, reals, catalog)).get(cwd)!;
	// One line (LIFECYCLE-3.2, D64): its icon names its CLI; when, then where - what a long title cuts off last comes first
	const itemOf = (entry: ConversationEntry): Item => ({
		label: plainText(entry.title?.trim() || vscode.l10n.t("Untitled conversation")),
		description: [entry.activityAt !== undefined ? ago(entry.activityAt, now(), deps.language) : undefined, (entry.cwdChoices ?? [entry.cwd]).map(placeIn).join(', ')].filter(Boolean).map(text => plainText(text!)).join(' · '),
		iconPath: cliIcon(deps.media, entry.key.cli),
		entry
	});
	const show = () => {
		const active = picker.activeItems[0]?.entry;
		picker.items = entries.map(itemOf);
		const again = active && picker.items.find(item => item.entry === active);
		if (again) {
			picker.activeItems = [again];
		}
		if (done && !entries.length) {
			picker.placeholder = vscode.l10n.t("No saved conversations in this window's folders");
		}
	};
	/** Reads the next batch, once at a time; deduplicated by environment, CLI and session ID, most recent first. */
	const readNext = (): Promise<void> => reading ??= (async () => {
		picker.busy = true;
		try {
			const before = entries.length;
			do {
				const batch = await pager.next();
				if (!open) {
					return;
				}
				for (const entry of batch.entries) {
					const id = conversationId(entry.key);
					// One that cannot be resumed now - its folder gone, its CLI off or not installed (D64) - or already runs is not offered (D69)
					if (!seen.has(id) && entry.unavailable === undefined && !deps.running(entry.key)) {
						seen.add(id);
						entries.push(entry);
					}
				}
				entries.sort((a, b) => (b.activityAt ?? Number.NEGATIVE_INFINITY) - (a.activityAt ?? Number.NEGATIVE_INFINITY));
				done = batch.done;
			} while (open && !done && entries.length === before);
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
	})();
	/** A search goes on past what was read, batch after batch, while it is typed (LIFECYCLE-3.2). */
	const readAll = async () => {
		while (open && !done && picker.value.trim()) {
			await readNext();
		}
	};
	void readNext();
	return new Promise(resolve => {
		let accepting = false;
		const subscriptions: vscode.Disposable[] = [
			picker.onDidChangeValue(() => void readAll()),
			picker.onDidChangeActive(([active]) => {
				if (!done && active && picker.items.indexOf(active) >= picker.items.length - READ_AHEAD) {
					void readNext();
				}
			}),
			picker.onDidAccept(async () => {
				let entry = picker.activeItems[0]?.entry;
				if (!entry) {
					return;
				}
				accepting = true;
				picker.hide();
				const title = entry.title?.trim() || vscode.l10n.t("Untitled conversation");
				let result: ReturnType<ResumeDeps['resume']>;
				try {
					if (entry.cwdChoices?.length) {
						const flow = new Flow();
						const chosen = await flow.pick({ title: vscode.l10n.t("Resume Agent"), placeholder: vscode.l10n.t("Select a working location"),
							items: entry.cwdChoices.map(cwd => ({ label: placeIn(cwd), description: cwd, cwd })), matchOnDescription: true });
						flow.close();
						if (!chosen || chosen === BACK) { resolve(); return; }
						entry = { ...entry, cwd: chosen.item.cwd, cwdChoices: undefined };
					}
					result = deps.resume(entry);
				} catch (err) {
					deps.notifyError(vscode.l10n.t("Could not resume {0}: {1}", title, messageOf(err)), {});
					resolve();
					return;
				}
				if (typeof result === 'string') {
					deps.select(result);
				} else if (result.running === 'elsewhere') {
					deps.notifyError(vscode.l10n.t("{0} is already running in another window.", title), {});
				} else {
					void deps.reveal(result.running);
				}
				resolve();
			}),
			picker.onDidHide(() => {
				open = false;
				subscriptions.forEach(each => each.dispose());
				pager.dispose();
				picker.dispose();
				if (!accepting) { resolve(); }
			})
		];
		picker.show();
	});
}
