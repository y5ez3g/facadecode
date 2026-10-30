/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawnSync } from 'child_process';
import * as path from 'path';
import { codeOf } from './errors';

/**
 * Whether the running process `pid` runs the same program as this one - another Facade window's extension
 * host, say - rather than whatever program got its id after the one that had it ended; undefined where
 * the system cannot tell (Windows).
 */
export function isSameProgram(pid: number): boolean | undefined {
	if (process.platform === 'win32') {
		return undefined;
	}
	const found = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
	const program = found.status === 0 ? found.stdout.trim() : '';
	return program ? path.basename(program) === path.basename(process.execPath) : false;
}

/** How long reading a process's start may take before it is taken as unknown. */
const PROCESS_READ_TIMEOUT_MS = 5_000;

/**
 * When the process `pid` started, in milliseconds since the epoch, to the second; undefined where it is gone,
 * or the system does not say (Windows).
 */
export function processStartedAt(pid: number): number | undefined {
	if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	const found = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' } });
	const time = found.status === 0 ? Date.parse(found.stdout.trim()) : NaN;
	return Number.isNaN(time) ? undefined : time;
}

/** How long a process's start time, once read, is taken as it is: a process's start does not change while it runs. */
const START_KEPT_MS = 60_000;
const startsRead = new Map<number, { readonly start: number | undefined; readonly at: number }>();

/**
 * When the process `pid` started, in milliseconds since the epoch, on every system - which, with its id, tells a process
 * from a later one that got the same id: on Windows as PowerShell reads it, which takes a moment, so an answer is kept a
 * while. Undefined where it is gone or the system does not say. This process's own is known without asking.
 */
export function processStartTime(pid: number, fresh = false): number | undefined {
	if (pid === process.pid) {
		return ownStart;
	}
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	const kept = startsRead.get(pid);
	if (!fresh && kept && Date.now() - kept.at < START_KEPT_MS) {
		return kept.start;
	}
	const asked = Date.now();
	let start: number | undefined;
	if (process.platform === 'win32') {
		const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: PROCESS_READ_TIMEOUT_MS, windowsHide: true });
		const time = found.status === 0 ? Date.parse(found.stdout.trim()) : NaN;
		start = Number.isNaN(time) ? undefined : time;
	} else {
		start = processStartedAt(pid);
	}
	keepStart(pid, start, asked);
	return start;
}

/**
 * Keeps what was read of `pid`'s start, as of `asked`, when the system was asked - never over what a later question
 * read: a process born after the question began is not told by its answer.
 */
function keepStart(pid: number, start: number | undefined, asked: number): void {
	const kept = startsRead.get(pid);
	if (!kept || kept.at <= asked) {
		startsRead.set(pid, { start, at: asked });
	}
}

/** The reads of a process's start under way, by its id: those that ask for it meanwhile share one. */
const startsReading = new Map<number, Promise<number | undefined>>();

/**
 * As `processStartTime`, without holding up the extension host while the system is asked: from what was read a moment
 * ago - not `fresh` - or one read for all those that ask for it at once.
 */
export function processStartTimeAsync(pid: number, fresh = false): Promise<number | undefined> {
	if (pid === process.pid || process.platform !== 'win32') {
		return Promise.resolve(processStartTime(pid, fresh));
	}
	const kept = startsRead.get(pid);
	if (!fresh && kept && Date.now() - kept.at < START_KEPT_MS) {
		return Promise.resolve(kept.start);
	}
	// A fresh read asks anew: one under way may have been asked before what it is to tell apart was born
	const shared = fresh ? undefined : startsReading.get(pid);
	if (shared) {
		return shared;
	}
	const asked = Date.now();
	const reading = new Promise<number | undefined>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: PROCESS_READ_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
		const time = err ? NaN : Date.parse(String(stdout).trim());
		const start = Number.isNaN(time) ? undefined : time;
		keepStart(pid, start, asked);
		if (startsReading.get(pid) === reading) {
			startsReading.delete(pid);
		}
		resolve(start);
	}));
	if (!fresh) {
		startsReading.set(pid, reading);
	}
	return reading;
}

/**
 * When `pid` started, as `processStartTime` keeps it - read again where what it kept says another start than `recorded`:
 * the id may have been given anew since it was kept, and a process that runs under it is not taken for another for that.
 */
export function processStartTimeOf(pid: number, recorded: number): number | undefined {
	const read = processStartTime(pid);
	// The latest kept, whichever answer came last - unknown too, never an older one for it; this process's own, never kept, as read
	return againIfBefore(pid, recorded) ? processStartTime(pid, true) : latestOf(pid, read);
}

/** As `processStartTimeOf`, without holding up the extension host while the system is asked. */
export async function processStartTimeOfAsync(pid: number, recorded: number): Promise<number | undefined> {
	const read = await processStartTimeAsync(pid);
	return againIfBefore(pid, recorded) ? processStartTimeAsync(pid, true) : latestOf(pid, read);
}

/** The latest start kept of `pid`, as the latest question answered it - unknown too; `read` where none is kept. */
function latestOf(pid: number, read: number | undefined): number | undefined {
	const kept = startsRead.get(pid);
	return kept ? kept.start : read;
}

/**
 * Whether the start kept of `pid` - the latest asked, whichever answer came last - is another than `recorded`, the start a
 * record names, and was asked before it: perhaps of a process that had the id before the one recorded, which is read
 * again. One asked after it, and still another start, is the system's word.
 */
function againIfBefore(pid: number, recorded: number): boolean {
	const kept = startsRead.get(pid);
	return !!kept && kept.start !== undefined && !isSameStart(kept.start, recorded) && kept.at < recorded;
}

/** When this process started, as its own clock says. */
const ownStart = Date.now() - Math.round(process.uptime() * 1000);

/** How far two readings of one process's start may differ: one system says it to the second, another to the millisecond. */
const SAME_START_MS = 2_000;

/** Whether two readings of a process's start are of the same start. */
export function isSameStart(one: number, other: number): boolean {
	return Math.abs(one - other) <= SAME_START_MS;
}

/** Whether the operating system process `pid` is running, including one of another user's. */
export function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return codeOf(err) === 'EPERM';
	}
}
