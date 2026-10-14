/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'stream';
import { messageOf, stackOf } from '../base/errors';
import { isJsonObject, JsonObject } from '../base/json';
import { McpTool, splitLines, ToolResult } from './protocol';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** The first protocol version with tool titles and structured content. */
const STRUCTURED_SINCE = '2025-06-18';

/** A tool call as the server runs it: aborted when the client cancels it. */
export interface McpCallContext {
	readonly signal: AbortSignal;
	progress(message: string): void;
}

/** An MCP server of tools: its name and version, its instructions and tools, and how it runs a tool. */
export interface McpServerOptions {
	readonly name: string;
	readonly version: string;
	/** The server's instructions for the model, asked for when the client initializes. */
	instructions(): Promise<string | undefined>;
	/** The tools, asked for when the client lists them, and before each call, to know its tool. */
	listTools(): Promise<readonly McpTool[]>;
	/** Runs a tool; a failure it throws is a result the model reads, marked as an error. */
	callTool(name: string, args: unknown, context: McpCallContext): Promise<ToolResult>;
	/** Writes diagnostics, never to stdout, which carries the protocol. */
	log?(message: string): void;
}

type JsonRpcId = string | number;

class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

/** The answer to a message that is no request: not an object, or with an id neither a string nor a number. */
const INVALID_REQUEST = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } as const;

/**
 * An MCP server over stdio, as newline-delimited JSON-RPC 2.0: the part of the protocol a server of
 * tools needs - initialize, ping, tools/list, tools/call, progress and cancellation - for the revisions
 * from 2024-11-05 to 2025-11-25, with the batches that revisions before 2025-06-18 may send.
 */
export class McpStdioServer {

	private protocolVersion: string | undefined;
	private readonly inFlight = new Map<JsonRpcId, AbortController>();
	private buffer = '';
	/** Set once the input ended: the client has gone, and is sent nothing more. */
	private ended = false;

	constructor(private readonly input: Readable, private readonly output: Writable, private readonly options: McpServerOptions) { }

	/** Serves until the input ends. */
	start(): Promise<void> {
		this.input.setEncoding('utf8');
		this.input.on('data', (chunk: string) => this.onData(chunk));
		return new Promise(resolve => this.input.on('end', () => {
			this.ended = true;
			for (const controller of this.inFlight.values()) {
				controller.abort();
			}
			resolve();
		}));
	}

	private onData(chunk: string): void {
		const { lines, rest } = splitLines(this.buffer + chunk);
		this.buffer = rest;
		for (const line of lines) {
			if (line.trim()) {
				this.onLine(line);
			}
		}
	}

	private onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.options.log?.('Received a line that is not valid JSON; returned a parse error.');
			this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			return;
		}
		if (!Array.isArray(message)) {
			void this.answer(message).then(response => response && this.send(response));
			return;
		}
		// A batch is answered once, when all its requests are
		if (!message.length) {
			this.send(INVALID_REQUEST);
			return;
		}
		void Promise.all(message.map(each => this.answer(each))).then(responses => {
			const answered = responses.filter(response => response !== undefined);
			if (answered.length) {
				this.send(answered);
			}
		});
	}

	/** The response to one message; undefined for a notification, a response, or a request that was cancelled. */
	private async answer(message: unknown): Promise<object | undefined> {
		if (!isJsonObject(message)) {
			return INVALID_REQUEST;
		}
		const { id, method, params } = message;
		if (typeof method !== 'string') {
			// A response; this server sends no requests.
			return undefined;
		}
		const given = isJsonObject(params) ? params : {};
		if (id === undefined || id === null) {
			this.onNotification(method, given);
			return undefined;
		}
		if (typeof id !== 'string' && typeof id !== 'number') {
			return INVALID_REQUEST;
		}
		return this.onRequest(id, method, given);
	}

	private onNotification(method: string, params: JsonObject): void {
		if (method === 'notifications/cancelled') {
			const id = params.requestId;
			if (typeof id === 'string' || typeof id === 'number') {
				this.inFlight.get(id)?.abort();
			}
		}
	}

	/** Runs a request; its response, or undefined once it was cancelled: a cancelled request gets none. */
	private async onRequest(id: JsonRpcId, method: string, params: JsonObject): Promise<object | undefined> {
		try {
			const result = await this.dispatch(id, method, params);
			return this.inFlight.get(id)?.signal.aborted ? undefined : { jsonrpc: '2.0', id, result };
		} catch (err) {
			if (this.inFlight.get(id)?.signal.aborted) {
				return undefined;
			}
			if (!(err instanceof RpcError)) {
				this.options.log?.(`${method} failed: ${stackOf(err)}`);
			}
			const error = err instanceof RpcError ? err : new RpcError(-32603, messageOf(err));
			return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
		} finally {
			this.inFlight.delete(id);
		}
	}

	private async dispatch(id: JsonRpcId, method: string, params: JsonObject): Promise<object> {
		switch (method) {
			case 'initialize': {
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
				this.protocolVersion = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
				const instructions = await this.options.instructions();
				return {
					protocolVersion: this.protocolVersion,
					capabilities: { tools: { listChanged: true } },
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
				throw new RpcError(-32601, `Method not found: ${method}.`);
		}
	}

	private isStructured(): boolean {
		return this.protocolVersion !== undefined && this.protocolVersion >= STRUCTURED_SINCE;
	}

	private describe(tool: McpTool): object {
		return {
			name: tool.name,
			...(this.isStructured() && tool.title ? { title: tool.title } : {}),
			description: tool.description,
			inputSchema: tool.inputSchema
		};
	}

	private async callTool(id: JsonRpcId, params: JsonObject): Promise<object> {
		const name = params.name;
		if (typeof name !== 'string') {
			throw new RpcError(-32602, 'tools/call requires a \'name\' parameter identifying the tool.');
		}
		// Cancellable from here: finding the tools may wait, as for a window that reloads
		const controller = new AbortController();
		this.inFlight.set(id, controller);
		const tools = await this.options.listTools();
		if (controller.signal.aborted) {
			// Never sent: a cancelled request gets no response, and its tool is not run
			throw new RpcError(-32603, 'Cancelled');
		}
		if (!tools.some(tool => tool.name === name)) {
			throw new RpcError(-32602, `Unknown tool: ${name}.`);
		}
		const token = isJsonObject(params._meta) ? params._meta.progressToken : undefined;
		const progressToken = typeof token === 'string' || typeof token === 'number' ? token : undefined;
		let progress = 0;
		let result: ToolResult;
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
			// A tool's failure is the model's to read, not a protocol error.
			result = { text: messageOf(err), isError: true };
		}
		return {
			content: [{ type: 'text', text: result.text }],
			...(this.isStructured() && result.data !== undefined ? { structuredContent: result.data } : {}),
			...(result.isError ? { isError: true } : {})
		};
	}

	/** Tells the client the tools changed, for it to list them again: as the window comes that was not there. */
	toolsChanged(): void {
		this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
	}

	private send(message: object): void {
		if (!this.ended) {
			this.output.write(`${JSON.stringify(message)}\n`);
		}
	}
}
