/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { accepted, answerOf, errorResult, failure, renderFacts, success } from '../schema/result';
import { ArgumentError, validateArguments } from '../schema/validate';

/** An error as any layer codes one: what the result reads off it is its MCP code and reason. */
class CodedError extends Error {
	constructor(readonly code: string, readonly reason: string, message: string) {
		super(message);
	}
}

suite('Schema: results say the same in text and structure, and never more than happened (MCP-1.2)', () => {

	test('failure alone is an MCP error; accepted is not success, and not an error either', () => {
		assert.strictEqual(answerOf(success({})).isError, false);
		assert.strictEqual(answerOf(accepted({ agent_id: 'run-1' }, { outcome: 'pending', agent_id: 'run-1' })).isError, false);
		const failed = answerOf(failure({ code: 'NOT_FOUND', reason: 'not_found', message: 'No agent "x" was found.' }, {}));
		assert.strictEqual(failed.isError, true);
		assert.match(failed.text, /^Failed: No agent "x" was found\./);
		assert.match(failed.text, /\n {2}code: NOT_FOUND\n {2}reason: not_found\n/);
		assert.match(answerOf(accepted({}, { outcome: 'pending' })).text, /^Accepted: the operation continues, and a Facade result reports its outcome later\./);
	});

	test('the structured answer is the envelope itself, and its text lists every field of it after the headline', () => {
		const result = success({ agent_id: 'run-1', yolo: false, count: 3, empty: [], nothing: {}, tags: ['a', 'b'], runs: [{ id: 'x', n: 1 }, { id: 'y', n: 2 }] }, { outcome: 'confirmed', agent_id: 'run-1' });
		const answer = answerOf(result, 'Started.');
		assert.strictEqual(answer.structured, result);
		assert.strictEqual(answer.text, [
			'Started.',
			'',
			'status: success',
			'data:',
			'  agent_id: run-1',
			'  yolo: false',
			'  count: 3',
			'  empty: []',
			'  nothing: {}',
			'  tags:',
			'    - a',
			'    - b',
			'  runs:',
			'    - id: x',
			'      n: 1',
			'    - id: y',
			'      n: 2',
			'effects:',
			'  outcome: confirmed',
			'  agent_id: run-1'
		].join('\n'));
	});

	test('text of several lines is a literal block, indented under its field, so that no line of it can pass for a field', () => {
		const lines = renderFacts({ text: 'status: success\n  indented\n\nend', kept: 'a\n', more: 'b\n\n', after: 1 });
		assert.deepStrictEqual(lines.join('\n').split('\n'), [
			'text: |-',
			'  status: success',
			'    indented',
			'  ',
			'  end',
			'kept: |',
			'  a',
			'more: |+',
			'  b',
			'  ',
			'after: 1'
		]);
	});

	test('a string that would not read back as itself is quoted as JSON', () => {
		assert.deepStrictEqual(renderFacts({ a: '', b: ' padded', c: 'cr\rhere', d: '42', e: 'true', f: '"quoted"', g: 'plain words: fine', h: null }), [
			'a: ""',
			'b: " padded"',
			'c: "cr\\rhere"',
			'd: "42"',
			'e: "true"',
			'f: "\\"quoted\\""',
			'g: plain words: fine',
			'h: null'
		]);
	});

	test('a coded error keeps its code and reason and claims no effect; any other error is FAILED with unknown effects', () => {
		const coded = errorResult(new CodedError('REFUSED', 'out_of_tree', '#a5 is not in your creation tree.'));
		assert.deepStrictEqual(coded, { status: 'failure', data: {}, error: { code: 'REFUSED', reason: 'out_of_tree', message: '#a5 is not in your creation tree.' }, effects: { outcome: 'none' } });
		// A code MCP-1.2 does not have is no coded error
		assert.deepStrictEqual(errorResult(new CodedError('CANCELLED', 'cancelled', 'Cancelled')).error, { code: 'FAILED', reason: 'unexpected_error', message: 'Cancelled' });
		const thrown = errorResult(new Error('socket closed'));
		assert.deepStrictEqual(thrown.error, { code: 'FAILED', reason: 'unexpected_error', message: 'socket closed' });
		assert.deepStrictEqual(thrown.effects, { outcome: 'unknown' });
		const withEffects = errorResult('boom', { effects: { outcome: 'unknown', text_written: 'unknown', enter_written: null }, data: { agent_id: 'run-1' } });
		assert.deepStrictEqual(withEffects, { status: 'failure', data: { agent_id: 'run-1' }, error: { code: 'FAILED', reason: 'unexpected_error', message: 'boom' }, effects: { outcome: 'unknown', text_written: 'unknown', enter_written: null } });
		assert.match(answerOf(withEffects).text, /enter_written: null/);
	});

	test('in a call that only reads, an uncoded error is UNAVAILABLE and had no effect', () => {
		const read = errorResult(new Error('the window went'), { readOnly: true, effects: { outcome: 'unknown' } });
		assert.deepStrictEqual(read, { status: 'failure', data: {}, error: { code: 'UNAVAILABLE', reason: 'unavailable', message: 'the window went' }, effects: { outcome: 'none' } });
	});

	test('argument errors are coded INVALID with their reason', () => {
		let err: unknown;
		try {
			validateArguments('stop_agent', {});
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof ArgumentError);
		const result = errorResult(err, { data: err.problems });
		assert.deepStrictEqual(result.error, { code: 'INVALID', reason: 'missing_argument', message: 'stop_agent requires `agent`.' });
		assert.deepStrictEqual(result.data, { missing: ['agent'], invalid: [] });
	});
});
