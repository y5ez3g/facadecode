/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentTable } from '../record/agents';
import { Agent, describe, isLive } from '../record/events';
import { Message, unreadOf } from '../record/messages';
import { Disposable, PersonInput, Ports } from './ports';

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
/** How long a doorbell waits for the window's answer before the window is what holds it up: away, it rings once the window is back (REMOTE.md R4). */
const WINDOW_SILENT_MS = 10_000;
/** How many unread messages a doorbell names: the others it counts. */
const NAMED = 5;

/** The delays of a launch: from a paste into its terminal to Enter, and from its hello to its task's first line typed there. */
export interface LaunchDelays {
	readonly enterDelay: number;
	readonly taskDelay: number;
}

/** What the doorbell needs of the core around it. */
export interface DoorbellContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	/** The delays of an agent's launch, as its start had them (AGENT-LAUNCHER.md, L9). */
	delaysOf(agent: Agent): LaunchDelays;
	/** The first line of an agent whose task no doorbell named yet: its doorbell types it instead, once. */
	firstLine(agent: Agent, task: Message): string;
	/** A message's sender, as Facade writes it. */
	senderOf(message: Message): string;
	/** Settles once the agent's fetches under way are done: whether their results went out is known. */
	fetchesDone(id: number): Promise<void>;
	/** Whether the agent framework is on: off, no doorbell goes in (AGENT-MESSAGES.md, M10). */
	frameworkOn(): boolean;
	/** Whether the agent's MCP server is connected: one that is not waits for its next hello (M5). */
	isConnected(agent: Agent): boolean;
	log(message: string): void;
}

/**
 * The doorbells: the one line Facade types into the terminal of an agent with unread messages - how
 * many, from whom, and that it should call `read_messages` - then Enter, whether its CLI is busy or not,
 * and whatever its YOLO. When each is due comes from the ledger, so that a reload changes nothing: a new
 * message rings 2 seconds after it came, but within a minute of the last doorbell only once the agent
 * has fetched all it had; one a doorbell named rings again while it is unread, 1, 2, 4 and 8 minutes on,
 * each from the doorbell before, then every 15. A doorbell waits for the person typing in that terminal,
 * for 10 seconds without a key at most, and for what Facade types there to have gone in; only then is its
 * line made, of what is unread as it goes in (AGENT-MESSAGES.md M5), and it takes its turn in the terminal's
 * input (AGENT-DEBUGGING.md D3). Facade turned off while it waits, it never goes in (M10).
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
	/** The agents whose doorbells wait behind what Facade types into their terminals. */
	private readonly behind = new Set<number>();
	/** The agents whose doorbells wait for their MCP servers to connect again: their next hello rings them. */
	private readonly disconnected = new Set<number>();
	/** When each agent's doorbell asked the window what it waits for the answer to, while it waits. */
	private readonly askedAt = new Map<number, number>();
	/** How long each agent's doorbell under way has waited for the window's answers, the longest wait. */
	private readonly windowWaited = new Map<number, number>();
	/** When each agent's doorbell rang that had waited a while for the window - away - for what holds its messages up. */
	private readonly rangLate = new Map<number, number>();
	private disposed = false;

	constructor(private readonly context: DoorbellContext) { }

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	/**
	 * Works out again when the agent's doorbell is due - its messages, its doorbells or its state changed, or the
	 * agent framework was turned on - and waits for then. While the framework is off, none is due.
	 */
	update(id: number): void {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		const agent = this.context.table.get(id);
		if (this.disposed || !agent || this.ringing.has(id) || !this.context.frameworkOn()) {
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
		this.disconnected.delete(id);
		this.rangLate.delete(id);
	}

	/** The agent's MCP server said hello: a doorbell that waited for it to connect again is due again. */
	connected(id: number): void {
		this.disconnected.delete(id);
		this.update(id);
	}

	/**
	 * What holds the agent's doorbell up, where Facade knows: the person typing in its terminal, Facade's own input
	 * there, its MCP server not connected, the window not answering - away - or a doorbell that could not be typed.
	 */
	holdUp(id: number): string | undefined {
		if (this.disconnected.has(id)) {
			return 'its MCP server is disconnected; the doorbell waits for reconnection';
		}
		if (this.waitsOnWindow(id)) {
			return 'the window has not answered its doorbell; it rings once the window is back';
		}
		if (this.waiting.has(id)) {
			return 'the doorbell is waiting for the person to submit or cancel terminal input, or leave the keyboard idle for 10 seconds';
		}
		if (this.behind.has(id)) {
			return 'the doorbell is queued behind earlier Facade input';
		}
		if (this.retryAt.has(id)) {
			return 'the terminal could not receive the doorbell; Facade retries every minute';
		}
		const late = this.rangLate.get(id);
		if (late !== undefined && Date.now() - late < RING_GAP_MS) {
			return `its doorbell waited for the window, which was away, and rang ${Math.round((Date.now() - late) / 1000)} seconds ago`;
		}
		return undefined;
	}

	/** Whether the agent's doorbell has waited a while for the window to answer: a window away, which rings it once it is back (REMOTE.md R4). */
	waitsOnWindow(id: number): boolean {
		const since = this.askedAt.get(id);
		return since !== undefined && Date.now() - since >= WINDOW_SILENT_MS;
	}

	/**
	 * What the window had to do with the agent's doorbell, for what the one told of its messages is to do: it waits for
	 * the window, away; it waited for it, and rang within the minute; or nothing.
	 */
	windowHold(id: number): 'waiting' | 'rang' | undefined {
		if (this.waitsOnWindow(id)) {
			return 'waiting';
		}
		const late = this.rangLate.get(id);
		return late !== undefined && Date.now() - late < RING_GAP_MS ? 'rang' : undefined;
	}

	/** The window's answer to `ask`, for the agent's doorbell: how long it is waited for is noted, for what holds the doorbell up. */
	private async windowAnswer<T>(id: number, ask: () => Promise<T>): Promise<T> {
		const since = Date.now();
		this.askedAt.set(id, since);
		try {
			return await ask();
		} finally {
			this.askedAt.delete(id);
			this.windowWaited.set(id, Math.max(this.windowWaited.get(id) ?? 0, Date.now() - since));
		}
	}

	/**
	 * When the agent's doorbell is due, as the ledger says; undefined while none is - it is not running, has
	 * nothing unread, or was launched without Facade's integration, which has no tool to fetch with. One that types
	 * its task's first line never sooner than its launch's task delay after it was running (M5, M7).
	 */
	dueAt(agent: Agent): number | undefined {
		const mail = this.context.table.state.mail;
		const unread = unreadOf(mail, agent.id);
		if (agent.state !== 'running' || !agent.integration || !unread.length || this.disconnected.has(agent.id)) {
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
		// The task delay bounds the line that types the task alone: a doorbell after it waits for nothing of the kind
		const settled = this.taskOf(agent, unread) ? (agent.runningTime ?? agent.startTime) + this.context.delaysOf(agent).taskDelay : 0;
		return Math.max(due, settled, this.retryAt.get(agent.id) ?? 0);
	}

	/** Rings an agent's doorbell as it is due, once the person's typing there is waited for. One that could not be typed is tried again a minute on. */
	private async ring(id: number): Promise<void> {
		this.timers.delete(id);
		const agent = this.context.table.get(id);
		if (this.disposed || agent?.state !== 'running' || this.ringing.has(id) || !this.context.frameworkOn() || !unreadOf(this.context.table.state.mail, id).length) {
			return;
		}
		const label = describe(agent);
		this.ringing.add(id);
		try {
			await this.waitForTurn(agent, label);
			// What a fetch under way takes is not rung for
			await this.context.fetchesDone(id);
			const now = unreadOf(this.context.table.state.mail, id);
			// Being stopped, or ended, it takes nothing more; the framework turned off, no doorbell begins (M10)
			if (this.disposed || this.context.table.get(id)?.state !== 'running' || !this.context.frameworkOn() || !now.length) {
				return;
			}
			// Its MCP server gone, it could not fetch: its next hello rings it (M5)
			if (!this.context.isConnected(agent)) {
				this.disconnected.add(id);
				this.context.log(`Doorbell for ${label} is waiting for its MCP server to connect to Facade.`);
				return;
			}
			const task = this.taskOf(agent, now);
			const line = task ? this.context.firstLine(agent, task) : doorbellLine(now, this.context.senderOf);
			// In the terminal's turn, behind what Facade typed there before: its line, then its Enter after the pause its
			// CLI needs - begun, Facade turned off meanwhile or not, as a line left unsent would wait in its input; the
			// window drops one Facade is off for when its turn comes, before anything of it goes in (M10)
			const effect = await this.windowAnswer(id, () => this.context.ports.terminals.type(id, line, { enter: true, enterDelayMs: this.context.delaysOf(agent).enterDelay, requiresFramework: true }));
			if (!effect) {
				throw new Error('its terminal was unavailable');
			}
			// Nothing went in and nothing rang: due again once Facade is on again, not tried again meanwhile (M10)
			if (effect.reason === 'frameworkOff') {
				this.context.log(`Doorbell for ${label} was not sent: the agent framework was disabled when its turn arrived. Delivery resumes when the framework is enabled.`);
				return;
			}
			if (effect.outcome !== 'applied') {
				if (this.context.table.get(id)?.state !== 'running') {
					return;
				}
				throw new Error(effect.pasted ? 'its terminal ended before Enter could be sent' : 'its terminal ended before input could be sent');
			}
			if (!this.disposed) {
				// Those it fetched meanwhile, as the line was typed, it was not rung for
				const mail = this.context.table.state.mail;
				const named = (task ? [task] : now).map(message => message.id).filter(each => mail.entries.get(each)?.state === 'unread');
				if (named.length) {
					this.context.table.messages.rang(id, named);
				}
				this.retryAt.delete(id);
				// One that waited a while for the window - away - is said to have, for a notice of its messages soon after
				if ((this.windowWaited.get(id) ?? 0) >= WINDOW_SILENT_MS) {
					this.rangLate.set(id, Date.now());
				} else {
					this.rangLate.delete(id);
				}
			}
		} catch (err) {
			if (!this.disposed) {
				this.retryAt.set(id, Date.now() + RETRY_MS);
				this.context.log(`Could not send the doorbell to ${label}. Retrying in one minute. Reason: ${messageOf(err)}`);
			}
		} finally {
			this.ringing.delete(id);
			this.windowWaited.delete(id);
			this.update(id);
		}
	}

	/**
	 * Waits for the doorbell's turn in the agent's terminal: while the person types there - a line typed and not
	 * sent with Enter, and a key within the last 10 seconds - and while Facade's own input goes in there or waits
	 * its turn. Its line is made only then, of what is unread as it goes in; and Facade turned off meanwhile, it
	 * never goes in. A window that cannot tell does not hold the doorbell back.
	 */
	private async waitForTurn(agent: Agent, label: string): Promise<void> {
		try {
			while (!this.disposed && isLive(this.context.table.get(agent.id))) {
				let input: PersonInput | undefined;
				try {
					input = await this.windowAnswer(agent.id, () => this.context.ports.terminals.input(agent.id));
				} catch (err) {
					this.context.log(`Could not determine the human-input state of ${label}'s terminal: ${messageOf(err)}`);
					return;
				}
				const typing = !!input?.pending && input.lastKey !== undefined && Date.now() - input.lastKey < TYPING_IDLE_MS;
				if (!typing && !input?.busy) {
					return;
				}
				(typing ? this.waiting : this.behind).add(agent.id);
				(typing ? this.behind : this.waiting).delete(agent.id);
				await timeout(TYPING_POLL_MS);
			}
		} finally {
			this.waiting.delete(agent.id);
			this.behind.delete(agent.id);
		}
	}

	/** The agent's task, where it is unread and no doorbell named it yet: its next doorbell is its first line. */
	private taskOf(agent: Agent, unread: readonly Message[]): Message | undefined {
		const mail = this.context.table.state.mail;
		const task = mail.tasks.get(agent.id);
		return unread.find(message => message.id === task && mail.entries.get(task)?.rings === 0);
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
