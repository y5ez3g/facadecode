/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';
import { AgentIdentity, describe, foreignRootKey, isLive, PERSON, WorkspaceState } from './events';
import { FACADE, ForeignAgent, foreignRef, HUMAN, isForeign, Message, MessageRecord, Recipient } from './messages';

/** The file beside the machine's chat rooms that says up to which message number they were last deleted (M9). */
const DELETED_FILE = 'deleted.json';

/** A chat room, as Open Chat Room lists it. */
export interface ChatRoom {
	readonly file: string;
	/** The agent the person started, whose tree it is. */
	readonly root: AgentIdentity;
	/** Whether that agent has not ended; undefined for a root of another workspace, which this one cannot tell. */
	readonly live: boolean | undefined;
	/** How many messages it has. */
	readonly messages: number;
	/** When its last message came. */
	readonly lastTime: number;
}

/** A tree's root, as a chat room is named by it: its number, its name and its workspace's record. */
export interface RoomRoot {
	readonly id: number;
	readonly name: string;
	readonly window: string;
	readonly label?: string;
}

/**
 * The chat rooms, the person's record of the messages (AGENT-MESSAGES.md, M9): the machine's, in Facade's home - one
 * Markdown file per agent the person started, whichever workspaces its tree spans - with every message to or from its
 * tree, in order, Facade's too, each whole under a heading; a message between two trees is in both. Each message is
 * written once, by the workspace that records it: its recipient's, or for one to the person its sender's - a sender's copy
 * of one to another workspace's agent is that workspace's to write - under a short lock on the room. A room missing what
 * this workspace's record holds gets it again as the workspace loads. They stay, through reloads, quitting and crashes,
 * until the person deletes them - every workspace's - and none is written again for a message up to that point.
 */
export class ChatRooms {

	/**
	 * `shared`, the machine's shared mark of agent numbers: a root numbered at or below it may share its number with
	 * another workspace's, so its room's name says its workspace too (AGENT-LAUNCHER.md, L12).
	 */
	constructor(readonly folder: string, private readonly self: string, private readonly state: () => WorkspaceState, private readonly messages: MessageRecord, private readonly shared: () => number = () => 0) { }

	/** Appends a message this workspace records to the rooms it goes into - and to those of `more`, the trees of a sender of another workspace. */
	append(id: number, more: readonly RoomRoot[] = []): void {
		const message = this.state().mail.messages.get(id);
		if (!message || isForeign(message.to) || id <= this.deletedUpTo()) {
			return;
		}
		const entry = this.entryOf(message);
		const roots = this.rootsOf(message);
		const others = more.filter(each => !roots.some(root => root.id === each.id && root.window === each.window)).map(each => ({ id: each.id, name: each.name, root: each.id, worktree: '', window: each.window, ...(each.label ? { workspace: each.label } : {}) }));
		for (const root of [...roots, ...others]) {
			this.appendTo(root, entry);
		}
	}

	/** Appends the note that a message was not delivered, and could not go back to its sender. */
	noteUnreturned(id: number): void {
		const message = this.state().mail.messages.get(id);
		const note = message && this.noteOf(message);
		if (!message || !note || id <= this.deletedUpTo()) {
			return;
		}
		for (const root of this.rootsOf(message)) {
			this.appendTo(root, note);
		}
	}

	/** Writes again, from the record, what of this workspace's messages a room is missing: a room deleted since holds nothing up to its mark. */
	restore(): void {
		const state = this.state();
		const deleted = this.deletedUpTo();
		const texts = new Map<string, string>();
		const textOf = (file: string) => {
			if (!texts.has(file)) {
				try {
					texts.set(file, fs.readFileSync(file, 'utf8'));
				} catch (err) {
					if (codeOf(err) !== 'ENOENT') {
						throw err;
					}
					texts.set(file, '');
				}
			}
			return texts.get(file)!;
		};
		for (const line of state.mail.roomLines) {
			const message = state.mail.messages.get(line.message);
			if (!message || isForeign(message.to) || message.id <= deleted || message.seq <= state.mail.roomsDeletedAt) {
				continue;
			}
			// The whole entry, not its heading alone: one cut short as it was written is written again
			const text = line.unreturned ? this.noteOf(message) : this.entryOf(message);
			for (const root of text ? this.rootsOf(message) : []) {
				const file = this.fileOf(root);
				if (!textOf(file).includes(text!)) {
					this.appendTo(root, text!);
					texts.delete(file);
				}
			}
		}
	}

	/** The rooms there are on the machine, the one with the latest message first. */
	list(): ChatRoom[] {
		let names: string[] = [];
		try {
			names = fs.readdirSync(this.folder).filter(name => name.endsWith('.md'));
		} catch {
			return [];
		}
		const state = this.state();
		const rooms: (ChatRoom & { readonly last: number })[] = [];
		for (const name of names) {
			const file = path.join(this.folder, name);
			try {
				const text = fs.readFileSync(file, 'utf8');
				const heading = /^# Chat room: @(?<name>\S+) #a(?<id>\d+)(?: \(workspace (?<workspace>[^)]*)\))?/.exec(text)?.groups;
				if (!heading) {
					continue;
				}
				const id = Number(heading.id);
				const numbers = [...text.matchAll(/^## #m(\d+) · /gm)].map(match => Number(match[1]));
				const here = !heading.workspace;
				const root: AgentIdentity = { id, name: heading.name, root: id, worktree: here ? state.identities.get(id)?.worktree ?? '' : heading.workspace!, ...(heading.workspace ? { workspace: heading.workspace } : {}) };
				rooms.push({ file, root, live: here ? isLive(state.agents.get(id)) : undefined, messages: numbers.length, lastTime: fs.statSync(file).mtimeMs, last: Math.max(0, ...numbers) });
			} catch {
				// Gone meanwhile, or not readable: not listed
			}
		}
		return rooms.sort((a, b) => b.last - a.last).map(({ last: _last, ...room }) => room);
	}

	/** The room a message is shown in: of its sender's tree, for one to the person; else of its recipient's. */
	roomOf(message: Message): string | undefined {
		const state = this.state();
		const roots = this.rootsOf(message);
		const recipient = typeof message.to === 'number' ? state.identities.get(message.to) : undefined;
		const root = (recipient && roots.find(each => each.id === recipient.root)) ?? roots[0];
		return root && this.fileOf(root);
	}

	/** Deletes every room of the machine, and marks them deleted up to `upTo`, the machine's last message number. */
	delete(upTo: number): void {
		fs.mkdirSync(this.folder, { recursive: true });
		withFileLock(path.join(this.folder, DELETED_FILE), () => {
			for (const name of fs.readdirSync(this.folder).filter(each => each.endsWith('.md'))) {
				fs.rmSync(path.join(this.folder, name), { force: true });
			}
			fs.writeFileSync(path.join(this.folder, DELETED_FILE), JSON.stringify({ upTo: Math.max(upTo, this.deletedUpTo()) }));
		});
	}

	/** Up to which message number the rooms were last deleted, on the machine. */
	deletedUpTo(): number {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(path.join(this.folder, DELETED_FILE), 'utf8'));
			return isJsonObject(value) && typeof value.upTo === 'number' ? value.upTo : 0;
		} catch {
			return 0;
		}
	}

	/** The roots of the trees a message is in, each with its workspace (`rootsOf`). */
	private rootsOf(message: Message): (AgentIdentity & RoomRoot)[] {
		return rootsOf(this.state(), message).map(root => ({ ...root, window: root.window ?? this.self }));
	}

	/** The file of the room of `root`'s tree: its name and number - and the start of its workspace's record id, for a number two records may hold. */
	private fileOf(root: RoomRoot): string {
		return path.join(this.folder, root.id <= this.shared() ? `${root.name}-a${root.id}-${root.window.replace(/-/g, '').slice(0, 8)}.md` : `${root.name}-a${root.id}.md`);
	}

	/** Appends `text` to the room of `root`'s tree, which begins with its heading, under the room's lock. */
	private appendTo(root: AgentIdentity & RoomRoot, text: string): void {
		const file = this.fileOf(root);
		fs.mkdirSync(this.folder, { recursive: true });
		withFileLock(file, () => fs.appendFileSync(file, fs.existsSync(file) ? text : `${headingOf(root, root.window === this.self ? undefined : root.workspace ?? root.window)}${text}`, { mode: 0o600 }));
	}

	/** A message as its room has it: a heading - its number, time, sender and recipient - then its whole text. */
	private entryOf(message: Message): string {
		const state = this.state();
		const marks = [
			...(message.replyTo !== undefined ? [`reply to #m${message.replyTo}`] : []),
			...(message.task ? ['task'] : [])
		];
		const text = this.messages.textOf(message) ?? `(Message text unavailable: ${message.length} ${message.length === 1 ? 'character' : 'characters'} removed when the chat rooms were deleted.)`;
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
			return `> #m${message.id} was not fetched by ${whoOf(state, message.to)} before the recipient ended (${returned.reason}). It was not returned because ${whoOf(state, message.from)} had already been notified of the recipient's exit.\n\n`;
		}
		// The person's go back to them always: only an agent's whose sender ended, and Facade's, do not
		const why = message.from === FACADE ? 'Facade system messages cannot be returned' : `its sender, ${whoOf(state, message.from)}, has already ended`;
		return `> #m${message.id} was not fetched by ${whoOf(state, message.to)} before the recipient ended (${returned.reason}). It could not be returned: ${why}.\n\n`;
	}
}

/**
 * The roots of the trees a message is to or from - of its sender, its recipient, and the agent one of
 * Facade's is about - each the agent the person started at the top: the chat rooms it is in. Agents that left
 * the list are known by who they were. A root is told apart by its workspace as well as its number: a tree whose
 * root is of another workspace is that root's, never this record's agent of the same older number (M9; L12).
 */
export function rootsOf(state: WorkspaceState, message: Message): AgentIdentity[] {
	const roots = new Map<string, AgentIdentity>();
	for (const id of [message.from, message.to, message.from === FACADE ? message.about : undefined]) {
		const agent = typeof id === 'number' ? state.identities.get(id) : undefined;
		const root = agent?.rootWindow !== undefined ? state.foreignRoots.get(foreignRootKey(agent.rootWindow, agent.root)) : agent && state.identities.get(agent.root);
		if (root) {
			roots.set(`${root.window ?? ''} ${root.id}`, root);
		}
	}
	return [...roots.values()];
}

/** The heading a room begins with: whose tree it is. */
function headingOf(root: AgentIdentity, workspace?: string): string {
	const who = `${describe(root)}${workspace ? ` (workspace ${workspace})` : ''}`;
	return `# Chat room: ${who}\n\nMessages to or from ${who} and its descendants, in chronological order.\n\n`;
}

/** Who sent or got a message, as Facade writes it: `@name #a7`, an agent of another window with its window, the person, `@human`, or Facade. */
export function whoOf(state: WorkspaceState, who: Recipient | typeof FACADE | ForeignAgent | undefined): string {
	if (who === FACADE) {
		return 'Facade';
	}
	if (isForeign(who)) {
		return foreignRef(who);
	}
	if (who === undefined || who === HUMAN) {
		return describe(PERSON);
	}
	const agent = state.identities.get(who);
	return agent ? describe(agent) : `#a${who}`;
}

/** A time as a room writes it: the date and the time of day, on this machine's clock. */
function timeText(time: number): string {
	const date = new Date(time);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
