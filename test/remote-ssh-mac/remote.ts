/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Executes actual scripts through the campaign's authenticated OpenSSH connections.
// This is a control connection, not an application test or a simulated remote host.
const { values } = parseArgs({
	options: {
		campaign: { type: 'string' },
		target: { type: 'string' },
		script: { type: 'string' },
		'timeout-ms': { type: 'string', default: '1800000' }
	}
});

if (!values.campaign || !values.script || !values.target || !['linux', 'windows'].includes(values.target)) {
	throw new Error('Usage: node remote.ts --campaign <directory> --target linux|windows --script <file> [--timeout-ms <milliseconds>]');
}

const timeout = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeout) || timeout <= 0) {
	throw new Error('timeout-ms must be a positive integer.');
}

const script = readFileSync(resolve(values.script), 'utf8');
const args = [
	'-F', resolve(values.campaign, 'auth/ssh_config'),
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=10',
	'-o', 'LogLevel=ERROR',
	'-o', 'ServerAliveInterval=15',
	'-o', 'ServerAliveCountMax=4',
	`facade-test-${values.target}`
];

if (values.target === 'windows') {
	const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n$OutputEncoding=[Console]::OutputEncoding\n` + script, 'utf16le').toString('base64');
	const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded;
	if (command.length > 7500) {
		throw new Error('Control script exceeds the Windows command limit. Upload it as a test file and invoke that file explicitly.');
	}
	args.push(command);
} else {
	args.push('bash -s');
}

const child = spawn('ssh', args, { stdio: ['pipe', 'inherit', 'inherit'] });
let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	child.kill('SIGTERM');
}, timeout);

child.on('error', error => {
	clearTimeout(timer);
	console.error(error.message);
	process.exitCode = 1;
});

child.stdin.on('error', error => {
	if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
		console.error(error.message);
	}
});
child.stdin.end(values.target === 'linux' ? 'export PATH="$HOME/.local/bin:$PATH"\n' + script : undefined);
child.on('close', (code, signal) => {
	clearTimeout(timer);
	if (timedOut) {
		console.error('SSH control script timed out. Inspect remote effects before retrying.');
	} else if (signal) {
		console.error(`SSH control connection ended with ${signal}. Inspect remote effects before retrying.`);
	}
	process.exitCode = timedOut ? 124 : code ?? 1;
});
