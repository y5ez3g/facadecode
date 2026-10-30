/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The error codes of a Facade failure. */
export type ErrorCode = 'INVALID' | 'NOT_FOUND';

/** A failure with its code, its machine reason and an English message for logs. */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, readonly reason: string, message: string) {
		super(message);
	}
}

export function invalid(reason: string, message: string): FacadeError {
	return new FacadeError('INVALID', reason, message);
}
