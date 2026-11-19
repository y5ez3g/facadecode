/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentRef, V3AgentInfo } from '../base/coreProtocol';
import { WINDOW_LEGACY_INSTANCE_COMMAND } from '../base/windowIdentity';
import { windowAddress } from '../host/windowNetwork';
import { keepWindowKey, workspaceRecord } from '../record/workspace';
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
	const instanceId = windowAddress(token);
	const state = new Map<string, unknown>();
	if (withPin) { state.set('facade.workspaceKey', previous.key); }
	const open = (sessionId: string, withComponent = true, storage = state) => {
		const { openRustWorkspace } = withModules({ vscode: {
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
		} })<typeof import('../host/orchestrator/workspace')>(require.resolve('../host/orchestrator/workspace'));
		return openRustWorkspace({ workspaceState: {
			get: (key: string) => storage.get(key),
			update: async (key: string, value: unknown) => { storage.set(key, value); },
		} } as never, { home, log: { event: assert.fail } });
	};
	const noQuery = async () => assert.fail('A folderless window can query members only by a proven old instance.');
	if (withPin) {
		const withoutComponent = open('without-component', false);
		const unrelated = open('unrelated', false, new Map());
		try {
			await assert.rejects(withoutComponent.importLegacy({ machineId: local, load: noQuery }), /Enable the Facade Code Window Component/);
			assert.deepStrictEqual(withoutComponent.snapshot().pins, [pin]);
			await unrelated.importLegacy({ machineId: local, load: noQuery });
			assert.deepStrictEqual(unrelated.snapshot(), { members: [], pins: [] });
		} finally {
			withoutComponent.dispose();
			unrelated.dispose();
		}
	}
	const opened = open(`new-${withPin}`);
	try {
		let imports = 0;
		const load = () => opened.importLegacy({
			machineId: local,
			load: async args => {
				imports++;
				assert.deepStrictEqual(args, { machine_id: local, instance_id: instanceId });
				return {
					agents: [agent],
					machines: [{
						machine_id: local, short_id: 'local', name: 'Local', selector: 'local', state: 'online',
						status: withPin && imports === 1 ? 'timed_out' : 'answered',
					}],
				};
			},
		});
		const expected = {
			members: withPin ? [{ machine_id: pin.machine_id, agent_id: pin.agent }, agent] : [agent],
			pins: withPin ? [pin] : [],
		};
		if (withPin) {
			await assert.rejects(load(), /facade machine add/);
			assert.deepStrictEqual(opened.snapshot(), expected);
		}
		await load();
		await load();
		assert.strictEqual(imports, withPin ? 2 : 1);
		assert.deepStrictEqual(opened.snapshot(), expected);
		if (withPin) { opened.removePin(pin.id); }
	} finally {
		opened.dispose();
	}
	if (withPin) {
		for (const session of ['reopened-empty', 'reopened-again']) {
			const reopened = open(session, false);
			try {
				await reopened.importLegacy({ machineId: local, load: noQuery });
				assert.deepStrictEqual(reopened.snapshot(), {
					members: [{ machine_id: gpu, agent_id: 'a7' }, agent],
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
	test('keeps equal numbers distinct and removes records only from an authoritative machine view', async () => {
		const temp = tempDir('fd-orchestrator-roster-');
		const load = (sessionId: string) => withModules({ vscode: {
			env: { sessionId },
			workspace: { workspaceFolders: [{ uri: { toString: () => 'file:///workspace' } }] },
			EventEmitter: TestEmitter,
		} })<typeof import('../host/orchestrator/workspace')>(require.resolve('../host/orchestrator/workspace'))
			.openRustWorkspace({ workspaceState: { get: () => undefined } } as never, { home: temp.dir, log: { event: assert.fail } });
		const first = load('first');
		const other = load('other');
		const ref = (machine_id: string, agent_id = 'a7'): AgentRef => ({ machine_id, agent_id });
		const info = (target: AgentRef, creator?: AgentRef): V3AgentInfo => ({
			...target, type: 'managed', address: target.agent_id + '@' + target.machine_id, args: [],
			name: 'Fixture', cli: 'codex', cwd: '/work', process: 'running', created_at: at, started_at: at,
			creator: creator?.agent_id, creator_machine_id: creator?.machine_id, root: 'a7', yolo: true, state: 'idle', tools_state: 'available',
		});
		const localAgent = ref(local);
		const remote = ref(gpu);
		const peer = ref(server);
		const child = ref(server, 'a8');
		const grandchild = ref(gpu, 'a9');
		let reopened: ReturnType<typeof load> | undefined;
		try {
			await first.importLegacy({ machineId: local, load: async () => assert.fail('A new workspace has no prior binding.') });
			await other.importLegacy({ machineId: local, load: async () => assert.fail('A second v3 window does not create a legacy source.') });
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
			const join = other.restorePinsOnce(async () => assert.fail('A second open window cannot restore the Pins again.'));
			finish.resolve();
			assert.deepStrictEqual(await restore, { performed: true, failures });
			assert.deepStrictEqual(await join, { performed: false, failures });
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
