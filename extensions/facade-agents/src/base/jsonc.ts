/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * JSON as a program's settings file has it - comments and trailing commas allowed - read with where each of
 * its parts is, so that what Facade adds to it goes in as an edit of the text: the rest of the file, its
 * comments, a number too large for JavaScript, a key written twice and its layout, stays as it was (X-48).
 */

/** Where a part of a JSON text is: from `start` up to `end`, not included. */
interface Place {
	readonly start: number;
	readonly end: number;
}

export interface JsonObjectNode extends Place {
	readonly kind: 'object';
	/** In the order written, a key written twice twice: the last is the one a reader takes. */
	readonly members: readonly JsonMember[];
}

export interface JsonMember {
	readonly key: string;
	readonly keyStart: number;
	readonly keyEnd: number;
	readonly value: JsonNode;
}

export interface JsonArrayNode extends Place {
	readonly kind: 'array';
	readonly items: readonly JsonNode[];
}

export interface JsonScalarNode extends Place {
	readonly kind: 'scalar';
	readonly value: string | number | boolean | null;
}

/** A JSON value as it is written in a text, with where each of its parts is. */
export type JsonNode = JsonObjectNode | JsonArrayNode | JsonScalarNode;

/** A change to a JSON text: `length` characters at `offset` replaced by `text`. */
export interface JsonEdit {
	readonly offset: number;
	readonly length: number;
	readonly text: string;
}

/** How a JSON text is written, for what is added to it to be written the same way. */
export interface JsonStyle {
	readonly lineEnding: string;
	/** One level of indentation. */
	readonly unit: string;
	/** All on one line: what is added goes in without line breaks or spaces. */
	readonly compact: boolean;
	/** Between a key and its value: `": "` or `":"`. */
	readonly colon: string;
	/** Between the items of a list on one line: `", "` or `","`. */
	readonly comma: string;
}

const BYTE_ORDER_MARK = 0xfeff;

/** The longest number text read: longer is no number a settings file has. */
const NUMBER_TEXT_MAX = 512;

/** Reads a JSON text, comments and trailing commas allowed, and a byte order mark; throws a `SyntaxError` for anything else. */
export function parseJsonc(text: string): JsonNode {
	let at = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
	const fail = (what: string): never => {
		throw new SyntaxError(`${what} was expected at offset ${at}`);
	};
	const blank = () => {
		for (; ;) {
			const char = text[at];
			if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
				at++;
			} else if (text.startsWith('//', at)) {
				const end = text.indexOf('\n', at);
				at = end < 0 ? text.length : end;
			} else if (text.startsWith('/*', at)) {
				const end = text.indexOf('*/', at + 2);
				if (end < 0) {
					fail('The end of a comment');
				}
				at = end + 2;
			} else {
				return;
			}
		}
	};
	const string = (): string => {
		const start = at;
		for (at++; at < text.length; at++) {
			const char = text[at];
			if (char === '\\') {
				at++;
			} else if (char === '"') {
				at++;
				return JSON.parse(text.slice(start, at));
			}
		}
		return fail('The end of a string');
	};
	const value = (): JsonNode => {
		blank();
		const start = at;
		const char = text[at];
		if (char === '{') {
			at++;
			const members: JsonMember[] = [];
			for (; ;) {
				blank();
				if (text[at] === '}') {
					at++;
					return { kind: 'object', start, end: at, members };
				}
				if (text[at] !== '"') {
					fail('A key');
				}
				const keyStart = at;
				const key = string();
				const keyEnd = at;
				blank();
				if (text[at] !== ':') {
					fail('A colon');
				}
				at++;
				members.push({ key, keyStart, keyEnd, value: value() });
				blank();
				if (text[at] === ',') {
					at++;
				} else if (text[at] !== '}') {
					fail('A comma or the end of an object');
				}
			}
		}
		if (char === '[') {
			at++;
			const items: JsonNode[] = [];
			for (; ;) {
				blank();
				if (text[at] === ']') {
					at++;
					return { kind: 'array', start, end: at, items };
				}
				items.push(value());
				blank();
				if (text[at] === ',') {
					at++;
				} else if (text[at] !== ']') {
					fail('A comma or the end of a list');
				}
			}
		}
		if (char === '"') {
			const read = string();
			return { kind: 'scalar', start, end: at, value: read };
		}
		const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + NUMBER_TEXT_MAX));
		if (!literal) {
			return fail('A value');
		}
		at += literal[0].length;
		return { kind: 'scalar', start, end: at, value: JSON.parse(literal[0]) };
	};
	const root = value();
	blank();
	if (at < text.length) {
		fail('The end of the text');
	}
	return root;
}

/** What `node` holds, as `JSON.parse` would read it: of a key written twice, the last. */
export function nodeValue(node: JsonNode): unknown {
	switch (node.kind) {
		case 'object': return Object.fromEntries(node.members.map(member => [member.key, nodeValue(member.value)]));
		case 'array': return node.items.map(nodeValue);
		case 'scalar': return node.value;
	}
}

/** The member of `node` a reader takes for `key`: of one written twice, the last. */
export function memberOf(node: JsonObjectNode, key: string): JsonMember | undefined {
	for (let i = node.members.length - 1; i >= 0; i--) {
		if (node.members[i].key === key) {
			return node.members[i];
		}
	}
	return undefined;
}

/** How `text`, read as `root`, is written: its line ending and indentation as given, its spacing as it has it. */
export function jsonStyleOf(text: string, root: JsonNode, lineEnding: string, indent: '\t' | number): JsonStyle {
	// An empty one tells nothing of how its writer lays it out: what is added is laid out
	const empty = root.kind === 'object' ? !root.members.length : root.kind === 'array' ? !root.items.length : true;
	const compact = !empty && !text.slice(root.start, root.end).includes('\n');
	let colon: string | undefined;
	let comma: string | undefined;
	const visit = (node: JsonNode) => {
		if (node.kind === 'object') {
			node.members.forEach((member, i) => {
				colon ??= /:\s/.test(text.slice(member.keyEnd, member.value.start)) ? ': ' : ':';
				const next = node.members[i + 1];
				const between = next && text.slice(member.value.end, next.keyStart);
				if (between !== undefined && !between.includes('\n')) {
					comma ??= /,\s/.test(between) ? ', ' : ',';
				}
				visit(member.value);
			});
		} else if (node.kind === 'array') {
			node.items.forEach((item, i) => {
				const next = node.items[i + 1];
				const between = next && text.slice(item.end, next.start);
				if (between !== undefined && !between.includes('\n')) {
					comma ??= /,\s/.test(between) ? ', ' : ',';
				}
				visit(item);
			});
		}
	};
	visit(root);
	return {
		lineEnding,
		unit: indent === '\t' ? '\t' : ' '.repeat(indent),
		compact,
		colon: colon ?? (compact ? ':' : ': '),
		comma: comma ?? (compact ? ',' : ', ')
	};
}

/** The text with `edits` made, none of them overlapping another. */
export function applyJsonEdits(text: string, edits: readonly JsonEdit[]): string {
	let result = text;
	for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
		result = result.slice(0, edit.offset) + edit.text + result.slice(edit.offset + edit.length);
	}
	return result;
}

/** `value` written as `style` writes it, on a line indented by `indent`. */
function written(value: unknown, indent: string, style: JsonStyle): string {
	return style.compact ? JSON.stringify(value) : JSON.stringify(value, undefined, style.unit).split('\n').join(style.lineEnding + indent);
}

/** The indentation of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

/**
 * Where to add after the last part of an object or a list, which ends at `end`, closed at `close`: past a
 * trailing comma, whether it has one, and past a comment on its line, which stays with it.
 */
function after(text: string, end: number, close: number): { readonly comma: number | undefined; readonly at: number } {
	let at = end;
	for (; ;) {
		while (text[at] === ' ' || text[at] === '\t') {
			at++;
		}
		if (text.startsWith('/*', at) && text.indexOf('*/', at) >= 0 && !text.slice(at, text.indexOf('*/', at)).includes('\n')) {
			at = text.indexOf('*/', at) + 2;
		} else if (text[at] === ',' && at < close) {
			return { comma: at, at: lineCommentEnd(text, at + 1) };
		} else {
			return { comma: undefined, at: lineCommentEnd(text, at) === at ? end : lineCommentEnd(text, at) };
		}
	}
}

/** Past the spaces and the line comment at `offset` on its line, if it has one; else `offset`. */
function lineCommentEnd(text: string, offset: number): number {
	let at = offset;
	while (text[at] === ' ' || text[at] === '\t') {
		at++;
	}
	if (!text.startsWith('//', at)) {
		return offset;
	}
	const end = text.indexOf('\n', at);
	const lineEnd = end < 0 ? text.length : end;
	return text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
}

/**
 * Adds `entries` - each written by `write`, on a line indented as given - after the last part of `parts`
 * that ends at `lastEnd`, in a container from `start` to `end`, or into it, empty: on lines of their own where
 * it has its parts on lines of their own or is empty in a text that is not compact, else on its line.
 */
function added(text: string, start: number, end: number, first: number | undefined, lastEnd: number | undefined, entries: readonly ((indent: string) => string)[], style: JsonStyle): readonly JsonEdit[] {
	const inner = text.slice(start + 1, end - 1);
	if (first === undefined || lastEnd === undefined) {
		if (style.compact) {
			return [{ offset: start + 1, length: 0, text: entries.map(entry => entry('')).join(style.comma.trim()) }];
		}
		const closeIndent = indentAt(text, start);
		const indent = closeIndent + style.unit;
		// An empty one with only blanks inside has them replaced; one with a comment keeps it, after what is added
		const onlyBlank = !/\S/.test(inner);
		return [{
			offset: start + 1,
			length: onlyBlank ? inner.length : 0,
			text: `${style.lineEnding}${indent}${entries.map(entry => entry(indent)).join(`,${style.lineEnding}${indent}`)}${onlyBlank ? `${style.lineEnding}${closeIndent}` : ''}`
		}];
	}
	const { comma, at } = after(text, lastEnd, end - 1);
	const multiline = !style.compact && text.slice(start, end).includes('\n');
	const indent = multiline ? indentAt(text, first) : '';
	const separator = multiline ? `${style.lineEnding}${indent}` : style.comma.slice(1);
	const each = entries.map(entry => `${separator}${entry(indent)}`);
	if (comma !== undefined) {
		// A trailing comma stays one: each added has its own
		return [{ offset: at, length: 0, text: each.map(part => `${part},`).join('') }];
	}
	return at === lastEnd
		? [{ offset: lastEnd, length: 0, text: `,${each.join(',')}` }]
		: [{ offset: lastEnd, length: 0, text: ',' }, { offset: at, length: 0, text: each.join(',') }];
}

/** The edits that add `members` to the object `node` of `text`, written as `style` writes JSON. */
export function addMembers(text: string, node: JsonObjectNode, members: readonly (readonly [string, unknown])[], style: JsonStyle): readonly JsonEdit[] {
	const first = node.members[0];
	const last = node.members.at(-1);
	return added(text, node.start, node.end, first?.keyStart, last?.value.end, members.map(([key, value]) => (indent: string) => `${JSON.stringify(key)}${style.colon}${written(value, indent, style)}`), style);
}

/** The edits that add `items` to the end of the list `node` of `text`, written as `style` writes JSON. */
export function addItems(text: string, node: JsonArrayNode, items: readonly unknown[], style: JsonStyle): readonly JsonEdit[] {
	return added(text, node.start, node.end, node.items[0]?.start, node.items.at(-1)?.end, items.map(item => (indent: string) => written(item, indent, style)), style);
}

/** The edit that puts `value` in the place of `node` in `text`, written as `style` writes JSON. */
export function replaceValue(text: string, node: JsonNode, value: unknown, style: JsonStyle): JsonEdit {
	return { offset: node.start, length: node.end - node.start, text: written(value, indentAt(text, node.start), style) };
}
