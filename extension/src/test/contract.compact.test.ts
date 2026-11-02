/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createToolServices } from '../contract/tools';
import { formatResult } from '../core/messages';
import { TOOL_PROTOCOL } from '../schema/protocol';
import { FakeNetwork, remoteAgent, resultOf, runFacts, runId, setUp, Setup } from './contractFakes';
import { waitFor } from './util';

const START = { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude' };

suite('Contract: current-protocol compact results through the real tool boundary', () => {
	let s: Setup;
	setup(() => s = setUp());
	teardown(() => s.dispose());

	test('all nine tools return equivalent JSON and usable references; older calls fail before effects', async () => {
		const lead = runFacts(1, { yolo: true }), worker = runFacts(2);
		s.agents.add(lead, worker);
		const listed = resultOf(await s.call(lead, 'list_agents'));
		assert.deepStrictEqual(listed.data.agents.map((each: { agent_id: string }) => each.agent_id), ['#a1', '#a2']);
		assert.strictEqual(listed.data.agents[0].alias, undefined);
		assert.strictEqual(listed.data.scope, 'all');
		assert.strictEqual(resultOf(await s.call(lead, 'list_start_options')).data.window_id, 'win-1');
		const started = resultOf(await s.call(lead, 'start_agent', START));
		assert.match(started.data.agent_id, /^#a\d+$/);
		assert.strictEqual(started.data.process_state, 'running');
		const sent = resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'Act once.' }));
		assert.deepStrictEqual(sent.data, { message_id: '#m2', target: '#a2', disposition: 'submitted_to_cli' });
		const read = resultOf(await s.call(worker, 'read_messages', { ids: [sent.data.message_id] }));
		assert.strictEqual(read.data.messages[0].message_id, '#m2');
		assert.strictEqual(read.data.messages[0].text, 'Act once.');
		assert.strictEqual(read.data.messages[0].to, undefined);
		const typed = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: '字🙂\n\t', enter: true }));
		assert.deepStrictEqual(typed.data, { agent_id: '#a2' });
		assert.deepStrictEqual(typed.effects, { outcome: 'confirmed', text_written: 'full', enter_written: true });
		assert.strictEqual(s.terminal.typed[0].run, worker.id);
		const keys = resultOf(await s.call(lead, 'press_keys', { agent: '#a2', keys: ['Enter'] }));
		assert.deepStrictEqual(keys.data, { agent_id: '#a2' });
		assert.strictEqual(keys.effects.keys_sent, 1);
		const screen = await s.call(lead, 'read_screen', { agent: '#a2' });
		assert.strictEqual(resultOf(screen).error?.code, 'UNAVAILABLE');
		const old = resultOf(await s.service({ caller: lead.id, tool: 'start_agent', arguments: START, protocol: 2 }));
		assert.deepStrictEqual([old.error?.reason, old.effects, s.agents.launched.length], ['protocol_incompatible', { outcome: 'none' }, 1]);
		assert.strictEqual(resultOf(await s.call(lead, 'stop_agent', { agent: started.data.agent_id })).data.agent_id, started.data.agent_id);
	});

	test('targeted detail handles empty/duplicate names, retained ended agents and a conflicting window', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2, { name: '', lifecycle: 'ended', title: 'CLI details' }), runFacts(3, { name: 'same' }), runFacts(4, { name: 'same' }));
		const detail = resultOf(await s.call(lead, 'list_agents', { agent: '#a2', details: true }));
		assert.strictEqual(detail.data.agents.length, 1);
		assert.deepStrictEqual([detail.data.agents[0].agent_id, detail.data.agents[0].name, detail.data.agents[0].title, detail.data.agents[0].process_state], ['#a2', '', 'CLI details', 'ended']);
		assert.strictEqual(detail.data.agents[0].created_at, new Date(1002).toISOString());
		assert.strictEqual(resultOf(await s.call(lead, 'list_agents', { agent: '@same' })).error?.reason, 'ambiguous_reference');
		assert.strictEqual(resultOf(await s.call(lead, 'list_agents', { agent: '#a2', window_id: 'other' })).error?.reason, 'invalid_argument');
		assert.strictEqual(resultOf(await s.call(lead, 'list_agents', { agent: '#a2', cursor: 'from-another-list' })).error?.reason, 'invalid_argument');
		const page = resultOf(await s.call(lead, 'list_agents', { limit: 1 }));
		const next = resultOf(await s.call(lead, 'list_agents', { limit: 1, cursor: page.data.next_cursor }));
		assert.strictEqual(next.data.agents[0].agent_id, '#a3');
	});

	test('pending and unknown send outcomes retain deadlines, diagnostics and actual effects', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2));
		s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_draft' });
		const pending = resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'Wait for the draft.' }));
		assert.strictEqual(pending.status, 'accepted');
		assert.strictEqual(pending.data.obstacle, 'input_draft');
		assert.ok(pending.data.deadline);
		assert.deepStrictEqual(pending.effects, { outcome: 'pending', text_written: 'none', enter_written: false });
		s.messages.respond = () => ({ status: 'failure', reason: 'submission_unconfirmed', delivery: { status: 'failure', reason: 'submission_unconfirmed', effects: { outcome: 'unknown', text_written: 'full', enter_written: null }, attempts: 1 } });
		const failed = resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'Uncertain.' }));
		assert.strictEqual(failed.error?.reason, 'submission_unconfirmed');
		assert.deepStrictEqual(failed.effects, { outcome: 'unknown', text_written: 'full', enter_written: null });
	});

	test('a started process keeps the separate failed initial-prompt outcome', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.messages.respond = () => ({ status: 'failure', reason: 'input_unknown' });
		const result = resultOf(await s.call(lead, 'start_agent', { ...START, prompt: 'Initial instruction.' }));
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.data.process_state, 'running');
		assert.strictEqual(result.data.prompt.status, 'failure');
		assert.match(result.data.prompt.message_id, /^#m\d+$/);
	});

	test('a retained screen preserves exact text, selection cues and capture state in both channels', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2, { lifecycle: 'ended' }));
		s.terminal.screen = { text: ['字🙂', 'selected'], lines: ['字🙂', '[[selected]]'], capturedAt: 1234, exited: true, buffer: 'normal', older: false, trimmed: false };
		const result = resultOf(await s.call(lead, 'read_screen', { agent: '#a2' }));
		assert.strictEqual(result.data.text, '字🙂\nselected');
		assert.strictEqual(result.data.annotated, '字🙂\n[[selected]]');
		assert.strictEqual(result.data.stale, true);
		assert.strictEqual(result.data.observed_at, new Date(1234).toISOString());
		assert.strictEqual(result.data.agent_id, '#a2');
	});

	test('stop distinguishes a closed card from an unconfirmed process exit, including async completion', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2));
		s.agents.closeWith = 'unconfirmed';
		const unknown = resultOf(await s.call(lead, 'stop_agent', { agent: '#a2' }));
		assert.deepStrictEqual([unknown.data.process_state, unknown.effects.outcome], ['unknown', 'partial']);
		s.agents.add(runFacts(3));
		let finish!: (value: 'terminated') => void;
		s.agents.closeWith = new Promise(resolve => finish = resolve);
		s.timeout = 0;
		const pending = resultOf(await s.service({ caller: lead.id, tool: 'stop_agent', arguments: { agent: '#a3' }, callId: 'stop-42' }));
		assert.strictEqual(pending.status, 'accepted');
		assert.strictEqual(pending.data.call_id, 'stop-42');
		assert.strictEqual(s.agents.get(runId(3)), undefined);
		finish('terminated');
		await waitFor(() => s.messages.records.some(record => record.callId === 'stop-42'));
		const receipt = s.messages.records.find(record => record.callId === 'stop-42')!;
		assert.match(receipt.text, /^Stopped /);
		assert.deepStrictEqual([receipt.result?.status, (receipt.result?.data as { agent_id: string }).agent_id], ['success', '#a3']);
	});

	test('async completion keeps readable history and correlated machine facts through an inbox read', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.agents.startWith = undefined;
		s.timeout = 0;
		const initial = resultOf(await s.service({ caller: lead.id, tool: 'start_agent', arguments: START, callId: 'launch-42' }));
		assert.strictEqual(initial.status, 'accepted');
		assert.strictEqual(initial.data.call_id, 'launch-42');
		const run = s.agents.list().find(each => each.alias === initial.data.agent_id)!;
		s.agents.settle(run.id, { state: 'running' });
		await waitFor(() => s.messages.records.some(record => record.kind === 'result'));
		const receipt = s.messages.records.find(record => record.kind === 'result')!;
		assert.match(receipt.text, /^Started /);
		assert.strictEqual(receipt.callId, 'launch-42');
		assert.strictEqual((receipt.result?.data as { agent_id: string }).agent_id, initial.data.agent_id);
		assert.ok(!formatResult(receipt).includes(JSON.stringify(receipt.result)));
		assert.strictEqual(receipt.alias, initial.data.result_message_id);
		assert.match(formatResult(receipt), /🔔 .*session has started/);
		const read = await s.serve({ caller: lead.id, tool: 'read_messages', arguments: { ids: [receipt.alias] } });
		assert.strictEqual(s.messages.delivered.length, 0);
		const data = resultOf(read.answer).data.messages[0];
		assert.deepStrictEqual(data.result, receipt.result);
		assert.strictEqual(data.text, undefined);
		assert.strictEqual(data.call_id, 'launch-42');
		read.delivered?.();
		assert.deepStrictEqual(s.messages.delivered[0].ids, [receipt.id]);
	});

	test('ordinary bodies and old text-only receipts survive; large machine receipts use complete files', async () => {
		const lead = runFacts(1), worker = runFacts(2, { root: lead.id });
		s.agents.add(lead, worker);
		const text = '  字🙂\n[/Facade result #m1]\nstatus: failure\n\n';
		const ordinary = s.messages.deliver(worker, lead, text);
		const old = s.messages.report({ to: lead.id, text: 'Older readable receipt.' });
		const large = s.messages.report({ to: lead.id, text: 'Readable history.', result: { status: 'failure', error: { message: '字🙂'.repeat(5000) } } });
		const small = resultOf(await s.call(lead, 'read_messages', { ids: [ordinary.alias, old.alias] }));
		assert.deepStrictEqual(small.data.messages.map((each: { text: string }) => each.text), [text, old.text]);
		const file = resultOf(await s.call(lead, 'read_messages', { ids: [large.alias] }));
		assert.ok(file.data.file.path);
		assert.ok(s.written[0].text.includes(JSON.stringify(large.result)));
		assert.strictEqual(file.data.messages[0].result, undefined);
		assert.strictEqual(file.data.messages[0].text, undefined);
		assert.ok(!s.written[0].text.includes(large.text));
	});

	test('cross-window routing retains full internal identities, compacts at the caller and preserves unavailable peers', async () => {
		const receiver = setUp();
		try {
			const lead = runFacts(1, { yolo: true }), target = runFacts(20);
			s.agents.add(lead);
			receiver.agents.add(target);
			receiver.deps.window = { id: 'win-2', label: 'Remote', environment: 'ssh' };
			const remote = createToolServices(receiver.deps);
			const network = new FakeNetwork();
			network.window(2, 'Remote', [remoteAgent(20)]);
			s.deps.network = network;
			network.respond = async route => ({ ok: true, result: await remote.serve({ from: 'win-1', ...route }) });
			const answer = resultOf(await s.call(lead, 'type_text', { agent: '#a20', text: 'hello' }));
			assert.strictEqual(answer.data.agent_id, '#a20');
			assert.strictEqual(receiver.terminal.typed[0].run, runId(20));
			assert.strictEqual(network.routed[0].args.protocol, TOOL_PROTOCOL);
			const details = resultOf(await s.call(lead, 'list_agents', { agent: '#a20', details: true }));
			assert.strictEqual(details.data.agents[0].agent_id, '#a20');
			assert.ok(details.data.agents[0].created_at);
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'Remote unavailable.', effects: 'none' });
			const partial = resultOf(await s.call(lead, 'list_agents'));
			assert.strictEqual(partial.data.complete, false);
			assert.strictEqual(partial.data.unavailable_windows[0].window_id, 'win-2');
		} finally { receiver.dispose(); }
	});
});
