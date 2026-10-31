/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { performance } from 'perf_hooks';
import * as os from 'os';
import * as path from 'path';
import { timeout } from '../../base/async';
import { messageOf } from '../../base/errors';
import { CallEvent, isPtydEvent, lineReader, Method, OwnerEvent, PTYD_PROTOCOL, Requests, Response, RunEvent, RunInfo } from '../../ptyd/protocol';
import { ensurePtydSocket } from '../../ptyd/socket';

/** How long a window waits for a ptyd it started to listen. */
const START_WAIT_MS = 5_000;

/** How long a ptyd of another protocol has to answer when a window looks for runs it still holds. */
const EARLIER_WAIT_MS = 2_000;

/**
 * A request that was refused before a write was attempted: ptyd did nothing of it. Once a write is attempted, a transport error
 * cannot establish whether ptyd received and carried out the complete request.
 */
export class PtydNotSent extends Error { }

/** A request whose answer was lost as the connection to ptyd closed: ptyd may have carried it out, all of it or part. */
export class PtydLost extends Error { }

/**
 * The socket the ptyd of `protocol` listens on for the Facade data directory `home`: one ptyd per person, directory and protocol,
 * so that a window of another protocol never talks to - or ends the runs of - a ptyd it cannot speak to (ARCHITECTURE-2.4).
 */
export function ptydSocketPath(home: string, protocol = PTYD_PROTOCOL): string {
	const key = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
	// Short even on macOS, and private even on a shared Linux host without XDG_RUNTIME_DIR. Never listen in /tmp itself.
	const socket = process.platform === 'win32' ? `\\\\.\\pipe\\facade-extension-ptyd-${protocol}-${key}`
		: path.join('/tmp', `facade-ptyd-${os.userInfo().uid}`, `extension-ptyd-${protocol}-${key}.sock`);
	ensurePtydSocket(socket);
	return socket;
}

/**
 * A window's connection to ptyd: starts it where nothing listens yet - detached, run by this extension host's own binary as Node,
 * so that it outlives the window - and asks it things, each answered once, while hearing what the runs it claims do and the tool
 * calls of their shims.
 */
export class PtydClient {

	private readonly socket: net.Socket;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
	private readonly runListeners = new Map<string, Set<(event: RunEvent) => void>>();
	private readonly closeListeners = new Set<() => void>();
	private readonly ownerListeners = new Set<(owner: string) => void>();
	private readonly callListeners = new Set<(event: CallEvent, receivedAt: number) => void>();
	private closed = false;
	private closeError: PtydLost | undefined;

	private constructor(socket: net.Socket) {
		this.socket = socket;
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => {
			// When this window had the line, on its monotonic clock: a call's time here counts from then (RULES-1.2)
			const receivedAt = performance.now();
			let message: Response | RunEvent | OwnerEvent | CallEvent;
			try {
				message = JSON.parse(line);
				if (!message || typeof message !== 'object' || Array.isArray(message)) {
					return;
				}
			} catch {
				return;
			}
			if ('event' in message) {
				if (!isPtydEvent(message)) {
					return;
				}
				if (message.event === 'ownerLost') {
					for (const listener of [...this.ownerListeners]) {
						listener(message.owner);
					}
					return;
				}
				if (message.event === 'call') {
					for (const listener of [...this.callListeners]) {
						listener(message, receivedAt);
					}
					return;
				}
				for (const listener of [...this.runListeners.get(message.run) ?? []]) {
					listener(message);
				}
				return;
			}
			if (!Number.isSafeInteger(message.id) || 'error' in message && typeof message.error !== 'string') {
				return;
			}
			const waiting = this.pending.get(message.id);
			this.pending.delete(message.id);
			if ('error' in message) {
				waiting?.reject(new Error(message.error));
			} else {
				waiting?.resolve(message.result);
			}
		}, err => {
			this.closeError = new PtydLost(messageOf(err));
			socket.destroy();
		}));
		socket.on('close', () => {
			this.closed = true;
			for (const waiting of this.pending.values()) {
				waiting.reject(this.closeError ?? new PtydLost('ptyd closed the connection.'));
			}
			this.pending.clear();
			for (const listener of [...this.closeListeners]) {
				listener();
			}
		});
		socket.on('error', () => socket.destroy());
	}

	/**
	 * Connects to ptyd at `socketPath`, starting it from `script` first where nothing listens, `logFile` taking what it says. Rejects
	 * where it does not come up, or speaks another protocol - which is said, and ends nothing it holds (ARCHITECTURE-2.4).
	 */
	static async connect(socketPath: string, script: string, logFile: string, options: { readonly protocol?: number; readonly start?: boolean } = {}): Promise<PtydClient> {
		const protocol = options.protocol ?? PTYD_PROTOCOL;
		let socket = await connectTo(socketPath);
		if (!socket && options.start === false) {
			throw new Error(`Nothing listens on ${socketPath}.`);
		}
		if (!socket) {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const child = spawn(process.execPath, [script, socketPath, logFile], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
			});
			child.unref();
			const deadline = Date.now() + START_WAIT_MS;
			while (!socket && Date.now() < deadline) {
				await timeout(100);
				socket = await connectTo(socketPath);
			}
			if (!socket) {
				throw new Error(`ptyd did not start: nothing listens on ${socketPath}. See ${logFile}.`);
			}
		}
		const client = new PtydClient(socket);
		let helloTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const hello = await Promise.race([
				client.request('hello', { protocol }),
				new Promise<never>((_, reject) => {
					helloTimer = setTimeout(() => reject(new Error(`ptyd did not answer hello within ${START_WAIT_MS} ms.`)), START_WAIT_MS);
				})
			]);
			if (hello.protocol !== protocol) {
				throw new Error(`The ptyd at ${socketPath} speaks protocol ${hello.protocol}, and this window protocol ${protocol}: its runs keep running, and this window cannot show them.`);
			}
		} catch (err) {
			client.dispose();
			throw err;
		} finally {
			clearTimeout(helloTimer);
		}
		return client;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	request<M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> {
		if (this.closed || this.socket.destroyed) {
			return Promise.reject(new PtydNotSent('ptyd is not connected.'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.socket.write(JSON.stringify({ id, method, params }) + '\n', err => {
				// A write failure cannot establish how much reached the peer. Its effect must be reconciled, never replayed.
				if (err && this.pending.delete(id)) {
					reject(new PtydLost(`Could not confirm the request to ptyd: ${messageOf(err)}`));
				}
			});
		});
	}

	/** Hears what the run `run` does, while this connection claims it. */
	onRunEvent(run: string, listener: (event: RunEvent) => void): { dispose(): void } {
		let listeners = this.runListeners.get(run);
		if (!listeners) {
			this.runListeners.set(run, listeners = new Set());
		}
		listeners.add(listener);
		return {
			dispose: () => {
				listeners.delete(listener);
				if (!listeners.size) {
					this.runListeners.delete(run);
				}
			}
		};
	}

	onDidClose(listener: () => void): { dispose(): void } {
		this.closeListeners.add(listener);
		return { dispose: () => this.closeListeners.delete(listener) };
	}

	onDidLoseOwner(listener: (owner: string) => void): { dispose(): void } {
		this.ownerListeners.add(listener);
		return { dispose: () => this.ownerListeners.delete(listener) };
	}

	/**
	 * Hears the tool calls of the shims of the runs this connection claims, each to be answered with `answer` (MCP-6.1), with when its
	 * line was read on this process's monotonic clock.
	 */
	onCall(listener: (event: CallEvent, receivedAt: number) => void): { dispose(): void } {
		this.callListeners.add(listener);
		return { dispose: () => this.callListeners.delete(listener) };
	}

	dispose(): void {
		this.socket.destroy();
	}
}

/**
 * The ptyds of earlier protocols for `home` that still hold live runs of `owner`, by protocol: reported plainly, never ended
 * (ARCHITECTURE-2.4) - this window cannot speak their protocol, so it does not show them.
 */
export async function earlierRuns(home: string, owner: string): Promise<readonly { readonly protocol: number; readonly runs: number }[]> {
	const found: { protocol: number; runs: number }[] = [];
	for (let protocol = 1; protocol < PTYD_PROTOCOL; protocol++) {
		let socket: net.Socket | undefined;
		try {
			socket = await connectTo(ptydSocketPath(home, protocol));
		} catch {
			continue;
		}
		if (!socket) {
			continue;
		}
		try {
			const ask = lineRequester(socket);
			const runs = await Promise.race([
				ask('list', { owner }) as Promise<readonly RunInfo[]>,
				timeout(EARLIER_WAIT_MS).then(() => [] as RunInfo[])
			]);
			const live = Array.isArray(runs) ? runs.filter(run => !run.exited).length : 0;
			if (live) {
				found.push({ protocol, runs: live });
			}
		} catch {
			// It went meanwhile, or does not answer as any protocol did: nothing to report
		} finally {
			socket.destroy();
		}
	}
	return found;
}

/** Asks on `socket` in JSON lines, as every protocol of ptyd has: each request answered by its number. */
function lineRequester(socket: net.Socket): (method: string, params: object) => Promise<unknown> {
	let nextId = 1;
	const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
	socket.setEncoding('utf8');
	socket.on('data', lineReader(line => {
		try {
			const message = JSON.parse(line) as Response;
			const waiting = pending.get(message.id);
			pending.delete(message.id);
			if ('error' in message) {
				waiting?.reject(new Error(message.error));
			} else {
				waiting?.resolve(message.result);
			}
		} catch {
			// Not an answer: an event, or what cannot be read
		}
	}, err => socket.destroy(err)));
	socket.on('close', () => pending.forEach(waiting => waiting.reject(new Error('ptyd closed the connection.'))));
	socket.on('error', () => socket.destroy());
	return (method, params) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		socket.write(JSON.stringify({ id, method, params }) + '\n');
	});
}

/** A connection to `socketPath`, or undefined where nothing listens there. */
function connectTo(socketPath: string): Promise<net.Socket | undefined> {
	ensurePtydSocket(socketPath);
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		const fail = () => {
			socket.destroy();
			resolve(undefined);
		};
		socket.once('connect', () => {
			socket.off('error', fail);
			resolve(socket);
		});
		socket.once('error', fail);
	});
}
