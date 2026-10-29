/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentState, Caller, ForeignCaller } from '../record/events';
import { ForeignAgent, isForeign } from '../record/messages';
import { OutboxNotice } from '../record/outbox';

/**
 * A workspace of the machine that did not answer, named, and why: it is silent - reloading, restarting its extension
 * host, recovering from a renderer crash, or hung - or its framework is off (AGENT-ORCHESTRATION.md, O8).
 */
export interface SilentWindow {
	readonly record: string;
	readonly label: string;
	readonly reason: 'not answering' | 'framework off';
}

/** An agent of another workspace, as that workspace lists it for a caller of this one: enough to find it by number or name. */
export interface RemoteAgent {
	readonly id: number;
	readonly name: string;
	readonly state: AgentState;
	/** Its workspace's record, and how the workspaces name that workspace. */
	readonly window: string;
	readonly label: string;
}

/** A workspace's answer to a query of this one's. */
export interface WindowAnswer {
	readonly record: string;
	readonly label: string;
	readonly answer: unknown;
}

/** What every other workspace answered to a query, and those that did not answer. */
export interface MachineAnswers {
	readonly answers: readonly WindowAnswer[];
	readonly silent: readonly SilentWindow[];
	/** Of a whole call handed every workspace, those that took it and gave no result: what it did there is unknown (O8). */
	readonly unknown?: readonly { readonly record: string; readonly label: string }[];
	/** Of a whole call handed every workspace, those that refused it before it ran, and why: it did not run there. */
	readonly refused?: readonly { readonly record: string; readonly label: string; readonly why: string }[];
}

/** Where a workspace is now: answering, silent, its framework off, or gone - closed, or its application instance ended (O8). */
export type Presence =
	| { readonly kind: 'live' | 'silent' | 'off'; readonly label: string; readonly load?: string }
	| { readonly kind: 'gone'; readonly label: string; readonly closed: boolean; readonly load?: string };

/** How long a reference or a folder waits for a silent workspace that may have it: a reload takes seconds (O8). */
export const SILENT_WAIT_MS = 10_000;

/**
 * The other workspaces of the machine, as the core reaches them (AGENT-ORCHESTRATION.md, O8): each keeps its own agents,
 * and this one asks them, or hands them a whole call, through their pipes. A call they did not accept is tried again
 * while they are silent; one they may have accepted, never. Notices go by file, which is safe to write again.
 */
export interface Machine {
	/** This workspace: its record, and how the others name it. */
	readonly self: { readonly record: string; readonly label: string };
	/**
	 * Asks every other live workspace `tool` with `args` - or, `only`, that one alone: what each answered, and those that did
	 * not. One silent is asked again, a second at a time, for up to `waitMs`; with none, waited for not at all.
	 */
	ask(tool: string, args: object, waitMs?: number, only?: string): Promise<MachineAnswers>;
	/**
	 * Asks `tool` as `ask` does, of every other workspace whose framework is on or off: what protects work there - a
	 * deletion's question of what each has in a folder - is answered whatever its switch (O5, O8).
	 */
	askEvery(tool: string, args: object, waitMs?: number): Promise<MachineAnswers>;
	/**
	 * Hands every other workspace, its framework on or off, a whole call - each once, sent again only where it was not
	 * taken - and waits for each to end it, a silent one for up to the timeout: what each answered, and those that did not,
	 * whose outcome is unknown (O5, O8).
	 */
	callEvery(tool: string, args: object): Promise<MachineAnswers>;
	/** Asks the workspace `record` `tool` with `args`; throws where it does not answer. */
	askOne(record: string, tool: string, args: object): Promise<unknown>;
	/** Hands the workspace `record` a whole call, which ends by its own rules; `progress` hears its progress lines. */
	call(record: string, tool: string, args: object, progress: (message: string) => void): Promise<unknown>;
	/**
	 * Leaves `notice` in the outbox of the workspace `record` and rings it: false where that workspace is gone, and nothing
	 * was left. A workspace silent or off takes it when it answers again (O8).
	 */
	notice(record: string, notice: OutboxNotice): boolean;
	/** Where the workspace `record` is now. */
	presence(record: string): Promise<Presence>;
	/** The workspaces of the machine, as they name themselves: those that answer, or are silent, or off - for a workspace argument (O2). */
	known(): Promise<readonly { readonly record: string; readonly label: string; readonly workspace?: string }[]>;
	/**
	 * Places the deletion mark of `folder` for this workspace (WORKTREE.md WT-8, step 3): placed, or refused where another
	 * workspace's live mark stands - its label - one whose window load ended taken away first.
	 */
	mark(folder: string): Promise<{ readonly placed: true } | { readonly placed: false; readonly by: string }>;
	/** Removes this workspace's deletion mark of `folder`, the deletion settled. */
	unmark(folder: string): Promise<void>;
	/** The label of the workspace whose live deletion mark covers `folder` - it, or a folder it is in; undefined for none. */
	markOver(folder: string): string | undefined;
	/** The labels of the windows of another Facade version there are now, which are not asked (WT-8, step 2). */
	otherVersions(): Promise<readonly string[]>;
}

/** The queries and calls a workspace takes from another (O8). */
export const WINDOW_REQUESTS = {
	rows: 'window.rows',
	tool: 'window.tool',
	start: 'window.start',
	messages: 'window.messages',
	human: 'window.human',
	tellHuman: 'window.tellHuman',
	reveal: 'window.reveal',
	folders: 'window.folders',
	workIn: 'window.workIn',
	workRelease: 'window.workRelease',
	deliver: 'window.deliver',
	ring: 'window.ring'
} as const;

/** The tools another workspace hands this one whole, for an agent of this workspace (O5, O8; AGENT-DEBUGGING.md, D1). */
export const FORWARDED_TOOLS: ReadonlySet<string> = new Set(['stop_agent', 'read_screen', 'type_text', 'press_keys']);

/** Who calls, as a workspace tells another: the caller as its own workspace knows it - number, name, YOLO and tree - and that workspace. */
export interface CallerIdentity {
	readonly id?: number;
	readonly name: string;
	readonly from: ForeignCaller;
}

/**
 * The caller a request names, each field checked - of another workspace, or of the one asked, named back to it, which
 * that workspace knows itself; undefined where it names none.
 */
export function callerOfRequest(value: unknown): Caller | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { id, name, from } = value as { [key: string]: unknown };
	if ((id !== undefined && !(typeof id === 'number' && Number.isInteger(id) && id > 0)) || typeof name !== 'string' || !name || typeof from !== 'object' || from === null) {
		return undefined;
	}
	const { window, label, yolo, creator, root, rootWindow, ancestors } = from as { [key: string]: unknown };
	const isNumber = (each: unknown) => each === undefined || (typeof each === 'number' && Number.isInteger(each) && each > 0);
	if (typeof window !== 'string' || !window || typeof label !== 'string' || (yolo !== undefined && typeof yolo !== 'boolean') || !isNumber(creator) || !isNumber(root)
		|| (rootWindow !== undefined && (typeof rootWindow !== 'string' || !rootWindow)) || (ancestors !== undefined && !(Array.isArray(ancestors) && ancestors.every(isForeign)))) {
		return undefined;
	}
	return {
		...(id !== undefined ? { id: id as number } : {}), name,
		from: {
			window, label, ...(yolo !== undefined ? { yolo: yolo as boolean } : {}), ...(creator !== undefined ? { creator: creator as number } : {}), ...(root !== undefined ? { root: root as number } : {}),
			...(rootWindow !== undefined ? { rootWindow: rootWindow as string } : {}), ...(ancestors !== undefined ? { ancestors: ancestors as ForeignAgent[] } : {})
		}
	};
}

/** Silent workspaces as words name them: `workspace lab (C:\src\lab, 1a2b3c4d) is not answering`. */
export function silentText(silent: readonly SilentWindow[]): string {
	return silent.map(each => `workspace ${each.label} ${each.reason === 'framework off' ? 'has its agent framework turned off' : 'is not answering (it may be reloading, restarting or busy)'}`).join('; ');
}
