/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
 * Where something may have happened already (AGENT-ORCHESTRATION.md, O2): `unknown`, its answer lost; or
 * `pending`, still going on - with the agent it is about.
 */
export interface ErrorOutcome {
	readonly outcome: 'unknown' | 'pending';
	readonly agent?: number;
}

/** How Facade's operations fail: with one of five codes, and a message that says what is wrong and what would be right. */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, message: string, readonly outcome?: ErrorOutcome) {
		super(message);
		this.name = 'FacadeError';
	}
}
