/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolAnswer } from '../schema/protocol';

/** The MCP-1.2 error codes a transport failure can have. */
export type FailureCode = 'INVALID' | 'NOT_FOUND' | 'UNAVAILABLE' | 'FAILED';

/**
 * The answer of a call no tool answered: it was not carried to the window, or the window's answer did not come back (MCP-1.2).
 * Its text is its English message; `unknown` where the call may have reached the window and acted.
 */
export function failureAnswer(code: FailureCode, reason: string, message: string, outcome: 'none' | 'unknown'): ToolAnswer {
	return {
		text: message,
		structured: { status: 'failure', data: {}, error: { code, reason, message }, effects: { outcome } },
		isError: true
	};
}

/** Whether `value` is a tool call's answer as a window gives it. */
export function isToolAnswer(value: unknown): value is ToolAnswer {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const { text, structured, isError } = value as { [key: string]: unknown };
	return typeof text === 'string' && !!structured && typeof structured === 'object' && !Array.isArray(structured) && typeof isError === 'boolean';
}
