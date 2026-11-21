/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../base/async';
import type {
	AttachResizeArgs, ChangedParams, HelloResult, ScreenChange, UpgradeArgs, V2AgentListResult, V3HelloParams,
	V3Operation, V3ScreenWatchArgs, V3Topic, WatchEndedParams, WatchResult
} from '../../base/coreProtocol';
import { messageOf } from '../../base/errors';
import type { Disposable, Event } from '../../core/ports';
import { Connection, connectDaemonSocket, errorOf, startDaemon, unavailable, type DaemonOptions } from '../rust/rpc';
import { DaemonError, type AttachListener, type OrchestratorLink, type ResizeAttach, type TerminalNotificationArgs, type WatchListener } from './types';

const PROTOCOL = 3;
const LEGACY_PROTOCOL = 2;
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

function incompatible(message: string): DaemonError {
	return new DaemonError(message, 'protocol_incompatible', { reason: 'protocol_incompatible' });
}

function verifyHello(result: unknown, protocol: number): HelloResult {
	const hello = result as HelloResult | null | undefined;
	if (hello?.protocol !== protocol) {
		throw incompatible(`Facade core did not select daemon protocol ${protocol}.`);
	}
	if (typeof hello.build !== 'string' || !hello.build.trim() ||
		typeof hello.machine_id !== 'string' || !MACHINE_ID.test(hello.machine_id)) {
		throw incompatible('Facade core did not identify its build and machine.');
	}
	return hello;
}

function isLegacyProtocol(error: unknown): boolean {
	if (!(error instanceof DaemonError) || error.reason !== 'protocol_incompatible') {
		return false;
	}
	const range = error.data.protocol?.local_protocol;
	return Array.isArray(range) && range[0] <= LEGACY_PROTOCOL && range[1] === LEGACY_PROTOCOL;
}

type Attempt =
	| { readonly kind: 'ready'; readonly connection: Connection; readonly hello: HelloResult }
	| { readonly kind: 'handover' }
	| { readonly kind: 'wait'; readonly absent?: boolean; readonly reason: string };

/** A watch the window holds: it is asked again after each reconnection, until its disposable is disposed. */
interface Watching {
	readonly request: () => { topic: V3Topic; args: object };
	readonly on: Omit<WatchListener<never, never>, 'snapshot'> & {
		snapshot(snapshot: never, resize?: ResizeAttach): void;
	};
	/** The number core gave it on the current connection. */
	number?: number;
	disposed: boolean;
}

/**
 * Starts Facade if its socket is absent and requests takeover if the daemon speaks v2.
 * Only a verified v3 connection is available to callers and watches.
 */
export async function connectOrchestrator(options: DaemonOptions): Promise<OrchestratorLink> {
	const link = new Link(options);
	try {
		await link.open();
	} catch (err) {
		link.dispose();
		throw err;
	}
	return link;
}

class Link implements OrchestratorLink {
	private machine!: string;
	private connection: Connection | undefined;
	private supportsAttach = false;
	/** Counts installed connections: a call refused as `upgrading` waits for a later one. */
	private generation = 0;
	private publishingConnection = false;
	private afterClosing = false;
	private reconnecting = false;
	/** Why the link is over: disposed, or core refused it for good. */
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

	async call<R>(op: V3Operation, args: object): Promise<R> {
		const machine = this.machine;
		let afterGeneration = 0;
		for (; ;) {
			await this.until(() => this.connected && this.generation > afterGeneration);
			if (this.machine !== machine) {
				throw unavailable('The Facade machine changed before the call could be sent.');
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
				// Nothing ran. Wait for a later connection to the same machine before sending again.
				afterGeneration = generation;
			}
		}
	}

	notify<O extends keyof TerminalNotificationArgs>(op: O, args: TerminalNotificationArgs[O]): boolean {
		return this.connection?.notify('call', { op, args }) ?? false;
	}

	watch<S, C>(topic: V3Topic, args: object, on: WatchListener<S, C>): Disposable {
		return this.addWatch(() => ({ topic, args }), on as Watching['on']);
	}

	watchAttach(args: () => V3ScreenWatchArgs, on: AttachListener): Disposable {
		return this.addWatch(() => {
			const { size, ...screen } = args();
			return this.supportsAttach
				? { topic: 'attach', args: { ...screen, ...size && { size } } }
				: { topic: 'screen', args: screen };
		}, on);
	}

	private addWatch(request: Watching['request'], on: Watching['on']): Disposable {
		const watching: Watching = { request, on, disposed: false };
		this.watching.add(watching);
		if (this.connection && !this.publishingConnection) {
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

	dispose(): void {
		this.lost ??= unavailable('The connection to Facade core was closed.');
		this.stop.abort();
		this.connection?.close();
		this.connection = undefined;
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
			} else if (attempt.kind === 'handover') {
				this.afterClosing = true;
				waitMs = HANDOVER_WAIT_MS;
				deadline = Date.now() + waitMs;
			} else if (!started && attempt.absent) {
				// The launcher waits for a live keeper and starts one if it exited without CLIs.
				started = true;
				await startDaemon(this.options);
				deadline = Date.now() + waitMs;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				const reason = attempt.kind === 'wait' ? attempt.reason : 'the socket closed during hello';
				throw unavailable(`The Orchestrator did not respond within ${waitMs / 1000} seconds: ${reason}`);
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
			let hello: HelloResult | undefined;
			try {
				hello = verifyHello(await this.hello(connection, deadline, 'ide', [PROTOCOL, PROTOCOL]), PROTOCOL);
			} catch (error) {
				if (error instanceof DaemonError && (error.reason === 'unavailable' || error.reason === 'upgrading')) {
					return { kind: 'wait', reason: error.message };
				}
				if (!isLegacyProtocol(error)) { throw error; }
			}
			if (hello !== undefined) {
				accepted = true;
				return { kind: 'ready', connection, hello };
			}
			if (this.afterClosing) {
				return { kind: 'wait', reason: 'waiting for the new Orchestrator after takeover' };
			}
			let legacy: HelloResult;
			try {
				legacy = verifyHello(await this.hello(connection, deadline, 'terminal', [LEGACY_PROTOCOL, PROTOCOL]), LEGACY_PROTOCOL);
			} catch (error) {
				if (error instanceof DaemonError && (error.reason === 'unavailable' || error.reason === 'upgrading')) {
					return { kind: 'wait', reason: error.message };
				}
				throw error;
			}
			await this.takeOverLegacy(connection, legacy.machine_id);
			return { kind: 'handover' };
		} finally {
			this.stop.signal.removeEventListener('abort', abort);
			if (!accepted) { connection.close(); }
		}
	}

	private async takeOverLegacy(connection: Connection, machineId: string): Promise<void> {
		const args: UpgradeArgs = {
			program: this.options.program,
			build: this.options.build,
			daemon_protocol: [LEGACY_PROTOCOL, PROTOCOL],
			keeper_protocol: [...KEEPER_PROTOCOL],
		};
		try {
			await connection.ask('call', { op: 'daemon.upgrade', args });
		} catch (error) {
			if (!(error instanceof DaemonError) || error.reason !== 'protocol_incompatible'
				|| !error.message.includes('the running keeper speaks')) {
				throw error;
			}
			const addresses = await this.legacyKeeperAgents(connection, machineId);
			throw addresses.length
				? new DaemonError(`${error.message}\n  tip: stop ${addresses.join(', ')} and retry the upgrade`, error.reason, error.data)
				: error;
		}
	}

	/** v2 did not include the addresses of running agents in a keeper protocol refusal. */
	private async legacyKeeperAgents(connection: Connection, machineId: string): Promise<readonly string[]> {
		try {
			const machine = `id:${machineId.replace(/-/g, '')}`;
			const listed = await connection.ask('call', { op: 'agent.list', args: { machine } }, HELLO_WAIT_MS) as V2AgentListResult;
			return listed.agents
				.filter(agent => agent.machine_id === machineId && agent.process === 'running' && !agent.guest)
				.map(agent => `${agent.agent_id}@${machineId}`);
		} catch {
			return [];
		}
	}

	private async hello(connection: Connection, deadline: number, kind: 'ide' | 'terminal', protocol: [number, number]): Promise<unknown> {
		const params: V3HelloParams = { protocol, build: this.options.build, kind, ...kind === 'ide' && { capabilities: ['attach'] } };
		return connection.ask('hello', params, Math.min(HELLO_WAIT_MS, Math.max(0, deadline - Date.now())));
	}

	private install(connection: Connection, hello: HelloResult): void {
		this.connection = connection;
		this.supportsAttach = hello.topics?.includes('attach') === true && hello.ops?.includes('attach.resize') === true;
		this.afterClosing = false;
		this.generation++;
		this.machine = hello.machine_id;
		this.options.log(`Connected to Facade core ${hello.build}.`);
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
		if (connection !== this.connection || !connection.active) {
			return;
		}
		const request = watching.request();
		connection.send('watch', request, outcome => {
			if (connection !== this.connection || !connection.active) {
				return;
			}
			if (outcome.error) {
				this.watchRefused(watching, request.topic, outcome.error);
				return;
			}
			const { watch, snapshot } = outcome.result as WatchResult;
			if (watching.disposed) {
				connection.send('unwatch', { watch }, () => undefined);
				return;
			}
			watching.number = watch;
			this.byNumber.set(watch, watching);
			const resize: ResizeAttach | undefined = request.topic === 'attach' ? capacity => {
				if (connection === this.connection && this.byNumber.get(watch) === watching) {
					const args: AttachResizeArgs = { ...capacity, watch };
					connection.notify('call', { op: 'attach.resize' satisfies V3Operation, args });
				}
			} : undefined;
			this.tell(() => watching.on.snapshot(snapshot as never, resize));
		});
	}

	private watchRefused(watching: Watching, topic: V3Topic, err: DaemonError): void {
		if (watching.disposed || err.reason === 'upgrading') {
			// The next connection asks again
			return;
		}
		this.options.log(`Facade core refused to watch ${topic}: ${err.message}`);
		this.watching.delete(watching);
		if (watching.on.ended) {
			this.tell(() => watching.on.ended?.(err));
		} else if (topic === 'screen' && err.reason === 'not_found') {
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
				reject(unavailable(`The Orchestrator did not respond within ${ms / 1000} seconds.`));
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
