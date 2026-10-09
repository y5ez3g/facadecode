/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { Agent, PERSON, rootOf, WorkspaceState } from './events';
import { FACADE, HUMAN, Message, MessageRecord, Recipient } from './messages';

/** The record's folder of chat rooms. */
const ROOMS_DIR = 'rooms';

/** A chat room, as Open Chat Room lists it. */
export interface ChatRoom {
	readonly file: string;
	/** The agent the person started, whose tree it is. */
	readonly root: Agent;
	/** How many messages it has. */
	readonly messages: number;
	/** When its last message came. */
	readonly lastTime: number;
}

/**
 * The chat rooms, the person's record of the messages: one Markdown file per agent the person started,
 * with every message to or from its tree, in order, Facade's too, each whole under a heading; a message
 * between two trees is in both. They are appended to as the messages come, never rewritten: one
 * missing, or shorter than the ledger says, is written again from the ledger as the window loads. They
 * stay, through reloads, quitting and crashes, until the person deletes them.
 */
export class ChatRooms {

	constructor(private readonly dir: string, private readonly state: () => WorkspaceState, private readonly messages: MessageRecord) { }

	/** The folder the rooms are in. */
	get folder(): string {
		return path.join(this.dir, ROOMS_DIR);
	}

	/** Appends a message to the rooms it goes into. */
	append(id: number): void {
		const message = this.state().mail.messages.get(id);
		if (!message) {
			return;
		}
		const entry = this.entryOf(message);
		for (const root of rootsOf(this.state(), message)) {
			this.appendTo(root, entry);
		}
	}

	/** Appends the note that a message was not delivered, and could not go back to its sender. */
	noteUnreturned(id: number): void {
		const message = this.state().mail.messages.get(id);
		const note = message && this.noteOf(message);
		if (!message || !note) {
			return;
		}
		for (const root of rootsOf(this.state(), message)) {
			this.appendTo(root, note);
		}
	}

	/** Writes again, from the ledger, each room that is missing or shorter than the ledger says. */
	restore(): void {
		for (const [file, text] of this.render()) {
			let size: number | undefined;
			try {
				size = fs.statSync(file).size;
			} catch (err) {
				if (codeOf(err) !== 'ENOENT') {
					throw err;
				}
			}
			if (size === undefined || size < Buffer.byteLength(text)) {
				fs.mkdirSync(this.folder, { recursive: true });
				replaceFile(file, text);
			}
		}
	}

	/** The rooms there are, the one with the latest message first. */
	list(): ChatRoom[] {
		const state = this.state();
		const rooms = new Map<number, { root: Agent; messages: number; lastTime: number; last: number }>();
		for (const line of state.mail.roomLines) {
			const message = line.unreturned ? undefined : state.mail.messages.get(line.message);
			for (const root of message ? rootsOf(state, message) : []) {
				const room = rooms.get(root.id) ?? { root, messages: 0, lastTime: 0, last: 0 };
				room.messages++;
				room.lastTime = message?.time ?? 0;
				room.last = message?.id ?? 0;
				rooms.set(root.id, room);
			}
		}
		return [...rooms.values()]
			.sort((a, b) => b.last - a.last)
			.map(({ root, messages, lastTime }) => ({ file: this.fileOf(root), root, messages, lastTime }));
	}

	/** The room a message is shown in: of its sender's tree, for one to the person; else of its recipient's. */
	roomOf(message: Message): string | undefined {
		const state = this.state();
		const roots = rootsOf(state, message);
		const recipient = typeof message.to === 'number' ? state.agents.get(message.to) : undefined;
		const root = (recipient && roots.find(each => each.id === rootOf(state.agents, recipient).id)) ?? roots[0];
		return root && this.fileOf(root);
	}

	/** Deletes every room. */
	delete(): void {
		fs.rmSync(this.folder, { recursive: true, force: true });
	}

	/** The file of the room of `root`'s tree. */
	private fileOf(root: Agent): string {
		return path.join(this.folder, `${root.name}-a${root.id}.md`);
	}

	/** Appends `text` to the room of `root`'s tree, which begins with its heading. */
	private appendTo(root: Agent, text: string): void {
		const file = this.fileOf(root);
		fs.mkdirSync(this.folder, { recursive: true });
		fs.appendFileSync(file, fs.existsSync(file) ? text : `${headingOf(root)}${text}`, { mode: 0o600 });
	}

	/** What each room holds, as the ledger says, by its file. */
	private render(): Map<string, string> {
		const state = this.state();
		const rooms = new Map<string, string>();
		for (const line of state.mail.roomLines) {
			const message = state.mail.messages.get(line.message);
			const text = message && (line.unreturned ? this.noteOf(message) : this.entryOf(message));
			for (const root of message && text ? rootsOf(state, message) : []) {
				const file = this.fileOf(root);
				rooms.set(file, `${rooms.get(file) ?? headingOf(root)}${text}`);
			}
		}
		return rooms;
	}

	/** A message as its room has it: a heading - its number, time, sender and recipient - then its whole text. */
	private entryOf(message: Message): string {
		const state = this.state();
		const marks = [
			...(message.replyTo !== undefined ? [`re #m${message.replyTo}`] : []),
			...(message.task ? ['task'] : [])
		];
		const text = this.messages.textOf(message) ?? `(Its text, ${message.length} ${message.length === 1 ? 'character' : 'characters'}, is gone with the chat rooms deleted before.)`;
		return `## #m${message.id} · ${timeText(message.time)} · ${whoOf(state, message.from)} → ${whoOf(state, message.to)}${marks.map(mark => ` · ${mark}`).join('')}\n${text}\n\n`;
	}

	/** The note under a message that was not delivered and could not go back. */
	private noteOf(message: Message): string | undefined {
		const state = this.state();
		const returned = state.mail.returns.get(message.id);
		if (!returned) {
			return undefined;
		}
		if (returned.known) {
			return `> #m${message.id} was not fetched by ${whoOf(state, message.to)} before it ended (${returned.reason}). It was not returned: ${whoOf(state, message.from)} was told it ended.\n\n`;
		}
		// The person's go back to them always: only an agent's whose sender ended, and Facade's, do not
		const why = message.from === FACADE ? 'Facade\'s own messages are not returned' : `${whoOf(state, message.from)}, its sender, had ended`;
		return `> #m${message.id} was not fetched by ${whoOf(state, message.to)} before it ended (${returned.reason}). It could not be returned: ${why}.\n\n`;
	}
}

/**
 * The roots of the trees a message is to or from - of its sender, its recipient, and the agent one of
 * Facade's is about - each the agent the person started at the top: the chat rooms it is in.
 */
export function rootsOf(state: WorkspaceState, message: Message): Agent[] {
	const roots = new Map<number, Agent>();
	for (const id of [message.from, message.to, message.from === FACADE ? message.about : undefined]) {
		const agent = typeof id === 'number' ? state.agents.get(id) : undefined;
		if (agent) {
			const root = rootOf(state.agents, agent);
			roots.set(root.id, root);
		}
	}
	return [...roots.values()];
}

/** The heading a room begins with: whose tree it is. */
function headingOf(root: Agent): string {
	return `# Chat room of @${root.name} #a${root.id}\n\nEvery message to or from @${root.name} #a${root.id} and the agents started from it, in order.\n\n`;
}

/** Who sent or got a message, as Facade writes it: `@name #a7`, the person, or Facade. */
export function whoOf(state: WorkspaceState, who: Recipient | typeof FACADE | undefined): string {
	if (who === FACADE) {
		return 'Facade';
	}
	if (who === undefined || who === HUMAN) {
		return `@${PERSON.name}`;
	}
	const agent = state.agents.get(who);
	return agent ? `@${agent.name} #a${agent.id}` : `#a${who}`;
}

/** A time as a room writes it: the date and the time of day, on this machine's clock. */
function timeText(time: number): string {
	const date = new Date(time);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
