/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sleepSync } from './async';
import { codeOf } from './errors';
import { isProcessRunning } from './system';

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

/** Runs `fn` while holding a lock on `file`; for a file that several windows read and write. */
export type FileLock = <T>(file: string, fn: () => T) => T;

/**
 * Runs `fn` while holding `<file>.lock`, which one process at a time can hold. It waits without
 * returning to the event loop, since callers hold it for a synchronous read and write only. Each holder
 * writes its own mark into the lock and removes only a lock that still has that mark. A folder at that
 * path is another program's lock, taken as proper-lockfile takes one, and is waited for as well.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`;
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	const mark = `${process.pid} ${crypto.randomBytes(6).toString('hex')}`;
	const deadline = Date.now() + WAIT_MS;
	while (!tryAcquire(lock, mark)) {
		if (Date.now() > deadline) {
			throw new Error(`${file} stayed locked by another window for ${WAIT_MS / 1000} seconds.`);
		}
		sleepSync(RETRY_MS);
	}
	try {
		return fn();
	} finally {
		release(lock, mark);
	}
}

function tryAcquire(lock: string, mark: string): boolean {
	try {
		fs.writeFileSync(lock, mark, { flag: 'wx' });
		return true;
	} catch (err) {
		// Windows fails with EPERM while another process is deleting the lock.
		if (!['EEXIST', 'EPERM'].includes(codeOf(err) ?? '')) {
			throw err;
		}
		breakIfStale(lock);
		return false;
	}
}

function release(lock: string, mark: string): void {
	try {
		if (fs.readFileSync(lock, 'utf8') === mark) {
			fs.rmSync(lock, { force: true });
		}
	} catch {
		// Already gone.
	}
}

/**
 * Removes a lock its holder left behind: older than any holder keeps one, or its holder gone. Another
 * program's folder is waited for while its holder touches it, and removed once it no longer does.
 */
function breakIfStale(lock: string): void {
	let mark: string;
	try {
		const stat = fs.statSync(lock);
		const age = Date.now() - stat.mtimeMs;
		if (stat.isDirectory()) {
			if (age > FOLDER_LOCK_STALE_MS) {
				// Only while it is empty, as proper-lockfile leaves it.
				fs.rmdirSync(lock);
			}
			return;
		}
		if (age <= STALE_AFTER_MS) {
			return;
		}
		mark = fs.readFileSync(lock, 'utf8');
		if (age <= ABANDONED_AFTER_MS && isProcessRunning(Number(mark.split(' ')[0]))) {
			return;
		}
	} catch {
		return;
	}
	removeLockIfUnchanged(lock, mark);
}

/**
 * Removes the lock file `lock` if it still holds `content`, as read when it was found left behind. It is
 * first renamed to a name of this attempt's own, so that of processes finding it so at the same time only
 * one removes it, and a lock taken anew in between is put back. Should yet another lock have been taken
 * by then - three processes racing over one a holder left behind - the one renamed aside is lost.
 */
export function removeLockIfUnchanged(lock: string, content: string): void {
	const aside = `${lock}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.stale`;
	try {
		fs.renameSync(lock, aside);
	} catch {
		// Another process moved it first.
		return;
	}
	try {
		if (fs.readFileSync(aside, 'utf8') !== content) {
			fs.linkSync(aside, lock);
		}
	} catch {
		// A lock was taken in its place meanwhile.
	} finally {
		fs.rmSync(aside, { force: true });
	}
}
