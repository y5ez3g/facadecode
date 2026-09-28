/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'stream';

/*
 * The MCP server each agent talks to over stdio: newline-delimited JSON-RPC 2.0. It implements the
 * part of the protocol a tools-only server needs - initialize, ping, tools/list, tools/call,
 * progress and cancellation - for the 2024-11-05 to 2025-11-25 revisions, which is what Claude Code
 * and Codex speak over stdio. A dual-era client probing with `server/discover` gets "method not
 * found" and falls back to `initialize`, as the 2026-07-28 revision tells clients to.
 *
 * Kept in-house rather than taking the SDK as a dependency: the surface is this small, and this
 * way the long-poll and progress behaviour the lead relies on is ours to test.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface JsonSchema {
	readonly type?: string | readonly string[];
	readonly description?: string;
	readonly properties?: { readonly [name: string]: JsonSchema };
	readonly required?: readonly string[];
	readonly items?: JsonSchema;
	readonly enum?: readonly (string | number)[];
	readonly additionalProperties?: boolean | JsonSchema;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly maxLength?: number;
	readonly default?: unknown;
}

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly annotations?: {
		readonly readOnlyHint?: boolean;
		readonly destructiveHint?: boolean;
		readonly idempotentHint?: boolean;
		readonly openWorldHint?: boolean;
	};
}

export interface McpToolResult {
	/** What the model reads. Complete on its own, for clients that ignore structured content. */
	readonly text: string;
	readonly data?: object;
	readonly isError?: boolean;
}

export interface McpCallContext {
	readonly signal: AbortSignal;
	progress(message: string): void;
}

export interface McpServerOptions {
	readonly name: string;
	readonly version: string;
	/** For the model: a string, or found when the client initializes, as when the window supplies it. */
	readonly instructions?: string | (() => Promise<string | undefined>);
	listTools(): Promise<readonly McpTool[]>;
	callTool(name: string, args: unknown, context: McpCallContext): Promise<McpToolResult>;
	/** Diagnostics; never stdout, which belongs to the protocol. */
	log?(message: string): void;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: JsonRpcId | null;
	readonly method?: string;
	readonly params?: { readonly [name: string]: unknown };
}

class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export class McpStdioServer {

	private protocolVersion: string | undefined;
	private readonly inFlight = new Map<JsonRpcId, AbortController>();
	private buffer = '';

	constructor(private readonly input: Readable, private readonly output: Writable, private readonly options: McpServerOptions) { }

	start(): Promise<void> {
		this.input.setEncoding('utf8');
		this.input.on('data', (chunk: string) => this.onData(chunk));
		return new Promise(resolve => this.input.on('end', () => {
			for (const controller of this.inFlight.values()) {
				controller.abort();
			}
			resolve();
		}));
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) {
				this.onLine(line);
			}
		}
	}

	private onLine(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			return;
		}
		if (Array.isArray(message) || typeof message !== 'object' || message === null) {
			this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported.' } });
			return;
		}
		if (typeof message.method !== 'string') {
			// A response to a request of ours; this server sends none.
			return;
		}
		if (message.id === undefined || message.id === null) {
			this.onNotification(message.method, message.params ?? {});
			return;
		}
		this.onRequest(message.id, message.method, message.params ?? {});
	}

	private onNotification(method: string, params: { readonly [name: string]: unknown }): void {
		if (method === 'notifications/cancelled') {
			const id = params.requestId;
			if (typeof id === 'string' || typeof id === 'number') {
				this.inFlight.get(id)?.abort();
			}
		}
	}

	private async onRequest(id: JsonRpcId, method: string, params: { readonly [name: string]: unknown }): Promise<void> {
		try {
			const result = await this.dispatch(id, method, params);
			if (this.inFlight.get(id)?.signal.aborted) {
				// A cancelled request gets no response.
				return;
			}
			this.send({ jsonrpc: '2.0', id, result });
		} catch (err) {
			if (this.inFlight.get(id)?.signal.aborted) {
				return;
			}
			const rpc = err instanceof RpcError ? err : new RpcError(-32603, (err as Error).message);
			this.send({ jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message } });
		} finally {
			this.inFlight.delete(id);
		}
	}

	private async dispatch(id: JsonRpcId, method: string, params: { readonly [name: string]: unknown }): Promise<object> {
		switch (method) {
			case 'initialize': {
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
				this.protocolVersion = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
				const instructions = typeof this.options.instructions === 'function' ? await this.options.instructions() : this.options.instructions;
				return {
					protocolVersion: this.protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: this.options.name, version: this.options.version },
					...(instructions ? { instructions } : {})
				};
			}
			case 'ping':
				return {};
			case 'tools/list': {
				const tools = await this.options.listTools();
				return { tools: tools.map(tool => this.describe(tool)) };
			}
			case 'tools/call':
				return this.callTool(id, params);
			default:
				throw new RpcError(-32601, `Method not found: ${method}`);
		}
	}

	private describe(tool: McpTool): object {
		// `title` arrived in 2025-06-18; older clients get the name alone.
		const modern = this.protocolVersion !== undefined && this.protocolVersion >= '2025-06-18';
		return {
			name: tool.name,
			...(modern && tool.title ? { title: tool.title } : {}),
			description: tool.description,
			inputSchema: tool.inputSchema,
			...(tool.annotations ? { annotations: tool.annotations } : {})
		};
	}

	private async callTool(id: JsonRpcId, params: { readonly [name: string]: unknown }): Promise<object> {
		const name = params.name;
		if (typeof name !== 'string') {
			throw new RpcError(-32602, 'tools/call needs a tool name.');
		}
		const tools = await this.options.listTools();
		if (!tools.some(tool => tool.name === name)) {
			throw new RpcError(-32602, `Unknown tool: ${name}`);
		}
		const meta = params._meta as { progressToken?: string | number } | undefined;
		const progressToken = meta?.progressToken;
		let progress = 0;
		const controller = new AbortController();
		this.inFlight.set(id, controller);
		let result: McpToolResult;
		try {
			result = await this.options.callTool(name, params.arguments ?? {}, {
				signal: controller.signal,
				progress: message => {
					if (progressToken !== undefined && !controller.signal.aborted) {
						this.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++progress, message } });
					}
				}
			});
		} catch (err) {
			// A failure inside a tool is the model's to read and act on, not a protocol error.
			result = { text: (err as Error).message, isError: true };
		}
		const structured = this.protocolVersion !== undefined && this.protocolVersion >= '2025-06-18' && result.data !== undefined;
		return {
			content: [{ type: 'text', text: result.text }],
			...(structured ? { structuredContent: result.data } : {}),
			...(result.isError ? { isError: true } : {})
		};
	}

	private send(message: object): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}
}
