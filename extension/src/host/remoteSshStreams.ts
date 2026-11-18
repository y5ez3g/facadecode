/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Readable, Writable } from 'stream';
import { timeout } from '../base/async';
import { MACHINE_BRIDGE_CHUNK_BYTES } from '../base/windowIdentity';

/** Pulls bytes on demand so a slow VS Code command leaves backpressure on the socket or pipe. */
export class MachineBridgeReader {
	private reading = false;

	constructor(private readonly input: Readable, private readonly signal: AbortSignal) {
		// The next read sees `errored`, including an error between two commands.
		input.on('error', () => undefined);
	}

	/** A chunk, null at EOF, or undefined when an idle pull reaches its time limit. */
	async read(waitMs?: number): Promise<Buffer | null | undefined> {
		if (this.reading) {
			throw new Error('A Facade machine bridge read is already pending on this stream.');
		}
		this.reading = true;
		try {
			return await new Promise((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer);
					this.input.off('readable', take);
					this.input.off('end', take);
					this.input.off('close', take);
					this.input.off('error', take);
					this.signal.removeEventListener('abort', take);
				};
				const take = () => {
					try {
						this.signal.throwIfAborted();
						const size = Math.min(this.input.readableLength, MACHINE_BRIDGE_CHUNK_BYTES);
						// read(0) lets Node signal EOF when the previous pull drained the last bytes.
						const bytes = this.input.read(size) as Buffer | null;
						if (bytes !== null) {
							cleanup();
							resolve(bytes);
						} else if (this.input.errored) {
							throw this.input.errored;
						} else if (this.input.readableEnded || this.input.destroyed) {
							cleanup();
							resolve(null);
						}
					} catch (err) {
						cleanup();
						reject(err);
					}
				};
				const timer = waitMs === undefined ? undefined : setTimeout(() => {
					cleanup();
					resolve(undefined);
				}, waitMs);
				for (const event of ['readable', 'end', 'close', 'error']) {
					this.input.on(event, take);
				}
				this.signal.addEventListener('abort', take, { once: true });
				take();
			});
		} finally {
			this.reading = false;
		}
	}
}

/** Waits for a write to finish before the caller sends another chunk. Undefined sends input EOF. */
export function writeMachineBridgeBytes(output: Writable, bytes?: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = (err?: Error | null) => {
			output.off('close', closed);
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		};
		const closed = () => done(output.errored ?? new Error('The Facade machine bridge output closed.'));
		if (output.destroyed || (bytes && output.writableEnded)) {
			closed();
			return;
		}
		output.once('close', closed);
		if (bytes) {
			output.write(bytes, done);
		} else {
			output.end(done);
		}
	});
}

/** Limits a bridge operation even when its peer or VS Code's command path is no longer answering. */
export async function withinMachineBridge<T>(pending: PromiseLike<T>, waitMs: number, message: string, signal?: AbortSignal): Promise<T> {
	const clock = new AbortController();
	try {
		return await Promise.race([pending, timeout(waitMs, signal ? AbortSignal.any([signal, clock.signal]) : clock.signal).then(() => {
			throw new Error(message);
		})]);
	} finally {
		clock.abort();
	}
}
