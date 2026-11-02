/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createToolServices } from '../contract/tools';
import { formatResult } from '../core/messages';
import { TOOL_PROTOCOL } from '../schema/protocol';
import { resultOf, runFacts, setUp, Setup } from './contractFakes';
import { waitFor } from './util';

const START = { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', request_id: 'one-start' };

suite('Contract: finite continuation and originating-call correlation', () => {
	let s: Setup;
	setup(() => s = setUp());
	teardown(() => s.dispose());

	test('a repeated pending start, also through a fresh tool service, keeps the original call instead of promising another result', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.agents.startWith = undefined;
		s.timeout = 0;
		const initial = resultOf(await s.service({ caller: lead.id, tool: 'start_agent', arguments: START, callId: 'original-call' }));
		const fresh = createToolServices(s.deps);
		const repeated = resultOf((await fresh.answer({ protocol: TOOL_PROTOCOL, elapsedMs: 0, caller: lead.id, tool: 'start_agent', arguments: START, callId: 'lookup-call' })).answer);
		assert.strictEqual(initial.data.result_message_id, repeated.data.result_message_id);
		assert.deepStrictEqual(s.messages.inbox(lead.id, { all: true, limit: 100 }).records, [], 'reserving the result does not create an inbox item');
		assert.deepStrictEqual([initial.data.call_id, repeated.data.call_id, repeated.data.repeated], ['original-call', 'original-call', true]);
		assert.strictEqual(s.agents.launched.length, 1);
		const worker = s.agents.list().find(run => run.alias === initial.data.agent_id)!;
		s.agents.settle(worker.id, { state: 'running' });
		await waitFor(() => s.messages.reports.length === 1);
		assert.strictEqual(s.messages.reports[0].callId, 'original-call');
		assert.strictEqual(s.messages.records[0].alias, initial.data.result_message_id);
	});

	test('an accepted start that closes still reports its final outcome under its original identity', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.agents.startWith = undefined;
		s.timeout = 0;
		const initial = resultOf(await s.service({ caller: lead.id, tool: 'start_agent', arguments: { ...START, worktree: { branch: 'fix', base_ref: 'HEAD' } }, callId: 'closed-start' }));
		const worker = s.agents.list().find(run => run.alias === initial.data.agent_id)!;
		s.agents.settle(worker.id, { state: 'closed', worktreeCreated: '/work/app.worktrees/fix' });
		await waitFor(() => s.messages.reports.length === 1);
		const result = s.messages.records.find(record => record.kind === 'result')!;
		assert.strictEqual(result.callId, initial.data.call_id);
		assert.strictEqual(result.alias, initial.data.result_message_id);
		assert.strictEqual(result.result?.status, 'failure');
		assert.strictEqual((result.result?.data as { process_state: string }).process_state, 'unknown', 'closing the card is not process-exit evidence');
		assert.deepStrictEqual(result.result?.effects, { outcome: 'unknown', worktree_created: '/work/app.worktrees/fix' });
		assert.match((result.result?.error as { message: string }).message, /closed before startup completed/);
		assert.deepStrictEqual(result.result?.recovery, { action: 'inspect_effects' });
		assert.strictEqual((result.result?.data as { agent_id: string }).agent_id, initial.data.agent_id);
		assert.deepStrictEqual(result.agent, { run: worker.id, alias: worker.alias, name: worker.name });
		assert.strictEqual(formatResult(result).split('\n')[0], `🔔 worker (${worker.alias}) was closed before startup finished. Whether the process stopped is unknown. · ${result.alias}`);
		assert.strictEqual(s.agents.get(worker.id), undefined);
	});

	test('a late stop receipt keeps the removed target name and short reference in its terminal header and inbox', async () => {
		const lead = runFacts(1, { yolo: true }), worker = runFacts(2, { name: 'worker' });
		s.agents.add(lead, worker);
		s.timeout = 0;
		let finish!: (value: 'unconfirmed') => void;
		s.agents.closeWith = new Promise(resolve => finish = resolve);
		const initial = resultOf(await s.service({ caller: lead.id, tool: 'stop_agent', arguments: { agent: worker.alias }, callId: 'original-stop' }));
		assert.strictEqual(initial.status, 'accepted');
		assert.match(initial.data.result_message_id, /^#m\d+$/);
		assert.strictEqual(s.agents.get(worker.id), undefined);
		finish('unconfirmed');
		await waitFor(() => s.messages.reports.length === 1);
		const receipt = s.messages.records.find(record => record.kind === 'result')!;
		assert.strictEqual(receipt.alias, initial.data.result_message_id);
		assert.strictEqual(formatResult(receipt).split('\n')[0], `🔔 worker (#a2) may still be running. The card and terminal are closed. · ${receipt.alias}`);
		const inbox = resultOf(await s.call(lead, 'read_messages'));
		const read = inbox.data.messages[0];
		assert.deepStrictEqual([read.agent, read.call_id, read.result.status, read.result.data.agent_id], ['#a2', initial.data.call_id, 'failure', '#a2']);
	});

	test('concurrent starts finishing in reverse order retain distinct call and target references', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.agents.startWith = undefined;
		s.timeout = 0;
		const accepted = await Promise.all(['first', 'second'].map(async key => resultOf(await s.service({ caller: lead.id, tool: 'start_agent',
			arguments: { ...START, request_id: key }, callId: key }))));
		for (const initial of [...accepted].reverse()) {
			const worker = s.agents.list().find(run => run.alias === initial.data.agent_id)!;
			s.agents.settle(worker.id, { state: 'running' });
		}
		await waitFor(() => s.messages.reports.length === 2);
		const receipts = s.messages.records.filter(record => record.kind === 'result');
		for (const initial of accepted) {
			const receipt = receipts.find(record => record.callId === initial.data.call_id)!;
			assert.strictEqual(receipt.alias, initial.data.result_message_id);
			assert.strictEqual((receipt.result?.data as { agent_id: string }).agent_id, initial.data.agent_id);
		}
		assert.strictEqual(s.agents.launched.length, 2);
	});

	test('an immediate final operation creates no follow-up receipt and an empty inbox carries no workflow instruction', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		const started = resultOf(await s.call(lead, 'start_agent', START));
		assert.strictEqual(started.data.call_id, undefined);
		assert.strictEqual(s.messages.reports.length, 0);
		const read = resultOf(await s.call(lead, 'read_messages'));
		assert.deepStrictEqual(read.data, { messages: [] });
		assert.strictEqual(read.recovery, undefined);
	});
});
