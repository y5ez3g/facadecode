/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ErrorCode =
	/** An argument is missing or wrong. */
	| 'INVALID'
	/** What it names is not there: an agent, a worktree, a terminal. */
	| 'NOT_FOUND'
	/** Not the caller's to do: an agent that is not its parent or child, or one that has stopped. */
	| 'REFUSED'
	/** Facade cannot do it here and now: a CLI not installed, the window reloading. */
	| 'UNAVAILABLE'
	/** It was tried, and did not work. */
	| 'FAILED';

/**
 * How Facade's operations fail (WORKTREE-AGENTS.md, WA-5.7): with a message that says what is wrong
 * and what would be right, and one of five codes. The contract hands both to the model.
 */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, message: string) {
		super(message);
		this.name = 'FacadeError';
	}
}
