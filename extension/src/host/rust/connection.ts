/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This window's connection to Facade core, as an `ide` client of the daemon protocol (core/protocol/PROTOCOL.md): finds or starts the
// daemon, says `hello`, hands an older daemon over to the packaged build, and keeps every call and watch to a response or a
// `DaemonError` across the daemon's restarts and handovers.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { timeout } from '../../base/async';
import { connectWithin } from '../../base/connect';
import { messageOf } from '../../base/errors';
import { lineReader } from '../../base/lines';
import { OLDEST_PROTOCOL, PROTOCOL } from '../../base/coreProtocol';
import type { ChangedParams, EmptyResult, ErrorBody, HelloParams, HelloResult, NumbersGiven, Operation, ScreenChange, Topic, UpgradeArgs, WatchResult, WindowDescription } from '../../base/coreProtocol';
import type { Disposable } from '../../core/ports';
import { DaemonError } from './types';
import type { DaemonLink, TerminalNotificationArgs } from './types';

/** The keeper protocol versions the packaged program speaks (its oldest and newest), which `daemon.upgrade` tells the daemon (KEEPER.md). */
const KEEPER_PROTOCOL: readonly [number, number] = [1, 1];
/** How long one connection to the socket may take. */
const CONNECT_WAIT_MS = 2_000;
/** How long a `hello` may stay unanswered: a daemon takes connections only once it has recovered its agents. */
const HELLO_WAIT_MS = 10_000;
/** How long the first connection retries after Facade was started (PROTOCOL "Connect to the daemon"). */
const START_WAIT_MS = 10_000;
/** How long between two attempts to connect. */
const RETRY_MS = 500;
/** How long a call waits for the connection to come back, or for the new daemon after an `upgrading` refusal. */
const RECONNECT_WAIT_MS = 30_000;
/** How long the first connection waits for the new daemon after a handover. */
const HANDOVER_WAIT_MS = 30_000;

export interface ConnectOptions {
	/** The Facade home: where the daemon's socket is named from, and `FACADE_HOME` for the program. */
	readonly home: string;
	/** Core's `facade` program of this package. */
	readonly program: string;
	/** The package's build, its manifest's version: this build takes over a daemon of an older release. */
	readonly build: string;
	readonly window: WindowDescription;
	readonly numbersGiven: NumbersGiven;
	log(line: string): void;
}

/** The daemon's socket for `home` (PROTOCOL "Connect to the daemon"): the home's path exactly as the program was started with it. */
export function daemonSocketPath(home: string): string {
	const key = crypto.createHash('sha256').update(Buffer.from(home, 'utf8')).digest('hex').slice(0, 10);
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-core-daemon-${key}`;
	}
	return path.join('/tmp', `facade-core-${process.getuid?.() ?? os.userInfo().uid}`, `daemon-${key}.sock`);
}

/**
 * Core's `socket_dir` check, made before connecting: a socket folder that exists must be a folder (not a link) owned by this user,
 * or another user could listen there and receive the window's environment and every key typed. False where it is missing: there is no
 * socket to connect to, and the daemon makes the folder.
 */
function socketFolderIsOurs(dir: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw err;
	}
	if (!stat.isDirectory() || stat.uid !== (process.getuid?.() ?? os.userInfo().uid)) {
		throw new Error(`Facade will not connect: ${dir} is not a folder of this user.`);
	}
	return true;
}

/** Whether the daemon of build `running` hands over to build `newer`: only a higher release version does, as core decides it. */
export function takesOver(newer: string, running: string): boolean {
	const a = versionOf(newer);
	const b = versionOf(running);
	if (!a || !b) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] > b[i];
		}
	}
	return false;
}

/** The three numbers of a build such as `0.2.1+4f2a`, none unless it has exactly three. */
function versionOf(build: string): number[] | undefined {
	const parts = build.split('+', 1)[0].split('.');
	return parts.length === 3 && parts.every(part => /^\d+$/.test(part)) ? parts.map(Number) : undefined;
}

function unavailable(message: string): DaemonError {
	return new DaemonError(message, 'unavailable', { reason: 'unavailable' });
}

function errorOf(body: ErrorBody | undefined): DaemonError {
	const data = body?.data && typeof body.data.reason === 'string' ? body.data : { reason: 'internal' as const };
	return new DaemonError(body?.message ?? 'Facade core answered with an error.', data.reason, data);
}

/** Runs `facade daemon --detach` for `home`: where Facade starts, or already runs, it answers with code 0. */
function startDaemon(options: ConnectOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(options.program, ['daemon', '--detach'], { env: { ...process.env, FACADE_HOME: options.home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let output = '';
		child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
		child.once('error', err => reject(new Error(`Could not run ${options.program}: ${messageOf(err)}`)));
		child.once('close', code => {
			if (code === 0) {
				if (output.trim()) {
					options.log(output.trim());
				}
				resolve();
			} else {
				reject(new Error(output.trim() || `${options.program} daemon --detach exited with code ${code}`));
			}
		});
	});
}

/** How one attempt to reach the daemon went: connected and greeted, or why not, where the next attempt may do better. */
type Attempt = { readonly connection: Connection; readonly hello: HelloResult } | { readonly connection?: undefined; readonly absent: boolean; readonly reason: string };

/** What a response settles a request with. */
type Outcome = { readonly result: unknown; readonly error?: undefined } | { readonly error: DaemonError };

/** One socket to the daemon, with the requests waiting on it. It ends them all with an error once the socket closes. */
class Connection {
	private readonly pending = new Map<number, (outcome: Outcome) => void>();
	private nextId = 1;
	private ended = false;

	constructor(private readonly socket: net.Socket, private readonly on: {
		changed(params: ChangedParams): void;
		closing(): void;
		closed(): void;
		log(line: string): void;
	}) {
		socket.on('data', lineReader(line => this.line(line), err => {
			this.on.log(`Facade core sent a line that is too long: ${err.message}`);
			socket.destroy();
		}));
		socket.on('error', err => this.on.log(`The connection to Facade core failed: ${err.message}`));
		socket.on('close', () => {
			this.ended = true;
			const waiting = [...this.pending.values()];
			this.pending.clear();
			for (const settle of waiting) {
				settle({ error: unavailable('The connection to Facade core closed: the call may or may not have run.') });
			}
			this.on.closed();
		});
	}

	/** Sends a request and answers with its response: `settle` runs as the response is read, before any later line is. */
	send(method: string, params: object, settle: (outcome: Outcome) => void): void {
		if (this.ended) {
			settle({ error: unavailable('The connection to Facade core is closed.') });
			return;
		}
		const id = this.nextId++;
		this.pending.set(id, settle);
		this.write({ jsonrpc: '2.0', id, method, params });
	}

	ask(method: string, params: object): Promise<unknown> {
		return new Promise((resolve, reject) => this.send(method, params, outcome => outcome.error ? reject(outcome.error) : resolve(outcome.result)));
	}

	/** Sends a notification: no response comes. */
	notify(method: string, params?: object): void {
		if (!this.ended) {
			this.write({ jsonrpc: '2.0', method, params });
		}
	}

	close(): void {
		this.socket.destroy();
	}

	private write(message: object): void {
		this.socket.write(JSON.stringify(message) + '\n');
	}

	private line(line: string): void {
		let message: { id?: number | null; method?: string; params?: unknown; result?: unknown; error?: ErrorBody };
		try {
			message = JSON.parse(line);
		} catch {
			this.on.log(`Facade core sent a line that is not JSON: ${line.slice(0, 200)}`);
			return;
		}
		if (message.method === 'changed') {
			this.on.changed(message.params as ChangedParams);
		} else if (message.method === 'closing') {
			this.on.closing();
		} else if (typeof message.id === 'number') {
			const settle = this.pending.get(message.id);
			this.pending.delete(message.id);
			settle?.(message.error ? { error: errorOf(message.error) } : { result: message.result });
		} else if (message.error) {
			this.on.log(`Facade core refused a request without an ID: ${message.error.message}`);
		}
	}
}

/** A watch the window holds: it is asked again after each reconnection, until its disposable is disposed. */
interface Watching {
	readonly topic: Topic;
	readonly args: object;
	readonly on: { snapshot(snapshot: never): void; change(change: never): void };
	/** The number core gave it on the current connection. */
	number?: number;
	disposed: boolean;
}

/**
 * Connects to the daemon of `options.home`, starting Facade where none answers, and hands a daemon of an older release over to
 * `options.build`. Rejects with a `DaemonError`, or with an `Error` carrying the program's output, where core cannot start.
 */
export async function connectDaemon(options: ConnectOptions): Promise<DaemonLink> {
	const link = new Link(options);
	try {
		await link.open();
	} catch (err) {
		link.dispose();
		throw err;
	}
	return link;
}

class Link implements DaemonLink {
	readonly windowId: string;
	private window: WindowDescription;
	private connection: Connection | undefined;
	/** Counts the connections made: a call refused as `upgrading` waits for a later one. */
	private generation = 0;
	private afterClosing = false;
	private reconnecting = false;
	/** Why the link is over: disposed, or core refused it for good. */
	private lost: DaemonError | undefined;
	private readonly watching = new Set<Watching>();
	private readonly byNumber = new Map<number, Watching>();
	private readonly waiters = new Set<() => void>();
	private readonly stop = new AbortController();

	constructor(private readonly options: ConnectOptions) {
		this.windowId = options.window.id;
		this.window = options.window;
	}

	/** The first connection: starts Facade where none answers, then hands an older daemon over. */
	async open(): Promise<void> {
		const running = await this.reach({ start: true, limited: true });
		this.options.log(`Connected to Facade core ${running.build}.`);
		if (!takesOver(this.options.build, running.build)) {
			return;
		}
		const generation = this.generation;
		const upgrade: UpgradeArgs = { program: this.options.program, build: this.options.build, daemon_protocol: [OLDEST_PROTOCOL, PROTOCOL], keeper_protocol: [...KEEPER_PROTOCOL] };
		try {
			await this.call('daemon.upgrade', upgrade);
		} catch (err) {
			// An older daemon that refuses serves on, as for the `facade` commands
			this.options.log(`Facade ${this.options.build} could not take over from ${running.build}: ${messageOf(err)}`);
			return;
		}
		await this.until(() => this.connection !== undefined && this.generation > generation, HANDOVER_WAIT_MS);
	}

	async call<R>(op: Operation, args: object): Promise<R> {
		for (; ;) {
			await this.until(() => this.connection !== undefined);
			const generation = this.generation;
			try {
				return await this.connection!.ask('call', { op, args }) as R;
			} catch (err) {
				if (err instanceof DaemonError && err.reason === 'upgrading') {
					// Nothing ran: the new daemon is coming, which this connection hears of as `closing`
					await this.until(() => this.connection !== undefined && this.generation > generation);
					continue;
				}
				throw err;
			}
		}
	}

	notify<O extends keyof TerminalNotificationArgs>(op: O, args: TerminalNotificationArgs[O]): void {
		this.connection?.notify('call', { op, args });
	}

	watch<S, C>(topic: Topic, args: object, on: { snapshot(snapshot: S): void; change(change: C): void }): Disposable {
		const watching: Watching = { topic, args, on: on as Watching['on'], disposed: false };
		this.watching.add(watching);
		if (this.connection) {
			this.startWatch(this.connection, watching);
		}
		return {
			dispose: () => {
				if (watching.disposed) {
					return;
				}
				watching.disposed = true;
				this.watching.delete(watching);
				if (watching.number !== undefined) {
					this.byNumber.delete(watching.number);
					this.connection?.send('unwatch', { watch: watching.number }, () => undefined);
				}
			},
		};
	}

	async update(window: WindowDescription): Promise<void> {
		this.window = window;
		await this.call<EmptyResult>('window.update', window);
	}

	dispose(): void {
		if (this.lost) {
			return;
		}
		this.lost = unavailable('The connection to Facade core was closed.');
		this.stop.abort();
		this.connection?.close();
		this.wake();
	}

	/**
	 * Connects and says `hello` until a daemon answers, then installs the connection and asks its watches again. With `start`, a
	 * socket nothing answers on gets `facade daemon --detach` once; `limited` ends the tries after 10 seconds (the first connection's),
	 * else they go on. Answers the daemon's `hello`.
	 */
	private async reach(how: { start: boolean; limited: boolean }): Promise<HelloResult> {
		let started = false;
		let deadline = how.limited ? Date.now() + START_WAIT_MS : undefined;
		for (; ;) {
			const attempt = await this.attempt();
			if (attempt.connection) {
				this.install(attempt.connection);
				return attempt.hello;
			}
			if (this.lost) {
				throw this.lost;
			}
			if (how.start && !started && attempt.absent) {
				started = true;
				await startDaemon(this.options);
				deadline = how.limited ? Date.now() + START_WAIT_MS : undefined;
			}
			if (deadline !== undefined && Date.now() > deadline) {
				throw new Error(`Facade core did not answer within ${START_WAIT_MS / 1000} seconds: ${attempt.reason}`);
			}
			await timeout(RETRY_MS, this.stop.signal).catch(() => undefined);
		}
	}

	/** One try: a decoded refusal other than `upgrading` is thrown; anything else that fails is for the next try. */
	private async attempt(): Promise<Attempt> {
		const socket = daemonSocketPath(this.options.home);
		// On Windows this `ide` client relies on the daemon pipe's DACL alone (ARCHITECTURE-1.4,
		// PROTOCOL "Connect to the daemon"); the folder check is Unix's.
		if (process.platform !== 'win32' && !socketFolderIsOurs(path.dirname(socket))) {
			return { absent: true, reason: 'the socket folder does not exist yet' };
		}
		const reached = await connectWithin(socket, CONNECT_WAIT_MS);
		if (!reached.socket) {
			return { absent: reached.absent, reason: reached.reason };
		}
		const connection = new Connection(reached.socket, {
			changed: params => this.changed(connection, params),
			closing: () => this.closing(connection),
			closed: () => this.closed(connection),
			log: line => this.options.log(line),
		});
		const hello: HelloParams = { protocol: [OLDEST_PROTOCOL, PROTOCOL], build: this.options.build, kind: 'ide', window: this.window, numbers_given: this.options.numbersGiven };
		const timer = setTimeout(() => connection.close(), HELLO_WAIT_MS);
		try {
			return { connection, hello: await connection.ask('hello', hello) as HelloResult };
		} catch (err) {
			connection.close();
			if (err instanceof DaemonError && err.reason !== 'unavailable' && err.reason !== 'upgrading') {
				throw err;
			}
			return { absent: false, reason: messageOf(err) };
		} finally {
			clearTimeout(timer);
		}
	}

	private install(connection: Connection): void {
		this.connection = connection;
		this.afterClosing = false;
		this.generation++;
		for (const watching of this.watching) {
			this.startWatch(connection, watching);
		}
		this.wake();
	}

	private startWatch(connection: Connection, watching: Watching): void {
		connection.send('watch', { topic: watching.topic, args: watching.args }, outcome => {
			if (outcome.error) {
				this.watchRefused(watching, outcome.error);
				return;
			}
			const { watch, snapshot } = outcome.result as WatchResult;
			if (watching.disposed) {
				connection.send('unwatch', { watch }, () => undefined);
				return;
			}
			watching.number = watch;
			this.byNumber.set(watch, watching);
			this.tell(() => watching.on.snapshot(snapshot as never));
		});
	}

	private watchRefused(watching: Watching, err: DaemonError): void {
		if (watching.disposed || err.reason === 'upgrading' || this.connection === undefined) {
			// The next connection asks again
			return;
		}
		this.options.log(`Facade core refused to watch ${watching.topic}: ${err.message}`);
		this.watching.delete(watching);
		if (watching.topic === 'screen' && err.reason === 'not_found') {
			// The agent went while the window was disconnected: its screen's last change
			const gone: ScreenChange = { kind: 'removed' };
			this.tell(() => watching.on.change(gone as never));
		}
	}

	private changed(connection: Connection, params: ChangedParams): void {
		if (connection === this.connection) {
			const watching = this.byNumber.get(params.watch);
			if (watching && !watching.disposed) {
				this.tell(() => watching.on.change(params.change as never));
			}
		}
	}

	/** A newer Facade takes over: answers, sends nothing more, and connects again once the new daemon answers. */
	private closing(connection: Connection): void {
		if (connection === this.connection) {
			this.options.log('A newer Facade core is taking over.');
			this.afterClosing = true;
			connection.notify('closing');
			this.lose(connection);
			connection.close();
		}
	}

	private closed(connection: Connection): void {
		if (connection === this.connection) {
			this.options.log('The connection to Facade core closed.');
			this.lose(connection);
		}
	}

	private lose(connection: Connection): void {
		if (connection !== this.connection) {
			return;
		}
		this.connection = undefined;
		this.byNumber.clear();
		for (const watching of this.watching) {
			watching.number = undefined;
		}
		void this.reconnect();
	}

	/** Connects again for as long as the link lasts; Facade is started again only where it did not go for a newer build. */
	private async reconnect(): Promise<void> {
		if (this.reconnecting || this.lost) {
			return;
		}
		this.reconnecting = true;
		try {
			await this.reach({ start: !this.afterClosing, limited: false });
			this.options.log('Connected to Facade core again.');
		} catch (err) {
			if (!this.lost) {
				this.options.log(`Facade core cannot be reached again: ${messageOf(err)}`);
				this.lost = err instanceof DaemonError ? err : unavailable(messageOf(err));
				this.wake();
			}
		} finally {
			this.reconnecting = false;
		}
	}

	private tell(listener: () => void): void {
		try {
			listener();
		} catch (err) {
			this.options.log(`A listener of Facade core failed: ${messageOf(err)}`);
		}
	}

	/** Waits until `ready`, which the connection coming back can make true; rejects once the link is over or `ms` have passed. */
	private until(ready: () => boolean, ms = RECONNECT_WAIT_MS): Promise<void> {
		if (this.lost) {
			return Promise.reject(this.lost);
		}
		if (ready()) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const check = () => {
				if (this.lost) {
					done();
					reject(this.lost);
				} else if (ready()) {
					done();
					resolve();
				}
			};
			const timer = setTimeout(() => {
				done();
				reject(unavailable(`Facade core did not answer within ${ms / 1000} seconds.`));
			}, ms);
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(check);
			};
			this.waiters.add(check);
		});
	}

	private wake(): void {
		for (const check of [...this.waiters]) {
			check();
		}
	}
}
