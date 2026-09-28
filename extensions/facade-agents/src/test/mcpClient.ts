/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

/*
 * A test's side of an MCP server over stdio, the way an agent CLI speaks to it: the real shim,
 * started as a process.
 */

export interface ToolCallResult {
	readonly text: string;
	readonly isError: boolean;
	readonly data?: Record<string, unknown>;
}

export class StdioMcpClient {

	private nextId = 1;
	private buffer = '';
	private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	readonly progress: string[] = [];
	stderr = '';

	private constructor(readonly child: ChildProcess) {
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
				} else if (message.method === 'notifications/progress') {
					this.progress.push(String(message.params?.message ?? ''));
				}
			}
		});
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => this.stderr += chunk);
	}

	/** Starts `shim.js mcp` with the given arguments, as an agent's MCP configuration would. */
	static start(args: readonly string[], env: NodeJS.ProcessEnv = {}): StdioMcpClient {
		const shim = path.join(__dirname, '..', 'shim.js');
		const child = spawn(process.execPath, [shim, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
		return new StdioMcpClient(child);
	}

	request(method: string, params: object): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result as Record<string, unknown>));
			this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	async initialize(): Promise<Record<string, unknown>> {
		const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
		this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
		return result;
	}

	async tools(): Promise<string[]> {
		const result = await this.request('tools/list', {}) as { tools: { name: string }[] };
		return result.tools.map(tool => tool.name);
	}

	async call(name: string, args: object = {}): Promise<ToolCallResult> {
		const result = await this.request('tools/call', { name, arguments: args, _meta: { progressToken: `p${this.nextId}` } }) as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
		return { text: result.content.map(item => item.text).join('\n'), isError: !!result.isError, data: result.structuredContent };
	}

	stop(): Promise<void> {
		return new Promise(resolve => {
			if (this.child.exitCode !== null) {
				resolve();
				return;
			}
			this.child.once('exit', () => resolve());
			this.child.stdin!.end();
			setTimeout(() => this.child.kill(), 2000).unref();
		});
	}
}
