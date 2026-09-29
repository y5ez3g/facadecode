/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { applyEvent, createState, LedgerEvent, LedgerEventBody, WorkspaceState } from './events';

export const LEDGER_FILE = 'ledger.jsonl';
const LOCK_FILE = 'ledger.lock';
const VERSION = 1;

/** Events whose loss in a crash costs nothing, written without waiting for the disk. */
const UNSYNCED: ReadonlySet<LedgerEvent['type']> = new Set(['agent.state']);

export class LedgerLockedError extends Error {
	constructor(readonly pid: number) {
		super(`Another Facade window (process ${pid}) has this workspace's ledger open.`);
		this.name = 'LedgerLockedError';
	}
}

/**
 * A workspace's ledger on disk: `ledger.jsonl`, one event per line, only ever appended to. A crash
 * can cut the last line short; loading drops that line and truncates the file back to the last whole
 * event, so the next append starts clean.
 *
 * One process owns a ledger at a time: two windows appending to one file would each hold a state the
 * other never saw, so the second is refused while the first is alive.
 */
export class Ledger {

	private fd: number | undefined;
	private readonly listeners = new Set<(event: LedgerEvent) => void>();

	private constructor(readonly dir: string, readonly state: WorkspaceState, private readonly now: () => number) { }

	/** Opens the ledger in `dir`, making it if there is none, and takes the lock on it. */
	static open(dir: string, now: () => number, isAlive: (pid: number) => boolean = processAlive): Ledger {
		fs.mkdirSync(dir, { recursive: true });
		takeLock(dir, isAlive);
		const file = path.join(dir, LEDGER_FILE);
		let content: Buffer;
		try {
			content = fs.readFileSync(file);
		} catch {
			content = Buffer.alloc(0);
		}
		const state = createState();
		let offset = 0;
		let good = 0;
		while (offset < content.length) {
			const end = content.indexOf(0x0a, offset);
			if (end < 0) {
				// The last line never got its newline: a write the crash cut short.
				break;
			}
			const line = content.subarray(offset, end).toString('utf8');
			offset = end + 1;
			if (!line.trim()) {
				good = offset;
				continue;
			}
			let parsed: LedgerEvent & { v?: number };
			try {
				parsed = JSON.parse(line);
			} catch {
				break;
			}
			if (parsed.v !== VERSION || parsed.seq !== state.seq + 1) {
				break;
			}
			delete parsed.v;
			applyEvent(state, parsed);
			good = offset;
		}
		if (good !== content.length) {
			fs.truncateSync(file, good);
		}
		return new Ledger(dir, state, now);
	}

	/** Appends an event, applies it, tells the listeners, and returns it with its number. */
	append(body: LedgerEventBody): LedgerEvent {
		const event: LedgerEvent = { ...body, seq: this.state.seq + 1, ts: this.now() };
		if (this.fd === undefined) {
			this.fd = fs.openSync(path.join(this.dir, LEDGER_FILE), 'a', 0o600);
		}
		fs.writeSync(this.fd, `${JSON.stringify({ v: VERSION, ...event })}\n`);
		if (!UNSYNCED.has(event.type)) {
			fs.fsyncSync(this.fd);
		}
		applyEvent(this.state, event);
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// A listener's failure is its own.
			}
		}
		return event;
	}

	onDidAppend(listener: (event: LedgerEvent) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	close(): void {
		if (this.fd !== undefined) {
			fs.closeSync(this.fd);
			this.fd = undefined;
		}
		this.listeners.clear();
		releaseLock(this.dir);
	}
}

function takeLock(dir: string, isAlive: (pid: number) => boolean): void {
	const file = path.join(dir, LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
		}
		const holder = Number(fs.readFileSync(file, 'utf8').trim());
		if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
			throw new LedgerLockedError(holder);
		}
		// Left behind by a process that is gone, or by this one.
		fs.rmSync(file, { force: true });
	}
	throw new Error(`Could not take the lock ${file}.`);
}

function releaseLock(dir: string): void {
	const file = path.join(dir, LOCK_FILE);
	try {
		if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) {
			fs.rmSync(file, { force: true });
		}
	} catch {
		// Already gone.
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}
