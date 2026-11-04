/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { GuestCaller } from '../contract/network';
import { createToolServices, ToolServices } from '../contract/tools';
import { FacadeError } from '../core/errors';
import type { MessageRecord } from '../core/messagePorts';
import { TOOL_PROTOCOL } from '../schema/protocol';
import { accepted, failure, success } from '../schema/result';
import { MESSAGE_LIMIT } from '../schema/tools';
import { FakeNetwork, remoteSnapshot, remoteAgent, resultOf, runFacts, runId, Setup, setUp } from './contractFakes';
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

suite('Contract: the eight tools across the windows of this computer (COLLABORATION-1.1, MCP-2 to 5)', () => {

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

	test('malformed query replies mean an unavailable window, never an empty complete list', async () => {
		const { stranger } = team(s);
		network.window(2, 'Backend', [remoteAgent(20)]);
		for (const body of [undefined, {}, { agents: 'empty', locations: 'empty' }]) {
			network.respond = () => ({ ok: true, result: body });
			for (const tool of ['list_agents'] as const) {
				const result = resultOf(await s.call(stranger, tool, {}));
				assert.strictEqual(result.data.complete, false);
				assert.strictEqual(result.data.unavailable_windows[0].reason, 'invalid_response');
				assert.strictEqual(result.effects.outcome, 'none');
			}
		}
	});

	test('a lost targeted screen read has no input effect; raw input on the same route remains unknown', async () => {
		const { stranger } = team(s);
		network.window(2, 'Backend', [remoteAgent(20)]);
		network.respond = () => ({ ok: false, reason: 'timeout', message: 'Reply lost.', effects: 'unknown' });
		const screen = resultOf(await s.call(stranger, 'read_screen', { agent: '#a20' }));
		const input = resultOf(await s.call(stranger, 'type_text', { agent: '#a20', text: 'x' }));
		assert.deepStrictEqual([screen.error?.reason, screen.effects.outcome], ['timeout', 'none']);
		assert.deepStrictEqual([input.error?.reason, input.effects.outcome], ['timeout', 'unknown']);
		assert.strictEqual(input.data.window_id, 'win-2');
		assert.strictEqual(network.routed.length, 2);
	});

	suite('window discovery in list_agents', () => {
		test('empty remote windows remain launch destinations, and unavailable windows remain explicit', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend', [], 'ssh-remote+box');
			network.window(3, 'Docs');
			network.unavailable = [{ window: 'win-4', label: 'Newer build', reason: 'protocol_incompatible' }];
			const backend = remoteSnapshot('win-2', [], { folders: [{ name: 'api', uri: 'file:///srv/api', path: '/srv/api' }],
				locations: [{ location_id: 'loc-9', label: 'api', path: '/srv/api' }], clis: [{ cli: 'codex', available: true }],
				counts: { folders: 1, locations: 1, worktrees: 0, agents: 0 } });
			network.respond = route => route.window === 'win-2' ? { ok: true, result: backend }
				: { ok: false, reason: 'timeout', message: 'The window did not answer.', effects: 'unknown' };
			const result = resultOf(await s.call(lead, 'list_agents'));
			assert.deepStrictEqual(result.data.windows.map((each: { window_id: string }) => each.window_id), ['win-1', 'win-2']);
			assert.deepStrictEqual(result.data.windows[1], backend.window);
			assert.deepStrictEqual(result.data.counts, { known_windows: 4, responding_windows: 2, folders: 2, locations: 3, worktrees: 1, agents: 3 });
			assert.strictEqual(result.data.complete, false);
			assert.deepStrictEqual(result.data.unavailable_windows.map((each: { reason: string }) => each.reason), ['protocol_incompatible', 'timeout']);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs]), [['win-2', 'agents', 9993], ['win-3', 'agents', 9993]]);
		});

		test('a window component too old for the client network: the other windows are unavailable as protocol_incompatible, the list not complete; a name is not resolved, this window\'s exact ID is (ARCHITECTURE-4.3, RULES-2.3)', async () => {
			const { stranger, worker } = team(s);
			network.directoryError = new FacadeError('UNAVAILABLE', 'protocol_incompatible', 'this window\'s Facade Code Window Component is too old to reach other windows');
			const listed = resultOf(await s.call(stranger, 'list_agents'));
			assert.deepStrictEqual([listed.status, listed.data.complete, listed.data.unavailable_windows.map((each: { window_id: string; reason: string }) => [each.window_id, each.reason]), listed.data.counts.known_windows],
				['success', false, [['*', 'protocol_incompatible']], 1]);
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '@worker', text: 'Hello' })).error?.reason, 'window_unavailable');
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: worker.alias, text: 'Hello' })).status, 'success');
		});

		test('an unreadable directory preserves local facts and explicitly marks unknown windows', async () => {
			const { lead } = team(s);
			network.directoryError = new Error('No window directory');
			const result = resultOf(await s.call(lead, 'list_agents'));
			assert.strictEqual(result.data.windows[0].window_id, 'win-1');
			assert.ok(result.data.windows[0].clis.length);
			assert.strictEqual(result.data.complete, false);
			assert.deepStrictEqual(result.data.unavailable_windows.map((each: { window_id: string }) => each.window_id), ['*']);
			assert.strictEqual(network.routed.length, 0);
		});

		test('a selected remote location is queried at its owner without guessing local CLIs', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend');
			network.respond = () => ({ ok: true, result: { result: success({ windows: [remoteSnapshot('win-2').window], agents: [], complete: true }) } });
			const result = resultOf(await s.call(lead, 'list_agents', { window_id: 'win-2', location_id: 'loc-9' }));
			assert.strictEqual(result.data.windows.length, 1);
			assert.strictEqual(result.data.windows[0].window_id, 'win-2');
			assert.strictEqual(network.routed[0].args.arguments.location_id, 'loc-9');
			assert.strictEqual(network.routed[0].args.caller.id, lead.id);
			assert.strictEqual(network.routed[0].op, 'call');
		});
	});

	test('selected remote locations preserve known absence and cursor errors through the actual destination contract', async () => {
		const { lead } = team(s);
		const other = setUp();
		try {
			other.deps.window = { id: 'win-2', label: 'Backend', environment: 'local' };
			const remote = createToolServices(other.deps);
			network.window(2, 'Backend');
			network.respond = async route => ({ ok: true, result: await remote.serve({ from: 'win-1', op: route.op, args: route.args, deadlineMs: route.deadlineMs }) });
			const absent = resultOf(await s.call(lead, 'list_agents', { window_id: 'win-2', location_id: 'gone' }));
			assert.deepStrictEqual([absent.error?.code, absent.error?.reason, absent.effects.outcome], ['NOT_FOUND', 'not_found', 'none']);
			const invalid = resultOf(await s.call(lead, 'list_agents', { window_id: 'win-2', cursor: 'bad' }));
			assert.strictEqual(invalid.error?.reason, 'invalid_argument');
			const first = resultOf(await s.call(lead, 'list_agents', { window_id: 'win-2', limit: 1 }));
			const next = resultOf(await s.call(lead, 'list_agents', { window_id: 'win-2', limit: 1, cursor: first.data.next_cursor }));
			assert.deepStrictEqual([...first.data.windows[0].locations, ...next.data.windows[0].locations].map(each => each.location_id), ['loc-1', 'loc-wt']);
			assert.deepStrictEqual(next.data.agents, []);
		} finally { other.dispose(); }
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
			network.respond = () => ({ ok: true, result: remoteSnapshot('win-2', [late, early]) });
			const first = resultOf(await s.call(stranger, 'list_agents', { limit: 2 }));
			assert.deepStrictEqual(first.data.agents.map((each: { agent_id: string }) => each.agent_id), ['#a20', '#a1']);
			assert.deepStrictEqual([first.data.complete, first.data.unavailable_windows], [true, []]);
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.args, each.deadlineMs]), [
				['win-2', 'agents', { caller: { id: stranger.id, alias: '#a4', name: 'stranger', root: stranger.id, yolo: true, window: 'win-1', windowLabel: 'Design' }, details: false }, 9_993]
			]);
			const second = resultOf(await s.call(stranger, 'list_agents', { limit: 2, cursor: first.data.next_cursor }));
			assert.deepStrictEqual(second.data.agents.map((each: { agent_id: string }) => each.agent_id), ['#a2', '#a3']);
			const third = resultOf(await s.call(stranger, 'list_agents', { limit: 2, cursor: second.data.next_cursor }));
			assert.deepStrictEqual([third.data.agents.map((each: { agent_id: string }) => each.agent_id), third.data.next_cursor], [['#a4', '#a21'], undefined]);
		});

		test('one window named lists that window alone: this one asks nobody, another is asked alone, one that is not open is not found', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend');
			network.window(3, 'Docs');
			network.respond = route => ({ ok: true, result: { result: success({ windows: [remoteSnapshot(route.window).window], agents: [{ agent_id: runId(10 * Number(route.window.slice(4))), window_id: route.window, alias: `#a${route.window.slice(4)}0`, created_at: new Date(0).toISOString() }] }) } });
			const here = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-1' }));
			assert.deepStrictEqual([here.data.agents.map((each: { agent_id: string }) => each.agent_id), network.routed.length], [['#a1', '#a2', '#a3', '#a4'], 0]);
			const there = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-3' }));
			assert.deepStrictEqual([there.data.agents.map((each: { agent_id: string }) => each.agent_id), network.routed.map(each => each.window)], [['#a30'], ['win-3']]);
			const missing = resultOf(await s.call(stranger, 'list_agents', { window_id: 'win-9' }));
			assert.deepStrictEqual([missing.error?.code, missing.error?.reason], ['NOT_FOUND', 'not_found']);
		});

		test('a window that does not answer is listed apart and the list is not complete; this window\'s agents are still listed', async () => {
			const { lead } = team(s);
			network.window(2, 'Backend');
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'The Facade window win-2 did not answer within 9.9 seconds.', effects: 'unknown' });
			const result = resultOf(await s.call(lead, 'list_agents', {}));
			assert.deepStrictEqual(result.data.agents.map((each: { agent_id: string }) => each.agent_id), ['#a1', '#a2', '#a3']);
			assert.deepStrictEqual([result.data.complete, result.data.unavailable_windows], [false, [{ window_id: 'win-2', label: 'Backend', reason: 'timeout', message: 'The Facade window win-2 did not answer within 9.9 seconds.' }]]);
		});
	});

	suite('stop, screen and input for another window\'s agent', () => {

		const STOPPED = success({ agent_id: runId(20), reference: '@builder #a20', process_state: 'terminated' }, { outcome: 'confirmed', agent_id: runId(20) });

		test('a name or exact #aN routes the full run ID, and the caller projects the returned facts', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder', cli: 'codex' })]);
			network.respond = () => ({ ok: true, result: { result: STOPPED, headline: 'Closed @builder #a20 and ended its process.' } });
			for (const reference of ['@builder', 'builder', '#a20', runId(20), 'builder #a20']) {
				const answer = await s.call(stranger, 'stop_agent', { agent: reference });
				assert.deepStrictEqual([resultOf(answer).status, resultOf(answer).data.agent_id, resultOf(answer).data.process_state], ['success', '#a20', 'terminated'], reference);
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
			const text = '[[' + 'x'.repeat(MESSAGE_LIMIT + 1) + ']]';
			const frame = 'the last full-screen frame';
			network.respond = () => ({
				ok: true, result: {
					result: success({ agent_id: runId(20), window_id: 'win-2', buffer: 'normal', text_format: 'facade-styled', line_count: 1, text, last_alternate_frame: { captured_at: '2026-10-28T21:00:00.000Z', line_count: 1, text: frame } }),
					headline: 'The screen of @builder #a20, captured 2026-10-28T22:00:00.000Z: 1 line of its normal buffer.'
				}
			});
			const answer = await s.call(stranger, 'read_screen', { agent: '@builder' });
			const result = resultOf(answer);
			assert.strictEqual(s.written.length, 1);
			const stored = JSON.parse(s.written[0].text);
			assert.deepStrictEqual([stored.text, stored.text_format, stored.last_alternate_frame.text], [text, 'facade-styled', frame]);
			assert.deepStrictEqual(result.data.file, { path: `${s.deps.home}/results/screen-1.txt`, size: Buffer.byteLength(s.written[0].text), code_points: [...s.written[0].text].length, format: 'json' });
			assert.strictEqual(result.data.last_alternate_frame, undefined);

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
			assert.deepStrictEqual(replies.map(answer => [resultOf(answer).data.message_id, resultOf(answer).data.target]), [['#m1', '#a20'], ['#m1', '#a20']]);
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

		test('its request ID goes with it to the window it is delivered in, and the copy kept here keeps it too (RULES-1.1, RULES-1.5)', async () => {
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
			// Its answer comes within the two seconds: that window is given them less the 7 ms spent here and half a second for the way back (RULES-1.2)
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs]), [['win-2', 'deliver', 1_993]]);
			assert.deepStrictEqual(network.routed[0].args, {
				id: 'm-1', from: { id: stranger.id, alias: '#a4', name: 'stranger', root: stranger.id, yolo: true, window: 'win-1', windowLabel: 'Design' },
				to: runId(20), text: 'Please check the build.', callId: 'call-1', elapsedMs: 507
			});
			assert.deepStrictEqual([result.status, result.data, result.effects], ['success', {
				message_id: '#m1', target: '#a20', window_id: 'win-2', disposition: 'submitted_to_cli'
			}, { outcome: 'confirmed', text_written: 'full', enter_written: true }]);
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
			assert.deepStrictEqual([later.status, later.data.deadline, later.data.obstacle, later.data.reply_to, later.effects.outcome], ['accepted', '2026-10-28T22:00:15.000Z', 'input_draft', earlier.alias, 'pending']);
			assert.strictEqual(network.routed[0].args.replyTo, earlier.id);
			const failed: MessageRecord['delivery'] = { status: 'failure', reason: 'unsupported', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 0 };
			network.respond = route => ({ ok: true, result: { status: 'failure', reason: 'unsupported', record: recordOf(route.args.id, stranger.id, runId(20), failed) } });
			const refused = resultOf(await s.call(stranger, 'send_message', { to: '#a20', text: 'Hi' }));
			assert.deepStrictEqual([refused.error?.code, refused.error?.reason, refused.effects.outcome], ['UNAVAILABLE', 'unsupported', 'none']);
			assert.deepStrictEqual(s.messages.kept.map(each => [each.id, each.delivery.status]), [['m-2', 'pending'], ['m-3', 'failure']]);
		});

		test('a route that never reached the other window had no effect and keeps no copy; one that may have - or an unreadable answer - is unknown, kept so (MCP-1.2)', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })], 'ssh-remote+box');
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'No open Facade window win-2 is on this computer: the request had no effect.', effects: 'none' });
			const none = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([none.error?.code, none.error?.reason, none.effects], ['UNAVAILABLE', 'window_unavailable', { outcome: 'none', text_written: 'none', enter_written: false }]);
			network.respond = () => ({ ok: false, reason: 'protocol_incompatible', message: 'The Facade window win-2 runs another version.', effects: 'none' });
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' })).error?.reason, 'protocol_incompatible');
			assert.strictEqual(s.messages.kept.length, 0);
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'The Facade window win-2 did not answer within 3 seconds.', effects: 'unknown' });
			const unknown = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi', request_id: 'ask-1' }));
			assert.deepStrictEqual([unknown.data.message_id, unknown.error?.reason, unknown.effects], ['#m3', 'timeout', { outcome: 'unknown', text_written: 'unknown', enter_written: null }]);
			network.respond = () => ({ ok: true, result: { status: 'delivered' } });
			const unreadable = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([unreadable.error?.code, unreadable.error?.reason, unreadable.effects.outcome], ['FAILED', 'invalid_response', 'unknown']);
			// What may have gone in there is kept here, its outcome not known: a retry asks that window, as its history shows it
			assert.deepStrictEqual(s.messages.kept.map(copy => [copy.id, copy.window, copy.environment, copy.fromWindow, copy.to.run, copy.requestId, copy.delivery.status, copy.delivery.effects]), [
				['m-3', 'win-2', 'ssh-remote+box', 'win-1', runId(20), 'ask-1', 'pending', { outcome: 'unknown', text_written: 'unknown', enter_written: null }],
				['m-4', 'win-2', 'ssh-remote+box', 'win-1', runId(20), undefined, 'pending', { outcome: 'unknown', text_written: 'unknown', enter_written: null }]
			]);
		});

		test('a retry whose message another window holds asks that window how it stands - after a lost reply or a lost result - and never sends it anywhere else (MCP-1.1)', async () => {
			const { stranger } = team(s);
			const NOW = Date.UTC(2026, 9, 28, 22, 0, 0);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			const pending: MessageRecord['delivery'] = { status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false }, deadline: Date.UTC(2026, 9, 28, 22, 10, 0), attempts: 1 };
			network.respond = route => ({ ok: true, result: { status: 'accepted', obstacle: 'input_draft', record: { ...recordOf(route.args.id, stranger.id, runId(20), pending), at: NOW, requestId: route.args.requestId } } });
			const args = { to: '@builder', text: 'Please check the build.', request_id: 'ask-2' };
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', args)).status, 'accepted');
			// Its result never came back; long after its deadline, the window that holds it answers how it went, with its ID
			network.respond = route => ({ ok: true, result: { status: 'success', record: { ...recordOf(route.args.id, stranger.id, runId(20), DELIVERED), at: NOW, requestId: route.args.requestId } } });
			const again = await s.call(stranger, 'send_message', args);
			const asked = resultOf(again);
			assert.deepStrictEqual([asked.status, asked.data.message_id, asked.data.repeated, asked.data.window_id], ['success', '#m1', true, 'win-2']);
			assert.deepStrictEqual(network.routed.map(route => [route.window, route.op, route.args.id, route.args.to, route.args.requestId]), [['win-2', 'deliver', 'm-1', runId(20), 'ask-2'], ['win-2', 'deliver', 'm-1', runId(20), 'ask-2']]);
			assert.deepStrictEqual(s.messages.allocated, ['m-1']);
			// Once known, the copy answers: nothing is routed
			assert.strictEqual(resultOf(await s.call(stranger, 'send_message', args)).status, 'success');
			assert.strictEqual(network.routed.length, 2);
			// A window that cannot be asked leaves it unknown - never "still being delivered" past its deadline
			network.respond = route => ({ ok: true, result: { status: 'accepted', record: { ...recordOf(route.args.id, stranger.id, runId(20), pending), at: NOW, requestId: route.args.requestId } } });
			await s.call(stranger, 'send_message', { ...args, request_id: 'ask-3' });
			network.respond = () => ({ ok: false, reason: 'window_unavailable', message: 'No open Facade window win-2 is on this computer: the request had no effect.', effects: 'none' });
			const gone = resultOf(await s.call(stranger, 'send_message', { ...args, request_id: 'ask-3' }));
			assert.deepStrictEqual([gone.status, gone.error?.reason, gone.data.message_id, gone.data.repeated, gone.effects.outcome], ['failure', 'window_unavailable', '#m2', true, 'unknown']);
		});

		test('a delivery the other window refuses before recording it - its agent gone - is not found, with no effect on this attempt; an earlier lost reply stays unknown (MCP-1.2)', async () => {
			const { stranger } = team(s);
			network.window(2, 'Backend', [remoteAgent(20, { name: 'builder' })]);
			const refusal = { status: 'failure', error: { code: 'NOT_FOUND', reason: 'not_found', message: `No agent ${runId(20)} that the sender reaches is in this window.` } };
			network.respond = () => ({ ok: true, result: refusal });
			const refused = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi' }));
			assert.deepStrictEqual([refused.error?.code, refused.error?.reason, refused.effects], ['NOT_FOUND', 'not_found', { outcome: 'none', text_written: 'none', enter_written: false }]);
			assert.strictEqual(s.messages.kept.length, 0);
			// The target vanished after a lost reply. This does not prove what happened to the earlier delivery.
			network.respond = () => ({ ok: false, reason: 'timeout', message: 'The Facade window win-2 did not answer within 3 seconds.', effects: 'unknown' });
			await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi', request_id: 'ask-4' });
			network.respond = () => ({ ok: true, result: refusal });
			const settled = resultOf(await s.call(stranger, 'send_message', { to: '@builder', text: 'Hi', request_id: 'ask-4' }));
			assert.deepStrictEqual([settled.error?.reason, settled.data.repeated, settled.effects.outcome], ['not_found', true, 'unknown']);
			assert.strictEqual(s.messages.kept.at(-1)?.delivery.effects.outcome, 'unknown');
			assert.strictEqual(s.messages.allocated.length, 2, 'the retry never allocates another message');
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

		test('missing, older and future routed tool protocols fail before launching', async () => {
			for (const protocol of [undefined, 2, 3, TOOL_PROTOCOL + 1]) {
				const reply = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: {
					protocol, tool: 'start_agent', arguments: { name: 'child', window_id: 'win-1', location_id: 'loc-1', cli: 'claude' },
					caller: guestOf(30), callId: 'wrong-version', elapsedMs: 0
				} }) as { result: { error: { reason: string }; effects: unknown } };
				assert.deepStrictEqual([reply.result.error.reason, reply.result.effects], ['protocol_incompatible', { outcome: 'none' }]);
			}
			assert.deepStrictEqual(s.agents.launched, []);
		});

		test('a routed start runs here for the guest: its child joins the guest\'s tree, names its creator, and its prompt is the guest\'s message', async () => {
			const guest = guestOf(30, { name: 'planner', root: runId(29), yolo: true, window: 'win-forged' });
			const served = await services.serve({
				from: 'win-2', op: 'call', deadlineMs: 130_000,
				args: { protocol: TOOL_PROTOCOL, tool: 'start_agent', arguments: { name: 'child', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', prompt: 'Build the API.\nThen test it.' }, caller: guest, callId: 'c-9', elapsedMs: 5 }
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
				args: { protocol: TOOL_PROTOCOL, tool: 'start_agent', arguments: { name: 'child', window_id: 'win-1', location_id: 'loc-1', cli: 'claude' }, caller: guest, callId: 'c-10', elapsedMs: 0 }
			}) as { result: { status: string; data: { agent_id: string; result_message_id: string } } };
			assert.strictEqual(served.result.status, 'accepted');
			assert.match(served.result.data.result_message_id, /^m-\d+$/);
			assert.deepStrictEqual(s.messages.records, [], 'a reservation is not a fake inbox item in either window');
			const child = served.result.data.agent_id;
			s.agents.settle(child, { state: 'running' });
			await waitFor(() => network.routed.length > 0);
			assert.strictEqual(network.routed[0].args.id, served.result.data.result_message_id);
			assert.deepStrictEqual(network.routed[0].args.operation, { tool: 'start_agent', window: 'win-1' });
			assert.deepStrictEqual(network.routed.map(each => [each.window, each.op, each.deadlineMs, each.args.to, each.args.callId, each.args.agent]), [['win-2', 'result', 15_000, runId(30), 'c-10', { run: child, alias: s.agents.get(child)!.alias, name: 'child' }]]);
			assert.match(network.routed[0].args.text, /^Started @child #a\d+ \(run-[0-9a-f]+\) with claude/);
			assert.deepStrictEqual(s.messages.reports, []);
		});

		test('a guest\'s call is validated and resolved here like any other: a start for another window is not found, its own reach applies', async () => {
			const { lead } = team(s);
			const outsider = guestOf(30);
			const elsewhere = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { protocol: TOOL_PROTOCOL, tool: 'start_agent', arguments: { name: 'child', window_id: 'win-5', location_id: 'loc-1', cli: 'claude' }, caller: outsider, callId: 'c-1', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([elsewhere.result.status, elsewhere.result.error.reason], ['failure', 'not_found']);
			const outOfTree = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { protocol: TOOL_PROTOCOL, tool: 'stop_agent', arguments: { agent: lead.id }, caller: outsider, callId: 'c-2', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([outOfTree.result.status, outOfTree.result.error.reason], ['failure', 'out_of_tree']);
			const invalid = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { protocol: TOOL_PROTOCOL, tool: 'stop_agent', arguments: {}, caller: outsider, callId: 'c-3', elapsedMs: 0 } }) as { result: { status: string; error: { reason: string } } };
			assert.deepStrictEqual([invalid.result.status, invalid.result.error.reason], ['failure', 'missing_argument']);
			assert.deepStrictEqual([s.agents.launched, s.agents.closed, network.routed], [[], [], []]);
			// One in its tree is stopped here
			const member = guestOf(30, { root: lead.id });
			const stopped = await services.serve({ from: 'win-2', op: 'call', deadlineMs: 130_000, args: { protocol: TOOL_PROTOCOL, tool: 'stop_agent', arguments: { agent: lead.id }, caller: member, callId: 'c-4', elapsedMs: 0 } }) as { result: { status: string } };
			assert.deepStrictEqual([stopped.result.status, s.agents.closed], ['success', [lead.id]]);
			await assert.rejects(services.serve({ from: 'win-2', op: 'call', deadlineMs: 1_000, args: { protocol: TOOL_PROTOCOL, tool: 'stop_agent', arguments: {}, callId: 'c-5', elapsedMs: 0 } }), /incomplete/);
		});

		test('a delivered message is sent here as the guest\'s, under its own ID and header label, to an agent the guest reaches alone', async () => {
			const { lead, stranger } = team(s);
			const reaching = guestOf(30, { yolo: true });
			s.messages.respond = () => ({ status: 'accepted', obstacle: 'input_draft' });
			const answered = await services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-77', from: reaching, to: stranger.id, text: 'Hi there', replyTo: 'm-70', callId: 'c-1', requestId: 'ask-9', elapsedMs: 900 } }) as { status: string; obstacle: string; record: MessageRecord };
			assert.deepStrictEqual([answered.status, answered.obstacle, answered.record.id], ['accepted', 'input_draft', 'm-77']);
			// Its request ID kept with it here, where its record is made, for the sender's retry to find (RULES-1.1, RULES-1.5)
			assert.deepStrictEqual(s.messages.sent, [{ id: 'm-77', from: runId(30), sender: { party: { run: runId(30), alias: '#a30', name: 'guest 30' }, window: 'win-2', label: 'Backend' }, to: stranger.id, text: 'Hi there', replyTo: 'm-70', elapsedMs: 900, callId: 'c-1', requestId: 'ask-9' }]);
			// Out of a non-YOLO guest's tree: not found, nothing sent
			// Refused before anything is recorded, as a refusal its sender can tell from a lost answer (MCP-1.2)
			for (const [id, from, to] of [['m-78', guestOf(31), lead.id], ['m-79', reaching, runId(99)]] as const) {
				assert.deepStrictEqual(await services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id, from, to, text: 'Hi', elapsedMs: 0 } }),
					{ status: 'failure', error: { code: 'NOT_FOUND', reason: 'not_found', message: `No agent ${to} that the sender reaches is in this window.` } });
			}
			await assert.rejects(services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-80', to: stranger.id, text: 'Hi', elapsedMs: 0 } }), /incomplete/);
			// Without the time it has spent, its budget could not be held: refused as incomplete, never delivered without a deadline (RULES-1.2)
			for (const elapsedMs of [undefined, Number.NaN, '900']) {
				await assert.rejects(services.serve({ from: 'win-2', op: 'deliver', deadlineMs: 3_000, args: { id: 'm-81', from: reaching, to: stranger.id, text: 'Hi', elapsedMs } }), /incomplete/, String(elapsedMs));
			}
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

		test('a routed operation keeps its execution window and original call through the receiving inbox', async () => {
			const { lead } = team(s);
			const agent = { run: runId(20), alias: '#a20', name: 'closed target' };
			const operation = { tool: 'stop_agent', window: 'win-2' };
			await services.serve({ from: 'win-2', op: 'result', deadlineMs: 15000, args: { id: 'm-42', to: lead.id, text: 'It has stopped.', callId: 'stop-original', operation, agent, result: { status: 'success', data: {}, effects: { outcome: 'confirmed' } } } });
			const receipt = resultOf(await s.call(lead, 'read_messages', { ids: ['#m42'] })).data.messages[0];
			assert.deepStrictEqual([receipt.message_id, receipt.call_id, receipt.agent, receipt.operation], ['#m42', 'stop-original', '#a20', operation]);
			await assert.rejects(services.serve({ from: 'win-2', op: 'result', deadlineMs: 15000, args: { to: lead.id, text: 'Unreadable', operation: { tool: 'guessed', window: 'win-2' } } }), /invalid operation/);
			assert.strictEqual(s.messages.records.length, 1);
		});

		test('this window\'s agents and window facts as other windows ask for them: within the guest\'s reach, ended ones on request', async () => {
			const { lead } = team(s);
			s.agents.add(runFacts(6, { name: 'gone', root: lead.id, lifecycle: 'ended' }));
			const inTree = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { root: lead.id }) } }) as { agents: { alias: string; window_id: string; created_at: string }[] };
			assert.deepStrictEqual(inTree.agents.map(each => each.alias), ['#a1', '#a2', '#a3']);
			assert.deepStrictEqual([inTree.agents[0].window_id, inTree.agents[0].created_at], ['win-1', new Date(1001).toISOString()]);
			const withEnded = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { root: lead.id }), agent: runId(6) } }) as { agents: { alias: string }[] };
			assert.deepStrictEqual(withEnded.agents.map(each => each.alias), ['#a6']);
			const yolo = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: { caller: guestOf(30, { yolo: true }) } }) as { agents: { alias: string }[] };
			assert.deepStrictEqual(yolo.agents.map(each => each.alias), ['#a1', '#a2', '#a3', '#a4']);
			await assert.rejects(services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9_000, args: {} }), /names no caller/);
			// A folderless window is still in the topology, with no invented destination.
			s.locations = [];
			const empty = await services.serve({ from: 'win-2', op: 'agents', deadlineMs: 9000, args: { caller: guestOf(30) } }) as { window: { locations: unknown[]; clis: unknown[] }; agents: unknown[] };
			assert.deepStrictEqual([empty.window.locations, empty.window.clis, empty.agents], [[], [], []]);
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
