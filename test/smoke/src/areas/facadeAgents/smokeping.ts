/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A fake agent CLI for the Facade agents smoke test: starts its MCP server from
// `--mcp-config <file>` - the `mcpServers.facade` entry Facade wrote for the run,
// the way a real CLI starts the server it was configured with - initializes it
// like one, so it says hello to the window (without a first request it never
// does), prints `smokeping ready`, then echoes each stdin line as `got:<line>`,
// until it is killed.
async function main(): Promise<void> {
	const at = process.argv.indexOf('--mcp-config');
	if (at < 0 || !process.argv[at + 1]) {
		process.stderr.write('smokeping: no --mcp-config given\n');
		process.exit(3);
	}
	let server;
	try {
		const entry = JSON.parse(readFileSync(process.argv[at + 1], 'utf8')).mcpServers.facade;
		server = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	} catch (err) {
		process.stderr.write(`smokeping: cannot start its MCP server: ${(err as Error).message}\n`);
		process.exit(3);
	}
	// A server that never launches is fatal: exit, so the start fails at once
	// instead of waiting for a hello that never comes. One that exits later is
	// said on the screen; the echo goes on.
	server.on('error', (err) => {
		process.stdout.write(`smokeping: server error: ${err.message}\n`);
		process.exit(3);
	});
	server.on('exit', (code, signal) => process.stdout.write(`smokeping: server exited ${code} ${signal}\n`));
	// What the server says on its stderr is said on the screen, so a start that
	// fails for the server's sake fails with its reason, not with silence.
	let errBuffered = '';
	server.stderr.setEncoding('utf8');
	server.stderr.on('data', (chunk) => {
		errBuffered += chunk;
		let newline;
		while ((newline = errBuffered.indexOf('\n')) >= 0) {
			process.stdout.write(`server: ${errBuffered.slice(0, newline).replace(/\r$/, '')}\n`);
			errBuffered = errBuffered.slice(newline + 1);
		}
	});
	const die = () => {
		try { server.kill(); } catch { /* gone already */ }
		process.exit(0);
	};
	process.on('SIGTERM', die);
	process.on('SIGINT', die);
	process.stdin.on('end', die);

	// The MCP leg: one request and its answer, like every CLI's first.
	const pending = new Map();
	let inBuffered = '';
	server.stdout.setEncoding('utf8');
	server.stdout.on('data', (chunk) => {
		inBuffered += chunk;
		let newline;
		while ((newline = inBuffered.indexOf('\n')) >= 0) {
			const line = inBuffered.slice(0, newline);
			inBuffered = inBuffered.slice(newline + 1);
			if (!line.trim()) {
				continue;
			}
			try {
				const message = JSON.parse(line);
				if (message.id !== undefined && pending.has(message.id)) {
					pending.get(message.id)(message);
					pending.delete(message.id);
				}
				// Anything else - a notification - is nothing to answer.
			} catch {
				process.stdout.write(`server: not JSON: ${line}\n`);
			}
		}
	});
	const answered = new Promise((resolve) => pending.set(1, resolve));
	server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smokeping', version: '0.0.0' } } }) + '\n');
	const responded = await Promise.race([
		answered,
		new Promise((resolve) => setTimeout(() => resolve(undefined), 60_000)),
	]);
	if (!responded) {
		process.stdout.write('smokeping: server never answered initialize\n');
		process.exit(3);
	}
	if ((responded as { error?: unknown }).error) {
		process.stdout.write(`smokeping: server refused initialize: ${JSON.stringify((responded as { error?: unknown }).error)}\n`);
		process.exit(3);
	}
	server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
	process.stdout.write('smokeping ready\n');
	let buffered = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		buffered += chunk;
		let newline;
		while ((newline = buffered.indexOf('\n')) >= 0) {
			const line = buffered.slice(0, newline).replace(/\r$/, '');
			buffered = buffered.slice(newline + 1);
			process.stdout.write(`got:${line}\n`);
		}
	});
	process.stdin.resume();
}

main().catch((err: Error) => {
	process.stderr.write(`smokeping: ${err?.message ?? err}\n`);
	process.exit(3);
});
