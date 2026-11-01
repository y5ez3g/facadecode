/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The error codes of every Facade failure, an agent's tool result among them (MCP-1.2). */
export type ErrorCode = 'INVALID' | 'NOT_FOUND' | 'REFUSED' | 'UNAVAILABLE' | 'FAILED';

/** A failure with its code, its machine reason and an English message for agents and logs (MCP-1.2). */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, readonly reason: string, message: string) {
		super(message);
	}
}

export function invalid(reason: string, message: string): FacadeError {
	return new FacadeError('INVALID', reason, message);
}
