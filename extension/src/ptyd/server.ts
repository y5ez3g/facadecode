/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { createHash } from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { codeOf, messageOf } from '../base/errors';
import { lineReader } from '../base/lines';
import { isAgentKey } from './keys';
import { CallEvent, CallRefusal, Method, OwnerEvent, PTYD_PROTOCOL, Request, Requests, Response, RunEvent, RunInfo, ShimCall } from './protocol';
import { OwnerClaims, type OwnerClock } from './ownership';
import { MOST_RUN_BUFFER, Run, RunListener } from './run';
import { ensurePtydSocket } from './socket';

/** How long ptyd stays up with no live run and no window: a window opening next starts it again. */
const IDLE_EXIT_MS = 5 * 60_000;

/** How long a ptyd that took the lock has to answer on the socket before another takes the lock over. */
const LOCK_STALE_MS = 10_000;

/** How much output may wait for one window, all its runs together, before they are paused (ARCHITECTURE-2.4). */
export const MOST_WINDOW_BUFFER = 32 * 1024 * 1024;

/** Effect receipts retain at most one MiB; screen/list replies are never retained in the duplicate-request cache. */
const MOST_RECEIPT_BYTES = 1024 * 1024;

/** How long a shim's call waits for a window to claim its run - one reloading, say - counted from the shim's ingress (RULES-1.2). */
export const CLAIM_WAIT_MS = 2_000;

/** The most tool calls of one run under way at once, waiting for a window or for its answer: none grows without bound. */
export const MOST_RUN_CALLS = 256;

/** The requests a run's shim may make: it never claims, starts or types into a run. */
const SHIM_METHODS: ReadonlySet<Method> = new Set<Method>(['hello', 'call']);

/** Requests whose answer is the run's current state: never kept in the duplicate-request cache, where a repeat would read it stale. */
const UNCACHED: ReadonlySet<Method> = new Set<Method>(['attach', 'list', 'conversations', 'hello', 'read', 'inspect', 'call']);

/** What a request's handling answers where it wrote its response itself: a shim's call, or an attach the calls waiting follow. */
const RESPONDED = Symbol('responded');

/** A call ptyd answers without a window's answer: why, and whether it may have acted. */
class CallRefused extends Error {
	constructor(readonly reason: CallRefusal, readonly effects: 'none' | 'unknown', message: string, readonly close = false) {
		super(message);
	}
}

/**
 * One window's connection: what it is sent, and the output of each run it claims that waits to be flushed to it. A run with more
 * than {@link MOST_RUN_BUFFER} waiting, or a window with more than {@link MOST_WINDOW_BUFFER}, is paused until the window catches
 * up: ordinary backpressure, the CLIs waiting, the screen usable (ARCHITECTURE-2.4).
 */
class Connection {

	/** A window's, unless it said hello as a run's shim. */
	role: 'window' | 'shim' = 'window';
	/** The run a shim said hello for. */
	shimRun: string | undefined;
	private waiting = 0;
	private readonly waitingByRun = new Map<Run, number>();
	private readonly requests = new Map<number, { readonly body: string; readonly result: Promise<unknown>; bytes: number }>();
	private receiptBytes = 0;
	private lastRequest = 0;

	constructor(readonly socket: net.Socket) { }

	get closed(): boolean {
		return this.socket.destroyed;
	}

	send(message: Response | RunEvent | OwnerEvent | CallEvent): void {
		if (this.socket.writable) {
			this.socket.write(JSON.stringify(message) + '\n');
		}
	}

	/** Sends `message`, settling once it was written to the socket: rejected where it could not be, its reader gone. */
	deliver(message: Response): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.socket.writable) {
				reject(new Error('its connection closed'));
				return;
			}
			this.socket.write(JSON.stringify(message) + '\n', err => err ? reject(err) : resolve());
		});
	}

	/** A repeated transport request never repeats its effects; old IDs beyond the response cache are refused. */
	request(request: Request, handle: () => Promise<unknown>): Promise<unknown> {
		const body = createHash('sha256').update(JSON.stringify([request.method, request.params])).digest('hex');
		const previous = this.requests.get(request.id);
		if (previous) {
			return previous.body === body ? previous.result : Promise.reject(new Error('Request ID reused with different arguments.'));
		}
		if (!Number.isSafeInteger(request.id) || request.id <= this.lastRequest) {
			return Promise.reject(new Error('Request ID is no longer available; effects were not repeated.'));
		}
		this.lastRequest = request.id;
		const result = handle();
		if (UNCACHED.has(request.method)) {
			return result;
		}
		const receipt = { body, result, bytes: 0 };
		this.requests.set(request.id, receipt);
		if (this.requests.size > 256) {
			this.evictReceipt();
		}
		const account = (value: unknown) => {
			if (this.requests.get(request.id) !== receipt) {
				return;
			}
			receipt.bytes = body.length + Buffer.byteLength(JSON.stringify(value) ?? '');
			this.receiptBytes += receipt.bytes;
			while (this.receiptBytes > MOST_RECEIPT_BYTES && this.requests.size) {
				this.evictReceipt();
			}
		};
		void result.then(account, err => account(messageOf(err)));
		return result;
	}

	private evictReceipt(): void {
		const oldest = this.requests.keys().next().value;
		if (oldest !== undefined) {
			this.receiptBytes -= this.requests.get(oldest)!.bytes;
			this.requests.delete(oldest);
		}
	}

	/** Sends `run`'s output, counting it until it is flushed. */
	output(run: Run, message: RunEvent, claimed: () => Iterable<Run>): void {
		if (this.socket.destroyed) {
			return;
		}
		const line = JSON.stringify(message) + '\n';
		const size = Buffer.byteLength(line, 'utf8');
		this.waiting += size;
		const forRun = (this.waitingByRun.get(run) ?? 0) + size;
		this.waitingByRun.set(run, forRun);
		this.socket.write(line, () => {
			this.waiting -= size;
			const left = (this.waitingByRun.get(run) ?? size) - size;
			if (left > 0) {
				this.waitingByRun.set(run, left);
			} else {
				this.waitingByRun.delete(run);
			}
			if (this.waiting <= MOST_WINDOW_BUFFER / 2) {
				for (const each of claimed()) {
					if ((this.waitingByRun.get(each) ?? 0) <= MOST_RUN_BUFFER / 2) {
						each.release(this);
					}
				}
			}
		});
		if (forRun > MOST_RUN_BUFFER) {
			run.hold(this);
		}
		if (this.waiting > MOST_WINDOW_BUFFER) {
			for (const each of claimed()) {
				each.hold(this);
			}
		}
	}

	/** Lets every run it held go: it closed, or it no longer claims them. */
	releaseAll(runs: Iterable<Run>): void {
		for (const run of runs) {
			run.release(this);
		}
	}
}

/** A shim's call under way: waiting for a window to claim its run, or given to one and waiting for its answer. */
interface PendingCall {
	/** ptyd's number for it, by which the window answers. */
	readonly id: number;
	readonly run: string;
	readonly shim: Connection;
	/** The shim's number for its request, by which ptyd answers it. */
	readonly request: number;
	readonly call: ShimCall;
	/** When ptyd read it, on its own monotonic clock: never compared with another process's (ARCHITECTURE-2.3). */
	readonly receivedAt: number;
	/** The window it was given to; none while it waits for one. */
	window?: Connection;
	/** Whether it is a query, which has its route deadline for a window's answer, waiting for a claim as well (MCP-1.3). */
	readonly query: boolean;
	/** Its one deadline: a call's two seconds for a window to claim its run, a query's route deadline for its answer. */
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * ptyd: holds the agents' processes for every window of the person's in this execution environment, on one socket per protocol
 * (ARCHITECTURE-2.3). A window starts runs and claims them; a run goes on as its window reloads or disconnects, and another
 * newer activation of its workspace can take ownership immediately. Effects are fenced to that owner; its disconnection starts
 * the explicit five-minute cleanup policy. Neither a former owner's disconnection nor an upgrade ends a successor's runs. A run's
 * MCP shim connects as well: each of its tool calls goes to the window that claims the run, and that window's answer back to it
 * (MCP-6.1).
 */
export class PtydServer {

	private readonly runs = new Map<string, Run>();
	/** Every run ID ptyd started, kept so that none is started twice (RULES-2.2). */
	private readonly seen = new Set<string>();
	private readonly claims = new Map<Run, Connection>();
	private readonly connections = new Set<Connection>();
	private server: net.Server | undefined;
	/** The socket this ptyd made at its path, on Unix: the one it may remove as it closes, never one another ptyd made there later. */
	private made: Identity | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly owners: OwnerClaims<Connection>;
	private closing = false;
	/** Each run's connected shims: a window that comes to claim the run is told its tools are there. */
	private readonly shims = new Map<string, Set<Connection>>();
	private readonly calls = new Map<number, PendingCall>();
	/** Runs claimed by an attach not answered yet: their calls wait, for the window to know the run is its first (RULES-4.1). */
	private readonly attaching = new Set<Run>();
	private nextCall = 1;

	/** `speaks` is the protocol it answers hello with: its own, or for a test the earlier one it stands for. */
	constructor(private readonly socketPath: string, private readonly log: (message: string) => void = () => undefined, clock?: OwnerClock, private readonly speaks = PTYD_PROTOCOL) {
		this.owners = new OwnerClaims((owner, previous) => {
			for (const run of this.claimedBy(previous).filter(run => run.params.owner === owner)) {
				this.claims.delete(run);
				run.listen(undefined);
				previous.releaseAll([run]);
			}
			previous.send({ event: 'ownerLost', owner });
			this.log(`Workspace ${owner} transferred to a newer activation.`);
		}, owner => this.endOwner(owner, 3_000, 'its owner connection was absent for five minutes'), clock);
	}

	/**
	 * Listens on the socket; resolves false where another ptyd answers there already - it serves the windows, and this one goes - or
	 * may: one too busy to answer at once still holds its runs, and only a socket proven gone, refused or absent, is taken over: a
	 * ptyd that died.
	 */
	async listen(): Promise<boolean> {
		ensurePtydSocket(this.socketPath);
		// Two windows opening at once may each start a ptyd: the one that takes the lock listens, and the other goes
		if (await probe(this.socketPath) !== 'gone' || !takeLock(this.lockPath)) {
			return false;
		}
		if (process.platform !== 'win32') {
			fs.rmSync(this.socketPath, { force: true });
		}
		const server = this.server = net.createServer(socket => this.connected(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		if (process.platform !== 'win32') {
			fs.chmodSync(this.socketPath, 0o600);
			this.made = identityOf(this.socketPath);
		}
		this.scheduleIdleExit();
		return true;
	}

	private get lockPath(): string {
		return process.platform === 'win32' ? path.join(os.tmpdir(), `${path.basename(this.socketPath)}.lock`) : `${this.socketPath}.lock`;
	}

	close(): void {
		this.closing = true;
		clearTimeout(this.idleTimer);
		this.owners.dispose();
		releaseLock(this.lockPath);
		for (const pending of this.calls.values()) {
			clearTimeout(pending.timer);
		}
		this.calls.clear();
		for (const run of this.runs.values()) {
			run.dispose();
		}
		this.runs.clear();
		for (const connection of this.connections) {
			connection.socket.destroy();
		}
		// Closing a Unix socket's server removes whatever is at its path by then: a socket another ptyd made there, once this one's
		// was taken for gone, is never removed - the server is let go of with the process instead
		if (process.platform === 'win32' || (this.made && sameIdentity(identityOf(this.socketPath), this.made))) {
			this.server?.close();
		} else {
			this.server?.unref();
		}
	}

	private connected(socket: net.Socket): void {
		const connection = new Connection(socket);
		this.connections.add(connection);
		clearTimeout(this.idleTimer);
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => {
			// When ptyd read it: a shim's call adds the time it spends here to how long it has been under way (RULES-1.2)
			const receivedAt = performance.now();
			let request: Request;
			try {
				request = JSON.parse(line);
				if (!request || typeof request !== 'object' || !Number.isSafeInteger(request.id) ||
					typeof request.method !== 'string' || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
					return;
				}
			} catch {
				return;
			}
			connection.request(request, () => this.handle(request, connection, receivedAt)).then(
				result => {
					if (result !== RESPONDED) {
						connection.send({ id: request.id, result });
					}
				},
				err => {
					const refused = err instanceof CallRefused ? err : undefined;
					connection.send({ id: request.id, error: messageOf(err), ...refused ? { reason: refused.reason, effects: refused.effects } : {} });
					if (refused?.close) {
						connection.socket.end();
					}
				}
			);
		}, err => socket.destroy(err)));
		socket.on('close', () => {
			this.connections.delete(connection);
			// Its runs go on, unclaimed, for its window to claim again after a reload (RULES-4.1)
			const released = this.claimedBy(connection);
			for (const run of released) {
				this.claims.delete(run);
				run.listen(undefined);
			}
			connection.releaseAll(this.runs.values());
			this.callsClosed(connection);
			if (!this.closing) {
				this.owners.disconnect(connection);
				this.scheduleIdleExit();
			}
		});
		socket.on('error', () => socket.destroy());
	}

	/** The runs `connection` claims. */
	private claimedBy(connection: Connection): Run[] {
		return [...this.claims].filter(([, claimant]) => claimant === connection).map(([run]) => run);
	}

	/** Whether a connected window other than `connection` claims `run`. */
	private claimedElsewhere(run: Run, connection: Connection): boolean {
		const claimant = this.claims.get(run);
		return !!claimant && claimant !== connection && !claimant.closed;
	}

	private info(run: Run, connection: Connection): RunInfo {
		return run.info(this.claimedElsewhere(run, connection));
	}

	/**
	 * `connection` claims `run`: it alone is told what the run does from now on - that its shim is connected, where it is. The calls
	 * that waited for a window go to it once it was answered the claim (`forwardWaiting`).
	 */
	private claim(run: Run, connection: Connection): void {
		const previous = this.claims.get(run);
		if (previous && previous !== connection) {
			previous.releaseAll([run]);
		}
		this.claims.set(run, connection);
		const listener: RunListener = {
			output: (seq, data) => connection.output(run, { event: 'output', run: run.id, seq, data }, () => this.claimedBy(connection)),
			title: title => connection.send({ event: 'title', run: run.id, title }),
			status: status => connection.send({ event: 'status', run: run.id, ...(status ? { status } : {}) }),
			exit: exit => connection.send({ event: 'exit', run: run.id, ...exit })
		};
		run.listen(listener);
		if (previous !== connection && this.shims.get(run.id)?.size) {
			connection.send({ event: 'tools', run: run.id });
		}
	}

	/** Gives the calls of `run` that wait for a window to `connection`, which claims it. */
	private forwardWaiting(run: Run, connection: Connection): void {
		for (const pending of [...this.calls.values()]) {
			if (pending.run === run.id && !pending.window && this.claims.get(run) === connection && !connection.closed) {
				this.forward(pending, connection);
			}
		}
	}

	private async handle(request: Request, connection: Connection, receivedAt: number): Promise<unknown> {
		const params = request.params as Requests[Method]['params'];
		const runOf = (id: string) => {
			const run = this.runs.get(id);
			if (!run) {
				throw new Error(`No run ${id}.`);
			}
			this.owners.assert(run.params.owner, connection);
			return run;
		};
		if (connection.role === 'shim' && !SHIM_METHODS.has(request.method)) {
			throw new Error(`A run's MCP shim does not ${String(request.method)}.`);
		}
		switch (request.method) {
			case 'hello': {
				const { protocol, role, run } = params as Requests['hello']['params'];
				if (role === 'shim') {
					if (protocol !== this.speaks) {
						throw new CallRefused('protocol_incompatible', 'none', `This agent's Facade MCP server speaks protocol ${protocol}, and its agent runtime (ptyd) protocol ${this.speaks}: no tool call can be carried.`, true);
					}
					this.shimConnected(connection, typeof run === 'string' ? run : '');
				}
				return { protocol: this.speaks, pid: process.pid };
			}
			case 'call':
				this.call(params as Requests['call']['params'], connection, receivedAt, request.id);
				return RESPONDED;
			case 'answer': {
				const { id, answer } = params as Requests['answer']['params'];
				const pending = this.calls.get(id);
				if (!pending || pending.window !== connection) {
					throw new Error(`No call ${id} waits for this window's answer.`);
				}
				this.settle(pending);
				// Answered once the shim has it: the window then knows its answer was handed back (MCP-4.2)
				try {
					await pending.shim.deliver({ id: pending.request, result: answer });
				} catch (err) {
					throw new Error(`The MCP shim of ${pending.run} went before call ${id}'s answer was handed back: ${messageOf(err)}.`);
				}
				return undefined;
			}
			case 'claim':
				this.owners.claim(params as Requests['claim']['params'], connection);
				return undefined;
			case 'conversations':
				return [...this.runs.values()].flatMap(run => {
					const meta = run.meta;
					return !run.removed && !run.info(false).exited && typeof meta.sessionId === 'string' && typeof meta.cli === 'string' && typeof meta.environment === 'string'
						? [{ environment: meta.environment, cli: meta.cli, sessionId: meta.sessionId }] : [];
				});
			case 'spawn': {
				const spawn = params as Requests['spawn']['params'];
				this.owners.assert(spawn.owner, connection);
				if (typeof spawn.run !== 'string' || !spawn.run || this.seen.has(spawn.run)) {
					throw new Error(`Run ${JSON.stringify(spawn.run)} was started before: ptyd never starts a run ID twice.`);
				}
				if (typeof spawn.meta.sessionId === 'string' && [...this.runs.values()].some(run => !run.removed && !run.info(false).exited
					&& run.meta.sessionId === spawn.meta.sessionId && run.meta.cli === spawn.meta.cli && run.meta.environment === spawn.meta.environment)) {
					throw new Error('This conversation is already running in Facade.');
				}
				this.seen.add(spawn.run);
				const run = new Run(spawn);
				// Claimed before its program starts: its window hears everything it writes from the first byte on
				this.runs.set(run.id, run);
				this.claim(run, connection);
				run.onExit(exit => {
					this.log(`Run ${run.id} ended: code ${exit.exitCode}${exit.signal ? `, signal ${exit.signal}` : ''}.`);
					if (run.removed) {
						this.drop(run);
					}
					this.scheduleIdleExit();
				});
				try {
					await run.started();
				} catch (err) {
					// A program that never started is no run: the spawn fails, as it did when node-pty threw at once, and its claim goes too
					this.drop(run);
					throw err;
				}
				this.log(`Started run ${run.id} (${spawn.file}) in ${spawn.cwd}, pid ${run.info(false).pid}.`);
				return this.info(run, connection);
			}
			case 'list': {
				const { owner } = params as Requests['list']['params'];
				const runs = [...this.runs.values()];
				return (typeof owner === 'string' ? runs.filter(run => run.params.owner === owner && !run.removed) : runs).map(run => this.info(run, connection));
			}
			case 'attach': {
				const run = runOf((params as Requests['attach']['params']).run);
				if (run.removed) {
					throw new Error(`No run ${run.id}.`);
				}
				if (this.claimedElsewhere(run, connection)) {
					throw new Error(`Run ${run.id} is claimed by another connected window.`);
				}
				this.claim(run, connection);
				// Its calls wait until the window was answered that the run is its: it knows the caller when they come (RULES-1.9, 4.1)
				this.attaching.add(run);
				try {
					const { screen, seq } = await run.snapshot();
					// Another activation can take over while xterm drains its writes. Do not bind its predecessor after that await.
					this.owners.assert(run.params.owner, connection);
					connection.send({ id: request.id, result: { info: this.info(run, connection), screen, seq } });
				} finally {
					this.attaching.delete(run);
				}
				this.forwardWaiting(run, connection);
				return RESPONDED;
			}
			case 'input': {
				const { run, data } = params as Requests['input']['params'];
				runOf(run).write(data);
				return undefined;
			}
			case 'resize': {
				const { run, cols, rows } = params as Requests['resize']['params'];
				runOf(run).resize(cols, rows);
				return undefined;
			}
			case 'read': {
				const { run, lines } = params as Requests['read']['params'];
				if (!Number.isSafeInteger(lines) || lines < 1) {
					throw new Error('A read asks for a whole number of lines.');
				}
				return runOf(run).read(lines);
			}
			case 'type': {
				const { run, text, enter, lead } = params as Requests['type']['params'];
				if (typeof text !== 'string') {
					throw new Error('Text to type must be a string.');
				}
				// A lead is typed as it is: words alone, nothing a terminal would act on
				// eslint-disable-next-line no-control-regex
				if (lead !== undefined && (typeof lead !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(lead))) {
					throw new Error('A lead to type before a paste is text without control characters.');
				}
				return runOf(run).type(text, !!enter, lead);
			}
			case 'keys': {
				const { run, keys } = params as Requests['keys']['params'];
				const refused = Array.isArray(keys) ? keys.find(key => !isAgentKey(key)) : '';
				if (refused !== undefined) {
					throw new Error(`Not a key: ${JSON.stringify(refused)}.`);
				}
				return runOf(run).keys(keys);
			}
			case 'inspect': {
				const { run, adapter } = params as Requests['inspect']['params'];
				if (typeof adapter !== 'string') {
					throw new Error('An input reader is named by a string.');
				}
				return runOf(run).inspect(adapter);
			}
			case 'setMeta': {
				const { run, meta } = params as Requests['setMeta']['params'];
				runOf(run).meta = meta;
				return undefined;
			}
			case 'terminate': {
				const { run: id, graceMs } = params as Requests['terminate']['params'];
				const run = this.runs.get(id);
				if (run) {
					this.owners.assert(run.params.owner, connection);
					// An accepted close precedes any later takeover. Its successor must not reattach a process already closing.
					this.remove(run);
				}
				// One ptyd no longer has ended and was forgotten: there is nothing left of it to end
				return run ? run.terminate(Math.max(0, graceMs)) : 'already_exited';
			}
			case 'forget': {
				const run = this.runs.get((params as Requests['forget']['params']).run);
				if (run) {
					this.owners.assert(run.params.owner, connection);
					this.remove(run);
				}
				return undefined;
			}
			case 'endWindow': {
				const { owner, graceMs } = params as Requests['endWindow']['params'];
				this.owners.assert(owner, connection);
				return this.endOwner(owner, graceMs, 'its window closed');
			}
			default:
				throw new Error(`Unknown method ${String(request.method)}.`);
		}
	}

	private endOwner(owner: string, graceMs: number, reason: string): number {
		const ending = [...this.runs.values()].filter(run => run.params.owner === owner);
		for (const run of ending) {
			this.log(`Ending run ${run.id}: ${reason}.`);
			this.remove(run);
			if (!run.hasExited) {
				void run.terminate(Math.max(0, graceMs));
			}
		}
		return ending.length;
	}

	/**
	 * No window shows `run` again: what its shim waits for is refused now, not after the claim wait (MCP-1.2), and it is let go of at
	 * once where it ended, else as it ends - however it came to be removed.
	 */
	private remove(run: Run): void {
		run.removed = true;
		this.refuseWaiting(run.id);
		if (run.hasExited) {
			this.drop(run);
		}
	}

	/** Lets go of a run no window shows again: ended, and removed. Its calls waiting for a window are refused. */
	private drop(run: Run): void {
		if (this.runs.get(run.id) !== run) {
			return;
		}
		this.claims.get(run)?.releaseAll([run]);
		this.claims.delete(run);
		this.runs.delete(run.id);
		run.dispose();
		this.refuseWaiting(run.id);
		this.scheduleIdleExit();
	}
	/** `connection` is the shim of `run`: the window that claims the run is told its tools are there (MCP-6.1). */
	private shimConnected(connection: Connection, run: string): void {
		connection.role = 'shim';
		if (connection.shimRun === run) {
			return;
		}
		this.shimGone(connection);
		if (!run) {
			return;
		}
		connection.shimRun = run;
		let shims = this.shims.get(run);
		if (!shims) {
			this.shims.set(run, shims = new Set());
		}
		shims.add(connection);
		const claimed = this.runs.get(run);
		const claimant = claimed && this.claims.get(claimed);
		if (claimant && !claimant.closed) {
			claimant.send({ event: 'tools', run });
		}
	}

	private shimGone(connection: Connection): void {
		const run = connection.shimRun;
		const shims = run !== undefined ? this.shims.get(run) : undefined;
		if (run !== undefined && shims?.delete(connection) && !shims.size) {
			this.shims.delete(run);
		}
		connection.shimRun = undefined;
	}

	/**
	 * A shim's call `request`, for the window that claims its caller: given to it at once, or - no window claiming the run, as while
	 * one reloads - once one does, within the call's two seconds from the shim's ingress (RULES-1.2), or a query's route deadline
	 * (ARCHITECTURE-2.3, MCP-1.3). The shim is answered that window's answer as it comes, or why none came; a query once its route
	 * deadline passed without one.
	 */
	private call(call: ShimCall, shim: Connection, receivedAt: number, request: number): void {
		if (shim.role !== 'shim') {
			throw new Error('Tool calls come from a run\'s MCP shim, which says hello as one first.');
		}
		if (!call || typeof call !== 'object' || typeof call.caller !== 'string' || typeof call.elapsedMs !== 'number' || !Number.isFinite(call.elapsedMs)) {
			throw new Error('A tool call names its calling run and how long it has been under way.');
		}
		const run = this.runs.get(call.caller);
		if (!run || run.removed) {
			throw new CallRefused('not_found', 'none', `Facade Code holds no agent run ${call.caller}: the call had no effect.`);
		}
		if ([...this.calls.values()].filter(pending => pending.run === run.id).length >= MOST_RUN_CALLS) {
			throw new CallRefused('capacity_exceeded', 'none', `${MOST_RUN_CALLS} tool calls of ${run.id} are under way already: this one had no effect.`);
		}
		const routeDeadlineMs = typeof call.routeDeadlineMs === 'number' && Number.isFinite(call.routeDeadlineMs) ? call.routeDeadlineMs : undefined;
		const pending: PendingCall = { id: this.nextCall++, run: run.id, shim, request, call, receivedAt, query: routeDeadlineMs !== undefined };
		this.calls.set(pending.id, pending);
		const spent = Math.max(0, call.elapsedMs) + performance.now() - receivedAt;
		const tool = typeof call.tool === 'string' ? call.tool : 'The query';
		const refusal = routeDeadlineMs !== undefined
			? `No Facade Code window answered ${tool} of ${run.id} within ${Math.round(routeDeadlineMs / 100) / 10} seconds: a query, it had no effect.`
			: `No Facade Code window holds ${run.id} now: the call had no effect.`;
		pending.timer = setTimeout(() => this.refuse(pending, new CallRefused('window_unavailable', 'none', refusal)), Math.max(0, (routeDeadlineMs ?? CLAIM_WAIT_MS) - spent));
		const claimant = this.claims.get(run);
		if (claimant && !claimant.closed && !this.attaching.has(run)) {
			this.forward(pending, claimant);
		}
	}

	/**
	 * Gives `pending` to `window`, with the time it spent in ptyd added to how long it has been under way: a call no longer waits for
	 * a deadline, a query still for its route's.
	 */
	private forward(pending: PendingCall, window: Connection): void {
		if (!pending.query) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
		}
		pending.window = window;
		const elapsedMs = pending.call.elapsedMs + Math.ceil(performance.now() - pending.receivedAt);
		window.send({ event: 'call', id: pending.id, call: { ...pending.call, elapsedMs } });
	}

	/** `pending` is answered or refused: ptyd keeps it no longer. */
	private settle(pending: PendingCall): void {
		clearTimeout(pending.timer);
		this.calls.delete(pending.id);
	}

	/** Answers `pending`'s shim why no window's answer comes; a window's answer after it finds no call to answer. */
	private refuse(pending: PendingCall, refusal: CallRefused): void {
		if (this.calls.get(pending.id) !== pending) {
			return;
		}
		this.settle(pending);
		pending.shim.send({ id: pending.request, error: refusal.message, reason: refusal.reason, effects: refusal.effects });
	}

	/** The calls of `run` still waiting for a window are refused: the run is gone or forgotten. */
	private refuseWaiting(run: string): void {
		for (const pending of [...this.calls.values()]) {
			if (pending.run === run && !pending.window) {
				this.refuse(pending, new CallRefused('not_found', 'none', `Facade Code holds no agent run ${run}: the call had no effect.`));
			}
		}
	}

	/**
	 * `connection` went. Each call given to it as a window may have acted, and is told so; each it asked as a shim that waits for a
	 * window is let go, its answer having nowhere to go - but a call given to a window already goes on (MCP-1.2).
	 */
	private callsClosed(connection: Connection): void {
		this.shimGone(connection);
		for (const pending of [...this.calls.values()]) {
			if (pending.window === connection) {
				this.refuse(pending, new CallRefused('window_unavailable', 'unknown', `The Facade Code window holding ${pending.run} went before it answered: the call may have taken effect.`));
			} else if (pending.shim === connection && !pending.window) {
				this.settle(pending);
			}
		}
	}



	/** Goes once nothing is left for it to do: no live run, and no window connected, for a while. */
	private scheduleIdleExit(): void {
		clearTimeout(this.idleTimer);
		if (this.connections.size || [...this.runs.values()].some(run => !run.hasExited)) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			this.log('No runs and no windows: ptyd exits.');
			this.close();
			process.exit(0);
		}, IDLE_EXIT_MS);
		this.idleTimer.unref?.();
	}
}

/**
 * Takes the lock at `lockPath` for this process: false where another ptyd took it just now and is coming up. A lock whose ptyd is
 * gone, or has had it a while with nothing answering on the socket, is taken over.
 */
function takeLock(lockPath: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
		}
		const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
		const age = Date.now() - fs.statSync(lockPath).mtimeMs;
		if (holder && holder !== process.pid && isAlive(holder) && age < LOCK_STALE_MS) {
			return false;
		}
		fs.rmSync(lockPath, { force: true });
	}
	return false;
}

function releaseLock(lockPath: string): void {
	try {
		if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) {
			fs.rmSync(lockPath, { force: true });
		}
	} catch {
		// Not ours, or gone already
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * What answers on the socket at `socketPath`: a connection proves a ptyd there, `alive`; a refusal or no socket at all proves none,
 * `gone`; a timeout or any other error proves nothing - a ptyd too busy to answer at once, say - and is `unknown`, never `gone`.
 */
export function probe(socketPath: string, ms = 1_000): Promise<'alive' | 'gone' | 'unknown'> {
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		const done = (found: 'alive' | 'gone' | 'unknown') => {
			clearTimeout(timer);
			socket.destroy();
			resolve(found);
		};
		socket.once('connect', () => done('alive'));
		socket.once('error', err => done(['ECONNREFUSED', 'ENOENT'].includes(codeOf(err) ?? '') ? 'gone' : 'unknown'));
		const timer = setTimeout(() => done('unknown'), ms);
		timer.unref?.();
	});
}

/** A file's identity: its device, inode and change time, which a socket made later at the same path does not share. */
interface Identity {
	readonly dev: number;
	readonly ino: number;
	readonly ctimeMs: number;
}

function identityOf(file: string): Identity | undefined {
	try {
		const { dev, ino, ctimeMs } = fs.statSync(file);
		return { dev, ino, ctimeMs };
	} catch {
		return undefined;
	}
}

function sameIdentity(found: Identity | undefined, made: Identity): boolean {
	return !!found && found.dev === made.dev && found.ino === made.ino && found.ctimeMs === made.ctimeMs;
}
