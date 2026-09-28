/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UsageRecord } from '../model';

/*
 * The shared state of one workspace (L2-PLAN, step 26): who is in it, the messages between them, and
 * the notebook they share. Everything that happens is an event in the workspace's ledger first; the
 * state is what replaying the ledger gives.
 */

/** The person, in every workspace. */
export const YOU = 'you';
/** The author of the notices Facade sends and of the pages it writes itself. */
export const FACADE = 'facade';
/** Names no agent may take. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([YOU, FACADE, 'all', 'everyone', 'me']);

export type ParticipantKind = 'person' | 'agent';

/**
 * starting   spawned, not heard from yet
 * working    in the middle of a turn
 * waiting    stopped in its terminal on a question or a permission prompt
 * idle       its turn ended; it is still open, at its prompt
 * stopped    gone: stopped, or its process ended for good
 * failed     it could not start, or it crashed
 */
export type ParticipantState = 'starting' | 'working' | 'waiting' | 'idle' | 'stopped' | 'failed';

export interface Participant {
	readonly name: string;
	incarnation: number;
	kind: ParticipantKind;
	/** The agent and model it runs, as `claude` or `claude:sonnet`. */
	agent?: string;
	/** The folder it works in. */
	place?: string;
	startedBy?: string;
	/** The first message it was given. */
	text?: string;
	state: ParticipantState;
	stateDetail?: string;
	stateAt: number;
	readonly groups: Set<string>;
	tokenHash?: string;
	joinedAt: number;
	/** The start of the last message it sent. */
	lastSaid?: string;
	lastSaidAt?: number;
	usage?: UsageRecord;
}

export interface Message {
	readonly seq: number;
	readonly ts: number;
	/** A participant's name, or `facade` for a notice. */
	readonly from: string;
	/** The addresses as the sender wrote them: `@name` and `#group`. */
	readonly to: readonly string[];
	/** Who it went to, fixed when it was sent. */
	readonly recipients: readonly string[];
	readonly text: string;
	readonly replyTo?: number;
	/** Written by Facade: a page changed, or an agent started, stopped or waits. */
	readonly notice?: boolean;
}

export interface PageInfo {
	readonly page: string;
	version: number;
	/** Undefined when the page's file was changed directly rather than through `write`. */
	author: string | undefined;
	ts: number;
	/** sha256 of the content; empty once deleted. */
	hash: string;
	size: number;
	deleted: boolean;
}

export type WriteMode = 'replace' | 'append' | 'create';

export type LedgerEventBody =
	| {
		readonly type: 'participant.joined';
		readonly name: string;
		readonly incarnation: number;
		readonly kind: ParticipantKind;
		readonly agent?: string;
		readonly place?: string;
		readonly startedBy?: string;
		readonly text?: string;
		readonly groups: readonly string[];
		readonly tokenHash?: string;
	}
	| { readonly type: 'participant.state'; readonly name: string; readonly incarnation: number; readonly state: ParticipantState; readonly detail?: string }
	| { readonly type: 'participant.usage'; readonly name: string; readonly incarnation: number; readonly usage: UsageRecord }
	| { readonly type: 'group.joined'; readonly name: string; readonly group: string }
	| { readonly type: 'group.left'; readonly name: string; readonly group: string }
	| { readonly type: 'message.sent'; readonly from: string; readonly to: readonly string[]; readonly recipients: readonly string[]; readonly text: string; readonly replyTo?: number; readonly notice?: boolean }
	/** `cursor`, not `seq`: every event has a `seq` of its own. */
	| { readonly type: 'cursor.moved'; readonly name: string; readonly cursor: number }
	| {
		readonly type: 'page.written';
		readonly page: string;
		readonly version: number;
		/** Absent when the file was changed directly. */
		readonly author?: string;
		readonly mode: WriteMode | 'delete' | 'direct';
		readonly hash: string;
		readonly size: number;
		readonly deleted?: boolean;
	}
	| { readonly type: 'page.read'; readonly name: string; readonly page: string; readonly version: number }
	| { readonly type: 'folder.listed'; readonly name: string; readonly folder: string };

export type LedgerEvent = LedgerEventBody & { readonly seq: number; readonly ts: number };

export interface KernelState {
	seq: number;
	readonly participants: Map<string, Participant>;
	/** Every message, in order. */
	readonly messages: Message[];
	/** Each participant's messages, in order. */
	readonly inboxes: Map<string, Message[]>;
	/** The last message each participant has taken with `recv`. */
	readonly cursors: Map<string, number>;
	readonly pages: Map<string, PageInfo>;
	/** For each page, who read it and at which version: each of them hears once when it changes. */
	readonly readers: Map<string, Map<string, number>>;
	/** For each folder, who listed it: each of them hears once when a page comes or goes in it. */
	readonly folderWatchers: Map<string, Set<string>>;
	/** Token hash to the incarnation it belongs to. */
	readonly tokens: Map<string, { readonly name: string; readonly incarnation: number }>;
}

/** Who a call comes from. */
export interface Caller {
	readonly name: string;
	readonly incarnation: number;
}
