/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sleepSync } from './async';
import { codeOf } from './errors';
import { isProcessRunning, isSameProgram, isSameStart, processStartTime, processStartTimeOf, processStartTimeOfAsync } from './system';

/** A lock older than this was left behind by a holder that ended: what a lock guards takes milliseconds. */
const STALE_AFTER_MS = 2_000;
/** A lock older than this is taken over even if the process it names still runs: its id may have been reused. */
const ABANDONED_AFTER_MS = 30_000;
/**
 * A lock another program takes in proper-lockfile's way - a folder at the same path, as Claude Code
 * locks its configuration - whose holder touches it while it holds it: older than this, it was left
 * behind, as proper-lockfile itself takes it to be.
 */
const FOLDER_LOCK_STALE_MS = 10_000;
/** How long `withFileLock` waits for another holder. */
const WAIT_MS = 5_000;
const RETRY_MS = 20;
/** How often letting go of a lock is asked again where the system refuses it a moment. */
const RELEASE_RETRIES = 5;
/**
 * A hold on breaking older than this is taken over even from a breaker that runs: one it could not remove as it let go,
 * which a process that breaks no lock again never takes itself; one paused this long - a machine put to sleep - is not waited for.
 */
const HOLD_FORSAKEN_MS = 10 * 60_000;

/** Runs `fn` while holding a lock on `file`; for a file that several windows read and write. */
export type FileLock = <T>(file: string, fn: () => T) => T;

/**
 * How a lock is taken: `keepLive`, never over a holder whose process still runs, whatever the lock's age - only once it
 * ended, or its process id is another process's, which the start time the lock records tells - as the machine's counters
 * are (AGENT-LAUNCHER.md, L12). Where neither start time can be read, the program decides, and where that cannot be told
 * either, the age, as for any lock.
 */
export interface FileLockOptions {
	readonly keepLive?: boolean;
	/**
	 * How long to wait for another holder before giving up - `WAIT_MS` where left out: for a lock its callers have already
	 * waited for without holding up the event loop (`breakStaleLock`), a short wait for a holder that is just letting go.
	 */
	readonly waitMs?: number;
}

/**
 * The marks of the locks this process holds now. One of this process's marks found on a lock it does not hold was left as
 * it could not let go of it - the system refused the removal - and is taken over, whatever `keepLive` says.
 */
const holding = new Set<string>();

/**
 * Runs `fn` while holding `<file>.lock`, which one process at a time can hold. It waits without
 * returning to the event loop, since callers hold it for a synchronous read and write only. Each holder
 * writes its own mark into the lock and removes only a lock that still has that mark. A folder at that
 * path is another program's lock, taken as proper-lockfile takes one, and is waited for as well.
 */
export function withFileLock<T>(file: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = `${file}.lock`;
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	const mark = `${process.pid} ${processStartTime(process.pid) ?? '-'} ${crypto.randomBytes(6).toString('hex')}`;
	if (leftHeld.size) {
		letGoAgain();
	}
	const waitMs = options.waitMs ?? WAIT_MS;
	const deadline = Date.now() + waitMs;
	while (!tryAcquire(lock, mark, options)) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${secondsOf(waitMs)} waiting for another window to release the lock on '${file}'.`);
		}
		sleepSync(RETRY_MS);
	}
	holding.add(mark);
	try {
		return fn();
	} finally {
		holding.delete(mark);
		release(lock, mark);
	}
}

function tryAcquire(lock: string, mark: string, options: FileLockOptions): boolean {
	if (tryTake(lock, mark)) {
		return true;
	}
	breakIfStale(lock, options);
	return false;
}

/** Takes `lock` where nobody holds it: false where another does. */
function tryTake(lock: string, mark: string): boolean {
	try {
		fs.writeFileSync(lock, mark, { flag: 'wx' });
		return true;
	} catch (err) {
		// Windows fails with EPERM while another process is deleting the lock.
		if (!['EEXIST', 'EPERM'].includes(codeOf(err) ?? '')) {
			throw err;
		}
		return false;
	}
}

function release(lock: string, mark: string): void {
	try {
		if (fs.readFileSync(lock, 'utf8') === mark) {
			removeRetried(lock);
		}
	} catch {
		// Already gone - or refused still: let go of again a second at a time, and as this process takes any lock, since
		// another holder takes it over only once its holder ended (this process takes its own back as it comes to it)
		if (fs.existsSync(lock)) {
			leftHeld.set(lock, { mark, since: Date.now() });
			letGoLater();
		}
	}
}

/** The locks this process could not let go of, by file: its mark there, and since when. */
const leftHeld = new Map<string, { readonly mark: string; readonly since: number }>();
/** How long a lock this process could not let go of is let go of again - a second apart, and as it takes any lock. */
const LET_GO_FOR_MS = 60_000;
let lettingGo: ReturnType<typeof setTimeout> | undefined;

/** Lets go again of the locks this process could not let go of, now and - while some are left - a second on. */
function letGoAgain(): void {
	for (const [lock, left] of leftHeld) {
		try {
			if (fs.readFileSync(lock, 'utf8') === left.mark) {
				fs.rmSync(lock, { force: true });
			}
			leftHeld.delete(lock);
		} catch (err) {
			// However often it is tried meanwhile, it is given up only once its time is over
			if (codeOf(err) === 'ENOENT' || Date.now() - left.since > LET_GO_FOR_MS) {
				leftHeld.delete(lock);
			}
		}
	}
	letGoLater();
}

/** Has `letGoAgain` run a second on while locks are left to let go of, without keeping the process alive for it. */
function letGoLater(): void {
	if (leftHeld.size && !lettingGo) {
		lettingGo = setTimeout(() => {
			lettingGo = undefined;
			letGoAgain();
		}, 1_000);
		lettingGo.unref?.();
	}
}

/** Removes `file`, asked again a few times where Windows refuses it a moment while another process reads it. */
function removeRetried(file: string): void {
	for (let tries = 0; ; tries++) {
		try {
			fs.rmSync(file, { force: true });
			return;
		} catch (err) {
			if (!['EPERM', 'EBUSY'].includes(codeOf(err) ?? '') || tries >= RELEASE_RETRIES) {
				throw err;
			}
			sleepSync(RETRY_MS);
		}
	}
}

/**
 * What is known of `lock` as another wants it: held - by a holder that keeps it, or too new to tell - or left behind,
 * with the mark it was found with; or, with `keepLive`, held by a process that still runs, whose start alone tells
 * whether it is the holder's. Another program's folder is waited for while its holder touches it, and removed once it
 * no longer does.
 */
function stalenessOf(lock: string, keepLive: boolean): { readonly kind: 'held' } | { readonly kind: 'left'; readonly mark: string } | { readonly kind: 'ask'; readonly mark: string; readonly holder: number; readonly recorded: number; readonly age: number } {
	try {
		const stat = fs.statSync(lock);
		const age = Date.now() - stat.mtimeMs;
		if (stat.isDirectory()) {
			if (age > FOLDER_LOCK_STALE_MS) {
				// Only while it is empty, as proper-lockfile leaves it.
				fs.rmdirSync(lock);
			}
			return { kind: 'held' };
		}
		if (age <= STALE_AFTER_MS) {
			return { kind: 'held' };
		}
		const mark = fs.readFileSync(lock, 'utf8');
		const [pid, started] = mark.split(' ');
		const holder = Number(pid);
		// Gone; or this process's own, which it does not hold: left as it could not let go of it
		if (!isProcessRunning(holder) || (holder === process.pid && !holding.has(mark))) {
			return { kind: 'left', mark };
		}
		if (!keepLive) {
			return age <= ABANDONED_AFTER_MS ? { kind: 'held' } : { kind: 'left', mark };
		}
		const recorded = Number(started);
		return Number.isFinite(recorded) && started !== '-' ? { kind: 'ask', mark, holder, recorded, age } : stillHeld(mark, holder, undefined, recorded, age);
	} catch {
		return { kind: 'held' };
	}
}

/** Whether a lock whose holder's process runs is still that holder's, by its start `now` - where it cannot be read, by its program, then its age. */
function stillHeld(mark: string, holder: number, now: number | undefined, recorded: number, age: number): { readonly kind: 'held' } | { readonly kind: 'left'; readonly mark: string } {
	return (now !== undefined ? isSameStart(now, recorded) : (age <= ABANDONED_AFTER_MS || isSameProgram(holder) === true)) ? { kind: 'held' } : { kind: 'left', mark };
}

/**
 * Removes a lock its holder left behind: older than any holder keeps one, or its holder gone - with `keepLive`, its
 * holder gone alone. The holder's start is read here without returning to the event loop, which takes a moment on
 * Windows - for a lock held past `STALE_AFTER_MS` by a running process alone, and from what `breakStaleLock` read a
 * moment before where a caller waited for the lock with it first, as the machine's counters do.
 */
function breakIfStale(lock: string, { keepLive }: FileLockOptions): void {
	const found = stalenessOf(lock, !!keepLive);
	const judged = found.kind === 'ask' ? stillHeld(found.mark, found.holder, processStartTimeOf(found.holder, found.recorded), found.recorded, found.age) : found;
	if (judged.kind === 'left') {
		removeLockIfUnchanged(lock, judged.mark);
	}
}

/** `ms` in seconds as words say it: `1 second`, `5 seconds`, `0.3 seconds`. */
function secondsOf(ms: number): string {
	const seconds = Math.round(ms / 100) / 10;
	return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/** How often `withLongFileLock` looks again for a lock another holder has. */
const LONG_RETRY_MS = 100;

/**
 * Runs `fn` while holding `<file>.lock`, as `withFileLock` does, for work that takes a while - git making a worktree -
 * waiting for another holder without holding up the event loop, for up to `waitMs`: never taken over from a holder whose
 * process still runs, as `keepLive` has it. Throws once the wait is over.
 */
export async function withLongFileLock<T>(file: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
	const lock = `${file}.lock`;
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	const mark = `${process.pid} ${processStartTime(process.pid) ?? '-'} ${crypto.randomBytes(6).toString('hex')}`;
	if (leftHeld.size) {
		letGoAgain();
	}
	const deadline = Date.now() + waitMs;
	while (!tryTake(lock, mark)) {
		await breakStaleLock(lock);
		if (tryTake(lock, mark)) {
			break;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${secondsOf(waitMs)} waiting for another window to release the lock on '${file}'.`);
		}
		await new Promise(resolve => setTimeout(resolve, LONG_RETRY_MS));
	}
	holding.add(mark);
	try {
		return await fn();
	} finally {
		holding.delete(mark);
		release(lock, mark);
	}
}

/**
 * Removes a lock its holder left behind as `breakIfStale` does with `keepLive`, the holder's start read without holding
 * up the event loop: never over a holder whose process still runs. The start it reads is kept a while, so that a
 * `withFileLock` right after reads it without asking the system again.
 */
export async function breakStaleLock(lock: string): Promise<void> {
	const found = stalenessOf(lock, true);
	const judged = found.kind === 'ask' ? stillHeld(found.mark, found.holder, await processStartTimeOfAsync(found.holder, found.recorded), found.recorded, found.age) : found;
	if (judged.kind === 'left') {
		removeLockIfUnchanged(lock, judged.mark);
	}
}

/**
 * Removes the lock file `lock` if it still holds `content`, as read when it was found left behind. One process at a time
 * breaks a lock: it holds `<lock>.break` while it reads the lock again and removes it only if it is still that one. Nobody
 * takes the lock while it is there, so the lock it removes is the one it found, and a lock taken anew - after another
 * breaker removed the one left behind - stays. The hold says its breaker's process id and start, written whole before it
 * is there: it goes once that process has ended - its id none's, or another's by its start - or, where that cannot be told,
 * once it is older than `ABANDONED_AFTER_MS`. A breaker that runs keeps it for `HOLD_FORSAKEN_MS`, past any pause but
 * a machine put to sleep, or a hold the system would not let it remove, which it takes away itself as it breaks again.
 * Not closed here: a breaker ending within the milliseconds it holds it while two others take its hold away at once; and
 * one stopped longer than `HOLD_FORSAKEN_MS` between reading the lock and removing it, which then removes the lock
 * another took meanwhile.
 */
export function removeLockIfUnchanged(lock: string, content: string): void {
	const breaking = `${lock}.break`;
	const mine = `${process.pid} ${processStartTime(process.pid) ?? '-'} ${crypto.randomBytes(6).toString('hex')}`;
	if (!publishOnce(breaking, mine)) {
		// Another breaks it now; or one that ended left its hold, which goes for the next try
		try {
			const held = fs.readFileSync(breaking, 'utf8');
			const age = Date.now() - fs.statSync(breaking).mtimeMs;
			// This process's own, which it could not remove as it let go - it breaks one at a time - or one kept past any pause
			const own = held.startsWith(`${process.pid} ${processStartTime(process.pid) ?? '-'} `);
			if (own || (breakerEnded(held) ?? age > ABANDONED_AFTER_MS) || age > HOLD_FORSAKEN_MS) {
				removeIfStill(breaking, held);
			}
		} catch {
			// Gone meanwhile.
		}
		return;
	}
	try {
		if (fs.readFileSync(lock, 'utf8') === content) {
			fs.rmSync(lock, { force: true });
		}
	} catch {
		// Gone meanwhile.
	} finally {
		// Its own hold alone: one taken from it - its process taken for ended - is another's now
		release(breaking, mine);
	}
}

/** Puts `content` at `file`, whole, where nothing is there yet: false where something is. */
function publishOnce(file: string, content: string): boolean {
	const made = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
	fs.writeFileSync(made, content);
	try {
		fs.linkSync(made, file);
		return true;
	} catch (err) {
		if (!['EEXIST', 'EPERM'].includes(codeOf(err) ?? '')) {
			throw err;
		}
		return false;
	} finally {
		fs.rmSync(made, { force: true });
	}
}

/**
 * Whether the breaker whose hold says `held` - its process id and start - has ended: its id another process's, or none's;
 * undefined where that cannot be told, which its age then tells.
 */
function breakerEnded(held: string): boolean | undefined {
	const [pid, started] = held.split(' ');
	const breaker = Number(pid);
	const recorded = Number(started);
	if (!Number.isInteger(breaker) || breaker <= 0) {
		return undefined;
	}
	if (!isProcessRunning(breaker)) {
		return true;
	}
	const now = Number.isFinite(recorded) && started !== '-' ? processStartTimeOf(breaker, recorded) : undefined;
	return now === undefined ? undefined : !isSameStart(now, recorded);
}

/** Removes `file` if it still holds `content`; a breaker's hold taken anew in between is another's, and stays. */
function removeIfStill(file: string, content: string): void {
	const aside = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
	try {
		fs.renameSync(file, aside);
	} catch {
		return;
	}
	if (fs.readFileSync(aside, 'utf8') !== content) {
		// Taken anew by a breaker that runs: put back where nobody holds it since
		try {
			fs.linkSync(aside, file);
		} catch {
			// Another holds it now.
		}
	}
	fs.rmSync(aside, { force: true });
}
