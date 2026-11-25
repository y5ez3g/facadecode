/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentInfo, AgentRef } from '../base/frameworkProtocol';
import { withLongFileLock } from '../base/lock';
import { WINDOW_LEGACY_INSTANCE_COMMAND } from '../base/windowIdentity';
import { createHash } from 'crypto';
import { keepWindowKey, keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { tempDir } from './util';
import { TestEmitter, withModules } from './withModules';

const local = '00000000-0000-4000-8000-000000000001';
const gpu = '00000000-0000-4000-8000-000000000002';
const server = '00000000-0000-4000-8000-000000000003';
const at = '2026-11-17T00:00:00.000Z';

async function bringsBackFolderlessWorkspace(home: string, withPin: boolean): Promise<void> {
	const token = randomUUID();
	const previousUri = `untitled:old-${withPin}`;
	const previous = workspaceRecord(previousUri, home, undefined, { token, folders: [] });
	keepWindowKey(token, previous.key, [], home, Date.now(), previousUri);
	const agent = { machine_id: local, agent_id: 'a7' };
	const pin = {
		id: 'stored-pin', machine_id: gpu, agent: 'a7', location: 'folder', cwd: '/work',
		name: 'Pinned agent', conversation: { environment: 'remote', cli: 'codex' }
	};
	if (withPin) {
		fs.writeFileSync(path.join(previous.dir, 'workspace-state.json'), JSON.stringify({ 'facade.pins': [pin] }));
	}
	const instanceId = 'win-' + createHash('sha256').update('facade-window:' + token).digest('hex').slice(0, 16);
	const state = new Map<string, unknown>();
	if (withPin) { state.set('facade.workspaceKey', previous.key); }
	const open = (sessionId: string, withComponent = true, storage = state) => {
		const { openFrameworkWorkspace } = withModules({ vscode: {
			env: { sessionId },
			workspace: {},
			l10n: { t: (text: string) => text },
			EventEmitter: TestEmitter,
			commands: {
				executeCommand: async (name: string, session: string) => {
					assert.deepStrictEqual([name, session], [WINDOW_LEGACY_INSTANCE_COMMAND, sessionId]);
					if (!withComponent) { throw new Error(`command '${name}' not found`); }
					return { version: 1, session, token, instanceId };
				},
			},
		} })<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
		return openFrameworkWorkspace({ workspaceState: {
			get: (key: string) => storage.get(key),
			update: async (key: string, value: unknown) => { storage.set(key, value); },
		} } as never, { home, log: { event: assert.fail } });
	};
	if (withPin) {
		const unrelated = open('unrelated', false, new Map());
		try {
			await unrelated.loadLocalPins();
			assert.deepStrictEqual(unrelated.snapshot(), { members: [], pins: [] });
		} finally {
			unrelated.dispose();
		}
	}
	const opened = open(`new-${withPin}`);
	try {
		// The editor saved this member before completing its workspace import.
		opened.show(agent);
		const expected = {
			members: withPin ? [agent, { machine_id: pin.machine_id, agent_id: pin.agent }] : [agent],
			pins: withPin ? [pin] : [],
		};
		assert.strictEqual(await opened.loadLocalPins(), false);
		assert.strictEqual(await opened.loadLocalPins(), false);
		opened.reconcile([], [agent]);
		assert.deepStrictEqual(opened.snapshot(), expected);
		if (withPin) { opened.removePin(pin.id); }
	} finally {
		opened.dispose();
	}
	if (withPin) {
		for (const session of ['reopened-empty', 'reopened-again']) {
			const reopened = open(session, false);
			try {
				assert.strictEqual(await reopened.loadLocalPins(), false);
				assert.deepStrictEqual(reopened.snapshot(), {
					members: [agent, { machine_id: gpu, agent_id: 'a7' }],
					pins: [],
				});
				assert.strictEqual(state.get('facade.workspaceKey'), previous.key);
			} finally {
				reopened.dispose();
			}
		}
	}
}

suite('Orchestrator workspace roster (RULES-6.1)', () => {
	for (const failsOnOpen of [true, false]) {
		const when = failsOnOpen ? 'cannot open' : 'fails after opening';
		test(`a native watch that ${when} falls back and retries a transient roster read (ARCHITECTURE-3.1)`, () => {
			const temp = tempDir('fd-orchestrator-watch-');
			const file = path.join(temp.dir, 'orchestrator-workspace.json');
			const messages: string[] = [];
			const error = Object.assign(new Error('Too many open files'), { code: 'EMFILE' });
			let closes = 0;
			let failRead = false;
			let refresh: (() => void) | undefined;
			const watcher = Object.assign(new EventEmitter(), { close: () => { closes++; } });
			const handle = { unref: () => undefined };
			const { FrameworkWorkspace } = withModules({
				vscode: { EventEmitter: TestEmitter },
				fs: {
					...fs,
					watch: () => {
						if (failsOnOpen) { throw error; }
						return watcher;
					},
					readFileSync: (target: string, encoding: BufferEncoding) => {
						if (target === file && failRead) { throw new Error('Transient read error'); }
						return fs.readFileSync(target, encoding);
					},
				}
			}, {
				setInterval: (callback: () => void) => { refresh = callback; return handle; },
				clearInterval: (timer: unknown) => { assert.strictEqual(timer, handle); refresh = undefined; },
			})<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
			const workspace = new FrameworkWorkspace(temp.dir, {}, { event: message => messages.push(message) });
			const writeMember = (agent_id: string) => {
				const member = { machine_id: local, agent_id };
				const next = file + '.next';
				fs.writeFileSync(next, JSON.stringify({ version: 1, members: [member], pins: [], hidden: [], imported: true, importedPins: true }));
				fs.renameSync(next, file);
				return member;
			};
			try {
				const first = writeMember('a2');
				if (failsOnOpen) {
					assert.ok(refresh);
					refresh();
				} else {
					// The native watch missed the replacement before it reported its error.
					watcher.emit('error', error);
				}
				assert.deepStrictEqual(workspace.snapshot().members, [first]);
				const next = writeMember('a3');
				assert.ok(refresh);
				failRead = true;
				refresh();
				assert.deepStrictEqual(workspace.snapshot().members, [first]);
				failRead = false;
				refresh();
				assert.deepStrictEqual(workspace.snapshot().members, [next]);
				assert.deepStrictEqual(messages, [
					'Could not watch the Facade workspace: Too many open files',
					'Could not read the Facade workspace: Transient read error',
				]);
			} finally {
				workspace.dispose();
				temp.remove();
			}
			assert.strictEqual(closes, failsOnOpen ? 0 : 1);
			assert.strictEqual(refresh, undefined);
		});
	}

	test('a fresh window imports the exact saved empty workspace before its URI ledger existed (ARCHITECTURE-6.2)', async () => {
		const temp = tempDir('fd-orchestrator-saved-empty-');
		const pin = {
			id: 'saved-pin', location: 'folder', cwd: '/work', name: 'Legacy Fixture',
			conversation: { environment: 'local', cli: 'codex', sessionId: 'old-session' },
		};
		const sources: string[] = [];
		const open = (uri: string | undefined, kept?: string) => {
			const { openFrameworkWorkspace } = withModules({ vscode: {
				env: { sessionId: randomUUID() },
				workspace: { workspaceFile: uri && { toString: () => uri }, workspaceFolders: [] },
				EventEmitter: TestEmitter,
				commands: { executeCommand: async (command: string) => {
					assert.strictEqual(command, WINDOW_LEGACY_INSTANCE_COMMAND);
					return undefined;
				} },
			} })<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
			return openFrameworkWorkspace({ workspaceState: {
				get: (key: string) => key === 'facade.workspaceKey' ? kept : undefined,
				update: () => Promise.resolve(),
			} } as never, {
				home: temp.dir, log: { event: assert.fail },
				legacy: { pins: owner => {
					sources.push(owner);
					return { snapshot: () => undefined, recover: async () => ({ kind: 'deferred' }) };
				} },
			});
		};
		const check = async (uri: string | undefined, kept: string | undefined, expected: boolean) => {
			const workspace = open(uri, kept);
			try {
				await workspace.loadLocalPins();
				assert.deepStrictEqual(workspace.pendingLegacyPins(), expected ? [pin] : []);
			} finally {
				workspace.dispose();
			}
		};
		try {
			const saved = 'file:///empty.code-workspace';
			const remote = 'vscode-remote://ssh-remote+dev/work/empty.code-workspace';
			const moved = 'file:///moved.code-workspace';
			const localRecord = workspaceRecord(saved, temp.dir, '0123456789abcdef');
			const remoteRecord = workspaceRecord(remote, temp.dir);
			const movedRecord = workspaceRecord(moved, temp.dir, '1123456789abcdef');
			for (const record of [localRecord, remoteRecord, movedRecord]) {
				fs.writeFileSync(path.join(record.dir, 'workspace-state.json'), JSON.stringify({ 'facade.pins': [pin] }));
			}
			const destination = 'file:///destination.code-workspace';
			keepWorkspaceUri(destination, workspaceRecord(destination, temp.dir, movedRecord.key), temp.dir);
			await check(undefined, localRecord.key, false);
			await check(moved, movedRecord.key, false);
			await check(saved, localRecord.key, true);
			await check(remote, undefined, true);
			assert.deepStrictEqual(sources, [localRecord.key, remoteRecord.key]);
		} finally {
			temp.remove();
		}
	});

	test('an interrupted v1 conversion corroborates a different workspace Pin only with an exact durable record (ARCHITECTURE-6.2)', async () => {
		const temp = tempDir('fd-orchestrator-partial-conversion-');
		const { FrameworkWorkspace } = withModules({ vscode: { EventEmitter: TestEmitter } })
			<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
		const before = {
			id: 'old-pin', location: '/work', cwd: '/work', name: 'Old name',
			conversation: { environment: 'local', cli: 'codex', sessionId: 'exact-session' },
		};
		const other = { ...before, id: 'other-pin' };
		const reference = { machine_id: local, agent_id: 'a7' };
		const converted = {
			...before, name: 'Framework name', machine_id: reference.machine_id, agent: reference.agent_id,
			conversation: { ...before.conversation, environment: `machine:${local}` },
		};
		const first = workspaceRecord('file:///first', temp.dir);
		const second = workspaceRecord('file:///second', temp.dir);
		const third = workspaceRecord('file:///third', temp.dir);
		const writeIntent = (directory: string, pin: typeof before) => {
			fs.writeFileSync(path.join(directory, 'orchestrator-legacy-pins.json'), JSON.stringify({
				version: 1, pending: [pin], attempts: [pin.id], unrecognized: [],
			}));
		};
		const writeRoster = (directory: string, pin: typeof converted) => {
			fs.writeFileSync(path.join(directory, 'orchestrator-workspace.json'), JSON.stringify({
				version: 1, members: [], pins: [pin], hidden: [], imported: true, importedPins: true,
			}));
		};
		writeIntent(first.dir, before);
		const reopenedFirst = new FrameworkWorkspace(first.dir, { home: temp.dir }, { event: assert.fail });
		const reopeningOther = new FrameworkWorkspace(second.dir, { home: temp.dir }, { event: assert.fail });
		try {
			assert.deepStrictEqual(reopeningOther.legacyPinProgress(other), { attempted: true });
			writeRoster(first.dir, { ...converted, conversation: { ...converted.conversation, sessionId: 'different-session' } });
			assert.deepStrictEqual(reopeningOther.legacyPinProgress(other), { attempted: true });
			writeRoster(first.dir, converted);
			await reopenedFirst.loadLocalPins();
			assert.deepStrictEqual(reopenedFirst.pendingLegacyPins(), [before], 'keep the intent until the shared result is committed');
			assert.deepStrictEqual(reopenedFirst.legacyPinProgress(before), { attempted: true, reference });
			assert.deepStrictEqual(reopeningOther.legacyPinProgress(other), { attempted: true, reference });
			writeIntent(third.dir, other);
			writeRoster(third.dir, { ...converted, id: other.id, agent: 'a8' });
			assert.deepStrictEqual(reopeningOther.legacyPinProgress(other), { attempted: true }, 'conflicting converted refs stay fenced');
		} finally {
			reopenedFirst.dispose();
			reopeningOther.dispose();
			temp.remove();
		}
	});

	test('startup settings and the one restart attempt survive another window, and the Pin follows the new reference and session (RULES-6.4)', () => {
		const temp = tempDir('fd-orchestrator-restart-');
		const { FrameworkWorkspace } = withModules({ vscode: { EventEmitter: TestEmitter } })
			<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
		const open = () => new FrameworkWorkspace(temp.dir, {}, { event: () => undefined });
		const first = open();
		const second = open();
		try {
			const pin = {
				id: 'early-pin', machine_id: local, agent: 'a7', location: 'folder', cwd: '/work', name: 'First',
				conversation: { environment: `machine:${local}`, cli: 'codex' },
				launch: { args: ['--sandbox', 'workspace-write'], model: 'model', effort: 'low' },
			};
			first.savePin(pin);
			assert.ok(first.beginPinRestart(pin, 'start-first'));
			assert.ok(!second.beginPinRestart(pin, 'start-second'));
			second.clearPinRestart(pin, 'start-second');
			assert.strictEqual(second.snapshot().pins[0].restartAttempt, 'start-first');
			const replacement = { ...pin, agent: 'a8' };
			second.replacePin(pin, replacement);
			assert.deepStrictEqual(second.snapshot().pins, [replacement]);
			const reference = { machine_id: local, agent_id: replacement.agent };
			second.reconcile([{
				reference, address: 'a8@this-machine', type: 'managed', name: 'Renamed', cli: 'codex', args: [], cwd: '/work',
				process: 'running', created_at: at, started_at: at, root: reference, yolo: true, state: 'idle',
				tools_state: 'available', session: 'new-session'
			}], []);
			assert.deepStrictEqual(second.snapshot().pins, [{
				...replacement, name: 'Renamed', conversation: { ...pin.conversation, sessionId: 'new-session' },
			}]);
			assert.ok(!first.beginPinRestart(replacement, 'start-after-session'));
		} finally {
			first.dispose();
			second.dispose();
			temp.remove();
		}
	});

	test('an unrecognized legacy recovery file leaves ordinary Pins usable and preserves the file', async () => {
		for (const original of ['{broken', '{"version":2,"data":"future recovery"}\n']) {
			const temp = tempDir('fd-orchestrator-sidecar-');
			const messages: string[] = [];
			const { FrameworkWorkspace } = withModules({ vscode: {
				EventEmitter: TestEmitter,
				l10n: { t: (text: string, file: string) => text.replace('{0}', file) },
				window: { showWarningMessage: (message: string) => { messages.push(message); } }
			} })<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
			const previous = path.join(temp.dir, '0123456789abcdef');
			fs.mkdirSync(previous);
			const legacyFile = path.join(previous, 'workspace-state.json');
			const legacyState = JSON.stringify({ 'facade.pins': [{
				id: 'legacy-pin', location: 'folder', cwd: '/work', name: 'Legacy Fixture',
				conversation: { environment: 'local', cli: 'codex', sessionId: 'old-session' }
			}] });
			fs.writeFileSync(legacyFile, legacyState);
			const workspace = new FrameworkWorkspace(temp.dir, { file: legacyFile }, { event: () => undefined });
			try {
				const pin = {
					id: 'current-pin', machine_id: local, agent: 'a7', location: 'folder', cwd: '/work', name: 'Fixture',
					conversation: { environment: 'local', cli: 'codex', sessionId: 'saved-session' }
				};
				workspace.savePin(pin);
				const file = path.join(temp.dir, 'orchestrator-legacy-pins.json');
				fs.writeFileSync(file, original);
				await workspace.loadLocalPins();
				assert.deepStrictEqual(workspace.snapshot().pins, [pin]);
				assert.deepStrictEqual(workspace.pendingLegacyPins(), []);
				workspace.removePin(pin.id);
				assert.deepStrictEqual(workspace.snapshot().pins, []);
				assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
				assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), legacyState);
				assert.strictEqual(messages.length, 1);
				assert.ok(messages[0].includes(file));
			} finally {
				workspace.dispose();
				temp.remove();
			}
		}
	});

	test('keeps equal numbers distinct and removes records only from an authoritative machine view', async () => {
		const temp = tempDir('fd-orchestrator-roster-');
		const uri = 'file:///workspace';
		const load = (sessionId: string) => withModules({ vscode: {
			env: { sessionId },
			workspace: { workspaceFolders: [{ uri: { toString: () => uri } }] },
			EventEmitter: TestEmitter,
		} })<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'))
			.openFrameworkWorkspace({ workspaceState: { get: () => undefined } } as never, { home: temp.dir, log: { event: assert.fail } });
		const first = load('first');
		const other = load('other');
		const ref = (machine_id: string, agent_id = 'a7'): AgentRef => ({ machine_id, agent_id });
		const info = (target: AgentRef, creator?: AgentRef): AgentInfo => ({
			reference: target, type: 'managed', address: target.agent_id + '@' + target.machine_id, args: [],
			name: 'Fixture', cli: 'codex', cwd: '/work', process: 'running', created_at: at, started_at: at,
			creator, root: ref(target.machine_id), yolo: true, state: 'idle', tools_state: 'available',
		});
		const localAgent = ref(local);
		const remote = ref(gpu);
		const peer = ref(server);
		const child = ref(server, 'a8');
		const grandchild = ref(gpu, 'a9');
		let reopened: ReturnType<typeof load> | undefined;
		try {
			assert.strictEqual(await first.loadLocalPins(), true);
			assert.strictEqual(await other.loadLocalPins(), true);
			const changed = new Promise<void>(resolve => {
				const watching = other.onDidChange(() => { watching.dispose(); resolve(); });
			});
			first.show(localAgent);
			await changed;
			assert.deepStrictEqual(other.snapshot().members, [localAgent]);
			other.show(remote);
			first.show(peer);
			assert.deepStrictEqual(first.snapshot().members, [localAgent, remote, peer]);

			const known = [info(localAgent), info(peer), info(grandchild, child), info(child, remote)];
			other.reconcile(known, []);
			assert.deepStrictEqual(other.snapshot().members, [localAgent, remote, peer, child, grandchild]);
			other.reconcile(known, [remote]);
			assert.deepStrictEqual(other.snapshot().members, [localAgent, peer, child, grandchild]);
			first.forget(peer);
			assert.deepStrictEqual(first.snapshot().members, [localAgent, child, grandchild]);

			const startedElsewhere = ref(gpu, 'a11');
			first.show(startedElsewhere);
			other.reconcile(known, []);
			assert.deepStrictEqual(other.snapshot().members, [localAgent, child, grandchild, startedElsewhere]);
			other.reconcile([...known, info(startedElsewhere)], []);
			assert.deepStrictEqual(other.snapshot().members, [localAgent, child, grandchild, startedElsewhere]);

			const pin = (target: AgentRef, id: string) => other.savePin({
				id, machine_id: target.machine_id, agent: target.agent_id, location: 'folder', cwd: '/work', name: id,
				conversation: { environment: 'local', cli: 'codex', sessionId: id },
			});
			const failed = pin(localAgent, 'failed-pin');
			const continued = pin(child, 'continued-pin');
			const newAgent = ref(server, 'a10');
			const failures = [{ id: failed.id, reference: localAgent, reason: 'Could not reach the running machine.' }];
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const restore = first.restorePinsOnce(async () => {
				started.resolve();
				await finish.promise;
				first.replacePin(continued, { ...continued, agent: newAgent.agent_id });
				return failures;
			});
			await started.promise;
			// A window can still be registering when recovery finishes. Its registration must be able to release the lock.
			const roundFile = path.join(workspaceRecord(uri, temp.dir).dir, 'orchestrator-pin-restore.json');
			const registered = Promise.withResolvers<void>();
			const registration = withLongFileLock(roundFile, () => registered.promise, 0);
			const join = other.restorePinsOnce(async () => assert.fail('A second open window cannot restore the Pins again.'));
			const outcomes = Promise.allSettled([restore, join]);
			finish.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));
			registered.resolve();
			await registration;
			assert.deepStrictEqual(await outcomes, [
				{ status: 'fulfilled', value: { performed: true, failures } },
				{ status: 'fulfilled', value: { performed: false, failures } },
			]);
			assert.deepStrictEqual(other.snapshot().pins.map(each => [each.id, each.machine_id, each.agent]), [
				[failed.id, local, localAgent.agent_id], [continued.id, server, newAgent.agent_id],
			]);

			first.dispose();
			other.dispose();
			reopened = load('reopened');
			assert.deepStrictEqual(await reopened.restorePinsOnce(async () => []), { performed: true, failures: [] });
			await bringsBackFolderlessWorkspace(temp.dir, true);
			await bringsBackFolderlessWorkspace(temp.dir, false);
		} finally {
			first.dispose();
			other.dispose();
			reopened?.dispose();
			temp.remove();
		}
	});
});
