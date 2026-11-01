/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
 * Calls `attempt` until it answers - anything but undefined - or `stopped()` says to give up, waiting `first` milliseconds before the
 * second call and twice as long before each one after, up to `most`. A call that rejects counts as one that did not answer, and is
 * said to `failed`: what is tried again is never given up for one failure. Answers what the last call answered.
 */
export async function untilAnswered<T>(attempt: () => Promise<T | undefined>, options: {
	readonly first: number;
	readonly most: number;
	readonly stopped: () => boolean;
	readonly failed: (err: unknown) => void;
	readonly wait: (ms: number) => Promise<void>;
}): Promise<T | undefined> {
	for (let wait = options.first; ; wait = Math.min(wait * 2, options.most)) {
		let answer: T | undefined;
		try {
			answer = await attempt();
		} catch (err) {
			options.failed(err);
		}
		if (answer !== undefined || options.stopped()) {
			return answer;
		}
		await options.wait(wait);
	}
}

/** Blocks the thread for `ms` milliseconds, for a short wait where the event loop cannot be returned to. */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
