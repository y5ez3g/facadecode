/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { writeSync } from 'fs';
import { spawn } from 'node-pty';
import { until } from './editors';

/** Prove the isolated Shell Attach took the editor's input and detached with Ctrl+]. */
async function attach(): Promise<void> {
	const [facade, address, marker] = process.argv.slice(2);
	const terminal = spawn(facade, ['attach', address], { cwd: process.cwd(), env: process.env, cols: 90, rows: 24, name: 'xterm-256color' });
	let output = '';
	let exitCode: number | undefined;
	const data = terminal.onData(chunk => { output += chunk; });
	const exit = terminal.onExit(event => { exitCode = event.exitCode; });
	try {
		await until('the Shell Attach to show the editor input', () => {
			assert.strictEqual(exitCode, undefined, output);
			return output.includes(marker) || undefined;
		});
		terminal.write('\x1d');
		assert.strictEqual(await until('Ctrl+] to detach from the terminal', () => exitCode), 0, output);
	} finally {
		data.dispose();
		exit.dispose();
		if (exitCode === undefined) { terminal.kill(); }
	}
}

// Windows node-pty can retain its native console worker after the child exited.
// This fixture owns that worker and exits with the assertions' result so the editor runner can continue its own cleanup.
void attach().then(() => process.exit(0), error => {
	writeSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
