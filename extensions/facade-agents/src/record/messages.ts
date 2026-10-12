/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { readLastNumber, replaceFile } from '../base/files';
import { JsonObject } from '../base/json';
import type { Ledger } from './ledger';

/** The person's mailbox, as the ledger writes a message to the person, who has no number. */
export const HUMAN = 'human';
/** Facade's own name: no agent takes it, and the ledger writes it as the sender of a message of its own. */
export const FACADE = 'facade';
/**
 * The most of a message's text a ledger line holds, and the most of the texts one fetch gives in its
 * result: past it, the text is in a file of the record's.
 */
export const TEXT_IN_LINE = 8_000;
/** The first number a message gets: numbers count up from it, and none is given twice within a workspace. */
const FIRST_MESSAGE = 1;
/** The record's folder of message files: texts too long for a ledger line, and fetches too long for a result. */
const MESSAGES_DIR = 'messages';
/**
 * The highest number given to a message, beside the ledger: written before the number is used - `last-message`
 * - and, read too, what it was called while a task was the only message, in a file of its own.
 */
export const LAST_MESSAGE_FILES: readonly string[] = ['last-message', 'last-message-id'];
/** A long text's file, by its message's number. */
const TEXT_FILE = /^m(?<id>\d+)\.txt$/;
/** A fetch's file, by its recipient - `a7`, or the person - and the count of its fetches. */
const FETCH_FILE = /^fetch-(?:a(?<agent>\d+)|human)-\d+\.txt$/;

/** Whose mailbox: an agent's, by its number, or the person's. */
export type Recipient = number | typeof HUMAN;

/**
 * What a message of Facade's is: a message going back to its sender, a child that ended, a task not
 * fetched, or messages that waited unfetched for the timeout.
 */
export type FacadeKind = 'returned' | 'ended' | 'taskNotFetched' | 'delayed';

const FACADE_KINDS: ReadonlySet<string> = new Set<FacadeKind>(['returned', 'ended', 'taskNotFetched', 'delayed']);

function isFacadeKind(value: unknown): value is FacadeKind {
	return typeof value === 'string' && FACADE_KINDS.has(value);
}

/** A message, as the ledger keeps it: its number is its handle, written `#m42`. */
export interface Message {
	readonly id: number;
	/** The agent that sent it, or Facade; none for the person. */
	readonly from?: number | typeof FACADE;
	readonly to: Recipient;
	/** Its text, where it is {@link TEXT_IN_LINE} characters or fewer; else `file` holds it. */
	readonly text?: string;
	/** The file of the record's `messages` folder that holds a longer text: `m42.txt`. */
	readonly file?: string;
	/** How many characters its text has. */
	readonly length: number;
	/** The message it answers. */
	readonly replyTo?: number;
	/** Set on an agent's task: its creator's message to it, sent as it started. */
	readonly task?: true;
	/** What a message of Facade's is. */
	readonly facade?: FacadeKind;
	/** The agent a message of Facade's is about. */
	readonly about?: number;
	/** When it was sent. */
	readonly time: number;
}

/** A message in its recipient's mailbox. */
export interface MailboxEntry {
	/** Unread until a result that holds it is delivered, or it goes back as its recipient ends. */
	state: 'unread' | 'delivered' | 'returned';
	/** When the results that held it went out to its recipient, oldest first. */
	readonly given: number[];
	/** How many doorbells named it. */
	rings: number;
}

/** A message that went back as its recipient ended, or could not, or needed not. */
export interface Return {
	/** How its recipient ended. */
	readonly reason: string;
	/** The message of Facade's that took it back; none where it could not go back, or needed not. */
	readonly as?: number;
	/** Set where it needed not go back: its sender was told of the end otherwise - by the start that failed, or the window closing. */
	readonly known?: true;
	readonly time: number;
}

/** What the chat rooms hold, in the order it came: a message, or - `unreturned` - the note that it could not go back. */
export interface RoomLine {
	readonly message: number;
	readonly unreturned?: true;
}

/** What a workspace's ledger says of its messages. */
export interface MessagesState {
	/** The highest number given to a message so far. */
	lastMessage: number;
	/** Every message the ledger has, by number. */
	readonly messages: Map<number, Message>;
	/**
	 * The messages the mailboxes hold, by number: those sent since the list was last cleared, and those of
	 * agents that ran on through it.
	 */
	readonly entries: Map<number, MailboxEntry>;
	/** Each mailbox's messages, by number. */
	readonly mailboxes: Map<Recipient, number[]>;
	/** The messages that went back as their recipients ended, or could not. */
	readonly returns: Map<number, Return>;
	/** When each agent was last rung. */
	readonly rungAt: Map<number, number>;
	/** When a result with each agent's own messages was last delivered to it. */
	readonly fetchedAt: Map<number, number>;
	/** When each agent's mailbox was last left with nothing unread, by a result delivered to it. */
	readonly drainedAt: Map<number, number>;
	/** When Facade last told of each agent's messages waiting unfetched for the timeout. */
	readonly delayedAt: Map<number, number>;
	/** When each agent was last given the messages of others it fetched by number: by its number, then theirs. */
	readonly seen: Map<number, Map<number, number>>;
	/** Each agent's task, by the agent's number. */
	readonly tasks: Map<number, number>;
	/** The agents whose creators were told that they had not fetched their tasks. */
	readonly notFetched: Set<number>;
	/** What the chat rooms hold since they were last deleted, in order. */
	readonly roomLines: RoomLine[];
	/** No chat room is written again for a message up to this number: Delete Chat Rooms deleted them. */
	roomsDeletedUpTo: number;
}

/** The ledger's events of messages. */
export type MessageEventBody =
	| {
		readonly type: 'message.sent';
		readonly id: number;
		readonly from?: number | typeof FACADE;
		readonly to: Recipient;
		readonly text?: string;
		readonly file?: string;
		readonly length: number;
		readonly replyTo?: number;
		readonly task?: true;
		readonly facade?: FacadeKind;
		readonly about?: number;
	}
	/** A result with these messages, as it goes out to the agent's pipe. */
	| { readonly type: 'message.given'; readonly agent: number; readonly ids: readonly number[] }
	/** The pipe wrote that result. */
	| { readonly type: 'message.delivered'; readonly agent: number; readonly ids: readonly number[] }
	/** A doorbell typed into the agent's terminal, and the messages it named. */
	| { readonly type: 'mailbox.rang'; readonly agent: number; readonly ids: readonly number[] }
	/** A message's recipient ended with it unread: `as` took it back to its sender; none where it could not go back, or - `known` - needed not. */
	| { readonly type: 'message.returned'; readonly id: number; readonly reason: string; readonly as?: number; readonly known?: true }
	/** Delete Chat Rooms: the rooms and the message files are gone, and none is written again for a message up to `upTo`. */
	| { readonly type: 'rooms.deleted'; readonly upTo: number };

/** The messages of a workspace with no ledger yet: none, the next number the first. */
export function createMessagesState(): MessagesState {
	return {
		lastMessage: FIRST_MESSAGE - 1,
		messages: new Map(),
		entries: new Map(),
		mailboxes: new Map(),
		returns: new Map(),
		rungAt: new Map(),
		fetchedAt: new Map(),
		drainedAt: new Map(),
		delayedAt: new Map(),
		seen: new Map(),
		tasks: new Map(),
		notFetched: new Set(),
		roomLines: [],
		roomsDeletedUpTo: 0
	};
}

/** Whether `value` is a number an agent or a message can have: both count from 1. */
export function isId(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Whether `value` is a list of numbers, at least one, none twice. */
function isNumbers(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.length > 0 && value.every(isId) && new Set(value).size === value.length;
}

/** An event of messages read from the ledger, each field checked for what it may hold; undefined when the line is no such event. */
export function messageBodyOf(value: JsonObject): MessageEventBody | undefined {
	switch (value.type) {
		case 'message.sent': {
			const { id, from, to, text, file, length, replyTo, task, facade, about } = value;
			const inLine = typeof text === 'string' && text.length > 0 && text.length <= TEXT_IN_LINE && length === text.length && file === undefined;
			const inFile = text === undefined && typeof file === 'string' && TEXT_FILE.exec(file)?.groups?.id === String(id) && isId(length) && length > TEXT_IN_LINE;
			if (!isId(id) || (from !== undefined && from !== FACADE && !isId(from)) || (to !== HUMAN && !isId(to)) || !(inLine || inFile) || !isId(length)
				|| (replyTo !== undefined && !isId(replyTo)) || (task !== undefined && task !== true)
				|| (facade !== undefined && !isFacadeKind(facade)) || (facade !== undefined) !== (from === FACADE)
				|| (about !== undefined && !isId(about))) {
				return undefined;
			}
			return {
				type: 'message.sent', id,
				...(from !== undefined ? { from } : {}), to,
				...(inLine ? { text } : { file }), length,
				...(replyTo !== undefined ? { replyTo } : {}), ...(task ? { task } : {}),
				...(facade !== undefined ? { facade } : {}), ...(about !== undefined ? { about } : {})
			};
		}
		case 'message.given':
		case 'message.delivered':
		case 'mailbox.rang': {
			const { agent, ids } = value;
			return isId(agent) && isNumbers(ids) ? { type: value.type, agent, ids: [...ids] } : undefined;
		}
		case 'message.returned': {
			const { id, reason, as, known } = value;
			return isId(id) && typeof reason === 'string' && reason.length > 0 && (as === undefined || isId(as)) && (known === undefined || (known === true && as === undefined))
				? { type: 'message.returned', id, reason, ...(as !== undefined ? { as } : {}), ...(known ? { known } : {}) }
				: undefined;
		}
		case 'rooms.deleted': {
			const { upTo } = value;
			return isId(upTo) ? { type: 'rooms.deleted', upTo } : undefined;
		}
	}
	return undefined;
}

/**
 * Whether an event of messages can follow what the ledger gave so far: a message goes under a number
 * above every one given, from and to agents the ledger started, answering one there is, and a task to
 * an agent from its creator, once; given, delivered and rung messages are in their mailboxes, rung
 * ones in the agent's own; a message goes back from its mailbox once, and only as a message of
 * Facade's that takes messages back; chat rooms are deleted up to a message there is.
 */
export function fitsMessages(agents: ReadonlyMap<number, { readonly creator?: number }>, state: MessagesState, event: MessageEventBody): boolean {
	switch (event.type) {
		case 'message.sent': {
			const known = (id: number | undefined) => id === undefined || agents.has(id);
			const to = typeof event.to === 'number' ? agents.get(event.to) : undefined;
			return event.id > state.lastMessage
				&& (event.from === FACADE || known(event.from))
				&& (event.to === HUMAN || !!to)
				&& known(event.about)
				&& (event.replyTo === undefined || state.messages.has(event.replyTo))
				&& (!event.task || (!!to && event.from !== FACADE && to.creator === event.from && !state.tasks.has(event.to as number)));
		}
		case 'message.given':
			return agents.has(event.agent) && event.ids.every(id => state.entries.has(id));
		case 'message.delivered':
			return agents.has(event.agent) && event.ids.every(id => state.messages.has(id));
		case 'mailbox.rang':
			return agents.has(event.agent) && event.ids.every(id => state.entries.has(id) && state.messages.get(id)?.to === event.agent);
		case 'message.returned':
			return state.entries.get(event.id)?.state === 'unread' && (event.as === undefined || state.messages.get(event.as)?.facade === 'returned');
		case 'rooms.deleted':
			return event.upTo <= state.lastMessage && event.upTo >= state.roomsDeletedUpTo;
	}
}

/** Applies one event of messages, at `time`, to what the ledger is replayed into. */
export function applyMessages(state: MessagesState, event: MessageEventBody, time: number): void {
	switch (event.type) {
		case 'message.sent': {
			state.messages.set(event.id, {
				id: event.id,
				...(event.from !== undefined ? { from: event.from } : {}),
				to: event.to,
				...(event.text !== undefined ? { text: event.text } : { file: event.file }),
				length: event.length,
				...(event.replyTo !== undefined ? { replyTo: event.replyTo } : {}),
				...(event.task ? { task: event.task } : {}),
				...(event.facade !== undefined ? { facade: event.facade } : {}),
				...(event.about !== undefined ? { about: event.about } : {}),
				time
			});
			// The person's messages are delivered as they are recorded: shown at once, and never returned
			state.entries.set(event.id, { state: event.to === HUMAN ? 'delivered' : 'unread', given: [], rings: 0 });
			mailboxOf(state, event.to).push(event.id);
			state.lastMessage = Math.max(state.lastMessage, event.id);
			if (event.task && typeof event.to === 'number') {
				state.tasks.set(event.to, event.id);
			}
			if (event.facade === 'taskNotFetched' && event.about !== undefined) {
				state.notFetched.add(event.about);
			}
			if (event.facade === 'delayed' && event.about !== undefined) {
				state.delayedAt.set(event.about, time);
			}
			state.roomLines.push({ message: event.id });
			break;
		}
		case 'message.given':
			for (const id of event.ids) {
				if (state.messages.get(id)?.to === event.agent) {
					state.entries.get(id)?.given.push(time);
				} else {
					let seen = state.seen.get(event.agent);
					if (!seen) {
						seen = new Map();
						state.seen.set(event.agent, seen);
					}
					seen.set(id, time);
				}
			}
			break;
		case 'message.delivered': {
			let own = false;
			for (const id of event.ids) {
				const entry = state.entries.get(id);
				if (entry && state.messages.get(id)?.to === event.agent) {
					own = true;
					if (entry.state === 'unread') {
						entry.state = 'delivered';
					}
				}
			}
			if (own) {
				state.fetchedAt.set(event.agent, time);
				if (!(state.mailboxes.get(event.agent) ?? []).some(id => state.entries.get(id)?.state === 'unread')) {
					state.drainedAt.set(event.agent, time);
				}
			}
			break;
		}
		case 'mailbox.rang':
			state.rungAt.set(event.agent, time);
			for (const id of event.ids) {
				const entry = state.entries.get(id);
				if (entry) {
					entry.rings++;
				}
			}
			break;
		case 'message.returned': {
			const entry = state.entries.get(event.id);
			if (entry) {
				entry.state = 'returned';
			}
			state.returns.set(event.id, { reason: event.reason, ...(event.as !== undefined ? { as: event.as } : {}), ...(event.known ? { known: event.known } : {}), time });
			if (event.as === undefined) {
				state.roomLines.push({ message: event.id, unreturned: true });
			}
			break;
		}
		case 'rooms.deleted': {
			state.roomsDeletedUpTo = event.upTo;
			const kept = state.roomLines.filter(line => line.message > event.upTo);
			state.roomLines.splice(0, state.roomLines.length, ...kept);
			break;
		}
	}
}

/**
 * Empties the mailboxes as the list is cleared - a start of the window that is not a reload - but
 * those of the agents that `runs` says ran on through it, as after a window that crashed: a message
 * taken out is in the chat rooms only.
 */
export function clearMailboxes(state: MessagesState, runs: (agent: number) => boolean): void {
	for (const [recipient, ids] of [...state.mailboxes]) {
		if (recipient !== HUMAN && runs(recipient)) {
			continue;
		}
		for (const id of ids) {
			state.entries.delete(id);
		}
		state.mailboxes.delete(recipient);
		if (recipient !== HUMAN) {
			state.rungAt.delete(recipient);
			state.fetchedAt.delete(recipient);
			state.drainedAt.delete(recipient);
			state.delayedAt.delete(recipient);
			state.seen.delete(recipient);
		}
	}
}

/** The messages in `recipient`'s mailbox, by number. */
function mailboxOf(state: MessagesState, recipient: Recipient): number[] {
	let ids = state.mailboxes.get(recipient);
	if (!ids) {
		ids = [];
		state.mailboxes.set(recipient, ids);
	}
	return ids;
}

/** The unread messages in `recipient`'s mailbox, by number. */
export function unreadOf(state: MessagesState, recipient: Recipient): Message[] {
	return (state.mailboxes.get(recipient) ?? [])
		.filter(id => state.entries.get(id)?.state === 'unread')
		.map(id => state.messages.get(id))
		.filter((message): message is Message => !!message);
}

/** A message to record: its number, and where its text goes, are the record's to give. */
export interface NewMessage {
	readonly from?: number | typeof FACADE;
	readonly to: Recipient;
	readonly text: string;
	readonly replyTo?: number;
	readonly task?: true;
	readonly facade?: FacadeKind;
	readonly about?: number;
}

/**
 * A workspace's messages as its ledger records them, and the files beside it: `last-message`, and in
 * `messages/` the texts too long for a ledger line and the fetches too long for a result, readable by
 * the user only. A long text's file stays while a mailbox or a chat room needs it; a fetch's file, as
 * long as its session.
 */
export class MessageRecord {

	/** The highest number given, as `last-message` says it: a ledger begun anew counts on from it. */
	private lastMessage: number;

	constructor(private readonly dir: string, private readonly ledger: Ledger) {
		this.lastMessage = Math.max(...LAST_MESSAGE_FILES.map(file => readLastNumber(path.join(dir, file))));
	}

	/** What the ledger says of the messages now. */
	get state(): MessagesState {
		return this.ledger.state.mail;
	}

	/** The folder of the message files: a CLI is let read it. */
	get folder(): string {
		return path.join(this.dir, MESSAGES_DIR);
	}

	/**
	 * Records a message under the next number, its text in a file of its own where it is longer than a
	 * ledger line holds. The number is written before it is used: one the ledger missed is never given
	 * again either. Nothing is written once the ledger is closed, or another window's.
	 */
	send(message: NewMessage): Message {
		this.ledger.assertOpen();
		const id = Math.max(this.state.lastMessage, this.lastMessage) + 1;
		replaceFile(path.join(this.dir, LAST_MESSAGE_FILES[0]), String(id));
		this.lastMessage = id;
		const { text, ...fields } = message;
		let place: { readonly text: string } | { readonly file: string } = { text };
		if (text.length > TEXT_IN_LINE) {
			const file = `m${id}.txt`;
			this.write(file, text);
			place = { file };
		}
		this.ledger.append({ type: 'message.sent', id, ...fields, ...place, length: text.length });
		const sent = this.state.messages.get(id);
		if (!sent) {
			throw new Error(`The ledger did not record #m${id}.`);
		}
		return sent;
	}

	/** Records that a result with these messages goes out to `agent`'s pipe. */
	given(agent: number, ids: readonly number[]): void {
		if (ids.length) {
			this.ledger.append({ type: 'message.given', agent, ids });
		}
	}

	/** Records that the pipe wrote the result with these messages to `agent`. */
	delivered(agent: number, ids: readonly number[]): void {
		if (ids.length) {
			this.ledger.append({ type: 'message.delivered', agent, ids });
		}
	}

	/** Records a doorbell typed into `agent`'s terminal, naming these messages. */
	rang(agent: number, ids: readonly number[]): void {
		if (ids.length) {
			this.ledger.append({ type: 'mailbox.rang', agent, ids });
		}
	}

	/**
	 * Records that a message went back to its sender `as` that message of Facade's, or that it could not,
	 * or - `known` - needed not.
	 */
	returned(id: number, reason: string, { as, known }: { readonly as?: number; readonly known?: true } = {}): void {
		this.ledger.append({ type: 'message.returned', id, reason, ...(as !== undefined ? { as } : {}), ...(known ? { known } : {}) });
	}

	/** Records that the chat rooms were deleted, up to the last message: the notes since the last deletion too. */
	roomsDeleted(): void {
		if (this.state.lastMessage > this.state.roomsDeletedUpTo || this.state.roomLines.length) {
			this.ledger.append({ type: 'rooms.deleted', upTo: this.state.lastMessage });
		}
	}

	/** A message's text: from its ledger line, or its file; undefined for one whose file is gone with the chat rooms. */
	textOf(message: Message): string | undefined {
		if (message.text !== undefined) {
			return message.text;
		}
		try {
			return fs.readFileSync(path.join(this.folder, message.file ?? ''), 'utf8');
		} catch (err) {
			if (codeOf(err) === 'ENOENT') {
				return undefined;
			}
			throw err;
		}
	}

	/**
	 * Writes the texts of a fetch too long for its result into a file of their own, for `recipient`, under
	 * the next number of its fetches' files; answers its path.
	 */
	writeFetch(recipient: Recipient, content: string): string {
		const prefix = `fetch-${recipient === HUMAN ? HUMAN : `a${recipient}`}-`;
		let last = 0;
		for (const name of this.files()) {
			const n = name.startsWith(prefix) ? Number(name.slice(prefix.length, -'.txt'.length)) : NaN;
			if (Number.isInteger(n) && n > last) {
				last = n;
			}
		}
		return this.write(`${prefix}${last + 1}.txt`, content);
	}

	/** Deletes the files of long texts, but those of the messages `keep` names. */
	deleteTexts(keep: (id: number) => boolean): void {
		for (const name of this.files()) {
			const id = TEXT_FILE.exec(name)?.groups?.id;
			if (id !== undefined && !keep(Number(id))) {
				fs.rmSync(path.join(this.folder, name), { force: true });
			}
		}
	}

	/** Deletes the files of fetches, but those of the agents `keep` names: a fetch's file lasts as long as its session. */
	deleteFetches(keep: (agent: number) => boolean): void {
		for (const name of this.files()) {
			const match = FETCH_FILE.exec(name);
			if (match && (match.groups?.agent === undefined || !keep(Number(match.groups.agent)))) {
				fs.rmSync(path.join(this.folder, name), { force: true });
			}
		}
	}

	/** The names of the message files: none where the folder is not there yet. */
	private files(): string[] {
		try {
			return fs.readdirSync(this.folder);
		} catch (err) {
			if (codeOf(err) === 'ENOENT') {
				return [];
			}
			throw err;
		}
	}

	/** Writes `content` to the file `name` of the message files, readable by the user only; answers its path. */
	private write(name: string, content: string): string {
		fs.mkdirSync(this.folder, { recursive: true });
		const file = path.join(this.folder, name);
		fs.writeFileSync(file, content, { mode: 0o600 });
		return file;
	}
}
