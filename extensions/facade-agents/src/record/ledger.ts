/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sleepSync } from '../base/async';
import { codeOf } from '../base/errors';
import { HELD_OPEN_CODES } from '../base/files';
import { isJsonObject } from '../base/json';
import { removeLockIfUnchanged } from '../base/lock';
import { isProcessRunning } from '../base/system';
import { applyEvent, createState, eventOf, fitsState, LedgerEvent, LedgerEventBody, WorkspaceState } from './events';

/** The ledger's file, in the workspace's folder. */
const LEDGER_FILE = 'ledger.jsonl';
const LOCK_FILE = 'ledger.lock';
/** The version of the ledger's events: 2 since processes have PIDs. */
const VERSION = 2;
/** How often the window that has the ledger open touches its lock. */
const HEARTBEAT_MS = 30_000;
/** A lock untouched for this long belongs to no window, even if the process it names runs: its id may be reused. */
const HELD_MS = 3 * HEARTBEAT_MS;
/** What a lock holds once its window closed the ledger. */
const CLOSED = 'closed';
/** How long a ledger closed by its window counts as held: the window may be reloading. */
const RELOAD_MS = 60_000;
/** How many times the lock is tried - taken, or read - while another window or program has it busy. */
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;
/** How long past the time a lock nobody touches may be taken over a window waiting for it waits: a moment more. */
const WAIT_MARGIN_MS = 5_000;

/** The ledger is another window's: open there, or closed by it a moment ago as it reloads. */
export class LedgerLockedError extends Error {
	/**
	 * `pid` is the process of the window that has it open - undefined for one that closed it as it
	 * reloads - and `touchedAt` when its lock was last touched, which a window that runs does every
	 * 30 seconds.
	 */
	constructor(readonly pid: number | undefined, readonly touchedAt: number) {
		super(pid !== undefined ? `Another Facade window (process ${pid}) has this workspace's agents.` : 'Another Facade window has this workspace\'s agents: it closed them a moment ago, as it reloads.');
		this.name = 'LedgerLockedError';
	}
}

/**
 * Whether a window that finds the ledger locked tries again, as each failure to open it comes. A lock
 * is waited for within `handoverMs` of the first, as the extension host before lets go of it; after
 * that while nobody touches it - its window ended, and its process id is another program's now, or
 * another workspace's window closed it as it reloaded and did not come back - until any window may
 * take it over. One touched again after the handover is a running window's.
 */
export function lockWait(handoverMs: number): (err: unknown) => boolean {
	const start = Date.now();
	/** When the lock was last touched, as first seen after the handover. */
	let seen: number | undefined;
	return err => {
		if (!(err instanceof LedgerLockedError)) {
			return false;
		}
		const now = Date.now();
		if (now - start < handoverMs) {
			return true;
		}
		seen ??= err.touchedAt;
		return err.touchedAt === seen && now < Math.max(seen, start) + HELD_MS + WAIT_MARGIN_MS;
	};
}

/** The ledger was taken by another window - its lock untouched for too long, as while this one stood still - and takes no event more from this one. */
export class LedgerTakenError extends Error {
	constructor(dir: string) {
		super(`Another Facade window took this workspace's agents: the ledger in ${dir} takes no event more from this one.`);
		this.name = 'LedgerTakenError';
	}
}

/** An event for a ledger that was closed: another window may own its file by now. */
class LedgerClosedError extends Error {
	constructor(dir: string) {
		super(`The ledger in ${dir} is closed.`);
		this.name = 'LedgerClosedError';
	}
}

/** A line of the ledger that is not an event of this version. */
class LedgerCorruptError extends Error {
	constructor(file: string, line: number) {
		super(`Line ${line} of ${file} is not an event Facade can read, so the workspace's agents are not loaded. Move the file away to start with no agents.`);
		this.name = 'LedgerCorruptError';
	}
}

/** How a ledger is opened; tests replace the clock, what runs, and how often the lock is touched. */
export interface LedgerOptions {
	readonly now?: () => number;
	/** Whether an operating system process runs. */
	readonly isRunning?: (pid: number) => boolean;
	readonly heartbeatMs?: number;
	/**
	 * Who opens it, the same each time - the workspace, through its reloads - written into the lock as the
	 * ledger closes: that one takes it back at once, any other once it is a minute old.
	 */
	readonly owner?: string;
	/** Called once, should another window take the ledger: it has closed itself by then. */
	readonly onTaken?: () => void;
}

/**
 * A workspace's ledger: `ledger.jsonl`, one event per line, only ever appended to. One window at a time
 * owns it, through `ledger.lock`, which holds the window's process id and a mark of this opening's own,
 * and takes no event more once another window took that lock. Opening it drops a last line a crash cut
 * short, and moves a ledger another version wrote aside; any other line it cannot read, or that does not
 * fit those before it, keeps it from opening.
 */
export class Ledger {

	private fd: number | undefined;
	private closed = false;
	private taken = false;
	private heartbeat: ReturnType<typeof setTimeout> | undefined;

	private constructor(readonly dir: string, readonly state: WorkspaceState, private readonly mark: string, private readonly options: LedgerOptions) { }

	/** Opens the ledger in `dir`, taking its lock; throws `LedgerLockedError` while another window has it. */
	static open(dir: string, options: LedgerOptions = {}): Ledger {
		fs.mkdirSync(dir, { recursive: true });
		const mark = `${process.pid} ${crypto.randomBytes(6).toString('hex')}`;
		acquireLock(dir, mark, options.isRunning ?? isProcessRunning, options.owner);
		try {
			const ledger = new Ledger(dir, load(dir), mark, options);
			ledger.scheduleHeartbeat();
			return ledger;
		} catch (err) {
			releaseLock(dir, mark, false);
			throw err;
		}
	}

	/**
	 * Throws unless events can be appended: the ledger is open, and its lock still this window's. A lock
	 * another program holds open too long to be read throws as reading it did, and the ledger stays open.
	 */
	assertOpen(): void {
		if (!this.closed && !ownsLock(this.dir, this.mark)) {
			this.lose();
		}
		if (this.taken) {
			throw new LedgerTakenError(this.dir);
		}
		if (this.closed) {
			throw new LedgerClosedError(this.dir);
		}
	}

	/**
	 * Appends an event, applies it to the state, and returns it. An event that could not be written whole
	 * leaves nothing of it in the file - or, when even that fails, the ledger closed - so that only a last
	 * line can ever be cut short.
	 */
	append(body: LedgerEventBody): LedgerEvent {
		this.assertOpen();
		const event: LedgerEvent = { ...body, seq: this.state.seq + 1, time: (this.options.now ?? Date.now)() };
		if (this.fd === undefined) {
			this.fd = fs.openSync(path.join(this.dir, LEDGER_FILE), 'a', 0o600);
		}
		const size = fs.fstatSync(this.fd).size;
		try {
			fs.writeFileSync(this.fd, `${JSON.stringify({ v: VERSION, ...event })}\n`);
			fs.fsyncSync(this.fd);
		} catch (err) {
			try {
				// By its path: Windows cuts no file through a handle opened to append to it
				fs.truncateSync(path.join(this.dir, LEDGER_FILE), size);
			} catch {
				this.close();
			}
			throw err;
		}
		applyEvent(this.state, event);
		return event;
	}

	/** Closes the ledger: its lock says `closed`, and by whom, if it is still this window's, for a reload to take it back. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearTimeout(this.heartbeat);
		if (this.fd !== undefined) {
			fs.closeSync(this.fd);
			this.fd = undefined;
		}
		releaseLock(this.dir, this.mark, true, this.options.owner);
	}

	/** Another window took the lock: nothing more is written, and whoever opened the ledger is told, once. */
	private lose(): void {
		this.taken = true;
		this.close();
		this.options.onTaken?.();
	}

	private scheduleHeartbeat(): void {
		this.heartbeat = setTimeout(() => {
			if (this.closed) {
				return;
			}
			let owned: boolean | undefined;
			try {
				owned = ownsLock(this.dir, this.mark);
			} catch {
				// Held open by another program: the next beat tells.
			}
			// Another window's by now: not touched for it, and not written to
			if (owned === false) {
				this.lose();
				return;
			}
			if (owned) {
				touchLock(this.dir);
			}
			this.scheduleHeartbeat();
		}, this.options.heartbeatMs ?? HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}
}

/** The state the ledger in `dir` records, after the repairs `Ledger` describes. */
function load(dir: string): WorkspaceState {
	const file = path.join(dir, LEDGER_FILE);
	let content: string;
	try {
		content = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return createState();
		}
		throw err;
	}
	const lines = content.split('\n');
	// What follows the last line break was cut short by a crash.
	const complete = lines.slice(0, -1);
	const version = versionOf(complete);
	if (version !== undefined && version !== VERSION) {
		fs.renameSync(file, path.join(dir, `ledger.v${version}.${Date.now()}.jsonl`));
		return createState();
	}
	const state = createState();
	complete.forEach((line, index) => {
		if (!line.trim()) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new LedgerCorruptError(file, index + 1);
		}
		const event = isJsonObject(parsed) && parsed.v === VERSION && parsed.seq === state.seq + 1 ? eventOf(parsed) : undefined;
		if (!event || !fitsState(state, event)) {
			throw new LedgerCorruptError(file, index + 1);
		}
		applyEvent(state, event);
	});
	if (lines[lines.length - 1] !== '') {
		fs.truncateSync(file, Buffer.byteLength(complete.map(line => `${line}\n`).join('')));
	}
	return state;
}

/** The version of a ledger's lines, by the first that says one. */
function versionOf(lines: readonly string[]): number | undefined {
	const first = lines.find(line => line.trim());
	if (first === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(first);
		return isJsonObject(parsed) && typeof parsed.v === 'number' ? parsed.v : undefined;
	} catch {
		return undefined;
	}
}

/** The process id a lock names: its first word; undefined for a lock that names none, as one that says `closed`. */
function holderOf(content: string): number | undefined {
	const pid = Number(content.split(' ')[0]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether a lock says its ledger was closed. */
function isClosed(content: string): boolean {
	return content.split(' ')[0].trim() === CLOSED;
}

/** Who closed the ledger, as its lock says; undefined for one that says only `closed`. */
function closerOf(content: string): string | undefined {
	return content.slice(CLOSED.length).trim() || undefined;
}

/** When the lock `file` was last touched; 0 where that cannot be told. */
function touchedAt(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Takes the lock in `dir` for this opening, `mark` its content. One whose process runs and touched it
 * lately is another window's, and so is one another owner closed a moment ago, as its window reloads;
 * any other was left by a window that ended, closed, or stood still too long, and is taken over - moved
 * aside first, so that of two windows finding it so at once only one takes it.
 */
function acquireLock(dir: string, mark: string, isRunning: (pid: number) => boolean, owner: string | undefined): void {
	const file = path.join(dir, LOCK_FILE);
	for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
		if (attempt > 1) {
			sleepSync(LOCK_RETRY_MS);
		}
		try {
			fs.writeFileSync(file, mark, { flag: 'wx', mode: 0o600 });
			return;
		} catch (err) {
			// Windows fails with EPERM while another window is deleting the lock: tried again.
			if (codeOf(err) !== 'EEXIST' && codeOf(err) !== 'EPERM') {
				throw err;
			}
		}
		const content = readLock(dir);
		// Let go of between the two calls: tried again
		if (content === undefined) {
			continue;
		}
		const holder = holderOf(content);
		if (holder !== undefined && holder !== process.pid && isRunning(holder) && isTouchedWithin(file, HELD_MS)) {
			throw new LedgerLockedError(holder, touchedAt(file));
		}
		const closer = isClosed(content) ? closerOf(content) : undefined;
		if (closer !== undefined && closer !== owner && isTouchedWithin(file, RELOAD_MS)) {
			throw new LedgerLockedError(undefined, touchedAt(file));
		}
		removeLockIfUnchanged(file, content);
	}
	throw new Error(`Could not take the lock ${file}.`);
}

/**
 * What the lock in `dir` holds; undefined while there is none. One another program holds open for a
 * moment - a scanner, on Windows - is read again; one it holds longer throws as the read did.
 */
function readLock(dir: string): string | undefined {
	const file = path.join(dir, LOCK_FILE);
	for (let attempt = 1; ; attempt++) {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch (err) {
			if (codeOf(err) === 'ENOENT') {
				return undefined;
			}
			if (attempt >= LOCK_ATTEMPTS || !HELD_OPEN_CODES.has(codeOf(err) ?? '')) {
				throw err;
			}
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

/** Whether the lock in `dir` is still the one this opening took; throws while it cannot be read. */
function ownsLock(dir: string, mark: string): boolean {
	return readLock(dir) === mark;
}

/** Lets go of this opening's lock; a ledger that was `closed` leaves a lock that says so, by whom, with the time. */
function releaseLock(dir: string, mark: string, closed: boolean, owner?: string): void {
	const file = path.join(dir, LOCK_FILE);
	try {
		if (!ownsLock(dir, mark)) {
			return;
		}
		if (closed) {
			fs.writeFileSync(file, owner ? `${CLOSED} ${owner}` : CLOSED);
		} else {
			fs.rmSync(file, { force: true });
		}
	} catch {
		// Held open by another program, or gone: left as it is, and untouched from now on, it is taken over in time.
	}
}

/** Whether `file` was touched within the last `ms` milliseconds. */
function isTouchedWithin(file: string, ms: number): boolean {
	try {
		return Date.now() - fs.statSync(file).mtimeMs <= ms;
	} catch {
		return false;
	}
}

function touchLock(dir: string): void {
	const now = new Date();
	try {
		fs.utimesSync(path.join(dir, LOCK_FILE), now, now);
	} catch {
		// The window is closing.
	}
}

/**
 * Whether the ledger in `dir` is a window's: open - the process that took its lock runs, and still touches
 * it - or closed a moment ago by a window that may be reloading. A lock another program holds open too
 * long to be read counts as held, whose it is not being known.
 */
export function isLedgerHeld(dir: string, isRunning: (pid: number) => boolean = isProcessRunning): boolean {
	let content: string | undefined;
	try {
		content = readLock(dir);
	} catch {
		return true;
	}
	if (content === undefined) {
		return false;
	}
	const file = path.join(dir, LOCK_FILE);
	const holder = holderOf(content);
	return holder !== undefined
		? isRunning(holder) && isTouchedWithin(file, HELD_MS)
		: isClosed(content) && isTouchedWithin(file, RELOAD_MS);
}
