/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { displayLine, inertCommandLinks } from '../../base/text';
import type { MessageRecord } from '../../core/messagePorts';
import { ago } from '../presentation';

type Party = MessageRecord['from'] | MessageRecord['to'];

/** One one-to-one conversation of Message History (COLLABORATION-3.2): its two sides, its records oldest first. */
export interface Conversation {
	/** Its two sides' run IDs (or `@human`, `facade`), sorted and joined: what its document is opened by. */
	readonly key: string;
	readonly sides: readonly [Party, Party];
	readonly records: readonly MessageRecord[];
	/** The time of its latest record. */
	readonly last: number;
}

/**
 * The records grouped into one-to-one conversations, the most recently active first. A Facade result belongs with the message it
 * reports on; one about another operation, or whose message expired, is a conversation of Facade with its recipient. Each side is
 * named as its latest record names it.
 */
export function conversationsOf(records: readonly MessageRecord[]): Conversation[] {
	const byId = new Map(records.map(record => [record.id, record]));
	const latest = new Map<string, Party>();
	for (const record of records) {
		for (const party of [record.from, record.to]) {
			if (party.name !== undefined || !latest.has(party.run)) {
				latest.set(party.run, party);
			}
		}
	}
	const groups = new Map<string, { sides: [string, string]; records: MessageRecord[] }>();
	for (const record of records) {
		const about = record.kind === 'result' && record.about !== undefined ? byId.get(record.about) : undefined;
		const anchor = about ?? record;
		const sides = [anchor.from.run, anchor.to.run].sort() as [string, string];
		const key = sides.join(' ');
		const group = groups.get(key) ?? { sides, records: [] };
		group.records.push(record);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.map(([key, group]) => {
			const ordered = group.records.sort((a, b) => numberOf(a.id) - numberOf(b.id));
			return { key, sides: [latest.get(group.sides[0])!, latest.get(group.sides[1])!] as const, records: ordered, last: Math.max(...ordered.map(record => record.at)) };
		})
		.sort((a, b) => b.last - a.last);
}

/** A side as the person sees it: the agent's name and short ID, `you` for the person, Facade for its results. */
export function sideName(party: Party): string {
	if (party.run === '@human') {
		// The person reading this, as the sender or recipient of a message: one word, as a chat app names its own user
		return vscode.l10n.t("You");
	}
	if (party.run === 'facade') {
		return 'Facade';
	}
	const name = party.name !== undefined ? displayLine(party.name, 80) : undefined;
	return [name, party.alias ?? party.run].filter(Boolean).join(' ');
}

/** A conversation's title: its two sides. */
export function conversationTitle(conversation: Conversation): string {
	// Facade, or the person, second
	const [a, b] = conversation.sides[0].run === 'facade' || conversation.sides[0].run === '@human' ? [conversation.sides[1], conversation.sides[0]] : conversation.sides;
	return `${sideName(a)} ↔ ${sideName(b)}`;
}

/**
 * A conversation as a read-only document (COLLABORATION-3.2): each record's source, recipient, time, reply relation, submission outcome
 * and Facade-result references, then its whole text - as text, links and commands in it inert.
 */
export function conversationText(conversation: Conversation, language: string): string {
	const results = new Map<string, string[]>();
	for (const record of conversation.records) {
		if (record.kind === 'result' && record.about !== undefined) {
			results.set(record.about, [...results.get(record.about) ?? [], record.alias]);
		}
	}
	const heading = [
		vscode.l10n.t("Message History: {0}", conversationTitle(conversation)),
		vscode.l10n.t("Read-only. Messages are shown as they were sent; links in them cannot run editor commands."),
		''
	];
	return `${[...heading, ...conversation.records.map(record => recordText(record, language, results.get(record.id) ?? []))].join('\n')}\n`;
}

/** One record as a document shows it: its facts, a blank line, its whole text, then a rule. */
export function recordText(record: MessageRecord, language: string, results: readonly string[] = []): string {
	const time = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }).format(record.at);
	const lines = [
		`${record.alias} · ${time}`,
		vscode.l10n.t("From: {0}", sideName(record.from)),
		vscode.l10n.t("To: {0}", sideName(record.to)),
		...record.replyTo !== undefined ? [vscode.l10n.t("In reply to: {0}", aliasOf(record.replyTo))] : [],
		...record.about !== undefined ? [vscode.l10n.t("About message: {0}", aliasOf(record.about))] : [],
		// {0} is how its delivery went, in a phrase such as "Delivered to the agent"
		vscode.l10n.t("Status: {0}", outcomeOf(record, language)),
		// {0} lists the short IDs, such as #m3, of the notes that told the sender how its message went
		...results.length ? [vscode.l10n.t("Result reported in: {0}", new Intl.ListFormat(language, { type: 'conjunction', style: 'narrow' }).format(results))] : [],
		'',
		inertCommandLinks(record.text),
		'',
		'─'.repeat(40),
		''
	];
	return lines.join('\n');
}

/** How a record's delivery went, in plain words (UX-2.4): never a reason code or input-effect field. */
function outcomeOf(record: MessageRecord, language: string): string {
	const { delivery } = record;
	if (delivery.status === 'pending') {
		return delivery.deadline !== undefined
			// {0} is the time of day Facade gives up
			? vscode.l10n.t("Being delivered; Facade stops trying at {0}", new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(delivery.deadline))
			: vscode.l10n.t("Being delivered");
	}
	if (delivery.status === 'success') {
		switch (delivery.via) {
			case 'notification': return vscode.l10n.t("Shown to you as a notification");
			case 'read': return vscode.l10n.t("Delivered when the agent checked its messages");
			case 'launch': return vscode.l10n.t("Delivered as the agent's first task");
			default: return record.to.run === '@human' ? vscode.l10n.t("Shown to you as a notification") : vscode.l10n.t("Delivered to the agent");
		}
	}
	// {0} is why, in a lowercase phrase such as "the time limit was reached"
	return vscode.l10n.t("Not delivered: {0}", failureOf(delivery.reason));
}

/** Why a message was not delivered, in plain words. */
function failureOf(reason: string | undefined): string {
	switch (reason) {
		case 'input_draft': return vscode.l10n.t("there was unsent text in the agent's input box");
		case 'input_interaction': return vscode.l10n.t("the agent was waiting for an answer, permission or sign-in");
		case 'input_unknown': return vscode.l10n.t("Facade could not tell if the agent was ready for input");
		case 'partial_input': return vscode.l10n.t("only part of the message reached the agent's input box");
		case 'submission_unconfirmed': return vscode.l10n.t("Facade could not confirm that the agent received the message");
		case 'timeout': return vscode.l10n.t("the time limit was reached");
		case 'ended': return vscode.l10n.t("the agent was no longer running");
		case 'unsupported': return vscode.l10n.t("Facade cannot type messages into the agent's CLI");
		case 'window_unavailable': return vscode.l10n.t("the agent's window could not be reached");
		default: return vscode.l10n.t("the reason is not known");
	}
}

function aliasOf(id: string): string {
	const match = /^(?:m-|#m)(\d+)$/.exec(id);
	return match ? `#m${match[1]}` : displayLine(id, 80);
}

function numberOf(id: string): number {
	return Number(id.replace(/^m-/, ''));
}

export interface MessageHistoryPickDeps {
	readonly history: () => readonly MessageRecord[];
	readonly onDidRecord: (listener: (record: MessageRecord) => void) => { dispose(): void };
	/** Opens a conversation's read-only document. */
	readonly open: (conversation: Conversation) => Promise<unknown>;
	readonly language: string;
	readonly now?: () => number;
}

type Item = vscode.QuickPickItem & { readonly conversation: Conversation };

/**
 * Message History (COLLABORATION-3.2): this window's one-to-one conversations, most recently active first, searched by their sides and
 * text; choosing one closes the picker and opens its read-only document. No composer, send, replay, delete or hide.
 */
export function pickConversation(deps: MessageHistoryPickDeps): Promise<void> {
	const now = deps.now ?? Date.now;
	const picker = vscode.window.createQuickPick<Item>();
	picker.title = vscode.l10n.t("Message History");
	picker.placeholder = vscode.l10n.t("Search by agent or message text");
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	const itemOf = (conversation: Conversation): Item => {
		const count = conversation.records.length;
		const latest = conversation.records[conversation.records.length - 1];
		return {
			label: conversationTitle(conversation),
			description: count === 1 ? vscode.l10n.t("1 message") : vscode.l10n.t("{0} messages", count),
			detail: [ago(conversation.last, now(), deps.language), displayLine(latest.text, 120)].join(' · '),
			conversation
		};
	};
	const show = () => {
		const active = picker.activeItems[0]?.conversation.key;
		const conversations = conversationsOf(deps.history());
		picker.items = conversations.map(itemOf);
		const again = picker.items.find(item => item.conversation.key === active);
		if (again) {
			picker.activeItems = [again];
		}
		if (!conversations.length) {
			picker.placeholder = vscode.l10n.t("No messages in this window yet");
		}
	};
	show();
	return new Promise(resolve => {
		const subscriptions = [
			deps.onDidRecord(() => show()),
			picker.onDidAccept(() => {
				const conversation = picker.activeItems[0]?.conversation;
				picker.hide();
				if (conversation) {
					void deps.open(conversation);
				}
			}),
			picker.onDidHide(() => {
				subscriptions.forEach(each => each.dispose());
				picker.dispose();
				resolve();
			})
		];
		picker.show();
	});
}
