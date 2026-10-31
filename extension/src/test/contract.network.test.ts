/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { locationOf } from '../contract/facts';
import type { GuestCaller } from '../contract/network';
import { createToolServices, ToolServices } from '../contract/tools';
import type { MessageRecord } from '../core/messagePorts';
import { accepted, failure, success } from '../schema/result';
import { MESSAGE_LIMIT } from '../schema/tools';
import { FakeNetwork, remoteAgent, resultOf, runFacts, runId, Setup, setUp } from './contractFakes';
import { waitFor } from './util';

/** A root the person started, YOLO off, with a child and a grandchild, and an unrelated YOLO root. */
function team(s: Setup) {
	const lead = runFacts(1, { name: 'lead' });
	const worker = runFacts(2, { name: 'worker', root: lead.id, creator: lead.id, origin: 'agent' });
	const helper = runFacts(3, { name: 'helper', root: lead.id, creator: worker.id, origin: 'agent' });
	const stranger = runFacts(4, { name: 'stranger', yolo: true });
	s.agents.add(lead, worker, helper, stranger);
	return { lead, worker, helper, stranger };
}

/** A caller of another window, as its window routes it here. */
function guestOf(n: number, more: Partial<GuestCaller> = {}): GuestCaller {
	return { id: runId(n), alias: `#a${n}`, name: `guest ${n}`, root: runId(n), yolo: false, window: 'win-2', windowLabel: 'Backend', ...more };
}

/** The record a delivering window keeps of a message, as it answers a `deliver` with it. */
function recordOf(id: string, from: string, to: string, delivery: MessageRecord['delivery'], text = 'Please check the build.'): MessageRecord {
	return {
		id, alias: `#m${id.slice(2)}`, kind: 'message', from: { run: from, alias: '#a4', name: 'stranger' }, to: { run: to, alias: '#a20', name: 'builder' },
		window: 'win-2', environment: 'ssh-remote+box', fromWindow: 'win-1', at: 4000, text, length: [...text].length, delivery
	};
}

const DELIVERED: MessageRecord['delivery'] = { status: 'success', effects: { outcome: 'confirmed', text_written: 'full', enter_written: true }, attempts: 1, via: 'terminal', deliveredAt: 4100 };

suite('Contract: the nine tools across the windows of this computer (COLLABORATION-1.1, MCP-2 to 5)', () => {

	let s: Setup;
	let network: FakeNetwork;
	let services: ToolServices;
	setup(() => {
		s = setUp();
		network = new FakeNetwork();
		s.deps.network = network;
		services = createToolServices(s.deps);
	});
	teardown(() => s.dispose());

	suite('list_start_options', () => {

		test('without a window: this window first, each other one that answers, and those that do not listed apart - never an empty success', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend', [], 'ssh-remote+box');
			network.window(3, 'Docs');
			network.unavailable = [{ window: 'win-4', label: 'Newer build', reason: 'protocol_incompatible' }];
			const backend = { window_id: 'win-2', label: 'Backend', environment: 'ssh-remote+box', available: true, locations: [{ location_id: 'loc-9', label: 'api' }] };
			network.respond = route => route.window === 'win-2'
				? { ok: true, result: backend }
				: { ok: false, reason: 'timeout', message: 'The Facade window win-3 did not answer within 10 seconds: the request may have taken effect there.', effects: 'unknown' };
			const result = resultOf(await s.call(lead, 'list_start_options', {}));
			assert.strictEqual(result.status, 'success');
			assert.deepStrictEqual(result.data.windows.map((each: { window_id: string }) => each.window_id), ['win-1', 'win-2']);
			assert.deepStrictEqual(result.data.windows[1], backend);
			assert.strictEqual(result.data.complete, false);
			assert.deepStrictEqual(result.data.unavailable_windows, [
				{ window_id: 'win-4', label: 'Newer build', reason: 'protocol_incompatible' },
				{ window_id: 'win-3', label: 'Docs', reason: 'window_unavailable', message: 'The Facade window win-3 did not answer within 10 seconds: the request may have taken effect there.' }
			]);
			// Each other window asked once, within what is left of the query's ten seconds
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.args, each.deadlineMs]), [['win-2', 'summary', {}, 9_993], ['win-3', 'summary', {}, 9_993]]);
		});

		test('the other windows that cannot be listed at all are one unavailable entry, and this window is still listed', async () => {
			const { lead } = team(s);
			network.directoryError = new Error('the Facade Code Window Component did not list the open windows');
			const result = resultOf(await s.call(lead, 'list_start_options', {}));
			assert.deepStrictEqual([result.data.windows.map((each: { window_id: string }) => each.window_id), result.data.complete], [['win-1'], false]);
			assert.deepStrictEqual(result.data.unavailable_windows.map((each: { window_id: string; reason: string }) => [each.window_id, each.reason]), [['*', 'window_unavailable']]);
			assert.deepStrictEqual(network.routed, []);
		});

		test('another window\'s locations and CLIs are asked of that window, for the caller as its own window knows it', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend');
			network.respond = () => ({ ok: true, result: { result: success({ window_id: 'win-2', label: 'Backend', locations: [], complete: true }), headline: 'Window Backend has 0 working locations.' } });
			const answer = await s.call(lead, 'list_start_options', { window_id: 'win-2' });
			const result = resultOf(answer);
			assert.deepStrictEqual([result.status, result.data.window_id, answer.text.split('\n')[0]], ['success', 'win-2', 'Window Backend has 0 working locations.']);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs]), [['win-2', 'call', 9_993]]);
			const routed = network.routed[0].args;
			assert.deepStrictEqual([routed.tool, routed.arguments.window_id, routed.callId, routed.elapsedMs, routed.inline], ['list_start_options', 'win-2', 'call-1', 7, undefined]);
			assert.deepStrictEqual(routed.caller, { id: lead.id, alias: '#a1', name: 'lead', root: lead.id, yolo: false, window: 'win-1', windowLabel: 'Design' });
		});

		test('a window no component lists is not found, before anything is routed - for a start as for a query', async () => {
			const { lead } = team(s);
			network.window(3, 'Docs');
			const query = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-2' }));
			assert.deepStrictEqual([query.error?.code, query.error?.reason], ['NOT_FOUND', 'not_found']);
			const start = resultOf(await s.call(lead, 'start_agent', { name: 'child', window_id: 'win-2', location_id: 'loc-1', cli: 'claude' }));
			assert.deepStrictEqual([start.error?.code, start.error?.reason, start.effects], ['NOT_FOUND', 'not_found', { outcome: 'none' }]);
			assert.deepStrictEqual([network.routed.length, s.agents.launched.length], [0, 0]);
			// Where the list itself cannot be read, the route is tried and says why
			network.directoryError = new Error('no component');
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'The Facade Code Window Component could not carry the request.', effects: 'none' });
			assert.strictEqual(resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-2' })).error?.reason, 'window_unavailable');
		});

		test('a window that cannot be reached for a query fails with why, and the query had no effect', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend');
			network.respond = () => ({ ok: false, reason: 'protocol_incompatible', message: 'The Facade window win-2 runs another version of Facade Code.', effects: 'unknown' });
			const result = resultOf(await s.call(lead, 'list_start_options', { window_id: 'win-2', location_id: 'loc-9' }));
			assert.deepStrictEqual([result.error?.code, result.error?.reason, result.effects, result.data], ['UNAVAILABLE', 'protocol_incompatible', { outcome: 'none' }, { window_id: 'win-2' }]);
		});
	});

	suite('start_agent', () => {

		test('a start in another window is made there, for the caller as its window knows it; nothing starts or is numbered here', async () => {
			const { worker } = team(s);
			network.window(2, 'Backend', [], 'ssh-remote+box');
			const started = success({ agent_id: runId(40), window_id: 'win-2', creator: worker.id, root: worker.root, process_state: 'running' }, { outcome: 'confirmed', agent_id: runId(40) });
			network.respond = () => ({ ok: true, result: { result: started, headline: `Started @child #a40 (${runId(40)}) with codex in /srv/api: its process is running.` } });
			const answer = await s.call(worker, 'start_agent', { name: 'child', window_id: 'win-2', location_id: 'loc-9', cli: 'codex', prompt: 'Build it.' });
			assert.deepStrictEqual(resultOf(answer).data, started.data);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.args.tool, each.args.arguments.location_id, each.args.arguments.prompt, each.deadlineMs]),
				[['win-2', 'call', 'start_agent', 'loc-9', 'Build it.', 130_000]]);
			// The child joins the caller's tree there: its root goes with the caller
			assert.deepStrictEqual([network.routed[0].args.caller.id, network.routed[0].args.caller.root], [worker.id, runId(1)]);
			assert.deepStrictEqual([s.agents.launched, s.messages.allocated], [[], []]);
		});
	});

	suite('list_agents', () => {

		test('every window within reach, oldest first across windows, paged with cursors that hold across windows', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend');
			const early = { agent_id: runId(20), alias: '#a20', name: 'builder', window_id: 'win-2', created_at: new Date(1000).toISOString() };
			const late = { agent_id: runId(21), alias: '#a21', name: 'tester', window_id: 'win-2', created_at: new Date(1500).toISOString() };
			network.respond = () => ({ ok: true, result: { agents: [late, early] } });
			const first = resultOf(await s.call(stranger, 'list_agents', { limit: 2 }));
			assert.deepStrictEqual(first.data.agents.map((each: { alias: string }) => each.alias), ['#a20', '#a1']);
			assert.deepStrictEqual([first.data.complete, first.data.unavailable_windows], [true, []]);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.args, each.deadlineMs]), [
				['win-2', 'agents', { caller: { id: stranger.id, alias: '#a4', name: 'stranger', root: stranger.id, yolo: true, window: 'win-1', windowLabel: 'Design' }, include_ended: false }, 9_993]
			]);
			const second = resultOf(await s.call(stranger, 'list_agents', { limit: 2, cursor: first.data.next_cursor }));
			assert.deepStrictEqual(second.data.agents.map((each: { alias: string }) => each.alias), ['#a2', '#a3']);
			const third = resultOf(await s.call(stranger, 'list_agents', { limit: 2, cursor: second.data.next_cursor }));
			assert.deepStrictEqual([third.data.agents.map((each: { alias: string }) => each.alias), third.data.next_cursor], [['#a4', '#a21'], undefined]);
		});

		test('one window named lists that window alone: this one asks nobody, another is asked alone, one that is not open is not found', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend');
			network.window(3, 'Docs');
			network.respond = route => ({ ok: true, result: { agents: [{ agent_id: runId(10 * Number(route.window.slice(4))), alias: `#a${route.window.slice(4)}0`, created_at: new Date(0).toISOString() }] } });
			const here = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-1' }));
			assert.deepStrictEqual([here.data.agents.map((each: { alias: string }) => each.alias), network.routed.length], [['#a1', '#a2', '#a3', '#a4'], 0]);
			const there = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-3' }));
			assert.deepStrictEqual([there.data.agents.map((each: { alias: string }) => each.alias), network.routed.map(each => each.window)], [['#a30'], ['win-3']]);
			const missing = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-9' }));
			assert.deepStrictEqual([missing.error?.code, missing.error?.reason], ['NOT_FOUND', 'not_found']);
		});

		test('a window that does not answer is listed apart and the list is not complete; this window\'s agents are still listed', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend');
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'The Facade window win-2 did not answer within 9.9 seconds.', effects: 'unknown' });
			const result = resultOf(await s.call(lead, 'list_agents', {}));
			assert.deepStrictEqual(result.data.agents.map((each: { alias: string }) => each.alias), ['#a1', '#a2', '#a3']);
			assert.deepStrictEqual([result.data.complete, result.data.unavailable_windows], [false, [{ window_id: 'win-2', label: 'Backend', reason: 'window_unavailable', message: 'The Facade window win-2 did not answer within 9.9 seconds.' }]]);
		});
	});

	suite('stop, screen and input for another window\'s agent', () => {

		const STOPPED = success({ agent_id: runId(20), reference: '@builder #a20', process_state: 'terminated' }, { outcome: 'confirmed', agent_id: runId(20) });

		test('a name another window lists, or its exact #aN, is routed there with the exact run ID; the answer comes back as that window gave it', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder', cli: 'codex' })]);
			network.respond = () => ({ ok: true, result: { result: STOPPED, headline: 'Closed @builder #a20 and ended its process.' } });
			for (const reference of ['@builder', 'builder', '#a20', runId(20), 'builder #a20']) {
				const answer = await s.call(stranger, 'stop_agent', { agent: reference });
				assert.deepStrictEqual([resultOf(answer).status, answer.text.split('\n')[0]], ['success', 'Closed @builder #a20 and ended its process.'], reference);
			}
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.args.tool, each.args.arguments, each.deadlineMs]), Array(5).fill(['win-2', 'call', 'stop_agent', { agent: runId(20) }, 130_000]));
			assert.deepStrictEqual(network.routed[0].args.caller, { id: stranger.id, alias: '#a4', name: 'stranger', root: stranger.id, yolo: true, window: 'win-1', windowLabel: 'Design' });
			// Nothing of this window's was closed
			assert.deepStrictEqual(s.agents.closed, []);
		});

		test('a stop that another window may have carried out before it went is unknown, one it never had is none', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'The Facade window win-2 went before it answered: the request may have taken effect there.', effects: 'unknown' });
			const unknown = resultOf(await s.call(stranger, 'stop_agent', { agent: '@builder' }));
			assert.deepStrictEqual([unknown.error?.code, unknown.error?.reason, unknown.effects], ['UNAVAILABLE', 'window_unavailable', { outcome: 'unknown' }]);
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'No open Facade window win-2 is on this computer: the request had no effect.', effects: 'none' });
			const none = resultOf(await s.call(stranger, 'stop_agent', { agent: '@builder' }));
			assert.deepStrictEqual(none.effects, { outcome: 'none' });
		});

		test('a name two windows have is ambiguous like one name twice in one window: the ID decides, and nothing is routed', async () => {
			const { stranger } = team(s);
			s.agents.add(runFacts(5, { name: 'builder', yolo: true }));
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			for (const tool of ['stop_agent', 'read_screen'] as const) {
				const result = resultOf(await s.call(stranger, tool, { agent: '@builder' }));
				assert.deepStrictEqual([result.error?.code, result.error?.reason], ['INVALID', 'ambiguous_reference'], tool);
				assert.match(result.error!.message, new RegExp(`${runId(5)}.*${runId(20)}`));
			}
			const sent = resultOf(await s.call(stranger, 'send_message', { to: 'builder', text: 'Hi' }));
			assert.strictEqual(sent.error?.reason, 'ambiguous_reference');
			assert.deepStrictEqual([network.routed, s.messages.allocated], [[], []]);
		});

		test('without YOLO another window\'s agent outside the caller\'s tree is refused by its ID and not found by its name', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' }), remoteAgent(22, { name: 'reviewer', root: lead.id, creator: lead.id })]);
			const byId = resultOf(await s.call(lead, 'stop_agent', { agent: '#a20' }));
			assert.deepStrictEqual([byId.error?.code, byId.error?.reason], ['REFUSED', 'out_of_tree']);
			const byName = resultOf(await s.call(lead, 'read_screen', { agent: '@builder' }));
			assert.deepStrictEqual([byName.error?.code, byName.error?.reason], ['NOT_FOUND', 'not_found']);
			assert.strictEqual(network.routed.length, 0);
			// One of its own tree in another window is reached
			network.respond = () => ({ ok: true, result: { result: success({ agent_id: runId(22), text: '' }), headline: 'The screen of @reviewer #a22.' } });
			assert.strictEqual(resultOf(await s.call(lead, 'read_screen', { agent: '@reviewer' })).status, 'success');
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.args.arguments]), [['win-2', { agent: runId(22), lines: 50 }]]);
		});

		test('read_screen of another window\'s agent asks for its text whole, and a short screen comes back as it is', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			const screen = success({ agent_id: runId(20), window_id: 'win-2', text: 'ready\n>' });
			network.respond = () => ({ ok: true, result: { result: screen, headline: 'The screen of @builder #a20.' } });
			const result = resultOf(await s.call(stranger, 'read_screen', { agent: '@builder', lines: 20 }));
			assert.deepStrictEqual(result.data, screen.data);
			assert.deepStrictEqual([network.routed[0].args.inline, network.routed[0].args.arguments, network.routed[0].deadlineMs], [true, { agent: runId(20), lines: 20 }, 9_993]);
			assert.deepStrictEqual(s.written, []);
		});

		test('a long screen another window read comes back whole and is written here, where the caller can read it (COLLABORATION-4.2)', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			const text = 'x'.repeat(MESSAGE_LIMIT + 1);
			const frame = 'the last full-screen frame';
			network.respond = () => ({
				ok: true, result: {
					result: success({ agent_id: runId(20), window_id: 'win-2', buffer: 'normal', line_count: 1, text, annotated: `[[${text}]]`, last_alternate_frame: { captured_at: '2026-10-28T21:00:00.000Z', line_count: 1, text: frame } }),
					headline: 'The screen of @builder #a20, captured 2026-10-28T22:00:00.000Z: 1 line of its normal buffer.'
				}
			});
			const answer = await s.call(stranger, 'read_screen', { agent: '@builder' });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.written.map(each => [each.home, each.kind, each.text]), [[s.deps.home, 'screen', `${text}\n`], [s.deps.home, 'screen', `${frame}\n`]]);
			assert.deepStrictEqual(result.data, {
				agent_id: runId(20), window_id: 'win-2', buffer: 'normal', line_count: 1,
				file: { path: `${s.deps.home}/results/screen-1.txt`, size: MESSAGE_LIMIT + 2, code_points: MESSAGE_LIMIT + 1 },
				last_alternate_frame: { captured_at: '2026-10-28T21:00:00.000Z', line_count: 1, file: { path: `${s.deps.home}/results/screen-2.txt`, size: frame.length + 1, code_points: frame.length } }
			});
			assert.match(answer.text.split('\n')[0], /more than 8,000 code points, so its complete plain text is in the file .*screen-1\.txt/);
		});

		test('type_text and press_keys reach a live agent of another window by name, an ended one of that name aside', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder', lifecycle: 'ended' }), remoteAgent(21, { name: 'builder' })]);
			network.respond = route => ({ ok: true, result: { result: success({ agent_id: runId(21) }, route.args.tool === 'type_text' ? { outcome: 'confirmed', text_written: 'full', enter_written: true } : { outcome: 'confirmed', keys_sent: 2 }), headline: 'Done there.' } });
			assert.strictEqual(resultOf(await s.call(stranger, 'type_text', { agent: '@builder', text: 'y', enter: true })).effects.enter_written, true);
			assert.strictEqual(resultOf(await s.call(stranger, 'press_keys', { agent: 'builder', keys: ['Down', 'Enter'] })).effects.keys_sent, 2);
			assert.deepStrictEqual(network.routed.map(each => [each.args.tool, each.args.arguments, each.deadlineMs]), [
				['type_text', { agent: runId(21), text: 'y', enter: true }, 30_000],
				['press_keys', { agent: runId(21), keys: ['Down', 'Enter'] }, 30_000]
			]);
			assert.deepStrictEqual([s.terminal.typed, s.terminal.pressed], [[], []]);
		});
	});

	suite('send_message to another window\'s agent', () => {

		test('overlapping sends with one request ID resolve and route only the first target', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20), remoteAgent(21)]);
			network.respond = route => ({ ok: true, result: { status: 'success', record: { ...recordOf(route.args.id, stranger.id, route.args.to, DELIVERED), requestId: route.args.requestId } } });
			const replies = await Promise.all([20, 21].map(id => s.call(stranger, 'send_message', { to: runId(id), text: 'Only once.', request_id: 'one-target' })));
			assert.strictEqual(network.routed.length, 1);
			assert.deepStrictEqual(replies.map(answer => [resultOf(answer).data.message_id, resultOf(answer).data.target]), [['m-1', runId(20)], ['m-1', runId(20)]]);
		});

		test('@human checks reachable agents in other windows; #human stays an unambiguous local notification', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'human' })]);
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '@human', text: 'Hello' })).error?.reason, 'ambiguous_reference');
			assert.deepStrictEqual(s.messages.sent, []);
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '#human', text: 'Hello' })).status, 'success');
		});

		test('an incomplete window list never guesses a local agent by name; its exact ID remains usable', async () => {
			const { stranger, worker } = team(s);
			network.directoryError = new Error('window component unavailable');
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '@worker', text: 'Hello' })).error?.reason, 'window_unavailable');
			assert.deepStrictEqual(s.messages.sent, []);
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: `@worker ${worker.alias}`, text: 'Hello' })).status, 'success');
		});

		test('its request ID goes with it to the window it is delivered in, and the copy kept here keeps it too (D104, D112)', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			network.respond = route => ({ ok: true, result: { status: 'success', record: { ...recordOf(route.args.id, stranger.id, runId(20), DELIVERED), requestId: route.args.requestId } } });
			await s.call(stranger, 'send_message', { to: '@builder', text: 'Please check the build.', request_id: 'ask-7' });
			assert.strictEqual(network.routed[0].args.requestId, 'ask-7');
			assert.deepStrictEqual(s.messages.kept.map(record => [record.id, record.requestId]), [['m-1', 'ask-7']]);
		});

		test('its ID is taken here, it is delivered there within the two seconds, a copy is kept here and success is the CLI\'s acceptance', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			network.respond = route => ({ ok: true, result: { status: 'success', record: recordOf(route.args.id, stranger.id, runId(20), DELIVERED) } });
			const answer = await s.call(stranger, 'send_message', { to: '@builder', text: 'Please check the build.' });
			const result = resultOf(answer);
			assert.deepStrictEqual(s.messages.allocated, ['m-1']);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs]), [['win-2', 'deliver', 2_993]]);
			assert.deepStrictEqual(network.routed[0].args, {
				id: 'm-1', from: { id: stranger.id, alias: '#a4', name: 'stranger', root: stranger.id, yolo: true, window: 'win-1', windowLabel: 'Design' },
				to: runId(20), text: 'Please check the build.', callId: 'call-1', elapsedMs: 7
			});
			assert.deepStrictEqual([result.status, result.data, result.effects], ['success', {
				message_id: 'm-1', alias: '#m1', target: runId(20), target_reference: '@builder #a20', length: 23, window_id: 'win-2', disposition: 'submitted_to_cli'
			}, { outcome: 'confirmed', text_written: 'full', enter_written: true }]);
			assert.strictEqual(answer.text.split('\n')[0], 'Message #m1 was submitted to @builder #a20\'s CLI.');
			assert.deepStrictEqual(s.messages.kept.map(each => [each.id, each.delivery.status]), [['m-1', 'success']]);
			// Not sent through this window's own delivery
			assert.deepStrictEqual(s.messages.sent, []);
		});

		test('accepted there is accepted here, with its deadline and obstacle; a failure there is one here, with its reason; a reply names a message of the caller\'s inbox', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			const earlier = s.messages.deliver(runFacts(1), stranger, 'Can you ask builder?');
			const pending: MessageRecord['delivery'] = { status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false }, deadline: Date.UTC(2026, 9, 28, 22, 0, 15), attempts: 1 };
			network.respond = route => ({ ok: true, result: { status: 'accepted', obstacle: 'input_draft', record: { ...recordOf(route.args.id, stranger.id, runId(20), pending), replyTo: route.args.replyTo } } });
			const later = resultOf(await s.call(stranger, 'send_message', { to: '#a20', text: 'Hi', reply_to: earlier.alias }));
			assert.deepStrictEqual([later.status, later.data.deadline, later.data.obstacle, later.data.reply_to, later.effects.outcome], ['accepted', '2026-10-28T22:00:15.000Z', 'input_draft', earlier.id, 'pending']);
			assert.strictEqual(network.routed[0].args.replyTo, earlier.id);
			const failed: MessageRecord['delivery'] = { status: 'failure', reason: 'unsupported', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 0 };
			network.respond = route => ({ ok: true, result: { status: 'failure', reason: 'unsupported', record: recordOf(route.args.id, stranger.id, runId(20), failed) } });
			const refused = resultOf(await s.call(stranger, 'send_message', { to: '#a20', text: 'Hi' }));
			assert.deepStrictEqual([refused.error?.code, refused.error?.reason, refused.effects.outcome], ['UNAVAILABLE', 'unsupported', 'none']);
			assert.deepStrictEqual(s.messages.kept.map(each => [each.id, each.delivery.status]), [['m-2', 'pending'], ['m-3', 'failure']]);
		});

		test('a route that never reached the other window had no effect; one that may have is unknown; an unreadable answer is unknown too; no copy is kept', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'No open Facade window win-2 is on this computer: the request had no effect.', effects: 'none' });
			const none = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([none.error?.code, none.error?.reason, none.effects], ['UNAVAILABLE', 'window_unavailable', { outcome: 'none', text_written: 'none', enter_written: false }]);
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'The Facade window win-2 did not answer within 3 seconds.', effects: 'unknown' });
			const unknown = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([unknown.error?.reason, unknown.effects], ['window_unavailable', { outcome: 'unknown', text_written: 'unknown', enter_written: null }]);
			network.respond = () => ({ ok: false, reason: 'protocol_incompatible', message: 'The Facade window win-2 runs another version.', effects: 'none' });
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' })).error?.reason, 'protocol_incompatible');
			network.respond = () => ({ ok: true, result: { status: 'delivered' } });
			const unreadable = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([unreadable.error?.code, unreadable.error?.reason, unreadable.effects.outcome], ['FAILED', 'internal_error', 'unknown']);
			assert.deepStrictEqual(s.messages.kept, []);
		});

		test('an ended agent of another window takes no message, and #human is the person in this window, never routed', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder', lifecycle: 'ended' })]);
			const ended = resultOf(await s.call(stranger, 'send_message', { to: '#a20', text: 'Hi' }));
			assert.deepStrictEqual([ended.error?.code, ended.error?.reason], ['UNAVAILABLE', 'ended']);
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '#human', text: 'Done.' })).status, 'success');
			assert.deepStrictEqual([network.routed, s.messages.sent.map(each => each.to)], [[], ['@human']]);
		});
	});

	suite('what this window serves for other windows', () => {

		test('a routed start runs here for the guest: its child joins the guest\'s tree, names its creator, and its prompt is the guest\'s message', async () => {
			const guest = guestOf(30, { name: 'planner', root: runId(29), yolo: true, window: 'win-forged' });
			const served = await services.serve({
				from: 'win-2', op: 'call', deadlineMs: 130_000,
				args: { tool: 'start_agent', arguments: { name: 'child', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', prompt: 'Build the API.\nThen test it.' }, caller: guest, callId: 'c-9', elapsedMs: 5 }
			}) as { result: { status: string; data: { agent_id: string; creator: string; root: string; prompt: { status: string } } }; headline: string };
			assert.strictEqual(served.result.status, 'success');
			const [launched] = s.agents.launched;
			assert.deepStrictEqual([launched.origin, launched.creator, launched.promptLine], ['agent', { run: runId(30), root: runId(29), label: 'planner #a30' }, 'Build the API.']);
			assert.deepStrictEqual([served.result.data.creator, served.result.data.root], [runId(30), runId(29)]);
			assert.strictEqual(s.agents.get(served.result.data.agent_id)?.root, runId(29));
			// Sent after startup as the guest's own message, its result to go back to the window the route came from, not the one it named
			assert.deepStrictEqual(s.messages.sent.map(each => [each.from, each.to, each.text, each.sender]), [[runId(30), served.result.data.agent_id, 'Build the API.\nThen test it.', { party: { run: runId(30), alias: '#a30', name: 'planner' }, window: 'win-2', label: 'Backend' }]]);
			assert.strictEqual(served.result.data.prompt.status, 'success');
			assert.deepStrictEqual(network.routed, []);
		});

		test('a routed start still starting is accepted, and its outcome goes back to the guest\'s window as a result - never into this window\'s inbox', async () => {
			s.agents.startWith = undefined;
			s.timeout = 0.02;
			network.respond = () => ({ ok: true, result: { taken: true } });
			const guest = guestOf(30, { name: 'planner' });
			const served = await services.serve({
				from: 'win-2', op: 'call', deadlineMs: 130_000,
				args: { tool: 'start_agent', arguments: { name: 'child', window_id: 'win-1', location_id: 'loc-1', cli: 'claude' }, caller: guest, callId: 'c-10', elapsedMs: 0 }
			}) as { result: { status: string; data: { agent_id: string } } };
			assert.strictEqual(served.result.status, 'accepted');
			const child = served.result.data.agent_id;
			s.agents.settle(child, { state: 'running' });
			await waitFor(() => network.routed.length > 0);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs, each.args.to, each.args.callId, each.args.agent]), [['win-2', 'result', 15_000, runId(30), 'c-10', { run: child, alias: s.agents.get(child)!.alias, name: 'child' }]]);
			assert.match(network.routed[0].args.text, /^Started @child #a\d+ \(run-[0-9a-f]+\) with claude/);
			assert.deepStrictEqual(s.messages.reports, []);
		});

		test('a guest\'s call is validated and resolved here like any other: a start for another window is not found, its own reach applies', async () => {
			const { lead } = team(s);
			const outsider = guestOf(30);
			const elsewhere = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { tool: 'start_agent', arguments: { name: 'child', window_id: 'win-5', location_id: 'loc-1', cli: 'claude' }, caller: outsider, callId: 'c-1', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([elsewhere.result.status, elsewhere.result.error.reason], ['failure', 'not_found']);
			const outOfTree = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { tool: 'stop_agent', arguments: { agent: lead.id }, caller: outsider, callId: 'c-2', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([outOfTree.result.status, outOfTree.result.error.reason], ['failure', 'out_of_tree']);
			const invalid = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { tool: 'stop_agent', arguments: {}, caller: outsider, callId: 'c-3', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([invalid.result.status, invalid.result.error.reason], ['failure', 'missing_argument']);
			assert.deepStrictEqual([s.agents.launched, s.agents.closed, network.routed], [[], [], []]);
			// One in its tree is stopped here
			const member = guestOf(30, { root: lead.id });
			const stopped = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { tool: 'stop_agent', arguments: { agent: lead.id }, caller: member, callId: 'c-4', elapsedMs: 0 } }) as { result: { status: string } };
			assert.deepStrictEqual([stopped.result.status, s.agents.closed], ['success', [lead.id]]);
			await assert.rejects(services.serve({ from: 'win-2', op: 'call', deadlineMs: 1_000, args: { tool: 'stop_agent', arguments: {}, callId: 'c-5', elapsedMs: 0 } }), /incomplete/);
		});

		test('a delivered message is sent here as the guest\'s, under its own ID and header label, to an agent the guest reaches alone', async () => {
			const { lead, stranger } = team(s);
			const reaching = guestOf(30, { yolo: true });
			s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_draft' });
			const answered = await services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-77', from: reaching, to: stranger.id, text: 'Hi there', replyTo: 'm-70', callId: 'c-1', requestId: 'ask-9', elapsedMs: 900 } }) as { status: string; obstacle: string; record: MessageRecord };
			assert.deepStrictEqual([answered.status, answered.obstacle, answered.record.id], ['accepted', 'input_draft', 'm-77']);
			// Its request ID kept with it here, where its record is made, for the sender's retry to find (D104, D112)
			assert.deepStrictEqual(s.messages.sent, [{ id: 'm-77', from: runId(30), sender: { party: { run: runId(30), alias: '#a30', name: 'guest 30' }, window: 'win-2', label: 'Backend' }, to: stranger.id, text: 'Hi there', replyTo: 'm-70', elapsedMs: 900, callId: 'c-1', requestId: 'ask-9' }]);
			// Out of a non-YOLO guest's tree: not found, nothing sent
			await assert.rejects(services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-78', from: guestOf(31), to: lead.id, text: 'Hi', elapsedMs: 0 } }), /No agent .* that the sender reaches is in this window/);
			await assert.rejects(services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-79', from: reaching, to: runId(99), text: 'Hi', elapsedMs: 0 } }), /No agent/);
			await assert.rejects(services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-80', to: stranger.id, text: 'Hi', elapsedMs: 0 } }), /incomplete/);
			assert.strictEqual(s.messages.sent.length, 1);
		});

		test('a result from another window goes into the agent\'s inbox here and brings its sent copy up to date; one for nobody here is refused', async () => {
			const { lead } = team(s);
			const about = recordOf('m-5', lead.id, runId(20), DELIVERED);
			assert.deepStrictEqual(await services.serve({ from: 'win-2', op: 'result', deadlineMs: 15_000, args: { to: lead.id, text: 'Your message #m5 was submitted to its CLI.', callId: 'c-1', about, agent: { run: runId(20), alias: '#a20', name: 'builder' } } }), { taken: true });
			assert.deepStrictEqual(s.messages.kept, [about]);
			assert.deepStrictEqual(s.messages.reports, [{ to: lead.id, text: 'Your message #m5 was submitted to its CLI.', callId: 'c-1', about: 'm-5', agentParty: { run: runId(20), alias: '#a20', name: 'builder' } }]);
			await assert.rejects(services.serve({ from: 'win-2', op: 'result', deadlineMs: 15_000, args: { to: runId(99), text: 'Nobody' } }), /names no agent of this window/);
			assert.strictEqual(s.messages.reports.length, 1);
		});

		test('this window\'s agents and summary as other windows ask for them: within the guest\'s reach, ended ones on request', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(6, { name: 'gone', root: lead.id, lifecycle: 'ended' }));
			const inTree = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { root: lead.id }) } }) as { agents: { alias: string; window_id: string; created_at: string }[] };
			assert.deepStrictEqual(inTree.agents.map(each => each.alias), ['#a1', '#a2', '#a3']);
			assert.deepStrictEqual([inTree.agents[0].window_id, inTree.agents[0].created_at], ['win-1', new Date(1001).toISOString()]);
			const withEnded = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { root: lead.id }), include_ended: true } }) as { agents: { alias: string }[] };
			assert.deepStrictEqual(withEnded.agents.map(each => each.alias), ['#a1', '#a2', '#a3', '#a6']);
			const yolo = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { yolo: true }) } }) as { agents: { alias: string }[] };
			assert.deepStrictEqual(yolo.agents.map(each => each.alias), ['#a1', '#a2', '#a3', '#a4']);
			await assert.rejects(services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: {} }), /names no caller/);
			assert.deepStrictEqual(await services.serve({ from: 'win-2', op: 'summary', deadlineMs: 9_000, args: {} }), {
				window_id: 'win-1', label: 'Design', environment: 'local', available: true, locations: s.locations.map(each => locationOf(each, false))
			});
			// A window with no folder is listed too, as one nobody can start an agent in (MCP-2.1)
			s.locations = [];
			assert.deepStrictEqual(await services.serve({ from: 'win-2', op: 'summary', deadlineMs: 9_000, args: {} }), {
				window_id: 'win-1', label: 'Design', environment: 'local', available: false, reason: 'No folder is open in this window, so no agent can start in it.', locations: []
			});
			await assert.rejects(services.serve({ from: 'win-2', op: 'unknown', deadlineMs: 9_000, args: {} }), /serves no "unknown"/);
		});
	});

	test('a failed answer of another window is a failure here, and accepted is accepted, both as that window gave them', async () => {
		const { stranger } = team(s);
		network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
		network.respond = () => ({ ok: true, result: { result: failure({ code: 'UNAVAILABLE', reason: 'ended', message: '@builder #a20 has ended, so its terminal takes no input.' }, { agent_id: runId(20) }, { outcome: 'none', text_written: 'none', enter_written: false }) } });
		const ended = resultOf(await s.call(stranger, 'type_text', { agent: '#a20', text: 'y' }));
		assert.deepStrictEqual([ended.status, ended.error?.reason], ['failure', 'ended']);
		network.respond = () => ({ ok: true, result: { result: accepted({ agent_id: runId(20), process_state: 'stopping', cleanup: 'pending' }, { outcome: 'pending', agent_id: runId(20) }), headline: 'Closed its card; its process is still being ended.' } });
		const stopping = resultOf(await s.call(stranger, 'stop_agent', { agent: '#a20' }));
		assert.deepStrictEqual([stopping.status, stopping.data.cleanup], ['accepted', 'pending']);
	});
});
