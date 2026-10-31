/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tool call's arguments checked against its tool's schema before any effect (MCP-1.1): a JSON object of known keys and exact
// types - nothing coerced but a list given as one string or written as JSON text, as some CLIs send one (D96), and no default
// but the schema's own - with every missing required field reported together, then the checks particular to each tool
// (MCP-4.1, 4.2, 5.2).

import { isJsonObject } from '../base/json';
import { normalizeKey } from './keys';
import { ArgumentSchema, ToolName, TOOLS } from './tools';

/** Each tool's arguments once valid: defaults filled in, `ids` and `keys` as lists, keys named as ptyd names them. */
export interface ToolArguments {
	readonly list_start_options: { readonly window_id?: string; readonly location_id?: string; readonly cli?: string };
	readonly start_agent: {
		readonly name: string;
		readonly window_id: string;
		readonly location_id: string;
		readonly cli: string;
		readonly model?: string;
		readonly effort?: string;
		readonly prompt?: string;
		readonly worktree?: { readonly branch: string; readonly base_ref: string };
	};
	readonly list_agents: { readonly window_id?: string; readonly include_ended: boolean; readonly cursor?: string; readonly limit: number };
	readonly stop_agent: { readonly agent: string };
	readonly send_message: { readonly to: string; readonly text: string; readonly reply_to?: string };
	readonly read_messages: { readonly ids?: readonly string[]; readonly all: boolean; readonly cursor?: string; readonly limit: number };
	readonly read_screen: { readonly agent: string; readonly lines: number };
	readonly type_text: { readonly agent: string; readonly text: string; readonly enter: boolean };
	readonly press_keys: { readonly agent: string; readonly keys: readonly string[] };
}

export interface ArgumentProblems {
	/** Required fields absent, all of them: `worktree.branch` for a nested one. */
	readonly missing: readonly string[];
	readonly invalid: readonly { readonly field: string; readonly problem: string }[];
}

/** Arguments that cannot be used: INVALID, `missing_argument` where any required field is absent, else `invalid_argument`. */
export class ArgumentError extends Error {
	readonly code = 'INVALID';
	readonly reason: 'missing_argument' | 'invalid_argument';

	constructor(readonly tool: string, readonly problems: ArgumentProblems) {
		super(messageOf(tool, problems));
		this.reason = problems.missing.length ? 'missing_argument' : 'invalid_argument';
	}
}

function messageOf(tool: string, { missing, invalid }: ArgumentProblems): string {
	const parts: string[] = [];
	if (missing.length) {
		parts.push(`${tool} requires ${missing.map(field => `\`${field}\``).join(', ')}.`);
	}
	parts.push(...invalid.map(each => each.problem));
	return parts.join(' ');
}

type Schema = { readonly [key: string]: unknown };

interface Collector {
	readonly missing: string[];
	readonly invalid: { field: string; problem: string }[];
}

/** C0 and C1 controls but tab, line feed and carriage return; DEL among them. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cs}/u;

/** The arguments of a call to `tool`, valid; an {@link ArgumentError} with every problem otherwise. */
export function validateArguments<T extends ToolName>(tool: T, args: unknown): ToolArguments[T] {
	const definition = TOOLS.find(each => each.name === tool);
	if (!definition) {
		throw new ArgumentError(tool, { missing: [], invalid: [{ field: '', problem: `Facade has no tool ${tool}.` }] });
	}
	const problems: Collector = { missing: [], invalid: [] };
	// MCP lets a call without arguments leave them out: that is the empty object, not a coercion
	const given = args === undefined ? {} : args;
	if (!isJsonObject(given)) {
		throw new ArgumentError(tool, { missing: [], invalid: [{ field: '', problem: `The arguments must be a JSON object, not ${kindOf(given)}.` }] });
	}
	const value = objectOf(definition.inputSchema, given, '', `an argument of ${tool}`, problems) as { [key: string]: unknown };
	// The tool's own checks look at each field that has its type, so that one call reports every problem
	CHECKS[tool](value, given, problems);
	if (problems.missing.length || problems.invalid.length) {
		throw new ArgumentError(tool, problems);
	}
	return value as unknown as ToolArguments[T];
}

function objectOf(schema: ArgumentSchema | Schema, given: { readonly [key: string]: unknown }, prefix: string, what: string, problems: Collector): unknown {
	const properties = (schema.properties ?? {}) as { readonly [name: string]: Schema };
	const required = (schema.required ?? []) as readonly string[];
	const value: { [key: string]: unknown } = {};
	for (const key of Object.keys(given)) {
		if (!Object.hasOwn(properties, key)) {
			problems.invalid.push({ field: prefix + key, problem: `\`${prefix + key}\` is not ${what}.` });
		}
	}
	for (const [key, property] of Object.entries(properties)) {
		const field = prefix + key;
		const each = given[key];
		if (each === undefined) {
			if (required.includes(key)) {
				problems.missing.push(field);
			} else if (property.default !== undefined) {
				value[key] = property.default;
			}
			continue;
		}
		const checked = valueOf(property, each, field, problems);
		if (checked !== undefined) {
			value[key] = checked;
		}
	}
	return value;
}

/** `given` checked against `schema`; undefined, with its problems collected, where it does not fit. */
function valueOf(schema: Schema, given: unknown, field: string, problems: Collector): unknown {
	if (schema.type === 'array' && typeof given === 'string') {
		// One item alone, or the list as JSON text, as some CLIs send a list (D96)
		return valueOf(schema, encodedArray(given) ? JSON.parse(given) : [given], field, problems);
	}
	if (!typeFits(schema.type, given)) {
		problems.invalid.push({ field, problem: `\`${field}\` must be ${typeName(schema.type)}, not ${kindOf(given)}.` });
		return undefined;
	}
	const before = problems.missing.length + problems.invalid.length;
	switch (schema.type) {
		case 'string': {
			const text = given as string;
			const length = codePoints(text);
			if (typeof schema.minLength === 'number' && length < schema.minLength) {
				problems.invalid.push({ field, problem: `\`${field}\` must not be empty.` });
			} else if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
				problems.invalid.push({ field, problem: `\`${field}\` has ${length} Unicode code points; at most ${schema.maxLength} are taken.` });
			}
			break;
		}
		case 'integer': {
			const n = given as number;
			if ((typeof schema.minimum === 'number' && n < schema.minimum) || (typeof schema.maximum === 'number' && n > schema.maximum)) {
				problems.invalid.push({ field, problem: `\`${field}\` must be from ${schema.minimum} to ${schema.maximum}, not ${n}.` });
			}
			break;
		}
		case 'array': {
			const items = given as readonly unknown[];
			if (typeof schema.minItems === 'number' && items.length < schema.minItems) {
				problems.invalid.push({ field, problem: `\`${field}\` must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}.` });
			} else if (typeof schema.maxItems === 'number' && items.length > schema.maxItems) {
				problems.invalid.push({ field, problem: `\`${field}\` has ${items.length} items; at most ${schema.maxItems} are taken.` });
			}
			const checked = items.map((item, index) => valueOf(schema.items as Schema, item, `${field}[${index}]`, problems));
			return problems.missing.length + problems.invalid.length === before ? checked : undefined;
		}
		case 'object':
			return objectOf(schema, given as { readonly [key: string]: unknown }, `${field}.`, `a field of \`${field}\``, problems);
	}
	return problems.missing.length + problems.invalid.length === before ? given : undefined;
}

function typeFits(type: unknown, value: unknown): boolean {
	switch (type) {
		case 'string': return typeof value === 'string';
		case 'boolean': return typeof value === 'boolean';
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'array': return Array.isArray(value);
		case 'object': return isJsonObject(value);
		default: return false;
	}
}

function typeName(type: unknown): string {
	switch (type) {
		case 'string': return 'a string';
		case 'boolean': return 'a boolean';
		case 'integer': return 'an integer';
		case 'array': return 'an array';
		case 'object': return 'an object';
		default: return String(type);
	}
}

function kindOf(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'an integer' : 'a fractional number';
	}
	return typeof value === 'object' ? 'an object' : typeName(typeof value);
}

/** The Unicode code points of `text`: what MCP's text limits count. */
export function codePoints(text: string): number {
	let n = 0;
	for (const _ of text) {
		n++;
	}
	return n;
}

/** Where `text` has a control character it must not, and which: `U+001B at code point 5`. */
function controlIn(text: string): string | undefined {
	const match = CONTROL.exec(text);
	if (!match) {
		return undefined;
	}
	const code = match[0].codePointAt(0)!;
	return `U+${code.toString(16).toUpperCase().padStart(4, '0')}${code === 0x1b ? ' (Escape)' : ''} at code point ${codePoints(text.slice(0, match.index)) + 1}`;
}

/** A string that is a JSON array written out: the list itself, as some CLIs send a list argument (MCP-1.1, D96). */
function encodedArray(text: string): boolean {
	if (!/^\s*\[/.test(text)) {
		return false;
	}
	try {
		return Array.isArray(JSON.parse(text));
	} catch {
		return false;
	}
}

/** How Antigravity marks a long text argument it cut to its last 8,000 characters before it reached Facade (D107). */
const CUT_MARK = '[Earlier output truncated]';

/** A text whose beginning the caller's CLI cut off on the way: never passed on as though whole (MCP-4.1, D107). */
function checkWhole(field: string, text: string, problems: Collector): void {
	if (text.startsWith(CUT_MARK)) {
		problems.invalid.push({ field, problem: `\`${field}\` begins with ${JSON.stringify(CUT_MARK)}: your CLI cut its beginning off before Facade received it. Send it in shorter parts.` });
	}
}

/** A message body (MCP-4.1, COLLABORATION-2.1): nonblank, whole, and only text - a control would act outside the paste. */
function checkBody(field: string, text: string, problems: Collector): void {
	if (!text.trim()) {
		problems.invalid.push({ field, problem: `\`${field}\` must not be blank.` });
		return;
	}
	checkWhole(field, text, problems);
	const control = controlIn(text);
	if (control) {
		problems.invalid.push({ field, problem: `\`${field}\` contains the control character ${control}; a message takes text, tabs and line breaks only. press_keys sends terminal keys.` });
	}
}

function checkNotBlank(field: string, text: string | undefined, problems: Collector, hint = ''): void {
	if (text !== undefined && !text.trim()) {
		problems.invalid.push({ field, problem: `\`${field}\` must not be blank${hint}.` });
	}
}

type Value = { [key: string]: unknown };

const KNOWN_KEYS = 'press_keys knows Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right (or ArrowUp, ArrowDown, ArrowLeft, ArrowRight), Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z, and any one printable character; type_text types text.';

const CHECKS: { readonly [T in ToolName]: (value: Value, given: { readonly [key: string]: unknown }, problems: Collector) => void } = {
	list_start_options: () => undefined,
	start_agent: (value, _given, problems) => {
		const args = value as Partial<ToolArguments['start_agent']>;
		checkNotBlank('model', args.model, problems, '; leave it out to use the launch configuration and the CLI default');
		checkNotBlank('effort', args.effort, problems, '; leave it out to use the launch configuration and the CLI default');
		checkNotBlank('worktree.branch', args.worktree?.branch, problems);
		checkNotBlank('worktree.base_ref', args.worktree?.base_ref, problems);
		if (args.prompt !== undefined) {
			checkBody('prompt', args.prompt, problems);
		}
	},
	list_agents: () => undefined,
	stop_agent: () => undefined,
	send_message: (value, _given, problems) => {
		const text = (value as Partial<ToolArguments['send_message']>).text;
		if (text !== undefined) {
			checkBody('text', text, problems);
		}
	},
	read_messages: (value, given, problems) => {
		const ids = value.ids;
		if (ids === undefined) {
			return;
		}
		if (given.all === true || given.cursor !== undefined) {
			problems.invalid.push({ field: 'ids', problem: '`ids` selects messages itself and cannot be combined with `all` or `cursor`.' });
		}
	},
	read_screen: () => undefined,
	type_text: (value, _given, problems) => {
		const args = value as Partial<ToolArguments['type_text']>;
		if (args.text === undefined) {
			return;
		}
		const control = controlIn(args.text);
		checkWhole('text', args.text, problems);
		if (control) {
			problems.invalid.push({ field: 'text', problem: `\`text\` contains the control character ${control}; type_text types text, tabs and line breaks only. Use press_keys for Escape and other control keys.` });
		} else if (args.text === '' && !args.enter) {
			problems.invalid.push({ field: 'text', problem: '`text` is empty and `enter` is false: there is nothing to type.' });
		}
	},
	press_keys: (value, given, problems) => {
		const keys = value.keys as readonly string[] | undefined;
		if (keys === undefined) {
			return;
		}
		// A key given alone is named as it was given
		const alone = typeof given.keys === 'string' && !encodedArray(given.keys);
		const normalized: string[] = [];
		const before = problems.invalid.length;
		keys.forEach((key, index) => {
			const name = normalizeKey(key);
			if (name === undefined) {
				const field = alone ? 'keys' : `keys[${index}]`;
				problems.invalid.push({ field, problem: `\`${field}\` ${JSON.stringify(key)} is not a key press_keys knows.` });
			} else {
				normalized.push(name);
			}
		});
		if (problems.invalid.length > before) {
			problems.invalid.push({ field: 'keys', problem: KNOWN_KEYS });
		}
		value.keys = normalized;
	}
};
