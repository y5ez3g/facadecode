/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade MCP server of one run, `facade`: `node shim.js`, started by the run's CLI as a stdio server (MCP-6.1, CLIS-2.2), run by
// the extension host's own binary as Node. The run it speaks for and ptyd's socket come in its environment - addresses, never
// credentials. Newline-delimited JSON-RPC on stdin and stdout; stderr carries diagnostics alone. It ends as its stdin does.

import * as fs from 'fs';
import * as path from 'path';
import { lineReader } from '../base/lines';
import { SHIM_AGENT, SHIM_PTYD, SHIM_RUN } from './launch';
import { McpShim } from './mcpServer';
import { PtydLink } from './ptydLink';

/** The extension's version, from the manifest beside `dist/`; `unknown` where there is none to read. */
function versionOf(): string {
	try {
		const version: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
		return typeof version === 'string' && version ? version : 'unknown';
	} catch {
		return 'unknown';
	}
}

const log = (line: string) => process.stderr.write(`facade: ${line}\n`);
const link = new PtydLink(process.env[SHIM_PTYD] ?? '', process.env[SHIM_RUN] ?? '');
const shim = new McpShim({
	alias: process.env[SHIM_AGENT] ?? '',
	version: versionOf(),
	link,
	write: message => process.stdout.write(JSON.stringify(message) + '\n'),
	log
});

// Its client gone, nothing it writes is read: it ends
process.stdout.on('error', () => process.exit(0));
// A request longer than one line may be is answered and skipped; the requests after it are read as ever
process.stdin.on('data', lineReader(line => shim.receive(line), err => shim.oversized(err), { oversized: 'skip' }));
// The client closed its input: what it asked is answered, written out, and the shim ends (calls a window took go on there)
process.stdin.on('end', () => void shim.idle().then(() => {
	link.dispose();
	process.stdout.write('', () => process.exit(0));
}));
