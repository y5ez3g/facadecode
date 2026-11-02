/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolAnswer } from '../schema/protocol';
import { answerOf, failure } from '../schema/result';
import { withRecovery } from '../schema/recovery';

/** The MCP-1.2 error codes a transport failure can have. */
export type FailureCode = 'INVALID' | 'NOT_FOUND' | 'UNAVAILABLE' | 'FAILED';

/**
 * The answer of a call no tool answered: it was not carried to the window, or the window's answer did not come back (MCP-1.2).
 * Both channels retain its diagnostic and effects; `unknown` where the call may have reached the window and acted.
 */
export function failureAnswer(code: FailureCode, reason: string, message: string, outcome: 'none' | 'unknown', call?: { readonly tool: string; readonly arguments: unknown }): ToolAnswer {
	return answerOf(withRecovery(call?.tool ?? '', failure({ code, reason, message }, {}, { outcome }), call?.arguments));
}

/** Whether `value` is a tool call's answer as a window gives it. */
export function isToolAnswer(value: unknown): value is ToolAnswer {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const { text, structured, isError } = value as { [key: string]: unknown };
	return typeof text === 'string' && !!structured && typeof structured === 'object' && !Array.isArray(structured) && typeof isError === 'boolean';
}
