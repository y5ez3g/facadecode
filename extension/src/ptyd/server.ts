/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { createHash } from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { messageOf } from '../base/errors';
import { lineReader, Method, OwnerEvent, PTYD_PROTOCOL, Request, Requests, Response, RunEvent, RunInfo } from './protocol';
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

/**
 * One window's connection: what it is sent, and the output of each run it claims that waits to be flushed to it. A run with more
 * than {@link MOST_RUN_BUFFER} waiting, or a window with more than {@link MOST_WINDOW_BUFFER}, is paused until the window catches
 * up: ordinary backpressure, the CLIs waiting, the screen usable (ARCHITECTURE-2.4).
 */
class Connection {

	private waiting = 0;
	private readonly waitingByRun = new Map<Run, number>();
	private readonly requests = new Map<number, { readonly body: string; readonly result: Promise<unknown>; bytes: number }>();
	private receiptBytes = 0;
	private lastRequest = 0;

	constructor(readonly socket: net.Socket) { }

	get closed(): boolean {
		return this.socket.destroyed;
	}

	send(message: Response | RunEvent | OwnerEvent): void {
		if (this.socket.writable) {
			this.socket.write(JSON.stringify(message) + '\n');
		}
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
		if (request.method === 'attach' || request.method === 'list' || request.method === 'hello') {
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

/**
 * ptyd: holds the agents' processes for every window of the person's in this execution environment, on one socket per protocol
 * (ARCHITECTURE-2.3). A window starts runs and claims them; a run goes on as its window reloads or disconnects, and another
 * newer activation of its workspace can take ownership immediately. Effects are fenced to that owner; its disconnection starts
 * the explicit five-minute cleanup policy. Neither a former owner's disconnection nor an upgrade ends a successor's runs.
 */
export class PtydServer {

	private readonly runs = new Map<string, Run>();
	/** Every run ID ptyd started, kept so that none is started twice (RULES-2.2). */
	private readonly seen = new Set<string>();
	private readonly claims = new Map<Run, Connection>();
	private readonly connections = new Set<Connection>();
	private server: net.Server | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly owners: OwnerClaims<Connection>;
	private closing = false;

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
	 * Listens on the socket; resolves false where another ptyd answers there already - it serves the windows, and this one goes.
	 * A socket file nobody answers on is a ptyd that died, and is taken over.
	 */
	async listen(): Promise<boolean> {
		ensurePtydSocket(this.socketPath);
		// Two windows opening at once may each start a ptyd: the one that takes the lock listens, and the other goes
		if (await answers(this.socketPath) || !takeLock(this.lockPath)) {
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
		for (const run of this.runs.values()) {
			run.dispose();
		}
		this.runs.clear();
		for (const connection of this.connections) {
			connection.socket.destroy();
		}
		this.server?.close();
	}

	private connected(socket: net.Socket): void {
		const connection = new Connection(socket);
		this.connections.add(connection);
		clearTimeout(this.idleTimer);
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => {
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
			connection.request(request, () => this.handle(request, connection)).then(
				result => connection.send({ id: request.id, result }),
				err => connection.send({ id: request.id, error: messageOf(err) })
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

	/** `connection` claims `run`: it alone is told what the run does from now on. */
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
	}

	private async handle(request: Request, connection: Connection): Promise<unknown> {
		const params = request.params as Requests[Method]['params'];
		const runOf = (id: string) => {
			const run = this.runs.get(id);
			if (!run) {
				throw new Error(`No run ${id}.`);
			}
			this.owners.assert(run.params.owner, connection);
			return run;
		};
		switch (request.method) {
			case 'hello':
				return { protocol: this.speaks, pid: process.pid };
			case 'claim':
				this.owners.claim(params as Requests['claim']['params'], connection);
				return undefined;
			case 'spawn': {
				const spawn = params as Requests['spawn']['params'];
				this.owners.assert(spawn.owner, connection);
				if (typeof spawn.run !== 'string' || !spawn.run || this.seen.has(spawn.run)) {
					throw new Error(`Run ${JSON.stringify(spawn.run)} was started before: ptyd never starts a run ID twice.`);
				}
				this.seen.add(spawn.run);
				const run = new Run(spawn);
				this.runs.set(run.id, run);
				this.claim(run, connection);
				this.log(`Started run ${run.id} (${spawn.file}) in ${spawn.cwd}, pid ${run.info(false).pid}.`);
				run.onExit(exit => {
					this.log(`Run ${run.id} ended: code ${exit.exitCode}${exit.signal ? `, signal ${exit.signal}` : ''}.`);
					if (run.removed) {
						this.drop(run);
					}
					this.scheduleIdleExit();
				});
				return this.info(run, connection);
			}
			case 'list': {
				const { owner } = params as Requests['list']['params'];
				return [...this.runs.values()].filter(run => run.params.owner === owner && !run.removed).map(run => this.info(run, connection));
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
				const { screen, seq } = await run.snapshot();
				// Another activation can take over while xterm drains its writes. Do not bind its predecessor after that await.
				this.owners.assert(run.params.owner, connection);
				return { info: this.info(run, connection), screen, seq };
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
					run.removed = true;
				}
				// One ptyd no longer has ended and was forgotten: there is nothing left of it to end
				return run ? run.terminate(Math.max(0, graceMs)) : 'already_exited';
			}
			case 'forget': {
				const run = this.runs.get((params as Requests['forget']['params']).run);
				if (run) {
					this.owners.assert(run.params.owner, connection);
					run.removed = true;
					if (run.hasExited) {
						this.drop(run);
					}
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
			run.removed = true;
			this.log(`Ending run ${run.id}: ${reason}.`);
			if (run.hasExited) {
				this.drop(run);
			} else {
				void run.terminate(Math.max(0, graceMs));
			}
		}
		return ending.length;
	}

	/** Lets go of a run no window shows again: ended, and removed. */
	private drop(run: Run): void {
		if (this.runs.get(run.id) !== run) {
			return;
		}
		this.claims.get(run)?.releaseAll([run]);
		this.claims.delete(run);
		this.runs.delete(run.id);
		run.dispose();
		this.scheduleIdleExit();
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

/** Whether something answers on the socket at `socketPath`. */
function answers(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		const done = (alive: boolean) => {
			socket.destroy();
			resolve(alive);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		setTimeout(() => done(false), 1_000).unref();
	});
}
