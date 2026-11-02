/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { deliveryReceipt } from '../contract/facts';
import { failureAnswer } from '../transport/failure';
import { resultOf, runFacts, setUp, Setup } from './contractFakes';

suite('Contract: recovery preserves effects and existing operations', () => {
	let s: Setup;
	setup(() => s = setUp());
	teardown(() => s.dispose());

	test('lost raw input suggests observation without performing another write', async () => {
		const lead = runFacts(1, { yolo: true }), worker = runFacts(2);
		s.agents.add(lead, worker);
		s.terminal.typeWith = new Error('Runtime answer lost after dispatch');
		const result = resultOf(await s.call(lead, 'type_text', { agent: '#a2', text: 'do once', enter: true }));
		assert.deepStrictEqual(result.recovery, { action: 'inspect_effects', check: { tool: 'read_screen', arguments: { agent: '#a2' } } });
		assert.deepStrictEqual(result.effects, { outcome: 'unknown', text_written: 'unknown', enter_written: null });
		assert.strictEqual(s.terminal.typed.length, 1);
		assert.strictEqual(s.terminal.pressed.length, 0);
	});

	test('a prompt failure has its own recovery without turning the running process into a failed start', async () => {
		const lead = runFacts(1);
		s.agents.add(lead);
		s.messages.respond = () => ({ status: 'failure', reason: 'input_draft' });
		const result = resultOf(await s.call(lead, 'start_agent', { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', prompt: 'one task' }));
		assert.deepStrictEqual([result.status, result.data.process_state, result.data.prompt.status], ['success', 'running', 'failure']);
		assert.strictEqual(result.recovery, undefined);
		assert.deepStrictEqual(result.data.prompt.recovery, { action: 'resolve_blocker', check: { tool: 'read_screen', arguments: { agent: result.data.agent_id } } });
		assert.deepStrictEqual([s.agents.launched.length, s.messages.sent.length, s.agents.closed.length], [1, 1, 0]);
	});

	test('same-ID retrieval of a final failure keeps the original message and recovery without sending again', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2));
		s.messages.now = () => 3000;
		s.messages.respond = () => ({ status: 'failure', reason: 'input_draft' });
		const args = { to: '#a2', text: 'one task', request_id: 'send-once' };
		const first = resultOf(await s.call(lead, 'send_message', args));
		const repeated = resultOf(await s.call(lead, 'send_message', args));
		assert.deepStrictEqual([repeated.status, repeated.data.message_id, repeated.data.repeated], ['failure', first.data.message_id, true]);
		assert.deepStrictEqual(repeated.recovery, first.recovery);
		assert.strictEqual(s.messages.sent.length, 1);
		assert.deepStrictEqual(deliveryReceipt(s.messages.records[0]).recovery, first.recovery);
	});

	test('transport distinguishes no handoff, uncertain keyed handoff, and uncertain raw input', () => {
		const call = { tool: 'send_message', arguments: { to: '#a2', text: 'secret body', request_id: 'original' } };
		const before = resultOf(failureAnswer('UNAVAILABLE', 'window_unavailable', 'Not dispatched.', 'none', call));
		const lost = resultOf(failureAnswer('UNAVAILABLE', 'window_unavailable', 'Reply lost.', 'unknown', call));
		const raw = resultOf(failureAnswer('UNAVAILABLE', 'window_unavailable', 'Reply lost.', 'unknown', { tool: 'press_keys', arguments: { agent: '#a2', keys: ['Enter'] } }));
		assert.deepStrictEqual(before.recovery, { action: 'reconnect' });
		assert.deepStrictEqual(lost.recovery, { action: 'repeat_original_request', request_id: 'original', condition: 'within_original_hour' });
		assert.deepStrictEqual(raw.recovery, { action: 'inspect_effects' });
		assert.ok(!JSON.stringify(lost).includes('secret body'));
	});

	test('lost pure queries have no state effects; an inbox read can acknowledge delivery', () => {
		for (const tool of ['list_start_options', 'list_agents', 'read_screen', 'read_messages']) {
			const result = resultOf(failureAnswer('UNAVAILABLE', 'timeout', 'Reply lost.', 'unknown', { tool, arguments: {} }));
			assert.strictEqual(result.effects.outcome, tool === 'read_messages' ? 'unknown' : 'none');
		}
	});

	test('every lost-answer reason preserves a valid Unicode original request key', () => {
		for (const reason of ['timeout', 'window_unavailable', 'invalid_response', 'route_failed']) {
			const request_id = '🔔'.repeat(200);
			const result = resultOf(failureAnswer('UNAVAILABLE', reason, 'Reply lost.', 'unknown', { tool: 'send_message', arguments: { request_id } }));
			assert.deepStrictEqual(result.recovery, { action: 'repeat_original_request', request_id, condition: 'within_original_hour' });
		}
	});

	test('normal success has no recovery; an ambiguous name offers scoped discovery, not another target', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2, { name: 'same' }), runFacts(3, { name: 'same' }));
		const failed = resultOf(await s.call(lead, 'send_message', { to: '@same', text: 'one task' }));
		assert.deepStrictEqual(failed.recovery, { action: 'resolve_target', check: { tool: 'list_agents', arguments: {} } });
		assert.strictEqual(s.messages.sent.length, 0);
		const success = resultOf(await s.call(lead, 'send_message', { to: '#a2', text: 'one task' }));
		assert.strictEqual(success.recovery, undefined);
	});

	test('a closed target offers no invented screen or agent lookup after unconfirmed termination', async () => {
		const lead = runFacts(1, { yolo: true });
		s.agents.add(lead, runFacts(2));
		s.agents.closeWith = 'unconfirmed';
		const result = resultOf(await s.call(lead, 'stop_agent', { agent: '#a2' }));
		assert.deepStrictEqual(result.recovery, { action: 'inspect_effects' });
		assert.deepStrictEqual([result.data.closed, result.effects.outcome, s.agents.closed.length], [true, 'partial', 1]);
	});
});
