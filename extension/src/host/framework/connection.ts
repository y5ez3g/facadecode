/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../base/async';
import {
	DAEMON_API_VERSIONS, type ChangedParams, type DaemonHelloParams, type DaemonHelloResult,
	type DaemonTopics, type WatchEndedParams, type WatchResult
} from '../../base/frameworkProtocol';
import { messageOf } from '../../base/errors';
import type { Disposable, Event } from '../../core/ports';
import { Connection, connectDaemonSocket, errorOf, startDaemon, unavailable, type DaemonOptions } from './rpc';
import {
	DaemonError, type AttachListener, type AttachWatchArgs, type EditorCalls, type EditorTopic,
	type FrameworkLink, type RawInputArgs, type ResizeAttach, type WatchListener
} from './types';

/** How long one connection to the socket may take. */
const CONNECT_WAIT_MS = 2_000;
/** How long a `hello` may stay unanswered: a daemon takes connections only once it has recovered its agents. */
const HELLO_WAIT_MS = 10_000;
/** How long the first connection retries after Facade Code Framework was started (PROTOCOL "Connect to the daemon"). */
const START_WAIT_MS = 10_000;
/** How long between two attempts to connect. */
const RETRY_MS = 500;
/** How long a call waits for the connection to come back, or for the new daemon after an `upgrading` refusal. */
const RECONNECT_WAIT_MS = 30_000;
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function incompatible(message: string, cause?: DaemonError): DaemonError {
	return new DaemonError(message, 'protocol_incompatible', { reason: 'protocol_incompatible' }, cause?.code, { cause });
}

function isCatalog(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function verifyHello(result: unknown, offered: readonly number[]): DaemonHelloResult {
	const hello = result as DaemonHelloResult | null | undefined;
	if (!hello || !offered.includes(hello.api_version)) {
		throw incompatible('Facade Code Framework did not select an offered daemon API version.');
	}
	if (typeof hello.build !== 'string' || !hello.build.trim() ||
		typeof hello.machine_id !== 'string' || !MACHINE_ID.test(hello.machine_id) ||
		!Number.isSafeInteger(hello.pid) || hello.pid <= 0) {
		throw incompatible('Facade Code Framework did not identify its build and machine.');
	}
	if (!Number.isSafeInteger(hello.agent_count) || hello.agent_count < 0 || !isCatalog(hello.ops) || !isCatalog(hello.topics)) {
		throw incompatible('Facade Code Framework did not provide its agent count and API catalog.');
	}
	return hello;
}

function unsupported(entry: string): DaemonError {
	return new DaemonError(`Facade Code Framework did not advertise ${entry}.`, 'unsupported', { reason: 'unsupported' });
}

type Attempt =
	| { readonly kind: 'ready'; readonly connection: Connection; readonly hello: DaemonHelloResult }
	| { readonly kind: 'wait'; readonly absent?: boolean; readonly reason: string };

interface WatchBinding {
	readonly connection: Connection;
	readonly number: number;
}

/** A watch the window holds: it is asked again after each reconnection, until its disposable is disposed. */
interface Watching {
	readonly request: () => { topic: keyof DaemonTopics; args: object };
	readonly on: Omit<WatchListener<never, never>, 'snapshot'> & {
		snapshot(snapshot: never, resize?: ResizeAttach): void;
	};
	binding?: WatchBinding;
	disposed: boolean;
}

/**
 * Starts Facade Code Framework if its socket is absent. Callers and watches use a verified daemon API v1 connection.
 */
export async function connectFramework(options: DaemonOptions): Promise<FrameworkLink> {
	const link = new Link(options);
	try {
		await link.open();
	} catch (err) {
		link.dispose();
		throw err;
	}
	return link;
}

class Link implements FrameworkLink {
	private machine!: string;
	private connection: Connection | undefined;
	private hello?: DaemonHelloResult;
	/** Counts installed connections: a call refused as `upgrading` waits for a later one. */
	private generation = 0;
	private publishingConnection = false;
	private reconnecting = false;
	/** Why the link is over: disposed, or framework refused it for good. */
	private lost: DaemonError | undefined;
	private readonly connectListeners = new Set<(machineId: string) => void>();
	private readonly watching = new Set<Watching>();
	private readonly byNumber = new Map<number, Watching>();
	private readonly waiters = new Set<() => void>();
	private readonly stop = new AbortController();

	readonly onDidConnect: Event<string> = listener => {
		this.connectListeners.add(listener);
		return { dispose: () => this.connectListeners.delete(listener) };
	};

	constructor(private readonly options: DaemonOptions) { }

	get machineId(): string {
		return this.machine;
	}

	get connected(): boolean {
		return this.connection?.active === true;
	}

	async open(): Promise<void> {
		await this.reach(START_WAIT_MS);
	}

	async call<Op extends keyof EditorCalls>(op: Op, args: EditorCalls[Op]['args']): Promise<EditorCalls[Op]['result']> {
		const machine = this.machine;
		let afterGeneration = 0;
		for (; ;) {
			await this.until(() => this.connected && this.generation > afterGeneration);
			if (this.machine !== machine) {
				throw unavailable('The Facade Code Framework machine changed before the call could be sent.');
			}
			const connection = this.connection;
			if (!connection?.active) {
				continue;
			}
			if (!this.hello?.ops.includes(op)) { throw unsupported(op); }
			const generation = this.generation;
			try {
				return await connection.ask('call', { op, args }) as EditorCalls[Op]['result'];
			} catch (err) {
				if (!(err instanceof DaemonError && err.reason === 'upgrading')) {
					throw err;
				}
				// Nothing ran. Wait for a later connection to the same machine before sending again.
				afterGeneration = generation;
			}
		}
	}

	notify(op: 'agent.type', args: RawInputArgs): boolean {
		if (!this.hello?.ops.includes(op)) { return false; }
		return this.connection?.notify('call', { op, args }) ?? false;
	}

	watch<Topic extends EditorTopic>(topic: Topic, args: DaemonTopics[Topic]['args'],
		on: WatchListener<DaemonTopics[Topic]['snapshot'], DaemonTopics[Topic]['change']>): Disposable {
		return this.addWatch(() => ({ topic, args }), on as Watching['on']);
	}

	watchAttach(args: () => AttachWatchArgs, on: AttachListener): Disposable {
		return this.addWatch(() => ({ topic: 'attach', args: args() }), on);
	}

	private addWatch(request: Watching['request'], on: Watching['on']): Disposable {
		const watching: Watching = { request, on, disposed: false };
		this.watching.add(watching);
		if (this.connection && !this.publishingConnection) {
			this.startWatch(this.connection, watching);
		}
		return {
			dispose: () => {
				if (watching.disposed) { return; }
				const binding = watching.binding;
				const live = binding && this.currentWatch(binding.connection, binding.number) === watching;
				watching.disposed = true;
				this.watching.delete(watching);
				watching.binding = undefined;
				if (binding && live) {
					this.byNumber.delete(binding.number);
					binding.connection.send('unwatch', { watch: binding.number }, () => undefined);
				}
			},
		};
	}

	dispose(): void {
		this.lost ??= unavailable('The connection to Facade Code Framework was closed.');
		this.stop.abort();
		this.connection?.close();
		this.connection = undefined;
		this.hello = undefined;
		this.byNumber.clear();
		this.watching.clear();
		this.connectListeners.clear();
		this.wake();
	}

	private async reach(waitMs = Infinity): Promise<void> {
		let started = false;
		let deadline = Date.now() + waitMs;
		while (!this.lost) {
			const attempt = await this.attempt(deadline);
			if (this.lost) {
				if (attempt.kind === 'ready') { attempt.connection.close(); }
				break;
			}
			if (attempt.kind === 'ready') {
				if (attempt.connection.active) {
					this.install(attempt.connection, attempt.hello);
					return;
				}
				attempt.connection.close();
			} else if (!started && attempt.absent) {
				// The launcher waits for a live keeper and starts one if it exited without CLIs.
				started = true;
				await startDaemon(this.options, '--detach');
				deadline = Date.now() + waitMs;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				const reason = attempt.kind === 'wait' ? attempt.reason : 'the socket closed during hello';
				throw unavailable(`Facade Code Framework did not respond within ${waitMs / 1000} seconds: ${reason}`);
			}
			await timeout(Math.min(RETRY_MS, remaining), this.stop.signal).catch(() => undefined);
		}
		throw this.lost;
	}

	private async attempt(deadline: number): Promise<Attempt> {
		const reached = await connectDaemonSocket(this.options.home, Math.min(CONNECT_WAIT_MS, Math.max(0, deadline - Date.now())));
		if (!reached.socket) {
			return { kind: 'wait', ...reached };
		}
		const connection = new Connection(reached.socket, {
			changed: params => this.changed(connection, params),
			watchEnded: params => this.watchEnded(connection, params),
			closing: () => this.closing(connection),
			closed: () => this.closed(connection),
			log: line => this.options.log(line),
		});
		const abort = () => connection.close();
		this.stop.signal.addEventListener('abort', abort, { once: true });
		let accepted = false;
		try {
			if (this.lost) { throw this.lost; }
			const params: DaemonHelloParams = { api_versions: [...DAEMON_API_VERSIONS], build: this.options.build, kind: 'ide' };
			const result = await connection.ask('hello', params, Math.min(HELLO_WAIT_MS, Math.max(0, deadline - Date.now())));
			const hello = verifyHello(result, params.api_versions);
			accepted = true;
			return { kind: 'ready', connection, hello };
		} catch (error) {
			if (error instanceof DaemonError && (error.reason === 'unavailable' || error.reason === 'upgrading')) {
				return { kind: 'wait', reason: error.message };
			}
			if (error instanceof DaemonError && error.reason === 'invalid_argument' && error.code === -32602) {
				throw incompatible('The running Facade Code Framework did not accept daemon API v1. Use compatible Facade Code Framework builds for the editor, Shell and participating SSH endpoints. ' + error.message, error);
			}
			throw error;
		} finally {
			this.stop.signal.removeEventListener('abort', abort);
			if (!accepted) { connection.close(); }
		}
	}

	private install(connection: Connection, hello: DaemonHelloResult): void {
		this.connection = connection;
		this.hello = hello;
		this.generation++;
		this.machine = hello.machine_id;
		this.options.log(`Connected to Facade Code Framework ${hello.build}.`);
		this.publishingConnection = true;
		for (const listener of [...this.connectListeners]) {
			this.tell(() => listener(this.machine));
		}
		this.publishingConnection = false;
		for (const watching of this.watching) {
			this.startWatch(connection, watching);
		}
		this.wake();
	}

	private startWatch(connection: Connection, watching: Watching): void {
		if (!this.installed(connection) || watching.disposed) { return; }
		const request = watching.request();
		if (!this.hello?.topics.includes(request.topic)) {
			this.watchRefused(watching, request.topic, unsupported(`topic ${request.topic}`));
			return;
		}
		if (request.topic === 'attach' && !this.hello.ops.includes('attach.resize')) {
			this.watchRefused(watching, request.topic, unsupported('attach.resize'));
			return;
		}
		connection.send('watch', request, outcome => {
			if (!this.installed(connection)) { return; }
			if (outcome.error) {
				this.watchRefused(watching, request.topic, outcome.error);
				return;
			}
			const result = outcome.result as WatchResult | undefined;
			if (!result || !Number.isSafeInteger(result.watch) || result.watch < 0 || this.byNumber.has(result.watch)) {
				this.watchRefused(watching, request.topic, incompatible('Facade Code Framework returned an invalid watch ID.'));
				return;
			}
			const { watch, snapshot } = result;
			if (watching.disposed || !this.watching.has(watching)) {
				connection.send('unwatch', { watch }, () => undefined);
				return;
			}
			watching.binding = { connection, number: watch };
			this.byNumber.set(watch, watching);
			const resize: ResizeAttach | undefined = request.topic === 'attach' ? capacity => {
				if (this.currentWatch(connection, watch) === watching) {
					connection.notify('call', { op: 'attach.resize', args: { ...capacity, watch } });
				}
			} : undefined;
			this.tell(() => watching.on.snapshot(snapshot as never, resize));
		});
	}

	private watchRefused(watching: Watching, topic: keyof DaemonTopics, err: DaemonError): void {
		if (!this.watching.has(watching) || err.reason === 'upgrading') {
			// The next connection asks again
			return;
		}
		this.options.log(`Facade Code Framework refused to watch ${topic}: ${err.message}`);
		this.watching.delete(watching);
		this.tell(() => watching.on.ended?.(err));
	}

	private installed(connection: Connection): boolean {
		return connection === this.connection && connection.active;
	}

	private currentWatch(connection: Connection, number: number): Watching | undefined {
		if (!this.installed(connection)) { return undefined; }
		const watching = this.byNumber.get(number);
		if (watching?.binding?.connection === connection && watching.binding.number === number && !watching.disposed) {
			return watching;
		}
		return undefined;
	}

	private changed(connection: Connection, params: ChangedParams): void {
		const watching = this.currentWatch(connection, params.watch);
		if (watching) {
			this.tell(() => watching.on.change(params.change as never));
		}
	}

	private watchEnded(connection: Connection, params: WatchEndedParams): void {
		const watching = this.currentWatch(connection, params.watch);
		if (!watching) { return; }
		this.byNumber.delete(params.watch);
		this.watching.delete(watching);
		watching.binding = undefined;
		this.tell(() => watching.on.ended?.(errorOf(params.error)));
	}

	/** A newer Facade Code Framework takes over: answers, sends nothing more, and connects again once the new daemon answers. */
	private closing(connection: Connection): void {
		if (!this.installed(connection)) { return; }
		this.options.log('A newer Facade Code Framework is taking over.');
		connection.notify('closing', {});
		connection.close();
		this.lose(connection);
	}

	private closed(connection: Connection): void {
		if (connection === this.connection) {
			this.options.log('The connection to Facade Code Framework closed.');
			this.lose(connection);
		}
	}

	private lose(connection: Connection): void {
		if (connection !== this.connection) {
			return;
		}
		this.connection = undefined;
		this.hello = undefined;
		this.byNumber.clear();
		for (const watching of this.watching) {
			watching.binding = undefined;
			this.tell(() => watching.on.disconnected?.());
		}
		void this.reconnect();
	}

	/** Connects again for as long as the link lasts. */
	private async reconnect(): Promise<void> {
		if (this.reconnecting || this.lost) {
			return;
		}
		this.reconnecting = true;
		try {
			await this.reach();
		} catch (err) {
			if (!this.lost) {
				this.options.log(`Facade Code Framework cannot be reached again: ${messageOf(err)}`);
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
			this.options.log(`A listener of Facade Code Framework failed: ${messageOf(err)}`);
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
				reject(unavailable(`Facade Code Framework did not respond within ${ms / 1000} seconds.`));
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
