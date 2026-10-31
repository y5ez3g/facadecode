/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The MCP server of one run's shim (MCP-6.1): JSON-RPC 2.0 requests of the run's CLI, each answered once. It lists the nine tools
// (MCP-1.1) and carries each tool call to the window that owns the run; the window validates and acts, and its answer returns as
// MCP returns a result - English text and the same facts structured (MCP-1.2).

import { instructionsFor } from '../schema/instructions';
import type { ToolAnswer, ToolCall } from '../schema/protocol';
import { QUERY_ROUTE_MS, QUERY_TOOLS, TOOLS } from '../schema/tools';
import { failureAnswer, isToolAnswer } from './failure';
import { CallFailed } from './ptydLink';

/** The MCP protocol versions the server speaks, the newest first: the one it answers where a client asks another. */
export const MCP_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What a server that speaks for no run says: its CLI was not started by Facade Code (CLIS-2.2). */
const NOT_SERVING = 'This session was not started by Facade Code, so the Facade Code tools are not available in it.';

/** A tool's mark that Antigravity gives it to the model directly rather than on demand (CLIS-2.2). */
const ALWAYS_LOAD = { 'antigravity/alwaysLoad': true };

/** What the server needs: who it is, and how a tool call reaches the window. */
export interface McpShimOptions {
	/** The run's short ID, `#aN`, whose instructions the model is given. */
	readonly alias: string;
	readonly version: string;
	/**
	 * Whether it speaks for a run: false where its CLI started it without the run's variables - a session the person started by hand
	 * in a folder that holds a running agent's server entry (CLIS-2.2). It then offers no tools and connects nowhere.
	 */
	readonly serving?: boolean;
	readonly link: {
		connect(): Promise<void>;
		call(call: Omit<ToolCall, 'elapsedMs' | 'caller' | 'protocol'>, readAt: number): Promise<unknown>;
	};
	/** Writes one JSON-RPC message, or a batch of them, to the client. */
	readonly write: (message: object) => void;
	/** A diagnostic line, never shown to the model. */
	readonly log: (line: string) => void;
}

/** A JSON-RPC error answered as one. */
class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

type Id = string | number;

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A tool's answer as an MCP `tools/call` result. */
function resultOf(answer: ToolAnswer): object {
	return { content: [{ type: 'text', text: answer.text }], structuredContent: answer.structured, isError: answer.isError };
}

/** The MCP server of one run's shim: requests in as lines are read, answers out as they come, concurrent calls in any order. */
export class McpShim {

	private outstanding = 0;
	private readonly idlers: (() => void)[] = [];

	constructor(private readonly options: McpShimOptions) { }

	/** One line the client wrote, read at `readAt` on this process's monotonic clock: a request, a notification or a batch. */
	receive(line: string, readAt = performance.now()): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.options.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the line is not JSON.' } });
			return;
		}
		if (Array.isArray(message) && !message.length) {
			this.options.write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: an empty batch.' } });
			return;
		}
		this.outstanding++;
		const answering = Array.isArray(message)
			? Promise.all(message.map(each => this.answer(each, readAt))).then(answers => {
				const sent = answers.filter(each => each !== undefined);
				if (sent.length) {
					this.options.write(sent);
				}
			})
			: this.answer(message, readAt).then(answer => {
				if (answer) {
					this.options.write(answer);
				}
			});
		void answering.catch(err => this.options.log(`Could not answer: ${err instanceof Error ? err.message : String(err)}`)).finally(() => {
			if (!--this.outstanding) {
				this.idlers.splice(0).forEach(idle => idle());
			}
		});
	}

	/**
	 * A line the client wrote that was longer than one line may be, and so was never read: it is answered as an invalid request
	 * whose id is not known, and the requests after it are read as ever.
	 */
	oversized(err: Error): void {
		this.options.log(`Did not read a request: ${err.message}`);
		this.options.write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Invalid request: it was not read. ${err.message}` } });
	}

	/** Resolves once every request read so far is answered. */
	idle(): Promise<void> {
		return this.outstanding ? new Promise(resolve => this.idlers.push(resolve)) : Promise.resolve();
	}

	/** The answer to one message; none for a notification, or a response to a request this server never made. */
	private async answer(message: unknown, readAt: number): Promise<object | undefined> {
		if (!isObject(message)) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: not a JSON-RPC message.' } };
		}
		const { id, method } = message;
		if (typeof method !== 'string') {
			return 'result' in message || 'error' in message ? undefined : { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid request: it names no method.' } };
		}
		if (id === undefined) {
			// A notification - initialized, cancelled or any other - asks for nothing
			return undefined;
		}
		if (typeof id !== 'string' && typeof id !== 'number') {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: its id is neither a string nor a number.' } };
		}
		try {
			return { jsonrpc: '2.0', id, result: await this.result(method, message.params, id, readAt) };
		} catch (err) {
			const error = err instanceof RpcError ? { code: err.code, message: err.message } : { code: -32603, message: `Internal error: ${err instanceof Error ? err.message : String(err)}` };
			return { jsonrpc: '2.0', id, error };
		}
	}

	private async result(method: string, params: unknown, id: Id, readAt: number): Promise<object> {
		switch (method) {
			case 'initialize': {
				const asked = isObject(params) ? params.protocolVersion : undefined;
				const serving = this.options.serving !== false;
				if (serving) {
					// Saying hello now tells the window the run's tools are there (MCP-6.1); a call connects again where this fails
					this.options.link.connect().catch(err => this.options.log(err instanceof Error ? err.message : String(err)));
				}
				return {
					protocolVersion: typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'facade', version: this.options.version },
					instructions: serving ? instructionsFor(this.options.alias) : NOT_SERVING
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				// Each tool given directly where a CLI otherwise loads tools on demand: Antigravity's first turn has them so (CLIS-2.2)
				return { tools: this.options.serving === false ? [] : TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, _meta: ALWAYS_LOAD })) };
			case 'tools/call': {
				if (!isObject(params) || typeof params.name !== 'string') {
					throw new RpcError(-32602, 'Invalid params: tools/call names its tool by a string `name`.');
				}

				// MCP's arguments are optional: none given is an empty set, which the window validates as any other (MCP-1.1). A query's
				// route answers it within ten seconds, the window's or not (MCP-1.3)
				const call = {
					tool: params.name,
					arguments: params.arguments === undefined ? {} : params.arguments,
					callId: String(id),
					...QUERY_TOOLS.has(params.name) ? { routeDeadlineMs: QUERY_ROUTE_MS } : {}
				};
				return resultOf(await this.call(call, readAt));
			}
			default:
				throw new RpcError(-32601, `Method not found: ${method}.`);
		}
	}

	/** The window's answer to a call, or the failure that kept it from coming: an error result either way, never a JSON-RPC error. */
	private async call(call: Omit<ToolCall, 'elapsedMs' | 'caller' | 'protocol'>, readAt: number): Promise<ToolAnswer> {
		let answer: unknown;
		try {
			answer = await this.options.link.call(call, readAt);
		} catch (err) {
			if (err instanceof CallFailed) {
				return failureAnswer(err.code, err.reason, err.message, err.outcome);
			}
			return failureAnswer('UNAVAILABLE', 'window_unavailable', `The call was not carried to a Facade Code window: ${err instanceof Error ? err.message : String(err)}. Whether it took effect is not known.`, 'unknown');
		}
		return isToolAnswer(answer) ? answer
			: failureAnswer('UNAVAILABLE', 'protocol_incompatible', 'The Facade Code window answered in a form this MCP server cannot read: the call may have taken effect.', 'unknown');
	}
}
