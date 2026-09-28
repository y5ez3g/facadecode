/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ProgramEvent, ProgramEventBody, ProgramState } from './model';
import { applyEvent, createState } from './state';

/*
 * Programs on disk: one folder each, holding `events.jsonl`, one event per line, only ever
 * appended to. Superpowers measured the most expensive failure of a lead that keeps its progress in
 * its own context: after a compaction it dispatched finished work again. Here progress lives in
 * this log, so neither a compaction nor a reload can lose it.
 *
 * A crash can cut the last line short. Loading drops that line and truncates the file back to the
 * last whole event, so the next append starts clean.
 */

const EVENTS_FILE = 'events.jsonl';

/** Events whose loss on a crash costs nothing: they are written without waiting for the disk. */
const UNSYNCED: ReadonlySet<ProgramEvent['type']> = new Set(['feature.progress', 'feature.stalled']);

export class ProgramLog {

	private fd: number | undefined;

	private constructor(readonly dir: string, readonly state: ProgramState, private readonly events: ProgramEvent[], private readonly now: () => number) { }

	/** Creates a new program. Fails if the folder already holds one. */
	static create(root: string, id: string, created: Extract<ProgramEventBody, { type: 'program.created' }>, now: () => number): ProgramLog {
		const dir = path.join(root, id);
		fs.mkdirSync(dir, { recursive: true });
		const event: Extract<ProgramEvent, { type: 'program.created' }> = { ...created, seq: 1, ts: now() };
		fs.writeFileSync(path.join(dir, EVENTS_FILE), `${JSON.stringify({ v: 1, ...event })}\n`, { flag: 'wx', mode: 0o600 });
		return new ProgramLog(dir, createState(id, event), [event], now);
	}

	/** Loads a program, repairing a line cut short by a crash. Undefined if the folder holds none. */
	static load(dir: string, now: () => number): ProgramLog | undefined {
		const file = path.join(dir, EVENTS_FILE);
		let content: Buffer;
		try {
			content = fs.readFileSync(file);
		} catch {
			return undefined;
		}
		const events: ProgramEvent[] = [];
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
			let parsed: ProgramEvent & { v?: number };
			try {
				parsed = JSON.parse(line);
			} catch {
				break;
			}
			if (parsed.v !== 1 || parsed.seq !== events.length + 1) {
				break;
			}
			events.push(parsed);
			good = offset;
		}
		if (good !== content.length) {
			fs.truncateSync(file, good);
		}
		const first = events[0];
		if (!first || first.type !== 'program.created') {
			return undefined;
		}
		const state = createState(path.basename(dir), first);
		for (const event of events.slice(1)) {
			applyEvent(state, event);
		}
		return new ProgramLog(dir, state, events, now);
	}

	/** The last event's sequence number. */
	get seq(): number {
		return this.state.seq;
	}

	/** Appends an event, applies it, and returns it with its sequence number. */
	append(body: ProgramEventBody): ProgramEvent {
		const event: ProgramEvent = { ...body, seq: this.state.seq + 1, ts: this.now() };
		if (this.fd === undefined) {
			this.fd = fs.openSync(path.join(this.dir, EVENTS_FILE), 'a', 0o600);
		}
		fs.writeSync(this.fd, `${JSON.stringify({ v: 1, ...event })}\n`);
		if (!UNSYNCED.has(event.type)) {
			fs.fsyncSync(this.fd);
		}
		applyEvent(this.state, event);
		this.events.push(event);
		return event;
	}

	/** Every event after `seq`, in order. */
	eventsAfter(seq: number): readonly ProgramEvent[] {
		// Sequence numbers run densely from 1, so the event numbered n sits at index n - 1.
		return this.events.slice(Math.max(0, seq));
	}

	close(): void {
		if (this.fd !== undefined) {
			fs.closeSync(this.fd);
			this.fd = undefined;
		}
	}
}

/** Every program folder under `root`. */
export function listProgramDirs(root: string): string[] {
	try {
		return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
	} catch {
		return [];
	}
}
