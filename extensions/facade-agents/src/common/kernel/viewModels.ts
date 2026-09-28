/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Kernel, ListEntry, ParticipantView } from './kernel';
import { Message, ParticipantState, YOU } from './model';

/*
 * What the views of step 32 draw, worked out without `vscode` so that it can be tested: a row per
 * participant, the notebook as folders of pages, the messages that need the person, and the
 * conversation as the Messages view shows it.
 */

export interface ParticipantRow {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly tooltip: string;
	/** A codicon id, with `~spin` for one that turns. */
	readonly icon: string;
	/** What the row's menu offers: `person`, `agent` for a running agent, `agentGone` for a stopped one. */
	readonly contextValue: 'person' | 'agent' | 'agentGone';
	readonly state: ParticipantState;
}

const STATE_ICONS: { readonly [state in ParticipantState]: string } = {
	starting: 'loading~spin',
	working: 'sync~spin',
	waiting: 'bell-dot',
	idle: 'circle-outline',
	stopped: 'circle-slash',
	failed: 'error'
};

export function participantRow(view: ParticipantView, now: number): ParticipantRow {
	const person = view.kind === 'person';
	const cost = view.usage?.costUsd !== undefined ? `$${view.usage.costUsd.toFixed(2)}` : undefined;
	const description = person
		? `the person${view.unread ? ` · ${view.unread} unread` : ''}`
		: [view.agent, view.state, cost].filter(Boolean).join(' · ');
	const tooltip = [
		`@${view.name}${view.incarnation > 1 ? ` (incarnation ${view.incarnation})` : ''}`,
		person ? 'The person.' : `${view.agent ?? 'agent'}: ${view.state}${view.stateDetail ? ` (${view.stateDetail})` : ''} for ${ago(now - view.since)}.`,
		view.place ? `Works in ${view.place}.` : undefined,
		view.startedBy ? `Started by @${view.startedBy}.` : undefined,
		view.groups.length ? `Groups: ${view.groups.map(group => `#${group}`).join(', ')}.` : undefined,
		view.lastSaid ? `Last said: ${view.lastSaid}` : undefined,
		cost ? `Cost so far: ${cost}.` : undefined
	].filter(Boolean).join('\n');
	return {
		name: view.name,
		label: `@${view.name}`,
		description,
		tooltip,
		icon: person ? 'account' : STATE_ICONS[view.state],
		contextValue: person ? 'person' : view.state === 'stopped' || view.state === 'failed' ? 'agentGone' : 'agent',
		state: view.state
	};
}

export interface PageNode {
	readonly kind: 'folder' | 'page';
	/** The folder's or the page's path. */
	readonly path: string;
	/** The last part of it. */
	readonly label: string;
	readonly entry?: ListEntry;
	readonly children: PageNode[];
}

/** The notebook's pages as a tree of folders: folders first, each level in order of name. */
export function pageTree(entries: readonly ListEntry[]): PageNode[] {
	const root: PageNode[] = [];
	const folders = new Map<string, PageNode>();
	const childrenOf = (folder: string): PageNode[] => {
		if (!folder) {
			return root;
		}
		let node = folders.get(folder);
		if (!node) {
			const slash = folder.lastIndexOf('/');
			node = { kind: 'folder', path: folder, label: folder.slice(slash + 1), children: [] };
			folders.set(folder, node);
			childrenOf(slash < 0 ? '' : folder.slice(0, slash)).push(node);
		}
		return node.children;
	};
	for (const entry of entries) {
		const slash = entry.page.lastIndexOf('/');
		childrenOf(slash < 0 ? '' : entry.page.slice(0, slash)).push({ kind: 'page', path: entry.page, label: entry.page.slice(slash + 1), entry, children: [] });
	}
	const sort = (nodes: PageNode[]) => {
		nodes.sort((a, b) => a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'folder' ? -1 : 1);
		nodes.forEach(node => sort(node.children));
	};
	sort(root);
	return root;
}

/** The messages to the person that they have not taken yet, notices left out: what needs them. */
export function needsYou(kernel: Kernel): Message[] {
	return kernel.messagesAfter(YOU, kernel.cursor(YOU), 1000).filter(message => !message.notice);
}

export interface ChatMessage {
	readonly seq: number;
	readonly ts: number;
	readonly from: string;
	readonly to: string;
	readonly text: string;
	readonly replyTo?: number;
	readonly notice: boolean;
	/** Sent to the person, or by them. */
	readonly mine: boolean;
}

/** The conversation, oldest first: the last `limit` messages, notices included for the view to dim. */
export function conversation(kernel: Kernel, limit: number): ChatMessage[] {
	const messages = kernel.state.messages;
	return messages.slice(Math.max(0, messages.length - limit)).map(message => ({
		seq: message.seq,
		ts: message.ts,
		from: message.from,
		to: message.to.join(', '),
		text: message.text,
		replyTo: message.replyTo,
		notice: !!message.notice,
		mine: message.from === YOU || message.recipients.includes(YOU)
	}));
}

/** The addresses the person can write to: every participant but themselves, and every group. */
export function addresses(kernel: Kernel): string[] {
	const groups = new Set<string>();
	const names: string[] = [];
	for (const participant of kernel.state.participants.values()) {
		if (participant.name !== YOU) {
			names.push(`@${participant.name}`);
		}
		participant.groups.forEach(group => groups.add(`#${group}`));
	}
	return [...[...groups].sort(), ...names.sort()];
}

export function ago(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
