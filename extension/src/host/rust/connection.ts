/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This window's connection to Facade core, as an `ide` client of the daemon protocol (core/protocol/PROTOCOL.md): finds or starts the
// daemon, says `hello`, hands an older daemon over to the packaged build, and keeps every call and watch to a response or a
// `DaemonError` across the daemon's restarts and handovers.

import { timeout } from '../../base/async';
import { messageOf } from '../../base/errors';
import type { ChangedParams, EmptyResult, HelloParams, HelloResult, NumbersGiven, Operation, ScreenChange, Topic, UpgradeArgs, WatchEndedParams, WatchResult, WindowDescription, WindowRef } from '../../base/coreProtocol';
import type { Disposable, Event } from '../../core/ports';
import { Connection, connectDaemonSocket, errorOf, startDaemon, takesOver, unavailable, type DaemonOptions } from './rpc';
import { DaemonError, type DaemonLink, type TerminalNotificationArgs, type WatchListener } from './types';

export { daemonSocketPath, connectDaemonSocket, startDaemon, takesOver } from './rpc';

/** Ordinary connections require the protocol with logical window bindings. */
const DAEMON_PROTOCOL = 2;
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
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ConnectOptions extends DaemonOptions {
	readonly window: WindowDescription;
	readonly numbersGiven: NumbersGiven;
}

function incompatible(message: string): DaemonError {
	return new DaemonError(message, 'protocol_incompatible', { reason: 'protocol_incompatible' });
}

interface BoundHello {
	readonly build: string;
	readonly window: WindowRef;
}

function verifyHello(result: unknown): BoundHello {
	const hello = result as HelloResult | null | undefined;
	if (hello?.protocol !== DAEMON_PROTOCOL) {
		throw incompatible(`Facade core did not select daemon protocol ${DAEMON_PROTOCOL}.`);
	}
	const { build, machine_id, window } = hello;
	if (typeof build !== 'string' || !build.trim()) {
		throw incompatible('Facade core did not identify its build.');
	}
	if (typeof machine_id !== 'string' || !MACHINE_ID.test(machine_id) || window?.machine_id !== machine_id ||
		typeof window.window_id !== 'string' || !window.window_id.trim() || window.window_id === 'terminal') {
		throw incompatible('Facade core did not bind this editor to a logical window on its machine.');
	}
	return { build, window: Object.freeze({ machine_id, window_id: window.window_id }) };
}

/** How one attempt to reach the daemon went: connected and greeted, or why not, where the next attempt may do better. */
type Attempt = { readonly connection: Connection; readonly hello: BoundHello } | { readonly connection?: undefined; readonly absent: boolean; readonly reason: string };

/** A watch the window holds: it is asked again after each reconnection, until its disposable is disposed. */
interface Watching {
	readonly topic: Topic;
	readonly args: object;
	readonly on: WatchListener<never, never>;
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
	private description: WindowDescription;
	/** Set before connectDaemon returns. Keep the reference across reconnects to the same logical window. */
	private binding!: WindowRef;
	private connection: Connection | undefined;
	/** Counts installed connections: a call refused as `upgrading` waits for a later one. */
	private generation = 0;
	private publishingBinding = false;
	private afterClosing = false;
	private reconnecting = false;
	/** Why the link is over: disposed, or core refused it for good. */
	private lost: DaemonError | undefined;
	private readonly bindListeners = new Set<(window: WindowRef) => void>();
	private readonly watching = new Set<Watching>();
	private readonly byNumber = new Map<number, Watching>();
	private readonly waiters = new Set<() => void>();
	private readonly stop = new AbortController();

	readonly onDidBind: Event<WindowRef> = listener => {
		this.bindListeners.add(listener);
		return { dispose: () => this.bindListeners.delete(listener) };
	};

	constructor(private readonly options: ConnectOptions) {
		this.description = options.window;
	}

	get machineId(): string {
		return this.binding.machine_id;
	}

	get window(): WindowRef {
		return this.binding;
	}

	get windowId(): string {
		return this.binding.window_id;
	}

	get connected(): boolean {
		return this.connection?.active === true;
	}

	/** The first connection: starts Facade where none answers, then hands an older daemon over. */
	async open(): Promise<void> {
		const running = await this.reach({ start: true, waitMs: START_WAIT_MS });
		this.options.log(`Connected to Facade core ${running.build}.`);
		if (!takesOver(this.options.build, running.build)) {
			return;
		}
		const generation = this.generation;
		const args: UpgradeArgs = {
			program: this.options.program,
			build: this.options.build,
			daemon_protocol: [DAEMON_PROTOCOL, DAEMON_PROTOCOL],
			keeper_protocol: [...KEEPER_PROTOCOL],
		};
		try {
			await this.call('daemon.upgrade', args);
		} catch (err) {
			// An older daemon that refuses serves on, as for the `facade` commands
			this.options.log(`Facade ${this.options.build} could not take over from ${running.build}: ${messageOf(err)}`);
			return;
		}
		await this.until(() => this.connected && this.generation > generation, HANDOVER_WAIT_MS);
	}

	async call<R>(op: Operation, args: object): Promise<R> {
		const binding = this.binding;
		let afterGeneration = 0;
		for (; ;) {
			await this.until(() => this.connected && this.generation > afterGeneration);
			if (this.binding !== binding) {
				throw unavailable('The Facade window binding changed before the call could be sent.');
			}
			const connection = this.connection;
			if (!connection?.active) {
				continue;
			}
			const generation = this.generation;
			try {
				return await connection.ask('call', { op, args }) as R;
			} catch (err) {
				if (!(err instanceof DaemonError && err.reason === 'upgrading')) {
					throw err;
				}
				// Nothing ran. Wait for a later connection to the same logical window before sending again.
				afterGeneration = generation;
			}
		}
	}

	notify<O extends keyof TerminalNotificationArgs>(op: O, args: TerminalNotificationArgs[O]): void {
		this.connection?.notify('call', { op, args });
	}

	watch<S, C>(topic: Topic, args: object, on: WatchListener<S, C>): Disposable {
		const watching: Watching = { topic, args, on: on as Watching['on'], disposed: false };
		this.watching.add(watching);
		if (this.connection && !this.publishingBinding) {
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
		this.description = window;
		await this.call<EmptyResult>('window.update', window);
	}

	dispose(): void {
		this.lost ??= unavailable('The connection to Facade core was closed.');
		this.stop.abort();
		this.connection?.close();
		this.connection = undefined;
		this.byNumber.clear();
		this.watching.clear();
		this.bindListeners.clear();
		this.wake();
	}

	/** Installs a verified v2 connection. With `start`, starts Facade once if the socket is absent. */
	private async reach(how: { start: boolean; waitMs?: number }): Promise<BoundHello> {
		let started = false;
		const waitMs = how.waitMs ?? Infinity;
		let deadline = Date.now() + waitMs;
		for (; ;) {
			if (this.lost) {
				throw this.lost;
			}
			const attempt = await this.attempt(deadline);
			if (this.lost) {
				attempt.connection?.close();
				throw this.lost;
			}
			if (attempt.connection?.active) {
				this.install(attempt.connection, attempt.hello.window);
				return attempt.hello;
			}
			attempt.connection?.close();
			if (how.start && !this.afterClosing && !started && !attempt.connection && attempt.absent) {
				started = true;
				await startDaemon(this.options);
				deadline = Date.now() + waitMs;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				const reason = attempt.connection ? 'the socket closed during hello' : attempt.reason;
				throw unavailable(`Facade core did not answer within ${waitMs / 1000} seconds: ${reason}`);
			}
			await timeout(Math.min(RETRY_MS, remaining), this.stop.signal).catch(() => undefined);
		}
	}

	private async helloV2(connection: Connection, waitMs: number): Promise<unknown> {
		const hello: HelloParams = {
			protocol: [DAEMON_PROTOCOL, DAEMON_PROTOCOL],
			build: this.options.build,
			kind: 'ide',
			window: this.description,
			numbers_given: this.options.numbersGiven,
		};
		const abort = () => connection.close();
		this.stop.signal.addEventListener('abort', abort, { once: true });
		try {
			return await connection.ask('hello', hello, waitMs);
		} finally {
			this.stop.signal.removeEventListener('abort', abort);
		}
	}

	/** Tries one v2 hello. */
	private async attempt(deadline: number): Promise<Attempt> {
		const reached = await connectDaemonSocket(this.options.home, Math.min(CONNECT_WAIT_MS, Math.max(0, deadline - Date.now())));
		if (!reached.socket) {
			return reached;
		}
		const connection = new Connection(reached.socket, {
			changed: params => this.changed(connection, params),
			watchEnded: params => this.watchEnded(connection, params),
			closing: () => this.closing(connection),
			closed: () => this.closed(connection),
			log: line => this.options.log(line),
		});
		let accepted = false;
		try {
			if (this.lost) {
				throw this.lost;
			}
			const result = await this.helloV2(connection, Math.min(HELLO_WAIT_MS, Math.max(0, deadline - Date.now())));
			const hello = verifyHello(result);
			accepted = true;
			return { connection, hello };
		} catch (err) {
			if (err instanceof DaemonError && err.reason !== 'unavailable' && err.reason !== 'upgrading') {
				throw err;
			}
			return { absent: false, reason: messageOf(err) };
		} finally {
			if (!accepted) {
				connection.close();
			}
		}
	}

	private install(connection: Connection, window: WindowRef): void {
		this.connection = connection;
		this.afterClosing = false;
		this.generation++;
		if (this.binding?.machine_id !== window.machine_id || this.binding.window_id !== window.window_id) {
			this.binding = window;
		}
		this.publishingBinding = true;
		for (const listener of [...this.bindListeners]) {
			this.tell(() => listener(this.binding));
		}
		this.publishingBinding = false;
		for (const watching of this.watching) {
			this.startWatch(connection, watching);
		}
		this.wake();
	}

	private startWatch(connection: Connection, watching: Watching): void {
		if (connection !== this.connection || !connection.active) {
			return;
		}
		connection.send('watch', { topic: watching.topic, args: watching.args }, outcome => {
			if (connection !== this.connection || !connection.active) {
				return;
			}
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
		if (watching.disposed || err.reason === 'upgrading') {
			// The next connection asks again
			return;
		}
		this.options.log(`Facade core refused to watch ${watching.topic}: ${err.message}`);
		this.watching.delete(watching);
		if (watching.on.ended) {
			this.tell(() => watching.on.ended?.(err));
		} else if (watching.topic === 'screen' && err.reason === 'not_found') {
			// The agent went while the window was disconnected: its screen's last change
			const gone: ScreenChange = { kind: 'removed' };
			this.tell(() => watching.on.change(gone as never));
		}
	}

	private changed(connection: Connection, params: ChangedParams): void {
		if (connection === this.connection && connection.active) {
			const watching = this.byNumber.get(params.watch);
			if (watching && !watching.disposed) {
				this.tell(() => watching.on.change(params.change as never));
			}
		}
	}

	private watchEnded(connection: Connection, params: WatchEndedParams): void {
		if (connection !== this.connection || !connection.active) { return; }
		const watching = this.byNumber.get(params.watch);
		if (!watching || watching.disposed) { return; }
		this.byNumber.delete(params.watch);
		this.watching.delete(watching);
		watching.number = undefined;
		this.tell(() => watching.on.ended?.(errorOf(params.error)));
	}

	/** A newer Facade takes over: answers, sends nothing more, and connects again once the new daemon answers. */
	private closing(connection: Connection): void {
		this.options.log('A newer Facade core is taking over.');
		this.afterClosing = true;
		connection.notify('closing');
		connection.close();
		this.lose(connection);
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
			this.tell(() => watching.on.disconnected?.());
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
			await this.reach({ start: !this.afterClosing });
			this.options.log('Connected to Facade core again.');
		} catch (err) {
			if (!this.lost) {
				this.options.log(`Facade core cannot be reached again: ${messageOf(err)}`);
				this.lost = err instanceof DaemonError ? err : unavailable(messageOf(err));
				this.wake();
			}
		} finally {
			this.reconnecting = false;
			if (!this.connected && !this.lost) {
				void this.reconnect();
			}
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
