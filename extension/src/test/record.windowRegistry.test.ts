/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WINDOW_NETWORK_PROTOCOL, type DirectoryAgent } from '../base/windowNetwork';
import { allocateNumbers, isAlive, registeredWindows, registerWindow, RegisteredWindow, registryOf, speaksOurs, unregisterWindow } from '../record/windowRegistry';
import { tempDir } from './util';

const AGENT: DirectoryAgent = { run: `run-${'1'.padStart(32, '0')}`, alias: '#a1', name: 'Ada', root: `run-${'1'.padStart(32, '0')}`, yolo: false, cli: 'claude', lifecycle: 'running' };

function entry(n: number, more: Partial<RegisteredWindow> = {}): RegisteredWindow {
	return {
		protocol: WINDOW_NETWORK_PROTOCOL,
		window: `win-${n.toString(16).padStart(16, '0')}`,
		socket: `/tmp/facade-window-test/${n}.sock`,
		pid: process.pid,
		label: `Window ${n}`,
		environment: 'local',
		agents: [],
		updatedAt: 1000 + n,
		...more
	};
}

/** The PID of a process that has ended: one this test started and waited for. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', '0']);
	assert.ok(child.pid, 'the child started');
	return child.pid;
}

suite('Window registry: the open windows of this computer and its alias counters (ARCHITECTURE-2.1, 3.1; RULES-1.1, 2.2)', () => {

	let home: ReturnType<typeof tempDir>;
	setup(() => home = tempDir('facade-registry-'));
	teardown(() => home.remove());

	test('a window registers whole and unregisters; entries list in address order', () => {
		const second = entry(2, { agents: [AGENT] });
		registerWindow(home.dir, second);
		registerWindow(home.dir, entry(1));
		assert.deepStrictEqual(registeredWindows(home.dir), [entry(1), second]);
		// Written again whole: a reader sees the old entry or the new one, never half of one
		registerWindow(home.dir, { ...second, label: 'Renamed', agents: [] });
		assert.deepStrictEqual(registeredWindows(home.dir).map(each => [each.window, each.label, each.agents.length]), [[entry(1).window, 'Window 1', 0], [second.window, 'Renamed', 0]]);
		unregisterWindow(home.dir, second.window);
		assert.deepStrictEqual(registeredWindows(home.dir).map(each => each.window), [entry(1).window]);
		// Gone already: nothing to do, and no failure
		unregisterWindow(home.dir, second.window);
		if (process.platform !== 'win32') {
			assert.strictEqual(fs.statSync(registryOf(home.dir)).mode & 0o077, 0, 'the registry folder is the person\'s alone');
		}
	});

	test('an address that is not a window\'s is refused before anything is written or removed', () => {
		for (const window of ['win-xyz', '../win-0000000000000001', 'win-00000000000000001', '']) {
			assert.throws(() => registerWindow(home.dir, entry(1, { window })), /is not a window address/);
			assert.throws(() => unregisterWindow(home.dir, window), /is not a window address/);
		}
		assert.deepStrictEqual(registeredWindows(home.dir), []);
	});

	test('no registry yet is no window; an unreadable entry, another file or an entry under another name is skipped, never guessed', () => {
		assert.deepStrictEqual(registeredWindows(home.dir), []);
		registerWindow(home.dir, entry(1));
		const folder = registryOf(home.dir);
		fs.writeFileSync(path.join(folder, `${entry(2).window}.json`), '{ not json');
		fs.writeFileSync(path.join(folder, `${entry(3).window}.json`), JSON.stringify({ ...entry(3), agents: [{ run: 'run-1' }] }));
		// An entry naming another window than its file is not taken for either
		fs.writeFileSync(path.join(folder, `${entry(4).window}.json`), JSON.stringify(entry(5)));
		fs.writeFileSync(path.join(folder, 'notes.txt'), 'not an entry');
		assert.deepStrictEqual(registeredWindows(home.dir).map(each => each.window), [entry(1).window]);
		// Skipped, not removed: what cannot be read is no proof that its window is gone
		assert.deepStrictEqual(fs.readdirSync(folder).sort(), [`${entry(1).window}.json`, `${entry(2).window}.json`, `${entry(3).window}.json`, `${entry(4).window}.json`, 'notes.txt'].sort());
	});

	test('the entry of a process that is gone is stale: removed as it is found; a live one stays', () => {
		const dead = deadPid();
		assert.strictEqual(isAlive(dead), false);
		assert.strictEqual(isAlive(process.pid), true);
		registerWindow(home.dir, entry(1, { pid: dead }));
		registerWindow(home.dir, entry(2));
		assert.deepStrictEqual(registeredWindows(home.dir).map(each => each.window), [entry(2).window]);
		assert.ok(!fs.existsSync(path.join(registryOf(home.dir), `${entry(1).window}.json`)), 'the stale entry is removed');
		// Whatever the liveness check says decides
		const asked: number[] = [];
		assert.deepStrictEqual(registeredWindows(home.dir, pid => { asked.push(pid); return false; }), []);
		assert.deepStrictEqual(asked, [process.pid]);
		assert.deepStrictEqual(fs.readdirSync(registryOf(home.dir)), []);
	});

	test('a window speaks ours only at this protocol', () => {
		assert.strictEqual(speaksOurs(entry(1)), true);
		assert.strictEqual(speaksOurs(entry(1, { protocol: WINDOW_NETWORK_PROTOCOL + 1 })), false);
		assert.strictEqual(speaksOurs(entry(1, { protocol: WINDOW_NETWORK_PROTOCOL - 1 })), false);
	});

	test('alias numbers: gapless within a take, never given twice across takes, each kind its own counter, and past `floor`', () => {
		assert.deepStrictEqual(allocateNumbers(home.dir, 'agent', 3), { first: 1, count: 3 });
		assert.deepStrictEqual(allocateNumbers(home.dir, 'agent', 2), { first: 4, count: 2 });
		// Messages are numbered apart from agents
		assert.deepStrictEqual(allocateNumbers(home.dir, 'message', 1), { first: 1, count: 1 });
		// A floor past the counter moves it there: numbers an earlier counter gave are never given again
		assert.deepStrictEqual(allocateNumbers(home.dir, 'agent', 1, 10), { first: 11, count: 1 });
		// A floor behind it changes nothing
		assert.deepStrictEqual(allocateNumbers(home.dir, 'agent', 2, 3), { first: 12, count: 2 });
		assert.deepStrictEqual(allocateNumbers(home.dir, 'agent', 1, 12.7), { first: 14, count: 1 });
		// Many takes in a row: no number twice
		const given = new Set<number>();
		for (let take = 0; take < 50; take++) {
			const { first, count } = allocateNumbers(home.dir, 'message', 1 + take % 4);
			for (let n = first; n < first + count; n++) {
				assert.ok(!given.has(n), `${n} was given twice`);
				given.add(n);
			}
		}
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home.dir, 'client-agent-numbers.json'), 'utf8')), { last: 14 });
	});

	test('a take of no number or of more than a thousand is refused; a counter that cannot be read stops it, never counting from nothing', () => {
		for (const count of [0, -1, 1001, 1.5, Number.NaN]) {
			assert.throws(() => allocateNumbers(home.dir, 'agent', count), /from 1 to 1000/);
		}
		const file = path.join(home.dir, 'client-message-numbers.json');
		for (const corrupt of ['not json', '{"last":-1}', '{"last":"7"}', '{"last":1.5}', '[]']) {
			fs.writeFileSync(file, corrupt);
			assert.throws(() => allocateNumbers(home.dir, 'message', 1), /does not hold a number; Facade gives no message number it may have given before/, corrupt);
		}
		// Left as it was: the next take after a repair goes on from the repaired value
		fs.writeFileSync(file, '{"last":41}');
		assert.deepStrictEqual(allocateNumbers(home.dir, 'message', 1), { first: 42, count: 1 });
	});
});
