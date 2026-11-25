/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import type { Socket } from 'net';
import * as os from 'os';
import * as path from 'path';
import { connectWithin } from '../../base/connect';
import { codeOf, messageOf } from '../../base/errors';
import { isJsonObject } from '../../base/json';
import { lineReader } from '../../base/lines';
import type { OwnerClaim } from '../../base/ownership';

// Read-only observation and retirement for the released TypeScript supervisor.
export const PTYD_PROTOCOL = 17;
export const EARLIER_PROTOCOLS = [8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
const WAIT_MS = 2_000;

export interface RunInfo {
	readonly run: string;
	readonly owner: string;
	readonly pid: number;
	readonly cwd: string;
	readonly startedAt: number;
	readonly claimedElsewhere: boolean;
	readonly exited?: { readonly exitCode: number };
	readonly uncertain?: boolean;
	readonly meta: Readonly<Record<string, unknown>>;
}

interface Conversation {
	readonly environment: string;
	readonly cli: string;
	readonly sessionId: string;
}

interface Requests {
	hello: { args: { readonly protocol: number }; result: { readonly protocol: number; readonly pid: number; readonly build?: string } };
	list: { args: { readonly owner?: string }; result: readonly RunInfo[] };
	conversations: { args: Record<string, never>; result: readonly Conversation[] };
	claim: { args: OwnerClaim; result: void };
	terminate: { args: { readonly run: string; readonly graceMs: number }; result: 'terminated' | 'already_exited' | 'unconfirmed' | 'failed' };
}

const PIPE_DIRECTORY = '\\\\.\\pipe\\';

function homeKey(home: string): string {
	return createHash('sha256').update(home).digest('hex').slice(0, 12);
}

function socketDirectory(): string {
	return path.join('/tmp', `facade-ptyd-${os.userInfo().uid}`);
}

export function ptydSocketPath(home: string, protocol: number, build?: string): string {
	const name = `${protocol}-${build ? `${build}-` : ''}${homeKey(home)}`;
	return process.platform === 'win32' ? `${PIPE_DIRECTORY}facade-extension-ptyd-${name}`
		: path.join(socketDirectory(), `extension-ptyd-${name}.sock`);
}

/** The released build hash includes its script's installation path and mtime. Discover the installed suffix. */
export function releasedPtydSockets(home: string): readonly { readonly socket: string; readonly build: string }[] {
	const windows = process.platform === 'win32';
	const directory = windows ? PIPE_DIRECTORY : socketDirectory();
	const pattern = new RegExp(`^${windows ? 'facade-' : ''}extension-ptyd-${PTYD_PROTOCOL}-([0-9a-f]{10})-${homeKey(home)}${windows ? '' : '\\.sock'}$`, windows ? 'i' : '');
	try {
		if (!windows) { assertPrivateDirectory(directory); }
		return fs.readdirSync(directory).sort().flatMap(name => {
			const build = pattern.exec(name)?.[1].toLowerCase();
			return build ? [{ socket: ptydSocketPath(home, PTYD_PROTOCOL, build), build }] : [];
		});
	} catch (error) {
		// A missing Unix directory has no listeners. An unreadable pipe namespace leaves discovery incomplete.
		if (!windows && codeOf(error) === 'ENOENT') { return []; }
		throw error;
	}
}

function assertPrivateDirectory(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.uid !== os.userInfo().uid || (stat.mode & 0o077) !== 0) {
		throw new Error('The legacy supervisor socket directory is not private.');
	}
}

/** The released supervisor takes this listener lock before publishing its socket and registry row. */
export function ptydListenerLockedAt(socket: string, pid: number): number | undefined {
	const windows = process.platform === 'win32';
	const lock = windows ? path.join(os.tmpdir(), `${path.win32.basename(socket)}.lock`) : `${socket}.lock`;
	const entry = fs.lstatSync(lock);
	if (!entry.isFile() || !Number.isFinite(entry.mtimeMs)
		|| !windows && (entry.uid !== os.userInfo().uid || (entry.mode & 0o077) !== 0)) { return; }
	const fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (entry.dev !== stat.dev || entry.ino !== stat.ino || entry.mtimeMs !== stat.mtimeMs
			|| stat.size < 1 || stat.size > 16 || fs.readFileSync(fd, 'utf8').trim() !== String(pid)) { return; }
		return stat.mtimeMs;
	} finally { fs.closeSync(fd); }
}

function privateSocket(socket: string): boolean {
	if (process.platform === 'win32') {
		if (!/^\\\\\.\\pipe\\facade-extension-ptyd-[\w-]+$/u.test(socket)) {
			throw new Error('Invalid legacy supervisor pipe name.');
		}
		return true;
	}
	try {
		const uid = os.userInfo().uid;
		assertPrivateDirectory(path.dirname(socket));
		const entry = fs.lstatSync(socket);
		if (!entry.isSocket() || entry.uid !== uid) {
			throw new Error('The legacy supervisor socket has the wrong owner or file type.');
		}
		return true;
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return false; }
		throw error;
	}
}

export async function within<T>(answer: Promise<T>, ms = WAIT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([answer, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`ptyd did not answer within ${ms} ms.`)), ms);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

export class PtydClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly owners = new Set<(owner: string) => void>();
	private readonly closing = new Set<() => void>();
	private greeted?: Requests['hello']['result'];

	private constructor(private readonly socket: Socket) {
		socket.setEncoding('utf8');
		socket.on('data', lineReader(line => this.read(line), () => socket.destroy()));
		socket.on('error', () => socket.destroy());
		socket.once('close', () => {
			for (const waiting of this.pending.values()) { waiting.reject(new Error('ptyd closed the connection.')); }
			this.pending.clear();
			for (const listener of this.closing) { listener(); }
			this.closing.clear();
			this.owners.clear();
		});
	}

	static async join(file: string, protocol: number): Promise<PtydClient | undefined> {
		if (!privateSocket(file)) { return undefined; }
		const reached = await connectWithin(file, WAIT_MS);
		if (!reached.socket) {
			if (reached.absent) { return undefined; }
			throw new Error(`The legacy supervisor did not accept a connection: ${reached.reason}.`);
		}
		const client = new PtydClient(reached.socket);
		try {
			const hello = await within(client.request('hello', { protocol }));
			if (!isJsonObject(hello) || hello.protocol !== protocol || !Number.isSafeInteger(hello.pid) || hello.pid < 1
				|| (hello.build !== undefined && typeof hello.build !== 'string')) {
				throw new Error('The legacy supervisor did not identify itself with the expected protocol.');
			}
			client.greeted = hello;
			return client;
		} catch (error) {
			client.dispose();
			throw error;
		}
	}

	get build(): string | undefined { return this.greeted?.build; }
	get pid(): number | undefined { return this.greeted?.pid; }
	get isClosed(): boolean { return this.socket.destroyed; }

	request<M extends keyof Requests>(method: M, params: Requests[M]['args']): Promise<Requests[M]['result']> {
		if (this.isClosed) { return Promise.reject(new Error('ptyd is not connected.')); }
		const id = this.nextId++;
		const answer = new Promise<Requests[M]['result']>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.socket.write(JSON.stringify({ id, method, params }) + '\n', error => {
				if (error && this.pending.delete(id)) { reject(new Error(`Could not confirm the request to ptyd: ${messageOf(error)}`)); }
			});
		});
		return within(answer, method === 'terminate' || method === 'claim' ? 8_000 : WAIT_MS).finally(() => this.pending.delete(id));
	}

	onDidClose(listener: () => void): void { this.closing.add(listener); }
	onDidLoseOwner(listener: (owner: string) => void): void { this.owners.add(listener); }
	dispose(): void { this.socket.destroy(); }

	private read(line: string): void {
		let frame: unknown;
		try { frame = JSON.parse(line); } catch { return; }
		if (!isJsonObject(frame)) { return; }
		if (frame.event === 'ownerLost' && typeof frame.owner === 'string') {
			for (const listener of this.owners) { listener(frame.owner); }
		} else if (typeof frame.id === 'number' && Number.isSafeInteger(frame.id)) {
			const waiting = this.pending.get(frame.id);
			this.pending.delete(frame.id);
			if (typeof frame.error === 'string') { waiting?.reject(new Error(frame.error)); }
			else if (!Object.hasOwn(frame, 'error')) { waiting?.resolve(frame.result); }
			else { waiting?.reject(new Error('Invalid legacy supervisor response.')); }
		}
	}
}
