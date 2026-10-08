/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { CliConfig } from '../clis/cli';
import { AgentTable } from '../record/agents';
import { Agent, isLive } from '../record/events';
import { Message, unreadOf } from '../record/messages';
import { CliCatalog, Disposable, PersonInput, Ports } from './ports';

/** How long after a new message comes its doorbell rings: what comes meanwhile rings with it. */
export const NEW_MESSAGE_MS = 2_000;
/** The least time between two doorbells of an agent's, unless it fetched all it had in between. */
export const RING_GAP_MS = 60_000;
/** How long after a doorbell that named a message still unread the next one rings: 1, 2, 4 and 8 minutes, then every 15. */
const AGAIN_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000];
/** How long after a doorbell the next rings once `AGAIN_MS` is through. */
const AGAIN_AFTER_MS = 900_000;
/** How long the person may have stopped typing, a line half typed, before the doorbell is typed after it. */
const TYPING_IDLE_MS = 10_000;
/** How often the person's typing is looked at again while the doorbell waits for them. */
const TYPING_POLL_MS = 1_000;
/** How long a doorbell that could not be typed waits before it tries again. */
const RETRY_MS = 60_000;
/** How many unread messages a doorbell names: the others it counts. */
const NAMED = 5;
/** How a CLI Facade no longer knows is taken to have been started: the delays the longest of its CLIs'. */
const UNKNOWN_CLI: CliConfig = { path: '', launch: { arguments: {}, environment: {}, enterDelay: 900, taskDelay: 2_000 } };

/** What the doorbell needs of the core around it. */
export interface DoorbellContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	/** The name of the terminal an agent runs in. */
	terminalOf(agent: Agent): string;
	/** The first line of an agent whose task no doorbell named yet: its doorbell types it instead, once. */
	firstLine(agent: Agent, task: Message): string;
	/** A message's sender, as Facade writes it. */
	senderOf(message: Message): string;
	/** Settles once the agent's fetches under way are done: whether their results went out is known. */
	fetchesDone(id: number): Promise<void>;
	log(message: string): void;
}

/**
 * The doorbells: the one line Facade types into the terminal of an agent with unread messages - how
 * many, from whom, and that it should call `read_messages` - then Enter, whether its CLI is busy or not,
 * and whatever its YOLO. When each is due comes from the ledger, so that a reload changes nothing: a new
 * message rings 2 seconds after it came, but within a minute of the last doorbell only once the agent
 * has fetched all it had; one a doorbell named rings again while it is unread, 1, 2, 4 and 8 minutes on,
 * each from the doorbell before, then every 15. A doorbell waits for the person typing in that terminal,
 * for 10 seconds without a key at most.
 */
export class Doorbell implements Disposable {

	/** Each agent's next doorbell. */
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	/** When each agent's doorbell that could not be typed is tried again. */
	private readonly retryAt = new Map<number, number>();
	/** The agents whose doorbells are being typed, or wait for the person. */
	private readonly ringing = new Set<number>();
	/** The agents whose doorbells wait for the person typing in their terminals. */
	private readonly waiting = new Set<number>();
	private disposed = false;

	constructor(private readonly context: DoorbellContext) { }

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	/** Works out again when the agent's doorbell is due - its messages, its doorbells or its state changed - and waits for then. */
	update(id: number): void {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		const agent = this.context.table.get(id);
		if (this.disposed || !agent || this.ringing.has(id)) {
			return;
		}
		// Its mailbox emptied, a doorbell that failed before is tried again no more: the next message rings afresh
		if (!unreadOf(this.context.table.state.mail, id).length) {
			this.retryAt.delete(id);
		}
		const due = this.dueAt(agent);
		if (due !== undefined) {
			this.timers.set(id, setTimeout(() => void this.ring(id), Math.max(0, due - Date.now())));
		}
	}

	/** An agent ended: no doorbell is due for it any more. */
	forget(id: number): void {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		this.retryAt.delete(id);
	}

	/** What holds the agent's doorbell up, where Facade knows: the person typing in its terminal, or a doorbell that could not be typed. */
	holdUp(id: number): string | undefined {
		if (this.waiting.has(id)) {
			return 'its doorbell waits while the person types in its terminal';
		}
		if (this.retryAt.has(id)) {
			return 'its doorbell could not be typed into its terminal, and is tried again each minute';
		}
		return undefined;
	}

	/**
	 * When the agent's doorbell is due, as the ledger says; undefined while none is - it is not running,
	 * or has nothing unread. Never sooner than its CLI's task delay after it was running.
	 */
	dueAt(agent: Agent): number | undefined {
		const mail = this.context.table.state.mail;
		const unread = unreadOf(mail, agent.id);
		if (agent.state !== 'running' || !unread.length) {
			return undefined;
		}
		const last = mail.rungAt.get(agent.id);
		// A mailbox emptied since the last doorbell starts afresh: a question's answer is not held a minute
		const gapFrom = last !== undefined && (mail.drainedAt.get(agent.id) ?? -Infinity) < last ? last : undefined;
		const rings = unread.map(message => mail.entries.get(message.id)?.rings ?? 0);
		let due = Infinity;
		const fresh = unread.find((_, index) => rings[index] === 0);
		if (fresh) {
			due = Math.max(fresh.time + NEW_MESSAGE_MS, gapFrom === undefined ? 0 : gapFrom + RING_GAP_MS);
		}
		const named = rings.filter(count => count > 0);
		if (named.length && last !== undefined) {
			due = Math.min(due, last + againAfter(Math.min(...named)));
		}
		const settled = (agent.runningTime ?? agent.startTime) + this.configOf(agent).launch.taskDelay;
		return Math.max(due, settled, this.retryAt.get(agent.id) ?? 0);
	}

	/** Rings an agent's doorbell as it is due, once the person's typing there is waited for. One that could not be typed is tried again a minute on. */
	private async ring(id: number): Promise<void> {
		this.timers.delete(id);
		const agent = this.context.table.get(id);
		if (this.disposed || agent?.state !== 'running' || this.ringing.has(id) || !unreadOf(this.context.table.state.mail, id).length) {
			return;
		}
		const config = this.configOf(agent);
		const terminal = this.context.terminalOf(agent);
		this.ringing.add(id);
		try {
			await this.waitForThePerson(agent, terminal);
			// What a fetch under way takes is not rung for
			await this.context.fetchesDone(id);
			const now = unreadOf(this.context.table.state.mail, id);
			if (this.disposed || !isLive(this.context.table.get(id)) || !now.length) {
				return;
			}
			const task = this.taskOf(agent, now);
			const line = task ? this.context.firstLine(agent, task) : doorbellLine(now, this.context.senderOf);
			if (!await this.context.ports.terminals.type(terminal, line)) {
				throw new Error('its terminal was not there');
			}
			// Its line typed, its Enter follows, Facade turned off meanwhile or not: a line left unsent would wait in its input
			await timeout(config.launch.enterDelay);
			if (!isLive(this.context.table.get(id))) {
				return;
			}
			if (!await this.context.ports.terminals.type(terminal, '\r')) {
				throw new Error('its terminal was not there');
			}
			if (!this.disposed) {
				// Those it fetched meanwhile, as the line was typed, it was not rung for
				const mail = this.context.table.state.mail;
				const named = (task ? [task] : now).map(message => message.id).filter(each => mail.entries.get(each)?.state === 'unread');
				if (named.length) {
					this.context.table.messages.rang(id, named);
				}
				this.retryAt.delete(id);
			}
		} catch (err) {
			if (!this.disposed) {
				this.retryAt.set(id, Date.now() + RETRY_MS);
				this.context.log(`The doorbell of ${terminal} could not be rung: ${messageOf(err)}. It is tried again in a minute.`);
			}
		} finally {
			this.ringing.delete(id);
			this.update(id);
		}
	}

	/**
	 * Waits while the person types in the agent's terminal: a line typed and not sent with Enter, and a
	 * key within the last 10 seconds. A window that cannot tell does not hold the doorbell back.
	 */
	private async waitForThePerson(agent: Agent, terminal: string): Promise<void> {
		try {
			while (!this.disposed && isLive(this.context.table.get(agent.id))) {
				let input: PersonInput | undefined;
				try {
					input = await this.context.ports.terminals.input(terminal);
				} catch (err) {
					this.context.log(`What the person typed into ${terminal} could not be told: ${messageOf(err)}`);
					return;
				}
				if (!input?.pending || input.lastKey === undefined || Date.now() - input.lastKey >= TYPING_IDLE_MS) {
					return;
				}
				this.waiting.add(agent.id);
				await timeout(TYPING_POLL_MS);
			}
		} finally {
			this.waiting.delete(agent.id);
		}
	}

	/** The agent's task, where it is unread and no doorbell named it yet: its next doorbell is its first line. */
	private taskOf(agent: Agent, unread: readonly Message[]): Message | undefined {
		const mail = this.context.table.state.mail;
		const task = mail.tasks.get(agent.id);
		return unread.find(message => message.id === task && mail.entries.get(task)?.rings === 0);
	}

	/** How the person has Facade start the agent's CLI; for a CLI Facade no longer knows, the longest delays. */
	private configOf(agent: Agent): CliConfig {
		const cli = this.context.clis.known.find(each => each.id === agent.cli);
		return cli ? this.context.clis.configOf(cli) : UNKNOWN_CLI;
	}
}

/** How long after a doorbell that named a message `rings` times, the message still unread, the next is due. */
function againAfter(rings: number): number {
	return AGAIN_MS[rings - 1] ?? AGAIN_AFTER_MS;
}

/** The doorbell: how many unread messages, from whom, and that the agent should fetch them. Never their text. */
function doorbellLine(unread: readonly Message[], senderOf: (message: Message) => string): string {
	const named = unread.slice(0, NAMED).map(message => `#m${message.id} from ${senderOf(message)}`);
	const more = unread.length > NAMED ? `, and ${unread.length - NAMED} more` : '';
	return `[facade] ${unread.length === 1 ? '1 unread message' : `${unread.length} unread messages`}: ${named.join(', ')}${more}. Call read_messages.`;
}
