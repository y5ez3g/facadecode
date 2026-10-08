/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonObject } from '../base/json';

/** What went wrong with a call to a Facade tool: the code its result carries. */
export type ErrorCode =
	/** An argument is missing or wrong. */
	| 'INVALID'
	/** What it names is not there: an agent, a worktree. */
	| 'NOT_FOUND'
	/** Not the caller's to do: an agent that is not its child, or the person. */
	| 'REFUSED'
	/** Facade cannot do it here and now: a CLI not installed, the window closing. */
	| 'UNAVAILABLE'
	/** It was tried, and did not work. */
	| 'FAILED';

/**
 * How Facade's operations fail: with one of five codes, and a message that says what is wrong and what
 * would be right. `data` holds the facts of what happened all the same - what went into a terminal before
 * it ended, whether that is known at all - which the result's data carries beside the code.
 */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, message: string, readonly data?: JsonObject) {
		super(message);
		this.name = 'FacadeError';
	}
}
