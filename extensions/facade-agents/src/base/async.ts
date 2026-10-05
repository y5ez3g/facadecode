/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Resolves after `ms` milliseconds. */
export function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
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
