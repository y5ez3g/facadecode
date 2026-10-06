/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { timeout } from '../base/async';
import { messageOf, stackOf } from '../base/errors';
import { McpStdioServer } from './mcpServer';
import { PipeClient, PipeClientError } from './pipe';
import { Hello, helloOf, MAX_TIMER_MS, McpTool, ToolResult, toolResultOf, WINDOW_WAIT_MS } from './protocol';

/** The version the MCP server gives of itself. */
const VERSION = '0.2.0';
/** How long a script waits for the window: it was started by hand, and should say at once that there is none. */
const SCRIPT_WAIT_MS = 5_000;
/** How often the window is tried again while it is away. */
const RETRY_MS = 1_000;

interface Connection {
	readonly pipe: string;
	readonly token: string;
}

/** The tool offered when no Facade window can be reached. */
const STATUS_TOOL: McpTool = {
	name: 'facade_status',
	title: 'Facade Status',
	description: 'Explains why Facade\'s tools are unavailable.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

function argumentAfter(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** The pipe and the token: from the arguments Facade launched it with, else from the environment; else why there are none. */
function connectionOf(args: readonly string[]): Connection | string {
	const pipe = argumentAfter(args, '--pipe');
	const tokenFile = argumentAfter(args, '--token-file');
	if (pipe && tokenFile) {
		try {
			return { pipe, token: fs.readFileSync(tokenFile, 'utf8').trim() };
		} catch (err) {
			return `the token file ${tokenFile} cannot be read (${messageOf(err)})`;
		}
	}
	const { FACADE_AGENTS_PIPE: envPipe, FACADE_AGENTS_TOKEN: envToken } = process.env;
	// A CLI that did not expand its configuration's variables passes them on as they were written.
	if (envPipe && envToken && !envPipe.includes('${') && !envToken.includes('${')) {
		return { pipe: envPipe, token: envToken };
	}
	return 'it was started without a pipe and a token';
}

/**
 * A wait in milliseconds, as the environment variable `name` sets it - an agent's launch, as the person
 * set it, or a test - else `ms`; never longer than a timer takes.
 */
function waitFromEnv(name: string, ms: number): number {
	const value = Number(process.env[name]);
	return Math.min(Number.isFinite(value) && value > 0 ? value : ms, MAX_TIMER_MS);
}

async function serveMcp(args: readonly string[]): Promise<void> {
	const isAgent = args.includes('--token-file') || args.includes('--agent');
	const waitMs = isAgent ? waitFromEnv('FACADE_AGENTS_WAIT_MS', WINDOW_WAIT_MS) : waitFromEnv('FACADE_SCRIPT_WAIT_MS', SCRIPT_WAIT_MS);
	const folder = process.cwd();
	let hello: Hello | undefined;
	let unavailable = '';
	let client: PipeClient | undefined;
	/** Set once the window was waited for in full: a window still away is then said to be at once. */
	let waited = false;
	/** Aborted once the CLI closed the MCP server's input: what waits for the window stops. */
	const stopped = new AbortController();

	/**
	 * Says hello to the window, waiting for it through a reload, the first time; undefined when there is
	 * no window. A window that does not answer is waited for no longer than one that is not there.
	 */
	const connect = async (): Promise<Hello | undefined> => {
		const deadline = Date.now() + (waited ? 0 : waitMs);
		waited = true;
		for (; ;) {
			const connection = connectionOf(args);
			if (typeof connection === 'string') {
				unavailable = connection;
				return undefined;
			}
			client = new PipeClient(connection.pipe, connection.token);
			try {
				const answered = AbortSignal.any([stopped.signal, AbortSignal.timeout(Math.max(deadline - Date.now(), RETRY_MS))]);
				const received = helloOf(await client.hello(answered));
				if (!received) {
					unavailable = 'Facade said hello with something this version cannot read';
					return undefined;
				}
				return received;
			} catch (err) {
				const code = err instanceof PipeClientError ? err.code : undefined;
				if (code === 'UNAUTHORIZED') {
					unavailable = 'Facade no longer accepts this session\'s token';
					return undefined;
				}
				unavailable = code === 'UNREACHABLE' || code === 'NOT_CONNECTED' ? `Facade is not reachable (${messageOf(err)})` : `Facade's window failed to say hello (${messageOf(err)})`;
			}
			if (Date.now() >= deadline) {
				return undefined;
			}
			await timeout(RETRY_MS, stopped.signal);
		}
	};

	const tools = async (): Promise<readonly McpTool[]> => {
		hello ??= await connect();
		return hello?.tools ?? [STATUS_TOOL];
	};

	const call = async (name: string, toolArgs: unknown, context: { readonly signal: AbortSignal; progress(message: string): void }): Promise<ToolResult> => {
		if (name === STATUS_TOOL.name || !client) {
			return { text: `Facade's tools are not available: ${unavailable || 'the reason is not known'}. Turn on the setting facade.orchestration.enabled in Facade, and start the agent with Facade: Start Agent, in a window whose workspace has ${folder}.`, isError: true, data: { code: 'UNAVAILABLE' } };
		}
		// A call that finds no window has not run: it waits for the window, as through a reload.
		const deadline = Date.now() + waitMs;
		let waiting = false;
		for (; ;) {
			try {
				const result = toolResultOf(await client.call(name, toolArgs, context.progress, context.signal));
				return result ?? { text: `Facade answered ${name} with something this version cannot read.`, isError: true, data: { code: 'FAILED' } };
			} catch (err) {
				const code = err instanceof PipeClientError ? err.code : undefined;
				if (code === 'CANCELLED' || context.signal.aborted) {
					throw err;
				}
				if (code === 'UNAUTHORIZED') {
					return { text: `Facade no longer accepts ${hello ? `@${hello.name}` : 'this session'}: it was killed, or exited. Stop working.`, isError: true, data: { code: 'REFUSED' } };
				}
				if (code === 'UNREACHABLE' && Date.now() < deadline) {
					if (!waiting) {
						waiting = true;
						context.progress('Waiting for Facade\'s window to come back.');
					}
					await timeout(RETRY_MS, context.signal);
					continue;
				}
				if (code === 'UNREACHABLE') {
					return { text: `Facade's window did not come back, so ${name} did not run (${messageOf(err)}). Call it again once the window is there.`, isError: true, data: { code: 'UNAVAILABLE' } };
				}
				if (code === 'TOO_LARGE') {
					return { text: `Facade did not take ${name}: its arguments are over the 1 MB a call may carry. Put what is long in a file, and give its path instead.`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'REJECTED') {
					return { text: `Facade could not read the call to ${name}, so it did not run. ${messageOf(err)}`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'NOT_CONNECTED') {
					return { text: `Facade's window went away during ${name} (${messageOf(err)}), as it does while it reloads, so ${name} may have run. Find out whether it did before you call it again.`, isError: true, data: { code: 'UNAVAILABLE' } };
				}
				return { text: `${name} failed in Facade's window: ${messageOf(err)}`, isError: true, data: { code: 'FAILED' } };
			}
		}
	};

	const server = new McpStdioServer(process.stdin, process.stdout, {
		name: 'facade',
		version: VERSION,
		instructions: async () => {
			await tools();
			return hello?.instructions;
		},
		listTools: tools,
		callTool: call,
		log: message => process.stderr.write(`${message}\n`)
	});
	await server.start();
	stopped.abort();
}

/**
 * Facade's helper process, run by Facade's own executable with ELECTRON_RUN_AS_NODE=1, as the git
 * extension runs askpass:
 *
 * - `shim.js mcp --pipe <pipe> --token-file <file>`: an agent's MCP server, as Facade launched it.
 * - `shim.js mcp --agent`, with FACADE_AGENTS_PIPE and FACADE_AGENTS_TOKEN set: the MCP server the
 *   agents of a CLI that reads its servers from a file of the worktree share; it finds the agent from
 *   its environment.
 * - `shim.js mcp`, with FACADE_AGENTS_PIPE and FACADE_AGENTS_TOKEN set: a script, acting as whoever
 *   holds the token.
 *
 * An agent's waits for the window as long as FACADE_AGENTS_WAIT_MS says, which its launch sets as the
 * person set it; a script, a few seconds.
 *
 * The MCP server forwards every tool call to the window over the pipe; the window decides what the
 * tools are and answers them. It keeps no state, so after a reload it simply connects again.
 */
async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'mcp') {
		return serveMcp(args);
	}
	process.stderr.write('Usage: shim.js mcp [--pipe <pipe> --token-file <file> | --agent]\n');
	process.exitCode = 2;
}

if (require.main === module) {
	main().catch(err => {
		process.stderr.write(`facade shim: ${stackOf(err)}\n`);
		process.exitCode = 1;
	});
}
