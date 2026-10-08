/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as l10n from '@vscode/l10n';
import { DeferredPromise } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentTable } from '../record/agents';
import { Agent, Caller, isLive, PERSON, rootOf } from '../record/events';
import { FACADE, HUMAN, MailboxEntry, Message, NewMessage, Recipient, TEXT_IN_LINE, unreadOf } from '../record/messages';
import { ChatRooms, rootsOf, whoOf } from '../record/rooms';
import { Doorbell, NEW_MESSAGE_MS, RING_GAP_MS } from './doorbell';
import { FacadeError } from './errors';
import { AgentSetup, CliCatalog, Disposable, Ports, Timing } from './ports';

/** A message's number, as a tool is given it: `#m42`, or `m42`. */
const MESSAGE_NUMBER = /^#?m(?<id>\d+)$/i;
/** An agent, given where a message's number is asked for: `#a7`, `a7`, or `@name #a7`. */
const AGENT_NUMBER = /^(?:@\S+\s+)?#?a\d+$/i;
/** How much of a message's first line a notification shows. */
const SHOWN_CHARS = 200;
/** How long the unexpected ends of the person's agents are gathered into one notification. */
const ENDS_GATHERED_MS = 1_000;
/** How many of an agent's unread messages its mailbox, or a notice of Facade's, names, the oldest: the others it counts. */
const LISTED = 10;

/** What the messages need of the core around them. */
export interface MailContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	/** How long the core waits, as the person sets it now: messages unfetched that long are told of. */
	timing(): Timing;
	/** The agent a tool names - by a name several have, the one `within` the caller's reach; throws, saying why, where none is. */
	agentNamed(text: string, within?: (agent: Agent) => boolean): Agent;
	/** The name of the terminal an agent runs in. */
	terminalOf(agent: Agent): string;
	log(message: string): void;
}

/** A message as `send_message` answers with it. */
export interface SentMessage {
	readonly id: number;
	/** Its recipient, as Facade writes it. */
	readonly to: string;
	/** Whether it is to the person. */
	readonly toPerson: boolean;
	/** Set where its recipient is still starting: its doorbell rings once it runs. */
	readonly starting?: true;
	/** Set where its recipient's YOLO is off and its tree is not the caller's: it can reply to the person only. */
	readonly cannotReply?: true;
}

/** What a fetch asks for: the caller's unread messages, with nothing; messages by number, `ids`; or `all` sent to it. */
export interface FetchRequest {
	readonly ids?: readonly string[];
	readonly all?: boolean;
}

/** How a fetch marks a message: new to the caller, given to it before, or gone back to its sender. */
export type Mark = 'new' | 'given before' | 'returned';

/** A message as a fetch gives it. */
export interface FetchedMessage {
	readonly id: number;
	readonly mark: Mark;
	/** When it was last given to the caller, for one given before. */
	readonly givenAt?: number;
	/** Its sender and its recipient, as Facade writes them. */
	readonly from: string;
	readonly to: string;
	/** Whether it was sent to the caller. */
	readonly own: boolean;
	/** Whether it was delivered as the fetch took it: one the caller fetches now is delivered once its result reaches it. */
	readonly state: MailboxEntry['state'];
	readonly time: number;
	readonly replyTo?: number;
	/** Set on an agent's task. */
	readonly task?: boolean;
	readonly length: number;
	/** Its text, where the fetch gives its texts in its result. */
	readonly text?: string;
}

/** What a fetch gives: the messages, by number, with their texts - or the file that holds them all. */
export interface Fetched {
	/** How they were fetched: the caller's unread ones, by number, or every one sent to it. */
	readonly way: 'unread' | 'ids' | 'all';
	readonly messages: readonly FetchedMessage[];
	/** Where their texts together are longer than a result holds: the file with them all. */
	readonly file?: string;
}

/** An agent's mailbox, as `ps` gives it. */
export interface Mailbox {
	/** Its oldest unread messages: their numbers, senders, and when they came. */
	readonly unread: readonly { readonly id: number; readonly from: string; readonly time: number }[];
	/** How many more are unread. */
	readonly more: number;
	/** How many of its messages it has fetched. */
	readonly fetched: number;
	/** When it last fetched its own. */
	readonly lastFetched?: number;
	/** Its task, and whether it has fetched it - delivered - or it went back to its creator. */
	readonly task?: { readonly id: number; readonly state: MailboxEntry['state'] };
}

/**
 * The messages (AGENT-MESSAGES.md): each numbered as it is sent and put into its recipient's mailbox;
 * Facade rings the recipient's doorbell and it fetches them with `read_messages`. Every message is
 * delivered at least once - a result that did not reach the pipe is given again, marked - or, its
 * recipient ending, goes back to its sender, or is noted in its chat room where its sender ended or was
 * told of the end otherwise; the chat rooms keep them all. An agent whose YOLO is off reaches the agents
 * of its own tree only, and the person. Every message is recorded before anything is done with it.
 */
export class Mail implements Disposable {

	readonly rooms: ChatRooms;
	private readonly doorbell: Doorbell;
	/** Each mailbox's last fetch, which the next one waits for. */
	private readonly fetching = new Map<Recipient, Promise<void>>();
	/** When each agent that has not fetched its task is looked at again. */
	private readonly tasks = new Map<number, ReturnType<typeof setTimeout>>();
	/** When each agent with messages unfetched is looked at again, for whether they waited the timeout. */
	private readonly delays = new Map<number, ReturnType<typeof setTimeout>>();
	/** The person's agents that ended unexpectedly, gathered for one notification. */
	private readonly ends: string[] = [];
	private endsTimer: ReturnType<typeof setTimeout> | undefined;
	/** When Facade was turned on again in this window, where it was: no doorbell was due while it was off. */
	private onAgainTime = 0;
	private disposed = false;

	constructor(private readonly context: MailContext) {
		const { table } = context;
		this.rooms = new ChatRooms(table.dir, () => table.state, table.messages);
		this.doorbell = new Doorbell({
			table,
			ports: context.ports,
			clis: context.clis,
			terminalOf: agent => context.terminalOf(agent),
			firstLine: (agent, task) => this.firstLineOf(agent, task.id),
			senderOf: message => this.whoOf(message.from),
			fetchesDone: id => this.fetching.get(id) ?? Promise.resolve(),
			log: message => context.log(message)
		});
	}

	dispose(): void {
		this.disposed = true;
		this.doorbell.dispose();
		for (const timer of [...this.tasks.values(), ...this.delays.values()]) {
			clearTimeout(timer);
		}
		this.tasks.clear();
		this.delays.clear();
		clearTimeout(this.endsTimer);
	}

	/**
	 * Sends a message from the caller to each recipient `to` names - an agent of the window in the
	 * caller's reach, or the person - each its own, under its own number; answers as soon as they are
	 * recorded, not when they are fetched. A recipient that ended, or is out of reach, refuses the whole
	 * send, and nothing is sent.
	 */
	send(caller: Caller, to: readonly string[], text: string, replyTo: string | undefined): SentMessage[] {
		this.stillOpen();
		const recipients = this.recipientsOf(caller, to);
		if (!text.trim()) {
			throw new FacadeError('INVALID', 'text is empty: write what the message says.');
		}
		const answers = replyTo === undefined ? undefined : this.repliedTo(caller, replyTo);
		const { agents } = this.context.table.state;
		const own = caller.id === undefined ? undefined : this.context.table.get(caller.id);
		const ownTree = own && rootOf(agents, own).id;
		const sent: SentMessage[] = [];
		for (const recipient of recipients) {
			let message: Message;
			try {
				message = this.record({ ...(caller.id !== undefined ? { from: caller.id } : {}), to: recipient, text, ...(answers !== undefined ? { replyTo: answers } : {}) });
			} catch (err) {
				// Those recorded are sent: sent again, they would come twice
				if (!sent.length) {
					throw err;
				}
				throw new FacadeError('FAILED', `${sent.map(each => `#m${each.id} to ${each.to}`).join(', ')} ${sent.length === 1 ? 'was' : 'were'} sent; then the message to ${this.whoOf(recipient)} could not be recorded: ${messageOf(err)}. Do not send those again; send to the rest again once Facade can record.`);
			}
			const agent = typeof recipient === 'number' ? this.context.table.get(recipient) : undefined;
			sent.push({
				id: message.id,
				to: this.whoOf(message.to),
				toPerson: message.to === HUMAN,
				...(agent?.state === 'starting' ? { starting: true } : {}),
				...(agent && ownTree !== undefined && !this.yoloOf(agent) && rootOf(agents, agent).id !== ownTree ? { cannotReply: true } : {})
			});
		}
		return sent;
	}

	/** Records the task the creator gives a new agent: a message to it, sent as it was recorded. */
	sendTask(creator: Caller, agent: Agent, text: string): Message {
		return this.record({ ...(creator.id !== undefined ? { from: creator.id } : {}), to: agent.id, text, task: true });
	}

	/** Records that the agent's first line, given as its launch argument, rang for its task. */
	firstRing(agent: Agent, task: number): void {
		this.context.table.messages.rang(agent.id, [task]);
	}

	/** The first line of an agent with a task: who it is, who created it, and its task's number. */
	firstLineOf(agent: Agent, task: number): string {
		const creator = agent.parent === undefined ? undefined : this.context.table.get(agent.parent);
		return this.context.setup.firstLine({ id: agent.id, name: agent.name }, creator ? { id: creator.id, name: creator.name } : PERSON, task);
	}

	/** An agent is running: its doorbell is due from now on, and its task and its messages are waited for. */
	running(agent: Agent): void {
		this.doorbell.update(agent.id);
		this.watchTask(agent.id);
		this.watchDelivery(agent.id);
	}

	/**
	 * Fetches messages for the caller: its unread ones, those numbered `ids` in its reach, or `all` sent to
	 * it. Its fetches run one after the other; one is done once the pipe said whether its result went
	 * out. The caller's own messages in a result that went out are delivered; those in one that did not
	 * are unread still, and are given again, marked. Texts that come to more than a result holds are all
	 * in one file.
	 */
	async fetch(caller: Caller, request: FetchRequest, whenWritten: (listener: (written: boolean) => void) => void): Promise<Fetched> {
		const recipient: Recipient = caller.id ?? HUMAN;
		const before = this.fetching.get(recipient);
		const turn = new DeferredPromise<void>();
		this.fetching.set(recipient, turn.p);
		void turn.p.then(() => {
			if (this.fetching.get(recipient) === turn.p) {
				this.fetching.delete(recipient);
			}
		});
		try {
			await before;
			this.stillOpen();
			const fetched = this.take(caller, request);
			const agent = caller.id;
			if (agent === undefined || !fetched.messages.length) {
				turn.complete();
				return fetched;
			}
			this.context.table.messages.given(agent, fetched.messages.map(message => message.id));
			whenWritten(written => {
				try {
					if (written && !this.disposed) {
						this.delivered(agent, fetched);
					}
				} finally {
					turn.complete();
				}
			});
			return fetched;
		} catch (err) {
			turn.complete();
			throw err;
		}
	}

	/**
	 * An agent's mailbox, as `ps` gives it: its oldest unread messages, how many it fetched, when it last
	 * fetched, and its task. Undefined for an agent out of the caller's reach.
	 */
	mailboxOf(id: number, caller: Caller): Mailbox | undefined {
		const { table } = this.context;
		const agent = table.get(id);
		const reach = this.reachOf(caller);
		if (!agent || (reach && rootOf(table.state.agents, agent).id !== reach.id)) {
			return undefined;
		}
		const mail = table.state.mail;
		const unread = unreadOf(mail, id);
		const lastFetched = mail.fetchedAt.get(id);
		const task = mail.tasks.get(id);
		const taskState = task === undefined ? undefined : mail.entries.get(task)?.state;
		return {
			unread: unread.slice(0, LISTED).map(message => ({ id: message.id, from: this.whoOf(message.from), time: message.time })),
			more: Math.max(0, unread.length - LISTED),
			fetched: (mail.mailboxes.get(id) ?? []).filter(each => mail.entries.get(each)?.state === 'delivered').length,
			...(lastFetched !== undefined ? { lastFetched } : {}),
			...(task !== undefined && taskState !== undefined ? { task: { id: task, state: taskState } } : {})
		};
	}

	/**
	 * An agent ended, `how` saying how; `tell` says whether its creator is told: an agent creator by a
	 * message of Facade's, while it runs; the person, for an agent they started, by a notification. Its
	 * unread messages go back to their senders, oldest first - but to `knownTo`, told of the end otherwise
	 * (its start, or its window closing), and to a sender that ended: for those its chat room notes it.
	 */
	ended(agent: Agent, how: string, tell: boolean, knownTo: readonly Recipient[] = []): void {
		this.doorbell.forget(agent.id);
		for (const timers of [this.tasks, this.delays]) {
			clearTimeout(timers.get(agent.id));
			timers.delete(agent.id);
		}
		if (tell) {
			if (agent.parent === undefined) {
				this.gatherEnd(l10n.t("@{0} #a{1} ended: {2}.", agent.name, agent.id, how));
			} else if (isLive(this.context.table.get(agent.parent))) {
				this.record({ from: FACADE, to: agent.parent, text: `${agentText(agent)} ended: ${how}. It takes no more messages.`, facade: 'ended', about: agent.id });
			}
		}
		for (const message of unreadOf(this.context.table.state.mail, agent.id)) {
			this.giveBack(message, agent, how, message.from !== FACADE && knownTo.includes(message.from ?? HUMAN));
		}
	}

	/**
	 * As Facade comes back: on a `fresh` start of the window, the files no mailbox or chat room needs any
	 * more go; the chat rooms are written again where short; the agents running are watched again - those
	 * of a window where Facade was off, `onAgain`, waited for from now.
	 */
	recover(fresh: boolean, onAgain = false): void {
		if (onAgain) {
			this.onAgainTime = Date.now();
		}
		if (fresh) {
			this.prune();
		}
		this.inRooms('again', () => this.rooms.restore());
		for (const agent of this.context.table.state.agents.values()) {
			if (agent.state === 'running') {
				this.running(agent);
			}
		}
	}

	/**
	 * Facade: Delete Chat Rooms. The rooms go for good, and the files of long texts with them, but those
	 * the mailboxes of this session still give: the messages stay with their agents.
	 */
	deleteRooms(): void {
		this.stillOpen();
		const { table } = this.context;
		table.messages.roomsDeleted();
		this.rooms.delete();
		const mail = table.state.mail;
		table.messages.deleteTexts(id => mail.entries.has(id));
	}

	/**
	 * Who `to` names, each once: agents of the window, by `#a7`, `@name` or `@name #a7`, or the person.
	 * Throws, saying why, where one is none, has ended, or is out of the caller's reach.
	 */
	private recipientsOf(caller: Caller, to: readonly string[]): Recipient[] {
		const named = to.map(each => each.trim());
		if (!named.length || named.some(each => !each)) {
			throw new FacadeError('INVALID', `to ${named.length ? 'has an empty recipient' : 'names nobody'}: give an agent - #a7, @name or @name #a7 - or the person, @${PERSON.name}; or several of them.`);
		}
		const reach = this.reachOf(caller);
		const { agents } = this.context.table.state;
		const inReach = reach && ((agent: Agent) => rootOf(agents, agent).id === reach.id);
		const recipients: Recipient[] = [];
		const refused: string[] = [];
		const outside: string[] = [];
		for (const text of named) {
			let recipient: Recipient;
			if (isPerson(text)) {
				if (caller.id === undefined) {
					throw new FacadeError('INVALID', `@${PERSON.name} is you: your messages go to agents.`);
				}
				recipient = HUMAN;
			} else {
				const agent = this.context.agentNamed(text, inReach);
				if (agent.exit) {
					refused.push(`${agentText(agent)} has ended (${agent.exit.kind}: ${agent.exit.reason})`);
					continue;
				}
				if (inReach && !inReach(agent)) {
					outside.push(agentText(agent));
					continue;
				}
				recipient = agent.id;
			}
			if (!recipients.includes(recipient)) {
				recipients.push(recipient);
			}
		}
		if (reach && outside.length) {
			refused.push(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} out of your reach: your YOLO is off, so you reach the agents of your own tree only - ${agentText(reach)} and the agents started from it - and @${PERSON.name}`);
		}
		if (refused.length) {
			throw new FacadeError('REFUSED', `${refused.join('; ')}. Nothing was sent.`);
		}
		return recipients;
	}

	/** The message `text` names for `reply_to`: one sent to the caller. */
	private repliedTo(caller: Caller, text: string): number {
		const id = messageNumberOf(text, 'reply_to');
		const message = this.context.table.state.mail.messages.get(id);
		if (!message) {
			throw new FacadeError('NOT_FOUND', `No message is #m${id}: reply_to names a message sent to you, by its number.`);
		}
		if (message.to !== (caller.id ?? HUMAN)) {
			throw new FacadeError('INVALID', `#m${id} was sent to ${this.whoOf(message.to)}, not to you: reply_to names a message sent to you.`);
		}
		return id;
	}

	/** Records a message, puts it into its chat rooms, and rings its recipient's doorbell, or tells the person. */
	private record(message: NewMessage): Message {
		const sent = this.context.table.messages.send(message);
		this.inRooms(`with #m${sent.id}`, () => this.rooms.append(sent.id));
		if (sent.to === HUMAN) {
			this.tellThePerson(sent);
		} else {
			this.doorbell.update(sent.to);
			this.watchDelivery(sent.to);
		}
		return sent;
	}

	/**
	 * The messages a fetch gives, marked, by number: the caller's unread ones, those asked for - in its
	 * reach, its YOLO off: those its tree's chat room has - or all sent to it.
	 */
	private take(caller: Caller, request: FetchRequest): Fetched {
		const recipient: Recipient = caller.id ?? HUMAN;
		const { state } = this.context.table;
		const mail = state.mail;
		if (request.all && request.ids?.length) {
			throw new FacadeError('INVALID', 'Give ids or all, not both: ids fetches messages by number, all every message sent to you.');
		}
		let ids: number[];
		let way: Fetched['way'];
		if (request.ids?.length) {
			way = 'ids';
			ids = [...new Set(request.ids.map(text => messageNumberOf(text, 'ids')))].sort((a, b) => a - b);
			const reach = this.reachOf(caller);
			for (const id of ids) {
				this.assertInMailbox(id);
				const message = mail.messages.get(id);
				if (reach && message && !rootsOf(state, message).some(root => root.id === reach.id)) {
					throw new FacadeError('REFUSED', `#m${id} is out of your reach: your YOLO is off, so you fetch by number only the messages to or from your own tree - ${agentText(reach)} and the agents started from it. Nothing was fetched.`);
				}
			}
		} else if (request.all) {
			way = 'all';
			ids = [...mail.mailboxes.get(recipient) ?? []];
		} else {
			way = 'unread';
			ids = unreadOf(mail, recipient).map(message => message.id);
		}
		const seen = typeof recipient === 'number' ? mail.seen.get(recipient) : undefined;
		const messages: FetchedMessage[] = [];
		for (const id of ids) {
			const message = mail.messages.get(id);
			const entry = mail.entries.get(id);
			if (!message || !entry) {
				continue;
			}
			const own = message.to === recipient;
			const givenAt = own ? entry.given[entry.given.length - 1] : seen?.get(id);
			messages.push({
				id,
				mark: entry.state === 'returned' ? 'returned' : givenAt !== undefined ? 'given before' : 'new',
				...(givenAt !== undefined ? { givenAt } : {}),
				from: this.whoOf(message.from),
				to: this.whoOf(message.to),
				own,
				state: entry.state,
				time: message.time,
				...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
				...(message.task ? { task: true } : {}),
				length: message.length
			});
		}
		if (messages.reduce((total, message) => total + message.length, 0) <= TEXT_IN_LINE) {
			return { way, messages: messages.map(message => ({ ...message, text: this.textOf(message.id) })) };
		}
		const file = this.context.table.messages.writeFetch(recipient, messages.map(message => `${headingOf(message)}\n${this.textOf(message.id)}\n`).join('\n'));
		return { way, messages, file };
	}

	/** Throws unless the message numbered `id` is in a mailbox: one from before the window last started is in the chat rooms only. */
	private assertInMailbox(id: number): void {
		const mail = this.context.table.state.mail;
		if (mail.entries.has(id)) {
			return;
		}
		const message = mail.messages.get(id);
		if (!message) {
			throw new FacadeError('NOT_FOUND', mail.lastMessage ? `No message is #m${id}: the last one is #m${mail.lastMessage}.` : `No message is #m${id}: none has been sent.`);
		}
		const room = id > mail.roomsDeletedUpTo ? this.rooms.roomOf(message) : undefined;
		throw new FacadeError('NOT_FOUND', room
			? `#m${id} is from before this window last started: it is in the chat room ${room} only.`
			: `#m${id} is from before this window last started, and the chat rooms with it were deleted: it is gone.`);
	}

	/** Records that the caller's own messages in a result were delivered, and works out its doorbell again. */
	private delivered(agent: number, fetched: Fetched): void {
		const own = fetched.messages.filter(message => message.own).map(message => message.id);
		try {
			this.context.table.messages.delivered(agent, own);
		} catch (err) {
			this.context.log(`That #a${agent} has its messages could not be recorded: ${messageOf(err)}. They are given again, marked.`);
			return;
		}
		this.doorbell.update(agent);
		this.watchDelivery(agent);
	}

	/**
	 * Sends a message its recipient ended without back to its sender, as a message of Facade's with its
	 * text; notes in its chat room one that cannot go back, and - `known` - one whose sender knows of the end.
	 */
	private giveBack(message: Message, recipient: Agent, how: string, known: boolean): void {
		const { table } = this.context;
		const sender = message.from;
		if (known || sender === FACADE || (sender !== undefined && !isLive(table.get(sender)))) {
			table.messages.returned(message.id, how, known ? { known: true } : {});
			this.inRooms(`with the note on #m${message.id}`, () => this.rooms.noteUnreturned(message.id));
			return;
		}
		const back = this.record({
			from: FACADE,
			to: sender ?? HUMAN,
			text: `#m${message.id} was not fetched by ${agentText(recipient)} before it ended (${how}).\nOriginal message:\n${table.messages.textOf(message) ?? ''}`,
			facade: 'returned',
			about: recipient.id
		});
		table.messages.returned(message.id, how, { as: back.id });
	}

	/**
	 * Tells the person of a message to them: its sender has something for them, its first line, and Show.
	 * One per agent, the next taking its place; quiet while that agent's terminal has their focus.
	 */
	private tellThePerson(message: Message): void {
		const { table } = this.context;
		const firstLine = (table.messages.textOf(message) ?? '').split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
		const shown = firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
		const from = typeof message.from === 'number' ? table.get(message.from) : undefined;
		const about = from ?? (message.about !== undefined ? table.get(message.about) : undefined);
		const show = l10n.t("Show");
		const text = from ? l10n.t("@{0} #a{1} has something for you: {2}", from.name, from.id, shown) : l10n.t("Facade: {0}", shown);
		const key = from ? `message:${from.id}` : `message:facade:${message.about ?? message.id}`;
		void this.context.ports.person.notify({ key, text, buttons: [show], ...(from ? { quietIn: this.context.terminalOf(from) } : {}) }).then(async choice => {
			if (choice === show) {
				await this.show(message, about);
			}
		}).catch(err => this.context.log(`A message to the person could not be shown: ${messageOf(err)}`));
	}

	/** Shows the person a message: the terminal of the agent it is from or about, else the message in its chat room, unless that was deleted. */
	private async show(message: Message, agent: Agent | undefined): Promise<void> {
		if (agent && isLive(this.context.table.get(agent.id)) && await this.context.ports.terminals.reveal(this.context.terminalOf(agent))) {
			return;
		}
		const room = message.id > this.context.table.state.mail.roomsDeletedUpTo ? this.rooms.roomOf(message) : undefined;
		if (room && fs.existsSync(room)) {
			await this.context.ports.person.openRoom(room, message.id);
		} else {
			this.context.ports.person.tell(l10n.t("#m{0} is in no chat room any more: the chat rooms were deleted.", message.id), undefined);
		}
	}

	/** Gathers the unexpected end of an agent the person started with those at the same moment, for one notification. */
	private gatherEnd(line: string): void {
		this.ends.push(line);
		if (this.endsTimer !== undefined) {
			return;
		}
		this.endsTimer = setTimeout(() => {
			this.endsTimer = undefined;
			const lines = this.ends.splice(0);
			if (!this.disposed && lines.length) {
				void this.context.ports.person.notify({ key: `ended:${Date.now()}`, text: lines.join(' '), buttons: [] })
					.catch(err => this.context.log(`The person could not be told of agents that ended: ${messageOf(err)}`));
			}
		}, ENDS_GATHERED_MS);
	}

	/** Waits for a running agent to fetch its task, for the timeout from when it was running: then its creator is told, once. */
	private watchTask(id: number): void {
		const mail = this.context.table.state.mail;
		const agent = this.context.table.get(id);
		const task = mail.tasks.get(id);
		if (this.disposed || this.tasks.has(id) || agent?.state !== 'running' || task === undefined || mail.notFetched.has(id) || mail.entries.get(task)?.state !== 'unread') {
			return;
		}
		const due = (agent.runningTime ?? Date.now()) + this.context.timing().startTimeoutMs;
		this.tasks.set(id, setTimeout(() => {
			this.tasks.delete(id);
			this.taskNotFetched(id, task);
		}, Math.max(0, due - Date.now())));
	}

	/**
	 * Tells an agent's creator that it has not fetched its task: by a message of Facade's, the person's
	 * too. Its task stays where it is. Once: `watchTask` waits no more for an agent whose creator was told.
	 */
	private taskNotFetched(id: number, task: number): void {
		const agent = this.context.table.get(id);
		if (this.disposed || !isLive(agent) || this.context.table.state.mail.entries.get(task)?.state !== 'unread'
			|| (agent.parent !== undefined && !isLive(this.context.table.get(agent.parent)))) {
			return;
		}
		const why = this.doorbell.holdUp(id);
		try {
			this.record({
				from: FACADE,
				to: agent.parent ?? HUMAN,
				text: `${agentText(agent)} has not fetched its task #m${task} since it started${why ? `: ${why}` : ''}. The task waits for it, and its doorbell rings again by itself. Facade cannot see what holds it up: its terminal shows that.`,
				facade: 'taskNotFetched',
				about: id
			});
		} catch (err) {
			this.context.log(`That ${this.context.terminalOf(agent)} has not fetched its task could not be told: ${messageOf(err)}`);
		}
	}

	/** Waits, for an agent with unread messages, until they have waited the timeout since their first doorbell was due: then their sender is told. */
	private watchDelivery(id: number): void {
		clearTimeout(this.delays.get(id));
		this.delays.delete(id);
		const due = this.delayDueAt(id);
		if (this.disposed || due === undefined) {
			return;
		}
		this.delays.set(id, setTimeout(() => {
			this.delays.delete(id);
			this.deliveryDelayed(id);
		}, Math.max(0, due - Date.now())));
	}

	/**
	 * When the agent's unread messages have waited the timeout since their first doorbell was due, the
	 * person's typing or a doorbell that failed not stopping that clock - but starting again with Facade
	 * turned on again, as no doorbell was due while it was off; undefined while none has to be told of: it
	 * is not running, its task waits - which has a notice of its own - only Facade's notices wait, or what
	 * waits was told of already.
	 */
	private delayDueAt(id: number): number | undefined {
		const { table } = this.context;
		const mail = table.state.mail;
		const agent = table.get(id);
		const unread = unreadOf(mail, id);
		const task = mail.tasks.get(id);
		if (agent?.state !== 'running' || !unread.some(message => message.from !== FACADE)
			|| (task !== undefined && mail.entries.get(task)?.state === 'unread')) {
			return undefined;
		}
		// Since the oldest that waits came, the mailbox was never left empty
		const oldest = unread[0];
		if ((mail.delayedAt.get(id) ?? -Infinity) >= oldest.time) {
			return undefined;
		}
		// Its first doorbell, where none rang for it yet, waits for a minute after the doorbell before, unless all was fetched since
		const last = mail.rungAt.get(id);
		const held = !mail.entries.get(oldest.id)?.rings && last !== undefined && (mail.drainedAt.get(id) ?? -Infinity) < last ? last + RING_GAP_MS : 0;
		return Math.max(oldest.time + NEW_MESSAGE_MS, held, agent.runningTime ?? agent.startTime, this.onAgainTime) + this.context.timing().startTimeoutMs;
	}

	/**
	 * Tells the sender of the oldest unread message of an agent's - an agent still running, or the person -
	 * that its messages have waited the timeout: which, and what holds them up where Facade knows. Once
	 * for as long as its mailbox is not emptied.
	 */
	private deliveryDelayed(id: number): void {
		const due = this.delayDueAt(id);
		if (this.disposed || due === undefined) {
			return;
		}
		if (due > Date.now()) {
			this.watchDelivery(id);
			return;
		}
		const { table } = this.context;
		const agent = table.get(id);
		const unread = unreadOf(table.state.mail, id);
		// The oldest sender still there to tell, the agent itself not: it has not fetched it
		const oldest = unread.find(message => message.from !== FACADE && message.from !== id && (message.from === undefined || isLive(table.get(message.from))));
		if (!agent || !oldest || oldest.from === FACADE) {
			return;
		}
		const ids = unread.slice(0, LISTED).map(message => `#m${message.id}`).join(', ') + (unread.length > LISTED ? `, and ${unread.length - LISTED} more` : '');
		const why = this.doorbell.holdUp(id);
		try {
			this.record({
				from: FACADE,
				to: oldest.from ?? HUMAN,
				text: `${agentText(agent)} has not fetched ${ids} in ${durationOf(Date.now() - unread[0].time)}${why ? `: ${why}` : ''}. The messages wait for it, and its doorbell rings again by itself; one goes back to its sender if it ends. Facade cannot see what holds it up: its terminal shows that.`,
				facade: 'delayed',
				about: id
			});
		} catch (err) {
			this.context.log(`That the messages of ${this.context.terminalOf(agent)} wait unfetched could not be told: ${messageOf(err)}`);
		}
	}

	/**
	 * As the window starts afresh: the files of the fetches of agents that did not run on through it go, and
	 * the files of long texts that neither a mailbox nor a chat room needs any more.
	 */
	private prune(): void {
		const { table } = this.context;
		const mail = table.state.mail;
		try {
			table.messages.deleteFetches(agent => isLive(table.get(agent)));
			table.messages.deleteTexts(id => mail.entries.has(id) || id > mail.roomsDeletedUpTo);
		} catch (err) {
			this.context.log(`The message files no longer needed could not all be deleted: ${messageOf(err)}`);
		}
	}

	/**
	 * The tree an agent caller reaches, its YOLO off: the agent the person started at the top of its
	 * creators. Undefined where it reaches the whole window: the person does, and an agent whose YOLO is on.
	 */
	private reachOf(caller: Caller): Agent | undefined {
		const agent = caller.id === undefined ? undefined : this.context.table.get(caller.id);
		return agent && !this.yoloOf(agent) ? rootOf(this.context.table.state.agents, agent) : undefined;
	}

	/** Whether the agent `id` is in the caller's reach: the caller's own tree, its YOLO off; else any. */
	inReach(caller: Caller, id: number): boolean {
		const reach = this.reachOf(caller);
		const agent = this.context.table.get(id);
		return !reach || (!!agent && rootOf(this.context.table.state.agents, agent).id === reach.id);
	}

	/**
	 * Whether an agent's YOLO is on: its CLI started with full access, as the ledger recorded it; for one a
	 * ledger before that did not say, as the person has it set up now. A CLI Facade no longer knows: off.
	 */
	private yoloOf(agent: Agent): boolean {
		if (agent.yolo !== undefined) {
			return agent.yolo;
		}
		const cli = this.context.clis.known.find(each => each.id === agent.cli);
		return !!cli && !!this.context.clis.configOf(cli).launch.arguments.fullAccess?.length;
	}

	/** A message's text; a note saying so for one whose file went with the chat rooms. */
	private textOf(id: number): string {
		const message = this.context.table.state.mail.messages.get(id);
		return (message && this.context.table.messages.textOf(message)) ?? '(Its text is gone: the chat rooms were deleted.)';
	}

	/** Writes to the chat rooms: one that fails is written again from the ledger as the window loads next. */
	private inRooms(what: string, write: () => void): void {
		try {
			write();
		} catch (err) {
			this.context.log(`The chat rooms could not be written ${what}: ${messageOf(err)}. They are written again as the window loads.`);
		}
	}

	/** Who sent or got a message, as Facade writes it. */
	private whoOf(who: Recipient | typeof FACADE | undefined): string {
		return whoOf(this.context.table.state, who);
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
	}
}

/** An agent as Facade's messages write it: `@name #a7`. */
export function agentText(agent: { readonly id: number; readonly name: string }): string {
	return `@${agent.name} #a${agent.id}`;
}

/** Whether `text` names the person: `@you`, or `@human`, as the other specs write them. */
function isPerson(text: string): boolean {
	const name = text.replace(/^@/, '').toLowerCase();
	return name === PERSON.name || name === HUMAN;
}

/** The number of the message `text` names, as `#m42`; throws, saying why, for what is none - an agent's number among them. */
function messageNumberOf(text: string, what: string): number {
	const trimmed = text.trim();
	if (AGENT_NUMBER.test(trimmed)) {
		throw new FacadeError('INVALID', `${trimmed} is an agent, not a message: ${what} takes a message's number, as #m42.`);
	}
	const id = MESSAGE_NUMBER.exec(trimmed)?.groups?.id;
	if (id === undefined || Number(id) < 1) {
		throw new FacadeError('INVALID', `${trimmed || 'An empty text'} is not a message's number: ${what} takes one as #m42.`);
	}
	return Number(id);
}

/** How long, as Facade's messages say it: seconds below two minutes, else minutes. */
function durationOf(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 120) {
		return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
	}
	return `${Math.round(seconds / 60)} minutes`;
}

/** A time of day as the messages give it: hours and minutes, on this machine's clock. */
export function clockOf(time: number): string {
	return new Date(time).toTimeString().slice(0, 5);
}

/**
 * A message's heading in a fetch: its number, its mark, who sent it to whom, when, what it answers, its
 * length, and whether it was delivered as the fetch took it.
 */
export function headingOf(message: FetchedMessage): string {
	return [
		`#m${message.id}`,
		message.mark === 'given before' && message.givenAt !== undefined ? `given before (${clockOf(message.givenAt)})` : message.mark,
		`from ${message.from} to ${message.own ? 'you' : message.to}`,
		clockOf(message.time),
		...(message.replyTo !== undefined ? [`re #m${message.replyTo}`] : []),
		...(message.task ? ['task'] : []),
		`${message.length.toLocaleString('en-US')} characters`,
		message.state
	].join(' · ');
}
