/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { PipeClient, PipeClientError } from './pipe';
import { McpStdioServer, McpTool, McpToolResult } from './stdio';

const VERSION = '0.1.0';
/** How long an agent's MCP server waits for the window, as it starts and through a reload. */
const RECONNECT_MS = 60_000;
/** How long a script's waits: it was started by hand, and says at once when there is no window. */
const SCRIPT_CONNECT_MS = 5_000;

/** What the window says to a new connection. */
interface Hello {
	readonly name?: string;
	readonly tools?: readonly McpTool[];
	readonly instructions?: string;
}

interface Connection {
	readonly pipe: string;
	readonly token: string;
}

/** What a client sees when the shim cannot reach a Facade window. */
const DISCONNECTED_TOOLS: readonly McpTool[] = [{
	name: 'facade_status',
	title: 'Facade connection status',
	description: 'Explains why Facade\'s tools are unavailable and how to connect.',
	inputSchema: { type: 'object', additionalProperties: false, properties: {} },
	annotations: { readOnlyHint: true }
}];

function argument(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** The pipe and the token: from the arguments Facade launched it with, else from the environment. */
function resolveConnection(args: readonly string[]): Connection | string {
	const pipe = argument(args, '--pipe');
	const tokenFile = argument(args, '--token-file');
	if (pipe && tokenFile) {
		try {
			return { pipe, token: fs.readFileSync(tokenFile, 'utf8').trim() };
		} catch (err) {
			return `the token file ${tokenFile} cannot be read (${(err as Error).message})`;
		}
	}
	const envPipe = process.env.FACADE_AGENTS_PIPE;
	const envToken = process.env.FACADE_AGENTS_TOKEN;
	if (envPipe && envToken && !envPipe.includes('${') && !envToken.includes('${')) {
		return { pipe: envPipe, token: envToken };
	}
	return 'it was started without a pipe and a token';
}

async function serveMcp(args: readonly string[]): Promise<void> {
	const cwd = process.cwd();
	const isAgent = args.includes('--token-file');
	let hello: Hello | undefined;
	let reason = '';
	let client: PipeClient | undefined;

	/** Says hello to the window, waiting through a window reload. Undefined when there is no window. */
	const connect = async (): Promise<Hello | undefined> => {
		const deadline = Date.now() + (isAgent ? RECONNECT_MS : SCRIPT_CONNECT_MS);
		for (; ;) {
			const connection = resolveConnection(args);
			if (typeof connection === 'string') {
				reason = connection;
				return undefined;
			}
			client = new PipeClient(connection.pipe, connection.token);
			try {
				return await client.hello<Hello>();
			} catch (err) {
				const refused = err instanceof PipeClientError && err.code === 'UNAUTHORIZED';
				reason = refused ? 'Facade no longer accepts this session\'s token' : `Facade is not reachable (${(err as Error).message})`;
				if (refused) {
					return undefined;
				}
			}
			if (Date.now() >= deadline) {
				return undefined;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	};

	const tools = async (): Promise<readonly McpTool[]> => {
		hello ??= await connect();
		return hello?.tools ?? DISCONNECTED_TOOLS;
	};

	const instructions = async (): Promise<string | undefined> => {
		await tools();
		return hello?.instructions;
	};

	const call = async (name: string, toolArgs: unknown, context: { signal: AbortSignal; progress(message: string): void }): Promise<McpToolResult> => {
		if (name === 'facade_status' || !client) {
			return { text: `Facade's tools are not available: ${reason || 'unknown reason'}. Turn on the setting facade.orchestration.enabled in Facade, and start the agent with Facade: Start Agent, in a window whose workspace has ${cwd}.`, isError: true, data: { code: 'UNAVAILABLE' } };
		}
		try {
			return await client.call(name, toolArgs, context.progress, context.signal) as McpToolResult;
		} catch (err) {
			const failure = err as PipeClientError;
			if (failure.code === 'CANCELLED' || context.signal.aborted) {
				throw err;
			}
			if (failure.code === 'UNAUTHORIZED') {
				return { text: `Facade no longer accepts ${hello?.name ? `@${hello.name}` : 'this session'} from this process: it was stopped, or a newer agent took its name. Stop working.`, isError: true, data: { code: 'REFUSED' } };
			}
			// The window may be reloading: the call is not repeated, since it may have run; the next one
			// finds the window back.
			return { text: `Facade was not reachable during ${name} (${failure.message}); the window may have reloaded. Call ${name} again in a moment.`, isError: true, data: { code: 'UNAVAILABLE' } };
		}
	};

	const server = new McpStdioServer(process.stdin, process.stdout, {
		name: 'facade',
		version: VERSION,
		instructions,
		listTools: tools,
		callTool: call,
		log: message => process.stderr.write(`${message}\n`)
	});
	await server.start();
}

/**
 * Facade's helper process, run by the Facade executable with ELECTRON_RUN_AS_NODE=1, the way the git
 * extension runs askpass:
 *
 * - `shim.js mcp --pipe <pipe> --token-file <file>`: an agent's MCP server, as Facade launched it.
 * - `shim.js mcp` with FACADE_AGENTS_PIPE and FACADE_AGENTS_TOKEN set: a script, as whoever holds
 *   the token.
 *
 * The MCP server speaks MCP on stdio and forwards every tool call to the window over the pipe, which
 * decides the tools and answers them (WA-5.1). It holds no state: when the window reloads, it
 * connects again. What it says itself is only for when the window cannot answer.
 */
async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'mcp') {
		return serveMcp(args);
	}
	process.stderr.write('Usage: shim.js mcp [--pipe <pipe> --token-file <file>]\n');
	process.exitCode = 2;
}

if (require.main === module) {
	main().catch(err => {
		process.stderr.write(`facade shim: ${(err as Error).stack ?? err}\n`);
		process.exitCode = 1;
	});
}
