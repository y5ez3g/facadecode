/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run's program says it is doing, by the Program Status Protocol - OSC 7501, revision 0.4: a program asks whether its
// terminal takes reports, `OSC 7501 ; ? ST`, and ptyd answers that it does; from then on - or without asking - the program
// reports, `OSC 7501 ; state=working ST`. Only the program's own record counts, the root, with no `id`: an agent's CLI is one
// program, whatever records it keeps for its own workers. Everything a report says is the program's, untrusted: each limit of
// the protocol is kept, and what it says is shown as text alone.

import { displayLine } from '../base/text';
import type { RunStatus, StatusKind, StatusState } from './protocol';

/** What ptyd answers a program that asks whether it takes reports: the states and the kinds it knows, as the protocol words them. */
export const STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const STATES: ReadonlySet<string> = new Set<StatusState>(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS: ReadonlySet<string> = new Set<StatusKind>(['permission', 'question', 'auth']);

/** The protocol's limits: a whole sequence, a key, a message encoded and decoded, a title, an app's id, an id and its parts. */
const MOST_SEQUENCE = 4096;
const MOST_KEY = 16;
const MOST_MSG_ENCODED = 2732;
const MOST_MSG_DECODED = 2048;
const MOST_TITLE_ENCODED = 256;
const MOST_TITLE_DECODED = 192;
const MOST_APP = 32;
const MOST_ID = 128;
const MOST_ID_DEPTH = 8;

/** How much of a program's words and title ptyd keeps, in code points: what a card shows (CLIS-2.3). */
const KEPT_TEXT = 300;

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]+$/;
const PROGRESS = /^\d{1,3}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Control characters, which decoded text may not hold: C0, DEL and C1. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A report, as a program sent it: its state - `clear` taking its record away - what it waits for, and its words. */
export interface StatusReport {
	/** Which of its records it is about; none for the program's own. */
	readonly id?: string;
	readonly state: StatusState | 'clear';
	readonly kind?: StatusKind;
	readonly msg?: string;
	/** The title it gives, which a window prefers over the terminal title (CLIS-2.3). */
	readonly title?: string;
	readonly app?: string;
	readonly progress?: number;
}

/**
 * What a program said between `OSC 7501 ;` and its end: `query`, where it asks whether the terminal takes reports; its report;
 * or undefined for what the protocol has ignored - no state, or one it does not know, an id that is none, a limit passed, text
 * that does not decode.
 */
export function parseStatus(body: string): 'query' | StatusReport | undefined {
	if (body.length > MOST_SEQUENCE) {
		return undefined;
	}
	if (body.trim() === '?') {
		return 'query';
	}
	const values = new Map<string, string>();
	let msg: string | undefined;
	let title: string | undefined;
	for (const pair of body.split(':')) {
		const equals = pair.indexOf('=');
		if (equals < 0) {
			continue;
		}
		const key = pair.slice(0, equals).trim();
		const value = pair.slice(equals + 1).trim();
		// A hard limit passed by any of its pairs, a duplicate too, voids the whole report: an id that is none never falls back
		// to the program's own record
		if (key.length > MOST_KEY || (key === 'app' && value.length > MOST_APP) || (key === 'id' && !isId(value))) {
			return undefined;
		}
		// A pair that is no pair is passed over, the rest of the report applying
		if (!KEY.test(key) || !VALUE.test(value)) {
			continue;
		}
		// Text that does not decode voids it too, each occurrence checked: a later one cannot launder an earlier
		if (key === 'msg' || key === 'title') {
			const text = key === 'msg' ? decoded(value, MOST_MSG_ENCODED, MOST_MSG_DECODED) : decoded(value, MOST_TITLE_ENCODED, MOST_TITLE_DECODED);
			if (text === undefined) {
				return undefined;
			}
			if (key === 'msg') {
				msg = text;
			} else {
				title = text;
			}
			continue;
		}
		values.set(key, value);
	}
	const state = values.get('state');
	if (state === undefined || (state !== 'clear' && !STATES.has(state))) {
		return undefined;
	}
	const kind = values.get('kind');
	const progress = values.get('progress');
	const app = values.get('app');
	const id = values.get('id');
	return {
		...(id !== undefined ? { id } : {}),
		state: state as StatusState | 'clear',
		...(state === 'blocked' && kind !== undefined && KINDS.has(kind) ? { kind: kind as StatusKind } : {}),
		...(msg ? { msg } : {}),
		...(title ? { title } : {}),
		...(app !== undefined && APP.test(app) ? { app } : {}),
		...((state === 'working' || state === 'blocked') && progress !== undefined && PROGRESS.test(progress) && Number(progress) <= 100 ? { progress: Number(progress) } : {})
	};
}

/** Whether `id` names a record of the program's own: parts of letters, digits and `_.+-`, a few, not long. */
function isId(id: string): boolean {
	const segments = id.split('/');
	return id.length <= MOST_ID && segments.length <= MOST_ID_DEPTH && segments.every(segment => SEGMENT.test(segment));
}

/** The text a report's base64 `value` holds; undefined where it is too long, no base64, no UTF-8, or holds a control character. */
function decoded(value: string, mostEncoded: number, mostDecoded: number): string | undefined {
	// Its size first: what a program can make ptyd do stays bounded
	if (value.length > mostEncoded || !BASE64.test(value)) {
		return undefined;
	}
	const unpadded = value.replace(/=+$/, '');
	if (unpadded.length % 4 === 1) {
		return undefined;
	}
	const bytes = Buffer.from(unpadded, 'base64');
	if (bytes.length > mostDecoded) {
		return undefined;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	return CONTROL.test(text) ? undefined : text;
}

/** A program's words as they are kept: one line, invisible formatting removed, at most {@link KEPT_TEXT} code points. */
function keptText(text: string | undefined): string | undefined {
	return text === undefined ? undefined : displayLine(text, KEPT_TEXT) || undefined;
}

/**
 * The status of a run's program: none while it has neither asked whether ptyd takes reports nor reported - it takes no part;
 * `pending` once it asked, or cleared its record, and stands on no report; else its last report, from when it came. The title its
 * reports give stays until a report gives another, or its record is cleared.
 */
export class ProgramStatus {

	private current: RunStatus | undefined;
	private readonly listeners = new Set<(status: RunStatus | undefined) => void>();

	/** The status now; none for a program that takes no part. */
	get status(): RunStatus | undefined {
		return this.current;
	}

	onDidChange(listener: (status: RunStatus | undefined) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The program asked whether ptyd takes reports: it takes part, pending its first report. */
	asked(): void {
		if (!this.current) {
			this.set({ state: 'pending', negotiating: true, at: Date.now() });
		}
	}

	/** Takes `report`: of the program's own record alone - a worker's, with its own id, is ignored (CLIS-2.3). */
	report(report: StatusReport): void {
		if (report.id !== undefined) {
			return;
		}
		if (report.state === 'clear') {
			this.clear();
			return;
		}
		const msg = keptText(report.msg);
		const title = keptText(report.title) ?? (this.current?.state !== 'pending' ? this.current?.title : undefined);
		const next: RunStatus = {
			state: report.state,
			...(report.kind ? { kind: report.kind } : {}),
			...(msg ? { msg } : {}),
			...(title ? { title } : {}),
			at: Date.now()
		};
		const now = this.current;
		// The same state, kind and words again - its progress alone moved on: the same episode, its time kept (CLIS-2.3)
		if (now !== undefined && now.state === next.state && now.kind === next.kind && now.msg === next.msg && !now.negotiating) {
			if (now.title !== next.title) {
				this.set({ ...next, at: now.at });
			}
			return;
		}
		this.set(next);
	}

	/** A new shell prompt, OSC 133 A: what the program said it was doing is over - working or blocked - unless it said it was done. */
	promptStarted(): void {
		if (this.current?.state === 'working' || this.current?.state === 'blocked') {
			this.clear();
		}
	}

	/** Its record taken away - `clear`, or a full reset of the terminal: it stands on no report, pending the next. */
	clear(): void {
		if (this.current && (this.current.state !== 'pending' || this.current.negotiating)) {
			this.set({ state: 'pending', at: Date.now() });
		}
	}

	private set(status: RunStatus): void {
		this.current = status;
		this.listeners.forEach(listener => listener(status));
	}
}
