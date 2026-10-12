/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { timeout } from '../base/async';
import { clauseOf, messageOf, stackOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { McpStdioServer } from './mcpServer';
import { PipeClient, PipeClientError } from './pipe';
import { Hello, helloOf, MAX_TIMER_MS, McpTool, ToolResult, toolResultOf, WINDOW_WAIT_MS } from './protocol';

/** The version the MCP server gives of itself. */
const VERSION = '0.2.0';
/** How long a script waits for the window: it was started by hand, and should say at once that there is none. */
const SCRIPT_WAIT_MS = 5_000;
/** How often the window is tried again while it is away. */
const RETRY_MS = 1_000;
/**
 * How long the server waits for the window as its client initializes it: a CLI gives up on a server that
 * does not answer soon (Codex after 30 s). A window that comes later is announced as tools that changed.
 */
const INITIALIZE_WAIT_MS = 10_000;
/**
 * How long past its wait a call the window accepted may go without a word from it before it is taken as cut
 * off: the window answers by then, unconfirmed or pending where it must, so a few seconds more mean it is
 * frozen or gone. The caller is answered within its wait and 5 s (AGENT-TEST-PLAN.md, TR-17): the margin
 * leaves a second of that for the answer to reach it.
 */
const SILENCE_MARGIN_MS = 4_000;

interface Connection {
	readonly pipe: string;
	readonly token: string;
	/** Whether the window's record says the agent framework is off. */
	readonly disabled: boolean;
}

/** What `window.json` in a workspace's record says now: the pipe the window listens on, and whether the framework is on. */
function windowOf(recordDir: string): { readonly pipe: string; readonly enabled: boolean } | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(recordDir, 'window.json'), 'utf8'));
		return isJsonObject(parsed) && typeof parsed.pipe === 'string' && parsed.pipe ? { pipe: parsed.pipe, enabled: parsed.enabled !== false } : undefined;
	} catch {
		return undefined;
	}
}

/** A token from a value that names its file - as an agent's environment gives it - or is the token itself, as a script's may. */
function tokenFrom(value: string): string | string[] {
	if (path.isAbsolute(value)) {
		try {
			return fs.readFileSync(value, 'utf8').trim();
		} catch (err) {
			return [`the token file ${value} cannot be read (${messageOf(err)})`];
		}
	}
	return value;
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

/**
 * The pipe and the token, read again at each try: from the arguments Facade launched it with, else from
 * the environment; else why there are none. The pipe is the one the workspace's record says the window
 * listens on now - a window that came back can listen on another - and the one it was launched with only
 * where the record names none.
 */
function connectionOf(args: readonly string[]): Connection | string {
	const { FACADE_AGENTS_RECORD: envRecord, FACADE_AGENTS_PIPE: envPipe, FACADE_AGENTS_TOKEN: envToken } = process.env;
	// A CLI that did not expand its configuration's variables passes them on as they were written.
	const given = (value: string | undefined) => value && !value.includes('${') ? value : undefined;
	const tokenFile = argumentAfter(args, '--token-file');
	const fromArgs = tokenFile !== undefined;
	const record = fromArgs ? argumentAfter(args, '--record') : given(envRecord);
	const launchedPipe = fromArgs ? argumentAfter(args, '--pipe') : given(envPipe);
	const tokenValue = fromArgs ? tokenFile : given(envToken);
	if (!tokenValue || (!record && !launchedPipe)) {
		return 'it was started without a pipe and a token';
	}
	const token = fromArgs ? tokenFrom(path.resolve(tokenValue)) : tokenFrom(tokenValue);
	if (Array.isArray(token)) {
		return token[0];
	}
	const window = record ? windowOf(record) : undefined;
	const pipe = window?.pipe ?? launchedPipe;
	if (!pipe) {
		return `the window of the record ${record} has not said where it listens`;
	}
	return { pipe, token, disabled: window?.enabled === false };
}

/** Whether this server was started for an agent or a script at all: a CLI run by hand in a folder Facade wrote a configuration into was not. */
function isConfigured(args: readonly string[]): boolean {
	if (args.includes('--token-file')) {
		return true;
	}
	const { FACADE_AGENTS_RECORD: envRecord, FACADE_AGENTS_PIPE: envPipe, FACADE_AGENTS_TOKEN: envToken } = process.env;
	const given = (value: string | undefined) => !!value && !value.includes('${');
	return given(envToken) && (given(envRecord) || given(envPipe));
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
	// A call the window accepted ends with a word from it - progress, then its result - within its own wait;
	// past that and a margin, the window is taken as gone without a word (frozen, killed).
	const silenceMs = waitFromEnv('FACADE_AGENTS_SILENCE_MS', Math.min(Math.max(waitMs, WINDOW_WAIT_MS) + SILENCE_MARGIN_MS, MAX_TIMER_MS));
	const folder = process.cwd();
	// A CLI run by hand where Facade's configuration is gets no Facade tools and no noise (O9).
	const configured = isConfigured(args);
	let hello: Hello | undefined;
	let unavailable = '';
	/** Since when the window is away, through every call: one outage is waited for once, not once per call (O8). */
	let awaySince: number | undefined;
	/** Whether the client was given the status tool alone: once the window comes, it is told the tools changed. */
	let gaveStatusOnly = false;
	/** Aborted once the CLI closed the MCP server's input: what waits for the window stops. */
	const stopped = new AbortController();

	/** How long this outage may still be waited for: what is left of the wait since the window went away. */
	const outageLeft = () => awaySince === undefined ? waitMs : Math.max(awaySince + waitMs - Date.now(), 0);

	/**
	 * Says hello to the window, trying for `maxWaitMs` at most; undefined when there is no window. A window
	 * that does not answer is waited for no longer than one that is not there.
	 */
	const connect = async (maxWaitMs: number): Promise<Hello | undefined> => {
		const deadline = Date.now() + maxWaitMs;
		for (; ;) {
			const connection = connectionOf(args);
			if (typeof connection === 'string') {
				unavailable = connection;
				return undefined;
			}
			const client = new PipeClient(connection.pipe, connection.token);
			try {
				const answered = AbortSignal.any([stopped.signal, AbortSignal.timeout(Math.max(deadline - Date.now(), RETRY_MS))]);
				const received = helloOf(await client.hello(answered));
				awaySince = undefined;
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
				awaySince ??= Date.now();
				unavailable = code === 'UNREACHABLE' || code === 'NOT_CONNECTED' ? `Facade is not reachable (${messageOf(err)})` : `Facade's window failed to say hello (${messageOf(err)})`;
			}
			if (Date.now() >= deadline) {
				return undefined;
			}
			await timeout(RETRY_MS, stopped.signal);
		}
	};

	/** The tools; found once the window says hello, waiting no longer than a client waits for a server that starts. */
	const tools = async (maxWaitMs = Math.min(outageLeft(), INITIALIZE_WAIT_MS)): Promise<readonly McpTool[]> => {
		if (!configured) {
			return [];
		}
		if (!hello) {
			hello = await connect(maxWaitMs);
			if (hello && gaveStatusOnly) {
				server.toolsChanged();
			}
		}
		if (!hello) {
			gaveStatusOnly = true;
			return [STATUS_TOOL];
		}
		return hello.tools;
	};

	const call = async (name: string, toolArgs: unknown, context: { readonly signal: AbortSignal; progress(message: string): void }): Promise<ToolResult> => {
		if (name === STATUS_TOOL.name || !hello) {
			// The window may have come since the client listed the tools: it lists them again.
			if (await tools(0) !== undefined && hello) {
				return { text: 'Facade\'s window is reachable now and its tools are listed again: list the tools, and call the one you need.', data: { code: 'OK' } };
			}
			return { text: `Facade's tools are not available: ${unavailable || 'the reason is not known'}. Turn on the setting facade.orchestration.enabled in Facade, and start the agent with Facade: Start Agent, in a window whose workspace has ${folder}.`, isError: true, data: { code: 'UNAVAILABLE' } };
		}
		// A call that finds no window has not run: it waits for the window, as through a reload - for what is
		// left of this outage, which every call shares.
		let waiting = false;
		// The run the call made, once the window said: what a call cut after names.
		let made: number | undefined;
		const madeText = () => made !== undefined ? ` - it made the run #a${made}` : '';
		const madeData = () => made !== undefined ? { agent: made } : {};
		for (; ;) {
			const tried = Date.now();
			const connection = connectionOf(args);
			if (typeof connection === 'string') {
				return { text: `Facade's tools are not available: ${connection}.`, isError: true, data: { code: 'UNAVAILABLE' } };
			}
			const client = new PipeClient(connection.pipe, connection.token);
			// Each word from the window - progress, the result - restarts the silence the call may take.
			const silence = new AbortController();
			let silenceTimer = setTimeout(() => silence.abort(), silenceMs);
			const progress = (message: string, agent?: number) => {
				clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => silence.abort(), silenceMs);
				made = agent ?? made;
				context.progress(message);
			};
			try {
				const result = toolResultOf(await client.call(name, toolArgs, progress, AbortSignal.any([context.signal, silence.signal])));
				awaySince = undefined;
				return result ?? { text: `Facade answered ${name} with something this version cannot read.`, isError: true, data: { code: 'FAILED' } };
			} catch (err) {
				const code = err instanceof PipeClientError ? err.code : undefined;
				if (silence.signal.aborted && !context.signal.aborted) {
					return { text: `Facade's window said nothing about ${name} for ${Math.round(silenceMs / 1000)} s after taking it, so ${name} may have run${madeText()}. Look with list_agents before you call it again.`, isError: true, data: { code: 'UNAVAILABLE', outcome: 'unknown', ...madeData() } };
				}
				if (code === 'CANCELLED' || context.signal.aborted) {
					throw err;
				}
				if (code === 'UNAUTHORIZED') {
					return { text: `Facade no longer accepts ${hello ? `@${hello.name}` : 'this session'}: it was stopped, or exited. Stop working.`, isError: true, data: { code: 'REFUSED' } };
				}
				if (code === 'UNREACHABLE') {
					if (connection.disabled) {
						return { text: `Facade's tools are off: the person turned the agent framework off (facade.orchestration.enabled), so ${name} did not run.`, isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
					}
					awaySince ??= Date.now();
					if (outageLeft() > 0) {
						if (!waiting) {
							waiting = true;
							context.progress('Waiting for Facade\'s window to come back.');
						}
						// Tried each second: a try the window did not take in time has had its second already (N-43)
						await timeout(Math.min(Math.max(RETRY_MS - (Date.now() - tried), 0), outageLeft()), context.signal);
						continue;
					}
					return { text: `Facade's window did not come back, so ${name} did not run (${clauseOf(messageOf(err))}). Call it again once the window is there.`, isError: true, data: { code: 'UNAVAILABLE' } };
				}
				if (code === 'TOO_LARGE') {
					return { text: `Facade did not take ${name}: its arguments are over the 1 MB a call may carry. Put what is long in a file, and give its path instead.`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'REJECTED') {
					return { text: `Facade could not read the call to ${name}, so it did not run. ${messageOf(err)}`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'NOT_CONNECTED') {
					return { text: `Facade's window went away during ${name} (${messageOf(err)}), as it does while it reloads, so ${name} may have run${madeText()}. Look with list_agents before you call it again.`, isError: true, data: { code: 'UNAVAILABLE', outcome: 'unknown', ...madeData() } };
				}
				return { text: `${name} failed in Facade's window: ${messageOf(err)}`, isError: true, data: { code: 'FAILED' } };
			} finally {
				clearTimeout(silenceTimer);
			}
		}
	};

	const server = new McpStdioServer(process.stdin, process.stdout, {
		name: 'facade',
		version: VERSION,
		instructions: async () => {
			await tools(Math.min(INITIALIZE_WAIT_MS, waitMs, outageLeft()));
			return hello?.instructions;
		},
		listTools: () => tools(),
		callTool: call,
		isTool: (name, listed) => listed.some(tool => tool.name === name) || (configured && name === STATUS_TOOL.name),
		log: message => process.stderr.write(`${message}\n`)
	});
	await server.start();
	stopped.abort();
}

/**
 * Facade's helper process, run by Facade's own executable with ELECTRON_RUN_AS_NODE=1, as the git
 * extension runs askpass:
 *
 * - `shim.js mcp --record <dir> --pipe <pipe> --token-file <file>`: an agent's MCP server, as Facade
 *   launched it; it finds the window's pipe in the record's `window.json` at each try.
 * - `shim.js mcp --agent`, with FACADE_AGENTS_RECORD and FACADE_AGENTS_TOKEN - the token file's path - set:
 *   the MCP server the agents of a CLI that reads its servers from a file of the worktree share; it finds
 *   the agent from its environment.
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
