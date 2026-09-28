/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Kernel } from './kernel';
import { LedgerEvent } from './model';

/*
 * Getting a message to an agent that is not asking for one (L2-PLAN, step 30). MCP calls only go
 * from the agent to Facade, so besides the unread count on every result and a waiting recv, an
 * agent whose turn ended gets one line typed into its terminal, as the person would type it.
 *
 * The line is typed only when the agent's turn has ended (its Stop hook), no new one has started
 * (its prompt hook), no prompt waits in its terminal, and nobody typed there in the last seconds: a
 * permission menu selects by number and Enter picks "Yes", so a line typed at the wrong moment
 * would answer for the person. Each message nudges an agent at most once.
 */

/** Typed into an idle agent's terminal. No digits: they would pick an entry of a menu. */
export const NUDGE = '[facade] new messages: call recv';

export interface DeliveryOptions {
	readonly kernel: Kernel;
	/** Types a line into an agent's terminal and presses Enter; false when it has none. */
	type(name: string, text: string): Promise<boolean>;
	/** When the person last typed into an agent's terminal, if the window can tell. */
	lastInputAt?(name: string): Promise<number | undefined>;
	/** How long the person's typing keeps Facade's hands off a terminal. Default 5 seconds. */
	readonly quietMs?: number;
	readonly now?: () => number;
	log(message: string): void;
}

export class Delivery {

	/** The newest message each agent was nudged for. */
	private readonly deliveredUpTo = new Map<string, number>();
	private readonly busy = new Set<string>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly subscription: { dispose(): void };
	private disposed = false;

	constructor(private readonly options: DeliveryOptions) {
		this.subscription = options.kernel.onDidAppend(event => this.onEvent(event));
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
	}

	private onEvent(event: LedgerEvent): void {
		if (event.type === 'message.sent') {
			this.later(event.recipients);
		} else if (event.type === 'participant.state' && event.state === 'idle') {
			this.later([event.name]);
		}
	}

	/** After the event that caused it is fully written: listeners run inside the ledger's append. */
	private later(names: readonly string[]): void {
		queueMicrotask(() => {
			for (const name of names) {
				void this.deliver(name);
			}
		});
	}

	/** Gets `name`'s waiting messages to it, if it cannot be expected to ask. Safe to call any time. */
	async deliver(name: string): Promise<void> {
		if (this.disposed || this.busy.has(name)) {
			return;
		}
		const participant = this.options.kernel.state.participants.get(name);
		if (!participant || participant.kind !== 'agent' || participant.state !== 'idle') {
			return;
		}
		const newest = this.newest(name);
		if (newest === undefined || newest <= (this.deliveredUpTo.get(name) ?? 0)) {
			return;
		}
		this.busy.add(name);
		try {
			const quietMs = this.options.quietMs ?? 5_000;
			const typedAt = await this.options.lastInputAt?.(name);
			const since = (this.options.now ?? Date.now)() - (typedAt ?? 0);
			if (typedAt !== undefined && since < quietMs) {
				// The person is at that terminal: try again once they have been quiet a while.
				this.retry(name, quietMs - since + 100);
				return;
			}
			if (this.options.kernel.state.participants.get(name)?.state !== 'idle') {
				return;
			}
			if (await this.options.type(name, NUDGE)) {
				this.deliveredUpTo.set(name, newest);
				this.options.log(`[delivery] nudged @${name} in its terminal`);
			}
		} catch (err) {
			this.options.log(`[delivery] reaching @${name} failed: ${(err as Error).message}`);
		} finally {
			this.busy.delete(name);
		}
	}

	/** The newest unread message's number, if any is unread. */
	private newest(name: string): number | undefined {
		const kernel = this.options.kernel;
		if (kernel.unread(name) === 0) {
			return undefined;
		}
		const inbox = kernel.state.inboxes.get(name)!;
		return inbox[inbox.length - 1].seq;
	}

	private retry(name: string, ms: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void this.deliver(name);
		}, ms);
		timer.unref?.();
		this.timers.add(timer);
	}
}
