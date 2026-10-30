/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type * as vscode from 'vscode';
import { PanelPrefs } from '../ui/order';
import { WorkspaceLaunchHistory } from '../host/history';

/** Workspace storage as the editor keeps it: JSON. */
class Memento {
	readonly values = new Map<string, unknown>();
	keys(): readonly string[] { return [...this.values.keys()]; }
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	update(key: string, value: unknown): Thenable<void> { this.values.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

suite('Stored records of earlier builds are ignored with one log line (ARCHITECTURE-4.2)', () => {

	test('a last launch of another shape is no last launch, said once; this build\'s is kept', () => {
		const state = new Memento();
		const logged: string[] = [];
		state.values.set('facade.lastLaunch', { folder: '/shop', agent: 'claude' });
		const history = new WorkspaceLaunchHistory(state as unknown as vscode.Memento, { event: line => logged.push(line) });
		const read = [history.last(), history.last()];
		history.remember('loc-1', 'claude');

		assert.deepStrictEqual([read, history.last(), new WorkspaceLaunchHistory(new Memento() as unknown as vscode.Memento, { event: line => logged.push(line) }).last()], [[{}, {}], { location: 'loc-1', cli: 'claude' }, {}]);
		assert.deepStrictEqual(logged, ['Ignored the stored last launch (facade.lastLaunch) this build does not read, as from an earlier build']);
	});
});

suite('Preference storage failures do not break the operation that saved them', () => {

	for (const failure of ['throw', 'reject'] as const) {
		test(`last launch and card order log a storage ${failure} and accept a later successful write`, async () => {
			const state = new Memento();
			const logged: string[] = [];
			const log = { event: (line: string) => logged.push(line) };
			const history = new WorkspaceLaunchHistory(state as unknown as vscode.Memento, log);
			const prefs = new PanelPrefs(state, log);
			const run = `run-${'1'.repeat(32)}`;
			const update = state.update;
			state.update = () => {
				const err = new Error('Storage unavailable');
				if (failure === 'throw') {
					throw err;
				}
				return Promise.reject(err);
			};

			assert.doesNotThrow(() => {
				history.remember('loc-first', 'claude');
				prefs.setOrder([run]);
			});
			await new Promise(resolve => setImmediate(resolve));
			const failedState = [history.last(), prefs.order()];
			state.update = update;
			history.remember('loc-next', 'codex');
			prefs.setOrder([run]);
			await new Promise(resolve => setImmediate(resolve));

			assert.deepStrictEqual([failedState, history.last(), prefs.order(), logged], [
				[{}, []],
				{ location: 'loc-next', cli: 'codex' },
				[run],
				['Could not save the last launch: Storage unavailable', 'Could not save the card order: Storage unavailable']
			]);
		});
	}
});
