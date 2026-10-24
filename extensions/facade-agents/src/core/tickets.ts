/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { FacadeError } from './errors';
import { InputEffect } from './ports';

/** An operation the extension host asks of the window: each carries a ticket the window claims before it acts (REMOTE.md R7). */
export type TicketOp = 'create' | 'type' | 'keys' | 'stop' | 'read' | 'delete';

/** Whether the run a ticket is for is live, stopping, or gone - ended, or no run of the record (REMOTE.md R7). */
export type RunLiveness = 'live' | 'stopping' | 'gone';

/** What the caller of a timed window operation is told once its wait ends: the operation was not done, its outcome is unknown, or the window did not answer. */
export type TicketTimeoutOutcome = 'not_applied' | 'unknown' | 'unavailable';

/** The timers a ticketed call waits with: the registry, narrowed for what such a call needs of it. */
export interface TicketTimers {
	/** The caller's wait ended, or its call to the window failed: what the caller is told, the ticket decided. */
	timeout(ticket: string): TicketTimeoutOutcome;
	/** The window answered: whether the caller still waits - false where it was already told, the answer moot. */
	answered(ticket: string): boolean;
	/** Whether the window claimed `ticket` and may be acting now: granted, the caller still waiting. */
	granted(ticket: string): boolean;
}

/** How much longer than the write's own time a granted ticket waits past the caller's wait: 10 seconds. */
export const GRANTED_MARGIN_MS = 10_000;

/** What `runTicketedCall` waits with: `setTimeout` as the host has it, or driven, as a test does. */
export interface TicketClock {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * The tickets of the operations this extension host asked of its window, each decided once, in order,
 * then forgotten: a claim that comes while the caller still waits is granted; after that the caller can
 * only have been told done, unknown or unconfirmed, never not done - and a later claim, the ticket gone,
 * is refused as unknown (REMOTE.md R4, R7).
 *
 * A ticket is its host's own: `${boot}.${counter}`, the boot id random per registry, so a claim from the
 * window for an operation of an extension host before - its tickets died with it - is unknown, and refused.
 * Read stays harmless: a read changes nothing, so its claim is granted while it is known.
 */
export class TicketRegistry implements TicketTimers {

	private readonly boot = crypto.randomBytes(8).toString('hex');
	private counter = 0;
	private readonly tickets = new Map<string, { readonly op: TicketOp; readonly run: number; phase: 'wanted' | 'granted' }>();

	/** `runs` says whether a run is live: the agent table, as the host reads it. */
	constructor(private readonly runs: (id: number) => RunLiveness) { }

	/** A ticket for `op` on the run `id`, wanted from now on. */
	issue(op: TicketOp, run: number): string {
		const ticket = `${this.boot}.${++this.counter}`;
		this.tickets.set(ticket, { op, run, phase: 'wanted' });
		return ticket;
	}

	/**
	 * Whether the window may act on `ticket` now: granted where the operation is still wanted - input
	 * whose caller still waits, for a run that is live, a start whose run was not stopped, a worktree's
	 * deletion whose caller still waits, whatever became of the agent it was asked for - and refused
	 * where it is not, was never issued here, or was already decided. A granted claim stays granted while
	 * the caller waits, however often it is claimed: the window acts once, and a second grant finds
	 * nothing to do.
	 */
	claim(ticket: string): boolean {
		const found = this.tickets.get(ticket);
		if (!found) {
			return false;
		}
		if (found.op === 'read' || found.op === 'stop' || found.op === 'delete') {
			found.phase = 'granted';
			return true;
		}
		if (this.runs(found.run) !== 'live') {
			return false;
		}
		found.phase = 'granted';
		return true;
	}

	/**
	 * The caller's wait for `ticket` ended, or its call to the window failed: what the caller is told,
	 * the ticket decided and forgotten. One never claimed was never acted on - not applied, or the window
	 * did not answer a read - and is wanted no more, so a later claim is refused and nothing is ever done
	 * late. One claimed may have been acted on already: unknown. Decided again, it is unknown: nothing is
	 * known of a forgotten ticket.
	 */
	timeout(ticket: string): TicketTimeoutOutcome {
		const found = this.tickets.get(ticket);
		if (!found) {
			return 'unknown';
		}
		this.tickets.delete(ticket);
		if (found.op === 'read') {
			return 'unavailable';
		}
		if (found.op === 'type' || found.op === 'keys' || found.op === 'delete') {
			return found.phase === 'granted' ? 'unknown' : 'not_applied';
		}
		return 'unknown';
	}

	answered(ticket: string): boolean {
		if (!this.tickets.has(ticket)) {
			return false;
		}
		this.tickets.delete(ticket);
		return true;
	}

	granted(ticket: string): boolean {
		return this.tickets.get(ticket)?.phase === 'granted';
	}
}

/**
 * Asks the window for `call` with a ticket for `op` on the run `id`, waiting as long as it
 * takes: a create, a stop. The ticket is answered once the window answered, or the call failed -
 * a rejected call leaks no entry.
 */
export async function runUntimedTicketedCall<T>(tickets: TicketRegistry, op: TicketOp, run: number, call: (ticket: string) => Promise<T>): Promise<T> {
	const ticket = tickets.issue(op, run);
	try {
		return await call(ticket);
	} finally {
		tickets.answered(ticket);
	}
}

/**
 * Whether the window has the command `id`, its commands `known` learned once as the terminals
 * started: false where they say it has not - no Facade workbench - and 'timeout' where they are
 * not learned within `waitMs`, the window away (REMOTE.md R4).
 */
export async function hasWindowCommand(known: Promise<ReadonlySet<string>>, id: string, waitMs: number, clock: TicketClock): Promise<boolean | 'timeout'> {
	let timer: unknown;
	try {
		return await Promise.race([
			known.then(commands => commands.has(id), () => false),
			new Promise<'timeout'>(resolve => { timer = clock.setTimeout(() => resolve('timeout'), waitMs); })
		]);
	} finally {
		if (timer !== undefined) {
			clock.clearTimeout(timer);
		}
	}
}

/**
 * Why input ends where the window never claimed its ticket - or its commands were never learned -
 * and answered nothing else meanwhile: it did not answer in time, and nothing was written. Where it
 * answered something else, its queue's own answer says so instead (D3). The reason codes stay: not
 * applied, on its turn's time.
 */
export function unansweredInputError(kind: 'text' | 'keys', waitMs: number): FacadeError {
	const seconds = Math.round(waitMs / 1000);
	return new FacadeError('UNAVAILABLE', kind === 'text'
		? `The window did not answer within ${seconds} seconds; nothing was typed.`
		: `The window did not answer within ${seconds} seconds; no keys were sent.`, { outcome: 'not_applied', reason: 'timeout' });
}

/**
 * What the caller of typed `kind` is told once its wait ends: unknown, where the window claimed its
 * ticket and may have written already - and, where it never did, the queue's own answer, not applied
 * on its turn's time behind human typing or earlier Facade input (D3), where the window answered
 * something else meanwhile; that it did not answer, where it answered nothing, and nothing was
 * written. The host's wait ends first - its timer starts before the RPC is sent, the window's queue
 * timer on receipt - so a live window's queue never gets to answer itself.
 */
export function inputTimeoutAnswer(outcome: TicketTimeoutOutcome, kind: 'text' | 'keys', waitMs: number, heardDuringWait: boolean): InputEffect {
	if (outcome === 'unknown') {
		throw new Error(`the window answered too late to say whether the ${kind} was written`);
	}
	if (outcome === 'unavailable' || !heardDuringWait) {
		throw unansweredInputError(kind, waitMs);
	}
	return kind === 'text'
		? { outcome: 'not_applied', reason: 'timeout', pasted: false, entered: false }
		: { outcome: 'not_applied', reason: 'timeout', keysSent: 0 };
}

/**
 * Calls the window with `call`, waiting `waitMs` for its answer - as long as it likes with none. The
 * answer, where the caller still waits, is the call's; where the wait ends first on a ticket never
 * claimed, or the call fails, the ticket decides what the caller is told instead
 * (`TicketRegistry.timeout`), and a late answer - the reconnection delivering the window's part late -
 * is dropped (REMOTE.md R4). `onTimeout` turns that outcome into the call's answer, or throws it. A
 * granted ticket waits `grantedMs` past the wait for the window's answer - begun input is its actual
 * effect - unknown only past that; without one it is unknown at the wait's end, as a call that fails is.
 */
export function runTicketedCall<T>(options: {
	readonly ticket: string;
	readonly waitMs: number | undefined;
	/** How much longer a granted ticket waits past the wait: the write's own time and a margin. */
	readonly grantedMs?: number;
	readonly call: () => Promise<T>;
	readonly timers: TicketTimers;
	readonly onTimeout: (outcome: TicketTimeoutOutcome) => T;
	readonly clock: TicketClock;
}): Promise<T> {
	const { ticket, waitMs, grantedMs, call, timers, onTimeout, clock } = options;
	if (waitMs === undefined) {
		return call().then(value => {
			timers.answered(ticket);
			return value;
		}, err => {
			timers.answered(ticket);
			throw err;
		});
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let extended = false;
		let timer = clock.setTimeout(onDeadline, waitMs);
		function onDeadline(): void {
			if (settled) {
				return;
			}
			if (!extended && grantedMs !== undefined && timers.granted(ticket)) {
				extended = true;
				timer = clock.setTimeout(onDeadline, grantedMs);
				return;
			}
			settleTimeout();
		}
		function settleTimeout(): void {
			settled = true;
			try {
				resolve(onTimeout(timers.timeout(ticket)));
			} catch (err) {
				reject(err);
			}
		}
		void call().then(value => {
			if (settled) {
				return;
			}
			settled = true;
			clock.clearTimeout(timer);
			timers.answered(ticket);
			resolve(value);
		}, () => {
			if (settled) {
				return;
			}
			settled = true;
			clock.clearTimeout(timer);
			try {
				resolve(onTimeout(timers.timeout(ticket)));
			} catch (err) {
				reject(err);
			}
		});
	});
}
