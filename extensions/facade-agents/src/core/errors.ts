/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What went wrong with a call to a Facade tool: the code its result carries. */
export type ErrorCode =
	/** An argument is missing or wrong. */
	| 'INVALID'
	/** What it names is not there: a process, a worktree. */
	| 'NOT_FOUND'
	/** Not the caller's to do: a process that is not its child, or the person. */
	| 'REFUSED'
	/** Facade cannot do it here and now: a CLI not installed, the window closing. */
	| 'UNAVAILABLE'
	/** It was tried, and did not work. */
	| 'FAILED';

/** How Facade's operations fail: with one of five codes, and a message that says what is wrong and what would be right. */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, message: string) {
		super(message);
		this.name = 'FacadeError';
	}
}

/** The person did not let Facade start a CLI at full access, the only way it starts agents. */
export class FullAccessRefusedError extends FacadeError {
	constructor(cli: string) {
		super('REFUSED', `The person did not let Facade start ${cli} with full access, the only way it starts agents, so ${cli} is not started. Ask the person, or start another CLI: the person lets Facade start ${cli} by starting a ${cli} agent themselves, with Facade: Start Agent.`);
		this.name = 'FullAccessRefusedError';
	}
}
