/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { timeout } from '../base/async';
import { codeOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { breakStaleLock, withFileLock } from '../base/lock';
import { numberedUpTo } from './agents';

/** A kind of number the machine gives: an agent's, `#a7`, or a message's, `#m7`. */
export type NumberKind = 'agents' | 'messages';

/**
 * Where a record's numbers come from: the next of a kind above `above` - the last the record `dir` gave - and the machine's
 * shared mark of it, at or below which a number may be one two records hold (AGENT-LAUNCHER.md, L2, L12).
 */
export interface NumberCounters {
	next(kind: NumberKind, above: number, dir: string): number;
	shared(kind: NumberKind): number;
	/** The last number of a kind the machine gave; 0 before any. */
	last(kind: NumberKind): number;
	/** The record `dir` opens: numbers it holds that the machine did not give it raise the shared mark. */
	join(dir: string): void;
	/** The record `dir` holds `id`, which the machine gave another record: no number of its own beyond the machine's. */
	saw(kind: NumberKind, id: number, dir: string): void;
	/** Resolves once the counters' lock is free, or a while on: taking a number then waits for no other holder. */
	ready(): Promise<void>;
}

/** What `counters.json` holds: the last number given of each kind, and the shared mark of each. */
interface Counted {
	readonly agents: number;
	readonly messages: number;
	readonly sharedAgents: number;
	readonly sharedMessages: number;
}

/** The file in a record that says the last numbers this version knows the record gave, from the machine's counters. */
export const MACHINE_NUMBERS_FILE = 'machine-numbers.json';

/** How long `ready` waits for the counters' lock, and how often it looks. */
const READY_WAIT_MS = 5_000;
const READY_AGAIN_MS = 25;
/**
 * How long taking a number - or a record joining the counters - waits for the lock, holding up the extension host, once
 * `ready` has waited for it without:
 * a holder letting go; one that keeps it past both - its window paused - refuses the number, which says so (L12).
 */
const TAKE_WAIT_MS = 1_000;

/**
 * The machine's counters, `counters.json` in Facade's home: one sequence of agent numbers and one of message numbers for
 * every workspace record, so that no number is given twice on the machine (AGENT-LAUNCHER.md, L2, L12). Each number is
 * taken under the file's lock, never taken over from a holder that still runs. A file missing or unreadable is made again
 * above the highest number any record in `records` gave, read under the lock; an unreadable one is kept aside.
 *
 * The shared mark is the highest number two records may both hold: every number before the counters began, and every
 * number a record holds beyond what this version knows it gave - one numbered meanwhile by an older version, which does
 * not know the counters - raises it as this version opens that record.
 */
export class MachineCounters implements NumberCounters {

	constructor(private readonly file: string, private readonly records: string) { }

	next(kind: NumberKind, above: number, dir: string): number {
		return withFileLock(this.file, () => {
			const counted = this.counted();
			const id = Math.max(counted[kind], above) + 1;
			replaceFile(this.file, JSON.stringify({ ...counted, [kind]: id }));
			const known = readKnown(dir) ?? numberedUpTo(dir);
			replaceFile(path.join(dir, MACHINE_NUMBERS_FILE), JSON.stringify({ ...known, [kind]: id }));
			return id;
		}, { keepLive: true, waitMs: TAKE_WAIT_MS });
	}

	last(kind: NumberKind): number {
		return readCounted(this.file)?.[kind] ?? 0;
	}

	shared(kind: NumberKind): number {
		const counted = readCounted(this.file);
		return counted ? (kind === 'agents' ? counted.sharedAgents : counted.sharedMessages) : 0;
	}

	join(dir: string): void {
		const reached = numberedUpTo(dir);
		const known = readKnown(dir);
		if (known && reached.agents <= known.agents && reached.messages <= known.messages) {
			return;
		}
		withFileLock(this.file, () => {
			const counted = this.counted();
			replaceFile(this.file, JSON.stringify({
				agents: Math.max(counted.agents, reached.agents),
				messages: Math.max(counted.messages, reached.messages),
				sharedAgents: Math.max(counted.sharedAgents, reached.agents),
				sharedMessages: Math.max(counted.sharedMessages, reached.messages)
			}));
			replaceFile(path.join(dir, MACHINE_NUMBERS_FILE), JSON.stringify(reached));
		}, { keepLive: true, waitMs: TAKE_WAIT_MS });
	}

	saw(kind: NumberKind, id: number, dir: string): void {
		const known = readKnown(dir) ?? numberedUpTo(dir);
		if (id > known[kind]) {
			replaceFile(path.join(dir, MACHINE_NUMBERS_FILE), JSON.stringify({ ...known, [kind]: id }));
		}
	}

	async ready(): Promise<void> {
		const lock = `${this.file}.lock`;
		const deadline = Date.now() + READY_WAIT_MS;
		while (fs.existsSync(lock) && Date.now() < deadline) {
			// One its holder left goes here, the holder's start read without holding up the extension host (L12)
			await breakStaleLock(lock);
			await timeout(READY_AGAIN_MS);
		}
	}

	/** The counters, under the lock: as the file has them, or begun above every record, an unreadable file kept aside. */
	private counted(): Counted {
		const counted = readCounted(this.file);
		if (counted) {
			return counted;
		}
		if (fs.existsSync(this.file)) {
			fs.renameSync(this.file, `${this.file}.unreadable-${Date.now()}`);
		}
		const reached = highestOf(this.records);
		return { agents: reached.agents, messages: reached.messages, sharedAgents: reached.agents, sharedMessages: reached.messages };
	}
}

/** `counters.json`, each field checked - one written before the shared mark, with the first numbers given, read as one; undefined where it is not there or cannot be read. */
function readCounted(file: string): Counted | undefined {
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		if (codeOf(err) !== 'ENOENT' && !(err instanceof SyntaxError)) {
			throw err;
		}
		return undefined;
	}
	const isCount = (count: unknown): count is number => typeof count === 'number' && Number.isInteger(count) && count >= 0;
	if (!isJsonObject(value) || !isCount(value.agents) || !isCount(value.messages)) {
		return undefined;
	}
	if (isCount(value.sharedAgents) && isCount(value.sharedMessages)) {
		return { agents: value.agents, messages: value.messages, sharedAgents: value.sharedAgents, sharedMessages: value.sharedMessages };
	}
	if (isCount(value.firstAgent) && isCount(value.firstMessage)) {
		return { agents: value.agents, messages: value.messages, sharedAgents: Math.max(0, value.firstAgent - 1), sharedMessages: Math.max(0, value.firstMessage - 1) };
	}
	return undefined;
}

/** The last numbers this version knows the record `dir` gave; undefined where it never gave one, or the file cannot be read. */
function readKnown(dir: string): { readonly agents: number; readonly messages: number } | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, MACHINE_NUMBERS_FILE), 'utf8'));
		const isCount = (count: unknown): count is number => typeof count === 'number' && Number.isInteger(count) && count >= 0;
		return isJsonObject(value) && isCount(value.agents) && isCount(value.messages) ? { agents: value.agents, messages: value.messages } : undefined;
	} catch {
		return undefined;
	}
}

/** The highest numbers any record in `records` gave; 0 where there is none. */
function highestOf(records: string): { readonly agents: number; readonly messages: number } {
	let agents = 0;
	let messages = 0;
	let names: string[] = [];
	try {
		names = fs.readdirSync(records);
	} catch {
		// No record yet
	}
	for (const name of names) {
		const reached = numberedUpTo(path.join(records, name));
		agents = Math.max(agents, reached.agents);
		messages = Math.max(messages, reached.messages);
	}
	return { agents, messages };
}
