/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The integration suite's Claude Code, run as Node in an agent's terminal. It records its working directory and arguments, then
// waits as an agent does.

import * as fs from 'fs';

const record = process.env.FACADE_IT_RECORD!;
const agent = process.env.FACADE_AGENT!;
const args = process.argv.slice(2);
fs.writeFileSync(`${record}.args.${agent}`, JSON.stringify({ cwd: process.cwd(), args }));
fs.writeFileSync(`${record}.${agent}`, `${process.pid}\n`);
process.stdout.write('fake agent ready\r\n');
setInterval(() => undefined, 60_000);
