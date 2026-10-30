/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { keepWindowKey, keepWorkspaceUri, workspaceRecord } from '../record/workspace';
import { nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { tempDir } from './util';

suite('Record: the workspace a window claims its runs under (ARCHITECTURE-2.2, 3.1)', () => {
	let temp: ReturnType<typeof tempDir>;

	setup(() => {
		temp = tempDir('fc-workspace-');
	});
	function moving(key: string, previousUri: string): { token: string; folders: string[] } {
		const window = { token: crypto.randomUUID(), folders: ['file:///work'] };
		keepWindowKey(window.token, key, window.folders, temp.dir, Date.now(), previousUri);
		return window;
	}
	function windowKeyOf(token: string, folders: readonly string[], home: string, uri = folders[0] ?? 'untitled:test'): string | undefined {
		return workspaceRecord(uri, home, undefined, { token, folders }).handedOver;
	}

	test('valid JSON that is not a record cannot break activation', () => {
		const key = workspaceRecord('file:///work/shop', temp.dir).key;
		keepWindowKey('window', key, ['file:///work/shop'], temp.dir);
		const file = path.join(temp.dir, 'windows', `${crypto.createHash('sha256').update('window').digest('hex').slice(0, 16)}.json`);
		for (const value of ['null', '[]', '7', '"record"']) {
			fs.writeFileSync(file, value);
			assert.strictEqual(windowKeyOf('window', ['file:///work/shop'], temp.dir), undefined);
		}
	});
	teardown(() => temp.remove());

	test('a workspace\'s key comes from its URI, the same for every window of it; one the workspace kept wins - a folder window that became a multi-root workspace keeps the folder\'s (D65)', () => {
		const folder = workspaceRecord('file:///work/shop', temp.dir);
		const again = workspaceRecord('file:///work/shop/', temp.dir);
		const other = workspaceRecord('file:///work/docs', temp.dir);
		const became = workspaceRecord('file:///Users/me/Library/Application%20Support/Code/Workspaces/1761/workspace.json', temp.dir, folder.key);
		const notKey = workspaceRecord('file:///work/docs', temp.dir, '../../elsewhere');
		assert.deepStrictEqual([again.key, other.key === folder.key, became.key, became.dir, notKey.key], [folder.key, false, folder.key, folder.dir, other.key]);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(folder.dir, 'identity.json'), 'utf8')), { workspace: 'file:///work/shop' });
		assert.match(folder.key, /^[0-9a-f]{16}$/);
	});

	test('exact saved URI shares the moved owner in a fresh profile; a copied URI never inherits by folders', () => {
		const folder = 'file:///work/shop';
		const saved = 'file:///work/shop.code-workspace';
		const original = workspaceRecord(folder, temp.dir);
		keepWorkspaceUri(folder, original, temp.dir);
		keepWindowKey('moving-window', original.key, [folder], temp.dir, Date.now(), folder);
		const moved = workspaceRecord(saved, temp.dir, undefined, { token: 'moving-window', folders: [folder, 'file:///work/docs'] });
		assert.strictEqual(moved.handedOver, original.key);
		keepWorkspaceUri(saved, moved, temp.dir);
		assert.strictEqual(workspaceRecord(saved, temp.dir).key, original.key);
		assert.notStrictEqual(workspaceRecord('file:///work/copied.code-workspace', temp.dir).key, original.key);
		assert.strictEqual(windowKeyOf('different-window', [folder], temp.dir, saved), undefined);
	});

	test('Save As A to B frees A: both stale Memento and the original URI hash stay independent of B', () => {
		const a = 'file:///work/a.code-workspace', b = 'file:///work/b.code-workspace';
		const original = workspaceRecord(a, temp.dir);
		keepWorkspaceUri(a, original, temp.dir);
		keepWindowKey('old-a-window', original.key, ['file:///work'], temp.dir, Date.now(), a);
		keepWindowKey('legacy-a-window', original.key, ['file:///work'], temp.dir);
		const moved = workspaceRecord(b, temp.dir, undefined, moving(original.key, a));
		keepWorkspaceUri(b, moved, temp.dir);
		const reopened = workspaceRecord(a, temp.dir, original.key);
		assert.notStrictEqual(reopened.key, original.key);
		assert.strictEqual(workspaceRecord(a, temp.dir).key, reopened.key);
		assert.strictEqual(windowKeyOf('old-a-window', ['file:///work'], temp.dir, a), undefined);
		assert.strictEqual(windowKeyOf('legacy-a-window', ['file:///work'], temp.dir, a), undefined);
		assert.strictEqual(windowKeyOf('old-a-window', ['file:///work'], temp.dir, 'file:///work/c.code-workspace'), undefined);
		keepWorkspaceUri(a, reopened, temp.dir);
		assert.strictEqual(workspaceRecord(a, temp.dir, original.key).key, reopened.key);
		assert.strictEqual(workspaceRecord(b, temp.dir).key, original.key);
	});

	test('canonical binding wins over a stale kept key and a pre-ledger window token; a proven move wins over the destination', () => {
		const a = 'file:///work/a', b = 'file:///work/b';
		const first = workspaceRecord(a, temp.dir), second = workspaceRecord(b, temp.dir);
		keepWindowKey('legacy', second.key, ['file:///work'], temp.dir);
		keepWorkspaceUri(a, first, temp.dir);
		keepWorkspaceUri(b, second, temp.dir);
		const moved = workspaceRecord(b, temp.dir, second.key, moving(first.key, a));
		keepWorkspaceUri(b, moved, temp.dir);
		assert.strictEqual(workspaceRecord(b, temp.dir, second.key).key, first.key);
		assert.strictEqual(windowKeyOf('legacy', ['file:///work'], temp.dir, b), undefined);
		// The displaced owner remains reserved even after the replacement moves onwards.
		keepWorkspaceUri('file:///work/c', workspaceRecord('file:///work/c', temp.dir, undefined, moving(first.key, b)), temp.dir);
		assert.notStrictEqual(workspaceRecord(b, temp.dir, second.key).key, second.key);
	});

	test('registration rejects a concurrent binding/move and a former owner cannot write the ledger', () => {
		const a = 'file:///work/a', b = 'file:///work/b';
		const one = workspaceRecord(a, temp.dir), two = workspaceRecord(b, temp.dir);
		keepWorkspaceUri(a, one, temp.dir);
		const stale = workspaceRecord(b, temp.dir, undefined, moving(one.key, a));
		keepWorkspaceUri(b, two, temp.dir);
		const file = path.join(temp.dir, 'workspace-uris.json');
		const before = fs.readFileSync(file, 'utf8');
		assert.throws(() => keepWorkspaceUri(b, stale, temp.dir), /ownership changed/);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
		const current = workspaceRecord(b, temp.dir, undefined, moving(one.key, a));
		const old = nextOwnerClaim(one.key, temp.dir);
		nextOwnerClaim(one.key, temp.dir);
		writeAsOwner(old, temp.dir, () => keepWorkspaceUri(b, current, temp.dir));
		assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
		assert.throws(() => keepWorkspaceUri(a, current, temp.dir), /does not match/);
	});

	test('handover proof and resolution share one snapshot: a former A window cannot take a later A-to-C move into B', () => {
		const a = 'file:///work/a', b = 'file:///work/b', c = 'file:///work/c';
		const original = workspaceRecord(a, temp.dir);
		keepWorkspaceUri(a, original, temp.dir);
		const oldWindow = moving(original.key, a);
		assert.strictEqual(windowKeyOf(oldWindow.token, oldWindow.folders, temp.dir, b), original.key);
		keepWorkspaceUri(c, workspaceRecord(c, temp.dir, undefined, moving(original.key, a)), temp.dir);
		const attempted = workspaceRecord(b, temp.dir, original.key, oldWindow);
		assert.strictEqual(attempted.handedOver, undefined);
		assert.notStrictEqual(attempted.key, original.key);
		keepWorkspaceUri(b, attempted, temp.dir);
		assert.strictEqual(workspaceRecord(c, temp.dir).key, original.key);
		assert.strictEqual(workspaceRecord(b, temp.dir).key, attempted.key);
	});

	test('normalization follows the execution platform and a malformed ledger fails without changing identity', () => {
		const a = 'file:///Work/Shop';
		const original = workspaceRecord(a, temp.dir);
		keepWorkspaceUri(a, original, temp.dir);
		assert.strictEqual(workspaceRecord(a + '/', temp.dir).key, original.key);
		assert.strictEqual(workspaceRecord(a.toLowerCase(), temp.dir).key === original.key, process.platform !== 'linux');
		const file = path.join(temp.dir, 'workspace-uris.json');
		for (const value of ['{', 'null', '[]', '{"version":2,"bindings":{},"owners":{}}', '{"version":1,"bindings":{"file:///work":"0123456789abcdef"},"owners":{}}']) {
			fs.writeFileSync(file, value);
			assert.throws(() => workspaceRecord(a, temp.dir, original.key));
			assert.throws(() => keepWorkspaceUri(a, original, temp.dir));
			assert.strictEqual(fs.readFileSync(file, 'utf8'), value);
		}
	});

	test('D70: a window whose extensions restart finds the key it claimed its runs under, by its editor session, while it still has the folder it had first; another session, another window\'s folders or a broken record find none', () => {
		const key = workspaceRecord('file:///work/shop', temp.dir).key;
		keepWindowKey('session-1', key, ['file:///work/shop'], temp.dir);
		const broken = path.join(temp.dir, 'windows', 'broken.json');
		fs.writeFileSync(broken, '{');
		assert.deepStrictEqual([
			windowKeyOf('session-1', ['file:///work/shop', 'file:///work/docs'], temp.dir),
			windowKeyOf('session-2', ['file:///work/shop'], temp.dir),
			windowKeyOf('session-1', ['file:///work/docs'], temp.dir),
			windowKeyOf('session-1', [], temp.dir)
		], [key, undefined, undefined, undefined]);
		// What a window said a month ago goes when another says something
		fs.utimesSync(broken, new Date(Date.now() - 31 * 24 * 60 * 60_000), new Date(Date.now() - 31 * 24 * 60 * 60_000));
		keepWindowKey('session-2', key, ['file:///work/docs'], temp.dir);
		assert.deepStrictEqual([fs.existsSync(broken), windowKeyOf('session-2', ['file:///work/docs'], temp.dir)], [false, key]);
	});
});
