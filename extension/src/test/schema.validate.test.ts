/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isAgentKey } from '../ptyd/keys';
import { KEY_NAMES, normalizeKey } from '../schema/keys';
import { MESSAGE_LIMIT, TOOLS } from '../schema/tools';
import { ArgumentError, validateArguments } from '../schema/validate';

/** The error validation throws, or a failure of the test where it throws none. */
function refusal(run: () => unknown): ArgumentError {
	try {
		run();
	} catch (err) {
		assert.ok(err instanceof ArgumentError, `expected an ArgumentError, got ${err}`);
		return err;
	}
	assert.fail('the arguments were accepted');
}

function fields(err: ArgumentError): string[] {
	return err.problems.invalid.map(each => each.field);
}

type Schema = { readonly [key: string]: unknown };

/** Each shape a tool advertises, its own and every one inside it, with where it is: `start_agent.worktree.branch`. */
function schemasOf(schema: Schema, where: string): [string, Schema][] {
	const properties = Object.entries((schema.properties ?? {}) as { readonly [name: string]: Schema });
	return [
		[where, schema],
		...schema.items ? schemasOf(schema.items as Schema, `${where}[]`) : [],
		...properties.flatMap(([name, each]) => schemasOf(each, `${where}.${name}`))
	];
}

suite('Schema: tool arguments are validated whole, exactly, before any effect (MCP-1.1)', () => {

	test('every missing required field is reported together, as missing_argument', () => {
		const err = refusal(() => validateArguments('start_agent', {}));
		assert.strictEqual(err.code, 'INVALID');
		assert.strictEqual(err.reason, 'missing_argument');
		assert.deepStrictEqual(err.problems.missing, ['name', 'window_id', 'location_id', 'cli']);
		assert.match(err.message, /`name`, `window_id`, `location_id`, `cli`/);
	});

	test('missing and invalid fields come in one answer, the reason missing_argument while any is missing', () => {
		const err = refusal(() => validateArguments('start_agent', { name: 'a', window_id: 7, cli: 'claude', extra: true }));
		assert.strictEqual(err.reason, 'missing_argument');
		assert.deepStrictEqual(err.problems.missing, ['location_id']);
		assert.deepStrictEqual(fields(err).sort(), ['extra', 'window_id']);
		assert.match(err.message, /`window_id` must be a string, not an integer/);
	});

	test('a nested object reports its own missing and unknown fields by path', () => {
		const err = refusal(() => validateArguments('start_agent', { name: 'a', window_id: 'w', location_id: 'l', cli: 'c', worktree: { branch: 'b', base: 'HEAD' } }));
		assert.deepStrictEqual(err.problems.missing, ['worktree.base_ref']);
		assert.deepStrictEqual(fields(err), ['worktree.base']);
	});

	test('nothing is coerced: no strings for booleans or integers, no fractions, no null', () => {
		for (const [tool, args, field] of [
			['list_agents', { include_ended: 'true' }, 'include_ended'],
			['list_agents', { limit: '5' }, 'limit'],
			['list_agents', { limit: 5.5 }, 'limit'],
			['list_agents', { cursor: null }, 'cursor'],
			['read_screen', { agent: 'a', lines: '20' }, 'lines'],
			['type_text', { agent: 'a', text: 'x', enter: 1 }, 'enter'],
			['press_keys', { agent: 'a', keys: [1] }, 'keys[0]'],
			['press_keys', { agent: 'a', keys: '[1]' }, 'keys[0]'],
			['stop_agent', { agent: '' }, 'agent']
		] as const) {
			const err = refusal(() => validateArguments(tool, args));
			assert.strictEqual(err.reason, 'invalid_argument', `${tool} ${JSON.stringify(args)}`);
			assert.ok(fields(err).includes(field), `${tool} ${JSON.stringify(args)}: ${err.message}`);
		}
	});

	test('integers stay within their ranges', () => {
		assert.deepStrictEqual(fields(refusal(() => validateArguments('list_agents', { limit: 0 }))), ['limit']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('list_agents', { limit: 201 }))), ['limit']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { limit: 201 }))), ['limit']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_screen', { agent: 'a', lines: 2001 }))), ['lines']);
		assert.strictEqual(validateArguments('read_screen', { agent: 'a', lines: 2000 }).lines, 2000);
		assert.strictEqual(validateArguments('list_agents', { limit: 200 }).limit, 200);
	});

	test('the schema\'s documented defaults, and no others, are filled in', () => {
		assert.deepStrictEqual(validateArguments('list_agents', {}), { include_ended: false, limit: 100 });
		assert.deepStrictEqual(validateArguments('read_messages', undefined), { all: false, limit: 100 });
		assert.deepStrictEqual(validateArguments('read_screen', { agent: '#a1' }), { agent: '#a1', lines: 50 });
		assert.deepStrictEqual(validateArguments('type_text', { agent: '#a1', text: 'hi' }), { agent: '#a1', text: 'hi', enter: false });
		assert.deepStrictEqual(validateArguments('start_agent', { name: 'n', window_id: 'w', location_id: 'l', cli: 'c' }), { name: 'n', window_id: 'w', location_id: 'l', cli: 'c' });
	});

	test('arguments must be an object; a call without any is the empty object', () => {
		assert.strictEqual(refusal(() => validateArguments('list_agents', [])).reason, 'invalid_argument');
		assert.strictEqual(refusal(() => validateArguments('list_agents', 'all')).reason, 'invalid_argument');
		assert.strictEqual(refusal(() => validateArguments('stop_agent', undefined)).reason, 'missing_argument');
		assert.deepStrictEqual(validateArguments('list_start_options', undefined), {});
	});

	test('every tool has a check for its schema, and every schema property type is one the validator knows', () => {
		const known = new Set(['string', 'integer', 'boolean', 'array', 'object']);
		for (const tool of TOOLS) {
			for (const [where, schema] of schemasOf(tool.inputSchema as unknown as Schema, tool.name)) {
				assert.ok(known.has(schema.type as string), `${where}: ${String(schema.type)}`);
			}
		}
	});

	test('every advertised shape has a type and none is a union, so that every model provider takes the tools (D96)', () => {
		// Gemini refuses a whole tool list over one value without a type, and OpenCode sends unions as JSON text (T3 Code #21655)
		for (const tool of TOOLS) {
			for (const [where, schema] of schemasOf(tool.inputSchema as unknown as Schema, tool.name)) {
				assert.ok(typeof schema.type === 'string', `${where} has no type`);
				for (const union of ['oneOf', 'anyOf', 'allOf', 'not']) {
					assert.ok(!(union in schema), `${where} has ${union}`);
				}
			}
		}
	});

	test('a text whose beginning the caller\'s CLI cut off - Antigravity\'s mark of it first - is refused before any effect (D107)', () => {
		const cut = `[Earlier output truncated]\n\n${'x'.repeat(100)}`;
		for (const [tool, args, field] of [
			['send_message', { to: 'a', text: cut }, 'text'],
			['start_agent', { name: 'n', window_id: 'w', location_id: 'l', cli: 'c', prompt: cut }, 'prompt'],
			['type_text', { agent: 'a', text: cut }, 'text']
		] as const) {
			const err = refusal(() => validateArguments(tool, args));
			assert.deepStrictEqual(fields(err), [field], tool);
			assert.match(err.message, /your CLI cut its beginning off before Facade received it\. Send it in shorter parts\./);
		}
		// The words anywhere else are a text like any other
		assert.strictEqual(validateArguments('send_message', { to: 'a', text: `It said [Earlier output truncated] there.` }).text, 'It said [Earlier output truncated] there.');
	});

	test('a list takes one item alone, or the list written as JSON text, as some CLIs send one (D96)', () => {
		assert.deepStrictEqual(validateArguments('read_messages', { ids: '["m-1","#m2"]' }).ids, ['m-1', '#m2']);
		assert.deepStrictEqual(validateArguments('read_messages', { ids: ' [ "m-1" ] ' }).ids, ['m-1']);
		assert.deepStrictEqual(validateArguments('press_keys', { agent: 'a', keys: '["Escape","Enter"]' }).keys, ['Escape', 'Enter']);
		// A key that only looks like the start of a list is that key
		assert.deepStrictEqual(validateArguments('press_keys', { agent: 'a', keys: '[' }).keys, ['[']);
		// The list as JSON text keeps every limit a list has
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: '[]' }))), ['ids']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: JSON.stringify(Array.from({ length: 101 }, (_, i) => `m-${i}`)) }))), ['ids']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('press_keys', { agent: 'a', keys: '["Enter","F1"]' }))), ['keys[1]', 'keys']);
	});

	test('start_agent: a name is any label, even empty (O22); models, efforts and branches are not blank, and a prompt is a message body', () => {
		const base = { name: 'n', window_id: 'w', location_id: 'l', cli: 'c' };
		for (const name of ['', '   ', 'human']) {
			assert.strictEqual(validateArguments('start_agent', { ...base, name }).name, name);
		}
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, name: 7 }))), ['name']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, model: '' }))), ['model']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, effort: ' ' }))), ['effort']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, worktree: { branch: ' ', base_ref: 'HEAD' } }))), ['worktree.branch']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, prompt: 'go\x1b[201~' }))), ['prompt']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('start_agent', { ...base, prompt: 'x'.repeat(MESSAGE_LIMIT + 1) }))), ['prompt']);
		const args = validateArguments('start_agent', { ...base, model: 'opus', effort: 'high', prompt: 'Review\n\tthis.', worktree: { branch: 'b', base_ref: 'HEAD' } });
		assert.deepStrictEqual(args.worktree, { branch: 'b', base_ref: 'HEAD' });
		assert.strictEqual(args.prompt, 'Review\n\tthis.');
	});

	test('send_message: text is nonblank, at most 8,000 code points counted as code points, and has no terminal control', () => {
		const astral = '\u{1F600}'.repeat(MESSAGE_LIMIT);
		assert.strictEqual(astral.length, MESSAGE_LIMIT * 2);
		assert.strictEqual(validateArguments('send_message', { to: '@human', text: astral }).text, astral);
		const long = refusal(() => validateArguments('send_message', { to: '@human', text: `${astral}x` }));
		assert.match(long.message, /8001 Unicode code points; at most 8000/);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('send_message', { to: 'a', text: ' \n\t ' }))), ['text']);
		const control = refusal(() => validateArguments('send_message', { to: 'a', text: 'hi\x1b[2J' }));
		assert.match(control.message, /U\+001B \(Escape\) at code point 3/);
		const kept = 'line one\r\nline two\ttabbed — ünïcödé \u{1F600}';
		assert.strictEqual(validateArguments('send_message', { to: 'a', text: kept, reply_to: '#m3' }).text, kept);
	});

	test('type_text takes any printable text, tabs and line breaks, with no length cap, and refuses controls toward press_keys', () => {
		const huge = 'word '.repeat(50_000);
		assert.strictEqual(validateArguments('type_text', { agent: 'a', text: huge }).text, huge);
		assert.strictEqual(validateArguments('type_text', { agent: 'a', text: 'a\tb\nc\rd   ' }).text, 'a\tb\nc\rd   ');
		assert.deepStrictEqual(validateArguments('type_text', { agent: 'a', text: '', enter: true }), { agent: 'a', text: '', enter: true });
		for (const control of ['\x1b', '\x03', '\x00', '\x7f', '\u0085', '\u009b', '\ud800']) {
			const err = refusal(() => validateArguments('type_text', { agent: 'a', text: `ok${control}` }));
			assert.strictEqual(err.reason, 'invalid_argument');
			assert.match(err.message, /press_keys/, JSON.stringify(control));
		}
		assert.match(refusal(() => validateArguments('type_text', { agent: 'a', text: '' })).message, /nothing to type/);
		assert.match(refusal(() => validateArguments('type_text', { agent: 'a', text: '', enter: false })).message, /nothing to type/);
	});

	test('press_keys takes a key or a list of any length, names normalized to the names ptyd presses', () => {
		assert.deepStrictEqual(validateArguments('press_keys', { agent: 'a', keys: 'Return' }).keys, ['Enter']);
		assert.deepStrictEqual(
			validateArguments('press_keys', { agent: 'a', keys: ['esc', 'ArrowUp', 'arrowdown', 'ArrowLeft', 'ARROWRIGHT', 'ctrl+c', 'Ctrl+Z', 'shift+tab', 'pageup', 'Space', 'a', 'A', ' ', 'é', '\u{1F600}'] }).keys,
			['Escape', 'Up', 'Down', 'Left', 'Right', 'Ctrl+C', 'Ctrl+Z', 'Shift+Tab', 'PageUp', 'Space', 'a', 'A', ' ', 'é', '\u{1F600}']
		);
		assert.strictEqual(validateArguments('press_keys', { agent: 'a', keys: Array(5000).fill('Down') }).keys.length, 5000);
		const err = refusal(() => validateArguments('press_keys', { agent: 'a', keys: ['Enter', 'F1', 'Ctrl+1', 'ab', '\x1b'] }));
		assert.deepStrictEqual(fields(err), ['keys[1]', 'keys[2]', 'keys[3]', 'keys[4]', 'keys']);
		assert.match(err.message, /type_text types text/);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('press_keys', { agent: 'a', keys: [] }))), ['keys']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('press_keys', { agent: 'a', keys: 'hello' }))), ['keys', 'keys']);
	});

	test('the key names are exactly the ones ptyd presses, and what press_keys refuses ptyd would not press', () => {
		for (const name of KEY_NAMES) {
			assert.ok(isAgentKey(name), name);
			assert.strictEqual(normalizeKey(name), name);
		}
		for (const alias of ['Return', 'Esc', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'enter', 'ctrl+a', 'x', '7', 'é']) {
			assert.ok(isAgentKey(normalizeKey(alias)!), alias);
		}
		for (const unknown of ['F1', 'Ctrl+1', 'Alt+X', 'ab', '\t', '\x1b', '​', '']) {
			assert.strictEqual(normalizeKey(unknown), undefined, JSON.stringify(unknown));
			assert.ok(!isAgentKey(unknown), JSON.stringify(unknown));
		}
	});

	test('read_messages: ids select messages themselves, never with all or cursor; one ID or 1 to 100', () => {
		assert.deepStrictEqual(validateArguments('read_messages', { ids: 'm-1' }).ids, ['m-1']);
		assert.deepStrictEqual(validateArguments('read_messages', { ids: ['m-1', '#m2'], all: false }).ids, ['m-1', '#m2']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: ['m-1'], all: true }))), ['ids']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: 'm-1', cursor: 'c' }))), ['ids']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: [] }))), ['ids']);
		assert.deepStrictEqual(fields(refusal(() => validateArguments('read_messages', { ids: Array.from({ length: 101 }, (_, i) => `m-${i}`) }))), ['ids']);
		assert.deepStrictEqual(validateArguments('read_messages', { all: true, cursor: 'c', limit: 5 }), { all: true, cursor: 'c', limit: 5 });
	});

	test('an unknown tool is refused', () => {
		assert.match(refusal(() => validateArguments('get_operation' as never, {})).message, /no tool get_operation/);
	});
});
