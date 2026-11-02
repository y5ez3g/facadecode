/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every tool's result (MCP-1.2): a status, its data, the error of a failure and the effects that actually happened - never more
// than happened, `unknown` where something may have. The current MCP result serializes the same object in both channels.

import { messageOf } from '../base/errors';
import type { ToolAnswer } from './protocol';

export type ErrorCode = 'INVALID' | 'NOT_FOUND' | 'REFUSED' | 'UNAVAILABLE' | 'FAILED';

const CODES: readonly string[] = ['INVALID', 'NOT_FOUND', 'REFUSED', 'UNAVAILABLE', 'FAILED'];

export interface Effects {
	readonly outcome: 'none' | 'confirmed' | 'partial' | 'unknown' | 'pending';
	readonly text_written?: 'none' | 'partial' | 'full' | 'unknown';
	readonly enter_written?: boolean | null;
	readonly keys_sent?: number;
	readonly agent_id?: string;
	readonly worktree_created?: string;
}

export interface ResultError {
	readonly code: ErrorCode;
	readonly reason: string;
	readonly message: string;
}

/** MCP-1.2's envelope. `accepted` is finite work continuing - neither success nor failure. */
export interface Result<T = unknown> {
	readonly status: 'success' | 'failure' | 'accepted';
	readonly data: T;
	readonly error?: ResultError;
	readonly effects: Effects;
}

export const NO_EFFECTS: Effects = { outcome: 'none' };

export function success<T>(data: T, effects: Effects = NO_EFFECTS): Result<T> {
	return { status: 'success', data, effects };
}

export function accepted<T>(data: T, effects: Effects): Result<T> {
	return { status: 'accepted', data, effects };
}

export function failure<T>(error: ResultError, data: T, effects: Effects = NO_EFFECTS): Result<T> {
	return { status: 'failure', data, error, effects };
}

/** An error with its MCP code and reason, as `FacadeError`, `ArgumentError` and a request that never left the window carry them. */
export function codedOf(err: unknown): ResultError | undefined {
	return err instanceof Error ? resultErrorOf({ code: (err as { code?: unknown }).code, reason: (err as { reason?: unknown }).reason, message: err.message }) : undefined;
}

/** `value` where it is a result's error, as another window answers one: its MCP code, reason and message. */
export function resultErrorOf(value: unknown): ResultError | undefined {
	const { code, reason, message } = (typeof value === 'object' && value !== null ? value : {}) as { code?: unknown; reason?: unknown; message?: unknown };
	return typeof code === 'string' && CODES.includes(code) && typeof reason === 'string' && typeof message === 'string' ? { code: code as ErrorCode, reason, message } : undefined;
}

/**
 * The failure an error comes to. A coded error keeps its code and reason, and by default claims no effect: it is thrown before any.
 * Anything else, in a call that only reads, is UNAVAILABLE with no effect: a read changes nothing, whatever stopped it. Otherwise it
 * is FAILED with its actual message, and by default `unknown` effects: where it came from, something may have happened.
 */
export function errorResult<T = { readonly [key: string]: unknown }>(err: unknown, options: { readonly effects?: Effects; readonly data?: T; readonly readOnly?: boolean } = {}): Result<T> {
	const data = options.data ?? ({} as T);
	const coded = codedOf(err);
	if (coded) {
		return failure(coded, data, options.effects ?? NO_EFFECTS);
	}
	if (options.readOnly) {
		return failure({ code: 'UNAVAILABLE', reason: 'unavailable', message: messageOf(err) }, data, NO_EFFECTS);
	}
	return failure({ code: 'FAILED', reason: 'unexpected_error', message: messageOf(err) }, data, options.effects ?? { outcome: 'unknown' });
}

/** One public object in either channel; JSON escaping preserves exact content and distinguishes null/false/empty. */
export function answerOf(result: Result): ToolAnswer {
	const text = JSON.stringify(result);
	return { text, structured: JSON.parse(text), isError: result.status === 'failure' };
}
