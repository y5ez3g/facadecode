/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A promise and the functions that settle it. */
export class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (error: Error) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

/** At most `limit` holders at once; the rest wait in order. */
export class Semaphore {

	private holders = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private limit: number) { }

	setLimit(limit: number): void {
		this.limit = Math.max(1, limit);
		this.drain();
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.holders < this.limit) {
			this.holders++;
			return Promise.resolve();
		}
		return new Promise(resolve => this.waiting.push(resolve));
	}

	private release(): void {
		this.holders--;
		this.drain();
	}

	private drain(): void {
		while (this.holders < this.limit && this.waiting.length) {
			this.holders++;
			this.waiting.shift()!();
		}
	}
}

/** Runs tasks for the same key one at a time, in the order they came. */
export class KeyedMutex {

	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.then(task, task);
		const tail = next.catch(() => undefined);
		this.tails.set(key, tail);
		tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return next;
	}
}

/** Resolves after `ms`, or rejects when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new CancelledError());
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new CancelledError());
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

/** A value a tool handler sends back while it works: shown as MCP progress. */
export type ProgressReporter = (message: string) => void;
