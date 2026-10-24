/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../base/async';
import { RunLiveness, hasWindowCommand, inputTimeoutAnswer, runTicketedCall, runUntimedTicketedCall, TicketClock, TicketRegistry, TicketTimeoutOutcome, unansweredInputError } from '../core/tickets';
import { failureOf, outcomeOf } from './util';

suite('Tickets: what the window may still do for the extension host', () => {

	/** A registry whose runs are live unless `liveness` says otherwise. */
	function registry(liveness: (id: number) => RunLiveness = () => 'live'): TicketRegistry {
		return new TicketRegistry(liveness);
	}

	/** A clock the test fires by hand: `timers` holds what waits, in the order set. */
	function clock(): { readonly clock: TicketClock; readonly timers: (() => void)[] } {
		const timers: (() => void)[] = [];
		return {
			timers,
			clock: {
				setTimeout: (callback: () => void) => { timers.push(callback); return timers.length - 1; },
				clearTimeout: (handle: unknown) => { delete timers[handle as number]; }
			}
		};
	}

	test('a claim that comes while the caller still waits is granted, for a run that is live; a claim for a ticket never issued here - an extension host before\'s - is refused (REMOTE.md R4, R7; RM-28)', () => {
		const tickets = registry();
		const type = tickets.issue('type', 1);
		const keys = tickets.issue('keys', 1);
		const create = tickets.issue('create', 2);

		assert.deepStrictEqual({
			type: tickets.claim(type),
			keys: tickets.claim(keys),
			create: tickets.claim(create),
			unknown: tickets.claim('deadbeef.1'),
			empty: tickets.claim('')
		}, { type: true, keys: true, create: true, unknown: false, empty: false });
	});

	test('each ticket is decided once: a granted claim stays granted while the caller waits, however often it is claimed; once the window answered, or the caller was told, a later claim is refused (RM-28)', () => {
		const tickets = registry();
		const granted = tickets.issue('type', 1);
		const answered = tickets.issue('type', 2);
		const timedOut = tickets.issue('type', 3);
		tickets.claim(granted);
		tickets.answered(answered);
		tickets.timeout(timedOut);

		assert.deepStrictEqual({
			grantedAgain: tickets.claim(granted),
			afterAnswer: tickets.claim(answered),
			afterTimeout: tickets.claim(timedOut)
		}, { grantedAgain: true, afterAnswer: false, afterTimeout: false });
	});

	test('a start stopped while its terminal waits for the window makes nothing: its create is refused; input for a run stopping, or gone, is refused too, while a stop is granted, whatever the run (RM-28)', () => {
		const tickets = registry(id => id === 1 ? 'stopping' : id === 2 ? 'gone' : 'live');
		const stoppedCreate = tickets.issue('create', 1);
		const stoppingType = tickets.issue('type', 1);
		const goneKeys = tickets.issue('keys', 2);
		const stopStopping = tickets.issue('stop', 1);
		const stopGone = tickets.issue('stop', 2);
		const liveCreate = tickets.issue('create', 3);

		assert.deepStrictEqual({
			stoppedCreate: tickets.claim(stoppedCreate),
			stoppingType: tickets.claim(stoppingType),
			goneKeys: tickets.claim(goneKeys),
			stopStopping: tickets.claim(stopStopping),
			stopGone: tickets.claim(stopGone),
			liveCreate: tickets.claim(liveCreate)
		}, { stoppedCreate: false, stoppingType: false, goneKeys: false, stopStopping: true, stopGone: true, liveCreate: true });
	});

	test('stopping an unclaimed worktree create settles its wait and refuses a late window claim', async () => {
		let state: RunLiveness = 'live';
		const tickets = registry(() => state);
		const window = new DeferredPromise<string>();
		let ticket = '';
		const creating = tickets.runUnclaimedCreate(1, issued => { ticket = issued; return window.p; });
		state = 'stopping';
		tickets.cancelUnclaimedCreate(1);
		const result = await creating;
		window.complete('made too late');

		assert.deepStrictEqual({ result, lateClaim: tickets.claim(ticket), stillPending: tickets.answered(ticket) }, {
			result: undefined, lateClaim: false, stillPending: false
		});
	});

	test('stopping after the window claimed a worktree create waits for its Git result', async () => {
		let state: RunLiveness = 'live';
		const tickets = registry(() => state);
		const window = new DeferredPromise<string>();
		let ticket = '';
		let answered = false;
		const creating = tickets.runUnclaimedCreate(1, issued => { ticket = issued; return window.p; });
		void creating.then(() => answered = true);
		assert.strictEqual(tickets.claim(ticket), true);
		state = 'stopping';
		tickets.cancelUnclaimedCreate(1);
		await Promise.resolve();
		const before = answered;
		window.complete('made');
		const result = await creating;

		assert.deepStrictEqual({ before, result, lateClaim: tickets.claim(ticket) }, { before: false, result: 'made', lateClaim: false });
	});

	test('a run stopped while waiting for the repository lock sends no worktree request', async () => {
		const tickets = registry(() => 'stopping');
		let called = false;
		const result = await tickets.runUnclaimedCreate(1, async () => { called = true; return 'made'; });
		assert.deepStrictEqual({ result, called }, { result: undefined, called: false });
	});

	test('read stays harmless: its claim is granted for any run, live or gone; unknown, or answered before, it is refused like any other (RM-28)', () => {
		const tickets = registry(() => 'gone');
		const read = tickets.issue('read', 1);
		tickets.answered(read);

		assert.deepStrictEqual({
			known: tickets.claim(tickets.issue('read', 1)),
			unknown: tickets.claim('deadbeef.9'),
			answered: tickets.claim(read)
		}, { known: true, unknown: false, answered: false });
	});

	test('a worktree\'s deletion is granted while its caller waits, whatever became of the agent it was asked for; its wait over, one never claimed is not applied and its later claim refused, one claimed is unknown (REMOTE.md R4, R7)', () => {
		const tickets = registry(() => 'gone');
		const claimed = tickets.issue('delete', 0);
		const unclaimed = tickets.issue('delete', 0);
		const granted = tickets.claim(claimed);
		const outcomes = { claimed: tickets.timeout(claimed), unclaimed: tickets.timeout(unclaimed) };

		assert.deepStrictEqual({ granted, outcomes, lateClaim: tickets.claim(unclaimed) }, { granted: true, outcomes: { claimed: 'unknown', unclaimed: 'not_applied' }, lateClaim: false });
	});

	test('input still queued when its wait ends is not applied, and never typed later: a later claim is refused; claimed input is done or unknown, never not applied (RM-28)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const calls: string[] = [];
		const call = (ticket: string, waitMs: number | undefined, answer: () => Promise<string>) => runTicketedCall({
			ticket, waitMs, timers: tickets, clock: driven,
			call: () => { calls.push(ticket); return answer(); },
			onTimeout: outcome => `caller told ${outcome}`
		});
		// Held in the queue behind the person's typing past the timeout: the window never answers
		const queuedTicket = tickets.issue('type', 1);
		const queued: Promise<string> = call(queuedTicket, 100, () => new Promise(() => { }));
		// Claimed just before its caller's timeout: the window answers, but the answer is lost
		const claimedTicket = tickets.issue('type', 2);
		const claimed: Promise<string> = call(claimedTicket, 100, () => new Promise(() => { }));
		assert.strictEqual(tickets.claim(claimedTicket), true);
		assert.deepStrictEqual(calls, [queuedTicket, claimedTicket]);
		timers.forEach(fire => fire?.());
		const [queuedOutcome, claimedOutcome] = [await queued, await claimed];

		assert.deepStrictEqual({
			queuedOutcome,
			claimedOutcome,
			lateClaim: tickets.claim(queuedTicket),
			lateClaimAfterUnknown: tickets.claim(claimedTicket)
		}, {
			queuedOutcome: 'caller told not_applied',
			claimedOutcome: 'caller told unknown',
			lateClaim: false,
			lateClaimAfterUnknown: false
		});
	});

	test('a call the window answers in time is the caller\'s answer; a late answer, after the caller was told, changes nothing; a call that fails is the wait ending (RM-28)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const run = (ticket: string, answer: () => Promise<string>) => runTicketedCall({
			ticket, waitMs: 100, timers: tickets, clock: driven, call: answer, onTimeout: outcome => `caller told ${outcome}`
		});
		const inTime = await run(tickets.issue('type', 1), async () => 'applied');
		const failing = await run(tickets.issue('type', 2), async () => { throw new Error('the window went'); });
		const lateTicket = tickets.issue('type', 3);
		let answerLate!: (value: string) => void;
		const late = run(lateTicket, () => new Promise<string>(resolve => answerLate = resolve));
		timers.forEach(fire => fire?.());
		const lateOutcome = await late;
		answerLate('applied');
		await Promise.resolve();

		assert.deepStrictEqual({ inTime, failing, lateOutcome }, {
			inTime: 'applied',
			failing: 'caller told not_applied',
			lateOutcome: 'caller told not_applied'
		});
	});

	test('a granted ticket whose turn came just before the deadline waits past it for the window\'s answer: begun input is its actual effect, even a local window\'s a moment later (D3; RM-28)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const begunTicket = tickets.issue('type', 1);
		let write!: (value: string) => void;
		let begunOutcome = 'waiting';
		const begun = runTicketedCall({
			ticket: begunTicket, waitMs: 100, grantedMs: 50, timers: tickets, clock: driven,
			call: () => new Promise<string>(resolve => write = resolve),
			onTimeout: outcome => `caller told ${outcome}`
		});
		void begun.then(outcome => begunOutcome = outcome);
		assert.strictEqual(tickets.claim(begunTicket), true);
		timers[0]?.();
		await Promise.resolve();
		const atDeadline = begunOutcome;
		write('applied');
		const applied = await begun;

		assert.deepStrictEqual({ atDeadline, applied }, { atDeadline: 'waiting', applied: 'applied' });
	});

	test('a granted ticket with no answer past the write and its margin is unknown; each ticket decided is forgotten: decided again, it is unknown (RM-28)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const silentTicket = tickets.issue('type', 1);
		let outcome = 'waiting';
		const silent = runTicketedCall({
			ticket: silentTicket, waitMs: 100, grantedMs: 50, timers: tickets, clock: driven,
			call: () => new Promise<string>(() => { }),
			onTimeout: told => `caller told ${told}`
		});
		void silent.then(told => outcome = told);
		assert.strictEqual(tickets.claim(silentTicket), true);
		timers[0]?.();
		await Promise.resolve();
		const atDeadline = outcome;
		timers[1]?.();
		const told = await silent;

		assert.deepStrictEqual({
			atDeadline,
			told,
			decidedAgain: tickets.timeout(silentTicket),
			answeredAgain: tickets.answered(silentTicket),
			claimedAgain: tickets.claim(silentTicket)
		}, {
			atDeadline: 'waiting',
			told: 'caller told unknown',
			decidedAgain: 'unknown',
			answeredAgain: false,
			claimedAgain: false
		});
	});

	test('a read the window does not answer reports the window unavailable; a late read changes nothing (REMOTE.md R4)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const reading = runTicketedCall({
			ticket: tickets.issue('read', 1), waitMs: 100, timers: tickets, clock: driven,
			call: () => new Promise<string>(() => { }),
			onTimeout: (outcome: TicketTimeoutOutcome) => { throw new Error(`caller told ${outcome}`); }
		}).then(() => 'answered', (err: Error) => err.message);
		timers.forEach(fire => fire?.());
		const failing = await reading;

		assert.deepStrictEqual({ failing }, { failing: 'caller told unavailable' });
	});

	test('with no wait - a doorbell - the window\'s answer is the call\'s, however long it takes; no timer waits with it (REMOTE.md R4)', async () => {
		const tickets = registry();
		const { clock: driven, timers } = clock();
		const ticket = tickets.issue('type', 1);
		const rung = await runTicketedCall({
			ticket, waitMs: undefined, timers: tickets, clock: driven,
			call: async () => 'applied',
			onTimeout: () => { throw new Error('must not time out'); }
		});

		assert.deepStrictEqual({ rung, timers: timers.length, laterClaim: tickets.claim(ticket) }, { rung: 'applied', timers: 0, laterClaim: false });
	});

	test('a create or stop without a wait answers its ticket once the window answered, or the call failed: a rejected call leaks no entry', async () => {
		const tickets = registry();
		const calls: string[] = [];
		const run = (op: 'create' | 'stop', id: number, answer: (ticket: string) => Promise<string>) => runUntimedTicketedCall(tickets, op, id, ticket => {
			calls.push(`${op} #a${id} ${ticket}`);
			return answer(ticket);
		});
		const made = await run('create', 1, async () => 'made');
		const failed = await run('create', 2, async () => { throw new Error('the window went'); }).then(() => 'answered', (err: Error) => err.message);
		const stopped = await run('stop', 1, async () => 'gone');

		assert.deepStrictEqual({
			made, failed, stopped,
			tickets: calls.length,
			lateClaim: tickets.claim(calls[0].split(' ')[2]),
			lateRefused: tickets.claim(calls[1].split(' ')[2])
		}, {
			made: 'made', failed: 'the window went', stopped: 'gone',
			tickets: 3,
			lateClaim: false,
			lateRefused: false
		});
	});

	test('the window\'s commands, learned once: known, the command is there or not; not learned within the call\'s wait, the wait ends, and nothing was asked after; learned late, the next call sees them', async () => {
		const { clock: driven, timers } = clock();
		const learned = new DeferredPromise<ReadonlySet<string>>();
		const checking = hasWindowCommand(learned.p, '_facade.terminal.type', 100, driven);
		const checkingKeys = hasWindowCommand(learned.p, '_facade.terminal.keys', 100, driven);
		timers.forEach(fire => fire?.());
		const [type, keys] = [await checking, await checkingKeys];
		learned.complete(new Set(['_facade.terminal.type']));
		const { clock: later, timers: laterTimers } = clock();
		const seen = await hasWindowCommand(learned.p, '_facade.terminal.type', 100, later);
		const missing = await hasWindowCommand(learned.p, '_facade.terminal.keys', 100, later);
		const refused = await hasWindowCommand(Promise.reject(new Error('gone')), '_facade.terminal.type', 100, later);

		assert.deepStrictEqual({ type, keys, seen, missing, refused, waiting: laterTimers.filter(fire => fire !== undefined) }, { type: 'timeout', keys: 'timeout', seen: true, missing: false, refused: false, waiting: [] });
	});

	test('input the window did not answer in time says so - nothing typed, no keys sent - with the reason codes as ever: not applied, on its turn\'s time', async () => {
		assert.deepStrictEqual([await failureOf(Promise.reject(unansweredInputError('text', 5000))), await failureOf(Promise.reject(unansweredInputError('keys', 120_000)))], [
			{ code: 'UNAVAILABLE', message: 'The window did not answer within 5 seconds; nothing was typed.', data: { outcome: 'not_applied', reason: 'timeout' } },
			{ code: 'UNAVAILABLE', message: 'The window did not answer within 120 seconds; no keys were sent.', data: { outcome: 'not_applied', reason: 'timeout' } }
		]);
	});

	test('input whose wait ends on a ticket never claimed is told its queue\'s own answer where the window answered something else meanwhile - not applied on its turn\'s time, as the window\'s queue answers - and that it did not answer where it answered nothing; claimed input is unknown (D3; REMOTE.md R4)', async () => {
		const queued = {
			text: inputTimeoutAnswer('not_applied', 'text', 5_000, true),
			keys: inputTimeoutAnswer('not_applied', 'keys', 5_000, true)
		};
		const silent = {
			text: await failureOf(Promise.resolve().then(() => inputTimeoutAnswer('not_applied', 'text', 5_000, false))),
			keys: await failureOf(Promise.resolve().then(() => inputTimeoutAnswer('not_applied', 'keys', 5_000, false))),
			unavailable: await failureOf(Promise.resolve().then(() => inputTimeoutAnswer('unavailable', 'text', 5_000, true)))
		};
		const claimed = await outcomeOf(Promise.resolve().then(() => inputTimeoutAnswer('unknown', 'keys', 5_000, true)));

		assert.deepStrictEqual({ queued, silent, claimed }, {
			queued: {
				text: { outcome: 'not_applied', reason: 'timeout', pasted: false, entered: false },
				keys: { outcome: 'not_applied', reason: 'timeout', keysSent: 0 }
			},
			silent: {
				text: { code: 'UNAVAILABLE', message: 'The window did not answer within 5 seconds; nothing was typed.', data: { outcome: 'not_applied', reason: 'timeout' } },
				keys: { code: 'UNAVAILABLE', message: 'The window did not answer within 5 seconds; no keys were sent.', data: { outcome: 'not_applied', reason: 'timeout' } },
				unavailable: { code: 'UNAVAILABLE', message: 'The window did not answer within 5 seconds; nothing was typed.', data: { outcome: 'not_applied', reason: 'timeout' } }
			},
			claimed: 'the window answered too late to say whether the keys was written'
		});
	});
});
