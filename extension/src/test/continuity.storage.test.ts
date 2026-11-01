/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SESSION_HOOK_SCRIPT, SESSION_FILE_VARIABLE, sessionFileOf } from '../clis/identity';
import { SessionIdentity } from '../host/execution/sessionIdentity';
import { keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { WorkspacePins } from '../host/pins';
import { KeptWorkspaceState } from '../host/workspaceState';
import { ConversationFile } from '../record/conversations';
import { cutNextWriteShort, fsError, replaceFsFunction, tempDir, waitFor } from './util';

suite('Exact conversation identity and durable restoration intent (CLIS-2.4, RULES-4.2)', () => {
	test('owned session files are read on a bounded period, needing no file watcher a quota could refuse', async () => {
		const temp = tempDir('fd-watch-quota-');
		const observed: (string | null)[] = [], log: string[] = [];
		const identity = new SessionIdentity(temp.dir, (_run, sessionId) => observed.push(sessionId), text => log.push(text));
		const restore = replaceFsFunction('watch', () => (() => { throw fsError('EMFILE', 'watch'); }) as typeof fs.watch);
		try {
			assert.doesNotThrow(() => identity.track('run-a'));
			fs.mkdirSync(path.dirname(sessionFileOf(temp.dir, 'run-a')), { recursive: true });
			const session = '86da4482-2bae-4a45-b193-a5664c19826a';
			fs.writeFileSync(sessionFileOf(temp.dir, 'run-a'), JSON.stringify({ session_id: session }));
			await waitFor(() => observed.includes(session));
			assert.deepStrictEqual(log, []);
		} finally { restore(); identity.dispose(); temp.remove(); }
	});
	test('a real isolated hook process updates only its run, observes /clear, and cleanup preserves other runs', async () => {
		const temp = tempDir('fd-session-');
		const ids: (string | null)[] = [];
		const identity = new SessionIdentity(temp.dir, (_run, sessionId) => ids.push(sessionId), () => undefined);
		const file = sessionFileOf(temp.dir, 'our-run');
		const one = '86da4482-2bae-4a45-b193-a5664c19826a';
		const two = '96da4482-2bae-4a45-b193-a5664c19826a';
		const hook = (session: string, event = 'SessionStart') => execFileSync(process.execPath, ['-e', SESSION_HOOK_SCRIPT], {
			input: JSON.stringify({ hook_event_name: event, session_id: session, source: 'clear' }), env: { [SESSION_FILE_VARIABLE]: file }
		});
		try {
			identity.track('our-run');
			hook(one); await waitFor(() => ids.length === 1);
			hook(two); await waitFor(() => ids.length === 2);
			hook(one, 'OtherEvent');
			assert.deepStrictEqual(ids, [one, two]);
			fs.writeFileSync(sessionFileOf(temp.dir, 'other-run'), '{}');
			identity.dispose();
			assert.ok(fs.existsSync(file), 'detach keeps identity for a reload');
			identity.forget('our-run');
			assert.ok(!fs.existsSync(file));
			assert.ok(fs.existsSync(sessionFileOf(temp.dir, 'other-run')));
		} finally { identity.dispose(); temp.remove(); }
	});

	test('conversation metadata stays separated by environment, CLI and exact session, including damaged records', () => {
		const temp = tempDir('fd-conversations-');
		try {
			const a = new ConversationFile(temp.dir), b = new ConversationFile(temp.dir);
			const key = { environment: 'local', cli: 'claude', sessionId: '../../literal-id' };
			const meta = { name: '', cwd: temp.dir };
			a.put(key, meta);
			b.put({ ...key, cli: 'codex' }, { ...meta, name: 'Other CLI' });
			assert.deepStrictEqual(a.get(key), meta);
			assert.strictEqual(a.get({ ...key, environment: 'ssh:elsewhere' }), undefined);
			assert.strictEqual(b.get({ ...key, cli: 'codex' })?.name, 'Other CLI');
			for (const file of fs.readdirSync(path.join(temp.dir, 'conversations'))) {
				fs.writeFileSync(path.join(temp.dir, 'conversations', file), '{broken');
			}
			assert.strictEqual(a.get(key), undefined);
		} finally { temp.remove(); }
	});


	test('a canonical workspace reopens its durable Pin and Unpin even when every editor Memento write failed', async () => {
		const temp = tempDir('fd-pin-memento-');
		const memory = { keys: () => [], get: <T>(_key: string) => undefined as T, update: async () => { throw new Error('editor storage unavailable'); } };
		try {
			const uri = 'file:///test/pinned-workspace';
			const open = () => {
				const record = workspaceRecord(uri, temp.dir);
				keepWorkspaceUri(uri, record, temp.dir);
				return new WorkspacePins(new KeptWorkspaceState(memory, path.join(record.dir, 'workspace-state.json'), record.binding.key === record.key, () => undefined));
			};
			const pin = { id: 'pin-a', name: 'A', cwd: temp.dir, location: 'loc', conversation: { environment: 'local', cli: 'claude', sessionId: 'exact' } };
			open().save(pin);
			await new Promise(resolve => setImmediate(resolve));
			const reopened = open();
			assert.deepStrictEqual(reopened.list(), [pin]);
			reopened.remove(pin.id);
			await new Promise(resolve => setImmediate(resolve));
			assert.deepStrictEqual(open().list(), []);
			await new Promise(resolve => setImmediate(resolve));
		} finally { temp.remove(); }
	});

	test('Pin commits to owned storage before success; an interrupted disk write preserves the previous list', () => {
		const temp = tempDir('fd-pins-');
		const values = new Map<string, unknown>();
		const memory = { keys: () => [...values.keys()], get: <T>(key: string) => values.get(key) as T, update: async (key: string, value: unknown) => { values.set(key, value); } };
		try {
			const state = new KeptWorkspaceState(memory, path.join(temp.dir, 'state.json'), false, () => undefined);
			const pins = new WorkspacePins(state);
			const pin = { id: 'pin-a', name: 'Agent', cwd: temp.dir, location: 'loc-a', conversation: { environment: 'local', cli: 'claude', sessionId: 'exact' } };
			pins.save(pin);
			const undo = cutNextWriteShort();
			try { assert.throws(() => pins.remove(pin.id), /ENOSPC/); } finally { undo(); }
			assert.deepStrictEqual(pins.list(), [pin]);
			const carried = new KeptWorkspaceState(memory, path.join(temp.dir, 'state.json'), true, () => undefined);
			assert.deepStrictEqual(new WorkspacePins(carried).list(), [pin]);
			pins.reorder(['pin-a', 'pin-a']);
			assert.strictEqual(pins.list().length, 1);
			pins.remove(pin.id);
			assert.deepStrictEqual(pins.list(), []);
		} finally { temp.remove(); }
	});
});
