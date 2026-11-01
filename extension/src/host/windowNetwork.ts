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
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { lineReader } from '../base/lines';
import {
	Allocation, Directory, DirectoryAgent, DirectoryWindow, isDirectoryAgent, isRouteResponse, RouteRequest, RouteResponse, ServedRoute,
	WINDOW_NETWORK_PROTOCOL
} from '../base/windowNetwork';
import { ensurePtydSocket } from '../ptyd/socket';
import { allocateNumbers, registeredWindows, registerWindow, RegisteredWindow, speaksOurs, unregisterWindow } from '../record/windowRegistry';

/** How long a connection to another window's component may take before the route is unavailable. */
const CONNECT_MS = 2_000;

/** The most requests one connection carries at once, either way: none grows without bound. */
const MOST_PENDING = 512;

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

/** Where the component of `window` listens for this computer's user: a private socket, or a named pipe on Windows. */
export function windowSocketPath(home: string, window: string): string {
	const key = crypto.createHash('sha256').update(`${path.resolve(home)}\0${window}`).digest('hex').slice(0, 16);
	return process.platform === 'win32' ? `\\\\.\\pipe\\facade-window-${WINDOW_NETWORK_PROTOCOL}-${key}`
		: path.join('/tmp', `facade-window-${os.userInfo().uid}`, `${WINDOW_NETWORK_PROTOCOL}-${key}.sock`);
}

interface Pending {
	readonly resolve: (response: RouteResponse) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** One connection to another window's component, carrying this window's requests to it. */
class Peer {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	private constructor(private readonly socket: net.Socket, readonly window: string) {
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

	static connect(socketPath: string, window: string): Promise<Peer> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`no answer within ${CONNECT_MS / 1000} seconds`));
			}, CONNECT_MS);
			socket.once('connect', () => {
				clearTimeout(timer);
				resolve(new Peer(socket, window));
			});
			socket.once('error', err => {
				clearTimeout(timer);
				reject(err);
			});
		});
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
	private readonly socketPath: string;
	private server: net.Server | undefined;
	private readonly peers = new Map<string, Promise<Peer>>();
	/** The connections other windows' components opened to this one: closed with it, so that they connect again to its successor. */
	private readonly connections = new Set<net.Socket>();
	private agents: readonly DirectoryAgent[] = [];
	/** The window's name as its workspace extension published it. */
	private publishedLabel: string | undefined;
	private disposed = false;

	constructor(private readonly options: WindowNetworkOptions) {
		this.window = windowAddress(options.token);
		this.socketPath = windowSocketPath(options.home, this.window);
	}

	/** Listens on this window's socket and registers it; resolves once other windows can reach it. */
	async start(): Promise<void> {
		ensurePtydSocket(this.socketPath, 'window network socket');
		if (process.platform !== 'win32') {
			fs.rmSync(this.socketPath, { force: true });
		}
		const server = this.server = net.createServer(socket => this.accepted(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		if (process.platform !== 'win32') {
			fs.chmodSync(this.socketPath, 0o600);
		}
		this.register();
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
		for (const entry of registeredWindows(this.options.home)) {
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
		const entry = registeredWindows(this.options.home).find(each => each.window === request.to);
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
			return { ok: false, reason: 'window_unavailable', message: `The Facade window ${request.to} cannot be reached: ${messageOf(err)}. The request had no effect.`, effects: 'none' };
		}
		return peer.ask(this.window, request);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		try {
			unregisterWindow(this.options.home, this.window);
		} catch (err) {
			this.options.log(`Could not remove this window's network entry: ${messageOf(err)}`);
		}
		for (const peer of this.peers.values()) {
			void peer.then(each => each.dispose(), () => undefined);
		}
		this.peers.clear();
		for (const socket of this.connections) {
			socket.destroy();
		}
		this.connections.clear();
		this.server?.close();
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

	/** The connection to `entry`'s component, made where there is none or the last one closed. */
	private peer(entry: RegisteredWindow): Promise<Peer> {
		const existing = this.peers.get(entry.window);
		if (existing) {
			return existing.then(peer => peer.isClosed ? this.connect(entry) : peer, () => this.connect(entry));
		}
		return this.connect(entry);
	}

	private connect(entry: RegisteredWindow): Promise<Peer> {
		if (process.platform !== 'win32') {
			ensurePtydSocket(entry.socket, 'window network socket');
		}
		const connecting = Peer.connect(entry.socket, entry.window);
		this.peers.set(entry.window, connecting);
		connecting.catch(() => {
			if (this.peers.get(entry.window) === connecting) {
				this.peers.delete(entry.window);
			}
		});
		return connecting;
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
