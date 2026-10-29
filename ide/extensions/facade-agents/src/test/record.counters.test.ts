/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MachineCounters } from '../record/counters';
import { facadeHome, injectedFile, workspacesRoot, worktreesRoot } from '../record/paths';
import { startedAnew, windowKey, windowsUnder } from '../transport/windows';
import { tempDir } from './util';

suite('Record: the machine\'s counters, key and windows', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-counters-');
	});

	teardown(() => {
		temp.remove();
	});

	test('the counters begin above the highest number any record gave, by its files or its ledger - which marks every number up to it as one two records may hold - and give each number once, above a record\'s own last too; a counters file that cannot be read is kept aside and made again the same way (L12; LA-23)', () => {
		const records = path.join(temp.dir, 'workspaces');
		const old = path.join(records, 'old');
		const fresh = path.join(records, 'fresh');
		fs.mkdirSync(old, { recursive: true });
		fs.mkdirSync(fresh, { recursive: true });
		fs.writeFileSync(path.join(old, 'last-id'), '7');
		fs.writeFileSync(path.join(old, 'ledger.jsonl'), `${JSON.stringify({ v: 6, seq: 1, time: 1, type: 'message.sent', id: 12, to: 'human', text: 'Hi.', length: 3 })}\n`);
		const file = path.join(temp.dir, 'counters.json');
		const counters = new MachineCounters(file, records);
		const given = [counters.next('agents', 0, fresh), counters.next('agents', 0, fresh), counters.next('messages', 0, fresh), counters.next('agents', 20, fresh)];
		const shared = [counters.shared('agents'), counters.shared('messages')];
		fs.writeFileSync(file, '{ not json');
		const again = counters.next('agents', 0, fresh);

		assert.deepStrictEqual({ given, shared, again, kept: fs.readdirSync(temp.dir).some(name => name.startsWith('counters.json.unreadable-')) }, {
			given: [8, 9, 13, 21],
			shared: [7, 12],
			again: 8,
			kept: true
		});
	});

	test('a record an older version went on numbering - beyond the numbers this version knows it gave there - raises the shared mark to its last numbers as this version opens it; one numbered by this version alone does not (L2, L12; LA-23)', () => {
		const records = path.join(temp.dir, 'workspaces');
		const mine = path.join(records, 'mine');
		const older = path.join(records, 'older');
		fs.mkdirSync(mine, { recursive: true });
		fs.mkdirSync(older, { recursive: true });
		const counters = new MachineCounters(path.join(temp.dir, 'counters.json'), records);
		const given = [counters.next('agents', 0, mine), counters.next('agents', 0, older)];
		counters.join(mine);
		const untouched = counters.shared('agents');
		// The older version gives #a5 there, knowing nothing of the counters
		fs.writeFileSync(path.join(older, 'last-id'), '5');
		counters.join(older);

		assert.deepStrictEqual({ given, untouched, raised: counters.shared('agents'), next: counters.next('agents', 0, mine) }, {
			given: [1, 2],
			untouched: 0,
			raised: 5,
			next: 6
		});
	});

	test('the machine\'s window key is made once, readable by its user, and read by every window after; two making it at once end with one (O8)', () => {
		const file = path.join(temp.dir, 'home', 'window.key');
		const first = windowKey(file);
		const second = windowKey(file);

		assert.deepStrictEqual({ same: first === second, long: first.length >= 40 }, { same: true, long: true });
	});

	test('the workspaces of the machine are the records whose window.json is there, the caller\'s own aside: one whose application instance runs is there - answering or silent, its extension host gone for a reload too - one closing, or whose instance ended, or started anew under its id, is gone (O8)', async () => {
		const root = path.join(temp.dir, 'workspaces');
		const write = (name: string, pid: number, instance: { pid: number; start?: number }, closing = false) => {
			fs.mkdirSync(path.join(root, name), { recursive: true });
			fs.writeFileSync(path.join(root, name, 'window.json'), JSON.stringify({ pipe: `pipe-${name}`, pid, enabled: true, workspace: name, folder: `/src/${name}`, record: `${name}-1234-5678`, load: `${name}-load`, instance, ...(closing ? { closing } : {}) }));
		};
		write('self', 1, { pid: 100, start: 1_000 });
		write('live', 2, { pid: 100, start: 1_000 });
		write('reloading', 3, { pid: 100, start: 1_000 });
		write('closing', 4, { pid: 100, start: 1_000 }, true);
		write('crashed', 5, { pid: 200, start: 1_000 });
		write('reused', 6, { pid: 300, start: 1_000 });
		const { found, gone } = windowsUnder(root, 'self-1234-5678', pid => [1, 2, 100, 300].includes(pid));
		const anew = await startedAnew(found, async pid => pid === 300 ? 90_000 : 1_000);

		assert.deepStrictEqual({ found: found.filter(each => !anew.includes(each)).map(each => `${each.record} ${each.label}`), gone: [...gone.map(each => `${each.record} ${each.closed ? 'closed' : 'crashed'} ${each.load}`), ...anew.map(each => `${each.record} crashed ${each.load}`)] }, {
			found: ['live-1234-5678 live (/src/live, live1234)', 'reloading-1234-5678 reloading (/src/reloading, reloadin)'],
			gone: ['closing-1234-5678 closed closing-load', 'crashed-1234-5678 crashed crashed-load', 'reused-1234-5678 crashed reused-load']
		});
	});

	test('FACADE_HOME puts the records, the worktrees, the counters and the key under another home; the record of what Facade put into the person\'s folders stays in theirs (O8; WT-2.1)', () => {
		const home = path.join(temp.dir, 'isolated');
		const before = process.env.FACADE_HOME;
		process.env.FACADE_HOME = home;
		try {
			assert.deepStrictEqual({ home: facadeHome(), records: workspacesRoot(), worktrees: worktreesRoot(), injected: injectedFile().startsWith(home) }, {
				home,
				records: path.join(home, 'workspaces'),
				worktrees: path.join(home, 'worktrees'),
				injected: false
			});
		} finally {
			if (before === undefined) {
				delete process.env.FACADE_HOME;
			} else {
				process.env.FACADE_HOME = before;
			}
		}
	});
});
