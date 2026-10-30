/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What ptyd and a window say to each other: JSON lines over ptyd's socket (ARCHITECTURE-2.3). A window asks - each request
// numbered, answered once by its number - and ptyd tells the connection that claims a run what the run does: its output,
// numbered so that a reattach never shows output twice, its title, its status and its exit.

/**
 * The protocol, raised whenever a message changes shape or what ptyd does for a run changes. Each protocol has its own socket,
 * so a window of another protocol starts its own ptyd and never ends the runs an earlier one holds (ARCHITECTURE-2.4): numbered
 * output, generation-fenced claims, explicit `terminate` and `endWindow`, and the selected five-minute disconnected-owner
 * cleanup. An upgrade alone never ends an earlier protocol's runs.
 */
export const PTYD_PROTOCOL = 8;

import type { OwnerClaim } from '../base/ownership';
import { isJsonObject } from '../base/json';
export type { OwnerClaim } from '../base/ownership';

/** What a window gives ptyd to start a run: the agent's process, where it runs, and what the window keeps with it. */
export interface SpawnParams {
	/** The run's ID: one ptyd has never had, which it refuses to reuse (RULES-2.2). */
	readonly run: string;
	/** The workspace whose run it is: `list` and `endWindow` are by owner. */
	readonly owner: string;
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** The whole environment of the process: the window's computed one, not ptyd's. */
	readonly env: { readonly [name: string]: string };
	readonly cols: number;
	readonly rows: number;
	/** What the window keeps of the agent with its run, to show it again after a reload. Plain JSON. */
	readonly meta: { readonly [key: string]: unknown };
}

/** What a program reports it is doing (OSC 7501). */
export type StatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error';

/** What a blocked program waits for: an approval, an answer to a question, or a sign-in. */
export type StatusKind = 'permission' | 'question' | 'auth';

/**
 * A run's program's status, as it reports it (OSC 7501): `pending` once it asked whether ptyd takes reports and has not reported,
 * or took its report back; none at all for a program that takes no part.
 */
export interface RunStatus {
	/** Pending on the program's question whether the terminal takes reports, with no report yet. */
	readonly negotiating?: true;
	readonly state: StatusState | 'pending';
	/** What it waits for, where it is blocked and says. */
	readonly kind?: StatusKind;
	/** What it says it is doing, or why it waits: its own words, shown as text alone. */
	readonly msg?: string;
	/** The title its reports give, which a window prefers over the terminal title (CLIS-2.3). */
	readonly title?: string;
	/** When it came to this, in milliseconds since 1970 on ptyd's clock. */
	readonly at: number;
}

/** How a run's process ended. */
export interface RunExit {
	readonly exitCode: number;
	/** The signal that ended it, by number, where one did. */
	readonly signal?: number;
	/** Whether the person typed Ctrl+C into it just before: evidence an adapter may verify as an interrupt (RULES-3.3). */
	readonly ctrlC?: true;
}

/** A run as ptyd knows it, as the connection asking sees it. */
export interface RunInfo {
	readonly run: string;
	readonly owner: string;
	readonly pid: number;
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	/** The terminal title its program set last (OSC 0/2); empty while it has set none. */
	readonly title: string;
	readonly startedAt: number;
	readonly exited?: RunExit;
	readonly status?: RunStatus;
	/** The number of the last output it wrote; 0 before any (ARCHITECTURE-2.3). */
	readonly seq: number;
	/** Whether another connected window claims it: a window shows only the runs it claims (RULES-4.1). */
	readonly claimedElsewhere: boolean;
	readonly meta: { readonly [key: string]: unknown };
}

/** What a termination came to, as ptyd observed it (LIFECYCLE-4.2). */
export type Termination = 'terminated' | 'already_exited' | 'unconfirmed' | 'failed';

/** The requests, by method: what each takes, and what it answers. */
export interface Requests {
	/** The protocol each side speaks: a window of another protocol reports the difference and ends nothing (ARCHITECTURE-2.4). */
	hello: { params: { readonly protocol: number }; result: { readonly protocol: number; readonly pid: number } };
	/** Takes the workspace once, or resumes this activation. Older activations cannot claim it again. */
	claim: { params: OwnerClaim; result: void };
	/** Starts a run, claimed by this connection. */
	spawn: { params: SpawnParams; result: RunInfo };
	/** The runs of `owner` that no window has removed, each with whether another connected window claims it. */
	list: { params: { readonly owner: string }; result: readonly RunInfo[] };
	/**
	 * Claims the run for this connection and answers its screen as it stands, with the number of the last output it holds: what the
	 * connection is told from then on is numbered after it. Only the current workspace owner can attach.
	 */
	attach: { params: { readonly run: string }; result: { readonly info: RunInfo; readonly screen: string; readonly seq: number } };
	/** What the person typed into the run's terminal: straight to its process, with no policy (EXPERIENCE-2.1). */
	input: { params: { readonly run: string; readonly data: string }; result: void };
	resize: { params: { readonly run: string; readonly cols: number; readonly rows: number }; result: void };
	/** Replaces what the window keeps with the run. */
	setMeta: { params: { readonly run: string; readonly meta: { readonly [key: string]: unknown } }; result: void };
	/**
	 * Ends the run's process: its process group hung up, then killed after `graceMs` where it has not ended. Answers once its exit
	 * is observed, or that it could not be (LIFECYCLE-4.2).
	 */
	terminate: { params: { readonly run: string; readonly graceMs: number }; result: Termination };
	/** No window shows the run again: dropped at once where it ended, else hidden from `list` and dropped as it ends. */
	forget: { params: { readonly run: string }; result: void };
	/**
	 * Ends and forgets this current owner's runs: sent only on evidence that the window truly closed
	 * (RULES-4.1, ARCHITECTURE-2.2). Answers how many it ends.
	 */
	endWindow: { params: { readonly owner: string; readonly graceMs: number }; result: number };
}

export type Method = keyof Requests;

export interface Request<M extends Method = Method> {
	readonly id: number;
	readonly method: M;
	readonly params: Requests[M]['params'];
}

/** A request's answer. */
export type Response =
	| { readonly id: number; readonly result: unknown }
	| { readonly id: number; readonly error: string };

export interface OwnerEvent {
	readonly event: 'ownerLost';
	readonly owner: string;
}

/** What ptyd tells the connection that claims a run, as it happens. */
export type RunEvent =
	| { readonly event: 'output'; readonly run: string; readonly seq: number; readonly data: string }
	| { readonly event: 'title'; readonly run: string; readonly title: string }
	| { readonly event: 'status'; readonly run: string; readonly status?: RunStatus }
	| ({ readonly event: 'exit'; readonly run: string } & RunExit);

/** Validates event payloads at the socket boundary before they reach a terminal or a UI callback. */
export function isPtydEvent(value: unknown): value is RunEvent | OwnerEvent {
	if (!isJsonObject(value)) {
		return false;
	}
	if (value.event === 'ownerLost') {
		return typeof value.owner === 'string';
	}
	if (typeof value.run !== 'string') {
		return false;
	}
	switch (value.event) {
		case 'output': return typeof value.data === 'string' && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0;
		case 'title': return typeof value.title === 'string';
		case 'exit': return typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) &&
			(value.signal === undefined || typeof value.signal === 'number') && (value.ctrlC === undefined || value.ctrlC === true);
		case 'status': {
			const status = value.status;
			return status === undefined || isJsonObject(status) && typeof status.state === 'string' && ['pending', 'idle', 'working', 'done', 'blocked', 'error'].includes(status.state) &&
				typeof status.at === 'number' && Number.isFinite(status.at) && ['title', 'msg'].every(key => status[key] === undefined || typeof status[key] === 'string') &&
				(status.kind === undefined || typeof status.kind === 'string' && ['permission', 'question', 'auth'].includes(status.kind));
		}
		default: return false;
	}
}

/** Splits what came on the socket into its whole lines, keeping the unfinished rest for the next chunk. */
export function splitJsonLines(buffer: string): { readonly lines: readonly string[]; readonly rest: string } {
	const parts = buffer.split('\n');
	const rest = parts.pop() ?? '';
	return { lines: parts.filter(line => line.trim()), rest };
}

/** Allows an 8 MiB screen even with JSON's sixfold control-character escaping, plus its response envelope. */
export const MAX_JSON_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Reads complete UTF-8 JSON lines, with bounded storage for a partial line. An oversized frame fails this reader permanently:
 * the caller closes its transport, and no partial input or later frame is delivered. The growing byte buffer also avoids keeping
 * an unbounded number of fragment objects when a peer sends a large frame in tiny pieces.
 */
export function lineReader(onLine: (line: string) => void, onError: (err: Error) => void = err => { throw err; }, maxBytes = MAX_JSON_LINE_BYTES): (chunk: string | Buffer) => void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error('The ptyd frame limit must be a positive safe integer.');
	}
	let buffer: Buffer | undefined;
	let length = 0;
	let failed = false;
	return chunk => {
		if (failed) {
			return;
		}
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		for (let start = 0; start < bytes.length;) {
			const newline = bytes.indexOf(10, start);
			const end = newline < 0 ? bytes.length : newline;
			const next = length + end - start;
			if (next > maxBytes) {
				buffer = undefined;
				length = 0;
				failed = true;
				onError(new Error(`The ptyd frame exceeds ${maxBytes} bytes.`));
				return;
			}
			if (next) {
				if (!buffer || next > buffer.length) {
					const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1024, next, (buffer?.length ?? 0) * 2)));
					buffer?.copy(grown, 0, 0, length);
					buffer = grown;
				}
				bytes.copy(buffer, length, start, end);
				length = next;
			}
			if (newline < 0) {
				return;
			}
			const line = buffer?.toString('utf8', 0, length) ?? '';
			buffer = undefined;
			length = 0;
			if (line.trim()) {
				onLine(line);
			}
			start = newline + 1;
		}
	};
}
