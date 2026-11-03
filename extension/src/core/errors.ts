/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FacadeReason } from './ports';

/** The error codes of every Facade failure, an agent's tool result among them (MCP-1.2). */
export type ErrorCode = 'INVALID' | 'NOT_FOUND' | 'REFUSED' | 'UNAVAILABLE' | 'FAILED';

/**
 * A failure with its code, its machine reason and an English message for agents and logs (MCP-1.2); `said`, where given, is what the
 * UI words in the person's language in place of that message (UX-2.4).
 */
export class FacadeError extends Error {
	constructor(readonly code: ErrorCode, readonly reason: string, message: string, readonly said?: FacadeReason) {
		super(message);
	}
}

export function invalid(reason: string, message: string, said?: FacadeReason): FacadeError {
	return new FacadeError('INVALID', reason, message, said);
}

/** Another window owns this workspace now (ARCHITECTURE-2.2), as the person is told it in their language (UX-2.4). */
export const OWNERSHIP_LOST: FacadeReason = { kind: 'ownership_lost', values: [] };
