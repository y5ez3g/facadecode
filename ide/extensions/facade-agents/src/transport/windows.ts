/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sleepSync } from '../base/async';
import { codeOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { withFileLock } from '../base/lock';
import { isJsonObject } from '../base/json';
import { isProcessRunning, isSameStart, processStartTimeOfAsync } from '../base/system';
import { readWindowRecord, WindowFacts } from './endpoint';
import { PipeClient, PipeClientError, WINDOW_REQUEST_EXTRA_BYTES } from './pipe';
import { Progress } from './protocol';

/** How long a window has to answer a query of another's, before it counts as not answering (AGENT-ORCHESTRATION.md, O8). */
export const QUERY_MS = 3_000;
/** How often an empty key file is read again - another window may be writing it - before it is taken for one left half made. */
const KEY_TRIES = 5;
const KEY_RETRY_MS = 50;

/** A window of the machine, as its record says it is: where it listens, and what it is. */
export interface WindowEntry extends WindowFacts {
	/** Its record's id, which names it to the others. */
	readonly record: string;
	readonly dir: string;
	readonly pipe: string;
	readonly pid: number;
	readonly enabled: boolean;
	/** How the others name it: its workspace's name, its first folder and the start of its record's id (O6). */
	readonly label: string;
}

/** What a window answers another's hello with: who it is, and whether its agent framework is on. */
export interface WindowHello extends WindowFacts {
	readonly window: true;
	readonly record: string;
	readonly enabled: boolean;
}

/**
 * Why a window did not answer: it is silent - reloading, its extension host starting again, recovering from a renderer
 * crash, or hung - or its framework is off.
 */
export type SilentReason = 'not answering' | 'framework off';

/** A window that is gone: it closed - its record says it closes - or its application instance ended, as in a crash (O8). */
export interface GoneWindow {
	readonly record: string;
	readonly label: string;
	readonly dir: string;
	/** Whether its record says it was closing; else its application instance is gone, as in a crash. */
	readonly closed: boolean;
	readonly load?: string;
}

/** A window that did not answer, named, and why. */
export interface SilentWindow {
	readonly record: string;
	readonly label: string;
	readonly reason: SilentReason;
}

/** How a window names another: `lab (C:\src\lab, 1a2b3c4d)`. */
export function labelOf(facts: WindowFacts & { readonly record: string }): string {
	const short = facts.record.replace(/-/g, '').slice(0, 8);
	return `${facts.workspace ?? 'untitled'} (${[facts.folder, short].filter(Boolean).join(', ')})`;
}

/**
 * The machine's window key, in `file`: read, or made by the first window that needs it - exclusively, so that two making
 * it at once end with one - readable by the user only (AGENT-ORCHESTRATION.md, O8).
 */
export function windowKey(file: string): string {
	for (let tries = 0; ; tries++) {
		const kept = keyIn(file);
		if (kept) {
			return kept;
		}
		if (kept === undefined) {
			// None yet: made whole aside, then put in place where no other window put its own first
			const key = crypto.randomBytes(32).toString('base64url');
			const made = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(made, key, { mode: 0o600 });
			try {
				fs.linkSync(made, file);
				return key;
			} catch (err) {
				if (codeOf(err) !== 'EEXIST') {
					throw err;
				}
			} finally {
				fs.rmSync(made, { force: true });
			}
		} else if (tries >= KEY_TRIES) {
			// Empty, and staying so: what an earlier build left half made, or a write that failed. Made again by one window
			// at a time, which reads it again first: one another just made whole is kept (O8)
			return withFileLock(file, () => {
				const now = keyIn(file);
				if (now) {
					return now;
				}
				const key = crypto.randomBytes(32).toString('base64url');
				replaceFile(file, key);
				// Readable by the user alone, whatever the empty file it replaces was
				fs.chmodSync(file, 0o600);
				return key;
			});
		} else {
			sleepSync(KEY_RETRY_MS);
		}
	}
}

/** The key in `file`: undefined where there is none, empty where the file is. */
function keyIn(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8').trim();
	} catch (err) {
		if (codeOf(err) !== 'ENOENT') {
			throw err;
		}
		return undefined;
	}
}

/**
 * Of `entries`, those whose application instance's process id is another process's now - the instance ended, as in a
 * crash, and the id was given anew - as their start times say, read without holding up the extension host (O8).
 */
export async function startedAnew(entries: readonly WindowEntry[], startOf: (pid: number, recorded: number) => Promise<number | undefined> = processStartTimeOfAsync): Promise<WindowEntry[]> {
	const starts = await Promise.all(entries.map(entry => entry.instance?.start !== undefined ? startOf(entry.instance.pid, entry.instance.start) : Promise.resolve(undefined)));
	return entries.filter((entry, i) => {
		const start = starts[i];
		return start !== undefined && entry.instance?.start !== undefined && !isSameStart(start, entry.instance.start);
	});
}

/**
 * The other windows of the machine, as their records under `root` say, but `self`'s (O8): each found is there - live, or
 * silent while it reloads or hangs - and each gone has closed, its record saying it closes, or has an application instance
 * that no longer runs. No record at all is a window closed long ago, and is neither.
 */
export function windowsUnder(root: string, self: string, isRunning: (pid: number) => boolean = isProcessRunning): { readonly found: readonly WindowEntry[]; readonly gone: readonly GoneWindow[] } {
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		return { found: [], gone: [] };
	}
	const found: WindowEntry[] = [];
	const gone: GoneWindow[] = [];
	for (const name of names) {
		if (name === self) {
			continue;
		}
		const dir = path.join(root, name);
		const record = readWindowRecord(dir);
		if (!record) {
			continue;
		}
		const facts = { ...record, record: record.record ?? name };
		if (facts.record === self) {
			continue;
		}
		const entry: WindowEntry = { ...facts, dir, label: labelOf(facts) };
		// A record of a build before the instance was written: its extension host's process says. Whether the instance's
		// process id is another process's now is `startedAnew`'s to tell, which reads its start without holding up the
		// extension host: a window that answers is there whatever its id
		const there = isRunning(record.instance?.pid ?? record.pid);
		if (record.closing || !there) {
			gone.push({ record: entry.record, label: entry.label, dir, closed: !!record.closing, ...(record.load ? { load: record.load } : {}) });
		} else {
			found.push(entry);
		}
	}
	return { found, gone };
}

/**
 * A window's end of the pipes of the other windows of the machine: it calls them with the machine's key, read again once
 * where one refuses it - the key was made anew meanwhile.
 */
export class WindowLink {

	private key: string;

	constructor(private readonly keyFile: string) {
		this.key = windowKey(keyFile);
	}

	/** The machine's key, which a window's pipe takes from another window. */
	get windowKey(): string {
		return this.key;
	}

	/**
	 * Says hello to `entry`: its hello, where it is the window its record says, of this one's `version` and `commit`;
	 * undefined where it did not answer within `QUERY_MS`, or is another window, or of another version.
	 */
	async hello(entry: WindowEntry, version: string | undefined, commit: string | undefined): Promise<WindowHello | 'other version' | undefined> {
		const answer = await this.withKey(client => client.hello(AbortSignal.timeout(QUERY_MS)), entry).catch(() => undefined);
		if (!isJsonObject(answer) || answer.window !== true || answer.record !== entry.record || typeof answer.enabled !== 'boolean') {
			return undefined;
		}
		if (answer.version !== version || answer.commit !== commit) {
			return 'other version';
		}
		const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
		return { window: true, record: entry.record, enabled: answer.enabled, ...Object.fromEntries(Object.entries({ version: text(answer.version), commit: text(answer.commit), workspace: text(answer.workspace), folder: text(answer.folder) }).filter(([, value]) => value !== undefined)) };
	}

	/** Asks `entry` a query - `tool` with `args` - which it answers within `QUERY_MS`, or counts as not answering. */
	query(entry: WindowEntry, tool: string, args: object): Promise<unknown> {
		return this.withKey(client => client.call(tool, args, () => undefined, AbortSignal.timeout(QUERY_MS)), entry);
	}

	/**
	 * Sends `entry` a whole call - `tool` with `args` - which ends by its own rules; `progress` hears its progress lines.
	 * `signal`, where given, gives up waiting for its result, which it may have all the same.
	 */
	call(entry: WindowEntry, tool: string, args: object, progress: Progress, signal?: AbortSignal): Promise<unknown> {
		return this.withKey(client => client.call(tool, args, progress, signal), entry);
	}

	private async withKey<T>(request: (client: PipeClient) => Promise<T>, entry: WindowEntry): Promise<T> {
		try {
			return await request(new PipeClient(entry.pipe, this.key, WINDOW_REQUEST_EXTRA_BYTES));
		} catch (err) {
			if (!(err instanceof PipeClientError) || err.code !== 'UNAUTHORIZED') {
				throw err;
			}
			const again = windowKey(this.keyFile);
			if (again === this.key) {
				throw err;
			}
			this.key = again;
			return request(new PipeClient(entry.pipe, this.key, WINDOW_REQUEST_EXTRA_BYTES));
		}
	}
}
