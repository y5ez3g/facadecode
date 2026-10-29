/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { readLastNumber, replaceFile } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import type { NumberCounters } from './counters';
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
 * An agent of another window of the machine, as a record names it (AGENT-ORCHESTRATION.md, O8): its number, its name, the
 * record of its window and that window's label.
 */
export interface ForeignAgent {
	readonly id: number;
	readonly name: string;
	readonly window: string;
	readonly label?: string;
}

/** Whether `value` is an agent of another window, each field checked. */
export function isForeign(value: unknown): value is ForeignAgent {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const { id, name, window, label } = value as { [key: string]: unknown };
	return isId(id) && typeof name === 'string' && name.length > 0 && typeof window === 'string' && window.length > 0 && (label === undefined || typeof label === 'string');
}

/** An agent of another workspace as Facade's words name it: `@lint #a7 (workspace lab, 1a2b3c4d)`. */
export function foreignRef(agent: ForeignAgent): string {
	return `@${agent.name} #a${agent.id} (workspace ${workspaceWordOf(agent.label, agent.window)})`;
}

/**
 * A workspace's label as the workspaces give it - `lab (C:\src\lab, 1a2b3c4d)`, its folder left out where it has none -
 * split into its name and the start of its record id. The folder begins with a root, so a name or a folder with
 * parentheses of its own splits where it should.
 */
const LABEL = /^(?<name>[\s\S]*?) \((?:(?:[A-Za-z]:|\\\\|\/)[\s\S]*, )?(?<short>[0-9a-f]{8})\)$/i;

/** A workspace's name, as its label begins: `lab` of `lab (C:\src\lab, 1a2b3c4d)`. */
export function workspaceNameOf(label: string): string {
	return LABEL.exec(label)?.groups?.name ?? label.replace(/\s\([^()]*\)$/, '');
}

/**
 * How Facade writes a workspace after an agent or a message for a caller to pass back as written - `lab, 1a2b3c4d`:
 * its name and the start of its record id, which no other workspace shares (AGENT-ORCHESTRATION.md, O2). Known by its
 * record alone, by a name whose parentheses do not pair - which a reference could not be read back with - or by one
 * that cmd.exe would read as its own, where it goes on a command line in a first line (AGENT-LAUNCHER.md, L10), it is
 * the start of the record id.
 */
export function workspaceWordOf(label: string | undefined, record?: string): string {
	const parts = label !== undefined ? LABEL.exec(label)?.groups : undefined;
	const name = parts?.name ?? label;
	const short = parts?.short ?? record?.replace(/-/g, '').slice(0, 8);
	if (name !== undefined && (!pairsParentheses(name) || CMD_READS.test(name))) {
		return short ?? '';
	}
	return name && short ? `${name}, ${short}` : name ?? short ?? '';
}

/** What cmd.exe reads as its own in a name a first line holds, as `unsafeForCmd` says: a name with it is not written. */
const CMD_READS = /["%^&|<>!]/;

/** Whether every parenthesis of `text` closes one it opened before, and each it opens is closed. */
function pairsParentheses(text: string): boolean {
	let depth = 0;
	for (const character of text) {
		depth += character === '(' ? 1 : character === ')' ? -1 : 0;
		if (depth < 0) {
			return false;
		}
	}
	return depth === 0;
}

/** A foreign agent as the ledger writes it: its fields alone. */
function foreignOf(agent: ForeignAgent): ForeignAgent {
	return { id: agent.id, name: agent.name, window: agent.window, ...(agent.label !== undefined ? { label: agent.label } : {}) };
}

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
	/** The agent that sent it - of this record, or of another window - or Facade; none for the person. */
	readonly from?: number | typeof FACADE | ForeignAgent;
	/** Its recipient; an agent of another window for the sender's copy of a message to it, whose mailbox is in that window (M11). */
	readonly to: Recipient | ForeignAgent;
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
	/** The agent a message of Facade's is about: of this record, or of another window. */
	readonly about?: number | ForeignAgent;
	/** The key of a notice another workspace left, or this one raised, which makes it one however often it comes (O8). */
	readonly key?: string;
	/** The message of this record a notice of Facade's settles: the sender's copy it says went back, or may never have been fetched. */
	readonly original?: number;
	/** For one from the person in another workspace - a script there - that workspace: a return goes back to the person there (M6). */
	readonly personAfar?: { readonly window: string; readonly label?: string };
	/** When it was sent. */
	readonly time: number;
	/** Where the ledger recorded it: the chat rooms are deleted up to a place in the ledger, not a number (AGENT-LAUNCHER.md, L12). */
	readonly seq: number;
}

/** A message in its recipient's mailbox. */
export interface MailboxEntry {
	/** Unread until a result that holds it is delivered, or it goes back as its recipient ends. */
	state: 'unread' | 'delivered' | 'returned';
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
	/** Set where it went back to its sender's window, its sender an agent of another window: that window holds the notice (M6). */
	readonly afar?: true;
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
	/** Each agent's task, by the agent's number. */
	readonly tasks: Map<number, number>;
	/** The agents whose creators were told that they had not fetched their tasks. */
	readonly notFetched: Set<number>;
	/** What the chat rooms hold since they were last deleted, in order. */
	readonly roomLines: RoomLine[];
	/** The keys of the notices recorded, and of those taken for an agent that had ended, each once (O8). */
	readonly noticeKeys: Set<string>;
	/** What became of each sender's copy as notices said: it went back, or - its recipient's workspace gone - it may never have been fetched (M4, M11). */
	readonly copyOutcomes: Map<number, FacadeKind>;
	/** No chat room is written again for a message up to this number: Delete Chat Rooms deleted them. */
	roomsDeletedUpTo: number;
	/**
	 * Where in the ledger Delete Chat Rooms last deleted them: no chat room is written again for a message recorded before;
	 * one recorded after is, however low its number - a copy from another window comes late (AGENT-LAUNCHER.md, L12).
	 */
	roomsDeletedAt: number;
}

/** The ledger's events of messages. */
export type MessageEventBody =
	| {
		readonly type: 'message.sent';
		readonly id: number;
		readonly from?: number | typeof FACADE | ForeignAgent;
		readonly to: Recipient | ForeignAgent;
		readonly text?: string;
		readonly file?: string;
		readonly length: number;
		readonly replyTo?: number;
		readonly task?: true;
		readonly facade?: FacadeKind;
		readonly about?: number | ForeignAgent;
		/** A message to the person recorded while the agent framework was off: unread, held for their notification until it is shown (M10). */
		readonly held?: true;
		readonly key?: string;
		readonly original?: number;
		readonly personAfar?: { readonly window: string; readonly label?: string };
	}
	/** A notice left by another workspace for an agent that had ended: taken, and recorded as not delivered (O8). */
	| { readonly type: 'notice.taken'; readonly key: string; readonly to: number }
	/** The agent's creator, of another workspace, was told by its workspace that the agent has not fetched its task (M6). */
	| { readonly type: 'task.toldAfar'; readonly agent: number }
	/** Messages to the person held while the agent framework was off, shown to them: delivered (M10). */
	| { readonly type: 'message.shown'; readonly ids: readonly number[] }
	/**
	 * A result with these messages, as it went out to the agent's pipe: written by Facades before M4 dropped the
	 * marks of messages given before. Read, so that their ledgers load, and nothing more (AGENT-MESSAGES.md, M11).
	 */
	| { readonly type: 'message.given'; readonly agent: number; readonly ids: readonly number[] }
	/** The pipe wrote that result. */
	| { readonly type: 'message.delivered'; readonly agent: number; readonly ids: readonly number[] }
	/** A doorbell typed into the agent's terminal, and the messages it named. */
	| { readonly type: 'mailbox.rang'; readonly agent: number; readonly ids: readonly number[] }
	/**
	 * A message's recipient ended with it unread: `as` took it back to its sender - `afar`, its sender's window took the notice,
	 * its sender an agent of another window; none where it could not go back, or - `known` - needed not.
	 */
	| { readonly type: 'message.returned'; readonly id: number; readonly reason: string; readonly as?: number; readonly known?: true; readonly afar?: true }
	/** Delete Chat Rooms: the rooms and the message files are gone, and none is written again for a message up to `upTo`. */
	| { readonly type: 'rooms.deleted'; readonly upTo: number }
	/** The sender of another window of the agent's oldest unread message was told by its window that its messages wait (M6). */
	| { readonly type: 'mailbox.delayed'; readonly agent: number };

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
		tasks: new Map(),
		notFetched: new Set(),
		roomLines: [],
		noticeKeys: new Set(),
		copyOutcomes: new Map(),
		roomsDeletedUpTo: 0,
		roomsDeletedAt: 0
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
			const { id, from, to, text, file, length, replyTo, task, facade, about, held, key, original, personAfar } = value;
			const person = isJsonObject(personAfar) && typeof personAfar.window === 'string' && personAfar.window.length > 0 && (personAfar.label === undefined || typeof personAfar.label === 'string')
				? { window: personAfar.window, ...(typeof personAfar.label === 'string' ? { label: personAfar.label } : {}) }
				: undefined;
			const inLine = typeof text === 'string' && text.length > 0 && text.length <= TEXT_IN_LINE && length === text.length && file === undefined;
			const inFile = text === undefined && typeof file === 'string' && TEXT_FILE.exec(file)?.groups?.id === String(id) && isId(length) && length > TEXT_IN_LINE;
			if (!isId(id) || (from !== undefined && from !== FACADE && !isId(from) && !isForeign(from)) || (to !== HUMAN && !isId(to) && !isForeign(to)) || !(inLine || inFile) || !isId(length)
				|| (replyTo !== undefined && !isId(replyTo)) || (task !== undefined && task !== true)
				|| (facade !== undefined && !isFacadeKind(facade)) || (facade !== undefined) !== (from === FACADE)
				|| (about !== undefined && !isId(about) && !isForeign(about)) || (held !== undefined && (held !== true || to !== HUMAN))
				|| (key !== undefined && (typeof key !== 'string' || !key || facade === undefined)) || (original !== undefined && (!isId(original) || facade === undefined))
				|| (personAfar !== undefined && (!person || from !== undefined))) {
				return undefined;
			}
			return {
				type: 'message.sent', id,
				...(from !== undefined ? { from: isForeign(from) ? foreignOf(from) : from as number | typeof FACADE } : {}), to: isForeign(to) ? foreignOf(to) : to as Recipient,
				...(inLine ? { text } : { file }), length,
				...(replyTo !== undefined ? { replyTo } : {}), ...(task ? { task } : {}),
				...(facade !== undefined ? { facade } : {}), ...(about !== undefined ? { about: isForeign(about) ? foreignOf(about) : about as number } : {}), ...(held ? { held } : {}),
				...(key !== undefined ? { key: key as string } : {}), ...(original !== undefined ? { original: original as number } : {}),
				...(person ? { personAfar: person } : {})
			};
		}
		case 'notice.taken': {
			const { key, to } = value;
			return typeof key === 'string' && key.length > 0 && isId(to) ? { type: 'notice.taken', key, to } : undefined;
		}
		case 'task.toldAfar': {
			const { agent } = value;
			return isId(agent) ? { type: 'task.toldAfar', agent } : undefined;
		}
		case 'message.shown': {
			const { ids } = value;
			return isNumbers(ids) ? { type: 'message.shown', ids: [...ids] } : undefined;
		}
		case 'message.given':
		case 'message.delivered':
		case 'mailbox.rang': {
			const { agent, ids } = value;
			return isId(agent) && isNumbers(ids) ? { type: value.type, agent, ids: [...ids] } : undefined;
		}
		case 'message.returned': {
			const { id, reason, as, known, afar } = value;
			return isId(id) && typeof reason === 'string' && reason.length > 0 && (as === undefined || isId(as)) && (known === undefined || (known === true && as === undefined))
				&& (afar === undefined || (afar === true && as === undefined && known === undefined))
				? { type: 'message.returned', id, reason, ...(as !== undefined ? { as } : {}), ...(known ? { known } : {}), ...(afar ? { afar } : {}) }
				: undefined;
		}
		case 'rooms.deleted': {
			const { upTo } = value;
			return isId(upTo) ? { type: 'rooms.deleted', upTo } : undefined;
		}
		case 'mailbox.delayed': {
			const { agent } = value;
			return isId(agent) ? { type: 'mailbox.delayed', agent } : undefined;
		}
	}
	return undefined;
}

/**
 * Whether an event of messages can follow what the ledger gave so far: a message goes under a number
 * above every one given, from and to agents the ledger started, answering one there is, and a task to
 * an agent from its creator, once - one from or to an agent of another window under a number not yet used, which that
 * window may have given below this record's last, answering one this record may not have (AGENT-MESSAGES.md, M11); given, delivered and rung messages are in their mailboxes, rung
 * ones in the agent's own; a message goes back from its mailbox once, and only as a message of
 * Facade's that takes messages back; chat rooms are deleted up to a message there is.
 */
export function fitsMessages(agents: ReadonlyMap<number, { readonly creator?: number }>, state: MessagesState, event: MessageEventBody): boolean {
	switch (event.type) {
		case 'message.sent': {
			const known = (id: number | ForeignAgent | undefined) => id === undefined || isForeign(id) || agents.has(id);
			const to = typeof event.to === 'number' ? agents.get(event.to) : undefined;
			const fromAfar = isForeign(event.from);
			const between = fromAfar || isForeign(event.to);
			return (between ? !state.messages.has(event.id) : event.id > state.lastMessage)
				&& (event.from === FACADE || known(event.from))
				// A copy of a message to another window's agent is its sender's: an agent of this record, or the person
				&& (event.to === HUMAN || !!to || (isForeign(event.to) && !fromAfar && event.from !== FACADE))
				&& known(event.about)
				&& (event.replyTo === undefined || between || state.messages.has(event.replyTo))
				// A task is from its creator: of this record, or of another workspace, as the agent's start recorded it (M7)
				&& (!event.task || (!!to && !state.tasks.has(event.to as number) && (isForeign(event.from)
					? (to as { readonly creatorAfar?: ForeignAgent }).creatorAfar?.id === event.from.id && (to as { readonly creatorAfar?: ForeignAgent }).creatorAfar?.window === event.from.window
					: (event.from === undefined || typeof event.from === 'number') && to.creator === event.from)))
				&& (event.key === undefined || !state.noticeKeys.has(event.key))
				&& (event.original === undefined || isForeign(state.messages.get(event.original)?.to));
		}
		case 'notice.taken':
			return agents.has(event.to) && !state.noticeKeys.has(event.key);
		case 'task.toldAfar':
			return agents.has(event.agent);
		case 'message.shown':
			return event.ids.every(id => state.entries.has(id) && state.messages.get(id)?.to === HUMAN);
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
		case 'mailbox.delayed':
			return agents.has(event.agent);
	}
}

/** Applies one event of messages, at `time` and the ledger's place `seq`, to what the ledger is replayed into. */
export function applyMessages(state: MessagesState, event: MessageEventBody, time: number, seq: number): void {
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
				...(event.key !== undefined ? { key: event.key } : {}),
				...(event.original !== undefined ? { original: event.original } : {}),
				...(event.personAfar ? { personAfar: event.personAfar } : {}),
				time,
				seq
			});
			if (event.key !== undefined) {
				state.noticeKeys.add(event.key);
			}
			if (event.original !== undefined && event.facade !== undefined) {
				state.copyOutcomes.set(event.original, event.facade);
			}
			// The copy of a message to another window's agent has no mailbox here: that window's has it, and says how it went (M11)
			if (!isForeign(event.to)) {
				// The person's messages are delivered as they are recorded: shown at once, and never returned - but one held while
				// the agent framework was off, unread until it is shown (M10)
				state.entries.set(event.id, { state: event.to === HUMAN && !event.held ? 'delivered' : 'unread', rings: 0 });
				mailboxOf(state, event.to).push(event.id);
			}
			state.lastMessage = Math.max(state.lastMessage, event.id);
			if (event.task && typeof event.to === 'number') {
				state.tasks.set(event.to, event.id);
			}
			if (event.facade === 'taskNotFetched' && typeof event.about === 'number') {
				state.notFetched.add(event.about);
			}
			if (event.facade === 'delayed' && typeof event.about === 'number') {
				state.delayedAt.set(event.about, time);
			}
			state.roomLines.push({ message: event.id });
			break;
		}
		case 'message.shown':
			for (const id of event.ids) {
				const entry = state.entries.get(id);
				if (entry?.state === 'unread') {
					entry.state = 'delivered';
				}
			}
			break;
		case 'message.given':
			// Facade keeps no history of who was given what: delivery is what counts (M4)
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
			state.returns.set(event.id, { reason: event.reason, ...(event.as !== undefined ? { as: event.as } : {}), ...(event.known ? { known: event.known } : {}), ...(event.afar ? { afar: event.afar } : {}), time });
			if (event.as === undefined && !event.afar) {
				state.roomLines.push({ message: event.id, unreturned: true });
			}
			break;
		}
		case 'rooms.deleted': {
			state.roomsDeletedUpTo = event.upTo;
			state.roomsDeletedAt = seq;
			state.roomLines.splice(0, state.roomLines.length);
			break;
		}
		case 'mailbox.delayed':
			state.delayedAt.set(event.agent, time);
			break;
		case 'notice.taken':
			state.noticeKeys.add(event.key);
			break;
		case 'task.toldAfar':
			state.notFetched.add(event.agent);
			break;
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
	/** Its sender: an agent of this record, Facade, an agent of another window whose message to this one's it is, or the person. */
	readonly from?: number | typeof FACADE | ForeignAgent;
	readonly to: Recipient;
	readonly text: string;
	readonly replyTo?: number;
	readonly task?: true;
	readonly facade?: FacadeKind;
	readonly about?: number | ForeignAgent;
	/** To the person while the agent framework is off: held for their notification, unread until it is shown (M10). */
	readonly held?: true;
	/** A notice's key, which makes it one however often it comes (O8). */
	readonly key?: string;
	/** The sender's copy a notice settles. */
	readonly original?: number;
	/** From the person in another workspace: that workspace (M6). */
	readonly personAfar?: { readonly window: string; readonly label?: string };
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

	constructor(private readonly dir: string, private readonly ledger: Ledger, private readonly counters?: NumberCounters) {
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
	 * Records a message under the next number - the machine's, above the record's last - its text in a file of its own
	 * where it is longer than a ledger line holds. The number is written before it is used: one the ledger missed is never given
	 * again either. Nothing is written once the ledger is closed, or another window's.
	 */
	send(message: NewMessage): Message {
		this.ledger.assertOpen();
		const last = Math.max(this.state.lastMessage, this.lastMessage);
		const id = this.counters?.next('messages', last, this.dir) ?? last + 1;
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
			throw new Error(`Failed to record message #m${id} in the ledger.`);
		}
		return sent;
	}

	/**
	 * Records the sender's copy of a message to an agent of another window, under the number that window gave it - which may
	 * be below this record's last - its text in a file of its own where it is long (AGENT-MESSAGES.md, M11).
	 */
	copy(id: number, message: { readonly from?: number; readonly to: ForeignAgent; readonly text: string; readonly replyTo?: number }): Message {
		this.ledger.assertOpen();
		const { text, ...fields } = message;
		let place: { readonly text: string } | { readonly file: string } = { text };
		if (text.length > TEXT_IN_LINE) {
			const file = `m${id}.txt`;
			this.write(file, text);
			place = { file };
		}
		this.ledger.append({ type: 'message.sent', id, ...fields, ...place, length: text.length });
		this.counters?.saw('messages', id, this.dir);
		const sent = this.state.messages.get(id);
		if (!sent) {
			throw new Error(`Failed to record message #m${id} in the ledger.`);
		}
		return sent;
	}

	/** Records that the agent's creator, of another workspace, was told that it has not fetched its task (M6). */
	notFetchedAfar(agent: number): void {
		this.ledger.assertOpen();
		this.ledger.append({ type: 'task.toldAfar', agent });
	}

	/** Records that a notice another workspace left, under `key`, was taken for the agent `to`, which had ended: not delivered (O8). */
	noticeTaken(key: string, to: number): void {
		this.ledger.assertOpen();
		this.ledger.append({ type: 'notice.taken', key, to });
	}

	/** Records that the person was shown these messages of theirs, held while the agent framework was off (M10). */
	shown(ids: readonly number[]): void {
		if (ids.length) {
			this.ledger.append({ type: 'message.shown', ids });
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
	 * Records that a message went back to its sender `as` that message of Facade's - or, `afar`, to its sender's window, which
	 * recorded the notice (M6) - or that it could not.
	 */
	returned(id: number, reason: string, { as, afar }: { readonly as?: number; readonly afar?: boolean } = {}): void {
		this.ledger.append({ type: 'message.returned', id, reason, ...(as !== undefined ? { as } : {}), ...(afar ? { afar: true as const } : {}) });
	}

	/** Records that the sender of another window of `agent`'s oldest unread message is told that its messages wait (M6). */
	delayedAfar(agent: number): void {
		this.ledger.append({ type: 'mailbox.delayed', agent });
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
