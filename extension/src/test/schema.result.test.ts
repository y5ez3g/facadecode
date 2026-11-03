/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { accepted, answerOf, errorResult, failure, success } from '../schema/result';
import { ArgumentError, validateArguments } from '../schema/validate';

/** An error as any layer codes one: what the result reads off it is its MCP code and reason. */
class CodedError extends Error {
	constructor(readonly code: string, readonly reason: string, message: string) {
		super(message);
	}
}

suite('Schema: current results say the same in text and structure (MCP-1.2)', () => {

	test('failure alone is an MCP error; accepted is not success, and not an error either', () => {
		assert.strictEqual(answerOf(success({})).isError, false);
		const waiting = answerOf(accepted({ agent_id: '#a1' }, { outcome: 'pending' }));
		assert.strictEqual(waiting.isError, false);
		assert.deepStrictEqual(JSON.parse(waiting.text), waiting.structured);
		assert.strictEqual(waiting.structured.status, 'accepted');
		const failed = answerOf(failure({ code: 'NOT_FOUND', reason: 'not_found', message: 'No agent "x" was found.' }, {}));
		assert.strictEqual(failed.isError, true);
		assert.deepStrictEqual(JSON.parse(failed.text), failed.structured);
		assert.deepStrictEqual(failed.structured.error, { code: 'NOT_FOUND', reason: 'not_found', message: 'No agent "x" was found.' });
	});

	test('both representations contain the complete JSON envelope, preserving empty and false values', () => {
		const result = success({ agent_id: '#a1', yolo: false, count: 3, empty: [], nothing: {}, tags: ['a', 'b'], runs: [{ id: 'x', n: 1 }, { id: 'y', n: 2 }] }, { outcome: 'confirmed' });
		const answer = answerOf(result);
		assert.deepStrictEqual(answer.structured, result);
		assert.deepStrictEqual(JSON.parse(answer.text), result);
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
		assert.strictEqual(JSON.parse(answerOf(withEffects).text).effects.enter_written, null);
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
