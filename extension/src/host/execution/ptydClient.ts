/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { timeout } from '../../base/async';
import { messageOf } from '../../base/errors';
import type { OwnerClaim } from '../../base/ownership';
import { isPtydEvent, lineReader, Method, OwnerEvent, PTYD_PROTOCOL, Requests, Response, RunEvent, RunInfo } from '../../ptyd/protocol';
import { ensurePtydSocket } from '../../ptyd/socket';

/** How long a window waits for a ptyd it started to listen. */
const START_WAIT_MS = 5_000;

/** How long a ptyd of another protocol has to answer when a window looks for runs it still holds. */
const EARLIER_WAIT_MS = 2_000;
/** How often a held earlier ptyd is asked whether runs of this window are left in it. */
const EARLIER_CHECK_MS = 60_000;

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
 * so that it outlives the window - and asks it things, each answered once, while hearing what the runs it claims do.
 */
export class PtydClient {

	private readonly socket: net.Socket;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
	private readonly runListeners = new Map<string, Set<(event: RunEvent) => void>>();
	private readonly closeListeners = new Set<() => void>();
	private readonly ownerListeners = new Set<(owner: string) => void>();
	private closed = false;
	private closeError: PtydLost | undefined;

	private constructor(socket: net.Socket) {
		this.socket = socket;
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => {
			let message: Response | RunEvent | OwnerEvent;
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
	static async connect(socketPath: string, script: string, logFile: string): Promise<PtydClient> {
		let socket = await connectTo(socketPath);
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
				client.request('hello', { protocol: PTYD_PROTOCOL }),
				new Promise<never>((_, reject) => {
					helloTimer = setTimeout(() => reject(new Error(`ptyd did not answer hello within ${START_WAIT_MS} ms.`)), START_WAIT_MS);
				})
			]);
			if (hello.protocol !== PTYD_PROTOCOL) {
				throw new Error(`The ptyd at ${socketPath} speaks protocol ${hello.protocol}, and this window protocol ${PTYD_PROTOCOL}: its runs keep running, and this window cannot show them.`);
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

	dispose(): void {
		this.socket.destroy();
	}
}

/**
 * This window's hold on the ptyds of earlier protocols for `home` that still run its agents. It cannot show them - it does not
 * speak their protocol for that - but its claim there keeps them from ending five minutes after their window reloaded into this
 * build: an update never ends them (ARCHITECTURE-2.4). They end five minutes after this window goes, as its own do (RULES-4.1).
 * A ptyd none of whose runs of this window is left is let go, to exit once idle.
 */
export class EarlierPtyds {
	private readonly held = new Map<number, { readonly socket: net.Socket; readonly ask: Requester }>();
	private finding: Promise<void> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(private readonly home: string, private readonly claim: OwnerClaim, private readonly log: (line: string) => void) { }

	/** Finds the earlier ptyds that run this window's agents and claims them there: each held once, whatever asks again. */
	find(): Promise<void> {
		this.finding ??= this.search().finally(() => this.finding = undefined);
		return this.finding;
	}

	/** Lets go of each earlier ptyd none of whose runs of this window is left, or that went. */
	async check(): Promise<void> {
		for (const [protocol, { socket, ask }] of [...this.held]) {
			const live = await liveRunsOf(ask, this.claim.owner).catch(() => 0);
			if (!live && this.held.get(protocol)?.socket === socket) {
				this.release(protocol);
				this.log(`The agent processes an earlier Facade Code started in a ptyd of protocol ${protocol} have ended.`);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const protocol of [...this.held.keys()]) {
			this.release(protocol);
		}
	}

	private async search(): Promise<void> {
		for (let protocol = 1; protocol < PTYD_PROTOCOL && !this.disposed; protocol++) {
			if (this.held.has(protocol)) {
				continue;
			}
			const socket = await connectTo(ptydSocketPath(this.home, protocol)).catch(() => undefined);
			if (!socket) {
				continue;
			}
			const ask = lineRequester(socket);
			let live: number;
			try {
				live = await liveRunsOf(ask, this.claim.owner);
			} catch {
				// It went meanwhile, or does not answer as any protocol did: nothing to hold
				live = 0;
			}
			if (!live || this.disposed) {
				socket.destroy();
				continue;
			}
			try {
				await answerOf(ask('claim', this.claim));
			} catch (err) {
				socket.destroy();
				this.log(`${live} agent processes started by an earlier Facade Code run in a ptyd of protocol ${protocol}, which this window could not claim: ${messageOf(err)}`);
				continue;
			}
			this.held.set(protocol, { socket, ask });
			socket.on('close', () => {
				if (this.held.get(protocol)?.socket === socket) {
					this.release(protocol);
				}
			});
			this.timer ??= setInterval(() => void this.check(), EARLIER_CHECK_MS);
			this.timer.unref?.();
			this.log(`${live} agent processes started by an earlier Facade Code still run in a ptyd of protocol ${protocol}; this window cannot show them, and keeps them running until it closes.`);
		}
	}

	private release(protocol: number): void {
		this.held.get(protocol)?.socket.destroy();
		this.held.delete(protocol);
		if (!this.held.size) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

type Requester = (method: string, params: object) => Promise<unknown>;

/** How many runs of `owner` the ptyd `ask` asks has that have not ended; none where it does not answer in time. */
async function liveRunsOf(ask: Requester, owner: string): Promise<number> {
	const runs = await answerOf(ask('list', { owner }), [] as RunInfo[]);
	return Array.isArray(runs) ? (runs as readonly RunInfo[]).filter(run => !run.exited).length : 0;
}

/** The answer to a request of an earlier ptyd: `otherwise` - or a failure, where there is none - if it does not come in time. */
function answerOf<T>(answer: Promise<unknown>, otherwise?: T): Promise<unknown> {
	return Promise.race([answer, timeout(EARLIER_WAIT_MS).then(() => {
		if (otherwise === undefined) {
			throw new Error(`ptyd did not answer within ${EARLIER_WAIT_MS} ms.`);
		}
		return otherwise;
	})]);
}

/** Asks on `socket` in JSON lines, as every protocol of ptyd has: each request answered by its number. */
function lineRequester(socket: net.Socket): Requester {
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
