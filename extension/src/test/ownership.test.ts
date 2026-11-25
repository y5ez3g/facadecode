/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { isCurrentOwner, nextOwnerClaim, writeAsOwner } from '../record/ownership';
import { tempDir } from './util';

suite('Workspace ownership: durable activation fencing', () => {
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
			fs.writeFileSync(record, JSON.stringify({ ...other, owner: first.owner }));
			assert.strictEqual(isCurrentOwner(other, temp.dir), false, 'the persisted owner must also match');
			assert.strictEqual(writeAsOwner(other, temp.dir, () => writes++), false);
			fs.rmSync(record);
			fs.mkdirSync(record);
			assert.throws(() => writeAsOwner(other, temp.dir, () => writes++));
			assert.strictEqual(writes, 1);
		} finally {
			temp.remove();
		}
	});
});
