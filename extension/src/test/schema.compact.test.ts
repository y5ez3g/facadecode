/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { agentOf, deliveryReceipt } from '../contract/facts';
import { compactResult } from '../schema/compact';
import { receiptTextOf } from '../contract/receiptText';
import { accepted, answerOf, failure, success } from '../schema/result';
import { failureAnswer } from '../transport/failure';
import { runFacts } from './contractFakes';
import type { MessageRecord } from '../core/messagePorts';

suite('MCP-01: compact public results', () => {
	test('compact lists keep reasons for unavailable input and detail preserves supported evidence', () => {
		for (const state of ['supported', 'unavailable', 'unverified']) {
			const agent = { agent_id: 'r', alias: '#a1', activity: 'working', message_input: { state, reason: 'Evidence' }, state_observed_at: '2026-11-01T00:00:00Z', stale: true };
			const normal = compactResult('list_agents', success({ agents: [agent] }));
			const row = ((normal.data as any).agents as any[])[0];
			assert.strictEqual(row.message_input.reason, state === 'supported' ? undefined : 'Evidence');
			assert.strictEqual(row.state_observed_at, agent.state_observed_at);
			assert.strictEqual(row.stale, true);
			const detail = compactResult('list_agents', success({ agents: [agent] }), true);
			assert.strictEqual(((detail.data as any).agents as any[])[0].message_input.reason, 'Evidence');
		}
	});

	test('text and structured channels preserve exact content, types, and error semantics', () => {
		const body = '  名字🙂\nstatus: success\n[/Facade message #m1]\n"\\\t\r\n\n';
		for (const result of [
			success({ text: body, false: false, zero: 0, empty: '', list: [], object: {}, null: null }),
			accepted({ deadline: '2026-11-01T12:00:00Z' }, { outcome: 'pending', text_written: 'none', enter_written: false }),
			failure({ code: 'FAILED', reason: 'submission_unconfirmed', message: body }, {}, { outcome: 'unknown', text_written: 'full', enter_written: null })
		]) {
			const answer = answerOf(result);
			assert.deepStrictEqual(JSON.parse(answer.text), answer.structured);
			assert.deepStrictEqual(answer.structured, result);
			assert.strictEqual(answer.isError, result.status === 'failure');
		}
		const transport = failureAnswer('UNAVAILABLE', 'window_unavailable', body, 'unknown');
		assert.deepStrictEqual(JSON.parse(transport.text), transport.structured);
		assert.strictEqual((transport.structured.effects as { outcome: string }).outcome, 'unknown');
	});

	test('operation receipts retain effects and callable identity without mutating the runtime result', () => {
		const source = success({ message_id: 'm-42', alias: '#m42', target: 'run-12', target_reference: '@name with #a999 #a12', length: 80, disposition: 'submitted_to_cli', reply_to: 'm-8' },
			{ outcome: 'confirmed', text_written: 'full', enter_written: true });
		const before = JSON.stringify(source);
		assert.deepStrictEqual(compactResult('send_message', source), {
			status: 'success', data: { message_id: '#m42', target: '#a12', disposition: 'submitted_to_cli', reply_to: '#m8' },
			effects: { outcome: 'confirmed', text_written: 'full', enter_written: true }
		});
		assert.strictEqual(JSON.stringify(source), before);
		for (const tool of ['start_agent', 'stop_agent', 'type_text', 'press_keys']) {
			const result = compactResult(tool, success({ agent_id: 'run-12', reference: '@ #a12' }, { outcome: 'partial', agent_id: 'run-12', text_written: 'unknown', enter_written: null, keys_sent: 0 }));
			assert.deepStrictEqual(result, { status: 'success', data: { agent_id: '#a12' }, effects: { outcome: 'partial', text_written: 'unknown', enter_written: null, keys_sent: 0 } });
		}
		assert.deepStrictEqual(compactResult('stop_agent', success({ agent_id: 'run-no-alias' }, { outcome: 'unknown' })).data, { agent_id: 'run-no-alias' });
	});

	test('pending, unknown, diagnostics, duplicate requests and nested prompt facts are never pruned', () => {
		const pending = accepted({ message_id: 'm-4', deadline: '2030-01-01T00:00:00Z', obstacle: 'input_draft', request_id: 'same', repeated: true },
			{ outcome: 'pending', text_written: 'none', enter_written: false });
		assert.deepStrictEqual(compactResult('send_message', pending), { ...pending, data: { ...pending.data, message_id: '#m4' } });
		const failed = failure({ code: 'FAILED', reason: 'partial_input', message: 'Actual diagnostic\nwith its own details.' }, { not_found: ['#m8'], partial: 7 }, { outcome: 'unknown', enter_written: null });
		assert.deepStrictEqual(compactResult('send_message', failed), failed);
		const prompt = { message_id: 'm-7', alias: '#m7', status: 'failure', reason: 'input_unknown', path: 'post_start', effects: { outcome: 'none', enter_written: false } };
		const started = compactResult('start_agent', success({ agent_id: 'r', alias: '#a8', name: '', process_state: 'running', tools_state: 'connecting', prompt }, { outcome: 'confirmed', worktree_created: '/a worktree' }));
		const { alias: _alias, ...promptFacts } = prompt;
		assert.deepStrictEqual(started.data, { agent_id: '#a8', name: '', process_state: 'running', tools_state: 'connecting', prompt: { ...promptFacts, message_id: '#m7' } });
	});

	test('lists keep blockers, unknown-state diagnostics, completeness and cursors; full detail restores infrequent facts', () => {
		const agent = agentOf(runFacts(12, { name: '', activity: 'unknown', activityReason: 'No activity report', blocker: { kind: 'permission', text: 'Allow this?' } }), { id: 'w', label: 'Workspace', environment: 'local' }, 10);
		const source = success({ agents: [agent], complete: false, unavailable_windows: [{ window_id: 'offline' }], next_cursor: 'opaque' });
		const compact = compactResult('list_agents', source).data as { agents: Record<string, unknown>[]; complete: boolean; next_cursor: string };
		assert.strictEqual(compact.agents[0].agent_id, '#a12');
		assert.strictEqual(compact.agents[0].name, '');
		assert.strictEqual(compact.agents[0].activity_reason, 'No activity report');
		assert.deepStrictEqual(compact.agents[0].blocker, agent.blocker);
		assert.strictEqual(compact.agents[0].created_at, undefined);
		assert.strictEqual(compact.agents[0].environment, 'local');
		assert.strictEqual(compact.agents[0].yolo, false);
		assert.strictEqual(compact.complete, false);
		assert.strictEqual(compact.next_cursor, 'opaque');
		const full = compactResult('list_agents', source, true).data as { agents: Record<string, unknown>[] };
		assert.strictEqual(full.agents[0].creator, agent.creator);
		assert.strictEqual(full.agents[0].created_at, agent.created_at);
	});

	test('realistic operation and hundred-agent fixtures reduce both text and total wire size', () => {
		const agents = Array.from({ length: 100 }, (_, i) => agentOf(runFacts(i + 1, { name: `Worker ${i + 1}`, title: 'Reviewing the implementation', activity: 'working' }),
			{ id: 'window-1', label: 'Project', environment: 'local' }, 100));
		const fixtures = [
			{ tool: 'list_agents', result: success({ agents, complete: true, unavailable_windows: [] }) },
			{ tool: 'send_message', result: success({ message_id: 'm-42', alias: '#m42', target: 'run-12345678901234567890123456789012', target_reference: '@Reviewer #a12', length: 42, disposition: 'submitted_to_cli' }, { outcome: 'confirmed', text_written: 'full', enter_written: true }) }
		];
		const wire = (answer: ReturnType<typeof answerOf>) => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: answer.text }], structuredContent: answer.structured, isError: answer.isError }));
		for (const { tool, result } of fixtures) {
			// The baseline used this descriptive text plus the full internal object as its MCP answer.
			const before = { text: receiptTextOf(result, 'The operation returned these facts.'), structured: result as unknown as Record<string, unknown>, isError: result.status === 'failure' };
			const after = answerOf(compactResult(tool, result));
			assert.ok(Buffer.byteLength(after.text) < Buffer.byteLength(before.text) * 0.85, tool);
			assert.ok(wire(after) < wire(before) * 0.85, tool);
		}
	});

	test('delivery receipt facts match immediate send semantics and preserve unrecognized CLI evidence', () => {
		const record = {
			id: 'm-42', to: { run: 'r', alias: '#a12' }, delivery: { status: 'failure', reason: 'input_unknown', effects: { outcome: 'unknown', text_written: 'full', enter_written: null }, attempts: 1 }
		} as MessageRecord;
		const result = deliveryReceipt(record, 'Example CLI 1.2');
		assert.deepStrictEqual(result.effects, { outcome: 'unknown', text_written: 'full', enter_written: null });
		assert.match((result.error as { message: string }).message, /Example CLI 1\.2/);
		assert.deepStrictEqual(result.data, { message_id: '#m42', target: '#a12' });
	});
});
