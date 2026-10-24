/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({
	options: {
		campaign: { type: 'string' }, target: { type: 'string' }, record: { type: 'string' },
		commit: { type: 'string' }, tool: { type: 'string' }, args: { type: 'string', default: '{}' },
		label: { type: 'string' }
	}
});
if (!values.campaign || !values.target || !['linux', 'windows'].includes(values.target) || !values.record || !values.tool ||
	!values.commit || !/^[a-f0-9]{40}$/.test(values.commit) || !values.label || !/^[a-z0-9-]+$/.test(values.label)) {
	throw new Error('Usage: control.ts --campaign <dir> --target linux|windows --record <actual record> --commit <sha> --tool <tool> --args <JSON> --label <evidence name>');
}
const args = JSON.stringify(JSON.parse(values.args));
const campaign = resolve(values.campaign);
const output = join(campaign, 'mcp', values.label + '.json');
mkdirSync(join(campaign, 'mcp'), { recursive: true, mode: 0o700 });
const leaf = 'request-' + randomUUID() + '.json';
const quote = (text: string) => `'` + text.replaceAll(`'`, `'\\''`) + `'`;
const psQuote = (text: string) => `'` + text.replaceAll(`'`, `''`) + `'`;
const ssh = ['-F', join(campaign, 'auth/ssh_config'), '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR',
	'-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', `facade-test-${values.target}`];
let input;
if (values.target === 'linux') {
	const home = '/home/aaron/facade-ssh-test-20261023';
	const temporary = home + '/control/' + leaf;
	input = `set -eu\numask 077\nbase64 -d > ${quote(temporary)} <<'FACADE_REQUEST'\n${Buffer.from(args).toString('base64')}\nFACADE_REQUEST\ntrap 'rm -f ${quote(temporary)}' EXIT\n` +
		['/home/aaron/.local/bin/node', home + '/control/live-mcp.ts', '--client', home + '/control/mcpClient.cjs',
			'--shim', home + '/server-data/bin/' + values.commit + '/extensions/facade-agents/dist/shim.js',
			'--record', values.record, '--tool', values.tool, '--args-file', temporary].map(quote).join(' ') + '\n';
	ssh.push('bash -s');
} else {
	const home = 'C:\\fssh24-a447';
	const temporary = home + '\\control\\' + leaf;
	const command = [
		`$ErrorActionPreference='Stop'`, `$ProgressPreference='SilentlyContinue'`,
		'[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)', '$OutputEncoding=[Console]::OutputEncoding',
		`[IO.File]::WriteAllBytes(${psQuote(temporary)},[Convert]::FromBase64String('${Buffer.from(args).toString('base64')}'))`,
		'try {',
		'& ' + ['C:\\Users\\y5ez3\\.local\\node\\node.exe', home + '\\control\\live-mcp.ts', '--client', home + '\\control\\mcpClient.cjs',
			'--shim', home + '\\server-data\\bin\\' + values.commit + '\\extensions\\facade-agents\\dist\\shim.js',
			'--record', values.record, '--tool', values.tool, '--args-file', temporary].map(psQuote).join(' '),
		'$resultCode=$LASTEXITCODE', '} finally { Remove-Item -LiteralPath ' + psQuote(temporary) + ' -ErrorAction SilentlyContinue }',
		'exit $resultCode'
	].join('\n');
	const encoded = Buffer.from(command, 'utf16le').toString('base64');
	if (encoded.length > 7400) { throw new Error('Request too long for the Windows command line. Use an uploaded args file.'); }
	ssh.push('powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded);
}
const result = spawnSync('ssh', ssh, { input, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
writeFileSync(output, result.stdout || '', { mode: 0o600 });
if (result.stderr) { writeFileSync(output + '.stderr', result.stderr, { mode: 0o600 }); }
if (result.error) { throw result.error; }
if (result.status !== 0) {
	console.error((result.stdout || result.stderr).slice(-3000));
	process.exitCode = result.status || 1;
} else {
	const response = JSON.parse(readFileSync(output, 'utf8'));
	console.log(JSON.stringify({ output, isError: response.isError, text: response.text?.slice(0, 3000), data: response.data }));
	if (response.isError) { process.exitCode = 1; }
}
