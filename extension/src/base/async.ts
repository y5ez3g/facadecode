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

/** Blocks the thread for `ms` milliseconds, for a short wait where the event loop cannot be returned to. */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
