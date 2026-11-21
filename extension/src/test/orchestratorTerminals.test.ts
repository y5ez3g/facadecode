/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { AgentInfo } from '../base/coreProtocol';
import type { RustPin } from '../core/ports';
import type { AgentPty } from '../host/execution/agentPty';
import { restoreRustPins } from '../host/orchestrator/pinRestore';
import { DaemonError, type AttachListener, type AttachWatchArgs, type OrchestratorLink, type ResizeAttach } from '../host/orchestrator/types';
import { TestEmitter, withModules } from './withModules';

const local = '00000000-0000-4000-8000-000000000001';
const gpu = '00000000-0000-4000-8000-000000000002';
const server = '00000000-0000-4000-8000-000000000003';
const none = { dispose() { } };

suite('Orchestrator terminals', () => {
	test('Attach redraws after a refused watch or lost connection, ignores old watches and drops only unsent bytes (RULES-6.3)', async () => {
		const watches: { args: () => AttachWatchArgs; listener: AttachListener; disposed: boolean }[] = [];
		const retries = new Set<() => void>();
		const sent: string[] = [];
		const attachResize: Parameters<ResizeAttach>[0][] = [];
		const writes: string[] = [];
		const renderer: (string | { columns: number; rows: number })[] = [];
		const themeChanges = new TestEmitter<void>();
		const vscode = {
			EventEmitter: TestEmitter,
			window: { activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: themeChanges.event },
			l10n: { t: (message: string, ...args: unknown[]) => message.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) }
		};
		const load = withModules({ vscode });
		const { AgentPty } = load<typeof import('../host/execution/agentPty')>(require.resolve('../host/execution/agentPty'));
		const { WindowColours } = load<typeof import('../host/execution/terminalColours')>(require.resolve('../host/execution/terminalColours'));
		const colors = new WindowColours();
		const pty: AgentPty = new AgentPty('Fixture', () => undefined, undefined, (osc, rgb) => colors.learn(osc, rgb));
		pty.onDidOverrideDimensions(grid => renderer.push(grid));
		pty.onDidWrite(data => {
			if (!data.startsWith('\x1b]10;?')) { writes.push(data); renderer.push(data); }
		});
		class AgentTerminals {
			create() {
				return {
					isOpen: () => pty.isOpen,
					reveal() { if (!pty.isOpen) { pty.open({ columns: 87, rows: 31 }); } return true; },
					dispose() { pty.dispose(); }, pty
				};
			}
			async finishRestore() { }
			dispose() { pty.dispose(); }
		}
		const timers = {
			setTimeout: (callback: () => void) => { retries.add(callback); return { callback, unref() { return this; } }; },
			clearTimeout: (timer?: { callback: () => void }) => { if (timer) { retries.delete(timer.callback); } }
		};
		const retry = () => {
			assert.strictEqual(retries.size, 1);
			const [callback] = retries;
			retries.delete(callback);
			callback();
		};
		const { OrchestratorTerminals } = withModules({ vscode, '../execution/agentTerminals': { AgentTerminals } }, timers)<typeof import('../host/orchestrator/terminals')>(require.resolve('../host/orchestrator/terminals'));
		let canSend = true;
		const ref = { machine_id: gpu, agent_id: 'a7' };
		const link: OrchestratorLink = {
			connected: true,
			machineId: local,
			onDidConnect: () => none,
			async call(op) { throw new Error(`Unexpected ${op}`); },
			watch(topic) { throw new Error(`Unexpected watch ${topic}`); },
			watchAttach(args, listener) {
				const watch = { args, listener, disposed: false };
				watches.push(watch);
				return { dispose: () => { watch.disposed = true; } };
			},
			notify(op, args) {
				assert.strictEqual(op, 'agent.type');
				assert.deepStrictEqual(args.target, ref);
				assert.strictEqual(args.input.kind, 'raw');
				if (!canSend) { return false; }
				sent.push(Buffer.from(args.input.raw, 'base64').toString());
				return true;
			},
			dispose() { }
		};
		const terminals = new OrchestratorTerminals(link, {
			viewer: 'VS Code: Fixture', colours: colors, media: {} as never, log: () => undefined
		});
		const run = 'remote';
		terminals.openPair({ run, name: 'Fixture', cli: 'codex', displayName: 'Codex', command: 'codex', cwd: '/work' }, { reveal: false, hidden: true });
		terminals.bind(run, { ref, address: 'a7@gpu' }, true);
		assert.strictEqual(watches.length, 0);
		await terminals.reveal(run, { preserveFocus: false });
		const draw = (listener: AttachListener, text: string, machine_id = gpu, resize: ResizeAttach = () => undefined) => listener.snapshot({
			reference: { ...ref, machine_id }, address: 'a7@gpu', redraw: Buffer.from(text).toString('base64'), size: { cols: 80, rows: 24 }
		}, resize);
		const unavailable = new DaemonError('Lost route', 'unavailable', { reason: 'unavailable' });
		const refused = watches[0].listener;
		const refusal = assert.rejects(terminals.attached(run), err => err === unavailable);
		refused.ended?.(unavailable);
		await refusal;
		retry();
		const old = watches[1].listener;
		assert.deepStrictEqual(watches[1].args().size, { cols: 87, rows: 31 });
		draw(refused, 'refused screen');
		draw(old, 'wrong machine', server);
		pty.handleInput('é');
		draw(old, 'first screen', gpu, args => attachResize.push(args));
		await terminals.attached(run);
		const notice = (text: string) => `\x1b7\x1b[999;1H\x1b[0m\x1b[2K${text}\x1b8`;
		const lost = notice('Connection lost. Reconnecting. Keys typed while disconnected are not sent.');
		const dropped = (bytes: number) => notice(`Keys not sent: ${bytes} bytes.`);
		assert.deepStrictEqual(writes, [lost, 'first screen', dropped(2)]);
		assert.deepStrictEqual(renderer.slice(-3), [{ columns: 80, rows: 24 }, 'first screen', dropped(2)]);
		assert.deepStrictEqual(attachResize, [{ size: { cols: 87, rows: 31 }, colors: { foreground: '#cccccc', background: '#1f1f1f', cursor: '#cccccc' } }]);
		old.change({ kind: 'redraw', data: Buffer.from('resized screen').toString('base64'), size: { cols: 83, rows: 26 } });
		assert.deepStrictEqual(renderer.slice(-2), [{ columns: 83, rows: 26 }, 'resized screen']);
		assert.deepStrictEqual(pty.dimensions, { columns: 87, rows: 31 });
		pty.handleInput('while connected');
		canSend = false;
		pty.handleInput('汉'); // The socket rejected the write before the watch announced its disconnect.
		old.disconnected?.();
		canSend = true;
		pty.handleInput('😊'); // The next connection exists but its complete screen has yet to arrive.
		pty.setDimensions({ columns: 101, rows: 39 });
		pty.handleInput('\x1b]11;rgb:1919/1a1a/1b1b\x1b\\');
		assert.deepStrictEqual(watches[1].args().size, { cols: 101, rows: 39 });
		assert.strictEqual(attachResize.length, 1);
		const reconnectedResize: Parameters<ResizeAttach>[0][] = [];
		draw(old, 'reconnected screen', gpu, args => reconnectedResize.push(args));
		assert.deepStrictEqual(writes.slice(-3), [lost, 'reconnected screen', dropped(7)]);
		assert.deepStrictEqual(reconnectedResize[0], { size: { cols: 101, rows: 39 }, colors: { foreground: '#cccccc', background: '#191a1b', cursor: '#cccccc' } });
		vscode.window.activeColorTheme.kind = 1;
		themeChanges.fire();
		assert.deepStrictEqual(reconnectedResize[1].colors, { foreground: '#3b3b3b', background: '#ffffff', cursor: '#3b3b3b' });
		pty.handleInput('\x1b]12;rgb:abcd/88/f\x07');
		assert.strictEqual(reconnectedResize[2].colors?.cursor, '#ab88ff');
		// The agents' sync arrives while the old watch still looks current, with no later agent update to prompt a retry.
		terminals.setReachable(run, true);
		assert.strictEqual(watches.length, 2);
		old.ended?.(unavailable);
		assert.strictEqual(watches[1].disposed, true);
		retry();
		const fresh = watches[2].listener;
		draw(fresh, 'second');
		old.ended?.(unavailable);
		old.disconnected?.();
		draw(old, 'stale screen');
		pty.handleInput('after the redraw');
		assert.deepStrictEqual(watches.map(watch => watch.args()), Array(3).fill({
			target: ref, viewer: 'VS Code: Fixture', keep_scrollback: true, size: { cols: 101, rows: 39 }
		}));
		assert.deepStrictEqual(writes, [lost, 'first screen', dropped(2), 'resized screen', lost, 'reconnected screen', dropped(7), lost, 'second']);
		assert.deepStrictEqual(sent, ['while connected', 'after the redraw']);
		assert.strictEqual(retries.size, 0);
		fresh.ended?.(unavailable);
		assert.strictEqual(retries.size, 1);
		terminals.setReachable(run, false);
		assert.strictEqual(retries.size, 0);
		terminals.setReachable(run, true);
		assert.strictEqual(watches.length, 4);
		draw(watches[3].listener, 'reachable again');
		pty.close();
		assert.strictEqual(watches[3].disposed, true);
		await terminals.reveal(run, { preserveFocus: false });
		const closed = assert.rejects(terminals.attached(run), /terminal closed before Attach/);
		pty.close();
		await closed;
		assert.strictEqual(watches[4].disposed, true);
		terminals.dispose();
		colors.dispose();
	});

	test('Pin recovery opens running agents, tries Resume once and distinguishes removal, expiry and failure (RULES-6.4)', async () => {
		const at = '2026-11-17T00:00:00.000Z';
		const root = { machine_id: gpu, agent_id: 'a7' };
		const running: AgentInfo = {
			reference: root, address: 'a7@gpu', type: 'managed', name: 'Fixture', cli: 'work', args: [], cwd: '/work',
			process: 'running', created_at: at, started_at: at, root, yolo: true, state: 'idle', tools_state: 'available', session: 'gpu-session'
		};
		const crashed: AgentInfo = { ...running, reference: { machine_id: gpu, agent_id: 'a8' }, address: 'a8@gpu', process: 'ended', state: 'ended', exit: { code: 1, at } };
		const refused: AgentInfo = { ...crashed, reference: { machine_id: server, agent_id: 'a8' }, address: 'a8@server', session: 'server-session' };
		const restored: AgentInfo = { ...running, reference: { machine_id: gpu, agent_id: 'a9' }, address: 'a9@gpu' };
		const restoredCrash: AgentInfo = { ...running, reference: crashed.reference, address: crashed.address };
		const pin = (id: string, agent: AgentInfo): RustPin => ({
			id, conversation: { environment: 'local', cli: agent.cli, sessionId: agent.session },
			location: 'folder', cwd: agent.cwd, name: agent.name, machine_id: agent.reference.machine_id, agent: agent.reference.agent_id
		});
		const refusedPin = pin('refused', refused);
		const runningPin = pin('running', running);
		const crashedPin = pin('crashed', crashed);
		const expiredRecord = pin('expired-record', { ...running, reference: { machine_id: gpu, agent_id: 'a1' } });
		const missingSession = pin('missing-session', { ...running, reference: { machine_id: gpu, agent_id: 'a2' }, session: 'gone' });
		const deleted = pin('deleted', { ...running, reference: { machine_id: gpu, agent_id: 'a3' } });
		const missingRecord = pin('missing-record', { ...running, reference: { machine_id: gpu, agent_id: 'a4' } });
		const offline = pin('offline', { ...running, reference: { machine_id: server, agent_id: 'a7' }, session: 'remote' });
		const refusal = new DaemonError("clis.work runs Codex now, but this conversation is Claude Code's; it cannot be resumed with it",
			'unsupported', { reason: 'unsupported', details: { entry: 'work' } });
		const unavailable = new DaemonError('Lost route', 'unavailable', { reason: 'unavailable' });
		const gone = new DaemonError('Session is gone', 'session_not_found', { reason: 'session_not_found' });
		const unknown = new DaemonError('Agent is unknown', 'not_found', { reason: 'not_found' });
		const records = new Map([[runningPin, running], [crashedPin, crashed], [refusedPin, refused]]);
		const effects: unknown[][] = [];
		await restoreRustPins([refusedPin, runningPin, crashedPin, expiredRecord, missingSession, deleted, missingRecord, offline], {
			lookup: async pin => {
				effects.push(['lookup', pin]);
				if (pin === offline) { throw unavailable; }
				if (pin === deleted) { return { removal: 'removed' }; }
				if (pin === expiredRecord || pin === missingSession) { return { removal: 'expired' }; }
				const agent = records.get(pin);
				if (!agent) { throw unknown; }
				return { agent };
			},
			resumeExisting: async agent => {
				effects.push(['resume record', agent]);
				if (agent === refused) { throw refusal; }
				return restoredCrash;
			},
			resumeSession: async pin => {
				effects.push(['resume session', pin]);
				if (pin === missingSession) { throw gone; }
				return restored;
			},
			opened: async (pin, agent) => { effects.push(['opened', pin, agent]); },
			removed: pin => { effects.push(['removed', pin]); },
			expired: pin => { effects.push(['expired', pin]); },
			failed: (pin, error) => { effects.push(['failed', pin, error]); },
			isMissingSession: error => error instanceof DaemonError && error.reason === 'session_not_found'
		});
		assert.deepStrictEqual(effects, [
			['lookup', refusedPin], ['resume record', refused], ['failed', refusedPin, refusal],
			['lookup', runningPin], ['opened', runningPin, running],
			['lookup', crashedPin], ['resume record', crashed], ['opened', crashedPin, restoredCrash],
			['lookup', expiredRecord], ['resume session', expiredRecord], ['opened', expiredRecord, restored],
			['lookup', missingSession], ['resume session', missingSession], ['expired', missingSession],
			['lookup', deleted], ['removed', deleted],
			['lookup', missingRecord], ['failed', missingRecord, unknown],
			['lookup', offline], ['failed', offline, unavailable]
		]);
	});
});
