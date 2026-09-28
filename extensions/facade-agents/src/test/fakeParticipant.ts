/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/*
 * An agent for the workspace tests: a real process that starts Facade's MCP server the way an agent
 * CLI would, from the launch it was given, and follows a script.
 *
 *   FACADE_FAKE_MCP      the MCP server launch: { command, args, env }
 *   FACADE_FAKE_SCRIPT   steps, in order:
 *                          { "call": tool, "args": {...} }     a tool call; "{prompt}" in a string
 *                                                              stands for the prompt it was given
 *                          { "file": path, "content": text }   a file written in its folder
 *                          { "print": text }                   a line on stdout, as a JSON stream would
 *                          { "sleep": ms }
 *                          { "line": true }                    waits for a line typed into it, as
 *                                                              into its terminal, and records it
 *                          { "wait": true }                    stays until it is killed
 *                          { "exit": code }
 *   FACADE_FAKE_PROMPT   the prompt, as the launch passed it
 *   FACADE_FAKE_OUT      a file each call's result text is appended to, one JSON line per call
 */

/** One step of a script: the one field set says which. */
interface Step {
	readonly call?: string;
	readonly args?: Record<string, unknown>;
	readonly file?: string;
	readonly content?: string;
	readonly print?: string;
	readonly sleep?: number;
	readonly line?: true;
	readonly wait?: true;
	readonly exit?: number;
}

/** The lines typed into this process, in order, each taken once. */
const typedLines: string[] = [];
const waitingForLine: ((line: string) => void)[] = [];
let partialLine = '';

function listenForLines(): void {
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk: string) => {
		partialLine += chunk;
		let newline: number;
		while ((newline = partialLine.indexOf('\n')) >= 0) {
			const line = partialLine.slice(0, newline).replace(/\r$/, '');
			partialLine = partialLine.slice(newline + 1);
			const waiting = waitingForLine.shift();
			if (waiting) {
				waiting(line);
			} else {
				typedLines.push(line);
			}
		}
	});
}

function nextLine(): Promise<string> {
	const line = typedLines.shift();
	return line !== undefined ? Promise.resolve(line) : new Promise(resolve => waitingForLine.push(resolve));
}

class Client {

	private nextId = 1;
	private buffer = '';
	private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

	constructor(private readonly child: ChildProcess) {
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			this.buffer += chunk;
			let newline: number;
			while ((newline = this.buffer.indexOf('\n')) >= 0) {
				const message = JSON.parse(this.buffer.slice(0, newline));
				this.buffer = this.buffer.slice(newline + 1);
				if (typeof message.id === 'number') {
					this.pending.get(message.id)?.(message);
					this.pending.delete(message.id);
				}
			}
		});
	}

	request(method: string, params: object): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
			this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}
}

function substitute(value: unknown, prompt: string): unknown {
	if (typeof value === 'string') {
		return value.split('{prompt}').join(prompt);
	}
	if (Array.isArray(value)) {
		return value.map(item => substitute(item, prompt));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, prompt)]));
	}
	return value;
}

async function main(): Promise<number> {
	const launch = JSON.parse(process.env.FACADE_FAKE_MCP!) as { command: string; args: string[]; env: Record<string, string> };
	const steps = JSON.parse(process.env.FACADE_FAKE_SCRIPT ?? '[]') as Step[];
	const prompt = process.env.FACADE_FAKE_PROMPT ?? '';
	const out = process.env.FACADE_FAKE_OUT;
	if (steps.some(step => step.line)) {
		listenForLines();
	}
	const server = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] });
	const client = new Client(server);
	await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-participant', version: '1' } });
	try {
		for (const step of steps) {
			if (step.call !== undefined) {
				const result = await client.request('tools/call', { name: step.call, arguments: substitute(step.args ?? {}, prompt) }) as { content: { text: string }[]; isError?: boolean };
				if (out) {
					fs.appendFileSync(out, `${JSON.stringify({ call: step.call, text: result.content.map(item => item.text).join('\n'), isError: !!result.isError })}\n`);
				}
			} else if (step.file !== undefined) {
				fs.mkdirSync(path.dirname(path.resolve(step.file)), { recursive: true });
				fs.writeFileSync(step.file, step.content ?? '');
			} else if (step.print !== undefined) {
				process.stdout.write(`${step.print}\n`);
			} else if (step.sleep !== undefined) {
				await new Promise(resolve => setTimeout(resolve, step.sleep));
			} else if (step.line) {
				const line = await nextLine();
				if (out) {
					fs.appendFileSync(out, `${JSON.stringify({ call: 'line', text: line, isError: false })}\n`);
				}
			} else if (step.wait) {
				await new Promise(() => { /* until killed */ });
			} else if (step.exit !== undefined) {
				return step.exit;
			}
		}
		return 0;
	} finally {
		server.stdin!.end();
		server.kill();
	}
}

main().then(code => process.exit(code), err => {
	process.stderr.write(`fake participant: ${(err as Error).stack}\n`);
	process.exit(1);
});
