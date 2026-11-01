/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window component's part of the client network (RULES-2.1, ARCHITECTURE-1.1, 2.1): it registers its window on this computer,
// listens on a private local socket, and carries requests between its own window's workspace extension and the other windows'
// components. It is an address book and a router: it owns no agent, file or process, and authenticates nobody.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { connectWithin } from '../base/connect';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { lineReader } from '../base/lines';
import { isSameStart, processStartTime, processStartTimeOfAsync } from '../base/system';
import {
	Allocation, Directory, DirectoryAgent, DirectoryWindow, isDirectoryAgent, isRouteResponse, PublishStatus, RouteRequest, RouteResponse,
	ServedRoute, WINDOW_NETWORK_PROTOCOL
} from '../base/windowNetwork';
import { ensurePtydSocket } from '../ptyd/socket';
import {
	allocateNumbers, isAlive, registeredWindow, registeredWindows, registerWindow, RegisteredWindow, removeStaleWindow, speaksOurs, unregisterWindow
} from '../record/windowRegistry';

/** How long a connection to another window's component may take before the route is unavailable. */
const CONNECT_MS = 2_000;

/** The most requests one connection carries at once, either way: none grows without bound. */
const MOST_PENDING = 512;

/** How long after a failed listen it is tried again, doubling each time up to {@link MOST_LISTEN_RETRY_MS}. */
const LISTEN_RETRY_MS = 1_000;
const MOST_LISTEN_RETRY_MS = 60_000;

/** How long another window's process start, once checked, is taken as it is. */
const START_CHECK_MS = 60_000;

export interface WindowNetworkOptions {
	/** This computer's Facade directory (ARCHITECTURE-3.1). */
	readonly home: string;
	/** The window's handover token: its address is derived from it, the token itself never shown. */
	readonly token: string;
	/** The window's name as this component sees it, until its workspace extension publishes the name it has (see `publish`). */
	readonly label: () => string;
	readonly environment: string;
	/** Serves a request another window routed to this one, through this window's workspace extension. */
	readonly serve: (request: ServedRoute) => Promise<unknown>;
	readonly log: (line: string) => void;
	/** When the process `pid`, recorded as started at `recorded`, started: the system's, or a test's. */
	readonly startOf?: (pid: number, recorded: number) => Promise<number | undefined>;
	/** How long after a failed listen it is first tried again: {@link LISTEN_RETRY_MS}, or a test's. */
	readonly retryMs?: number;
}

/**
 * What `serve` throws where no workspace extension serves its window now - it is starting or restarting, or not running there - so
 * that nothing ran: the window is unavailable, and the request had no effect.
 */
export class NotServed extends Error {
	constructor() {
		super('Facade Code in that window is not running yet - it is starting or restarting: the request had no effect.');
	}
}

/** The address of the window whose handover token is `token`: stable across its reloads, telling nothing of the token. */
export function windowAddress(token: string): string {
	return `win-${crypto.createHash('sha256').update(`facade-window:${token}`).digest('hex').slice(0, 16)}`;
}

/**
 * Where the component of `window` listens for this computer's user, in its start `incarnation`: a private socket, or a named pipe on
 * Windows. Each start has its own, as the registry names it: a start never finds its pipe held, or its socket removed, by the
 * previous start of its window shutting down late (ARCHITECTURE-2.1).
 */
export function windowSocketPath(home: string, window: string, incarnation = ''): string {
	const key = crypto.createHash('sha256').update(`${path.resolve(home)}\0${window}${incarnation ? `\0${incarnation}` : ''}`).digest('hex').slice(0, 16);
	return process.platform === 'win32' ? `\\\\.\\pipe\\facade-window-${WINDOW_NETWORK_PROTOCOL}-${key}`
		: path.join(socketFolder(), `${WINDOW_NETWORK_PROTOCOL}-${key}.sock`);
}

/** The private folder of the window components' sockets on POSIX. */
function socketFolder(): string {
	return path.join('/tmp', `facade-window-${os.userInfo().uid}`);
}

/** A window component's socket file in {@link socketFolder}, as {@link windowSocketPath} names it: one Facade may remove. */
const SOCKET_FILE = /^\d+-[0-9a-f]{16}\.sock$/;

interface Pending {
	readonly resolve: (response: RouteResponse) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** A window component that took no connection: `absent` where nothing is there to answer any more, its window gone. */
class Unreached extends Error {
	constructor(readonly absent: boolean, reason: string) {
		super(reason);
	}
}

/** One connection to another window's component, carrying this window's requests to it. */
class Peer {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	private constructor(private readonly socket: net.Socket, readonly window: string, readonly socketPath: string) {
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => this.answered(line), () => socket.destroy()));
		socket.on('close', () => {
			this.closed = true;
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.resolve({ ok: false, reason: 'window_unavailable', message: `The Facade window ${window} went before it answered: the request may have taken effect there.`, effects: 'unknown' });
				this.pending.delete(id);
			}
		});
		socket.on('error', () => socket.destroy());
	}

	static async connect(socketPath: string, window: string): Promise<Peer> {
		const reached = await connectWithin(socketPath, CONNECT_MS);
		if (!reached.socket) {
			throw new Unreached(reached.absent, reached.reason);
		}
		return new Peer(reached.socket, window, socketPath);
	}

	get isClosed(): boolean {
		return this.closed || this.socket.destroyed;
	}

	ask(from: string, request: RouteRequest): Promise<RouteResponse> {
		if (this.isClosed) {
			return Promise.resolve({ ok: false, reason: 'window_unavailable', message: `The Facade window ${this.window} is not connected: the request had no effect.`, effects: 'none' });
		}
		if (this.pending.size >= MOST_PENDING) {
			return Promise.resolve({ ok: false, reason: 'window_unavailable', message: `${MOST_PENDING} requests to the Facade window ${this.window} are under way already: this one had no effect.`, effects: 'none' });
		}
		const id = this.nextId++;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					resolve({ ok: false, reason: 'timeout', message: `The Facade window ${this.window} did not answer within ${Math.round(request.deadlineMs / 100) / 10} seconds: the request may have taken effect there.`, effects: 'unknown' });
				}
			}, Math.max(0, request.deadlineMs));
			this.pending.set(id, { resolve, timer });
			const line = JSON.stringify({ id, protocol: WINDOW_NETWORK_PROTOCOL, from, op: request.op, args: request.args, deadlineMs: request.deadlineMs }) + '\n';
			this.socket.write(line, err => {
				const waiting = err ? this.pending.get(id) : undefined;
				if (waiting) {
					this.pending.delete(id);
					clearTimeout(waiting.timer);
					resolve({ ok: false, reason: 'window_unavailable', message: `The request could not be sent to the Facade window ${this.window}: ${messageOf(err)}. Whether it reached it is not known.`, effects: 'unknown' });
				}
			});
		});
	}

	private answered(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!isJsonObject(message) || !Number.isSafeInteger(message.id)) {
			return;
		}
		const pending = this.pending.get(message.id as number);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id as number);
		clearTimeout(pending.timer);
		const { id: _id, ...response } = message;
		pending.resolve(isRouteResponse(response) ? response : { ok: false, reason: 'failed', message: `The Facade window ${this.window} answered something this window cannot read: whether the request took effect is not known.`, effects: 'unknown' });
	}

	dispose(): void {
		this.socket.destroy();
	}
}

/**
 * This window's place in the client network: registered on this computer while its component runs, listening for the requests
 * other windows route to it, and carrying its own window's requests to theirs (ARCHITECTURE-2.1).
 */
export class WindowNetwork {
	readonly window: string;
	/** This start of the window's component: its socket and its registry entry are its own (ARCHITECTURE-2.1). */
	readonly incarnation = crypto.randomUUID();
	readonly socketPath: string;
	/** Set once it listens: an entry is registered only for a socket that takes connections. */
	private server: net.Server | undefined;
	/** Why it does not listen now, where it tried and could not: tried again meanwhile. */
	private problem: string | undefined;
	private retries = 0;
	private retry: ReturnType<typeof setTimeout> | undefined;
	/** The connection to each other window's component, with the socket it was made to. */
	private readonly peers = new Map<string, { readonly socket: string; readonly peer: Promise<Peer> }>();
	/** The connections other windows' components opened to this one: closed with it, so that they connect again to its successor. */
	private readonly connections = new Set<net.Socket>();
	private agents: readonly DirectoryAgent[] = [];
	/** The window's name as its workspace extension published it. */
	private publishedLabel: string | undefined;
	/** When each other window's entry had its process start checked last. */
	private readonly startsChecked = new Map<string, number>();
	private disposed = false;

	constructor(private readonly options: WindowNetworkOptions) {
		this.window = windowAddress(options.token);
		this.socketPath = windowSocketPath(options.home, this.window, this.incarnation);
	}

	/**
	 * Listens on this window's socket and registers it; resolves once other windows can reach it. Rejects where it cannot listen now,
	 * which is tried again, later and later, until it can or the component stops: the window is registered then.
	 */
	async start(): Promise<void> {
		this.removePredecessor();
		try {
			await this.listen();
		} catch (err) {
			this.failed(err);
			throw err;
		}
	}

	/** Whether other windows can reach this one now, and why not where they cannot (ARCHITECTURE-2.1). */
	status(): PublishStatus {
		return this.server ? { listening: true } : { listening: false, ...this.problem !== undefined ? { problem: this.problem } : {} };
	}

	private async listen(): Promise<void> {
		ensurePtydSocket(this.socketPath, 'window network socket');
		if (process.platform !== 'win32') {
			fs.rmSync(this.socketPath, { force: true });
		}
		const server = net.createServer(socket => this.accepted(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		try {
			if (process.platform !== 'win32') {
				fs.chmodSync(this.socketPath, 0o600);
			}
		} catch (err) {
			server.close();
			throw err;
		}
		if (this.disposed) {
			server.close();
			this.removeSocket();
			return;
		}
		this.server = server;
		this.problem = undefined;
		this.register();
	}

	/** It could not listen: said once for each reason, and tried again later. */
	private failed(err: unknown): void {
		const problem = messageOf(err);
		if (problem !== this.problem) {
			this.options.log(`Other Facade windows cannot reach this window, which tries again: ${problem}`);
		}
		this.problem = problem;
		if (this.disposed) {
			return;
		}
		clearTimeout(this.retry);
		this.retry = setTimeout(() => void this.listen().catch(again => this.failed(again)), Math.min(MOST_LISTEN_RETRY_MS, (this.options.retryMs ?? LISTEN_RETRY_MS) * 2 ** this.retries++));
		this.retry.unref?.();
	}

	/**
	 * The previous start of this window, ended without removing its entry - its extension host stopped at once - leaves it and, on
	 * POSIX, its socket file: both go. A previous start still running ends itself, removing its own alone.
	 */
	private removePredecessor(): void {
		try {
			const previous = registeredWindow(this.options.home, this.window);
			if (previous && previous.incarnation !== this.incarnation && !isAlive(previous.pid)) {
				this.forget(previous);
			}
		} catch (err) {
			this.options.log(`Could not remove what this window's previous Facade left: ${messageOf(err)}`);
		}
	}

	/**
	 * The agents this window holds now, and its name, as its workspace extension publishes them: written for every other window to
	 * read. The name is the workspace extension's, as its tools give it: in a remote window only it has the remote's (`app [SSH:
	 * host]`), as this component's extension host is never told the name the remote gives the window.
	 */
	publish(agents: readonly DirectoryAgent[], label?: string): void {
		this.agents = agents.filter(isDirectoryAgent);
		this.publishedLabel = label ?? this.publishedLabel;
		this.register();
	}

	/** Every open Facade window on this computer that this one can reach, itself first, and those it cannot. */
	directory(): Directory {
		const windows: DirectoryWindow[] = [{ window: this.window, label: this.label(), environment: this.options.environment, agents: this.agents }];
		const unavailable: { window: string; label: string; reason: string }[] = [];
		for (const entry of this.registered()) {
			if (entry.window === this.window) {
				continue;
			}
			if (!speaksOurs(entry)) {
				unavailable.push({ window: entry.window, label: entry.label, reason: 'protocol_incompatible' });
				continue;
			}
			windows.push({ window: entry.window, label: entry.label, environment: entry.environment, agents: entry.agents });
		}
		return { self: this.window, windows, unavailable };
	}

	/** Numbers for aliases, unique on this computer (RULES-1.1, 2.2). */
	allocate(kind: 'agent' | 'message', count: number, floor?: number): Allocation {
		return allocateNumbers(this.options.home, kind, count, floor);
	}

	/** Carries `request` to its window and back, or says why it could not, and whether it may have acted there. */
	async route(request: RouteRequest): Promise<RouteResponse> {
		if (this.disposed) {
			return { ok: false, reason: 'window_unavailable', message: 'This Facade window is closing: the request had no effect.', effects: 'none' };
		}
		const entry = this.registered().find(each => each.window === request.to);
		if (!entry) {
			return { ok: false, reason: 'window_unavailable', message: `No open Facade window ${request.to} is on this computer: the request had no effect.`, effects: 'none' };
		}
		if (!speaksOurs(entry)) {
			return { ok: false, reason: 'protocol_incompatible', message: `The Facade window ${request.to} runs another version of Facade Code that speaks network protocol ${entry.protocol}, and this one ${WINDOW_NETWORK_PROTOCOL}: the request had no effect.`, effects: 'none' };
		}
		let peer: Peer;
		try {
			peer = await this.peer(entry);
		} catch (err) {
			// Nothing answers where its entry says it listens: that window went without saying so, and its entry goes (ARCHITECTURE-1.1)
			if (err instanceof Unreached && err.absent) {
				this.forget(entry);
			}
			return { ok: false, reason: 'window_unavailable', message: `The Facade window ${request.to} cannot be reached: ${messageOf(err)}. The request had no effect.`, effects: 'none' };
		}
		return peer.ask(this.window, request);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.retry);
		try {
			// Its own entry alone: a successor of this component may have registered the window already (ARCHITECTURE-2.1)
			unregisterWindow(this.options.home, this.window, this.incarnation);
		} catch (err) {
			this.options.log(`Could not remove this window's network entry: ${messageOf(err)}`);
		}
		for (const { peer } of this.peers.values()) {
			void peer.then(each => each.dispose(), () => undefined);
		}
		this.peers.clear();
		for (const socket of this.connections) {
			socket.destroy();
		}
		this.connections.clear();
		this.server?.close();
		this.removeSocket();
	}

	/**
	 * The windows registered on this computer, those whose process ended left out and removed. The process start of each other one is
	 * checked meanwhile, now and then: one whose process id another program has now went without saying so, and its entry goes
	 * (ARCHITECTURE-1.1, 2.1).
	 */
	private registered(): RegisteredWindow[] {
		const entries = registeredWindows(this.options.home);
		const now = Date.now();
		const seen = new Set<string>();
		for (const entry of entries) {
			const started = entry.started;
			if (entry.window === this.window || started === undefined) {
				continue;
			}
			const key = `${entry.window}\0${entry.incarnation ?? ''}\0${entry.pid}\0${started}`;
			seen.add(key);
			if (now - (this.startsChecked.get(key) ?? -Infinity) < START_CHECK_MS) {
				continue;
			}
			this.startsChecked.set(key, now);
			void (this.options.startOf ?? processStartTimeOfAsync)(entry.pid, started).then(start => {
				if (start !== undefined && !isSameStart(start, started) && !this.disposed) {
					this.forget(entry);
				}
			}, () => undefined);
		}
		for (const key of [...this.startsChecked.keys()]) {
			if (!seen.has(key)) {
				this.startsChecked.delete(key);
			}
		}
		return entries;
	}

	/** Removes the entry of a window found gone, where it is unchanged, and on POSIX its socket file in this computer's socket folder. */
	private forget(entry: RegisteredWindow): void {
		try {
			removeStaleWindow(this.options.home, entry);
			if (process.platform !== 'win32' && path.dirname(entry.socket) === socketFolder() && SOCKET_FILE.test(path.basename(entry.socket))
				&& registeredWindows(this.options.home).every(each => each.socket !== entry.socket) && fs.lstatSync(entry.socket, { throwIfNoEntry: false })?.isSocket()) {
				fs.rmSync(entry.socket, { force: true });
			}
		} catch (err) {
			this.options.log(`Could not remove the entry of the gone Facade window ${entry.window}: ${messageOf(err)}`);
		}
	}

	private removeSocket(): void {
		if (process.platform !== 'win32') {
			fs.rmSync(this.socketPath, { force: true });
		}
	}

	private register(): void {
		if (this.disposed || !this.server) {
			return;
		}
		const entry: RegisteredWindow = {
			protocol: WINDOW_NETWORK_PROTOCOL,
			window: this.window,
			socket: this.socketPath,
			pid: process.pid,
			...processStartTime(process.pid) !== undefined ? { started: processStartTime(process.pid) } : {},
			incarnation: this.incarnation,
			label: this.label(),
			environment: this.options.environment,
			agents: this.agents,
			updatedAt: Date.now()
		};
		try {
			registerWindow(this.options.home, entry);
		} catch (err) {
			this.options.log(`Could not register this window on the network: ${messageOf(err)}`);
		}
	}

	/** The window's name: its workspace extension's once published, this component's until then. */
	private label(): string {
		return this.publishedLabel ?? this.options.label();
	}

	/**
	 * The connection to `entry`'s component, made where there is none, the last one closed, or the window's component started again -
	 * a new start listens on a socket of its own.
	 */
	private peer(entry: RegisteredWindow): Promise<Peer> {
		const existing = this.peers.get(entry.window);
		if (!existing) {
			return this.connect(entry);
		}
		if (existing.socket !== entry.socket) {
			void existing.peer.then(peer => peer.dispose(), () => undefined);
			return this.connect(entry);
		}
		const again = () => {
			// Another request may have connected again meanwhile: its connection is shared
			const current = this.peers.get(entry.window);
			return current && current !== existing && current.socket === entry.socket ? current.peer : this.connect(entry);
		};
		return existing.peer.then(peer => peer.isClosed ? again() : peer, again);
	}

	private connect(entry: RegisteredWindow): Promise<Peer> {
		if (process.platform !== 'win32') {
			ensurePtydSocket(entry.socket, 'window network socket');
		}
		const connecting = { socket: entry.socket, peer: Peer.connect(entry.socket, entry.window) };
		this.peers.set(entry.window, connecting);
		connecting.peer.catch(() => {
			if (this.peers.get(entry.window) === connecting) {
				this.peers.delete(entry.window);
			}
		});
		return connecting.peer;
	}

	/** A connection from another window's component: each request it carries served here, its answer written back. */
	private accepted(socket: net.Socket): void {
		if (this.disposed) {
			socket.destroy();
			return;
		}
		this.connections.add(socket);
		socket.on('close', () => this.connections.delete(socket));
		socket.setEncoding('utf8');
		let serving = 0;
		const answer = (id: unknown, response: RouteResponse) => {
			if (socket.writable) {
				socket.write(JSON.stringify({ id, ...response }) + '\n');
			}
		};
		socket.on('data', lineReader(line => {
			let request: unknown;
			try {
				request = JSON.parse(line);
			} catch {
				return;
			}
			if (!isJsonObject(request) || !Number.isSafeInteger(request.id)) {
				return;
			}
			if (request.protocol !== WINDOW_NETWORK_PROTOCOL) {
				answer(request.id, { ok: false, reason: 'protocol_incompatible', message: `This Facade window speaks network protocol ${WINDOW_NETWORK_PROTOCOL}, and the request came in protocol ${String(request.protocol)}: it had no effect.`, effects: 'none' });
				return;
			}
			if (typeof request.from !== 'string' || typeof request.op !== 'string' || typeof request.deadlineMs !== 'number' || !Number.isFinite(request.deadlineMs)) {
				answer(request.id, { ok: false, reason: 'failed', message: 'The request was incomplete: it had no effect.', effects: 'none' });
				return;
			}
			if (this.disposed) {
				answer(request.id, { ok: false, reason: 'window_unavailable', message: 'This Facade window is closing: the request had no effect.', effects: 'none' });
				return;
			}
			if (serving >= MOST_PENDING) {
				answer(request.id, { ok: false, reason: 'window_unavailable', message: `${MOST_PENDING} requests are under way here already: this one had no effect.`, effects: 'none' });
				return;
			}
			serving++;
			const served: ServedRoute = { from: request.from, op: request.op, args: request.args, deadlineMs: request.deadlineMs };
			void this.options.serve(served).then(
				result => answer(request.id, { ok: true, result }),
				err => answer(request.id, err instanceof NotServed ? { ok: false, reason: 'window_unavailable', message: err.message, effects: 'none' }
					: { ok: false, reason: 'failed', message: messageOf(err), effects: 'unknown' })
			).finally(() => serving--);
		}, () => socket.destroy()));
		socket.on('error', () => socket.destroy());
	}
}
