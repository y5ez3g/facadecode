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

export function ptydSocketPath(home: string, protocol: number): string {
	const key = createHash('sha256').update(home).digest('hex').slice(0, 12);
	const name = `${protocol}-${key}`;
	return process.platform === 'win32' ? `\\\\.\\pipe\\facade-extension-ptyd-${name}`
		: path.join('/tmp', `facade-ptyd-${os.userInfo().uid}`, `extension-ptyd-${name}.sock`);
}

function privateSocket(socket: string): boolean {
	if (process.platform === 'win32') {
		if (!/^\\\\\.\\pipe\\facade-extension-ptyd-[\w-]+$/u.test(socket)) {
			throw new Error('Invalid legacy supervisor pipe name.');
		}
		return true;
	}
	try {
		const dir = fs.lstatSync(path.dirname(socket));
		const uid = os.userInfo().uid;
		if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) {
			throw new Error('The legacy supervisor socket directory is not private.');
		}
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
