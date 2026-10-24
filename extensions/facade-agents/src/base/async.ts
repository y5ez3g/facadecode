/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelledError } from './errors';

/** Resolves after `ms` milliseconds; rejects with a `CancelledError` as soon as `signal` aborts. */
export function timeout(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new CancelledError());
			return;
		}
		const onAbort = () => {
			clearTimeout(handle);
			reject(new CancelledError());
		};
		const handle = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * What comes first: `promise`'s value - or, once `ms` pass, `onTimeout()`'s, the promise running
 * on, its late outcome dropped; an `onTimeout` that throws rejects with what it threw. A rejection of
 * the promise is its own, thrown as ever, whenever it comes. No timer is left running either way.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((resolve, reject) => {
			timer = setTimeout(() => {
				// What `onTimeout` throws is the answer's failure, not an error of the timer's
				try {
					resolve(onTimeout());
				} catch (err) {
					reject(err);
				}
			}, ms);
		})
	]).finally(() => { if (timer !== undefined) { clearTimeout(timer); } });
}

/**
 * Asks with `ask`, `pollMs` apart, until an answer `tells` or `ms` pass: each ask waited for as long as is left, and
 * read as `unknown` past it - one never answered, by a window away, holds nothing up beyond `ms` (REMOTE.md R4).
 */
export async function askUntil<T>(ask: () => Promise<T>, tells: (answer: T) => boolean, unknown: T, ms: number, pollMs: number): Promise<T> {
	const deadline = Date.now() + ms;
	const asked = () => withDeadline(ask(), Math.max(0, deadline - Date.now()), () => unknown);
	let answer = await asked();
	while (!tells(answer) && Date.now() < deadline) {
		await timeout(pollMs);
		answer = await asked();
	}
	return answer;
}

/** A promise that whoever holds it settles, once: what comes after the first `complete` or `error` is ignored. */
export class DeferredPromise<T> {

	readonly p: Promise<T>;
	private callbacks: { readonly resolve: (value: T) => void; readonly reject: (err: unknown) => void } | undefined;

	constructor() {
		this.p = new Promise<T>((resolve, reject) => {
			this.callbacks = { resolve, reject };
		});
	}

	/** Resolves the promise with `value`, unless it has settled. */
	complete(value: T): void {
		const callbacks = this.callbacks;
		this.callbacks = undefined;
		callbacks?.resolve(value);
	}

	/** Rejects the promise with `err`, unless it has settled. */
	error(err: unknown): void {
		const callbacks = this.callbacks;
		this.callbacks = undefined;
		callbacks?.reject(err);
	}
}

/** Blocks the thread for `ms` milliseconds, for a short wait where the event loop cannot be returned to. */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
