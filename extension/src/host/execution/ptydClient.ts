/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { forgetPtyd, ptydBuild, ptydRecords, recordedPtyds } from '../../base/ptydRegistry';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { performance } from 'perf_hooks';
import * as os from 'os';
import * as path from 'path';
import { timeout } from '../../base/async';
import { connectWithin } from '../../base/connect';
import { messageOf } from '../../base/errors';
import { lineReader } from '../../base/lines';
import type { OwnerClaim } from '../../base/ownership';
import { EARLIER_PROTOCOLS, CallEvent, isPtydEvent, Method, OwnerEvent, PTYD_PROTOCOL, Requests, Response, RunEvent } from '../../ptyd/protocol';
import { ensurePtydSocket } from '../../ptyd/socket';

/** How long a window waits for a ptyd it started to listen, or for a busy one to take its connection. */
const START_WAIT_MS = 5_000;
/** How long one connection to a ptyd may take: a busy Windows pipe can take a while, and is tried again. */
const CONNECT_WAIT_MS = 2_000;

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
 * The socket the ptyd of `protocol` listens on for the Facade data directory `home`: one ptyd per person, directory, protocol and
 * `build`, so that a window never talks to - or ends the runs of - a ptyd it cannot speak to, and never starts a run in the ptyd of
 * another installation, whose files an update may have removed (ARCHITECTURE-2.4). Without `build`, the name builds from before
 * builds named their ptyds listen on.
 */
export function ptydSocketPath(home: string, protocol = PTYD_PROTOCOL, build?: string): string {
	const key = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
	const name = build ? `${protocol}-${build}-${key}` : `${protocol}-${key}`;
	// Short even on macOS, and private even on a shared Linux host without XDG_RUNTIME_DIR. Never listen in /tmp itself.
	const socket = process.platform === 'win32' ? `\\\\.\\pipe\\facade-extension-ptyd-${name}`
		: path.join('/tmp', `facade-ptyd-${os.userInfo().uid}`, `extension-ptyd-${name}.sock`);
	ensurePtydSocket(socket);
	return socket;
}

/** The socket of the ptyd a window of the installation whose ptyd script is `script`, of `version`, starts its runs in (ARCHITECTURE-2.4). */
export function ownPtydSocket(home: string, script: string, version = ''): string {
	return ptydSocketPath(home, PTYD_PROTOCOL, ptydBuild(script, version));
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
	/** The protocol its ptyd answered hello with. */
	speaks = 0;
	/** The build its ptyd answered hello with: none for one from before builds named their ptyds (ARCHITECTURE-2.4). */
	build: string | undefined;

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
	 * Connects to ptyd at `socketPath`, starting it from `script` first where nothing listens, `logFile` taking what it says, and
	 * `build` its installation's. Rejects where it does not come up, speaks another protocol or runs another build - which is said,
	 * and ends nothing it holds (ARCHITECTURE-2.4).
	 */
	static async connect(socketPath: string, script: string, logFile: string, options: { readonly protocol?: number; readonly start?: boolean; readonly build?: string } = {}): Promise<PtydClient> {
		const protocol = options.protocol ?? PTYD_PROTOCOL;
		const socket = await reachOrStart(socketPath, () => {
			if (options.start === false) {
				throw new Error(`Nothing listens on ${socketPath}.`);
			}
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const child = spawn(process.execPath, [script, socketPath, logFile, ...options.build ? [options.build] : []], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
			});
			child.unref();
		}, `See ${logFile}.`);
		const client = await PtydClient.greeted(new PtydClient(socket), protocol, START_WAIT_MS,
			spoken => `The ptyd at ${socketPath} speaks protocol ${spoken}, and this window protocol ${protocol}: its runs keep running, and this window cannot show them.`);
		if (options.build !== undefined && client.build !== options.build) {
			client.dispose();
			throw new Error(`The ptyd at ${socketPath} runs build ${client.build ?? 'unnamed'}, not this window's ${options.build}: this window starts no agent there.`);
		}
		return client;
	}

	/**
	 * Connects to the ptyd of the earlier protocol `protocol` at `socketPath`, which a window never starts: undefined where none is
	 * there - no such name, or on POSIX a name nothing listens on. Rejects with PtydNotSent where one may be there but took no
	 * connection in time, and where it does not answer in time, or as that protocol.
	 */
	static async join(socketPath: string, protocol: number): Promise<PtydClient | undefined> {
		ensurePtydSocket(socketPath);
		const reached = await connectWithin(socketPath, EARLIER_WAIT_MS);
		if (!reached.socket) {
			if (reached.absent) {
				return undefined;
			}
			throw new PtydNotSent(`The ptyd of protocol ${protocol} took no connection now: ${reached.reason}.`);
		}
		return PtydClient.greeted(new PtydClient(reached.socket), protocol, EARLIER_WAIT_MS,
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
			client.speaks = hello.protocol;
			client.build = typeof hello.build === 'string' ? hello.build : undefined;
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

/** What a window hears of the other ptyds it joined, each by its socket. */
export interface EarlierEvents {
	readonly log: (line: string) => void;
	/** The connection to the ptyd at `socket` closed unasked: its runs are not heard until it is joined again. */
	readonly lost: (socket: string) => void;
	/** The workspace went to a newer activation there. */
	readonly ownerLost: () => void;
	/** Whether the window has requests through the ptyd at `socket` under way - closing a run - for which it is not let go. */
	readonly busy?: (socket: string) => boolean;
	/** Each joined, as it claims this window's runs there: the window hears and answers their tool calls on it (ARCHITECTURE-2.4, MCP-6.1). */
	readonly connected?: (client: PtydClient) => void;
}

/** A ptyd other than this window's own that may hold its runs, with the protocol it speaks. */
export interface OtherPtyd {
	readonly socket: string;
	readonly protocol: number;
}

/**
 * The ptyds other than `own` that may hold runs for the Facade data directory `home` (ARCHITECTURE-2.4): each earlier protocol's,
 * and this protocol's from before builds named their ptyds, by those names; and every other build's that recorded itself, of this
 * protocol or an earlier one. A ptyd that names no build is never this build's.
 */
export function otherPtyds(home: string, own: string): readonly OtherPtyd[] {
	const found = new Map<string, number>();
	for (const protocol of [...EARLIER_PROTOCOLS, PTYD_PROTOCOL]) {
		found.set(ptydSocketPath(home, protocol), protocol);
	}
	for (const record of recordedPtyds(ptydRecords(path.join(home, 'ptyd')))) {
		if (record.protocol === PTYD_PROTOCOL || EARLIER_PROTOCOLS.includes(record.protocol)) {
			found.set(record.socket, record.protocol);
		}
	}
	found.delete(own);
	return [...found].map(([socket, protocol]) => ({ socket, protocol }));
}

/** How a log line names the ptyd at `socket`. */
function named(socket: string, protocol: number | undefined): string {
	return `the ptyd ${path.basename(socket)}${protocol === undefined ? '' : ` (protocol ${protocol})`}`;
}

/**
 * This window's connections to the ptyds other than its own that hold its runs (ARCHITECTURE-2.4) - one of an earlier protocol, or
 * of another build, an update's predecessor among them: each joined once it is found to hold any, and found again at each check
 * while one could not be joined; one none of whose runs of this window is left is let go. None is ever started, no run is ever
 * started in one, and one found gone - nothing listening, or none of this window's runs there - is not asked again, as every
 * connection would put off the idle exit it waits for.
 */
export class EarlierPtyds {
	private readonly held = new Map<string, PtydClient>();
	/** The protocol each ptyd found speaks, by its socket. */
	private readonly protocols = new Map<string, number>();
	/** Why a ptyd is not held, as its last search found: gone, or not joined now. */
	private readonly unheld = new Map<string, PtydGone | PtydNotSent>();
	private finding: Promise<void> | undefined;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor(private readonly home: string, private readonly own: string, private readonly claim: OwnerClaim, private readonly events: EarlierEvents) {
		this.timer = setInterval(() => void this.find().then(() => this.check()), EARLIER_CHECK_MS);
		this.timer.unref?.();
	}

	/** The other ptyds this window holds, each by its socket. */
	get clients(): readonly (readonly [string, PtydClient])[] {
		return [...this.held];
	}

	/** The protocol the ptyd at `socket` speaks, where it was found. */
	protocolOf(socket: string): number | undefined {
		return this.protocols.get(socket);
	}

	/** Joins each other ptyd that holds runs of this window and is not held yet: once, whatever asks again. */
	find(): Promise<void> {
		this.finding ??= this.search().finally(() => this.finding = undefined);
		return this.finding;
	}

	/**
	 * The connection to the other ptyd at `socket`: held, or joined again. Rejects with PtydGone where that ptyd holds none of this
	 * window's runs any more, or nothing listens there - its runs ended with it - and with PtydNotSent where it could not be joined
	 * now, to be tried again.
	 */
	async client(socket: string): Promise<PtydClient> {
		// A search under way may have passed it by, held then: one of its own follows
		for (let searches = 0; searches < 2 && !this.held.has(socket) && !(this.unheld.get(socket) instanceof PtydGone); searches++) {
			await this.find();
		}
		const client = this.held.get(socket);
		if (!client) {
			throw this.unheld.get(socket) ?? new PtydNotSent(`${named(socket, this.protocols.get(socket))} is not joined now.`);
		}
		return client;
	}

	/** Lets go of each held ptyd none of whose runs of this window is left - ended and forgotten - to exit once idle. */
	async check(): Promise<void> {
		for (const [socket, client] of [...this.held]) {
			if (this.events.busy?.(socket)) {
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
			if (!left && this.held.get(socket) === client && !this.events.busy?.(socket)) {
				this.release(socket);
				this.unheld.set(socket, new PtydGone(`None of this window's runs is left in ${named(socket, this.protocols.get(socket))}.`));
				this.events.log(`The agents an earlier Facade Code started in ${named(socket, this.protocols.get(socket))} have ended: this window lets that ptyd go.`);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
		for (const socket of [...this.held.keys()]) {
			this.release(socket);
		}
	}

	private async search(): Promise<void> {
		for (const { socket, protocol } of otherPtyds(this.home, this.own)) {
			if (this.disposed) {
				return;
			}
			this.protocols.set(socket, protocol);
			if (this.held.has(socket) || this.unheld.get(socket) instanceof PtydGone) {
				continue;
			}
			try {
				await this.join(socket, protocol);
				this.unheld.delete(socket);
			} catch (err) {
				this.unheld.set(socket, err instanceof PtydGone ? err : new PtydNotSent(`Could not join ${named(socket, protocol)}: ${messageOf(err)}`));
			}
		}
	}

	/** Joins the ptyd at `socket`, of `protocol`, and claims this window's runs there, where it holds any. */
	private async join(socket: string, protocol: number): Promise<void> {
		const client = await PtydClient.join(socket, protocol);
		if (!client) {
			// Its record, where it left one, outlived it
			forgetPtyd(ptydRecords(path.join(this.home, 'ptyd')), socket);
			throw new PtydGone(`Nothing listens for ${named(socket, protocol)}.`);
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
				throw new PtydGone(`${named(socket, protocol)} holds no run of this window.`);
			}
			// Its runs' tool calls come to the window that claims them, from the claim on: each is answered, an older tool protocol's
			// refused with no effect, and none waits without end (ARCHITECTURE-2.4)
			this.events.connected?.(client);
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
		this.held.set(socket, client);
		client.onDidClose(() => {
			if (this.held.get(socket) === client) {
				this.held.delete(socket);
				this.events.log(`The connection to ${named(socket, protocol)} closed: its agents keep running, and this window joins it again.`);
				this.events.lost(socket);
			}
		});
		this.events.log(`${runs} agents an earlier Facade Code started are in ${named(socket, protocol)}: this window shows them and keeps them running until it closes, and starts none there.`);
	}

	private release(socket: string): void {
		const client = this.held.get(socket);
		this.held.delete(socket);
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
 * A connection to this window's own ptyd at `socketPath`, `start`ing one only where none is there - no such name, or on POSIX a name
 * nothing listens on - then waiting for it to listen. A ptyd that is there but slow to take a connection, as a busy Windows pipe
 * can be, is waited for and never replaced: a second ptyd could take its socket and leave every run of the first one unclaimed
 * (ARCHITECTURE-2.3). Rejects with PtydNotSent where none took a connection within `waitMs` without one being found absent.
 */
export async function reachOrStart(socketPath: string, start: () => void, startHelp: string, connect = connectWithin, waitMs = START_WAIT_MS): Promise<net.Socket> {
	const deadline = Date.now() + waitMs;
	let started = false;
	for (; ;) {
		ensurePtydSocket(socketPath);
		const reached = await connect(socketPath, Math.max(100, Math.min(CONNECT_WAIT_MS, deadline - Date.now())));
		if (reached.socket) {
			return reached.socket;
		}
		if (reached.absent && !started) {
			start();
			started = true;
		}
		if (Date.now() >= deadline) {
			throw started && reached.absent ? new Error(`ptyd did not start: nothing listens on ${socketPath}. ${startHelp}`)
				: new PtydNotSent(`The ptyd at ${socketPath} took no connection within ${waitMs / 1000} seconds (${reached.reason}); no other was started.`);
		}
		await timeout(100);
	}
}
