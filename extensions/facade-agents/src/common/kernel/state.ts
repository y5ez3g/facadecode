/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KernelState, LedgerEvent, Message, Participant } from './model';

/*
 * The state a workspace's ledger replays into. Pure: the same events give the same state, which is
 * what lets a reload lose nothing. Notices are not made here; the kernel writes them as messages of
 * their own, so replaying them is replaying messages.
 */

const LAST_SAID_CHARS = 160;

export function createKernelState(): KernelState {
	return {
		seq: 0,
		participants: new Map(),
		messages: [],
		inboxes: new Map(),
		cursors: new Map(),
		pages: new Map(),
		readers: new Map(),
		folderWatchers: new Map(),
		tokens: new Map()
	};
}

export function applyKernelEvent(state: KernelState, event: LedgerEvent): void {
	state.seq = event.seq;
	switch (event.type) {
		case 'participant.joined': {
			const previous = state.participants.get(event.name);
			for (const [hash, owner] of state.tokens) {
				if (owner.name === event.name) {
					// A new incarnation: the old one's token stops working.
					state.tokens.delete(hash);
				}
			}
			const participant: Participant = {
				name: event.name,
				incarnation: event.incarnation,
				kind: event.kind,
				agent: event.agent,
				place: event.place,
				startedBy: event.startedBy,
				text: event.text,
				state: event.kind === 'person' ? 'idle' : 'starting',
				stateAt: event.ts,
				groups: new Set(event.groups),
				tokenHash: event.tokenHash,
				joinedAt: previous?.joinedAt ?? event.ts,
				lastSaid: previous?.lastSaid,
				lastSaidAt: previous?.lastSaidAt
			};
			state.participants.set(event.name, participant);
			if (event.tokenHash) {
				state.tokens.set(event.tokenHash, { name: event.name, incarnation: event.incarnation });
			}
			return;
		}
		case 'participant.state': {
			const participant = current(state, event.name, event.incarnation);
			if (participant) {
				participant.state = event.state;
				participant.stateDetail = event.detail;
				participant.stateAt = event.ts;
				if ((event.state === 'stopped' || event.state === 'failed') && participant.tokenHash) {
					// Gone for good: whatever is left of its process is no longer heard.
					state.tokens.delete(participant.tokenHash);
				}
			}
			return;
		}
		case 'participant.usage': {
			const participant = current(state, event.name, event.incarnation);
			if (participant) {
				participant.usage = event.usage;
			}
			return;
		}
		case 'group.joined':
			state.participants.get(event.name)?.groups.add(event.group);
			return;
		case 'group.left':
			state.participants.get(event.name)?.groups.delete(event.group);
			return;
		case 'message.sent': {
			const message: Message = {
				seq: event.seq,
				ts: event.ts,
				from: event.from,
				to: event.to,
				recipients: event.recipients,
				text: event.text,
				replyTo: event.replyTo,
				notice: event.notice
			};
			state.messages.push(message);
			for (const name of event.recipients) {
				let inbox = state.inboxes.get(name);
				if (!inbox) {
					inbox = [];
					state.inboxes.set(name, inbox);
				}
				inbox.push(message);
			}
			const sender = state.participants.get(event.from);
			if (sender && !event.notice) {
				sender.lastSaid = event.text.replace(/\s+/g, ' ').trim().slice(0, LAST_SAID_CHARS);
				sender.lastSaidAt = event.ts;
			}
			return;
		}
		case 'cursor.moved':
			state.cursors.set(event.name, Math.max(state.cursors.get(event.name) ?? 0, event.cursor));
			return;
		case 'page.written': {
			const before = state.pages.get(event.page);
			const existedBefore = !!before && !before.deleted;
			state.pages.set(event.page, {
				page: event.page,
				version: event.version,
				author: event.author,
				ts: event.ts,
				hash: event.hash,
				size: event.size,
				deleted: !!event.deleted
			});
			// Everyone who read the page has now heard it changed; the writer holds the new version.
			const readers = new Map<string, number>();
			if (event.author && !event.deleted) {
				readers.set(event.author, event.version);
			}
			state.readers.set(event.page, readers);
			if (existedBefore !== !event.deleted) {
				// A page came or went: everyone watching a folder it is in has heard it, bar its author.
				for (const folder of foldersOf(event.page)) {
					const watchers = state.folderWatchers.get(folder);
					if (!watchers) {
						continue;
					}
					for (const name of [...watchers]) {
						if (name !== event.author) {
							watchers.delete(name);
						}
					}
				}
			}
			return;
		}
		case 'page.read': {
			let readers = state.readers.get(event.page);
			if (!readers) {
				readers = new Map();
				state.readers.set(event.page, readers);
			}
			readers.set(event.name, event.version);
			return;
		}
		case 'folder.listed': {
			let watchers = state.folderWatchers.get(event.folder);
			if (!watchers) {
				watchers = new Set();
				state.folderWatchers.set(event.folder, watchers);
			}
			watchers.add(event.name);
			return;
		}
	}
}

/** The participant, if `incarnation` is still the current one. */
function current(state: KernelState, name: string, incarnation: number): Participant | undefined {
	const participant = state.participants.get(name);
	return participant && participant.incarnation === incarnation ? participant : undefined;
}

/** Every folder a page sits in, the root (`''`) first: `a/b/c` is in `''`, `a` and `a/b`. */
export function foldersOf(page: string): string[] {
	const parts = page.split('/');
	const folders = [''];
	for (let i = 1; i < parts.length; i++) {
		folders.push(parts.slice(0, i).join('/'));
	}
	return folders;
}
