/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentCli, terminalName } from '../clis';
import { Agent, FACADE, Message, YOU } from '../record/events';
import { AgentRegistry } from '../record/registry';
import { Disposable, Person, Terminals } from './ports';

/** How long after the person's last keystroke in a terminal Facade may type into it (WA-6.4). */
const QUIET_MS = 5_000;
/** Between the text typed and the Enter that submits it: sent together, a terminal UI can take both for one paste. */
const SUBMIT_GAP_MS = 300;

export interface DeliveryOptions {
	readonly registry: AgentRegistry;
	readonly terminals: Terminals;
	readonly person: Person;
	readonly log: (message: string) => void;
	readonly quietMs?: number;
	readonly now?: () => number;
}

/** Messages as their recipient reads them (WA-6.4): `[from @name] text`, or `[from facade] text`. */
export function renderMessages(messages: readonly Message[]): string {
	return messages.map(message => `[from ${message.from === FACADE ? FACADE : `@${message.from}`}] ${message.text}`).join('\n');
}

export function terminalOf(agent: Agent): string {
	return terminalName(agent.name, agent.incarnation, agent.cli);
}

export function isRunning(agent: Agent | undefined): agent is Agent {
	return !!agent && agent.state !== 'stopped' && agent.state !== 'failed';
}

/**
 * Brings each message to its recipient (WORKTREE-AGENTS.md, section 6): the person as a notification;
 * an agent with the result of its next tool call, by blocking its Stop hook when its turn would end,
 * or typed into its terminal once it is idle there. Agents never poll. Each message is delivered
 * once, and the ledger records how.
 */
export class Delivery implements Disposable {

	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly typing = new Set<string>();
	private disposed = false;

	constructor(private readonly options: DeliveryOptions) { }

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	/** A message was sent: to the person at once; to an agent as soon as it can take it. */
	sent(message: Message): void {
		if (message.to === YOU) {
			const sender = this.options.registry.agent(message.from);
			this.options.person.notify(message.from, message.text, isRunning(sender) ? terminalOf(sender) : undefined);
			this.options.registry.markDelivered(message, 'notification');
			return;
		}
		this.schedule(message.to, 0);
	}

	/**
	 * Tells an agent's parent what became of it (WA-6.11), as a message from Facade. A parent that
	 * has left is told nothing.
	 */
	notice(subject: Agent, text: string): void {
		const { registry, person } = this.options;
		if (subject.parent !== YOU && !isRunning(registry.agent(subject.parent))) {
			return;
		}
		const message = registry.sendMessage(FACADE, subject.parent, text);
		if (subject.parent === YOU) {
			person.notify(FACADE, text, isRunning(subject) ? terminalOf(subject) : undefined);
			registry.markDelivered(message, 'notification');
		} else {
			this.schedule(subject.parent, 0);
		}
	}

	/** The messages waiting for an agent, delivered with the result of its tool call (WA-5.3). */
	withResult(name: string): Message[] {
		return this.deliver(name, 'result');
	}

	/** At its Stop hook: the messages that keep the agent's turn going (WA-6.3), or none to let it end. */
	atStop(name: string): Message[] {
		return this.deliver(name, 'stop');
	}

	/** Drops what waits for an agent that stopped: nobody is there to take it (WA-6.8). */
	drop(name: string): void {
		this.deliver(name, 'dropped');
	}

	/** Types what waits for an idle agent into its terminal, once it can take it (WA-6.4). */
	schedule(name: string, delayMs: number): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.timers.get(name));
		this.timers.set(name, setTimeout(() => {
			this.timers.delete(name);
			void this.typeWaiting(name);
		}, delayMs));
	}

	/** After a reload: what came while the window was away goes on its way (WA-10.3). */
	resume(): void {
		for (const name of new Set([...this.options.registry.state.pending.values()].map(message => message.to))) {
			if (name === YOU) {
				for (const message of this.options.registry.pendingFor(YOU)) {
					this.sent(message);
				}
			} else {
				this.schedule(name, 0);
			}
		}
	}

	private deliver(name: string, way: 'result' | 'stop' | 'dropped'): Message[] {
		const { registry } = this.options;
		const messages = registry.pendingFor(name);
		for (const message of messages) {
			registry.markDelivered(message, way);
		}
		return messages;
	}

	/**
	 * Only at its input box - its turn ended, and nothing asks it anything - and only once nobody has
	 * typed in its terminal for a while: a menu picks by number and Enter, so text typed at the wrong
	 * moment would answer for the person.
	 */
	private async typeWaiting(name: string): Promise<void> {
		const { registry, terminals, log } = this.options;
		const agent = registry.agent(name);
		const cli = agent && agentCli(agent.cli);
		if (this.disposed || this.typing.has(name) || !agent || agent.state !== 'idle' || !cli || !registry.pendingFor(name).length) {
			return;
		}
		const terminal = terminalOf(agent);
		this.typing.add(name);
		try {
			const quietMs = this.options.quietMs ?? QUIET_MS;
			const typedAt = await terminals.lastInputAt(terminal);
			const quietFor = (this.options.now ?? Date.now)() - (typedAt ?? 0);
			if (typedAt !== undefined && quietFor < quietMs) {
				this.schedule(name, quietMs - quietFor + 100);
				return;
			}
			// The checks took a moment: still at its input box, the same incarnation?
			const now = registry.agent(name);
			const messages = registry.pendingFor(name);
			if (this.disposed || !now || now.incarnation !== agent.incarnation || now.state !== 'idle' || !messages.length) {
				return;
			}
			for (const piece of cli.typing(renderMessages(messages))) {
				if (!await terminals.type(terminal, piece)) {
					return;
				}
			}
			await delay(SUBMIT_GAP_MS);
			await terminals.type(terminal, '\r');
			for (const message of messages) {
				registry.markDelivered(message, 'terminal');
			}
			// What was typed starts a turn: nothing more is typed over it before its hooks say so.
			registry.setState(name, agent.incarnation, 'working', 'took messages typed into its terminal');
			log(`Typed ${messages.length} message(s) into ${terminal}.`);
		} finally {
			this.typing.delete(name);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
