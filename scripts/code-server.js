/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const cp = require('child_process');
const path = require('path');
const open = require('open');
const minimist = require('minimist');

async function main() {

	const args = minimist(process.argv.slice(2), {
		boolean: [
			'help',
			'launch'
		]
	});

	if (args.help) {
		console.log(
			'./scripts/code-server.sh|bat [options]\n' +
			' --launch              Opens a browser'
		);
		startServer(['--help']);
		return;
	}

	process.env['VSCODE_SERVER_PORT'] = '9888';

	const serverArgs = process.argv.slice(2).filter(v => v !== '--launch');
	const addr = await startServer(serverArgs);
	if (args['launch']) {
		open.default(addr);
	}
}

function startServer(programArgs) {
	return new Promise((s, e) => {
		const env = { ...process.env };
		const entryPoint = path.join(__dirname, '..', 'out', 'server-main.js');

		// With the test resolver's opt-in, broken pipes - the window that started
		// this launcher went away - end the forwarding, not the server: dying here
		// would kill it through the exit below, as a window that reloads would lose
		// every process it started. Without it, upstream behavior: the launcher
		// dies with its pipes and takes the server.
		if (process.env['TESTRESOLVER_KEEP_SERVER'] === '1') {
			process.stdout.on('error', () => { });
		}
		console.log(`Starting server: ${entryPoint} ${programArgs.join(' ')}`);
		const proc = cp.spawn(process.execPath, [entryPoint, ...programArgs], { env, stdio: [process.stdin, null, process.stderr] });
		// Its own id, for whoever started this launcher to tell the server by: this
		// launcher and its shell end with the pipes that started them, the server
		// outlives them.
		console.log(`Server process id: ${proc.pid}`);
		proc.stdout.on('data', e => {
			const data = e.toString();
			process.stdout.write(data);
			const m = data.match(/Web UI available at (.*)/);
			if (m) {
				s(m[1]);
			}
		});

		proc.on('exit', (code) => process.exit(code));

		process.on('exit', () => proc.kill());
		process.on('SIGINT', () => {
			proc.kill();
			process.exit(128 + 2); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
		});
		process.on('SIGTERM', () => {
			proc.kill();
			process.exit(128 + 15); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
		});
	});

}

main();
