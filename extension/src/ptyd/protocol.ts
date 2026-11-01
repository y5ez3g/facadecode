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
 * cleanup. An upgrade alone never ends an earlier protocol's runs. 9: a run's MCP shim connects and its tool calls are carried
 * to the window that owns the run and back; `read`, `type`, `keys` and `inspect` read and write a run's terminal for its owner.
 */
export const PTYD_PROTOCOL = 10;

/**
 * The earlier protocols of released builds, each still spoken: a window shows and operates the runs their ptyds hold for it
 * through those ptyds, and starts none there (ARCHITECTURE-2.4). None is ever dropped. 8, of 0.0.1, is 9 without `spawn`'s
 * `screenStatus`; 9 lacks 10's exact-conversation listing and duplicate-spawn protection. New requests go to neither.
 */
export const EARLIER_PROTOCOLS: readonly number[] = [8, 9];

import type { OwnerClaim } from '../base/ownership';
import { isJsonObject } from '../base/json';
import type { InputReading } from './composer';
import type { InputEffect } from './input';
export type { OwnerClaim } from '../base/ownership';
export type { InputReading, InputState } from './composer';
export type { InputEffect } from './input';

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
	/**
	 * The screen reader that reads the run's status from its screen while its program reports nothing (CLIS-2.3, D80), by its ID
	 * in `screenStatus.ts`; none for a program that is read by its reports alone. An ID this ptyd knows no reader by reads nothing.
	 */
	readonly screenStatus?: string;
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

/** The last frame a full-screen program drew on the alternate screen, as it left it or ended there (MCP-5.1). */
export interface ScreenFrame {
	readonly lines: readonly string[];
	readonly text: readonly string[];
	/** When the program left the alternate screen, or ended on it. */
	readonly capturedAt: number;
}

/** A screen as a read gives it: its bottom logical lines, annotated and as plain text (MCP-5.1). */
export interface ScreenRead {
	/** Inverse-video text marked `[[...]]`, dim text `{{...}}`. */
	readonly lines: readonly string[];
	/** The same lines as plain text. */
	readonly text: readonly string[];
	readonly buffer: 'normal' | 'alternate';
	/** Whether the buffer holds lines with something on them above those read. */
	readonly older: boolean;
	/** Whether earlier scrollback was let go of: the 10,000-line or 8 MiB bound was reached (ARCHITECTURE-2.4). */
	readonly trimmed: boolean;
	readonly capturedAt: number;
	readonly lastOutput?: number;
	readonly exited: boolean;
	/**
	 * Read from the normal buffer, the last frame the program drew on the alternate screen before it left it - or ended there, the
	 * normal buffer then being its final output - its bottom lines as many as the read asked for.
	 */
	readonly frame?: ScreenFrame;
}

/**
 * A tool call as a run's shim asks it: the shim's `ToolCall`, which ptyd carries as it is but for the two fields it reads - the
 * calling run, by which it routes, and how long the call has been under way, to which it adds its own time (RULES-1.2).
 */
export interface ShimCall {
	readonly caller: string;
	readonly elapsedMs: number;
	/** For a query, how long from the shim's ingress a window has to answer before ptyd refuses it `window_unavailable` (MCP-1.3). */
	readonly routeDeadlineMs?: number;
	readonly [field: string]: unknown;
}

/** Why ptyd answers a shim's call with no window's answer: an MCP-1.2 reason the shim reports as it is. */
export type CallRefusal = 'window_unavailable' | 'not_found' | 'protocol_incompatible' | 'capacity_exceeded';

/** The requests, by method: what each takes, and what it answers. */
export interface Requests {
	/** Exact conversations currently held anywhere in this execution environment. */
	conversations: { params: Record<string, never>; result: readonly { readonly environment: string; readonly cli: string; readonly sessionId: string }[] };
	/**
	 * The protocol each side speaks: a window of another protocol reports the difference and ends nothing (ARCHITECTURE-2.4). A
	 * run's shim says it is one, and for which run; ptyd refuses a shim of another protocol and closes its connection.
	 */
	hello: { params: { readonly protocol: number; readonly role?: 'window' | 'shim'; readonly run?: string }; result: { readonly protocol: number; readonly pid: number } };
	/** Takes the workspace once, or resumes this activation. Older activations cannot claim it again. */
	claim: { params: OwnerClaim; result: void };
	/** Starts a run, claimed by this connection. */
	spawn: { params: SpawnParams; result: RunInfo };
	/**
	 * The runs of `owner` that no window has removed, each with whether another connected window claims it; with no owner, every
	 * run ptyd holds, of every owner, removed or not - whose injected files may still be in use (CLIS-2.2).
	 */
	list: { params: { readonly owner?: string }; result: readonly RunInfo[] };
	/**
	 * Claims the run for this connection and answers its screen as it stands, with the number of the last output it holds: what the
	 * connection is told from then on is numbered after it. Only the current workspace owner can attach.
	 */
	attach: { params: { readonly run: string }; result: { readonly info: RunInfo; readonly screen: string; readonly seq: number } };
	/** What the person typed into the run's terminal: straight to its process, with no policy (EXPERIENCE-2.1). */
	input: { params: { readonly run: string; readonly data: string }; result: void };
	resize: { params: { readonly run: string; readonly cols: number; readonly rows: number }; result: void };
	/** The bottom `lines` lines of the run's screen, once what it wrote is drawn (MCP-5.1). */
	read: { params: { readonly run: string; readonly lines: number }; result: ScreenRead };
	/**
	 * Pastes `text` - bracketed where the program turned that mode on - or presses Enter where asked, in turn with other automated
	 * input: never both in one request, an Enter going in one of its own once the CLI can have read the text (MCP-5.2, D113); a ptyd
	 * of protocol 9 still took both. `lead`, where given, is typed before the paste in the same write: words of the person's own ahead
	 * of pasted material, for a CLI whose model takes a paste alone as material rather than a request (CLIS-2.1, D108). A ptyd from
	 * before it takes no lead and pastes the text alone.
	 */
	type: { params: { readonly run: string; readonly text: string; readonly enter: boolean; readonly lead?: string }; result: InputEffect };
	/** Presses keys by name, or printable characters, in order: in turn with other automated input. */
	keys: { params: { readonly run: string; readonly keys: readonly string[] }; result: InputEffect };
	/**
	 * Reads the run's ordinary-message input with the input reader `adapter`, once what it wrote is drawn (CLIS-2.1, RULES-1.4):
	 * nothing is typed to find out.
	 */
	inspect: { params: { readonly run: string; readonly adapter: string }; result: InputReading };
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
	/**
	 * A shim's tool call, answered with the owning window's answer as it gave it. Waits for a window to claim the run while the call's
	 * two seconds last (RULES-1.2), and a query for an answer while its route deadline lasts; refused with a {@link CallRefusal} where
	 * no window answers.
	 */
	call: { params: ShimCall; result: unknown };
	/**
	 * A window's answer to the call ptyd numbered `id`, for the shim that asked it: answered once it was written to that shim, and
	 * refused where it could not be - the shim went, or the call was refused meanwhile - so that the window knows it was handed back.
	 */
	answer: { params: { readonly id: number; readonly answer: unknown }; result: void };
}

export type Method = keyof Requests;

export interface Request<M extends Method = Method> {
	readonly id: number;
	readonly method: M;
	readonly params: Requests[M]['params'];
}

/**
 * A request's answer. A shim's call ptyd could not carry says why, and whether the call may have acted: `unknown` once a window
 * was given it and went before answering, `none` where no window was.
 */
export type Response =
	| { readonly id: number; readonly result: unknown }
	| { readonly id: number; readonly error: string; readonly reason?: CallRefusal; readonly effects?: 'none' | 'unknown' };

export interface OwnerEvent {
	readonly event: 'ownerLost';
	readonly owner: string;
}

/** What ptyd tells the connection that claims a run, as it happens: `tools` once the run's shim says hello (MCP-6.1). */
export type RunEvent =
	| { readonly event: 'output'; readonly run: string; readonly seq: number; readonly data: string }
	| { readonly event: 'title'; readonly run: string; readonly title: string }
	| { readonly event: 'status'; readonly run: string; readonly status?: RunStatus }
	| ({ readonly event: 'exit'; readonly run: string } & RunExit)
	| { readonly event: 'tools'; readonly run: string };

/** A shim's call for the window that owns its run, numbered by ptyd: the window answers it with `answer`. */
export interface CallEvent {
	readonly event: 'call';
	readonly id: number;
	readonly call: ShimCall;
}

/** Validates event payloads at the socket boundary before they reach a terminal or a UI callback. */
export function isPtydEvent(value: unknown): value is RunEvent | OwnerEvent | CallEvent {
	if (!isJsonObject(value)) {
		return false;
	}
	if (value.event === 'ownerLost') {
		return typeof value.owner === 'string';
	}
	if (value.event === 'call') {
		return Number.isSafeInteger(value.id) && isJsonObject(value.call) && typeof value.call.caller === 'string' && typeof value.call.elapsedMs === 'number' && Number.isFinite(value.call.elapsedMs);
	}
	if (typeof value.run !== 'string') {
		return false;
	}
	switch (value.event) {
		case 'output': return typeof value.data === 'string' && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0;
		case 'title': return typeof value.title === 'string';
		case 'tools': return true;
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
