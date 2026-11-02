/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { metaOf } from '../core/agents';
import { resultOf, runFacts, setUp, Setup } from './contractFakes';

const START = { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', request_id: 'original', prompt: 'One original task.' };

suite('Contract: truthful operation outcomes', () => {
	let s: Setup;
	setup(() => s = setUp());
	teardown(() => s.dispose());

	test('an uncertain native prompt stays unknown on retry, then a real inbox handoff delivers it without repasting', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead);
		s.agents.startWith = { state: 'running', prompt: { path: 'native', capability: { state: 'unverified', reason: 'No acceptance evidence.' } } };
		const first = resultOf(await s.call(lead, 'start_agent', START));
		const worker = s.agents.list().find(run => run.alias === first.data.agent_id)!;
		assert.deepStrictEqual([first.status, first.data.prompt.status, s.messages.records[0].delivery.status], ['success', 'unknown', 'unknown']);
		assert.strictEqual(metaOf(worker).promptId, s.messages.records[0].id);
		const repeated = resultOf(await s.call(lead, 'start_agent', { ...START, prompt: 'Do not replace the original.' }));
		assert.deepStrictEqual([repeated.data.prompt.status, repeated.effects.outcome, repeated.data.process_state], ['unknown', 'none', 'running']);
		assert.strictEqual(repeated.data.prompt.delivered_via, undefined, 'an attempted native path is not confirmed delivery');
		assert.strictEqual(repeated.data.process, undefined);
		assert.strictEqual(s.messages.records[0].text, START.prompt);
		const read = resultOf(await s.call(worker, 'read_messages'));
		assert.strictEqual(read.data.messages[0].delivery.status, 'unknown');
		const afterRead = resultOf(await s.call(lead, 'start_agent', START));
		assert.deepStrictEqual([afterRead.data.prompt.status, afterRead.data.prompt.delivered_via], ['success', 'read']);
		assert.deepStrictEqual([s.agents.launched.length, s.messages.sent.length, s.messages.prompts.length], [1, 0, 1]);
	});

	test('a post-start prompt is observed on repeated starts, including pending delivery and a lost record', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead);
		s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_draft' });
		const first = resultOf(await s.call(lead, 'start_agent', START));
		const repeated = resultOf(await s.call(lead, 'start_agent', START));
		assert.strictEqual(repeated.data.prompt.message_id, first.data.prompt.message_id);
		assert.deepStrictEqual([repeated.data.prompt.status, repeated.data.prompt.deadline], ['pending', first.data.prompt.deadline]);
		s.messages.records.length = 0;
		const absent = resultOf(await s.call(lead, 'start_agent', START));
		assert.deepStrictEqual([absent.data.prompt.status, absent.data.prompt.reason], ['unknown', 'prompt_unrecorded']);
		assert.deepStrictEqual([s.agents.launched.length, s.messages.sent.length], [1, 1]);
	});

	test('a retry cannot introduce a prompt into a start that never had one', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead);
		const { prompt: _prompt, ...args } = START;
		await s.call(lead, 'start_agent', args);
		const repeated = resultOf(await s.call(lead, 'start_agent', START));
		assert.strictEqual(repeated.data.prompt, undefined);
		assert.deepStrictEqual([s.agents.launched.length, s.messages.sent.length], [1, 0]);
	});

	test('unconfirmed termination is a failure with the completed closure preserved', async () => {
		const lead = runFacts(1, { yolo: true }), worker = runFacts(2);
		s.agents.add(lead, worker);
		s.agents.closeWith = 'unconfirmed';
		const answer = await s.call(lead, 'stop_agent', { agent: '#a2' });
		const result = resultOf(answer);
		assert.strictEqual(answer.isError, true);
		assert.deepStrictEqual([result.error?.reason, result.effects.outcome, result.data.closed, result.data.process_state], ['termination_unconfirmed', 'partial', true, 'unknown']);
		assert.deepStrictEqual(s.agents.closed, [worker.id]);
	});

	test('agent snapshots keep process, tools and activity independent in the same public vocabulary', async () => {
		const lead = runFacts(1, { tools: 'unavailable', activity: 'not_working' });
		s.agents.add(lead);
		const agent = resultOf(await s.call(lead, 'list_agents')).data.agents[0];
		assert.deepStrictEqual([agent.process_state, agent.tools_state, agent.activity], ['running', 'unavailable', 'not_working']);
		assert.strictEqual(agent.process, undefined);
		assert.strictEqual(agent.tools, undefined);
		assert.strictEqual(agent.task_completed, undefined);
	});
});
