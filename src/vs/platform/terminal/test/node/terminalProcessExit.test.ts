/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ok, strictEqual } from 'assert';
import { spawn } from 'child_process';
import { once } from 'events';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TerminalProcessExitMonitor } from '../../node/terminalProcessExit.js';

suite('TerminalProcessExitMonitor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('waits for a real child after its parent exits, and retains its identity after a timeout', async () => {
		const parent = spawn(process.execPath, ['-e', `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 6000)'], { stdio: 'ignore', env: process.env });
console.log(child.pid);
setInterval(() => {}, 1000);
`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let childPid: number | undefined;
		try {
			const [ready] = await once(parent.stdout, 'data');
			childPid = Number(String(ready).trim());
			ok(Number.isSafeInteger(childPid) && childPid > 0);
			ok(parent.pid);
			const monitor = await TerminalProcessExitMonitor.create(parent.pid);
			ok(monitor);
			strictEqual(await monitor.wait(50), false, 'live native processes must not be reported ended');
			const exited = once(parent, 'exit');
			parent.kill();
			await exited;
			if (!isWindows) {
				strictEqual(await monitor.wait(50), false, 'the child still holds resources after its shell exits');
			}
			strictEqual(await monitor.wait(10000), true, 'an explicit retry observes the original child ending');
		} finally {
			parent.kill();
		}
	}).timeout(30000);
});
