/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { AgentInfo, AgentListResult, AgentsChange, AgentsSnapshot, Message, MessagesChange, MessagesSnapshot, Operation, ScreenChange, ScreenSnapshot, Topic, WindowRef } from '../base/coreProtocol';
import type { MessageRecord } from '../core/messagePorts';
import type { RunChange } from '../core/ports';
import type { RunBinding } from '../host/execution/agentPty';
import type { RustAgentsDeps } from '../host/rust/agents';
import { agentAddress, messageAddress } from '../host/rust/references';
import { DaemonError, type DaemonLink, type WatchListener } from '../host/rust/types';
import { withModules } from './withModules';

const local = '00000000-0000-4000-8000-000000000001';
const gpu = '00000000-0000-4000-8000-000000000002';
const server = '00000000-0000-4000-8000-000000000003';
const window: WindowRef = { machine_id: local, window_id: 'editor' };
const targetWindow: WindowRef = { machine_id: gpu, window_id: 'backend' };
const at = '2026-11-17T00:00:00.000Z';
const none = { dispose() { } };

function record(machine_id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
	return {
		machine_id, agent_id: 'a7', name: 'Fixture', cli: 'codex', cwd: '/work', location_id: 'folder', process: 'running',
		windows: [window], pid: 42, created_at: at, root: 'a7', yolo: true, state: 'idle', tools_state: 'available', session: 'shared-session',
		...extra
	};
}

function harness() {
	const calls: { op: Operation; args: object }[] = [];
	const notifications: MessageRecord[] = [];
	const watches = new Map<Topic, WatchListener<never, never>>();
	let answer: (op: Operation) => unknown = op => { throw new Error(`Unexpected ${op}`); };
	let rebound = () => { };
	let connected = true;
	const listing = () => watches.get('agents') as unknown as WatchListener<AgentsSnapshot, AgentsChange>;
	const link: DaemonLink = {
		window, windowId: window.window_id, machineId: window.machine_id, get connected() { return connected; },
		onDidBind: listener => { rebound = () => listener(window); return none; },
		call: async <R>(op: Operation, args: object): Promise<R> => { calls.push({ op, args }); return answer(op) as R; },
		watch<S, C>(topic: Topic, _args: object, on: WatchListener<S, C>) {
			watches.set(topic, on as WatchListener<never, never>);
			return none;
		},
		notify() { }, async update() { }, dispose() { }
	};
	const empty = () => [];
	const ignore = () => { };
	const disconnected = new Map<string, boolean>();
	const dismissed = new Set<string>();
	const removed: string[] = [];
	const deps = {
		link, terminals: {
			openPair: ignore, bind: ignore, tabLabel: ignore, spin: ignore, removePair: (run: string) => removed.push(run), note: ignore, exited: ignore,
			setReachable: (run: string, reachable: boolean) => disconnected.set(run, !reachable),
			tabOpen: () => false, reveal: async () => true
		},
		locations: { resolve: () => undefined, snapshot: () => ({ folders: [], locations: [] }) },
		clis: empty, windows: empty, onDidChangeWindows: () => none, onDidChangeMachines: () => none,
		machineName: (machine: string) => machine === gpu ? 'gpu' : 'server',
		environment: () => ({ LOCAL: 'editor' }), pins: { list: empty }, titles: { title: async () => undefined },
		history: { remember: () => assert.fail('remote paths must stay outside local launch history') },
		dismissed: { has: (agent: string) => dismissed.has(agent), set: (agent: string, dismiss: boolean) => dismiss ? dismissed.add(agent) : dismissed.delete(agent), retain: () => undefined },
		contact: { contact: (notice: MessageRecord) => notifications.push(notice) }, human: { error: ignore },
		log: { event: ignore }, describe: (err: Error) => err.message, newRunId: () => 'start-fixture'
	};
	const load = withModules({ vscode: { l10n: { t: (message: string) => message } } });
	const { RustAgents } = load<typeof import('../host/rust/agents')>(require.resolve('../host/rust/agents'));
	const { DaemonError: LinkError } = load<typeof import('../host/rust/types')>(require.resolve('../host/rust/types'));
	const agents = new RustAgents(deps as unknown as RustAgentsDeps);
	return {
		agents, calls, notifications, disconnected, dismissed, removed, LinkError,
		answer: (fn: typeof answer) => { answer = fn; },
		disconnect: () => { connected = false; listing().disconnected?.(); },
		reconnect: () => { connected = true; rebound(); },
		get listing() { return listing(); },
		get inbox() { return watches.get('messages') as unknown as WatchListener<MessagesSnapshot, MessagesChange>; }
	};
}

suite('Rust machine network windows (RULES-2.2, PANEL-1.3, LIFECYCLE-2.3)', () => {
	test('keeps equal numbers distinct and removes records only from an authoritative machine view', () => {
		const view = harness();
		const localAgent = record(local);
		const remote = record(gpu, { label: '#a7@gpu' });
		const peer = record(server, { label: '#a7@server' });
		view.listing.snapshot({ agents: [localAgent], machines: [
			{ machine_id: gpu, state: 'synced', agents: [remote] }, { machine_id: server, state: 'synced', agents: [peer] }
		] });
		assert.deepStrictEqual(view.agents.list().map(run => [run.alias, run.pinnable]), [['#a7', true], ['#a7@gpu', false], ['#a7@server', false]]);
		view.listing.change({ kind: 'machine_state', machine: { machine_id: gpu, state: 'pending' } });
		assert.strictEqual(view.agents.get(agentAddress(remote))?.disconnected, true);
		assert.strictEqual(view.disconnected.get(agentAddress(remote)), true);
		view.reconnect();
		view.listing.snapshot({ agents: [localAgent], machines: [{ machine_id: server, state: 'unreachable' }] });
		assert.strictEqual(view.agents.get(agentAddress(remote))?.disconnected, true);
		assert.strictEqual(view.agents.get(agentAddress(peer))?.disconnected, true);
		view.listing.change({ kind: 'machine_state', machine: { machine_id: gpu, state: 'synced', agents: [remote] } });
		assert.strictEqual(view.disconnected.get(agentAddress(remote)), false);
		view.listing.change({ kind: 'machine_state', machine: { machine_id: gpu, state: 'synced', agents: [] } });
		assert.deepStrictEqual(view.agents.list().map(run => run.id), [agentAddress(localAgent), agentAddress(peer)]);
		view.listing.change({ kind: 'removed', machine_id: server, agent_id: peer.agent_id });
		assert.deepStrictEqual(view.agents.list().map(run => run.id), [agentAddress(localAgent)]);
	});

	test('local core loss immediately marks every remote card disconnected until its machine syncs', () => {
		const view = harness();
		const localAgent = record(local);
		const remote = record(gpu);
		const peer = record(server);
		view.listing.snapshot({ agents: [localAgent], machines: [
			{ machine_id: gpu, state: 'synced', agents: [remote] }, { machine_id: server, state: 'synced', agents: [peer] }
		] });
		const changes: RunChange[] = [];
		view.agents.onDidChange(change => changes.push(change));
		view.disconnect();
		assert.deepStrictEqual(view.agents.list().map(run => [run.id, !!run.disconnected]), [
			[agentAddress(localAgent), false], [agentAddress(remote), true], [agentAddress(peer), true]
		]);
		assert.deepStrictEqual(changes, [remote, peer].map(info => ({ run: agentAddress(info), kind: 'lifecycle' })));
		assert.strictEqual(view.disconnected.get(agentAddress(remote)), true);
		assert.strictEqual(view.disconnected.get(agentAddress(peer)), true);
		view.reconnect();
		assert.strictEqual(view.agents.get(agentAddress(remote))?.disconnected, true);
		view.listing.snapshot({ agents: [localAgent], machines: [{ machine_id: gpu, state: 'synced', agents: [remote] }] });
		assert.strictEqual(view.disconnected.get(agentAddress(remote)), false);
		assert.strictEqual(view.agents.get(agentAddress(peer))?.disconnected, true);
		view.listing.change({ kind: 'machine_state', machine: { machine_id: server, state: 'synced', agents: [peer] } });
		assert.strictEqual(view.disconnected.get(agentAddress(peer)), false);
	});

	test('preserves the storage machine for notification deduplication and replies (COLLABORATION-2.3)', () => {
		const view = harness();
		const message = (machine_id: string): Message => ({
			message_id: 'm42', message_ref: { machine_id, message_id: 'm42' }, from: 'a7', to: 'human',
			text: 'Hello', at, delivery: { status: 'success', text_written: 'full' }, reply_to: 'm41', reply_to_machine_id: server
		});
		const fromGpu = message(gpu);
		view.inbox.change({ kind: 'updated', message: fromGpu });
		view.inbox.change({ kind: 'updated', message: fromGpu });
		view.inbox.change({ kind: 'updated', message: message(local) });
		assert.deepStrictEqual(view.notifications.map(notice => notice.id), [messageAddress(fromGpu.message_ref!), messageAddress(message(local).message_ref!)]);
		assert.strictEqual(view.notifications[0].replyTo, messageAddress({ machine_id: server, message_id: 'm41' }));
	});

	test('adopts, stops and resumes the selected machine record despite a matching local number', async () => {
		const view = harness();
		const localAgent = record(local);
		const remote = record(gpu, { windows: [targetWindow] });
		const joined = { ...remote, windows: [targetWindow, window] };
		view.listing.snapshot({ agents: [localAgent], machines: [] });
		view.answer(op => {
			if (op === 'agent.list') { return { agents: [localAgent, remote], machines: [] } satisfies AgentListResult; }
			if (op === 'agent.adopt') { return joined; }
			if (op === 'agent.stop') { return { already_ended: false }; }
			if (op === 'agent.resume') { return { ...joined, pid: 43 }; }
			throw new Error(`Unexpected ${op}`);
		});
		const [candidate] = await view.agents.queryOtherAgents();
		const run = await view.agents.adoptAgent(candidate.facts.id);
		assert.strictEqual(run, agentAddress(remote));
		assert.strictEqual(await view.agents.stop(run), 'terminated');
		view.listing.change({ kind: 'updated', agent: { ...joined, process: 'ended', state: 'ended', exit: { code: 0, at } } });
		assert.strictEqual(view.agents.get(run), undefined);
		const [retained] = view.agents.retainedConversations();
		assert.strictEqual(await view.agents.resumeRetained(retained.agent, { reveal: true }), run);
		assert.strictEqual(view.agents.get(run)?.pid, 43);
		assert.deepStrictEqual(view.calls.map(call => call.op), ['agent.list', 'agent.adopt', 'agent.stop', 'agent.resume']);
		assert.ok(view.calls.slice(1).every(call => (call.args as { agent: string }).agent === agentAddress(remote)));
		assert.ok(!('env' in view.calls[3].args));
	});

	test('keeps the remote pair when core refuses stop or the result is unknown', async () => {
		const view = harness();
		const remote = record(gpu);
		view.listing.snapshot({ agents: [], machines: [{ machine_id: gpu, state: 'synced', agents: [remote] }] });
		const lost = new DaemonError('the target did not answer', 'unavailable', { reason: 'unavailable', unavailable: { execution: 'outcome_unknown' } });
		view.answer(() => { throw lost; });
		await assert.rejects(view.agents.stop(agentAddress(remote)), err => err === lost);
		const refused = new DaemonError('Stop refused', 'refused', { reason: 'refused' });
		view.answer(() => { throw refused; });
		await assert.rejects(view.agents.stop(agentAddress(remote)), err => err === refused);
		assert.strictEqual(view.agents.get(agentAddress(remote))?.pid, remote.pid);
	});

	test('dismisses a confirmed ended member only in this window and keeps the record for Resume', async () => {
		const view = harness();
		const remote = record(gpu);
		const run = agentAddress(remote);
		const ended = { ...remote, process: 'ended', state: 'ended', exit: { code: 2, at } } satisfies AgentInfo;
		const report = (agent: AgentInfo) => view.listing.change({ kind: 'updated', agent });
		view.listing.snapshot({ agents: [], machines: [{ machine_id: gpu, state: 'synced', agents: [remote] }] });

		await view.agents.dismiss(run);
		assert.strictEqual(view.agents.get(run)?.lifecycle, 'running');
		assert.deepStrictEqual(view.calls, []);
		report(ended);

		const resume = Promise.withResolvers<AgentInfo>();
		view.answer(() => resume.promise);
		const pending = view.agents.resumeRetained(run, { reveal: false });
		assert.strictEqual(view.agents.get(run)?.endUnconfirmed, true);
		await view.agents.dismiss(run);
		assert.ok(view.agents.get(run), 'a pending Resume keeps its pair');
		const refused = new view.LinkError('Resume refused', 'refused', { reason: 'refused' });
		resume.reject(refused);
		await assert.rejects(pending, err => err === refused);

		assert.strictEqual(await view.agents.stop(run), 'already_ended');
		assert.ok(view.agents.get(run), 'a stale Stop leaves the known ended card');
		await view.agents.dismiss(run);
		assert.strictEqual(view.agents.get(run), undefined);
		assert.deepStrictEqual(view.removed, [run]);
		assert.deepStrictEqual([...view.dismissed], [run]);
		assert.deepStrictEqual(view.agents.retainedConversations().map(({ agent, entry }) => [agent, entry.key.sessionId]), [[run, remote.session]]);
		assert.deepStrictEqual(view.calls.map(({ op }) => op), ['agent.resume']);

		view.answer(() => ({ ...remote, pid: 43 }));
		assert.strictEqual(await view.agents.resumeRetained(run, { reveal: false }), run);
		assert.strictEqual(view.agents.get(run)?.pid, 43);
		assert.deepStrictEqual([...view.dismissed], []);
	});

	test('retries remote screens after a refusal or late watch end and ignores the old generation', async () => {
		let binding!: RunBinding;
		type ScreenListener = WatchListener<ScreenSnapshot, ScreenChange>;
		const watches: { agent: string; listener: ScreenListener }[] = [];
		const retries = new Set<() => void>();
		const sent: string[] = [];
		const screens: string[] = [];
		const pty = {
			isOpen: true, close() { }, note() { },
			bind(value: RunBinding) { binding = value; void binding.snapshot().then(screen => screens.push(screen.screen)); },
			output(_seq: number, screen: string) { screens.push(screen); }
		};
		class AgentTerminals {
			create() { return { open() { }, pty }; }
			async finishRestore() { }
		}
		const vscode = { EventEmitter: class { event() { return none; } }, l10n: { t: (message: string) => message } };
		const timers = {
			setTimeout: (callback: () => void) => { retries.add(callback); return { callback, unref() { } }; },
			clearTimeout: (timer?: { callback: () => void }) => { if (timer) { retries.delete(timer.callback); } }
		};
		const retry = () => {
			assert.strictEqual(retries.size, 1);
			const [callback] = retries;
			retries.delete(callback);
			callback();
		};
		const { DaemonTerminals } = withModules({ vscode, '../execution/agentTerminals': { AgentTerminals } }, timers)<typeof import('../host/rust/terminals')>(require.resolve('../host/rust/terminals'));
		const link = {
			connected: true,
			watch(_topic: Topic, { agent }: { agent: string }, listener: ScreenListener) { watches.push({ agent, listener }); return none; },
			notify(_op: string, args: { raw: string }) { sent.push(Buffer.from(args.raw, 'base64').toString()); }
		} as unknown as DaemonLink;
		const terminals = new DaemonTerminals(link, {} as never);
		const ref = record(gpu);
		terminals.openPair({ run: 'remote' } as never, { reveal: false });
		terminals.bind('remote', agentAddress(ref), { reachable: true });
		const draw = (listener: ScreenListener, text: string, info = ref) => listener.snapshot({ ...info, redraw: Buffer.from(text).toString('base64'), cols: 80, rows: 24 });
		const unavailable = new DaemonError('Lost route', 'unavailable', { reason: 'unavailable' });
		const refused = watches[0].listener;
		refused.ended?.(unavailable);
		retry();
		const old = watches[1].listener;
		draw(refused, 'refused screen');
		draw(old, 'wrong machine', record(server));
		binding.input('before snapshot');
		draw(old, 'first');
		await Promise.resolve();
		binding.input('while connected');
		// The agents' sync arrives while the old watch still looks current, with no later agent update to prompt a retry.
		terminals.setReachable('remote', true);
		assert.strictEqual(watches.length, 2);
		old.ended?.(unavailable);
		binding.input('while disconnected');
		retry();
		const fresh = watches[2].listener;
		binding.input('before the redraw');
		draw(fresh, 'second');
		old.ended?.(unavailable);
		old.disconnected?.();
		draw(old, 'stale screen');
		binding.input('after the redraw');
		assert.deepStrictEqual(watches.map(watch => watch.agent), Array(3).fill(agentAddress(ref)));
		assert.deepStrictEqual(screens, ['first', '\x1bcsecond']);
		assert.deepStrictEqual(sent, ['while connected', 'after the redraw']);
		assert.strictEqual(retries.size, 0);
		fresh.ended?.(unavailable);
		assert.strictEqual(retries.size, 1);
		terminals.setReachable('remote', false);
		assert.strictEqual(retries.size, 0);
	});
});
