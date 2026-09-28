/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';
import { escapeCmdArgument, OutputTail, runProcess } from '../common/spawn';
import { tempDir, write } from './util';

suite('spawn', () => {

	test('escapes arguments for cmd.exe the way cross-spawn does', () => {
		assert.deepStrictEqual(['plain', 'two words', 'a"quote', 'trail\\', 'a&b|c', '100%'].map(arg => escapeCmdArgument(arg, false)), [
			'^"plain^"',
			'^"two^ words^"',
			'^"a\\^"quote^"',
			'^"trail\\\\^"',
			'^"a^&b^|c^"',
			'^"100^%^"'
		]);
	});

	test('keeps the last lines of output without control sequences', () => {
		const tail = new OutputTail(2);
		tail.push('one\ntwo\n\x1b[31mthree\x1b[0m\nfour');
		assert.strictEqual(tail.toString(), 'three\nfour');
	});

	test('runs an argument array, reports its exit code, and kills it at its timeout', async function () {
		this.timeout(20_000);
		const passed = await runProcess([process.execPath, '-e', 'process.exit(3)'], { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 });
		const slow = await runProcess([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), env: process.env, timeoutMs: 300 });
		const missing = await runProcess(['facade-no-such-program-anywhere'], { cwd: process.cwd(), env: process.env, timeoutMs: 1000 });
		assert.deepStrictEqual({ exit: passed.exitCode, timedOut: slow.timedOut, missing: missing.spawnError !== undefined }, { exit: 3, timedOut: true, missing: true });
	});

	test('runs a batch file with arguments intact on Windows', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const temp = tempDir('facade-spawn-');
		try {
			const script = path.join(temp.dir, 'echo args.cmd');
			write(script, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
			let output = '';
			const result = await runProcess([script, 'two words', 'a&b', 'q"uote'], { cwd: temp.dir, env: process.env, timeoutMs: 10_000, onOutput: chunk => output += chunk.toString() });
			assert.deepStrictEqual({ exit: result.exitCode, args: JSON.parse(output.trim()) }, { exit: 0, args: ['two words', 'a&b', 'q"uote'] });
		} finally {
			temp.remove();
		}
	});
});
