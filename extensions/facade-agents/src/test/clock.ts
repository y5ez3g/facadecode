/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A timer the clock holds: when it is due, and what it runs. */
interface Timer {
	readonly at: number;
	readonly run: () => void;
}

/**
 * A clock for tests of what runs in memory: while it is installed, `setTimeout`, `clearTimeout` and
 * `Date.now` are its own, and time moves only when the test moves it - every timer due on the way
 * firing in its turn, and what each one set going settled before the next. Mocha keeps timers of its
 * own, so a test's timeout still ends it.
 */
export class FakeClock {

	private readonly timers = new Map<number, Timer>();
	private last = 0;
	private readonly real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, now: Date.now, setImmediate: global.setImmediate };

	private constructor(private now: number) { }

	/** Puts a clock at the real time in place of the real one. */
	static install(): FakeClock {
		const clock = new FakeClock(Date.now());
		const handle = (id: number) => ({ id, ref: () => handle(id), unref: () => handle(id), hasRef: () => true, refresh: () => handle(id), [Symbol.toPrimitive]: () => id });
		global.setTimeout = ((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const id = ++clock.last;
			clock.timers.set(id, { at: clock.now + Math.max(0, ms ?? 0), run: () => run(...args) });
			return handle(id);
		}) as unknown as typeof global.setTimeout;
		global.clearTimeout = ((timer: unknown) => {
			clock.timers.delete(typeof timer === 'object' && timer ? (timer as { id: number }).id : Number(timer));
		}) as typeof global.clearTimeout;
		Date.now = () => clock.now;
		return clock;
	}

	/** Puts the real clock back; timers still set never fire. */
	uninstall(): void {
		global.setTimeout = this.real.setTimeout;
		global.clearTimeout = this.real.clearTimeout;
		Date.now = this.real.now;
		this.timers.clear();
	}

	/** Moves time on by `ms`: each timer due on the way fires at its time, in the order it is due. */
	async tick(ms: number): Promise<void> {
		const end = this.now + ms;
		await this.settle();
		for (let due = this.nextDue(end); due; due = this.nextDue(end)) {
			this.timers.delete(due[0]);
			this.now = Math.max(this.now, due[1].at);
			due[1].run();
			await this.settle();
		}
		this.now = end;
		await this.settle();
	}

	/** The timer due first, no later than `end`: of two due together, the one set first. */
	private nextDue(end: number): [number, Timer] | undefined {
		let first: [number, Timer] | undefined;
		for (const entry of this.timers) {
			if (entry[1].at <= end && (!first || entry[1].at < first[1].at)) {
				first = entry;
			}
		}
		return first;
	}

	/** Lets what a timer set going run as far as it can while time stands still. */
	private async settle(): Promise<void> {
		for (let turn = 0; turn < 3; turn++) {
			await new Promise(resolve => this.real.setImmediate(resolve));
		}
	}
}

/** The running test's clock: the core's time moves only as the test moves it. */
let clock: FakeClock;

/** Every test of the suite it is called in runs on a clock of its own. */
export function useFakeClock(): void {
	setup(() => {
		clock = FakeClock.install();
	});
	teardown(() => {
		clock.uninstall();
	});
}

/** Moves the clock on by `ms`. */
export function sleep(ms: number): Promise<void> {
	return clock.tick(ms);
}

/** Moves the clock on until `test` holds, for `ms` at most. */
export async function until(test: () => boolean, ms = 1000): Promise<void> {
	for (let waited = 0; waited < ms && !test(); waited += 10) {
		await clock.tick(10);
	}
}

/** `promise`, which waits on the core's own timers: the clock moves on until it settles, for `ms` at most. */
export async function settled<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
	let done = false;
	promise.then(() => done = true, () => done = true);
	await until(() => done, ms);
	return promise;
}
