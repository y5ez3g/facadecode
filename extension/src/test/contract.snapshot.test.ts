/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { snapshotPage, WindowSnapshot } from '../contract/snapshot';
import { resultOf, runFacts, setUp } from './contractFakes';

suite('Snapshot pagination and targeted recovery', () => {
	for (const [agentCount, locationCount] of [[1, 7], [7, 1], [7, 7], [0, 7]]) {
		test(`${agentCount} agents and ${locationCount} locations advance independently without repeating a finished list`, () => {
			const locations = Array.from({ length: locationCount }, (_, i) => ({ location_id: `loc-${i}`, path: `/work/${i}` }));
			const window: WindowSnapshot = { window_id: 'win-1', label: 'App', environment: 'local', folders: [], clis: [], locations,
				counts: { folders: 0, locations: locationCount, worktrees: 0, agents: agentCount }, complete: true };
			const agents = Array.from({ length: agentCount }, (_, i) => ({ agent_id: `run-${i}`, created_at: new Date(i).toISOString() }));
			let cursor: string | undefined;
			const seenAgents: unknown[] = [], seenLocations: unknown[] = [];
			let pages = 0;
			do {
				const page = snapshotPage([window], agents, 2, 'selection', cursor);
				seenAgents.push(...page.agents.map(each => each.agent_id));
				seenLocations.push(...(page.windows[0].locations as { location_id: string }[]).map(each => each.location_id));
				assert.deepStrictEqual(page.windows[0].counts, window.counts);
				cursor = page.next_cursor;
				assert.ok(++pages <= 4, 'pagination terminates');
			} while (cursor);
			assert.deepStrictEqual(seenAgents, agents.map(each => each.agent_id));
			assert.deepStrictEqual(seenLocations, locations.map(each => each.location_id));
		});
	}

	test('targeted lookup does not need a working CLI scanner and preserves the requested settings of ended agents', async () => {
		const s = setUp();
		try {
			const caller = runFacts(1, { yolo: true });
			s.agents.add(caller, runFacts(2, { lifecycle: 'ended', model: 'example', effort: 'high' }));
			s.deps.clis.list = async () => { assert.fail('targeted recovery must not scan CLIs'); };
			const result = resultOf(await s.call(caller, 'list_agents', { agent: '#a2' }));
			assert.strictEqual(result.status, 'success');
			assert.strictEqual(result.data.windows[0].clis_queried, false);
			assert.strictEqual(result.data.windows[0].locations.length, 1);
			assert.deepStrictEqual([result.data.agents[0].process_state, result.data.agents[0].requested_model], ['ended', 'example']);
		} finally { s.dispose(); }
	});
});
