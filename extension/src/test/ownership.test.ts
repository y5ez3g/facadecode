/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { LOCAL_OWNER_GRACE_MS, OwnerClaims, OWNER_GRACE_MS, type OwnerClock } from '../ptyd/ownership';
import { isCurrentOwner, nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { tempDir } from './util';

/** Keeps canceled callbacks too, to exercise a callback already queued when reconnection cancels its timer. */
function fixture() {
	const timers: { ms: number; callback: () => void; canceled: boolean }[] = [];
	const events: string[] = [];
	const clock: OwnerClock = { after: (ms, callback) => {
		const timer = { ms, callback, canceled: false };
		timers.push(timer);
		return { dispose: () => timer.canceled = true };
	} };
	const owners = new OwnerClaims<string>((owner, connection) => events.push(`transfer ${owner} ${connection}`), (owner, why) => events.push(why === 'absent' ? `expire ${owner}` : `expire ${owner} ${why}`), clock);
	const claim = (generation: number, owner = 'workspace') => ({ owner, generation, token: `activation-${generation}` });
	return { owners, timers, events, claim };
}

suite('Workspace ownership: one activation, fenced reconnect and five-minute cleanup', () => {
	test('an old activation cannot retake ownership by reconnecting or repeating its claim', () => {
		const { owners, events, claim } = fixture();
		owners.claim(claim(1), 'old');
		owners.claim(claim(2), 'new');
		assert.throws(() => owners.claim(claim(1), 'late'), /transferred or expired/);
		assert.throws(() => owners.assert('workspace', 'old'), /transferred or expired/);
		owners.assert('workspace', 'new');
		assert.deepStrictEqual(events, ['transfer workspace old']);
	});

	test('a lost claim reply can be resumed idempotently without transferring to another activation', () => {
		const { owners, events, timers, claim } = fixture();
		owners.claim(claim(1), 'socket-1');
		owners.claim(claim(1), 'socket-1');
		owners.disconnect('socket-1');
		owners.claim(claim(1), 'socket-2');
		timers[0].callback();
		owners.assert('workspace', 'socket-2');
		assert.deepStrictEqual([events, timers.map(timer => [timer.ms, timer.canceled])], [[], [[OWNER_GRACE_MS, true]]]);
	});

	test('old disconnect and a queued old timer do not end a successor; each workspace expires independently', () => {
		const { owners, timers, events, claim } = fixture();
		owners.claim(claim(1), 'old');
		owners.disconnect('old');
		owners.claim(claim(2), 'new');
		owners.disconnect('old');
		owners.claim(claim(1, 'other'), 'other');
		owners.disconnect('other');
		timers.forEach(timer => timer.callback());
		assert.deepStrictEqual(events, ['expire other']);
		owners.assert('workspace', 'new');
	});

	test('expiry is irreversible for that activation; a new activation may open the now-empty workspace', () => {
		const { owners, timers, events, claim } = fixture();
		owners.claim(claim(1), 'old');
		owners.disconnect('old');
		timers[0].callback();
		assert.throws(() => owners.claim(claim(1), 'too-late'), /expired/);
		owners.claim(claim(2), 'new');
		owners.assert('workspace', 'new');
		assert.deepStrictEqual(events, ['expire workspace']);
	});

	test('network loss that leaves the remote extension-host socket connected starts no timer', () => {
		const { owners, timers, claim } = fixture();
		owners.claim(claim(1), 'remote-extension-host');
		assert.deepStrictEqual(timers, []);
		owners.assert('workspace', 'remote-extension-host');
	});

	// The owner closed a local window and opened its workspace again seconds later: its agents were still there, taken over by the
	// new window as a reload's would be. Five minutes are for a remote window's lost network, never for a local window (2026-11-03)
	test('a local window gone and another window opening its workspace: that one was closed, and its runs end at once, never taken over (RULES-4.1)', () => {
		const { owners, timers, events, claim } = fixture();
		const local = (generation: number, window: string) => ({ ...claim(generation), window, local: true });
		owners.claim(local(1, 'win-a'), 'first');
		owners.disconnect('first');
		assert.deepStrictEqual(timers.map(timer => timer.ms), [LOCAL_OWNER_GRACE_MS], 'a local window\'s grace is the reload\'s, not five minutes');
		owners.claim(local(2, 'win-b'), 'second');
		assert.deepStrictEqual(events, ['expire workspace closed'], 'ended, not transferred');
		assert.strictEqual(timers[0].canceled, true);
		owners.assert('workspace', 'second');
		// Its queued timer cannot end the new window's
		timers[0].callback();
		assert.deepStrictEqual(events, ['expire workspace closed']);
	});

	test('a local window reloaded - the same window, gone a moment - claims its runs again; one still connected hands them to another window (RULES-4.1)', () => {
		const reload = fixture();
		const local = (generation: number, window: string) => ({ ...reload.claim(generation), window, local: true });
		reload.owners.claim(local(1, 'win-a'), 'before');
		reload.owners.disconnect('before');
		reload.owners.claim(local(2, 'win-a'), 'after');
		reload.owners.assert('workspace', 'after');
		assert.deepStrictEqual([reload.events, reload.timers.map(timer => timer.canceled)], [[], [true]]);
		// Two windows of one workspace, the first still there: the second takes its runs over, ending none
		const both = fixture();
		both.owners.claim({ ...both.claim(1), window: 'win-a', local: true }, 'first');
		both.owners.claim({ ...both.claim(2), window: 'win-b', local: true }, 'second');
		assert.deepStrictEqual(both.events, ['transfer workspace first']);
	});

	test('a remote window keeps its five minutes, and a reopened window takes its runs over as before; a window that cannot know its identity too (RULES-4.1)', () => {
		const remote = fixture();
		remote.owners.claim({ ...remote.claim(1), window: 'win-a', local: false }, 'remote-extension-host');
		remote.owners.disconnect('remote-extension-host');
		remote.owners.claim({ ...remote.claim(2), window: 'win-b', local: false }, 'reopened');
		assert.deepStrictEqual([remote.timers.map(timer => [timer.ms, timer.canceled]), remote.events], [[[OWNER_GRACE_MS, true]], []]);
		remote.owners.assert('workspace', 'reopened');
		const unknown = fixture();
		unknown.owners.claim({ ...unknown.claim(1), local: true }, 'no-identity');
		unknown.owners.disconnect('no-identity');
		unknown.owners.claim({ ...unknown.claim(2), window: 'win-b', local: true }, 'next');
		assert.deepStrictEqual(unknown.events, []);
		assert.throws(() => unknown.owners.claim({ ...unknown.claim(3), window: 7 } as never, 'odd'), /Invalid workspace ownership claim/);
	});

	test('the same generation with a different token is refused, and disposal disarms queued timers', () => {
		const { owners, timers, events, claim } = fixture();
		owners.claim(claim(1), 'old');
		assert.throws(() => owners.claim({ ...claim(1), token: 'different' }, 'fake'), /transferred or expired/);
		owners.disconnect('old');
		owners.dispose();
		timers[0].callback();
		assert.deepStrictEqual(events, []);
	});

	test('activation generations are durable, monotonic and workspace-qualified; damaged state never resets the fence', () => {
		const temp = tempDir('fc-ownership-');
		try {
			const first = nextOwnerClaim('a', temp.dir);
			const second = nextOwnerClaim('a', temp.dir);
			const other = nextOwnerClaim('b', temp.dir);
			assert.deepStrictEqual([first.generation, second.generation, other.generation, isCurrentOwner(first, temp.dir), isCurrentOwner(second, temp.dir)], [1, 2, 1, false, true]);
			for (const file of fs.readdirSync(path.join(temp.dir, 'claims'))) {
				fs.writeFileSync(path.join(temp.dir, 'claims', file), '{}');
			}
			assert.throws(() => nextOwnerClaim('a', temp.dir), /Invalid workspace ownership generation/);
		} finally {
			temp.remove();
		}
	});

	test('a successor waits for an in-flight owned disk write, then supersedes it; a stale writer cannot overwrite it', async () => {
		const temp = tempDir('fc-write-fence-');
		const first = nextOwnerClaim('workspace', temp.dir);
		const file = path.join(temp.dir, 'state.json');
		const held = path.join(temp.dir, 'held');
		const release = path.join(temp.dir, 'release');
		const module = require.resolve('../record/ownership');
		const launch = (code: string) => {
			const child = spawn(process.execPath, ['-e', code], { stdio: 'pipe' });
			let error = '';
			child.stderr.on('data', chunk => error += chunk);
			const done = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `exit ${code}`))));
			return { child, done };
		};
		const prefix = `const fs=require('fs'), o=require(${JSON.stringify(module)}), home=${JSON.stringify(temp.dir)}, file=${JSON.stringify(file)};`;
		const old = launch(`${prefix}o.writeAsOwner(${JSON.stringify(first)},home,()=>{fs.writeFileSync(${JSON.stringify(held)},'held');const end=Date.now()+4000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}fs.writeFileSync(file,'old');});`);
		let successor: ReturnType<typeof launch> | undefined;
		try {
			const end = Date.now() + 3_000;
			while (!fs.existsSync(held)) {
				assert.ok(Date.now() < end, 'old writer acquired its lock');
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			successor = launch(`${prefix}const claim=o.nextOwnerClaim('workspace',home);o.writeAsOwner(claim,home,()=>fs.writeFileSync(file,'new'));`);
			await new Promise(resolve => setTimeout(resolve, 150));
			assert.strictEqual(isCurrentOwner(first, temp.dir), true, 'allocation waits while the previous atomic write owns the lock');
			fs.writeFileSync(release, 'go');
			await Promise.all([old.done, successor.done]);
			writeAsOwner(first, temp.dir, () => fs.writeFileSync(file, 'stale'));
			assert.deepStrictEqual([isCurrentOwner(first, temp.dir), fs.readFileSync(file, 'utf8')], [false, 'new']);
		} finally {
			old.child.kill();
			successor?.child.kill();
			temp.remove();
		}
	});

	test('an owned write says whether it wrote; a claim record that cannot be read fails it, never taken for another owner (LIFECYCLE-3.4)', () => {
		const temp = tempDir('fc-owned-write-');
		try {
			const first = nextOwnerClaim('workspace', temp.dir);
			let writes = 0;
			assert.strictEqual(writeAsOwner(first, temp.dir, () => writes++), true);
			nextOwnerClaim('workspace', temp.dir);
			assert.strictEqual(writeAsOwner(first, temp.dir, () => writes++), false, 'a successor owns it: nothing written, and said so');
			const other = nextOwnerClaim('other', temp.dir);
			const record = fs.readdirSync(path.join(temp.dir, 'claims')).map(name => path.join(temp.dir, 'claims', name)).find(file => file.endsWith('.json') && fs.readFileSync(file, 'utf8').includes('"other"'))!;
			fs.rmSync(record);
			fs.mkdirSync(record);
			assert.throws(() => writeAsOwner(other, temp.dir, () => writes++));
			assert.strictEqual(writes, 1);
		} finally {
			temp.remove();
		}
	});
});
