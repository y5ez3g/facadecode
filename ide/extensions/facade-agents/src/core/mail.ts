/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { DeferredPromise } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentTable } from '../record/agents';
import { Agent, Caller, describe, ForeignCaller, isLive, namesThePerson, PERSON, splitWorkspace, workspaceWordOf } from '../record/events';
import { FACADE, FacadeKind, ForeignAgent, foreignRef, HUMAN, isForeign, MailboxEntry, Message, NewMessage, Recipient, TEXT_IN_LINE, unreadOf } from '../record/messages';
import { OutboxNotice, removeNotice, WaitingNotice } from '../record/outbox';
import { ChatRooms, RoomRoot, whoOf } from '../record/rooms';
import { Doorbell, LaunchDelays, NEW_MESSAGE_MS, RING_GAP_MS } from './doorbell';
import { ErrorOutcome, FacadeError } from './errors';
import type { Located } from './facade';
import { CallerIdentity, Machine, silentText, WINDOW_REQUESTS } from './machine';
import { Disposable, Ports, Timing } from './ports';
import { excerptText } from './screens';

/** The root of the tree of a sender of another workspace, as its workspace named it (M9). */
function senderRoot(id: number, name: string, from: ForeignCaller): RoomRoot {
	const window = from.rootWindow ?? from.window;
	if (from.root === id && window === from.window) {
		return { id, name, window, label: from.label };
	}
	const known = from.ancestors?.find(each => each.id === from.root && each.window === window);
	return { id: from.root!, name: known?.name ?? `a${from.root}`, window, ...(known?.label ? { label: known.label } : {}) };
}

/** A message's number, as a tool is given it: `#m42`, or `m42`. */
const MESSAGE_NUMBER = /^#?m(?<id>\d+)$/i;
/** An agent, given where a message's number is asked for: `#a7`, `a7`, or `@name #a7`. */
const AGENT_NUMBER = /^(?:@\S+\s+)?#?a\d+$/i;
/** How much of a message's first line a notification shows. */
const SHOWN_CHARS = 200;
/** How many of an agent's unread messages its mailbox, or a notice of Facade's, names, the oldest: the others it counts. */
const LISTED = 10;

/** What the messages need of the core around them. */
export interface MailContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	/** How long the core waits, as the person sets it now: messages unfetched that long are told of. */
	timing(): Timing;
	/**
	 * The agent a tool names, as every Facade tool takes one (AGENT-ORCHESTRATION.md, O2): one the caller reaches
	 * (O1) - else refused, saying why.
	 */
	agentNamed(text: string, caller: Caller): Agent;
	/** Whether `caller` reaches `agent` (O1): the person every agent; an agent with YOLO on every agent, with it off its own tree. */
	reaches(caller: Caller, agent: Agent): boolean;
	/** An agent's first line, with its task: who it is, who created it, and the number of its task (M7). */
	firstLine(agent: Agent, task: number): string;
	/** The delays of an agent's launch, as its start had them. */
	delaysOf(agent: Agent): LaunchDelays;
	/** Whether the agent framework is on: off, no doorbell goes in (M10). */
	frameworkOn(): boolean;
	/** Whether the agent's MCP server is connected now. */
	isConnected(agent: Agent): boolean;
	/** The last lines of an agent's screen - of its final screen once it ended, waited for a moment - or undefined where there are none. */
	excerptOf(agent: Agent): Promise<{ readonly text: string } | undefined>;
	log(message: string): void;
	/** The other windows of the machine, where this window has them (AGENT-ORCHESTRATION.md, O8). */
	readonly machine?: Machine;
	/** Who a caller is, as this window tells another (O8). */
	identityOf(caller: Caller): CallerIdentity;
	/** Where the agent a tool names is: here, or in another window (O2, O8). */
	locate(caller: Caller, text: string): Promise<Located>;
	/** Whether `caller` reaches the other windows: the person, and an agent of this window with YOLO on (O1). */
	reachesMachine(caller: Caller): boolean;
	/** The notices other workspaces left for this one's agents, oldest first (O8); none where left out. */
	notices?(): readonly WaitingNotice[];
	/** The workspace `text` names, this one or another - refused where it names none or several (O2). */
	workspaceNamed(text: string): Promise<{ readonly record: string; readonly label: string }>;

	/** The tree an agent of this record is in: its root's number and the root's workspace (O8). */
	treeOf(agent: Agent): { readonly root: number; readonly window: string };
	/** Where the machine's chat rooms are (M9); the record's own folder where left out. */
	readonly roomsFolder?: string;
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
	/** Set where its recipient runs, its MCP server gone: its doorbell rings once it connects again (M2). */
	readonly reconnecting?: true;
	/** Set where its recipient's YOLO is off and its tree is not the caller's: it can reply to the person only. */
	readonly cannotReply?: true;
	/** The window of a recipient of another window, as the windows name it (M2). */
	readonly window?: string;
}

/** A recipient a send could not reach, as its window found it at delivery - ended meanwhile - and why (M11). */
export interface NotSent {
	readonly to: string;
	readonly why: string;
}

/** What a send answers with: the messages recorded, and the recipients of other windows refused at delivery alone. */
export interface Sent {
	readonly sent: readonly SentMessage[];
	readonly notSent: readonly NotSent[];
}

/** A recipient of a send: of this window, or an agent of another window. */
type Addressee = { readonly kind: 'here'; readonly here: Recipient } | { readonly kind: 'afar'; readonly afar: { readonly window: string; readonly label: string; readonly id: number; readonly text: string } };

/**
 * What a send to several that Facade failed to record partway answers with, its text made of it too (AGENT-MESSAGES.md,
 * M11; AGENT-ORCHESTRATION.md, O2): the messages it recorded, by number and recipient - they went, and sent again they would
 * come twice - and that what became of the rest is not known.
 */
interface SendCutShort extends ErrorOutcome {
	readonly outcome: 'unknown';
	readonly sent: NonNullable<ErrorOutcome['sent']>;
}

/** What a fetch asks for: the caller's unread messages, with nothing; messages by number, `ids`; or `all` sent to it. */
export interface FetchRequest {
	readonly ids?: readonly string[];
	readonly all?: boolean;
}

/** A message as a fetch gives it. */
export interface FetchedMessage {
	readonly id: number;
	/** Its sender and its recipient, as Facade writes them. */
	readonly from: string;
	readonly to: string;
	/** Whether it was sent to the caller. */
	readonly own: boolean;
	/**
	 * Its delivery state as the fetch took it: one the caller fetches now is delivered once its result reaches it - and, for
	 * a message to an agent of another window, unknown while that window, whose state it is, does not answer (M4).
	 */
	readonly state: MailboxEntry['state'] | 'unknown';
	/** The window that holds it, where that is another window of the machine: its label (M4). */
	readonly window?: string;
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
	/** For the person's history of every workspace: those that did not answer, whose messages are not in it (M9). */
	readonly silent?: readonly string[];
}

/** An agent's mailbox, as `list_agents` gives it (AGENT-MESSAGES.md, M3). */
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
 * delivered at least once - a result that did not reach the pipe leaves them unread, to come again - or, its
 * recipient ending, goes back to its sender, or is noted in its chat room where its sender ended; the chat
 * rooms keep them all. An agent whose YOLO is off reaches the agents of its own tree only, and the person.
 * Every message is recorded before anything is done with it.
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
	/** Children whose creators are told of their ends once their last screens are kept, by number: each notice's first line. */
	private readonly endsToTell = new Map<number, string>();
	/** When the agent framework was turned on again in this window, where it was: no doorbell was due while it was off. */
	private onAgainTime = 0;
	private disposed = false;
	/** Set as the workspace closes: the ends it records are told of at once, with no last screen awaited (L6). */
	private closing = false;

	constructor(private readonly context: MailContext) {
		const { table } = context;
		this.rooms = new ChatRooms(context.roomsFolder ?? path.join(table.dir, 'rooms'), context.machine?.self.record ?? path.basename(table.dir), () => table.state, table.messages, () => context.machine ? table.sharedMark('agents') : 0);
		this.doorbell = new Doorbell({
			table,
			ports: context.ports,
			delaysOf: agent => context.delaysOf(agent),
			firstLine: (agent, task) => context.firstLine(agent, task.id),
			senderOf: message => this.whoOf(message.from),
			fetchesDone: id => this.fetching.get(id) ?? Promise.resolve(),
			frameworkOn: () => context.frameworkOn(),
			isConnected: agent => context.isConnected(agent),
			log: message => context.log(message)
		});
	}

	dispose(): void {
		// Ends whose last screens are still awaited are told of now, without them: their notices outlive Facade
		for (const [id, first] of [...this.endsToTell]) {
			this.endsToTell.delete(id);
			this.tellEnd(id, first, undefined, true);
		}
		this.disposed = true;
		this.doorbell.dispose();
		for (const timer of [...this.tasks.values(), ...this.delays.values()]) {
			clearTimeout(timer);
		}
		this.tasks.clear();
		this.delays.clear();
	}

	/**
	 * Sends a message from the caller to each recipient `to` names - an agent of the window in the caller's reach, or the
	 * person - each its own, under its own number; answers as soon as they are recorded, not when they are fetched. A
	 * recipient that ended, or is out of reach, refuses the whole send, and nothing is sent.
	 */
	send(caller: Caller, to: readonly string[], text: string, replyTo: string | undefined): SentMessage[] {
		this.stillOpen();
		const recipients = this.recipientsHere(caller, to);
		assertText(text);
		const answers = replyTo === undefined ? undefined : this.repliedToHere(caller, replyTo);
		const sent: SentMessage[] = [];
		for (const recipient of recipients) {
			try {
				sent.push(this.sendOne(caller, recipient, text, answers));
			} catch (err) {
				throw this.cutShort(sent, this.whoOf(recipient), err);
			}
		}
		return sent;
	}

	/**
	 * Sends a message as `send` does, to recipients of every window of the machine the caller reaches: one of another
	 * window gets it from its own window, which numbers it; this one keeps the sender's copy under that number - and one that
	 * window refuses as it gets it, ended meanwhile, is that recipient's refusal alone (AGENT-MESSAGES.md, M2, M11).
	 */
	async sendAcross(caller: Caller, to: readonly string[], text: string, replyTo: string | undefined): Promise<Sent> {
		if (!this.context.machine || !this.context.reachesMachine(caller)) {
			return { sent: this.send(caller, to, text, replyTo), notSent: [] };
		}
		this.stillOpen();
		const recipients = await this.recipientsOf(caller, to);
		await this.context.table.numbersReady();
		this.stillOpen();
		assertText(text);
		const answers = replyTo === undefined ? undefined : await this.repliedTo(caller, replyTo);
		const sent: SentMessage[] = [];
		const notSent: NotSent[] = [];
		for (const recipient of recipients) {
			let message: SentMessage;
			try {
				if (recipient.kind === 'afar') {
					const delivered = await this.deliverAfar(caller, recipient.afar, text, answers);
					if (delivered.kind === 'refused') {
						notSent.push(delivered.notSent);
						continue;
					}
					message = delivered.sent;
				} else {
					message = this.sendOne(caller, recipient.here, text, answers);
				}
			} catch (err) {
				throw this.cutShort(sent, recipient.kind === 'afar' ? recipient.afar.text : this.whoOf(recipient.here), err);
			}
			sent.push(message);
		}
		if (!sent.length && notSent.length) {
			throw new FacadeError('REFUSED', `${notSent.map(each => `${each.to}: ${each.why}`).join('; ')}. Nothing was sent.`);
		}
		return { sent, notSent };
	}

	/** Records one message from the caller to `recipient`, of this window, as `send` answers with it. */
	private sendOne(caller: Caller, recipient: Recipient, text: string, replyTo: number | undefined): SentMessage {
		const own = caller.id === undefined ? undefined : this.context.table.get(caller.id);
		const recorded = this.record({ ...(caller.id !== undefined ? { from: caller.id } : {}), to: recipient, text, ...(replyTo !== undefined ? { replyTo } : {}) });
		const agent = typeof recipient === 'number' ? this.context.table.get(recipient) : undefined;
		return {
			id: recorded.id,
			to: this.whoOf(recorded.to),
			toPerson: recorded.to === HUMAN,
			...(agent?.state === 'starting' ? { starting: true } : {}),
			...(agent?.state === 'running' && agent.integration && !this.context.isConnected(agent) ? { reconnecting: true } : {}),
			// Its YOLO off, it reaches its own tree and the person alone: not a caller of another tree (M2)
			...(agent && own && !agent.yolo && agent.root !== own.root ? { cannotReply: true } : {})
		};
	}

	/** What a send that failed to record its message to `whom` throws: the failure, where nothing went; else what went, and that the rest is unknown. */
	private cutShort(sent: readonly SentMessage[], whom: string, err: unknown): unknown {
		// Those recorded are sent: sent again, they would come twice
		if (!sent.length) {
			return err;
		}
		// Said in words and in data alike, from the one record of what went
		const cutShort: SendCutShort = { outcome: 'unknown', sent: sent.map(each => ({ id: each.id, to: each.to })) };
		return new FacadeError('FAILED', `Recorded messages: ${cutShort.sent.map(each => `#m${each.id} to ${each.to}`).join(', ')}. Failed to record a message to ${whom}: ${messageOf(err)}\nFurther effects are unknown. Do not resend the messages listed above; inspect the recorded state before sending again.`, cutShort);
	}

	/**
	 * Hands a message to an agent of another window, which records it in its mailbox under a number of its own and rings
	 * it - then keeps the sender's copy here under that number (M11). Its window refusing it - the agent ended meanwhile -
	 * is that recipient's refusal alone; a window that does not answer, or answers nothing that can be read, fails it.
	 */
	private async deliverAfar(caller: Caller, to: { readonly window: string; readonly label: string; readonly id: number; readonly text: string }, text: string, replyTo: number | undefined): Promise<{ readonly kind: 'sent'; readonly sent: SentMessage } | { readonly kind: 'refused'; readonly notSent: NotSent }> {
		const machine = this.context.machine;
		if (!machine) {
			throw new FacadeError('UNAVAILABLE', `Cannot reach ${to.text}: this workspace has no link to other workspaces.`);
		}
		let answer: unknown;
		try {
			answer = await machine.call(to.window, WINDOW_REQUESTS.deliver, { caller: this.context.identityOf(caller), to: to.id, text, ...(replyTo !== undefined ? { replyTo } : {}) }, () => undefined);
		} catch (err) {
			if (err instanceof FacadeError && err.code === 'REFUSED') {
				return { kind: 'refused', notSent: { to: to.text, why: messageOf(err) } };
			}
			throw err;
		}
		const { id, name, starting, reconnecting } = (answer ?? {}) as { [key: string]: unknown };
		if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || typeof name !== 'string') {
			throw new FacadeError('FAILED', `Workspace ${to.label} answered the delivery to ${to.text} with nothing that names its message. Whether it was recorded is unknown; inspect with read_messages before sending again.`, { outcome: 'unknown' });
		}
		const recipient: ForeignAgent = { id: to.id, name, window: to.window, label: to.label };
		const copy = this.context.table.messages.copy(id, { ...(caller.id !== undefined ? { from: caller.id } : {}), to: recipient, text, ...(replyTo !== undefined ? { replyTo } : {}) });
		this.inRooms(`with #m${copy.id}`, () => this.rooms.append(copy.id));
		return { kind: 'sent', sent: { id, to: foreignRef(recipient), toPerson: false, window: to.label, ...(starting === true ? { starting: true } : {}), ...(reconnecting === true ? { reconnecting: true } : {}) } };
	}

	/**
	 * A message from an agent of another window to one of this window's, `to`, as its window hands it over (M11): recorded
	 * in its mailbox under this window's next number, written in its chat room, and rung. A recipient that ended, is
	 * stopping, has no Facade tools, or is out of the caller's reach is refused, saying why.
	 */
	receive(caller: Caller, to: number, text: string, replyTo: number | undefined): SentMessage & { readonly name: string } {
		this.stillOpen();
		const agent = this.context.table.get(to);
		if (!agent || !this.context.reaches(caller, agent)) {
			throw new FacadeError('NOT_FOUND', `No agent has ID #a${to} in workspace ${this.context.machine?.self.label ?? 'this workspace'}.`);
		}
		const why = agent.end ? `${describe(agent)} has ended (${agent.end.kind}: ${agent.end.reason})` : agent.state === 'stopping' ? `${describe(agent)} is stopping` : !agent.integration ? `${describe(agent)} cannot fetch messages because it was started without Facade tools` : undefined;
		if (why) {
			throw new FacadeError('REFUSED', why);
		}
		if (!text.trim() || caller.id === undefined && !caller.from) {
			throw new FacadeError('INVALID', 'A delivery needs a sender and a nonempty text.');
		}
		const from: ForeignAgent | undefined = caller.id === undefined || !caller.from ? undefined : { id: caller.id, name: caller.name, window: caller.from.window, label: caller.from.label };
		const replied = replyTo !== undefined && this.context.table.state.mail.messages.has(replyTo) ? replyTo : undefined;
		// Written into the sender's tree's room too, whose root its workspace named: this workspace records the message (M9)
		const root = caller.from && caller.from.root !== undefined && caller.id !== undefined ? senderRoot(caller.id, caller.name, caller.from) : undefined;
		// From the person's script in another workspace: a return goes back to the person there (M6)
		const personAfar = caller.id === undefined && caller.from ? { window: caller.from.window, label: caller.from.label } : undefined;
		const message = this.record({ ...(from ? { from } : {}), ...(personAfar ? { personAfar } : {}), to, text, ...(replied !== undefined ? { replyTo: replied } : {}) }, root ? [root] : []);
		return {
			id: message.id,
			name: agent.name,
			to: describe(agent),
			toPerson: false,
			...(agent.state === 'starting' ? { starting: true } : {}),
			...(agent.state === 'running' && !this.context.isConnected(agent) ? { reconnecting: true } : {})
		};
	}

	/** The sender's copy `id` of a message to another workspace's agent was recorded: written into its chat rooms (M9). */
	copied(id: number): void {
		this.inRooms(`with #m${id}`, () => this.rooms.append(id));
	}

	/** This workspace, as the agents of other workspaces are told it with its agents: `lab, 1a2b3c4d` (O2). */
	private get selfName(): string {
		const self = this.context.machine?.self;
		return self ? workspaceWordOf(self.label, self.record) : 'another workspace';
	}

	/** The workspace closes: what its ends tell, from now, is told at once (AGENT-LAUNCHER.md, L6). */
	closingNow(): void {
		this.closing = true;
	}

	/**
	 * Takes the notices other workspaces left for this one's agents (O8): a message one's recipient there ended without,
	 * going back; messages waiting there unfetched; a child's end, or its task unfetched (M6, M8). Each is recorded once, by
	 * its key, and rung - one for an agent that ended, recorded as not delivered - then removed. While the agent framework
	 * is off they wait where they are, as M10 keeps any.
	 */
	takeNotices(): void {
		if (this.disposed || !this.context.notices || !this.context.frameworkOn()) {
			return;
		}
		const { table } = this.context;
		for (const { file, notice } of this.context.notices()) {
			try {
				if (!table.state.mail.noticeKeys.has(notice.key)) {
					const agent = notice.to === 'human' ? undefined : table.get(notice.to);
					// The copy it settles is this record's own: a number no copy has here settles nothing
					const original = notice.message !== undefined && isForeign(table.state.mail.messages.get(notice.message)?.to) ? notice.message : undefined;
					if (notice.to === 'human') {
						this.record({ from: FACADE, to: HUMAN, text: notice.text, facade: notice.kind, about: notice.about, key: notice.key, ...(original !== undefined ? { original } : {}) });
					} else if (isLive(agent)) {
						this.record({ from: FACADE, to: notice.to, text: notice.text, facade: notice.kind, about: notice.about, key: notice.key, ...(original !== undefined ? { original } : {}) });
					} else if (agent && typeof notice.to === 'number') {
						table.messages.noticeTaken(notice.key, notice.to);
					}
				}
				removeNotice(file);
			} catch (err) {
				this.context.log(`Could not take a notice from another workspace (${notice.key}): ${messageOf(err)}`);
			}
		}
	}

	/**
	 * Records a notice of Facade's about this record's own messages and agents, raised here - a workspace gone or silent,
	 * as O8 has it - under `key`, once, for the live agent `to`.
	 */
	noticeHere(to: number, text: string, kind: FacadeKind, about: number | ForeignAgent, key: string, original?: number): void {
		const { table } = this.context;
		if (this.disposed || table.state.mail.noticeKeys.has(key) || !isLive(table.get(to))) {
			return;
		}
		this.record({ from: FACADE, to, text, facade: kind, about, key, ...(original !== undefined ? { original } : {}) });
	}

	/** Records the task the creator gives a new agent: a message to it, sent as it was recorded (M7). */
	sendTask(creator: Caller, agent: Agent, text: string): Message {
		// From a creator of another workspace: its task is from that agent, its sender's copy kept there (M7, M11)
		if (agent.creatorAfar) {
			return this.record({ from: agent.creatorAfar, to: agent.id, text, task: true }, agent.rootAfar ? [{ id: agent.rootAfar.id, name: agent.rootAfar.name, window: agent.rootAfar.window, ...(agent.rootAfar.label ? { label: agent.rootAfar.label } : {}) }] : []);
		}
		return this.record({ ...(creator.id !== undefined ? { from: creator.id } : {}), to: agent.id, text, task: true });
	}

	/** Records that the agent's first line, given as its launch argument, rang for its task (M7). */
	firstRing(agent: Agent, task: number): void {
		this.context.table.messages.rang(agent.id, [task]);
	}

	/** An agent is running: its doorbell is due from now on, and its task and its messages are waited for. */
	running(agent: Agent): void {
		this.doorbell.update(agent.id);
		this.watchTask(agent.id);
		this.watchDelivery(agent.id);
	}

	/** An agent's MCP server said hello: connected again, its doorbell rings again, where it waited for that. */
	connected(agent: Agent): void {
		if (agent.state === 'running') {
			this.doorbell.connected(agent.id);
		}
	}

	/**
	 * The agent framework was turned on, or off: on, the agents running are watched again, their doorbells due
	 * from now - none was while it was off - and the person is shown what came for them meanwhile (M10); off, no
	 * doorbell is due, and none that has not begun goes in.
	 */
	frameworkChanged(on: boolean): void {
		if (on) {
			this.recover(false, true);
			return;
		}
		// Nothing can be fetched meanwhile: no task or message is told of as unfetched for it
		for (const timer of [...this.tasks.values(), ...this.delays.values()]) {
			clearTimeout(timer);
		}
		this.tasks.clear();
		this.delays.clear();
		for (const agent of this.context.table.state.agents.values()) {
			this.doorbell.update(agent.id);
		}
	}

	/**
	 * Fetches messages for the caller: its unread ones, those numbered `ids` in its reach, or `all` sent to
	 * it. Its fetches run one after the other; one is done once the pipe said whether its result went
	 * out. The caller's own messages in a result that went out are delivered; those in one that did not
	 * are unread still, and come again under their numbers. Texts that come to more than a result holds are
	 * all in one file.
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
			const fetched = await this.takeAcross(caller, request);
			this.stillOpen();
			const agent = caller.id;
			if (agent === undefined || !fetched.messages.length) {
				turn.complete();
				return fetched;
			}
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
		if (!agent || !this.context.reaches(caller, agent)) {
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
	 * An agent ended, `how` saying how - `told`, as its creator's notice says it; `tell` says whether its creator, an agent, is told: by a message of
	 * Facade's, while it runs (M8) - the person hears of the ends of the agents they started as L6 has it. Its
	 * unread messages go back to their senders, oldest first - every live one, the person whose window went among
	 * them (M6) - but Facade's own, and those of a sender that ended: for those its chat room notes it.
	 */
	ended(agent: Agent, how: string, tell: boolean, told = how): void {
		this.doorbell.forget(agent.id);
		for (const timers of [this.tasks, this.delays]) {
			clearTimeout(timers.get(agent.id));
			timers.delete(agent.id);
		}
		if (tell && (agent.creatorAfar || (agent.creator !== undefined && isLive(this.context.table.get(agent.creator))))) {
			this.tellCreatorOfEnd(agent, told);
		}
		for (const message of unreadOf(this.context.table.state.mail, agent.id)) {
			this.giveBack(message, agent, how);
		}
		// Its children whose tasks wait unfetched: no notice of that can go to it now, so their other senders hear of
		// what waits (M6) - their watch set again
		for (const child of this.context.table.state.agents.values()) {
			if (child.creator === agent.id && child.state === 'running') {
				this.watchDelivery(child.id);
			}
		}
	}

	/**
	 * Tells an agent's creator that it ended, by a message of Facade's: how, then the last lines of its screen, which
	 * the window keeps a moment after the end (AGENT-DEBUGGING.md D6) - or that none was kept.
	 */
	private tellCreatorOfEnd(agent: Agent, how: string): void {
		const first = `${describe(agent)}${agent.creatorAfar ? ` (workspace ${this.selfName})` : ''} ended: ${how}. It can no longer receive messages.`;
		// Its workspace closing: told at once, as the workspace goes, with no last screen to wait for (L6)
		if (this.closing) {
			this.tellEnd(agent.id, first, undefined, true, true);
			return;
		}
		this.endsToTell.set(agent.id, first);
		void this.context.excerptOf(agent).catch(err => {
			this.context.log(`Could not read ${describe(agent)}'s screen excerpt for its creator: ${messageOf(err)}`);
			return undefined;
		}).then(excerpt => {
			// Told of already, as Facade stopped meanwhile
			if (this.endsToTell.delete(agent.id)) {
				this.tellEnd(agent.id, first, excerpt?.text);
			}
		});
	}

	/**
	 * Records the notice of agent `id`'s end for its creator, while that runs: `first`, then the last lines of its screen
	 * where it was kept - or, `stopping`, that Facade stopped before it read them: the window keeps the screen all the same.
	 */
	private tellEnd(id: number, first: string, excerpt: string | undefined, stopping = false, closing = false): void {
		const agent = this.context.table.get(id);
		const text = excerpt !== undefined ? `${first}\n${excerptText(id, excerpt)}`
			: closing ? `${first} Its workspace closed with it; no final screen was kept.`
				: stopping ? `${first} Facade shut down before reading the final screen. After Facade reconnects, call read_screen with agent #a${id}.`
				: `${first} No final screen was saved. Call read_screen with agent #a${id} to find out why.`;
		// Its creator in another workspace: told by that workspace, from its outbox (M8, O8)
		if (agent?.creatorAfar) {
			this.noticeAfar(agent.creatorAfar, `ended-a${id}`, text, 'ended', agent);
			return;
		}
		const creator = agent?.creator === undefined ? undefined : this.context.table.get(agent.creator);
		if (!agent || !creator || !isLive(creator)) {
			return;
		}
		try {
			this.record({ from: FACADE, to: creator.id, text, facade: 'ended', about: id });
		} catch (err) {
			this.context.log(`Could not notify the creator that ${describe(agent)} ended: ${messageOf(err)}`);
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
		this.showHeld();
	}

	/**
	 * Shows the person what came for them while the agent framework was off, held unread in the record - a reload
	 * meanwhile included - once it is on: recorded delivered, and told (M10; MS-03).
	 */
	private showHeld(): void {
		if (!this.context.frameworkOn()) {
			return;
		}
		const held = unreadOf(this.context.table.state.mail, HUMAN);
		try {
			this.context.table.messages.shown(held.map(message => message.id));
		} catch (err) {
			this.context.log(`Could not record delivery of notifications held for the person while the agent framework was disabled: ${messageOf(err)}`);
		}
		held.forEach(message => this.tellThePerson(message));
	}

	/**
	 * Facade: Delete Chat Rooms. The rooms go for good, and the files of long texts with them, but those
	 * the mailboxes of this session still give: the messages stay with their agents.
	 */
	deleteRooms(): void {
		this.stillOpen();
		const { table } = this.context;
		table.messages.roomsDeleted();
		this.rooms.delete(table.machineLast('messages'));
		const mail = table.state.mail;
		table.messages.deleteTexts(id => mail.entries.has(id));
	}

	/**
	 * Who `to` names, each once: agents of this window or another of the machine, by `#a7`, `@name` or `@name #a7`, or the
	 * person. Throws, saying why, where one is none, has ended, or is out of the caller's reach - checked, for one of another
	 * window, by that window as it gets the message (M11).
	 */
	private async recipientsOf(caller: Caller, to: readonly string[]): Promise<Addressee[]> {
		const named = namedIn(to);
		const recipients: Addressee[] = [];
		const refused: string[] = [];
		for (const text of named) {
			const located = namesThePerson(text) ? { here: true as const } : await this.context.locate(caller, text);
			if (!located.here) {
				if (!recipients.some(each => each.kind === 'afar' && each.afar.window === located.window && each.afar.id === located.id)) {
					recipients.push({ kind: 'afar', afar: { window: located.window, label: located.label, id: located.id, text: splitWorkspace(text).workspace !== undefined ? text : `${text} (workspace ${workspaceWordOf(located.label, located.window)})` } });
				}
				continue;
			}
			const recipient = this.recipientHere(caller, text, refused);
			if (recipient !== undefined && !recipients.some(each => each.kind === 'here' && each.here === recipient)) {
				recipients.push({ kind: 'here', here: recipient });
			}
		}
		if (refused.length) {
			throw new FacadeError('REFUSED', `${refused.join('; ')}. Nothing was sent.`);
		}
		return recipients;
	}

	/** Who `to` names, each once, all of this window: its agents, by `#a7`, `@name` or `@name #a7`, or the person (M2). */
	private recipientsHere(caller: Caller, to: readonly string[]): Recipient[] {
		const recipients: Recipient[] = [];
		const refused: string[] = [];
		for (const text of namedIn(to)) {
			const recipient = this.recipientHere(caller, text, refused);
			if (recipient !== undefined && !recipients.includes(recipient)) {
				recipients.push(recipient);
			}
		}
		if (refused.length) {
			throw new FacadeError('REFUSED', `${refused.join('; ')}. Nothing was sent.`);
		}
		return recipients;
	}

	/**
	 * The recipient of this window `text` names: the person, or an agent the caller reaches - one that ended, is stopping
	 * or has no Facade tools added to `refused` instead, saying why. Throws where it names none, or one out of reach.
	 */
	private recipientHere(caller: Caller, text: string, refused: string[]): Recipient | undefined {
		if (namesThePerson(text)) {
			if (caller.id === undefined) {
				throw new FacadeError('INVALID', `You are ${describe(PERSON)}. Send messages to agents, not to yourself.`);
			}
			return HUMAN;
		}
		// Out of the caller's reach, refused as every tool refuses it: nothing is sent
		const agent = this.context.agentNamed(text, caller);
		if (agent.end) {
			refused.push(`${describe(agent)} has ended (${agent.end.kind}: ${agent.end.reason})`);
			return undefined;
		}
		if (agent.state === 'stopping') {
			refused.push(`${describe(agent)} is stopping`);
			return undefined;
		}
		// Launched without Facade's integration, it has no tool to fetch with (M2)
		if (!agent.integration) {
			refused.push(`${describe(agent)} cannot fetch messages because it was started without Facade tools: its launch has no connect group, or the agent framework was disabled`);
			return undefined;
		}
		return agent.id;
	}

	/**
	 * The message `text` names for `reply_to`: one sent to the caller - for the person, one to them in any window's mailbox,
	 * which that window confirms (M9).
	 */
	private async repliedTo(caller: Caller, text: string): Promise<number> {
		const id = messageNumberOf(text, 'reply_to');
		const message = this.context.table.state.mail.messages.get(id);
		if (!message && caller.id === undefined && this.context.machine && this.context.reachesMachine(caller)) {
			const { answers } = await this.context.machine.ask(WINDOW_REQUESTS.messages, { caller: this.context.identityOf(caller), ids: [id] });
			if (answers.some(({ answer }) => fetchedOf(answer).some(each => each.id === id && each.own))) {
				return id;
			}
		}
		return this.repliedToHere(caller, text);
	}

	/** The message `text` names for `reply_to`, of this window: one sent to the caller. */
	private repliedToHere(caller: Caller, text: string): number {
		const id = messageNumberOf(text, 'reply_to');
		const message = this.context.table.state.mail.messages.get(id);
		if (!message) {
			throw new FacadeError('NOT_FOUND', `Message #m${id} was not found. reply_to must identify a message addressed to you.`);
		}
		if (message.to !== (caller.id ?? HUMAN)) {
			throw new FacadeError('INVALID', `Message #m${id} was addressed to ${this.whoOf(message.to)}, not to you. reply_to must identify a message addressed to you.`);
		}
		return id;
	}

	/**
	 * Records a message, puts it into its chat rooms, and rings its recipient's doorbell, or tells the person - once the
	 * agent framework is on: one that comes for them while it is off waits for it, as an agent's does (M10).
	 */
	private record(message: NewMessage, rooms: readonly RoomRoot[] = []): Message {
		// Held in the record, unread, for the person while the framework is off: shown once it is on, a reload meanwhile too
		const held = message.to === HUMAN && !this.context.frameworkOn();
		const sent = this.context.table.messages.send(held ? { ...message, held } : message);
		this.inRooms(`with #m${sent.id}`, () => this.rooms.append(sent.id, rooms));
		if (sent.to === HUMAN) {
			if (!held) {
				this.tellThePerson(sent);
			}
		} else if (typeof sent.to === 'number') {
			this.doorbell.update(sent.to);
			this.watchDelivery(sent.to);
		}
		return sent;
	}

	/**
	 * The messages a fetch gives, by number: the caller's unread ones, those asked for - in its
	 * reach, its YOLO off: those its tree's chat room has - or all sent to it.
	 */
	private take(caller: Caller, request: FetchRequest, pack = true): Fetched {
		// An agent of another window has no mailbox here - its number may be one of this window's agents' - and reads by
		// number alone (O8)
		const recipient: Recipient | undefined = caller.from && caller.id !== undefined ? undefined : caller.id ?? HUMAN;
		const { state } = this.context.table;
		const mail = state.mail;
		if (request.all && request.ids?.length) {
			throw new FacadeError('INVALID', 'Use ids for specific messages or all:true for your inbox history, not both. Nothing was fetched.');
		}
		let ids: number[];
		let way: Fetched['way'];
		if (request.ids?.length) {
			way = 'ids';
			ids = [...new Set(request.ids.map(text => messageNumberOf(text, 'ids')))].sort((a, b) => a - b);
			for (const id of ids) {
				this.assertReadable(id, caller);
				this.assertInMailbox(id);
			}
		} else if (request.all) {
			way = 'all';
			ids = recipient === undefined ? [] : [...mail.mailboxes.get(recipient) ?? []];
		} else {
			way = 'unread';
			ids = recipient === undefined ? [] : unreadOf(mail, recipient).map(message => message.id);
		}
		const messages: FetchedMessage[] = [];
		for (const id of ids) {
			const message = mail.messages.get(id);
			const entry = mail.entries.get(id);
			if (!message || !entry) {
				continue;
			}
			const own = message.to === recipient;
			messages.push({
				id,
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
		const withTexts = messages.map(message => ({ ...message, text: this.textOf(message.id) }));
		return pack && recipient !== undefined ? this.packed(recipient, way, withTexts) : { way, messages: withTexts };
	}

	/**
	 * Refuses `caller` the message `id` this window holds where its YOLO is off and the message went neither to nor from
	 * its tree, of this workspace or another (M4; AGENT-ORCHESTRATION.md, O1).
	 */
	private assertReadable(id: number, caller: Caller): void {
		if (!this.isReadable(id, caller)) {
			const own = caller.id === undefined || caller.from ? undefined : this.context.table.get(caller.id);
			const tree = this.readingTree(caller)!;
			const root = own?.rootAfar ? foreignRef(own.rootAfar) : own ? this.whoOf(tree.root) : `#a${tree.root}`;
			throw new FacadeError('REFUSED', `Cannot fetch #m${id}: it is outside your reach. With YOLO off, an ID lookup can read only messages to or from your tree, rooted at ${root}. Nothing was fetched.`);
		}
	}

	/** Whether `caller` may read the message `id` this window holds: with YOLO off, one to or from its tree alone (M4; O1). */
	private isReadable(id: number, caller: Caller): boolean {
		const message = this.context.table.state.mail.messages.get(id);
		const tree = this.readingTree(caller);
		return !tree || !message || this.inTree(message, tree, caller);
	}

	/** The tree `caller` reads by number in where its YOLO is off, of this workspace or another; none with YOLO on. */
	private readingTree(caller: Caller): { readonly root: number; readonly window: string } | undefined {
		const own = caller.id === undefined || caller.from ? undefined : this.context.table.get(caller.id);
		return own && !own.yolo ? this.context.treeOf(own)
			: caller.from && caller.id !== undefined && !caller.from.yolo && caller.from.root !== undefined ? { root: caller.from.root, window: caller.from.rootWindow ?? caller.from.window } : undefined;
	}

	/** Whether a message went to or from the tree `tree`, or is about one of it: a party of this record in it, or the caller itself. */
	private inTree(message: Message, tree: { readonly root: number; readonly window: string }, caller: Caller): boolean {
		const { state } = this.context.table;
		return [message.from, message.to, message.from === FACADE ? message.about : undefined].some(party => {
			if (isForeign(party)) {
				return party.id === caller.id && party.window === caller.from?.window;
			}
			if (typeof party !== 'number') {
				return false;
			}
			const agent = state.agents.get(party);
			// One that left the list is in its tree as it was: of this workspace, or the root's where that is another (M9)
			const known = agent ? undefined : state.identities.get(party);
			const at = agent ? this.context.treeOf(agent) : known ? { root: known.root, window: known.rootWindow ?? this.context.machine?.self.record ?? '' } : undefined;
			return !!at && at.root === tree.root && at.window === tree.window;
		});
	}

	/** A fetch's messages, each with its text: in the result, or - longer together than a result holds - in one file. */
	private packed(recipient: Recipient, way: Fetched['way'], messages: readonly FetchedMessage[]): Fetched {
		if (messages.reduce((total, message) => total + message.length, 0) <= TEXT_IN_LINE) {
			return { way, messages };
		}
		const file = this.context.table.messages.writeFetch(recipient, messages.map(message => `${headingOf(message)}\n${message.text ?? ''}\n`).join('\n'));
		return { way, messages: messages.map(({ text: _text, ...rest }) => rest), file };
	}

	/**
	 * A fetch across the machine, for a caller that reaches it (M4, M9): by number, a message this window does not hold -
	 * or holds below the first number the machine gave, which another may hold too - is looked up in the other windows,
	 * and a copy of one sent to another window's agent takes its delivery state from that window; the person's whole
	 * history is every window's. Anything else is this window's own.
	 */
	private async takeAcross(caller: Caller, request: FetchRequest): Promise<Fetched> {
		const machine = this.context.machine;
		const recipient: Recipient = caller.id ?? HUMAN;
		const byIds = !!request.ids?.length && !request.all;
		const history = !!request.all && !request.ids?.length && caller.id === undefined;
		if (!machine || !this.context.reachesMachine(caller) || (!byIds && !history)) {
			return this.take(caller, request);
		}
		const identity = this.context.identityOf(caller);
		if (history) {
			const here = this.take(caller, request, false);
			const { answers, silent } = await machine.ask(WINDOW_REQUESTS.human, { caller: identity });
			const there = answers.flatMap(({ label, answer }) => fetchedOf(answer).map(message => ({ ...message, window: label })));
			const fetched = this.packed(recipient, 'all', [...here.messages, ...there].sort((a, b) => a.id - b.id));
			if (!silent.length) {
				return fetched;
			}
			// Said in the result as well as the log: a history missing a workspace's is no whole history (M9)
			this.context.log(`The person's message history leaves out ${silentText(silent)}.`);
			return { ...fetched, silent: silent.map(each => each.label) };
		}
		const mail = this.context.table.state.mail;
		const shared = this.context.table.sharedMark('messages');
		const self = machine.self.record;
		const wanted = await this.wantedIds(request.ids ?? []);
		const asked = [...new Set(wanted.filter(({ id, record }) => {
			if (record !== undefined) {
				return record !== self;
			}
			const message = mail.messages.get(id);
			return !message || isForeign(message.to) || id <= shared;
		}).map(each => each.id))];
		const { answers, silent } = asked.length ? await machine.ask(WINDOW_REQUESTS.messages, { caller: identity, ids: asked }) : { answers: [], silent: [] };
		const found = new Map<number, (FetchedMessage & { readonly record: string })[]>();
		for (const { record, label, answer } of answers) {
			for (const message of fetchedOf(answer)) {
				found.set(message.id, [...found.get(message.id) ?? [], { ...message, window: label, record }]);
			}
		}
		const local: string[] = [];
		const there: FetchedMessage[] = [];
		const waiting = silent.filter(each => each.reason === 'not answering');
		// Each workspace as a caller can pass it back, where a message's number is held by more than one (O2)
		const labels = new Map([[self, machine.self.label], ...answers.map(each => [each.record, each.label] as const), ...silent.map(each => [each.record, each.label] as const)]);
		const word = (record: string) => workspaceWordOf(labels.get(record), record);
		for (const { id, record } of wanted) {
			const message = mail.messages.get(id);
			const elsewhere = found.get(id) ?? [];
			// Ending in its workspace, it is that workspace's message alone (M4; AGENT-ORCHESTRATION.md, O2)
			if (record === self) {
				local.push(`#m${id}`);
				continue;
			}
			if (record !== undefined) {
				const held = elsewhere.find(each => each.record === record);
				if (held) {
					there.push(withoutRecord(held));
				} else if (waiting.some(each => each.record === record)) {
					throw new FacadeError('UNAVAILABLE', `Cannot find #m${id} (workspace ${word(record)}) yet: ${silentText(waiting.filter(each => each.record === record))}. Nothing was fetched. Retry shortly.`);
				} else {
					throw new FacadeError('NOT_FOUND', `Workspace ${word(record)} holds no message #m${id} that you can read. Nothing was fetched.`);
				}
				continue;
			}
			if (message && isForeign(message.to)) {
				// The sender's copy: its text here, its state its recipient's workspace's - or, while that does not answer, what
				// the notices said of it: returned, or its recipient gone with its workspace; else unknown (M4). Read only by
				// one that reaches it, as any message here (O1)
				this.assertReadable(id, caller);
				const to = message.to;
				const authority = elsewhere.find(each => each.record === to.window);
				const learned = mail.copyOutcomes.get(id);
				there.push(authority ? withoutRecord(authority) : {
					id, from: this.whoOf(message.from), to: this.whoOf(message.to), own: false,
					state: learned === 'returned' ? 'returned' : 'unknown', time: message.time, ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}), length: message.length, text: this.textOf(id),
					window: learned === 'returned' ? `${message.to.label}, returned` : learned === 'ended' ? `${message.to.label}, gone: its recipient ended with it, perhaps before fetching it` : `${message.to.label}, not answering`
				});
				continue;
			}
			const holders = (message && mail.entries.has(id) ? 1 : 0) + elsewhere.length;
			if (holders > 1) {
				const written = [...(message ? [self] : []), ...elsewhere.map(each => each.record)].map(each => `#m${id} (workspace ${word(each)})`);
				throw new FacadeError('INVALID', `#m${id} is ambiguous: ${written.length} workspaces each hold a different message with that ID, given before numbers were unique on the machine. Pass the one you mean as written here: ${written.join(', ')}. Nothing was fetched.`);
			}
			if (elsewhere.length) {
				there.push(withoutRecord(elsewhere[0]));
			} else if (!message && waiting.length) {
				throw new FacadeError('UNAVAILABLE', `Cannot find #m${id} yet: ${silentText(waiting)}. Nothing was fetched. Retry shortly.`);
			} else {
				local.push(`#m${id}`);
			}
		}
		const here = local.length ? this.take(caller, { ids: local }, false).messages : [];
		return this.packed(recipient, 'ids', [...here, ...there].sort((a, b) => a.id - b.id));
	}

	/**
	 * The messages `ids` names, in order and each once: each by its number, and by the record of the workspace it ends in
	 * where it names one (M4; AGENT-ORCHESTRATION.md, O2).
	 */
	private async wantedIds(ids: readonly string[]): Promise<{ readonly id: number; readonly record?: string }[]> {
		const wanted = new Map<string, { readonly id: number; readonly record?: string }>();
		for (const text of ids) {
			const { workspace } = splitWorkspace(text);
			const id = messageNumberOf(text, 'ids');
			const record = workspace !== undefined ? (await this.context.workspaceNamed(workspace)).record : undefined;
			wanted.set(`${id} ${record ?? ''}`, { id, ...(record !== undefined ? { record } : {}) });
		}
		return [...wanted.values()].sort((a, b) => a.id - b.id);
	}

	/**
	 * The messages numbered `ids` this window holds as their recipient's - the authority on their delivery - for a caller of
	 * another window, each with its text (M4, M11): those it reaches; none it does not hold.
	 */
	fetchForAfar(caller: Caller, ids: readonly number[]): FetchedMessage[] {
		const mail = this.context.table.state.mail;
		// With YOLO off, its tree's messages alone: one outside it is as if not held here (O1). Each read once
		const reached = ids.filter(id => mail.entries.has(id) && mail.messages.has(id) && this.isReadable(id, caller));
		return reached.length ? [...this.take(caller, { ids: reached.map(id => `#m${id}`) }, false).messages] : [];
	}

	/** The person's mailbox here, every message of the current session with its text, for the person's script in another window (M9). */
	humanForAfar(caller: Caller): FetchedMessage[] {
		return caller.id === undefined ? [...this.take(caller, { all: true }, false).messages] : [];
	}

	/** Throws unless the message numbered `id` is in a mailbox: one from before the window last started is in the chat rooms only. */
	private assertInMailbox(id: number): void {
		const mail = this.context.table.state.mail;
		if (mail.entries.has(id)) {
			return;
		}
		const message = mail.messages.get(id);
		if (!message) {
			throw new FacadeError('NOT_FOUND', mail.lastMessage ? `Message #m${id} was not found. The latest message ID is #m${mail.lastMessage}.` : `Message #m${id} was not found. No messages have been sent.`);
		}
		// Its room gone with the rooms deleted here, or by any workspace of the machine (M9)
		const room = message.seq > mail.roomsDeletedAt && id > this.rooms.deletedUpTo() ? this.rooms.roomOf(message) : undefined;
		throw new FacadeError('NOT_FOUND', room
			? `Message #m${id} predates this window's current session. Its only copy is in chat room ${room}.`
			: `Message #m${id} predates this window's current session, and its chat rooms were deleted. The message is no longer available.`);
	}

	/** Records that the caller's own messages in a result were delivered, and works out its doorbell again. */
	private delivered(agent: number, fetched: Fetched): void {
		const own = fetched.messages.filter(message => message.own).map(message => message.id);
		try {
			this.context.table.messages.delivered(agent, own);
		} catch (err) {
			this.context.log(`Could not record message delivery to #a${agent}. The messages remain unread and will appear again with the same IDs. Reason: ${messageOf(err)}`);
			return;
		}
		this.doorbell.update(agent);
		this.watchDelivery(agent);
	}

	/**
	 * Sends a message its recipient ended without back to its sender, as a message of Facade's with its
	 * text; notes in its chat room one that cannot go back: Facade's own, or one whose sender ended.
	 */
	private giveBack(message: Message, recipient: Agent, how: string): void {
		const { table } = this.context;
		const sender = message.from;
		if (isForeign(sender)) {
			this.giveBackAfar(message, sender, recipient, how);
			return;
		}
		if (sender === undefined && message.personAfar) {
			this.giveBackAfar(message, { human: true, ...message.personAfar }, recipient, how);
			return;
		}
		if (sender === FACADE || (sender !== undefined && !isLive(table.get(sender)))) {
			table.messages.returned(message.id, how);
			this.inRooms(`with a note about #m${message.id}`, () => this.rooms.noteUnreturned(message.id));
			return;
		}
		const back = this.record({
			from: FACADE,
			to: sender ?? HUMAN,
			text: `#m${message.id} was returned because ${describe(recipient)} ended without fetching it (${how}).\nOriginal message:\n${table.messages.textOf(message) ?? ''}`,
			facade: 'returned',
			about: recipient.id
		});
		table.messages.returned(message.id, how, { as: back.id });
	}

	/**
	 * Sends a message its recipient ended without back to its sender of another window: that window records the notice and
	 * rings it, asked again while it is coming back (M6). Recorded here as returned once it did; as not returned where its
	 * window is gone, its sender gone with it, or the sender ended.
	 */
	private giveBackAfar(message: Message, sender: ForeignAgent | { readonly human: true; readonly window: string; readonly label?: string }, recipient: Agent, how: string): void {
		const { table } = this.context;
		const text = `#m${message.id} was returned because ${describe(recipient)} (workspace ${this.selfName}) ended without fetching it (${how}).\nOriginal message:\n${table.messages.textOf(message) ?? ''}`;
		const left = this.noticeAfar(sender, `returned-m${message.id}`, text, 'returned', recipient, message.id);
		try {
			table.messages.returned(message.id, how, left ? { afar: true } : {});
			if (!left) {
				this.inRooms(`with a note about #m${message.id}`, () => this.rooms.noteUnreturned(message.id));
			}
		} catch (err) {
			this.context.log(`Could not record what became of #m${message.id}, returned to ${isForeign(sender) ? foreignRef(sender) : `@human in workspace ${sender.label ?? sender.window}`}: ${messageOf(err)}`);
		}
	}

	/**
	 * Leaves a notice of Facade's for `to`, an agent of another workspace, in its workspace's outbox, under `key`, and rings
	 * that workspace (M6, O8): whether it was left - not where that workspace is gone, `to` gone with it.
	 */
	noticeAfar(to: ForeignAgent | { readonly human: true; readonly window: string; readonly label?: string }, key: string, text: string, kind: FacadeKind, about: Agent, message?: number): boolean {
		const machine = this.context.machine;
		if (!machine) {
			return false;
		}
		const self = machine.self;
		const notice: OutboxNotice = { key, to: isForeign(to) ? to.id : 'human', text, kind, about: { id: about.id, name: about.name, window: self.record, label: self.label }, ...(message !== undefined ? { message } : {}) };
		try {
			return machine.notice(to.window, notice);
		} catch (err) {
			this.context.log(`Could not leave a notice for ${isForeign(to) ? foreignRef(to) : `@human in workspace ${to.label ?? to.window}`}: ${messageOf(err)}`);
			return false;
		}
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
		// Where the person directs its tree: shown in the workspace of its root, where that is another and answers (M9)
		const machine = this.context.machine;
		if (from?.rootAfar && machine) {
			const sender: ForeignAgent = { id: from.id, name: from.name, window: machine.self.record, label: machine.self.label };
			void machine.askOne(from.rootAfar.window, WINDOW_REQUESTS.tellHuman, { from: sender, message: message.id, text: shown }).then(undefined, err => {
				this.context.log(`Could not show ${describe(from)}'s message to the person in its root's workspace, so it is shown here: ${messageOf(err)}`);
				this.tellHere(message, from, shown);
			});
			return;
		}
		this.tellHere(message, from, shown);
	}

	/** Tells the person here of a message to them - `from` its sender here, `shown` its first line - with Show. */
	private tellHere(message: Message, from: Agent | undefined, shown: string): void {
		const { table } = this.context;
		const about = from ?? (typeof message.about === 'number' ? table.get(message.about) : undefined);
		const show = l10n.t("Show");
		// One from an agent of another window: its terminal is in that window, its message in the chat room here (M9)
		const afar = isForeign(message.from) ? message.from : undefined;
		const text = from ? l10n.t("{0} sent you a message: {1}", describe(from), shown) : afar ? l10n.t("{0} sent you a message: {1}", foreignRef(afar), shown) : l10n.t("Facade: {0}", shown);
		const key = from ? `message:${from.id}` : afar ? `message:${afar.window}:${afar.id}` : facadeNoticeKey(typeof message.about === 'number' ? message.about : message.id);
		void this.context.ports.person.notify({ key, text, buttons: [show], ...(from ? { quietIn: from.id } : {}) }).then(async choice => {
			if (choice === show) {
				await this.show(message, about);
			}
		}).catch(err => this.context.log(`Could not show a message notification to the person: ${messageOf(err)}`));
	}

	/**
	 * Tells the person here of a message to them that `from`, an agent of another workspace in a tree rooted here, sent
	 * there (M9): Show reveals its terminal in its workspace's window, brought forward - the person's own act.
	 */
	tellThePersonFor(from: ForeignAgent, message: number, shown: string): void {
		const show = l10n.t("Show");
		void this.context.ports.person.notify({ key: `message:${from.window}:${from.id}`, text: l10n.t("{0} sent you a message: {1}", foreignRef(from), shown), buttons: [show] }).then(async choice => {
			if (choice === show) {
				const revealed = await this.context.machine?.askOne(from.window, WINDOW_REQUESTS.reveal, { agent: from.id }).catch(() => undefined);
				if (!(revealed as { shown?: unknown } | undefined)?.shown) {
					this.context.ports.person.tell(l10n.t("{0} could not be shown: its workspace did not answer, or it has ended. Message #m{1} is in its chat room.", foreignRef(from), message), undefined, 'information');
				}
			}
		}).catch(err => this.context.log(`Could not show a message notification to the person: ${messageOf(err)}`));
	}

	/** Shows the person the terminal of this workspace's agent `agent`, for Show in another workspace's notification, its window brought forward (M9). */
	async revealFor(agent: number): Promise<boolean> {
		if (!isLive(this.context.table.get(agent)) || !await this.context.ports.terminals.reveal(agent)) {
			return false;
		}
		await this.context.ports.person.bringForward?.();
		return true;
	}

	/** Shows the person a message: the terminal of the agent it is from or about, else the message in its chat room, unless that was deleted. */
	private async show(message: Message, agent: Agent | undefined): Promise<void> {
		if (agent && isLive(this.context.table.get(agent.id)) && await this.context.ports.terminals.reveal(agent.id)) {
			return;
		}
		const room = message.seq > this.context.table.state.mail.roomsDeletedAt ? this.rooms.roomOf(message) : undefined;
		if (room && fs.existsSync(room)) {
			await this.context.ports.person.openRoom(room, message.id);
		} else {
			this.context.ports.person.tell(l10n.t("Message #m{0} is no longer available because the chat rooms were deleted.", message.id), undefined, 'information');
		}
	}

	/** Waits for a running agent to fetch its task, for the timeout from when it was running: then its creator is told, once. */
	private watchTask(id: number): void {
		const mail = this.context.table.state.mail;
		const agent = this.context.table.get(id);
		const task = mail.tasks.get(id);
		if (this.disposed || this.tasks.has(id) || !this.context.frameworkOn() || agent?.state !== 'running' || task === undefined || mail.notFetched.has(id) || mail.entries.get(task)?.state !== 'unread') {
			return;
		}
		// The framework turned on again, the timeout counts from then: no doorbell rang while it was off
		const due = Math.max(agent.runningTime ?? Date.now(), this.onAgainTime) + this.context.timing().startTimeoutMs;
		this.tasks.set(id, setTimeout(() => {
			this.tasks.delete(id);
			this.taskNotFetched(id, task);
		}, Math.max(0, due - Date.now())));
	}

	/**
	 * Tells an agent's creator that it has not fetched its task: by a message of Facade's, the person's
	 * too. Its task stays where it is. Once: `watchTask` waits no more for an agent whose creator was told.
	 * Nothing while the agent framework is off, whatever timer is left from before: nothing can be fetched then (M10).
	 */
	private taskNotFetched(id: number, task: number): void {
		const agent = this.context.table.get(id);
		if (this.disposed || !this.context.frameworkOn() || !isLive(agent) || this.context.table.state.mail.entries.get(task)?.state !== 'unread'
			|| (!agent.creatorAfar && agent.creator !== undefined && !isLive(this.context.table.get(agent.creator)))) {
			return;
		}
		const why = this.doorbell.holdUp(id);
		// Its creator in another workspace: told by that workspace, once (M6, O8)
		if (agent.creatorAfar) {
			this.noticeAfar(agent.creatorAfar, `taskNotFetched-a${id}`, `${describe(agent)} (workspace ${this.selfName}) has not fetched task #m${task} since starting${why ? `: ${why}` : ''}. The task is still queued; Facade retries the doorbell automatically. ${whereToLook(id, 0, 'task')}`, 'taskNotFetched', agent);
			this.context.table.messages.notFetchedAfar(id);
			return;
		}
		try {
			this.record({
				from: FACADE,
				to: agent.creator ?? HUMAN,
				text: `${describe(agent)} has not fetched task #m${task} since starting${why ? `: ${why}` : ''}. The task is still queued; Facade retries the doorbell automatically. ${whereToLook(id, agent.creator ?? HUMAN, 'task')}`,
				facade: 'taskNotFetched',
				about: id
			});
		} catch (err) {
			this.context.log(`Could not notify the creator that ${describe(agent)} has not fetched its task: ${messageOf(err)}`);
		}
	}

	/** Waits, for an agent with unread messages, until they have waited the timeout since their first doorbell was due: then their sender is told. */
	private watchDelivery(id: number): void {
		clearTimeout(this.delays.get(id));
		this.delays.delete(id);
		const due = this.delayDueAt(id);
		if (this.disposed || due === undefined || !this.context.frameworkOn()) {
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
		// Its task unfetched, the notice of that goes to its creator in place of this one - where its creator is there to
		// be told (M6): with its creator ended, the other senders still hear that their messages wait
		const creatorTold = agent?.creator === undefined || isLive(table.get(agent.creator));
		if (agent?.state !== 'running' || !unread.some(message => message.from !== FACADE)
			|| (task !== undefined && mail.entries.get(task)?.state === 'unread' && creatorTold)) {
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
	 * for as long as its mailbox is not emptied. Nothing while the agent framework is off, whatever timer is left
	 * from before: nothing can be fetched then, and it is timed again from when the framework is on again (M10).
	 */
	private deliveryDelayed(id: number): void {
		const due = this.delayDueAt(id);
		if (this.disposed || due === undefined || !this.context.frameworkOn()) {
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
		const oldest = unread.find(message => message.from !== FACADE && message.from !== id && (message.from === undefined || isForeign(message.from) || isLive(table.get(message.from))));
		if (!agent || !oldest || oldest.from === FACADE) {
			return;
		}
		const ids = unread.slice(0, LISTED).map(message => `#m${message.id}`).join(', ') + (unread.length > LISTED ? `, and ${unread.length - LISTED} more` : '');
		const why = this.doorbell.holdUp(id);
		if (isForeign(oldest.from)) {
			// Its sender is told by its own window; told once, as the record here says (M6)
			try {
				table.messages.delayedAfar(id);
			} catch (err) {
				this.context.log(`Could not record that ${describe(agent)}'s unfetched messages were told of: ${messageOf(err)}`);
				return;
			}
			this.noticeAfar(oldest.from, `delayed-a${id}-m${oldest.id}`, `${describe(agent)} (workspace ${this.selfName}) has not fetched ${ids} after ${durationOf(Date.now() - unread[0].time)}${why ? `: ${why}` : ''}. The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. ${whereToLook(id, 0, 'messages')}`, 'delayed', agent);
			return;
		}
		try {
			this.record({
				from: FACADE,
				to: oldest.from ?? HUMAN,
				text: `${describe(agent)} has not fetched ${ids} after ${durationOf(Date.now() - unread[0].time)}${why ? `: ${why}` : ''}. The messages are still queued; Facade retries the doorbell automatically. Any messages still unread when the agent ends will be returned to their senders. ${whereToLook(id, oldest.from ?? HUMAN, 'messages')}`,
				facade: 'delayed',
				about: id
			});
		} catch (err) {
			this.context.log(`Could not notify the sender that ${describe(agent)} has unfetched messages: ${messageOf(err)}`);
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
			// Kept while a mailbox holds it, or a room may: after the rooms were deleted here, by this record's sequence, and on
			// the machine, from any workspace, by message number (M9)
			const machineDeleted = this.rooms.deletedUpTo();
			table.messages.deleteTexts(id => mail.entries.has(id) || ((mail.messages.get(id)?.seq ?? 0) > mail.roomsDeletedAt && id > machineDeleted));
		} catch (err) {
			this.context.log(`Could not delete all message files that are no longer needed: ${messageOf(err)}`);
		}
	}

	/** A message's text; a note saying so for one whose file went with the chat rooms. */
	private textOf(id: number): string {
		const message = this.context.table.state.mail.messages.get(id);
		return (message && this.context.table.messages.textOf(message)) ?? '(Message text unavailable: the chat rooms were deleted.)';
	}

	/** Writes to the chat rooms: one that fails is written again from the ledger as the window loads next. */
	private inRooms(what: string, write: () => void): void {
		try {
			write();
		} catch (err) {
			this.context.log(`Could not update chat rooms ${what}. They will be rebuilt from the ledger the next time the window loads. Reason: ${messageOf(err)}`);
		}
	}

	/** Who sent or got a message, as Facade writes it. */
	private whoOf(who: Recipient | typeof FACADE | ForeignAgent | undefined): string {
		return whoOf(this.context.table.state, who);
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw new FacadeError('UNAVAILABLE', 'The window closed during this call; the call will do no further work. Earlier effects may already have occurred. After the window reconnects, inspect the state before retrying.');
		}
	}
}

/**
 * Where the one told of agent `id` sees what holds it up: an agent reads its screen with read_screen, the person has its
 * terminal. An agent is told too what to do of a menu that took the doorbell: answer it, and send nothing again - what was
 * sent waits under its number (AGENT-DEBUGGING.md, D7; DB-09).
 */
function whereToLook(id: number, told: Recipient | typeof FACADE, waiting: 'task' | 'messages'): string {
	return told === HUMAN
		? 'Facade cannot determine what the CLI is doing. Inspect its terminal.'
		: `Call read_screen with agent #a${id}. A CLI menu may have consumed the doorbell; answer it with type_text or press_keys. Do not resend ${waiting === 'task' ? 'the task or start a replacement agent for it' : 'the messages'}.`;
}

/** The number of the message `text` names, as `#m42`; throws, saying why, for what is none - an agent's number among them. */
function messageNumberOf(text: string, what: string): number {
	// The workspace a message's number may end in only says where to look (O2)
	const trimmed = splitWorkspace(text).text;
	if (AGENT_NUMBER.test(trimmed)) {
		throw new FacadeError('INVALID', `'${trimmed}' is an agent ID. Argument '${what}' requires a message ID such as #m42.`);
	}
	const id = MESSAGE_NUMBER.exec(trimmed)?.groups?.id;
	if (id === undefined || Number(id) < 1) {
		throw new FacadeError('INVALID', `${trimmed || 'An empty string'} is not a message ID. Argument '${what}' requires a message ID such as #m42.`);
	}
	return Number(id);
}

/** The recipients `to` names, trimmed; throws where it names none, or an empty one. */
function namedIn(to: readonly string[]): string[] {
	const named = to.map(each => each.trim());
	if (!named.length || named.some(each => !each)) {
		throw new FacadeError('INVALID', `Argument 'to' ${named.length ? 'contains an empty recipient' : 'has no recipients'}. Provide an agent (#a7, @name, or @name #a7), @${PERSON.name}, or a nonempty list of recipients.`);
	}
	return named;
}

/** Throws where a message's text is empty. */
function assertText(text: string): void {
	if (!text.trim()) {
		throw new FacadeError('INVALID', 'Argument \'text\' must contain a message; it cannot be empty.');
	}
}

/** A message another window answered a fetch with, but which window it was. */
function withoutRecord({ record: _record, ...message }: FetchedMessage & { readonly record: string }): FetchedMessage {
	return message;
}

/** The messages another window answered a fetch with, each field checked: those it cannot read are left out. */
function fetchedOf(answer: unknown): FetchedMessage[] {
	if (!Array.isArray(answer)) {
		return [];
	}
	const states: ReadonlySet<unknown> = new Set(['unread', 'delivered', 'returned']);
	return answer.filter((each): each is FetchedMessage => {
		const { id, from, to, own, state, time, length, text } = (each ?? {}) as { [key: string]: unknown };
		return typeof id === 'number' && typeof from === 'string' && typeof to === 'string' && typeof own === 'boolean' && states.has(state)
			&& typeof time === 'number' && typeof length === 'number' && (text === undefined || typeof text === 'string');
	});
}

/** How long, as Facade's messages say it: seconds below two minutes, else minutes. */
function durationOf(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 120) {
		return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
	}
	return `${Math.round(seconds / 60)} minutes`;
}

/**
 * The key of Facade's notice to the person about agent `id` - a message of Facade's about it, or its start not confirmed -
 * or, about no agent, of its message numbered `id`: the next with the key takes its place (AGENT-MESSAGES.md, M11).
 */
export function facadeNoticeKey(id: number): string {
	return `message:facade:${id}`;
}

/** A time of day as the messages give it: hours and minutes, on this machine's clock. */
export function clockOf(time: number): string {
	return new Date(time).toTimeString().slice(0, 5);
}

/**
 * A message's heading in a fetch: its number, who sent it to whom, when, what it answers, its length, and
 * its delivery state as the fetch took it.
 */
export function headingOf(message: FetchedMessage): string {
	return [
		`#m${message.id}`,
		`from ${message.from} to ${message.own ? 'you' : message.to}`,
		clockOf(message.time),
		...(message.replyTo !== undefined ? [`reply to #m${message.replyTo}`] : []),
		...(message.task ? ['task'] : []),
		`${message.length.toLocaleString('en-US')} ${message.length === 1 ? 'character' : 'characters'}`,
		message.state
	].join(' · ');
}
