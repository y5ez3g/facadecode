/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { FileChangedError, replaceFile } from '../base/files';
import { takeNumbers } from './counter';
import { facadeHome } from './paths';
import { pruneResults } from './results';

/** Message records expire this long after they were sent, with no manual delete (RULES-5.3, COLLABORATION-3.3). */
export const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a long-lived store looks for what expired since it last did. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const RECORD_FILE = /^m-(\d+)\.json$/;
const MESSAGE_ID = /^m-\d+$/;

interface Stored {
	readonly id: string;
	readonly at: number;
}

/**
 * The message records of an execution environment, in its Facade directory (ARCHITECTURE-3.1, 2.4): one small JSON file per record,
 * replaced whole by its one writer, so each file stays bounded and every window of the environment reads the others' records. A
 * record survives reloads and goes thirty days after it was sent, and with it every long-result file that holds it (COLLABORATION-4.2).
 */
export class MessageFile<T extends Stored> {
	private readonly dir: string;
	/** What was read of each file, as it was when read: a file is read again only once it changed. */
	private readonly cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly ino: number; readonly record: T | undefined }>();
	private prunedAt = Number.NEGATIVE_INFINITY;

	/**
	 * The records in `home`'s `folder`. Only the store of the messages themselves prunes the long-result files that hold them: a store
	 * of copies does not know every message kept (COLLABORATION-4.2).
	 */
	constructor(private readonly home: string = facadeHome(), private readonly now: () => number = Date.now, folder = 'messages', private readonly ownsResults = folder === 'messages') {
		this.dir = path.join(home, folder);
		fs.mkdirSync(this.dir, { recursive: true });
		this.prune();
	}

	/** Every record kept, oldest first. */
	list(): readonly T[] {
		if (this.now() - this.prunedAt >= PRUNE_EVERY_MS) {
			this.prune();
		}
		const cutoff = this.now() - MESSAGE_RETENTION_MS;
		return this.names()
			.map(name => this.read(name))
			.filter((record): record is T => !!record && record.at >= cutoff)
			.sort((a, b) => numberOf(a.id) - numberOf(b.id));
	}

	/** Writes a new record; throws where a record of its ID is there already, which is never written over (RULES-1.1). */
	create(record: T): void {
		try {
			this.write(record, 'missing');
		} catch (err) {
			throw err instanceof FileChangedError ? new Error(`A message ${record.id} is kept already: its ID is never given to another.`) : err;
		}
	}

	/** Writes `record` whole, in place of the one with its ID. */
	put(record: T): void {
		this.write(record);
	}

	private write(record: T, unless?: 'missing'): void {
		if (!MESSAGE_ID.test(record.id)) {
			throw new Error(`${JSON.stringify(record.id)} is not a message ID.`);
		}
		const name = `${record.id}.json`;
		const file = path.join(this.dir, name);
		replaceFile(file, `${JSON.stringify(record)}\n`, unless);
		const { mtimeMs, size, ino } = fs.statSync(file);
		this.cache.set(name, { mtimeMs, size, ino, record });
	}

	/** Removes the records older than thirty days, and the long-result files holding any message no longer kept. */
	prune(): void {
		const now = this.now();
		this.prunedAt = now;
		const cutoff = now - MESSAGE_RETENTION_MS;
		const kept = new Set<string>();
		for (const name of this.names()) {
			const file = path.join(this.dir, name);
			const record = this.read(name);
			// One that cannot be read goes by its file's age
			const at = record?.at ?? this.cache.get(name)?.mtimeMs ?? now;
			if (at < cutoff) {
				fs.rmSync(file, { force: true });
				this.cache.delete(name);
			} else if (record) {
				kept.add(record.id);
			}
		}
		if (this.ownsResults) {
			pruneResults(this.home, now, id => !MESSAGE_ID.test(id) || kept.has(id));
		}
	}

	private names(): string[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir).filter(name => RECORD_FILE.test(name));
		} catch (err) {
			if (codeOf(err) === 'ENOENT') {
				return [];
			}
			throw err;
		}
		const present = new Set(names);
		for (const name of this.cache.keys()) {
			if (!present.has(name)) {
				this.cache.delete(name);
			}
		}
		return names;
	}

	private read(name: string): T | undefined {
		const file = path.join(this.dir, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			this.cache.delete(name);
			return undefined;
		}
		const cached = this.cache.get(name);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
			return cached.record;
		}
		let record: T | undefined;
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
			record = isStored(parsed) && `${parsed.id}.json` === name ? parsed as T : undefined;
		} catch {
			record = undefined;
		}
		this.cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, record });
		return record;
	}
}

/**
 * Message numbers for `m-N` and `#mN`, from one counter per execution environment that every window draws from under a lock
 * (RULES-1.1): never reused, also once the records holding them expired. A counter found behind a record still kept moves past it;
 * one that cannot be read is an error, never a count from nothing.
 */
export class MessageCounter {
	private readonly file: string;
	private readonly records: string;

	constructor(home: string = facadeHome()) {
		this.file = path.join(home, 'message-aliases.json');
		this.records = path.join(home, 'messages');
	}

	next(): number {
		// The records read under the counter's lock: what another window wrote just now counts
		return takeNumbers(this.file, 1, 'message number', () => this.floor());
	}

	/** The highest number of a record kept. */
	private floor(): number {
		let names: string[];
		try {
			names = fs.readdirSync(this.records);
		} catch (err) {
			if (codeOf(err) === 'ENOENT') {
				return 0;
			}
			throw err;
		}
		return names.reduce((floor, name) => Math.max(floor, Number(RECORD_FILE.exec(name)?.[1] ?? 0)), 0);
	}
}

function numberOf(id: string): number {
	return Number(id.slice(2));
}

function isStored(value: unknown): value is Stored {
	const record = value as { id?: unknown; at?: unknown } | null;
	return !!record && typeof record === 'object' && typeof record.id === 'string' && MESSAGE_ID.test(record.id) && typeof record.at === 'number' && Number.isFinite(record.at);
}
