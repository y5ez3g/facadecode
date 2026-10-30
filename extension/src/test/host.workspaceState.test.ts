/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { KeptWorkspaceState } from '../host/workspaceState';
import { tempDir } from './util';

/** An editor's workspace state: what it holds, and what it was told to keep. */
function editorState(values: { readonly [key: string]: unknown } = {}): vscode.Memento & { readonly values: Map<string, unknown> } {
	const map = new Map(Object.entries(values));
	return {
		values: map,
		keys: () => [...map.keys()],
		get: <T>(key: string, defaultValue?: T) => (map.has(key) ? map.get(key) : defaultValue) as T,
		update: async (key: string, value: unknown) => void (value === undefined ? map.delete(key) : map.set(key, value))
	};
}

suite('Host: the window\'s workspace state, kept beside its agents too (ARCHITECTURE-2.2, D70)', () => {
	let temp: ReturnType<typeof tempDir>;
	let file: string;

	setup(() => {
		temp = tempDir('fc-kept-');
		file = path.join(temp.dir, 'workspace-state.json');
	});
	teardown(() => temp.remove());

	test('a superseded activation cannot overwrite workspace history or the shared state file', async () => {
		let owns = true;
		const editor = editorState();
		const state = new KeptWorkspaceState(editor, file, false, () => undefined, write => { if (owns) { write(); } });
		await state.update('facade.panel.order', ['b', 'a']);
		owns = false;
		await state.update('facade.panel.order', []);
		assert.deepStrictEqual([state.get('facade.panel.order'), editor.get('facade.panel.order'), JSON.parse(fs.readFileSync(file, 'utf8'))],
			[['b', 'a'], ['b', 'a'], { 'facade.panel.order': ['b', 'a'] }]);
	});

	test('it is the editor\'s workspace state, and every change of it is kept in its file as well', async () => {
		const editor = editorState({ 'facade.lastLaunch': { location: 'loc-1', cli: 'claude' } });
		const state = new KeptWorkspaceState(editor, file, false, () => undefined);
		await state.update('facade.panel.order', ['run-2', 'run-1']);
		await state.update('facade.lastLaunch', undefined);
		assert.deepStrictEqual([state.get('facade.panel.order'), state.get('facade.lastLaunch', 'none'), state.keys(), [...editor.values.keys()], JSON.parse(fs.readFileSync(file, 'utf8'))],
			[['run-2', 'run-1'], 'none', ['facade.panel.order'], ['facade.panel.order'], { 'facade.panel.order': ['run-2', 'run-1'] }]);
	});

	test('a continuing window carries its current order and choices over stale destination state', () => {
		fs.writeFileSync(file, JSON.stringify({ 'facade.lastLaunch': { location: 'loc-1', cli: 'claude' }, 'facade.panel.order': ['run-1'], 'facade.workspaceKey': 'aaaaaaaaaaaaaaaa' }));
		const editor = editorState({ 'facade.panel.order': ['run-9'], 'facade.staleChoice': 'from an earlier visit' });
		const carried = new KeptWorkspaceState(editor, file, true, () => undefined);
		const fresh = new KeptWorkspaceState(editorState(), path.join(temp.dir, 'other.json'), false, () => undefined);
		assert.deepStrictEqual([carried.get('facade.lastLaunch'), carried.get('facade.panel.order'), editor.values.get('facade.lastLaunch'), fresh.keys()],
			[{ location: 'loc-1', cli: 'claude' }, ['run-1'], { location: 'loc-1', cli: 'claude' }, []]);
		assert.strictEqual(editor.get<string[]>('facade.panel.order')?.[0], 'run-1');
		assert.ok(!carried.keys().includes('facade.staleChoice'));
		assert.ok(!editor.keys().includes('facade.staleChoice'));
	});

	test('an unreadable carried-state file does not erase the editor state', () => {
		fs.writeFileSync(file, '{');
		const editor = editorState({ 'facade.panel.order': ['run-1'] });
		const carried = new KeptWorkspaceState(editor, file, true, () => undefined);
		assert.deepStrictEqual(carried.get('facade.panel.order'), ['run-1']);
	});

	test('a failed sidecar write cannot confirm a newer editor order that reload would roll back', async () => {
		const editor = editorState({ 'facade.panel.order': ['a', 'b'] });
		const state = new KeptWorkspaceState(editor, file, false, () => undefined);
		const saved = `${file}.saved`;
		fs.renameSync(file, saved);
		fs.mkdirSync(file); // A real replacement failure, independent of platform permission behavior under an elevated user.
		await assert.rejects(Promise.resolve(state.update('facade.panel.order', ['b', 'a'])));
		assert.deepStrictEqual(state.get('facade.panel.order'), ['a', 'b']);
		assert.deepStrictEqual(editor.get('facade.panel.order'), ['a', 'b']);
		fs.rmdirSync(file);
		fs.renameSync(saved, file);
		const reloaded = new KeptWorkspaceState(editor, file, true, () => undefined);
		assert.deepStrictEqual(reloaded.get('facade.panel.order'), ['a', 'b']);
		await reloaded.update('facade.panel.order', ['b', 'a']);
		assert.deepStrictEqual(editor.get('facade.panel.order'), ['b', 'a']);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['facade.panel.order'], ['b', 'a']);
	});
});
