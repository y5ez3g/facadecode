/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The message service's contract (RULES-1, COLLABORATION-2-4): what the tool service asks of it, and the ports it needs of the
// window - the run's ordinary input, the person's notifications and the message records.

import type { CapabilityState, RunId } from './ports';

/** What automated input did, as MCP-1.2 reports it. */
export interface InputEffects {
	readonly outcome: 'none' | 'confirmed' | 'partial' | 'unknown' | 'pending';
	readonly text_written?: 'none' | 'partial' | 'full' | 'unknown';
	readonly enter_written?: boolean | null;
}

/** One message or Facade result, as kept for its recipient's inbox and Message History (COLLABORATION-4.1). */
export interface MessageRecord {
	/** `m-42`; its alias `#m42` is unique and never reassigned (RULES-1.1). */
	readonly id: string;
	readonly alias: string;
	readonly kind: 'message' | 'result';
	/** The sending run, or `facade` for a Facade result. */
	readonly from: { readonly run: RunId | 'facade'; readonly alias?: string; readonly name?: string };
	readonly to: { readonly run: RunId | '@human'; readonly alias?: string; readonly name?: string };
	/** The window and execution environment the message was sent in. */
	readonly window: string;
	readonly environment: string;
	/** The window of its sender where that is another window of this computer: its Facade result goes back there (RULES-1.7). */
	readonly fromWindow?: string;
	/** The workspace whose Message History shows it, across reloads and later openings (COLLABORATION-3.2). */
	readonly workspace?: string;
	readonly at: number;
	readonly replyTo?: string;
	/** For a Facade result: the message it reports on. */
	readonly about?: string;
	/** For a Facade result: the tool call whose accepted response it completes (MCP-1.3). */
	readonly callId?: string;
	/** For a Facade result about another operation than a message: the agent it was on, a start's or a stop's (MCP-1.3). */
	readonly agent?: { readonly run: RunId; readonly alias?: string; readonly name?: string };
	readonly text: string;
	/** Unicode code points of `text`. */
	readonly length: number;
	/** The sender's request ID for this send, where it gave one: the same one again answers this record (MCP-1.1, D110). */
	readonly requestId?: string;
	/** The window its header names, where its sender is another window's: what a delivery that goes on after a reload types again. */
	readonly label?: string;
	readonly delivery: {
		readonly status: 'pending' | 'success' | 'failure';
		readonly reason?: string;
		readonly effects: InputEffects;
		/** Epoch ms when an accepted delivery ends at the latest. */
		readonly deadline?: number;
		readonly attempts: number;
		/**
		 * How a delivered record reached its recipient (COLLABORATION-3.1): its CLI took it in its terminal, read_messages handed it
		 * back, its native launch took it as a creation prompt, or the person was notified. One state: delivered or not.
		 */
		readonly via?: 'terminal' | 'read' | 'launch' | 'notification';
		/** Epoch ms it was delivered. */
		readonly deliveredAt?: number;
		/**
		 * While it is being delivered, what this window's next opening needs to go on with it within the same budget (RULES-1.9), kept
		 * before the input they describe: when its stage started, whether its text may be in the input - from before its paste is issued
		 * on, so that it is never pasted again (RULES-1.6) - the draft it showed as, and whether an Enter of it went. Never shown.
		 */
		readonly start?: number;
		readonly pasted?: true;
		readonly seen?: string;
		readonly entered?: true;
	};
}

/** A send as the tool service asks for it, validated and resolved already (RULES-1.1, 2.3). */
export interface SendRequest {
	readonly from: RunId;
	/** A sender in another window, as its own window names it: this window does not hold it (COLLABORATION-1.1). */
	readonly sender?: { readonly party: MessageRecord['from']; readonly window: string; readonly label?: string };
	readonly to: RunId | '@human';
	readonly text: string;
	readonly replyTo?: string;
	/** Milliseconds already spent since the request reached the shim: the 2-second response budget counts from there (RULES-1.2). */
	readonly elapsedMs: number;
	/** The originating tool call, so that a later Facade result names it (MCP-1.3). */
	readonly callId?: string;
	/** The ID {@link Messages.allocate} took for it, where it was formatted before it was sent: a creation prompt (COLLABORATION-2.2). */
	readonly id?: string;
	/** The caller's request ID, kept with the record (MCP-1.1, D110). */
	readonly requestId?: string;
}

/** The first response to a send (RULES-1.2): success, failure, or accepted with its deadline and current obstacle. */
export interface SendResult {
	readonly record: MessageRecord;
	readonly status: 'success' | 'failure' | 'accepted';
	readonly reason?: string;
	readonly obstacle?: string;
}

export interface InboxQuery {
	readonly ids?: readonly string[];
	readonly all?: boolean;
	readonly cursor?: string;
	readonly limit: number;
}

export interface InboxPage {
	/** Oldest first, each with its delivery as it was before this read. */
	readonly records: readonly MessageRecord[];
	readonly nextCursor?: string;
	/** IDs asked for that are not in this inbox (MCP-4.2): reported as not found, nothing of another inbox shown. */
	readonly missing: readonly string[];
}

/** The message service the tool service and Message History use. */
export interface Messages {
	/** The first message sent by this caller with this request ID within the last hour, including routed sends. */
	findRequest(from: RunId, requestId: string): MessageRecord | undefined;
	/** Sends one message, answering within the response budget (RULES-1.2); an accepted one reports its outcome later. */
	send(request: SendRequest): Promise<SendResult>;
	/**
	 * Takes the ID of a message from `from` not sent yet, and answers the text its recipient's CLI is given for it: its header naming
	 * the sender and this window, the whole text and its footer (COLLABORATION-2.1). A creation prompt is made so before its launch,
	 * so that the native path gives the CLI the message its record keeps (COLLABORATION-2.2); it is sent or recorded with that ID.
	 */
	allocate(request: { readonly from: RunId; readonly text: string; readonly party?: MessageRecord['from']; readonly label?: string }): { readonly id: string; readonly text: string };
	/** A start's creation prompt went in natively: recorded as the caller's message to the child with its outcome (COLLABORATION-2.2). */
	recordPrompt(request: Omit<SendRequest, 'elapsedMs'>, delivery: MessageRecord['delivery']): MessageRecord;
	/**
	 * A Facade result about an operation other than a message - a start that completed after its accepted response (MCP-1.3): a
	 * `result` record in `to`'s inbox, delivered with its own budget, ending quietly where it cannot be (RULES-1.7).
	 */
	report(request: { readonly to: RunId; readonly callId?: string; readonly agent?: RunId; readonly agentParty?: MessageRecord['agent']; readonly about?: string; readonly text: string }): MessageRecord;
	/** Keeps a copy of a message this window's agent sent to another window's, for Message History; its outcome updates it. */
	keepSent(record: MessageRecord): void;
	/** The caller's own inbox, never another's (MCP-4.2). */
	inbox(run: RunId, query: InboxQuery): InboxPage;
	/**
	 * Delivers the records of `run`'s inbox that a read handed back and that were not delivered yet (COLLABORATION-3.1): one still being
	 * delivered cancels unstarted typing and lets an already pasted owned draft finish, while its sender's result immediately says
	 * read_messages delivered it; one that failed is now
	 * delivered, and its sender, told of the failure already, is not told again.
	 */
	markDelivered(run: RunId, ids: readonly string[]): void;
	/** The records involving this window's runs, for Message History (COLLABORATION-3.2). */
	history(): readonly MessageRecord[];
	readonly onDidRecord: (listener: (record: MessageRecord) => void) => { dispose(): void };
}

/** A run's ordinary message input (CLIS-2.1, RULES-1.4): only a `supported` capability is ever typed into. */
export interface InputPort {
	capability(run: RunId): CapabilityState;
	/**
	 * The input now: a usable composer without draft, a draft - `own` where it is `own` alone as its CLI draws it, after `lead` where
	 * that was typed, the message an earlier attempt wrote whole (RULES-1.6), and `seen` itself where its CLI drew it as a placeholder
	 * then (D118) - a native interaction, or unknown.
	 */
	inspect(run: RunId, own?: string, lead?: string, seen?: string): Promise<'usable' | 'draft' | 'own' | 'interaction' | 'unknown'>;
	/**
	 * Pastes the complete text once - `lead` typed before it where its CLI takes a paste alone as material (D108) - and presses Enter
	 * once the input shows it as its own draft, answering what actually went in and whether the input showed it (RULES-1.3, 1.6,
	 * 1.10). Once `signal` aborts - the attempt's deadline passed, or its run ended - nothing more goes in. `canPaste` is checked
	 * immediately before writing: a read cancels an unstarted paste without interrupting an already-issued owned draft.
	 */
	submit(run: RunId, text: string, signal?: AbortSignal, lead?: string, canPaste?: () => boolean): Promise<Submission>;
	/**
	 * Presses Enter where the input holds `text` alone as its own draft, after `lead` where that was typed, written whole by an earlier
	 * attempt - `seen` itself where it showed as a placeholder (D118) - and answers what went in: nothing where it holds anything else
	 * (RULES-1.6). Once `signal` aborts nothing more goes in.
	 */
	enter(run: RunId, text: string, signal?: AbortSignal, lead?: string, seen?: string): Promise<InputEffects>;
	/** How much longer than usual a paste of `text` into `run`'s CLI takes to show and be taken: its size, and lines for some (D105, D118). */
	pasteTime?(run: RunId, text: string): number;
}

/** What one submission did: what went in, and whether the input showed the message as its own draft, as which (RULES-1.6, D118). */
export interface Submission {
	readonly effects: InputEffects;
	readonly shown: boolean;
	/** The draft it showed as, its own and alone, where it did. */
	readonly draft?: string;
}

/** Explicit contact with the person in the sender's window (COLLABORATION-2.3): true once handed to the editor. */
export interface HumanContactPort {
	/** `saved` gives a message's record as it is kept when asked, by its ID: what Show opens, never a copy made at handoff. */
	contact(record: MessageRecord, saved: (id: string) => MessageRecord | undefined): boolean;
}
