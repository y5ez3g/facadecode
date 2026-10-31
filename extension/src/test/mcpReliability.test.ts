/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createToolServices } from '../contract/tools';
import type { InputPort, MessageRecord } from '../core/messagePorts';
import { MessageService, MessageStore } from '../core/messages';
import { OrdinaryInput } from '../host/input';
import { settled, sleep, useFakeClock } from './clock';
import { FakeNetwork, remoteAgent, resultOf, runFacts, Setup, setUp } from './contractFakes';

const CONFIRMED = { outcome: 'confirmed', text_written: 'full', enter_written: true } as const;

/** Real delivery and tool services; only terminal observations, processes and transport are substitutes. */
function delivery(s: Setup, input?: InputPort) {
	const records = new Map<string, MessageRecord>();
	const copies = new Map<string, MessageRecord>();
	const pastes: string[] = [];
	const store = (items: Map<string, MessageRecord>): MessageStore => ({
		list: () => [...items.values()],
		create: record => { assert.ok(!items.has(record.id)); items.set(record.id, record); },
		put: record => { items.set(record.id, record); }
	});
	let next = 0;
	const service = new MessageService({
		agents: { get: id => s.agents.get(id), onDidChange: () => ({ dispose() { } }) },
		input: input ?? {
			capability: () => ({ state: 'supported', reason: 'test terminal' }),
			inspect: async () => 'usable',
			submit: async (_run, text) => { pastes.push(text); return { effects: CONFIRMED, shown: true, draft: text }; },
			enter: async () => CONFIRMED
		},
		human: { contact: () => true }, store: store(records), sent: store(copies), ids: { next: () => ++next },
		clock: { now: () => Date.now() }, window: s.deps.window, environment: 'test', workspace: 'review', log: { event() { } }
	});
	s.deps.messages = service;
	s.deps.clock = { now: () => Date.now() };
	return { service, records, copies, pastes };
}

suite('MCP reliability: retries through the real delivery service', () => {
	test('concurrent starts with one request ID accept only one run, also while discovery waits', async () => {
		const s = setUp();
		try {
			const lead = runFacts(1);
			s.agents.add(lead);
			s.deps.clock = { now: () => 5000 };
			const args = { name: 'worker', window_id: 'win-1', location_id: 'loc-1', cli: 'claude', request_id: 'start-once' };
			const answers = await Promise.all([s.call(lead, 'start_agent', args), s.call(lead, 'start_agent', args)]);
			assert.strictEqual(s.agents.launched.length, 1);
			assert.strictEqual(resultOf(answers[0]).data.agent_id, resultOf(answers[1]).data.agent_id);
		} finally {
			s.dispose();
		}
	});

	test('concurrent sends with one request ID allocate and paste one message', async () => {
		const s = setUp();
		const m = delivery(s);
		try {
			const lead = runFacts(1), worker = runFacts(2, { root: lead.id });
			s.agents.add(lead, worker);
			const args = { to: worker.id, text: 'Do this once.', request_id: 'send-once' };
			const answers = await Promise.all([s.call(lead, 'send_message', args), s.call(lead, 'send_message', args)]);
			assert.strictEqual(resultOf(answers[0]).data.message_id, resultOf(answers[1]).data.message_id);
			assert.strictEqual(m.records.size, 1);
			assert.strictEqual(m.pastes.length, 1);
		} finally {
			m.service.dispose();
			s.dispose();
		}
	});

	test('a lost cross-window reply, followed by retry and loss of the sender copy, never repastes and returns the original ID', async () => {
		const a = setUp(), b = setUp();
		b.deps.window = { id: 'win-2', label: 'Receiver', environment: 'test' };
		const ma = delivery(a), mb = delivery(b);
		try {
			const lead = runFacts(1, { yolo: true }), worker = runFacts(20);
			a.agents.add(lead);
			b.agents.add(worker);
			const network = new FakeNetwork();
			network.window(2, 'Receiver', [remoteAgent(20)]);
			a.deps.network = network;
			const receiver = createToolServices(b.deps);
			let routes = 0;
			network.respond = async route => {
				const result = await receiver.serve({ from: 'win-1', op: route.op, args: route.args, deadlineMs: route.deadlineMs });
				return ++routes === 1
					? { ok: false, reason: 'timeout', effects: 'unknown', message: 'Reply lost after delivery.' }
					: { ok: true, result };
			};
			// The schema counts Unicode code points, including on a routed retry; 200 emoji are a valid key, not 400 characters.
			const args = { to: worker.id, text: 'Do this once.', request_id: '🔁'.repeat(200) };
			const first = await a.call(lead, 'send_message', args);
			assert.strictEqual(resultOf(first).effects.outcome, 'unknown');
			assert.match(first.text, /whether it was delivered is not known/);
			const retry = resultOf(await a.call(lead, 'send_message', args));
			assert.deepStrictEqual([retry.status, retry.data.message_id, mb.pastes.length], ['success', 'm-1', 1]);
			assert.strictEqual(ma.copies.get('m-1')?.requestId, args.request_id);
			// The recipient has closed since then; the recorded request still answers, even if the sender lost its local copy.
			b.agents.runs.delete(worker.id);
			ma.copies.clear();
			const again = resultOf(await a.call(lead, 'send_message', args));
			assert.deepStrictEqual([again.status, again.data.message_id, mb.pastes.length], ['success', 'm-1', 1]);
		} finally {
			ma.service.dispose(); mb.service.dispose(); a.dispose(); b.dispose();
		}
	});
});

suite('MCP reliability: read delivery and an already pasted draft', () => {
	useFakeClock();

	for (const edited of [false, true]) {
		test(`read_messages delivers immediately; ${edited ? 'a person\'s edit is left untouched' : 'the owned draft finishes and the next message succeeds'}`, async () => {
			const s = setUp();
			const lead = runFacts(1);
			const worker = runFacts(2, { root: lead.id, inputAdapter: 'pi-frame', inputCapability: { state: 'supported', reason: 'test terminal' } });
			s.agents.add(lead, worker);
			let buffer = '', visible = false, pastes = 0, enters = 0;
			const input = new OrdinaryInput({
				get: id => s.agents.get(id),
				inspectInput: async () => buffer ? visible ? { state: 'draft', draft: buffer, evidence: 'drawn' } : { state: 'unknown', evidence: 'not drawn yet' } : { state: 'usable', evidence: 'empty' },
				typeText: async (_run, text) => { buffer = text; pastes++; return { outcome: 'applied', pasted: true, entered: false }; },
				pressKeys: async () => { buffer = ''; enters++; return { outcome: 'applied', keysSent: 1 }; }
			});
			const m = delivery(s, input);
			try {
				const sending = m.service.send({ from: lead.id, to: worker.id, text: 'First message', elapsedMs: 0 });
				await sleep(10);
				assert.strictEqual(pastes, 1);
				const at = Date.now();
				m.service.markDelivered(worker.id, ['m-1']);
				assert.strictEqual(m.service.inbox(worker.id, { limit: 10 }).records.length, 0);
				const read = await settled(sending);
				assert.deepStrictEqual([read.status, read.record.delivery.via, read.record.delivery.deliveredAt], ['success', 'read', at]);
				assert.strictEqual(read.record.delivery.effects.outcome, 'unknown', 'a read cannot claim that the still-pending input wrote nothing');
				assert.strictEqual(enters, 0);
				if (edited) {
					buffer += ' my additional instruction';
				}
				visible = true;
				await sleep(5000);
				if (edited) {
					assert.strictEqual(enters, 0);
					assert.ok(buffer.endsWith(' my additional instruction'));
				} else {
					assert.strictEqual(enters, 1);
					const next = await settled(m.service.send({ from: lead.id, to: worker.id, text: 'Second message', elapsedMs: 0 }));
					assert.deepStrictEqual([next.status, pastes, enters, buffer], ['success', 2, 2, '']);
				}
				assert.strictEqual(m.records.get('m-1')?.delivery.via, 'read');
			} finally {
				m.service.dispose(); s.dispose();
			}
		});
	}

	test('a read while submission waits behind direct input cancels its unstarted paste', async () => {
		const s = setUp(), worker = runFacts(2, { inputAdapter: 'pi-frame', inputCapability: { state: 'supported', reason: 'test terminal' } });
		s.agents.add(worker);
		let pastes = 0, release!: () => void;
		const input = new OrdinaryInput({ get: id => s.agents.get(id), inspectInput: async () => ({ state: 'usable', evidence: 'empty' }),
			typeText: async () => { pastes++; return { outcome: 'applied' }; }, pressKeys: async () => ({ outcome: 'applied' }) });
		void input.inTurn(worker.id, () => new Promise<void>(resolve => { release = resolve; }));
		const m = delivery(s, input);
		try {
			const sending = m.service.send({ from: worker.id, to: worker.id, text: 'Queued message', elapsedMs: 0 });
			await sleep(10);
			m.service.markDelivered(worker.id, ['m-1']);
			assert.strictEqual((await settled(sending)).status, 'success');
			release();
			await sleep(5000);
			assert.strictEqual(pastes, 0);
		} finally {
			m.service.dispose(); s.dispose();
		}
	});
});
