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
import type { ChangedParams, ErrorBody, WatchEndedParams } from '../../base/coreProtocol';
import { messageOf } from '../../base/errors';
import { lineReader } from '../../base/lines';
import { DaemonError } from './types';

export interface DaemonOptions {
	readonly home: string;
	readonly program: string;
	readonly build: string;
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

/** Opens one socket to this user's core, before hello. */
export async function connectDaemonSocket(home: string, waitMs: number): Promise<Reached> {
	const socket = daemonSocketPath(home);
	// On Windows the extension relies on the daemon pipe's DACL (ARCHITECTURE-1.4,
	// PROTOCOL "Connect to the daemon"). The folder check is Unix's.
	if (process.platform !== 'win32' && !socketFolderIsOurs(path.dirname(socket))) {
		return { absent: true, reason: 'the socket folder does not exist yet' };
	}
	return connectWithin(socket, waitMs);
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
function versionOf(build: string): bigint[] | undefined {
	const parts = build.split('+', 1)[0].split('.');
	if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) {
		return undefined;
	}
	const numbers = parts.map(BigInt);
	return numbers.every(number => number <= 0xffff_ffff_ffff_ffffn) ? numbers : undefined;
}

export function unavailable(message: string): DaemonError {
	return new DaemonError(message, 'unavailable', { reason: 'unavailable' });
}

export function errorOf(body: ErrorBody | undefined): DaemonError {
	const data = body?.data && typeof body.data.reason === 'string' ? body.data : { reason: 'internal' as const };
	return new DaemonError(body?.message ?? 'Facade core answered with an error.', data.reason, data);
}

/** Runs `facade daemon --detach` for `home`: where Facade starts, or already runs, it answers with code 0. */
export function startDaemon(options: Pick<DaemonOptions, 'home' | 'program' | 'log'>): Promise<void> {
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
			this.on.log(`Facade core sent a line that is too long: ${err.message}`);
			this.close();
		}));
		socket.on('error', err => this.on.log(`The connection to Facade core failed: ${err.message}`));
		socket.on('close', () => {
			this.on.closed();
			const waiting = [...this.pending.values()];
			this.pending.clear();
			for (const settle of waiting) {
				settle({ error: unavailable('The connection to Facade core closed: the call may or may not have run.') });
			}
		});
	}

	get active(): boolean {
		return !this.socket.destroyed && !this.socket.readableEnded && this.socket.writable;
	}

	/** Sends a request and answers with its response: `settle` runs as the response is read, before any later line is. */
	send(method: string, params: object, settle: (outcome: Outcome) => void): void {
		if (!this.active) {
			settle({ error: unavailable('The connection to Facade core is closed.') });
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
			this.on.log(`Facade core sent a line that is not JSON: ${line.slice(0, 200)}`);
			return;
		}
		if (message?.jsonrpc !== '2.0') {
			this.on.log('Facade core sent an invalid JSON-RPC message.');
			return;
		}
		if (message.method === 'changed') {
			this.on.changed(message.params as ChangedParams);
		} else if (message.method === 'watch_ended') {
			this.on.watchEnded(message.params as WatchEndedParams);
		} else if (message.method === 'closing') {
			this.on.closing();
		} else if (message.method === undefined && typeof message.id === 'number') {
			const settle = this.pending.get(message.id);
			this.pending.delete(message.id);
			settle?.(message.error ? { error: errorOf(message.error) } : { result: message.result });
		} else if (message.error) {
			this.on.log(`Facade core refused a request without an ID: ${message.error.message}`);
		}
	}
}
