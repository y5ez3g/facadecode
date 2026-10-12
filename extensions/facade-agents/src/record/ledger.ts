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
import { isProcessRunning, isSameProgram } from '../base/system';
import { applyEvent, createState, eventOf, fitsState, LedgerEvent, LedgerEventBody, WorkspaceState } from './events';

/** The ledger's file, in the workspace's folder. */
export const LEDGER_FILE = 'ledger.jsonl';
const LOCK_FILE = 'ledger.lock';
/**
 * The version of the ledger's events: 5 since an agent has its YOLO, its tree's root, its sandbox and its
 * task's message. Lines of version 4, from before, are read too: their agents ran at full access.
 */
const VERSION = 5;
/** The versions a ledger's lines may have, the one written last. */
const READ_VERSIONS: ReadonlySet<unknown> = new Set([4, VERSION]);
/** How often the window that has the ledger open touches its lock. */
const HEARTBEAT_MS = 30_000;
/** A lock untouched for this long belongs to no window, even if the process it names runs: its id may be reused. */
const HELD_MS = 3 * HEARTBEAT_MS;
/** What a lock holds once its window closed the ledger as the window went: closed, quit, or reloaded. */
const CLOSED = 'closed';
/** What a lock holds once Facade let go of its agents while its window stayed: turned off, or a start that failed. */
const RELEASED = 'released';
/** A word of a closed lock that is not known: its owner, where a window load follows. */
const UNKNOWN = '-';

/** Who let go of a ledger: its window, as it went, or Facade, the window staying. */
export type ClosedBy = 'window' | 'facade';

/** How the window that had a ledger before let go of it, as its lock says. */
export interface LastClose {
	readonly by: ClosedBy;
	/** Whether it was this workspace's window: the one whose owner opens it now. */
	readonly ownWindow: boolean;
	/** Whether it was this very window, as its extension host started again: the window load that opens it now. */
	readonly thisWindow: boolean;
}

/** How long a ledger closed by its window counts as held: the window may be reloading. */
const RELOAD_MS = 60_000;
/** How many times the lock is tried - taken, or read - while another window or program has it busy. */
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;
/** How long past the time a lock nobody touches may be taken over a window waiting for it waits: a moment more. */
const WAIT_MARGIN_MS = 5_000;

/** The ledger is another window's: open there, or closed by it a moment ago, as it reloads or as Facade there let go of its agents. */
export class LedgerLockedError extends Error {
	/**
	 * `pid` is the process of the window that has it open - undefined for one that closed it, `closedBy`
	 * saying how - and `touchedAt` when its lock was last touched, which a window that runs does every
	 * 30 seconds.
	 */
	constructor(readonly pid: number | undefined, readonly touchedAt: number, closedBy: ClosedBy = 'window') {
		super(pid !== undefined
			? `Another Facade window (process ${pid}) has this workspace's agents.`
			: closedBy === 'window'
				? 'Another Facade window has this workspace\'s agents: it closed them a moment ago, as it reloads.'
				: 'Another Facade window has this workspace\'s agents: Facade there let go of them a moment ago.');
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

/**
 * A ledger Facade cannot read - a line that is no event of this version, one that does not fit those
 * before it, or a ledger of another version - while a process of its agents may run: nothing of it is
 * changed, and it is moved aside only once none can.
 */
export class LedgerUnreadableError extends Error {
	constructor(readonly file: string, why: string) {
		super(`${why}, so this window starts and stops no agent of this workspace while an agent of it may still run. Its next start with none running begins a new list.`);
		this.name = 'LedgerUnreadableError';
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
	/**
	 * The window load it opens in: the same through its extension host's restarts, another after a reload.
	 * Written into the lock as the ledger closes, for the next opening to tell whether this very window closed it.
	 */
	readonly session?: string;
	/** Called once, should another window take the ledger: it has closed itself by then. */
	readonly onTaken?: () => void;
	/**
	 * Whether a ledger Facade cannot read may be moved aside, for a new list to begin: at a start of the
	 * window that is not a reload, with no process of its agents present. Where left out, it never is.
	 */
	readonly mayMoveAside?: () => boolean;
	/** Hears that a ledger Facade could not read was moved aside, why, and where it is kept: the person is told (L12; N-31). */
	readonly onMovedAside?: (why: string, keptAs: string) => void;
}

/**
 * A workspace's ledger: `ledger.jsonl`, one event per line, only ever appended to. One window at a time
 * owns it, through `ledger.lock`, which holds the window's process id and a mark of this opening's own,
 * and takes no event more once another window took that lock. Opening it drops a last line a crash cut
 * short. A ledger another version wrote, a line it cannot read, or one that does not fit those before it,
 * keeps it from opening while its agents may run, and is moved aside once none can (`mayMoveAside`).
 */
export class Ledger {

	/** Who hears of each event as it is written. */
	private readonly listeners = new Set<(event: LedgerEvent) => void>();

	private fd: number | undefined;
	private closed = false;
	private taken = false;
	private heartbeat: ReturnType<typeof setTimeout> | undefined;

	/**
	 * @param lastClose How the window that had the ledger before let go of it: as it went - quit, closed or
	 * reloaded - or as Facade let go of its agents while the window stayed, and which window that was.
	 * Undefined where it crashed, its lock left behind, or for the first window there, which finds none.
	 */
	private constructor(readonly dir: string, readonly state: WorkspaceState, private readonly mark: string, private readonly options: LedgerOptions, readonly lastClose: LastClose | undefined) { }

	/** Opens the ledger in `dir`, taking its lock; throws `LedgerLockedError` while another window has it. */
	static open(dir: string, options: LedgerOptions = {}): Ledger {
		fs.mkdirSync(dir, { recursive: true });
		const mark = `${process.pid} ${crypto.randomBytes(6).toString('hex')}`;
		const found = acquireLock(dir, mark, options.isRunning ?? isProcessRunning, options.owner);
		const lastClose = found && {
			by: found.by,
			ownWindow: found.owner === options.owner,
			thisWindow: found.session !== undefined && found.session === options.session
		};
		try {
			const ledger = new Ledger(dir, load(dir, options.mayMoveAside, options.onMovedAside), mark, options, lastClose);
			ledger.scheduleHeartbeat();
			return ledger;
		} catch (err) {
			releaseLock(dir, mark, undefined);
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
				// The window stays: it is Facade that lets go
				this.close('facade');
			}
			throw err;
		}
		applyEvent(this.state, event);
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// One who listens is not the ledger's to answer for
			}
		}
		return event;
	}

	/** Hears each event once it is written and applied. */
	onDidAppend(listener: (event: LedgerEvent) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/**
	 * Closes the ledger: its lock says it was closed - by its window as it goes, or by Facade, the window
	 * staying - and by whom, if it is still this window's, for a reload to take it back.
	 */
	close(by: ClosedBy = 'window'): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearTimeout(this.heartbeat);
		if (this.fd !== undefined) {
			fs.closeSync(this.fd);
			this.fd = undefined;
		}
		releaseLock(this.dir, this.mark, by, this.options.owner, this.options.session);
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

/**
 * The state the ledger in `dir` records, after the repairs `Ledger` describes. One it cannot read is moved
 * aside, a new list beginning, where `mayMoveAside` says it may be; else it is left as it is, and loading
 * throws `LedgerUnreadableError`.
 */
function load(dir: string, mayMoveAside: (() => boolean) | undefined, onMovedAside?: (why: string, keptAs: string) => void): WorkspaceState {
	const file = path.join(dir, LEDGER_FILE);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return createState();
		}
		throw err;
	}
	const unreadable = (why: string, aside: string): WorkspaceState => {
		if (!mayMoveAside?.()) {
			throw new LedgerUnreadableError(file, why);
		}
		const keptAs = path.join(dir, `${aside}.${Date.now()}.jsonl`);
		fs.renameSync(file, keptAs);
		onMovedAside?.(why, keptAs);
		return createState();
	};
	const content = bytes.toString('utf8');
	const lines = content.split('\n');
	// What follows the last line break was cut short by a crash.
	const complete = lines.slice(0, -1);
	const version = versionOf(complete);
	if (version !== undefined && !READ_VERSIONS.has(version)) {
		return unreadable(`${file} is a ledger of version ${version}, which this Facade does not read`, `ledger.v${version}`);
	}
	const state = createState();
	for (const [index, line] of complete.entries()) {
		if (!line.trim()) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return unreadable(`Line ${index + 1} of ${file} is not an event Facade can read`, 'ledger.unreadable');
		}
		const event = isJsonObject(parsed) && READ_VERSIONS.has(parsed.v) && parsed.seq === state.seq + 1 ? eventOf(parsed) : undefined;
		if (!event || !fitsState(state, event)) {
			return unreadable(`Line ${index + 1} of ${file} is not an event Facade can read`, 'ledger.unreadable');
		}
		applyEvent(state, event);
	}
	if (lines[lines.length - 1] !== '') {
		// At the last line break of what is on disk: counted in its bytes, not in text decoded from them (X-13)
		fs.truncateSync(file, bytes.lastIndexOf(0x0a) + 1);
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

/** A lock that says its ledger was closed: how, by which owner, and in which window load. */
interface ClosedLock {
	readonly by: ClosedBy;
	readonly owner: string | undefined;
	readonly session: string | undefined;
}

/** What a lock says of its ledger's closing - `<how> <owner> <window load>`, a word not known `-` - undefined for one a window holds. */
function closedLockOf(content: string): ClosedLock | undefined {
	const [word, owner, session] = content.trim().split(' ');
	const by: ClosedBy | undefined = word === CLOSED ? 'window' : word === RELEASED ? 'facade' : undefined;
	const known = (value: string | undefined) => value && value !== UNKNOWN ? value : undefined;
	return by && { by, owner: known(owner), session: known(session) };
}

/** Whether a lock says its ledger was closed. */
function isClosed(content: string): boolean {
	return closedLockOf(content) !== undefined;
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
 * aside first, so that of two windows finding it so at once only one takes it. Answers what the lock
 * taken over said of the ledger's closing, where it did.
 */
function acquireLock(dir: string, mark: string, isRunning: (pid: number) => boolean, owner: string | undefined): ClosedLock | undefined {
	const file = path.join(dir, LOCK_FILE);
	let found: string | undefined;
	for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
		if (attempt > 1) {
			sleepSync(LOCK_RETRY_MS);
		}
		try {
			fs.writeFileSync(file, mark, { flag: 'wx', mode: 0o600 });
			return found === undefined ? undefined : closedLockOf(found);
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
		found = content;
		const holder = holderOf(content);
		if (holder !== undefined && holder !== process.pid && isHolding(file, holder, isRunning)) {
			throw new LedgerLockedError(holder, touchedAt(file));
		}
		const closed = closedLockOf(content);
		if (closed?.owner !== undefined && closed.owner !== owner && isTouchedWithin(file, RELOAD_MS)) {
			throw new LedgerLockedError(undefined, touchedAt(file), closed.by);
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

/**
 * Lets go of this opening's lock; a ledger that was closed - by its window, or by Facade - leaves a lock
 * that says so, by which owner, in which window load, with the time.
 */
function releaseLock(dir: string, mark: string, closedBy: ClosedBy | undefined, owner?: string, session?: string): void {
	const file = path.join(dir, LOCK_FILE);
	try {
		if (!ownsLock(dir, mark)) {
			return;
		}
		if (closedBy) {
			const word = closedBy === 'window' ? CLOSED : RELEASED;
			fs.writeFileSync(file, session !== undefined ? `${word} ${owner ?? UNKNOWN} ${session}` : owner !== undefined ? `${word} ${owner}` : word);
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
		? isHolding(file, holder, isRunning)
		: isClosed(content) && isTouchedWithin(file, RELOAD_MS);
}

/**
 * Who closed the ledger in `dir` as its window went - quit, closed, or reloaded - where no window has it
 * now: the owner and window load its lock names. Undefined for one a window holds or closed a moment ago,
 * one Facade let go of while its window stayed, and one a window left as it ended without closing it.
 */
export function closedByItsWindow(dir: string, isRunning: (pid: number) => boolean = isProcessRunning): { readonly owner?: string; readonly session?: string } | undefined {
	if (isLedgerHeld(dir, isRunning)) {
		return undefined;
	}
	let content: string | undefined;
	try {
		content = readLock(dir);
	} catch {
		return undefined;
	}
	const closed = content === undefined ? undefined : closedLockOf(content);
	return closed?.by === 'window' ? { ...(closed.owner !== undefined ? { owner: closed.owner } : {}), ...(closed.session !== undefined ? { session: closed.session } : {}) } : undefined;
}

/**
 * Whether the window whose process `holder` wrote the lock `file` still has it: its process runs, and
 * touched the lock lately - or, untouched for long, still is Facade's program. A window that stands still
 * keeps its ledger: nothing takes it over by the time alone (AGENT-LAUNCHER.md, L12). Only a process id
 * that another program has by now, its lock untouched, is no window's.
 */
function isHolding(file: string, holder: number, isRunning: (pid: number) => boolean): boolean {
	return isRunning(holder) && (isTouchedWithin(file, HELD_MS) || isSameProgram(holder) === true);
}

/**
 * What the lock in `dir` says of its window: whether one holds it now - its process runs, and touches it -
 * and the window load that closed it, where a window, or Facade in it, did. A lock another program holds
 * open too long to be read counts as held.
 */
export function lockStateOf(dir: string, isRunning: (pid: number) => boolean = isProcessRunning): { readonly held: boolean; readonly closedIn?: string } {
	let content: string | undefined;
	try {
		content = readLock(dir);
	} catch {
		return { held: true };
	}
	if (content === undefined) {
		return { held: false };
	}
	const holder = holderOf(content);
	if (holder !== undefined) {
		return { held: isHolding(path.join(dir, LOCK_FILE), holder, isRunning) };
	}
	const session = closedLockOf(content)?.session;
	return { held: false, ...(session !== undefined ? { closedIn: session } : {}) };
}
