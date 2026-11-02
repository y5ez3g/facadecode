/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Result } from '../schema/result';

/** Readable text stored for Message History; never an MCP answer or protocol adapter. */
export function receiptTextOf(result: Result, headline?: string): string {
	return `${headline ?? headlineOf(result)}\n\n${renderFacts(result).join('\n')}`;
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
