/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { RunFacts } from '../core/ports';
import { withModules } from './withModules';

const RUN = `run-${'3'.padStart(32, '0')}`;

const FACTS: RunFacts = {
	id: RUN, alias: '#a3', name: 'Ada Lovelace', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-main', cwd: '/shop', environment: 'local',
	yolo: true, createdAt: 1, lifecycle: 'running', phase: 'running', pid: 7, startedAt: 2, activity: 'working', reporting: true,
	root: RUN, origin: 'human', tools: 'not_injected'
};

suite('Facade Code Framework agent command targets (UX-3.1, PANEL-4.2)', () => {
	test('PANEL-2.2, 4.2: a card\'s menu names its exact run, including same-numbered agents on two machines', async () => {
		const registered = new Map<string, (arg?: unknown) => unknown>();
		const done: unknown[][] = [];
		const renames: unknown[] = [];
		const local = { ...FACTS, id: 'workstation/a3', alias: 'a3', address: 'a3@workstation', pinnable: true };
		const remote = { ...FACTS, id: 'devbox/a3', alias: 'a3', address: 'a3@0f12abcd', lifecycle: 'ended', pin: 'pin-remote' } satisfies RunFacts;
		let selected: RunFacts = local;
		const entries = new Map<string, RunFacts>([[local.id, local], [remote.id, remote]]);
		const api = {
			commands: { registerCommand: (id: string, handler: (arg?: unknown) => unknown) => {
				registered.set(id, handler);
				return { dispose: () => registered.delete(id) };
			} },
			l10n: { t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
			env: { clipboard: { writeText: async (text: string) => { done.push(['copy', text]); } } }
		};
		const { registerFrameworkAgentCommands } = withModules({ vscode: api, '../pickers/stepping': {
			Flow: class { async text(options: unknown) { renames.push(options); return '  New name  '; } close() { } }
		} })<typeof import('../ui/commands/agent')>(require.resolve('../ui/commands/agent'));
		const registration = registerFrameworkAgentCommands({
			agents: { get: id => entries.get(id) },
			model: {
				selectedAgent: () => ({ run: selected.id, ended: selected.lifecycle === 'ended' }),
				move: (id: RunFacts['id'], by: -1 | 1) => {
					done.push(['move', id, by]);
					return true;
				}
			} as never,
			actions: {
				open: async id => { done.push(['open', id]); return true; },
				stop: async id => { done.push(['stop', id]); },
				remove: async id => { done.push(['remove', id]); },
				setPinned: async (id, value) => { done.push(['pin', id, value]); },
				rename: async (id, name) => { done.push(['rename', id, name]); }
			},
			stopAgent: async () => { done.push(['stop-picker']); },
			notifyError: text => assert.fail(text)
		});
		const card = { webview: 'facade.agents', webviewSection: 'agent', run_id: remote.id, preventDefaultContextMenuItems: true };
		const invoke = (name: string, target?: unknown) => registered.get(`facade.${name}`)!(target);
		assert.strictEqual(await invoke('openTerminal', card), false);
		await invoke('stopAgent', card);
		await invoke('pinAgent', card);
		await assert.rejects(async () => invoke('deleteAgent', { run: remote.id }), /run_id/);
		assert.strictEqual(done.length, 0);
		assert.strictEqual(await invoke('openTerminal'), true);
		await invoke('stopAgent');
		await invoke('deleteAgent', card);
		await invoke('pinAgent');
		await invoke('unpinAgent', card);
		await invoke('renameAgent', card);
		await invoke('copyAgentReference', card);
		entries.set(remote.id, { ...remote, address: undefined, name: '' });
		await invoke('renameAgent', card);
		await invoke('moveUp', card);
		selected = remote;
		await invoke('moveDown', { ...card, run_id: local.id });
		assert.deepStrictEqual(done, [
			['open', local.id], ['stop-picker'], ['remove', remote.id],
			['pin', local.id, true], ['pin', remote.id, false], ['rename', remote.id, 'New name'], ['copy', remote.address],
			['rename', remote.id, 'New name'], ['move', remote.id, -1], ['move', local.id, 1]
		]);
		assert.deepStrictEqual(renames, [
			{ title: 'Rename Agent', value: remote.name, placeholder: 'Leave blank to choose a name automatically', prompt: 'Rename a3@0f12abcd' },
			{ title: 'Rename Agent', value: '', placeholder: 'Leave blank to choose a name automatically' }
		]);
		assert.deepStrictEqual(['dismissAgent', 'goToAgent', 'hideAgent', 'moveUp', 'moveDown'].map(name => registered.has(`facade.${name}`)), [false, false, false, true, true]);
		registration.forEach(each => each.dispose());
	});
});
