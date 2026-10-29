/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { canonicalFolder, isEqualPath, isInsideFolder, replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withLongFileLock } from '../base/lock';
import { isProcessRunning, isSameStart, processStartTimeOfAsync } from '../base/system';
import { FacadeError } from '../core/errors';
import { Machine, MachineAnswers, Presence, SilentWindow, WINDOW_REQUESTS } from '../core/machine';
import { OutboxNotice, postNotice } from '../record/outbox';
import { PipeClientError } from '../transport/pipe';
import { readWindowRecord } from '../transport/endpoint';
import { GoneWindow, startedAnew, WindowEntry, WindowLink, windowsUnder } from '../transport/windows';

/** How often a silent workspace is tried again, while what is asked of it waits (AGENT-ORCHESTRATION.md, O8). */
const AGAIN_MS = 1_000;
/** How long a deletion waits for another workspace looking at the same deletion mark: what that takes is milliseconds. */
const MARK_WAIT_MS = 5_000;

/** This workspace, as the other workspaces of the machine know it: its record, its label, this load of its window, and Facade's version and commit. */
export interface WindowSelf {
	readonly record: string;
	readonly label: string;
	readonly load?: string;
	readonly version?: string;
	readonly commit?: string;
}

/** A deletion mark: the folder being deleted, and the workspace deleting it, by its record, label and window load (WT-8). */
interface DeletionMark {
	readonly folder: string;
	readonly record: string;
	readonly label: string;
	readonly load?: string;
}

/** A workspace looked at: those that answer, and how each that does not stands. */
interface Looked {
	readonly live: readonly WindowEntry[];
	readonly silent: readonly (SilentWindow & { readonly entry: WindowEntry })[];
	readonly gone: readonly GoneWindow[];
}

/**
 * The other workspaces of the machine, as this one reaches them through their pipes (O8): those whose records under `root`
 * are there - not closing, their application instance running - and answer hello as the workspace their record names, of
 * this one's version. One that is there but does not answer is silent, for as long as that lasts; one whose framework is
 * off says so. A call one has not accepted is tried again, a second at a time, while it is silent, up to `waitMs()`.
 * Notices are left in `outbox`, its folder for each workspace, and the workspace rung.
 */
export class HostMachine implements Machine {

	constructor(private readonly link: WindowLink, private readonly root: string, private readonly outbox: string, private readonly marks: string, readonly self: WindowSelf, private readonly waitMs: () => number, private readonly log: (message: string) => void) { }

	mark(folder: string): Promise<{ readonly placed: true } | { readonly placed: false; readonly by: string }> {
		const file = this.markFileOf(folder);
		const mark: DeletionMark = { folder, record: this.self.record, label: this.self.label, ...(this.self.load ? { load: this.self.load } : {}) };
		fs.mkdirSync(this.marks, { recursive: true });
		// Looked at, taken over and placed by one workspace at a time: two deleting at once never both place it. The file
		// is written whole before it is there, so no workspace ever reads half of one (WT-8.4)
		return withLongFileLock(file, async () => {
			const standing = readMark(file);
			if (standing && !(standing.record === this.self.record && standing.load === this.self.load) && await this.isLive(standing)) {
				return { placed: false, by: standing.label };
			}
			// Ours already; or left by a window load that ended - a reload, a close - or unreadable: placed anew
			replaceFile(file, JSON.stringify(mark));
			return { placed: true };
		}, MARK_WAIT_MS);
	}

	unmark(folder: string): Promise<void> {
		const file = this.markFileOf(folder);
		return withLongFileLock(file, async () => {
			const standing = readMark(file);
			if (standing?.record === this.self.record && standing.load === this.self.load) {
				fs.rmSync(file, { force: true });
			}
		}, MARK_WAIT_MS);
	}

	markOver(folder: string): string | undefined {
		let names: string[] = [];
		try {
			names = fs.readdirSync(this.marks).filter(name => name.endsWith('.json'));
		} catch {
			return undefined;
		}
		const real = canonicalFolder(folder);
		for (const name of names) {
			const mark = readMark(path.join(this.marks, name));
			if (mark && [folder, real].some(each => isEqualPath(each, mark.folder) || isInsideFolder(each, mark.folder)) && this.isLiveById(mark)) {
				return mark.label;
			}
		}
		return undefined;
	}

	async otherVersions(): Promise<readonly string[]> {
		const { found } = windowsUnder(this.root, this.self.record);
		const hellos = await Promise.all(found.map(entry => this.link.hello(entry, this.self.version, this.self.commit)));
		return found.filter((_, i) => hellos[i] === 'other version').map(entry => entry.label);
	}

	/**
	 * Whether the window load that placed `mark` is still the window's - this very one, or another workspace's, there and
	 * not closing, its instance's process running - by its id alone, as a start into the folder looks: a mark kept by an
	 * id given anew holds starts back no longer than that process runs. A deletion's mark looks exactly (`isLive`).
	 */
	private isLiveById(mark: DeletionMark): boolean {
		if (mark.record === this.self.record) {
			return mark.load === this.self.load;
		}
		const record = readWindowRecord(path.join(this.root, mark.record));
		return !!record && !record.closing && record.load === mark.load && isProcessRunning(record.instance?.pid ?? record.pid);
	}

	/** Whether the window load that placed `mark` is still the window's, its instance's start read too, without holding up the extension host. */
	private async isLive(mark: DeletionMark): Promise<boolean> {
		if (!this.isLiveById(mark) || mark.record === this.self.record) {
			return this.isLiveById(mark);
		}
		const instance = readWindowRecord(path.join(this.root, mark.record))?.instance;
		const start = instance?.start !== undefined ? await processStartTimeOfAsync(instance.pid, instance.start) : undefined;
		return start === undefined || instance?.start === undefined || isSameStart(start, instance.start);
	}

	/** The file of the deletion mark of `folder`, named by its path as the system compares it. */
	private markFileOf(folder: string): string {
		const key = process.platform === 'linux' ? canonicalFolder(folder) : canonicalFolder(folder).toLowerCase();
		return path.join(this.marks, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
	}

	ask(tool: string, args: object, waitMs = 0, only?: string): Promise<MachineAnswers> {
		return this.asking(tool, args, waitMs, only, false);
	}

	askEvery(tool: string, args: object, waitMs = 0): Promise<MachineAnswers> {
		return this.asking(tool, args, waitMs, undefined, true);
	}

	async callEvery(tool: string, args: object): Promise<MachineAnswers> {
		const deadline = Date.now() + this.waitMs();
		const answers: { record: string; label: string; answer: unknown }[] = [];
		const silent: SilentWindow[] = [];
		const unknown: { record: string; label: string }[] = [];
		const refused: { record: string; label: string; why: string }[] = [];
		const done = new Set<string>();
		for (; ;) {
			const looked = await this.look();
			const calling = [...looked.live, ...looked.silent.filter(each => each.reason === 'framework off').map(each => each.entry)].filter(entry => !done.has(entry.record));
			const called = await Promise.allSettled(calling.map(entry => this.callOnce(entry, tool, args, deadline)));
			called.forEach((result, i) => {
				const entry = calling[i];
				done.add(entry.record);
				if (result.status === 'fulfilled') {
					answers.push({ record: entry.record, label: entry.label, answer: result.value });
					return;
				}
				this.log(`Workspace ${entry.label} did not answer ${tool}: ${messageOf(result.reason)}`);
				// Taken and never answered - its connection broken, its result not come in time, or failing as it ran - what it
				// did there is unknown, and it is never sent again; not taken, or refused before it ran, it did not run there (O8)
				if (result.reason instanceof PipeClientError && ['NOT_CONNECTED', 'CANCELLED', 'FAILED'].includes(result.reason.code)) {
					unknown.push({ record: entry.record, label: entry.label });
				} else if (result.reason instanceof PipeClientError && result.reason.code === 'UNREACHABLE') {
					silent.push({ record: entry.record, label: entry.label, reason: 'not answering' });
				} else {
					refused.push({ record: entry.record, label: entry.label, why: messageOf(result.reason) });
				}
			});
			const waiting = looked.silent.filter(each => each.reason === 'not answering' && !done.has(each.record));
			if (!waiting.length || Date.now() >= deadline) {
				return { answers, silent: [...silent, ...waiting.map(({ record, label, reason }) => ({ record, label, reason }))], unknown, refused };
			}
			await timeout(AGAIN_MS);
		}
	}

	/**
	 * Hands `entry` the call `tool` once, waiting for its result no longer than the timeout and as much again past
	 * `deadline`: sent again, while there is time, only where it was not taken - to the workspace's pipe as it is then,
	 * which a reload may have changed.
	 */
	private async callOnce(first: WindowEntry, tool: string, args: object, deadline: number): Promise<unknown> {
		const limit = AbortSignal.timeout(Math.max(0, deadline - Date.now()) + this.waitMs());
		for (let entry = first; ;) {
			try {
				return await this.link.call(entry, tool, args, () => undefined, limit);
			} catch (err) {
				if (!(err instanceof PipeClientError && err.code === 'UNREACHABLE') || Date.now() >= deadline) {
					throw err;
				}
			}
			await timeout(AGAIN_MS);
			// As it listens then - its framework on or off - which a reload may have changed
			const looked = await this.look(first.record);
			entry = looked.live[0] ?? looked.silent.find(each => each.reason === 'framework off')?.entry ?? entry;
		}
	}

	/** `ask`'s and `askEvery`'s asking: of the live workspaces - and `evenOff`, those whose framework is off - `only` that one, where given. */
	private async asking(tool: string, args: object, waitMs: number, only: string | undefined, evenOff: boolean): Promise<MachineAnswers> {
		const deadline = Date.now() + waitMs;
		const answers: { record: string; label: string; answer: unknown }[] = [];
		const done = new Set<string>();
		for (; ;) {
			const looked = await this.look(only);
			const off = evenOff ? looked.silent.filter(each => each.reason === 'framework off') : [];
			const asking = [...looked.live, ...off.map(each => each.entry)].filter(entry => !done.has(entry.record));
			const asked = await Promise.allSettled(asking.map(entry => this.link.query(entry, tool, args)));
			const silent: SilentWindow[] = looked.silent.filter(each => !done.has(each.record) && !off.includes(each)).map(({ record, label, reason }) => ({ record, label, reason }));
			asked.forEach((result, i) => {
				const entry = asking[i];
				if (result.status === 'fulfilled') {
					done.add(entry.record);
					answers.push({ record: entry.record, label: entry.label, answer: result.value });
				} else if (result.reason instanceof PipeClientError && result.reason.windowCode === 'UNAVAILABLE') {
					silent.push({ record: entry.record, label: entry.label, reason: 'framework off' });
				} else {
					this.log(`Workspace ${entry.label} did not answer ${tool}: ${messageOf(result.reason)}`);
					silent.push({ record: entry.record, label: entry.label, reason: 'not answering' });
				}
			});
			if (!silent.some(each => each.reason === 'not answering') || Date.now() >= deadline) {
				return { answers, silent };
			}
			await timeout(AGAIN_MS);
		}
	}

	async askOne(record: string, tool: string, args: object): Promise<unknown> {
		// A silent one refused as a call is, `UNAVAILABLE`: what a query of it says, without waiting for it
		const entry = await this.entryOf(record).catch(err => {
			throw err instanceof SilentError ? err.refusal : err;
		});
		return this.link.query(entry, tool, args).catch(err => {
			throw windowFailure(entry, err);
		});
	}

	async call(record: string, tool: string, args: object, progress: (message: string) => void): Promise<unknown> {
		const deadline = Date.now() + this.waitMs();
		for (; ;) {
			const entry = await this.entryOf(record).catch(err => {
				// One silent is waited for; one gone, or off, is not
				if (!(err instanceof SilentError) || Date.now() >= deadline) {
					throw err instanceof SilentError ? err.refusal : err;
				}
				return undefined;
			});
			if (entry) {
				try {
					return await this.link.call(entry, tool, args, progress);
				} catch (err) {
					// Not taken: it did not run, and is sent again while the workspace is silent (O8)
					if (!(err instanceof PipeClientError && err.code === 'UNREACHABLE') || Date.now() >= deadline) {
						throw windowFailure(entry, err);
					}
				}
			}
			await timeout(AGAIN_MS);
		}
	}

	notice(record: string, notice: OutboxNotice): boolean {
		const { found } = windowsUnder(this.root, this.self.record);
		const entry = found.find(each => each.record === record);
		if (!entry) {
			return false;
		}
		postNotice(this.outbox, record, notice);
		// Rung where it answers, with no wait for its answer; one silent or off takes it as it answers again
		void this.link.query(entry, WINDOW_REQUESTS.ring, {}).catch(() => undefined);
		return true;
	}

	async presence(record: string): Promise<Presence> {
		const looked = await this.look(record);
		const live = looked.live.find(each => each.record === record);
		if (live) {
			return { kind: 'live', label: live.label, ...(live.load ? { load: live.load } : {}) };
		}
		const silent = looked.silent.find(each => each.record === record);
		if (silent) {
			return { kind: silent.reason === 'framework off' ? 'off' : 'silent', label: silent.label, ...(silent.entry.load ? { load: silent.entry.load } : {}) };
		}
		const gone = looked.gone.find(each => each.record === record);
		return { kind: 'gone', label: gone?.label ?? record, closed: gone?.closed ?? true, ...(gone?.load ? { load: gone.load } : {}) };
	}

	async known(): Promise<readonly { readonly record: string; readonly label: string; readonly workspace?: string }[]> {
		const looked = await this.look();
		return [...looked.live, ...looked.silent.map(each => each.entry)].map(entry => ({ record: entry.record, label: entry.label, ...(entry.workspace ? { workspace: entry.workspace } : {}) }));
	}

	/** The workspaces there - `only` that one, where given - each answering hello, or not, and those gone. */
	private async look(only?: string): Promise<Looked> {
		const { found, gone } = windowsUnder(this.root, this.self.record);
		const there = found.filter(entry => only === undefined || entry.record === only);
		const hellos = await Promise.all(there.map(entry => this.link.hello(entry, this.self.version, this.self.commit)));
		const live: WindowEntry[] = [];
		const silent: (SilentWindow & { entry: WindowEntry })[] = [];
		const quiet: WindowEntry[] = [];
		there.forEach((entry, i) => {
			const hello = hellos[i];
			if (hello === 'other version') {
				return;
			}
			if (!hello) {
				quiet.push(entry);
			} else if (!hello.enabled) {
				silent.push({ record: entry.record, label: entry.label, reason: 'framework off', entry });
			} else {
				live.push(entry);
			}
		});
		// One that does not answer is silent - reloading, hung - unless its instance's id is another process's now (O8)
		const anew = await startedAnew(quiet);
		silent.push(...quiet.filter(entry => !anew.includes(entry)).map(entry => ({ record: entry.record, label: entry.label, reason: 'not answering' as const, entry })));
		const ended = anew.map(entry => ({ record: entry.record, label: entry.label, dir: entry.dir, closed: false, ...(entry.load ? { load: entry.load } : {}) }));
		return { live, silent, gone: [...gone.filter(each => only === undefined || each.record === only), ...ended] };
	}

	/** The workspace `record`, answering; throws, saying why, where it does not - silent, its framework off, or gone. */
	private async entryOf(record: string): Promise<WindowEntry> {
		const looked = await this.look(record);
		const live = looked.live[0];
		if (live) {
			return live;
		}
		const silent = looked.silent[0];
		if (silent?.reason === 'framework off') {
			throw new FacadeError('UNAVAILABLE', `Workspace ${silent.label} has its agent framework turned off (framework_disabled). Nothing was done there.`);
		}
		if (silent) {
			throw new SilentError(new FacadeError('UNAVAILABLE', `Workspace ${silent.label} is not answering (it may be reloading, restarting or busy). Nothing was done there; retry shortly.`));
		}
		const gone = looked.gone[0];
		throw new FacadeError('NOT_FOUND', `Workspace ${gone?.label ?? record} is ${gone && !gone.closed ? 'gone: its app ended' : 'closed'}; its agents ended with it.`);
	}
}

/** A deletion mark as read, each field checked; undefined where it is none. */
function readMark(file: string): DeletionMark | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!isJsonObject(value) || typeof value.folder !== 'string' || typeof value.record !== 'string' || typeof value.label !== 'string' || (value.load !== undefined && typeof value.load !== 'string')) {
			return undefined;
		}
		return { folder: value.folder, record: value.record, label: value.label, ...(typeof value.load === 'string' ? { load: value.load } : {}) };
	} catch {
		return undefined;
	}
}

/** A workspace silent: waited for by a call, its refusal once the wait is over. */
class SilentError extends Error {
	constructor(readonly refusal: FacadeError) {
		super(refusal.message);
	}
}

/** What a failed request to `entry` says: the workspace's own failure as it is; one that never ran, unavailable; one that may have run, unknown. */
function windowFailure(entry: WindowEntry, err: unknown): FacadeError {
	if (err instanceof FacadeError) {
		return err;
	}
	if (err instanceof PipeClientError) {
		if (err.code === 'FAILED' && err.windowCode) {
			const code = ['INVALID', 'NOT_FOUND', 'REFUSED', 'UNAVAILABLE', 'FAILED'].includes(err.windowCode) ? err.windowCode as FacadeError['code'] : 'FAILED';
			return new FacadeError(code, err.message);
		}
		if (err.code === 'UNREACHABLE') {
			return new FacadeError('UNAVAILABLE', `Workspace ${entry.label} did not take the request: ${err.message} Nothing was done there; retry shortly.`);
		}
		if (err.code === 'NOT_CONNECTED') {
			return new FacadeError('FAILED', `The connection to workspace ${entry.label} broke after it took the request. Its effects are unknown; inspect before retrying.`, { outcome: 'unknown' });
		}
	}
	return new FacadeError('FAILED', `Workspace ${entry.label} failed the request: ${messageOf(err)}`, { outcome: 'unknown' });
}
