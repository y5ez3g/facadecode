/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MessageService, ResultRoute } from '../core/messages';
import type { InputEffects, InputPort, MessageRecord, Submission } from '../core/messagePorts';
import type { CapabilityState, Disposable, Event, RunChange, RunFacts, RunId } from '../core/ports';
import { settled, sleep, useFakeClock } from './clock';

type InputState = Awaited<ReturnType<InputPort['inspect']>>;

const CONFIRMED: InputEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };

/** A run's input as the test scripts it: the states each inspection takes in turn, the last one kept. */
class FakeInput implements InputPort {
	readonly states = new Map<RunId, InputState[]>();
	readonly submitted: { readonly run: RunId; readonly text: string }[] = [];

	capability(): CapabilityState {
		return { state: 'supported', reason: 'its reader knows its layout' };
	}

	async inspect(run: RunId): Promise<InputState> {
		const script = this.states.get(run);
		return !script?.length ? 'usable' : script.length > 1 ? script.shift()! : script[0];
	}

	async submit(run: RunId, text: string): Promise<Submission> {
		this.submitted.push({ run, text });
		return { effects: CONFIRMED, shown: true };
	}

	async enter(): Promise<InputEffects> {
		return CONFIRMED;
	}
}

const A = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** An agent of another window: this window does not hold it. */
const GUEST = 'run-99999999999999999999999999999999';
const SENDER = { party: { run: GUEST, alias: '#a9', name: 'Gus' }, window: 'win-2', label: 'Backend' };

/** A store as a test keeps it: by ID, listed oldest first. */
function store(): { readonly records: Map<string, MessageRecord>; list(): readonly MessageRecord[]; create(record: MessageRecord): void; put(record: MessageRecord): void } {
	const records = new Map<string, MessageRecord>();
	return {
		records,
		list: () => [...records.values()].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2))),
		create: record => {
			if (records.has(record.id)) {
				throw new Error(`A message ${record.id} is kept already.`);
			}
			records.set(record.id, record);
		},
		put: record => void records.set(record.id, record)
	};
}

function setUp(options: { readonly results?: ResultRoute | false; readonly sent?: boolean } = {}) {
	const runs = new Map<RunId, RunFacts>([
		[A, { id: A, alias: '#a1', name: 'Ada', displayName: 'Claude Code', version: '2.1.314', lifecycle: 'running' } as RunFacts],
		[B, { id: B, alias: '#a2', name: 'Bob', displayName: 'Codex', version: '0.166.0', lifecycle: 'running' } as RunFacts]
	]);
	const listeners = new Set<(change: RunChange) => void>();
	const onDidChange: Event<RunChange> = listener => {
		listeners.add(listener);
		return { dispose: () => listeners.delete(listener) } as Disposable;
	};
	const input = new FakeInput();
	const reported: { readonly window: string; readonly result: Parameters<ResultRoute['report']>[1] }[] = [];
	const results: ResultRoute = options.results === false ? undefined as never : options.results ?? {
		report: async (window, result) => {
			reported.push({ window, result });
			return true;
		}
	};
	const messages = store();
	const copies = store();
	const log: string[] = [];
	const recorded: MessageRecord[] = [];
	let n = 0;
	const service = new MessageService({
		agents: { get: run => runs.get(run), onDidChange },
		input,
		human: { contact: () => true },
		store: messages,
		...options.sent === false ? {} : { sent: copies },
		...options.results === false ? {} : { results },
		ids: { next: () => ++n },
		clock: { now: () => Date.now() },
		monotonic: () => performance.now(),
		window: { id: 'win-1', label: 'Design' },
		environment: 'local',
		workspace: 'ws-1',
		log: { event: text => log.push(text) }
	});
	service.onDidRecord(record => recorded.push(record));
	return { service, runs, input, reported, messages, copies, log, recorded };
}

suite('Agent messages between windows (RULES-1.7, COLLABORATION-1.1, 2.1, 3.2)', () => {
	useFakeClock();

	test('a message from another window\'s agent keeps that window, and its header names the sender\'s window', async () => {
		const { service, input } = setUp();
		const result = await settled(service.send({ id: 'm-50', from: GUEST, sender: SENDER, to: B, text: 'Ship it.', elapsedMs: 0, callId: 'c-1' }));
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual([result.record.id, result.record.from, result.record.fromWindow, result.record.window], ['m-50', SENDER.party, 'win-2', 'win-1']);
		assert.deepStrictEqual(input.submitted, [{ run: B, text: '[Facade message #m50 | from @Gus #a9 | window Backend]\nShip it.\n[/Facade message #m50]' }]);
	});

	test('its accepted outcome goes back to the sender\'s window as a result about it - never into this window', async () => {
		const { service, input, reported, messages } = setUp();
		input.states.set(B, ['draft', 'usable']);
		const result = await settled(service.send({ id: 'm-50', from: GUEST, sender: SENDER, to: B, text: 'Ship it.', elapsedMs: 0, callId: 'c-1' }));
		assert.strictEqual(result.status, 'accepted');
		await sleep(15_000);
		assert.strictEqual(reported.length, 1);
		const [{ window, result: report }] = reported;
		assert.deepStrictEqual([window, report.to, report.callId, report.about.id, report.about.delivery.status], ['win-2', GUEST, 'c-1', 'm-50', 'success']);
		assert.strictEqual(report.text, `Your message #m50 to @Bob #a2 (${B}) was submitted to its CLI. This is a Facade result, not a reply from the recipient.`);
		// Nothing is typed into this window for it, and no result record is kept here: that window keeps it
		assert.deepStrictEqual([input.submitted.map(each => each.run), [...messages.records.keys()]], [[B], ['m-50']]);
	});

	test('a result its sender\'s window cannot take ends there, with a line in the log and nobody else told', async () => {
		const { service, input, log, messages } = setUp({ results: { report: async () => false } });
		input.states.set(B, ['draft', 'usable']);
		await settled(service.send({ id: 'm-50', from: GUEST, sender: SENDER, to: B, text: 'Ship it.', elapsedMs: 0 }));
		await sleep(15_000);
		assert.ok(log.some(line => line === 'The Facade result about #m50 could not reach its sender\'s window, and ends there'), log.join('\n'));
		assert.deepStrictEqual([...messages.records.keys()], ['m-50']);
		assert.deepStrictEqual(input.submitted.map(each => each.run), [B]);
	});

	test('with no route to other windows, such a result ends quietly too, never handed to this window\'s agents', async () => {
		const { service, input, log, messages } = setUp({ results: false });
		input.states.set(B, ['draft', 'usable']);
		await settled(service.send({ id: 'm-50', from: GUEST, sender: SENDER, to: B, text: 'Ship it.', elapsedMs: 0 }));
		await sleep(15_000);
		assert.ok(log.some(line => line.startsWith('The Facade result about #m50 could not reach its sender\'s window')), log.join('\n'));
		assert.deepStrictEqual([[...messages.records.keys()], input.submitted.map(each => each.run)], [['m-50'], [B]]);
	});

	test('an input box Facade never recognized fails at the deadline, the result naming the CLI and the version it found (D83)', async () => {
		const { service, input, reported } = setUp();
		input.states.set(B, ['unknown']);
		await settled(service.send({ id: 'm-50', from: GUEST, sender: SENDER, to: B, text: 'Ship it.', elapsedMs: 0 }));
		await sleep(15_000);
		assert.strictEqual(reported[0].result.about.delivery.reason, 'input_unknown');
		assert.strictEqual(reported[0].result.text, `Your message #m50 to @Bob #a2 (${B}) was not delivered: its input could not be read until the deadline; Facade did not recognize the input box of Codex 0.166.0 (input_unknown). Input effects: none. This is a Facade result, not a reply from the recipient.`);
		assert.deepStrictEqual(input.submitted, []);
	});

	test('a local sender\'s result about an unrecognized input box names the CLI too, and without a known version its name alone', async () => {
		const { service, input, runs, messages } = setUp();
		runs.set(B, { ...runs.get(B)!, version: undefined } as RunFacts);
		input.states.set(B, ['unknown']);
		input.states.set(A, ['usable']);
		await settled(service.send({ from: A, to: B, text: 'Ship it.', elapsedMs: 0 }));
		await sleep(15_000);
		const result = [...messages.records.values()].find(record => record.kind === 'result')!;
		assert.match(result.text, /Facade did not recognize the input box of Codex \(input_unknown\)/);
	});

	test('history shows this window\'s messages and the copies of those it sent to other windows, each once, oldest first', async () => {
		const { service, copies, recorded } = setUp();
		await settled(service.send({ from: A, to: B, text: 'Local one.', elapsedMs: 0 }));
		const there = (id: string, at: number): MessageRecord => ({
			id, alias: `#m${id.slice(2)}`, kind: 'message', from: { run: A, alias: '#a1', name: 'Ada' }, to: { run: GUEST, alias: '#a9', name: 'Gus' },
			window: 'win-2', environment: 'ssh-remote+box', fromWindow: 'win-1', workspace: 'ws-remote', at, text: 'Remote one.', length: 11,
			delivery: { status: 'success', effects: CONFIRMED, attempts: 1, via: 'terminal', deliveredAt: at }
		});
		service.keepSent(there('m-7', Date.now() + 1));
		// A copy of a message this environment keeps itself is shown once, as kept
		service.keepSent({ ...there('m-1', Date.now()), text: 'A stale copy.' });
		assert.deepStrictEqual(service.history().map(record => [record.id, record.text]), [['m-1', 'Local one.'], ['m-7', 'Remote one.']]);
		// The copy is brought up to date in place, and history follows it
		service.keepSent({ ...there('m-7', Date.now() + 1), delivery: { status: 'failure', reason: 'input_draft', effects: { outcome: 'none' }, attempts: 5 } });
		assert.deepStrictEqual(service.history().find(record => record.id === 'm-7')?.delivery.status, 'failure');
		assert.deepStrictEqual([...copies.records.keys()].sort(), ['m-1', 'm-7']);
		// Each copy kept is told, as Message History follows what is recorded
		assert.deepStrictEqual(recorded.filter(record => record.window === 'win-2').map(record => record.id), ['m-7', 'm-1', 'm-7']);
	});

	test('without a store of copies a copy is not kept, and nothing fails', async () => {
		const { service, recorded } = setUp({ sent: false });
		service.keepSent({ id: 'm-7', alias: '#m7', kind: 'message', from: { run: A }, to: { run: GUEST }, window: 'win-2', environment: 'local', at: 1, text: 'x', length: 1, delivery: { status: 'pending', effects: { outcome: 'pending' }, attempts: 0 } });
		assert.deepStrictEqual([service.history(), recorded], [[], []]);
	});

	test('a creation prompt another window\'s agent gave natively is recorded as that agent\'s, with its window', async () => {
		const { service } = setUp();
		const record = service.recordPrompt({ id: 'm-60', from: GUEST, sender: SENDER, to: B, text: 'Build it.' }, { status: 'success', effects: { outcome: 'unknown' }, attempts: 0, via: 'launch', deliveredAt: 1 });
		assert.deepStrictEqual([record.id, record.from, record.fromWindow, record.delivery.via], ['m-60', SENDER.party, 'win-2', 'launch']);
		// What a prompt's header is made of, for the native path: the guest's party
		const allocated = service.allocate({ from: GUEST, text: 'Build it.', party: SENDER.party });
		assert.strictEqual(allocated.text, `[Facade message #m${allocated.id.slice(2)} | from @Gus #a9 | window Design]\nBuild it.\n[/Facade message #m${allocated.id.slice(2)}]`);
	});

	test('a result another window routes for this window\'s agent is about the message it names, and names the agent as that window did', async () => {
		const { service, input } = setUp();
		const record = service.report({ to: A, text: 'Your message #m5 was submitted to its CLI.', callId: 'c-3', about: 'm-5', agentParty: { run: GUEST, alias: '#a9', name: 'Gus' } });
		assert.deepStrictEqual([record.kind, record.about, record.callId, record.agent], ['result', 'm-5', 'c-3', { run: GUEST, alias: '#a9', name: 'Gus' }]);
		await sleep(1);
		assert.deepStrictEqual(input.submitted.map(each => [each.run, each.text.split('\n')[0]]), [[A, '[Facade result #m1 | about #m5 | agent @Gus #a9 | call c-3]']]);
	});
});
