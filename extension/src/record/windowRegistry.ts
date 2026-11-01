/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';
import { Allocation, DirectoryAgent, isDirectoryAgent, WINDOW_NETWORK_PROTOCOL } from '../base/windowNetwork';

/** One open window as its window component registers it on this computer (ARCHITECTURE-2.1, 3.1). */
export interface RegisteredWindow {
	readonly protocol: number;
	readonly window: string;
	/** Where its window component listens: a socket path, or a named pipe on Windows. */
	readonly socket: string;
	/** Its local extension host's process: gone, the entry is stale. */
	readonly pid: number;
	/**
	 * When that process started, as it says itself: with its id it tells it from a later process given the same id once its window
	 * went without saying so (ARCHITECTURE-2.1). Absent from an entry an earlier build wrote.
	 */
	readonly started?: number;
	/** This start of its window component, which alone removes the entry it wrote: never its successor's. */
	readonly incarnation?: string;
	readonly label: string;
	readonly environment: string;
	readonly agents: readonly DirectoryAgent[];
	readonly updatedAt: number;
}

const ENTRY = /^win-[0-9a-f]{16}\.json$/;

/**
 * The folder of the open windows' entries in this computer's Facade directory `home`: a folder of its own, apart from the window
 * handover records of `windows/`, which are pruned by age (ARCHITECTURE-3.1).
 */
export function registryOf(home: string): string {
	return path.join(home, 'network');
}

function entryFile(home: string, window: string): string {
	if (!/^win-[0-9a-f]{16}$/.test(window)) {
		throw new Error(`${JSON.stringify(window)} is not a window address.`);
	}
	return path.join(registryOf(home), `${window}.json`);
}

/**
 * Writes this window's entry whole, so that a reader sees the old one or the new one; under the entry's lock, which a stale entry's
 * removal takes too, so that no removal takes a newer entry than the one it found stale.
 */
export function registerWindow(home: string, entry: RegisteredWindow): void {
	fs.mkdirSync(registryOf(home), { recursive: true, mode: 0o700 });
	const file = entryFile(home, entry.window);
	withFileLock(file, () => replaceFile(file, `${JSON.stringify(entry)}\n`));
}

/**
 * Removes this window's entry as its window component stops: only the one `incarnation` wrote, never what a successor of it
 * registered meanwhile - a late shutdown of the component's previous start (ARCHITECTURE-2.1).
 */
export function unregisterWindow(home: string, window: string, incarnation?: string): void {
	const file = entryFile(home, window);
	withFileLock(file, () => {
		const entry = readEntry(file);
		if (incarnation === undefined || entry === undefined || entry.incarnation === incarnation) {
			fs.rmSync(file, { force: true });
		}
	});
}

/**
 * Removes the entry `stale` of a window found gone - its process ended or is another program now, or its socket answers no more -
 * where it is still the entry found so: one its window wrote since stays (ARCHITECTURE-2.1).
 */
export function removeStaleWindow(home: string, stale: RegisteredWindow): void {
	const file = entryFile(home, stale.window);
	withFileLock(file, () => {
		const entry = readEntry(file);
		if (entry && entry.incarnation === stale.incarnation && entry.pid === stale.pid && entry.updatedAt === stale.updatedAt && entry.socket === stale.socket) {
			fs.rmSync(file, { force: true });
		}
	});
}

/** The entry `window` has now, where it has a valid one. */
export function registeredWindow(home: string, window: string): RegisteredWindow | undefined {
	return readEntry(entryFile(home, window));
}

function readEntry(file: string): RegisteredWindow | undefined {
	let entry: unknown;
	try {
		entry = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
	return isRegisteredWindow(entry) && `${entry.window}.json` === path.basename(file) ? entry : undefined;
}

/**
 * The windows registered on this computer, read as they are now. An entry of a process that is gone is stale - its window closed
 * without saying so - and is removed; one that cannot be read is skipped, never guessed.
 */
export function registeredWindows(home: string, alive: (pid: number) => boolean = isAlive): RegisteredWindow[] {
	let names: string[];
	try {
		names = fs.readdirSync(registryOf(home)).filter(name => ENTRY.test(name));
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return [];
		}
		throw err;
	}
	const windows: RegisteredWindow[] = [];
	for (const name of names) {
		const entry = readEntry(path.join(registryOf(home), name));
		if (!entry) {
			continue;
		}
		if (!alive(entry.pid)) {
			removeStaleWindow(home, entry);
			continue;
		}
		windows.push(entry);
	}
	return windows.sort((a, b) => a.window.localeCompare(b.window));
}

function isRegisteredWindow(value: unknown): value is RegisteredWindow {
	return isJsonObject(value) && Number.isSafeInteger(value.protocol) && typeof value.window === 'string' && typeof value.socket === 'string'
		&& Number.isSafeInteger(value.pid) && typeof value.label === 'string' && typeof value.environment === 'string'
		&& Array.isArray(value.agents) && value.agents.every(isDirectoryAgent) && typeof value.updatedAt === 'number'
		&& (value.started === undefined || Number.isFinite(value.started)) && (value.incarnation === undefined || (typeof value.incarnation === 'string' && !!value.incarnation));
}

/** Whether the process `pid` runs: one another user owns counts, as it may still be a window of this person's in another session. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return codeOf(err) === 'EPERM';
	}
}

/** Whether `entry` speaks this window component's protocol. */
export function speaksOurs(entry: RegisteredWindow): boolean {
	return entry.protocol === WINDOW_NETWORK_PROTOCOL;
}

/**
 * Takes `count` numbers for `kind` - `#aN` agent or `#mN` message aliases - from this computer's counter, under its lock, so that no
 * two windows, local or remote, ever give the same number (RULES-1.1, 2.2). A counter that cannot be read is an error, never a
 * count from nothing; `floor` moves it past numbers already given by an earlier counter.
 */
export function allocateNumbers(home: string, kind: 'agent' | 'message', count: number, floor = 0): Allocation {
	if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
		throw new Error('Numbers are taken from 1 to 1000 at a time.');
	}
	fs.mkdirSync(home, { recursive: true });
	const file = path.join(home, `client-${kind}-numbers.json`);
	return withFileLock(file, () => {
		let last = 0;
		let text: string | undefined;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch (err) {
			if (codeOf(err) !== 'ENOENT') {
				throw new Error(`The ${kind} number counter ${file} cannot be read: ${messageOf(err)}`);
			}
		}
		if (text !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = undefined;
			}
			const value = isJsonObject(parsed) ? parsed.last : undefined;
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
				throw new Error(`The ${kind} number counter ${file} does not hold a number; Facade gives no alias it may have given before.`);
			}
			last = value;
		}
		const first = Math.max(last, Math.max(0, Math.floor(floor))) + 1;
		replaceFile(file, `${JSON.stringify({ last: first + count - 1 })}\n`);
		return { first, count };
	});
}
