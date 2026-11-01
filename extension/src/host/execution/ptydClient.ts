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
import type { OwnerClaim } from '../../base/ownership';
import { EARLIER_PROTOCOLS, CallEvent, isPtydEvent, lineReader, Method, OwnerEvent, PTYD_PROTOCOL, Requests, Response, RunEvent } from '../../ptyd/protocol';
import { ensurePtydSocket } from '../../ptyd/socket';

/** How long a window waits for a ptyd it started to listen. */
const START_WAIT_MS = 5_000;

/** How long a ptyd of an earlier protocol has to answer as a window joins it. */
const EARLIER_WAIT_MS = 2_000;
/** How often a window looks for ptyds of earlier protocols holding its runs, and lets go of those holding none any more. */
const EARLIER_CHECK_MS = 60_000;

/**
 * A request that was refused before a write was attempted: ptyd did nothing of it. Once a write is attempted, a transport error
 * cannot establish whether ptyd received and carried out the complete request.
 */
export class PtydNotSent extends Error { }

/** A request whose answer was lost as the connection to ptyd closed: ptyd may have carried it out, all of it or part. */
export class PtydLost extends Error { }

/** The ptyd of an earlier protocol holds none of the window's runs any more - it went, or they did: they ended with it. */
export class PtydGone extends Error { }

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
		return PtydClient.greeted(new PtydClient(socket), protocol, START_WAIT_MS,
			spoken => `The ptyd at ${socketPath} speaks protocol ${spoken}, and this window protocol ${protocol}: its runs keep running, and this window cannot show them.`);
	}

	/**
	 * Connects to the ptyd of the earlier protocol `protocol` at `socketPath`, which a window never starts: undefined where none is
	 * there - no such name, or on POSIX a name nothing listens on. Rejects with PtydNotSent where one may be there but took no
	 * connection in time, and where it does not answer in time, or as that protocol.
	 */
	static async join(socketPath: string, protocol: number): Promise<PtydClient | undefined> {
		const reached = await reach(socketPath, EARLIER_WAIT_MS);
		if (reached === 'none') {
			return undefined;
		}
		if (reached === 'not now') {
			throw new PtydNotSent(`The ptyd of protocol ${protocol} took no connection now.`);
		}
		return PtydClient.greeted(new PtydClient(reached), protocol, EARLIER_WAIT_MS,
			spoken => `The ptyd at ${socketPath} for protocol ${protocol} speaks protocol ${spoken}: this window does not join it.`);
	}

	/** `client` once its ptyd said it speaks `protocol`, within `ms`; disposed and rejected, as `mismatch` says, otherwise. */
	private static async greeted(client: PtydClient, protocol: number, ms: number, mismatch: (spoken: number) => string): Promise<PtydClient> {
		let helloTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const hello = await Promise.race([
				client.request('hello', { protocol }),
				new Promise<never>((_, reject) => {
					helloTimer = setTimeout(() => reject(new Error(`ptyd did not answer hello within ${ms} ms.`)), ms);
				})
			]);
			if (hello.protocol !== protocol) {
				throw new Error(mismatch(hello.protocol));
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

/** What a window hears of the ptyds of earlier protocols it joined. */
export interface EarlierEvents {
	readonly log: (line: string) => void;
	/** The connection to the ptyd of `protocol` closed unasked: its runs are not heard until it is joined again. */
	readonly lost: (protocol: number) => void;
	/** The workspace went to a newer activation there. */
	readonly ownerLost: () => void;
	/** Whether the window has requests through the ptyd of `protocol` under way - closing a run - for which it is not let go. */
	readonly busy?: (protocol: number) => boolean;
}

/**
 * This window's connections to the ptyds of earlier released protocols that hold its runs (ARCHITECTURE-2.4): each joined in its
 * own protocol and claimed with this window's claim, so that the window shows and operates their runs as its own - their cards,
 * terminals, input and closing - and an update never ends them. They are looked for as the window connects, and every minute
 * while one could not be joined; one none of whose runs of this window is left is let go. None is ever started, and one found
 * gone - nothing listening, or none of this window's runs there - is not asked again, as every connection would put off the
 * idle exit it waits for.
 */
export class EarlierPtyds {
	private readonly held = new Map<number, PtydClient>();
	/** Why a ptyd of an earlier protocol is not held, as its last search found: gone, or not joined now. */
	private readonly unheld = new Map<number, PtydGone | PtydNotSent>();
	private finding: Promise<void> | undefined;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor(private readonly home: string, private readonly claim: OwnerClaim, private readonly events: EarlierEvents) {
		this.timer = setInterval(() => void this.find().then(() => this.check()), EARLIER_CHECK_MS);
		this.timer.unref?.();
	}

	/** The ptyds of earlier protocols this window holds, each with its protocol. */
	get clients(): readonly (readonly [number, PtydClient])[] {
		return [...this.held];
	}

	/** Joins each ptyd of an earlier protocol that holds runs of this window and is not held yet: once, whatever asks again. */
	find(): Promise<void> {
		this.finding ??= this.search().finally(() => this.finding = undefined);
		return this.finding;
	}

	/**
	 * The connection to the ptyd of the earlier protocol `protocol`: held, or joined again. Rejects with PtydGone where that ptyd holds
	 * none of this window's runs any more, or nothing listens there - its runs ended with it - and with PtydNotSent where it could
	 * not be joined now, to be tried again.
	 */
	async client(protocol: number): Promise<PtydClient> {
		// A search under way may have passed it by, held then: one of its own follows
		for (let searches = 0; searches < 2 && !this.held.has(protocol) && !(this.unheld.get(protocol) instanceof PtydGone); searches++) {
			await this.find();
		}
		const client = this.held.get(protocol);
		if (!client) {
			throw this.unheld.get(protocol) ?? new PtydNotSent(`The ptyd of protocol ${protocol} is not joined now.`);
		}
		return client;
	}

	/** Lets go of each held ptyd none of whose runs of this window is left - ended and forgotten - to exit once idle. */
	async check(): Promise<void> {
		for (const [protocol, client] of [...this.held]) {
			if (this.events.busy?.(protocol)) {
				continue;
			}
			let left: number;
			try {
				left = (await within(client.request('list', { owner: this.claim.owner }))).length;
			} catch {
				// Not answering now, or gone: asked again at the next check, and a closed connection says so itself
				continue;
			}
			// Closing or forgetting a run may have started while the list was in flight.
			if (!left && this.held.get(protocol) === client && !this.events.busy?.(protocol)) {
				this.release(protocol);
				this.unheld.set(protocol, new PtydGone(`None of this window's runs is left in the ptyd of protocol ${protocol}.`));
				this.events.log(`The agents an earlier Facade Code started in a ptyd of protocol ${protocol} have ended: this window lets that ptyd go.`);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
		for (const protocol of [...this.held.keys()]) {
			this.release(protocol);
		}
	}

	private async search(): Promise<void> {
		for (const protocol of EARLIER_PROTOCOLS) {
			if (this.disposed) {
				return;
			}
			if (this.held.has(protocol) || this.unheld.get(protocol) instanceof PtydGone) {
				continue;
			}
			try {
				await this.join(protocol);
				this.unheld.delete(protocol);
			} catch (err) {
				this.unheld.set(protocol, err instanceof PtydGone ? err : new PtydNotSent(`Could not join the ptyd of protocol ${protocol}: ${messageOf(err)}`));
			}
		}
	}

	/** Joins the ptyd of `protocol` and claims this window's runs there, where it holds any. */
	private async join(protocol: number): Promise<void> {
		const client = await PtydClient.join(ptydSocketPath(this.home, protocol), protocol);
		if (!client) {
			throw new PtydGone(`Nothing listens for a ptyd of protocol ${protocol}.`);
		}
		// Heard from the start: the workspace can go to a newer activation in the same answer as the claim
		client.onDidLoseOwner(owner => {
			if (owner === this.claim.owner) {
				this.events.ownerLost();
			}
		});
		let runs: number;
		try {
			runs = (await within(client.request('list', { owner: this.claim.owner }))).length;
			if (!runs) {
				throw new PtydGone(`The ptyd of protocol ${protocol} holds no run of this window.`);
			}
			await within(client.request('claim', this.claim));
			if (this.disposed) {
				throw new PtydNotSent('The window is closing.');
			}
		} catch (err) {
			client.dispose();
			if (/ownership was transferred or expired/.test(messageOf(err))) {
				this.events.ownerLost();
			}
			throw err;
		}
		this.held.set(protocol, client);
		client.onDidClose(() => {
			if (this.held.get(protocol) === client) {
				this.held.delete(protocol);
				this.events.log(`The connection to the ptyd of protocol ${protocol} closed: its agents keep running, and this window joins it again.`);
				this.events.lost(protocol);
			}
		});
		this.events.log(`${runs} agents an earlier Facade Code started are in a ptyd of protocol ${protocol}: this window shows them and keeps them running until it closes.`);
	}

	private release(protocol: number): void {
		const client = this.held.get(protocol);
		this.held.delete(protocol);
		client?.dispose();
	}
}

/**
 * The answer to a request, or a failure where it does not come within `ms`: what a window asks of a ptyd that may hang - one of an
 * earlier protocol - never holds up its own runs.
 */
export function within<T>(answer: Promise<T>, ms = EARLIER_WAIT_MS): Promise<T> {
	return Promise.race([answer, timeout(ms).then((): never => {
		throw new Error(`ptyd did not answer within ${ms} ms.`);
	})]);
}

/**
 * A connection to `socketPath` within `ms`: 'none' where no ptyd is there - no such name, or on POSIX a name nothing listens on,
 * its ptyd gone - and 'not now' where one may be but took no connection: another failure, or one slower than `ms`, as a busy
 * Windows pipe is.
 */
function reach(socketPath: string, ms: number): Promise<net.Socket | 'none' | 'not now'> {
	ensurePtydSocket(socketPath);
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		let settled = false;
		const settle = (reached: net.Socket | 'none' | 'not now') => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(reached);
			}
		};
		const timer = setTimeout(() => {
			socket.destroy();
			settle('not now');
		}, ms);
		const failed = (err: NodeJS.ErrnoException) => {
			socket.destroy();
			settle(err.code === 'ENOENT' || (process.platform !== 'win32' && err.code === 'ECONNREFUSED') ? 'none' : 'not now');
		};
		socket.once('error', failed);
		socket.once('connect', () => {
			socket.off('error', failed);
			settle(socket);
		});
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
