/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { FileStamp, replaceFile } from '../base/files';
import { withFileLock } from '../base/lock';

export const AGENTS_LOG = 'agents.log';
export const EVENTS_LOG = 'events.jsonl';
const EVENT_BYTES = 4 * 1024 * 1024;

/** Lines older than this go when the log is opened (ARCHITECTURE-3.3). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The agents log: one UTC-stamped line per operation or lifecycle fact, without secrets or message text (ARCHITECTURE-3.3),
 * pruned to thirty days.
 */
export class AgentLog {
	readonly file: string;
	readonly eventsFile: string;

	constructor(dir: string, private readonly now: () => number = Date.now) {
		this.file = path.join(dir, AGENTS_LOG);
		this.eventsFile = path.join(dir, EVENTS_LOG);
		this.prune();
		this.pruneEvents();
	}

	/** JSONL events for agents to inspect with their normal file tools. One ID correlates requests and outcomes. */
	fact(event: string, fields: Readonly<Record<string, unknown>>): void {
		try {
			const at = new Date(this.now()).toISOString();
			let line = `${JSON.stringify({ ...fields, event, at })}\n`;
			if (Buffer.byteLength(line) > EVENT_BYTES) {
				line = `${JSON.stringify({ event: 'event_omitted', at, original_event: event.slice(0, 200), reason: 'event_too_large', bytes: Buffer.byteLength(line) })}\n`;
			}
			withFileLock(this.eventsFile, () => {
				let size = 0;
				try { size = fs.statSync(this.eventsFile).size; } catch { /* First event. */ }
				if (size && size + Buffer.byteLength(line) > EVENT_BYTES) {
					fs.rmSync(`${this.eventsFile}.2`, { force: true });
					if (fs.existsSync(`${this.eventsFile}.1`)) { fs.renameSync(`${this.eventsFile}.1`, `${this.eventsFile}.2`); }
					fs.renameSync(this.eventsFile, `${this.eventsFile}.1`);
				}
				fs.appendFileSync(this.eventsFile, line);
			}, { waitMs: 0 });
		} catch { /* A diagnostic write cannot change the outcome of the operation it describes. */ }
	}

	private pruneEvents(): void {
		try {
			withFileLock(this.eventsFile, () => {
				for (const file of [this.eventsFile, `${this.eventsFile}.1`, `${this.eventsFile}.2`]) {
					if (!fs.existsSync(file)) { continue; }
					const { size, mtimeMs, ino } = fs.statSync(file);
					// Only our bounded event files; never allocate an unbounded old or externally modified file.
					if (size > EVENT_BYTES * 2) { continue; }
					const text = fs.readFileSync(file, 'utf8');
					const kept = text.split('\n').filter(line => {
						if (!line) { return false; }
						try { const at = Date.parse(JSON.parse(line).at); return Number.isNaN(at) || at >= this.now() - RETENTION_MS; }
						catch { return true; }
					});
					const next = kept.length ? kept.join('\n') + '\n' : '';
					if (next !== text) { replaceFile(file, next, { size, mtimeMs, ino }); }
				}
			}, { waitMs: 0 });
		} catch { /* Best-effort retention, like the existing agents log. */ }
	}

	event(text: string): void {
		const line = `${new Date(this.now()).toISOString()} ${text.replace(/[\r\n]+/g, ' ')}\n`;
		try {
			fs.appendFileSync(this.file, line);
		} catch {
			// The log is diagnostic: a full disk must not fail the operation it describes.
		}
	}

	private prune(): void {
		let text: string;
		let stamp: FileStamp;
		try {
			const { size, mtimeMs, ino } = fs.statSync(this.file);
			stamp = { size, mtimeMs, ino };
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return;
		}
		const cutoff = this.now() - RETENTION_MS;
		const kept = text.split('\n').filter(line => {
			const at = Date.parse(line.slice(0, 24));
			return line && (Number.isNaN(at) || at >= cutoff);
		});
		const next = kept.length ? `${kept.join('\n')}\n` : '';
		if (next !== text) {
			try {
				// Preserve the old log if pruning fails or another host appended after the read.
				replaceFile(this.file, next, stamp);
			} catch {
				// Retention is best effort: diagnostics must not prevent the extension from activating.
			}
		}
	}
}
