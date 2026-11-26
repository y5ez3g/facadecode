/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { connectWithin, type Reached } from '../../base/connect';
import type { ChangedParams, ErrorBody, WatchEndedParams } from '../../base/frameworkProtocol';
import { messageOf } from '../../base/errors';
import { lineReader } from '../../base/lines';
import { DaemonError } from './daemonTypes';

export interface DaemonOptions {
	readonly home: string;
	readonly program: string;
	readonly startupObserverProgram?: string;
	readonly build: string;
	log(line: string): void;
}

/** The daemon's socket for `home` (PROTOCOL "Connect to the daemon"): the home's path exactly as the program was started with it. */
export function daemonSocketPath(home: string): string {
	const key = crypto.createHash('sha256').update(Buffer.from(home, 'utf8')).digest('hex').slice(0, 10);
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\facade-framework-daemon-${key}`;
	}
	return path.join('/tmp', `facade-framework-${process.getuid?.() ?? os.userInfo().uid}`, `daemon-${key}.sock`);
}

/**
 * Framework's `socket_dir` check, made before connecting: a socket folder that exists must be a folder (not a link) owned by this user,
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

/** Opens one socket to this user's framework, before hello. */
export async function connectDaemonSocket(home: string, waitMs: number): Promise<Reached> {
	const socket = daemonSocketPath(home);
	// On Windows the extension relies on the daemon pipe's DACL (ARCHITECTURE-1.4,
	// PROTOCOL "Connect to the daemon"). The folder check is Unix's.
	if (process.platform !== 'win32' && !socketFolderIsOurs(path.dirname(socket))) {
		return { absent: true, reason: 'the socket folder does not exist yet' };
	}
	return connectWithin(socket, waitMs);
}

export function unavailable(message: string): DaemonError {
	return new DaemonError(message, 'unavailable', { reason: 'unavailable' });
}

export function errorOf(body: ErrorBody | undefined): DaemonError {
	const data = body?.data && typeof body.data.reason === 'string' ? body.data : { reason: 'internal' as const };
	return new DaemonError(body?.message ?? 'Facade Code Framework answered with an error.', data.reason, data, body?.code);
}

function startupRefusal(stdout: string): DaemonError | undefined {
	const prefix = 'facade-editor-daemon-error ';
	const report = stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
	if (!report) { return undefined; }
	try {
		const body = JSON.parse(report.slice(prefix.length)) as ErrorBody | null;
		const reason = body?.data?.reason;
		if ((reason === 'refused' || reason === 'protocol_incompatible') &&
			typeof body?.message === 'string' && Number.isInteger(body.code)) {
			return errorOf(body);
		}
	} catch {
		// Keep the ordinary startup error when the child did not send a usable report.
	}
	return undefined;
}

export interface StartupTicket {
	readonly generation: string;
	readonly pid: number;
	readonly birth: string;
}

export interface StartupReady {
	readonly pid: number;
	readonly deadlineNs: bigint;
}

function startupLine<T>(stdout: string, prefix: string): T | undefined {
	const line = stdout.split(/\r?\n/).find(item => item.startsWith(prefix));
	if (!line) { return undefined; }
	try {
		return JSON.parse(line.slice(prefix.length)) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Selects the bundled programs or starts the home launcher for the given home. */
export async function startDaemon(
	options: Pick<DaemonOptions, 'home' | 'program' | 'startupObserverProgram' | 'log'>,
	mode: '--takeover' | '--detach',
	signal?: AbortSignal
): Promise<StartupTicket | undefined> {
	const report = mode === '--detach' && options.startupObserverProgram !== undefined;
	const stdout = await startupCommand(options, options.program, [mode], signal, report);
	const ticket = startupLine<StartupTicket>(stdout, 'facade-startup-locked ');
	if (ticket && typeof ticket.generation === 'string' && /^[0-9a-f]{16}$/i.test(ticket.generation)
		&& Number.isSafeInteger(ticket.pid) && ticket.pid > 0 && typeof ticket.birth === 'string'
		&& /^[a-z0-9_.:-]{1,128}$/i.test(ticket.birth)) {
		return ticket;
	}
	return undefined;
}

/** Observes precisely the startup accepted by --detach through the native startup policy. */
export async function waitForStartup(options: DaemonOptions, ticket: StartupTicket | undefined, signal: AbortSignal): Promise<StartupReady> {
	const program = options.startupObserverProgram ?? options.program;
	const words = ['--await-startup'];
	if (ticket) { words.push(ticket.generation, String(ticket.pid), ticket.birth); }
	const stdout = await startupCommand(options, program, words, signal, true);
	const ready = startupLine<{ pid: number; deadlineNs: string }>(stdout, 'facade-startup-ready ');
	if (!ready || !Number.isSafeInteger(ready.pid) || ready.pid <= 0
		|| typeof ready.deadlineNs !== 'string' || !/^[0-9]{1,20}$/.test(ready.deadlineNs)) {
		throw unavailable('Facade Code Framework did not identify the daemon that completed startup.');
	}
	const deadlineNs = BigInt(ready.deadlineNs);
	if (deadlineNs - process.hrtime.bigint() > 180_000_000_000n) {
		throw unavailable('Facade Code Framework returned an invalid startup deadline.');
	}
	return { pid: ready.pid, deadlineNs };
}

function startupCommand(
	options: Pick<DaemonOptions, 'home' | 'log'>, program: string, words: string[], signal: AbortSignal | undefined,
	report: boolean
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, ['daemon', ...words], {
			env: { ...process.env, FACADE_HOME: options.home, FACADE_EDITOR_STARTUP_REPORT: '1',
				...(report ? { FACADE_STARTUP_REPORT: '1' } : {}) },
			stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
			if (report) { options.log(chunk.trimEnd()); }
		});
		child.once('error', err => reject(new Error(`Could not run ${program}: ${messageOf(err)}`)));
		child.once('close', code => {
			const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
			if (code === 0) {
				const diagnostic = stdout.split(/\r?\n/).filter(line => !/^facade-startup-(locked|ready) /.test(line)).join('\n').trim();
				const notice = [diagnostic, report ? '' : stderr.trim()].filter(Boolean).join('\n');
				if (notice) { options.log(notice); }
				resolve(stdout);
			} else {
				reject(startupRefusal(stdout) ??
					new Error(`${program} daemon ${words[0]} exited with code ${code}${detail ? `\n${detail}` : ''}`));
			}
		});
	});
}
/** What a response settles a request with. */
type Outcome = { readonly result: unknown; readonly error?: undefined } | { readonly error: DaemonError };

/** One socket to the daemon, with the requests waiting on it. It ends them all with an error once the socket closes. */
export class Connection {
	private readonly pending = new Map<number, (outcome: Outcome) => void>();
	private nextId = 1;

	constructor(private readonly socket: net.Socket, private readonly on: {
		changed(params: ChangedParams): void;
		watchEnded(params: WatchEndedParams): void;
		closing(): void;
		closed(): void;
		log(line: string): void;
	}) {
		socket.on('data', lineReader(line => this.line(line), err => {
			this.on.log(`Facade Code Framework sent a line that is too long: ${err.message}`);
			this.close();
		}));
		socket.on('error', err => this.on.log(`The connection to Facade Code Framework failed: ${err.message}`));
		socket.on('close', () => {
			this.on.closed();
			const waiting = [...this.pending.values()];
			this.pending.clear();
			for (const settle of waiting) {
				settle({ error: unavailable('The connection to Facade Code Framework closed: the call may or may not have run.') });
			}
		});
	}

	get active(): boolean {
		return !this.socket.destroyed && !this.socket.readableEnded && this.socket.writable;
	}

	/** Sends a request and answers with its response: `settle` runs as the response is read, before any later line is. */
	send(method: string, params: object, settle: (outcome: Outcome) => void): void {
		if (!this.active) {
			settle({ error: unavailable('The connection to Facade Code Framework is closed.') });
			return;
		}
		const id = this.nextId++;
		this.pending.set(id, settle);
		this.write({ jsonrpc: '2.0', id, method, params });
	}

	ask(method: string, params: object, waitMs?: number): Promise<unknown> {
		const answer = new Promise((resolve, reject) => this.send(method, params, outcome => outcome.error ? reject(outcome.error) : resolve(outcome.result)));
		if (waitMs === undefined) {
			return answer;
		}
		const timer = setTimeout(() => this.close(), waitMs);
		return answer.finally(() => clearTimeout(timer));
	}

	/** Sends a notification: no response comes. */
	notify(method: string, params?: object): boolean {
		if (!this.active) {
			return false;
		}
		this.write({ jsonrpc: '2.0', method, params });
		return true;
	}

	close(): void {
		this.socket.destroy();
	}

	private write(message: object): void {
		this.socket.write(JSON.stringify(message) + '\n');
	}

	private line(line: string): void {
		if (!this.active) {
			return;
		}
		let message: { jsonrpc?: string; id?: number | null; method?: string; params?: unknown; result?: unknown; error?: ErrorBody } | null;
		try {
			message = JSON.parse(line);
		} catch {
			this.on.log(`Facade Code Framework sent a line that is not JSON: ${line.slice(0, 200)}`);
			return;
		}
		if (message?.jsonrpc !== '2.0') {
			this.on.log('Facade Code Framework sent an invalid JSON-RPC message.');
			return;
		}
		if (message.method === 'changed') {
			this.on.changed(message.params as ChangedParams);
		} else if (message.method === 'watch_ended') {
			this.on.watchEnded(message.params as WatchEndedParams);
		} else if (message.method === 'closing') {
			this.on.closing();
		} else if (message.method === undefined && typeof message.id === 'number' && Number.isSafeInteger(message.id)) {
			const settle = this.pending.get(message.id);
			this.pending.delete(message.id);
			settle?.(message.error ? { error: errorOf(message.error) } : { result: message.result });
		} else if (message.error) {
			this.on.log(`Facade Code Framework refused a request without an ID: ${message.error.message}`);
		}
	}
}
