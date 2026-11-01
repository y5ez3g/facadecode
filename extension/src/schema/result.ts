/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every tool's result (MCP-1.2): a status, its data, the error of a failure and the effects that actually happened - never more
// than happened, `unknown` where something may have. MCP gets it twice, as structured facts and as English text that states the
// same facts: a sentence saying what came of the call, then every field of the structured result.

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

/**
 * MCP's answer for `result`: `headline`, a sentence or two saying what came of the call - by default its status and any error - then
 * every field of the structured result, so that text and structure state the same facts (MCP-6.2). Failure alone is an MCP error.
 */
export function answerOf(result: Result, headline?: string): ToolAnswer {
	const text = `${headline ?? headlineOf(result)}\n\n${renderFacts(result).join('\n')}`;
	return { text, structured: result as unknown as { readonly [key: string]: unknown }, isError: result.status === 'failure' };
}

function headlineOf(result: Result): string {
	switch (result.status) {
		case 'success': return 'Succeeded.';
		case 'accepted': return 'Accepted: the operation continues, and a Facade result reports its outcome later.';
		case 'failure': return `Failed: ${result.error?.message ?? 'no reason was given.'}`;
	}
}

/** The fields of `value` as indented `key: value` lines, lists as `- item`: every field, none left out or reworded. */
export function renderFacts(value: { readonly [key: string]: unknown } | Result, indent = 0): string[] {
	return Object.entries(value).flatMap(([key, each]) => field(key, each, indent));
}

function field(key: string, value: unknown, indent: number): string[] {
	if (value === undefined) {
		return [];
	}
	const pad = '  '.repeat(indent);
	if (Array.isArray(value)) {
		return value.length ? [`${pad}${key}:`, ...items(value, indent + 1)] : [`${pad}${key}: []`];
	}
	if (isObject(value)) {
		const lines = renderFacts(value, indent + 1);
		return lines.length ? [`${pad}${key}:`, ...lines] : [`${pad}${key}: {}`];
	}
	if (isBlock(value)) {
		return [`${pad}${key}: ${blockOf(value, indent + 1)}`];
	}
	return [`${pad}${key}: ${scalar(value)}`];
}

function items(values: readonly unknown[], indent: number): string[] {
	const pad = '  '.repeat(indent);
	return values.flatMap(value => {
		if (Array.isArray(value)) {
			return value.length ? [`${pad}-`, ...items(value, indent + 1)] : [`${pad}- []`];
		}
		if (isObject(value)) {
			const lines = renderFacts(value, indent + 1);
			// The item's first field on the dash's line, as YAML writes a list of objects
			return lines.length ? [`${pad}- ${lines[0].trimStart()}`, ...lines.slice(1)] : [`${pad}- {}`];
		}
		return [`${pad}- ${isBlock(value) ? blockOf(value, indent + 1) : scalar(value)}`];
	});
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of several lines, with no control but tabs and line feeds: shown as it reads, as a block. */
function isBlock(value: unknown): value is string {
	// eslint-disable-next-line no-control-regex
	return typeof value === 'string' && value.includes('\n') && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

/**
 * `text` as a YAML literal block: its indicator - `|-` without a final line break, `|` with one, `|+` with more - then each of
 * its lines indented under the field, so that no line of it can stand for another field and its exact text can be read back.
 */
function blockOf(text: string, indent: number): string {
	const pad = '  '.repeat(indent);
	const body = text.replace(/\n+$/, '');
	const trailing = text.length - body.length;
	return [trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+', ...body.split('\n').map(line => pad + line), ...Array.from({ length: Math.max(0, trailing - 1) }, () => pad)].join('\n');
}

/**
 * A scalar as text: a plain one-line string as it is; any other - empty, padded, with tabs or controls, or one that would read
 * as a number, boolean or null - quoted as JSON, so that its exact content shows.
 */
function scalar(value: unknown): string {
	if (typeof value !== 'string') {
		return value === null ? 'null' : String(value);
	}
	// eslint-disable-next-line no-control-regex
	const plain = value !== '' && value === value.trim() && !value.startsWith('"') && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
		&& !/^(?:true|false|null|-?\d[\d.e+-]*)$/i.test(value);
	return plain ? value : JSON.stringify(value);
}
