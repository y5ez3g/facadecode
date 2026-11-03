/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spendRouteTime } from '../base/routeBudget';

suite('Route budgets use local elapsed time at every hop (MCP-1.3)', () => {
	for (const budget of [0, 2000, 10_000, 3_600_000]) {
		test(`connection and queue waits share the ${budget} ms budget and message age`, () => {
			const first = { to: 'win-2', op: 'deliver', args: { elapsedMs: 500, text: 'exact body' }, deadlineMs: budget };
			const afterQueue = spendRouteTime(first, 200);
			const afterConnection = spendRouteTime(afterQueue, 300);
			assert.strictEqual(afterConnection.deadlineMs, Math.max(0, budget - 500));
			assert.deepStrictEqual(afterConnection.args, { elapsedMs: 1000, text: 'exact body' });
			assert.strictEqual(first.args.elapsedMs, 500);
			assert.strictEqual(spendRouteTime(first, -10).deadlineMs, budget, 'a negative duration never adds time');
		});
	}
});
