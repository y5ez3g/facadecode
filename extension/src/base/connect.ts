/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';

/**
 * What connecting to a local socket - a Unix domain socket, or a named pipe on Windows - found within its time: the connection; or
 * why there is none, `absent` only where nothing is there to answer - no such name, or on POSIX a name nothing listens on, as a
 * process that ended leaves it. Anything else - a listener slower than the time, as a busy Windows pipe is, or another failure -
 * may still be there: it is never taken for a missing one.
 */
export type Reached = { readonly socket: net.Socket } | { readonly socket?: undefined; readonly absent: boolean; readonly reason: string };

/**
 * Whether a failure to connect, by its `code`, proves nothing listens there (ARCHITECTURE-2.3): no such name; or on POSIX a name
 * nothing listens on, as a process that ended leaves its socket file. A Windows pipe goes with its process, so a refusal there
 * proves nothing. The one rule for the windows that start ptyd and for a ptyd that takes over its socket.
 */
export function provesAbsent(code: string | undefined): boolean {
	return code === 'ENOENT' || (process.platform !== 'win32' && code === 'ECONNREFUSED');
}

/** Connects to `socketPath` within `ms` (ARCHITECTURE-2.1, 2.3): see {@link Reached}. */
export function connectWithin(socketPath: string, ms: number): Promise<Reached> {
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		let settled = false;
		const settle = (reached: Reached) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(reached);
			}
		};
		const timer = setTimeout(() => {
			socket.destroy();
			settle({ absent: false, reason: `it took no connection within ${ms / 1000} seconds` });
		}, ms);
		const failed = (err: NodeJS.ErrnoException) => {
			socket.destroy();
			settle({ absent: provesAbsent(err.code), reason: err.message });
		};
		socket.once('error', failed);
		socket.once('connect', () => {
			socket.off('error', failed);
			settle({ socket });
		});
	});
}
