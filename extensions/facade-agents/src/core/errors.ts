/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StartPhase } from '../record/events';

/** What went wrong with a call to a Facade tool: the code its result carries. */
export type ErrorCode =
	/** An argument is missing or wrong. */
	| 'INVALID'
	/** What it names is not there: an agent, a worktree. */
	| 'NOT_FOUND'
	/** It is there, but the caller's reach, its state or a capability keeps the call from doing it. */
	| 'REFUSED'
	/** Facade cannot do it here and now: a CLI not installed, the window closing. */
	| 'UNAVAILABLE'
	/** It was tried, and did not work. */
	| 'FAILED';

/**
 * Where something happened already (AGENT-ORCHESTRATION.md, O2): `unknown`, its answer lost; `pending`,
 * still going on; or `failed`, ended as it says - with the agent it is about, and the worktree made for it.
 * Input into a terminal says what went in (AGENT-DEBUGGING.md, D9): `not_applied`, nothing; `partial`, a
 * first part, the terminal ending before the rest.
 */
export interface ErrorOutcome {
	readonly outcome?: 'unknown' | 'pending' | 'failed' | 'not_applied' | 'partial';
	/**
	 * Why not all of an input went in: its terminal ended, it waited for its turn past its time, or - for input that
	 * needs the agent framework - the framework was off when its turn came.
	 */
	readonly reason?: 'ended' | 'timeout' | 'frameworkOff';
	/** For text typed: whether it was pasted, and whether Enter followed. */
	readonly pasted?: boolean;
	readonly entered?: boolean;
	/** For keys pressed: how many went in, from the first. */
	readonly keysSent?: number;
	/** The file the final screen of the agent is in, kept as its terminal ended (D6). */
	readonly finalScreen?: string;
	readonly agent?: number;
	/** The folder of a worktree made for it, which stays. */
	readonly worktree?: string;
	/** The agents the call stopped before it was refused: what happened all the same. */
	readonly stopped?: readonly number[];
	/** For a message to several cut short: those it recorded before it was, by number and recipient (AGENT-MESSAGES.md, M11; XS-02). */
	readonly sent?: readonly { readonly id: number; readonly to: string }[];
	/**
	 * Where the start of `agent` had got to (AGENT-ORCHESTRATION.md, O2); `validating`, with no `agent`, for one
	 * refused or failed before it was recorded: no run was made for it (O4; OR-18).
	 */
	readonly phase?: StartPhase | 'validating';
}

/** How Facade's operations fail: with one of five codes, and a message that says what is wrong and what would be right. */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, message: string, readonly outcome?: ErrorOutcome) {
		super(message);
		this.name = 'FacadeError';
	}
}
