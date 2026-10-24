/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		client: { type: 'string' },
		shim: { type: 'string' },
		record: { type: 'string' },
		tool: { type: 'string' },
		'args-file': { type: 'string' },
		output: { type: 'string' },
		'timeout-ms': { type: 'string', default: '180000' }
	}
});
if (!values.client || !values.shim || !values.record) {
	throw new Error('Usage: node live-mcp.ts --client <compiled real stdio client> --shim <installed product shim> --record <record> [--tool <tool> --args-file <JSON file>] [--output <JSON file>]');
}
const timeout = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeout) || timeout <= 0) {
	throw new Error('timeout-ms must be a positive integer.');
}
const require = createRequire(import.meta.url);
const { StdioMcpClient } = require(resolve(values.client));
const record = resolve(values.record);
// Use the product's own record, private @human token and installed MCP shim.
// Clearing inherited agent variables prevents another workspace from winning.
const client = StdioMcpClient.start([
	'--record', record, '--token-file', join(record, 'you.token')
], { FACADE_AGENTS_RECORD: '', FACADE_AGENTS_PIPE: '', FACADE_AGENTS_TOKEN: '' }, resolve(values.shim));

let timer;
try {
	const operation = async () => {
		await client.initialize();
		return values.tool ? client.call(values.tool, values['args-file'] ? JSON.parse(readFileSync(resolve(values['args-file']), 'utf8')) : {}) : client.tools();
	};
	const result = await Promise.race([
		operation(),
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Live MCP request timed out; inspect actual effects before retrying.')), timeout); })
	]);
	const text = JSON.stringify(result, null, 2) + '\n';
	if (values.output) {
		writeFileSync(resolve(values.output), text, { mode: 0o600 });
	}
	console.log(text);
	if (result?.isError) {
		process.exitCode = 1;
	}
} finally {
	clearTimeout(timer);
	await client.stop();
}
