/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { timeout } from '../base/async';
import { CancelledError, clauseOf, messageOf, stackOf } from '../base/errors';
import { isJsonObject, sameJson } from '../base/json';
import { McpStdioServer } from './mcpServer';
import { PipeClient, PipeClientError } from './pipe';
import { Hello, helloOf, MAX_TIMER_MS, McpTool, ToolResult, toolResultOf, TOOLS_FILE, toolsOf, WINDOW_WAIT_MS } from './protocol';

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
/** How often an agent's server whose client has the tools of the record, not the window's, looks for the window in the background (O8). */
const DISCOVER_MS = 2_000;
/**
 * How long past its wait a call the window accepted may go without a word from it before it is taken as cut
 * off: the window answers by then, unconfirmed or pending where it must, so a few seconds more mean it is
 * frozen or gone. The caller is answered within its wait and 5 s: the margin leaves a second of that for the
 * answer to reach it.
 */
const SILENCE_MARGIN_MS = 4_000;

/** Says what went wrong on stderr, which a CLI keeps for its MCP server: stdout carries the server's messages alone. */
function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

interface Connection {
	readonly pipe: string;
	readonly token: string;
	/** Whether the window's record says the agent framework is off. */
	readonly disabled: boolean;
	/**
	 * The window the record names now, where it names one: its process and its pipe. A window back from a reload is
	 * another - a new extension host, which knows nothing of the servers that said hello to the one before.
	 */
	readonly window?: string;
}

/**
 * What `window.json` in a workspace's record says now: the pipe the window listens on, whether the framework is on,
 * and which window it is - its process and its pipe.
 */
function windowOf(recordDir: string): { readonly pipe: string; readonly enabled: boolean; readonly id: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(recordDir, 'window.json'), 'utf8'));
		return isJsonObject(parsed) && typeof parsed.pipe === 'string' && parsed.pipe ? { pipe: parsed.pipe, enabled: parsed.enabled !== false, id: `${typeof parsed.pid === 'number' ? parsed.pid : ''} ${parsed.pipe}` } : undefined;
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
			return [`could not read token file ${value} (${messageOf(err)})`];
		}
	}
	return value;
}

function argumentAfter(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** A value of the environment as the server was given it: none where a CLI that did not expand its configuration's variables passes them on as they were written. */
function given(value: string | undefined): string | undefined {
	return value && !value.includes('${') ? value : undefined;
}

/** The workspace's record the server was given: in the arguments Facade launched it with, else in the environment. */
function recordOf(args: readonly string[]): string | undefined {
	return argumentAfter(args, '--token-file') !== undefined ? argumentAfter(args, '--record') : given(process.env.FACADE_AGENTS_RECORD);
}

/**
 * The tools the window wrote into the workspace's record as it last started: what the server lists while the window
 * does not answer - its tools are the same whatever the window's state, start_agent's description without what only
 * the window knows (AGENT-LAUNCHER.md, L1; O8). None where it has no record, as a script given a pipe alone; none,
 * and why said on stderr, where the record's tools cannot be read.
 */
function recordedTools(args: readonly string[]): readonly McpTool[] {
	const record = recordOf(args);
	if (!record) {
		return [];
	}
	const file = path.join(record, TOOLS_FILE);
	try {
		const tools = toolsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
		if (!tools) {
			log(`${file} contains no tool definitions this version can read. No tools will be listed until the window responds.`);
		}
		return tools ?? [];
	} catch (err) {
		log(`Could not read ${file} (${messageOf(err)}). No tools will be listed until the window responds.`);
		return [];
	}
}

/**
 * The pipe and the token, read again at each try: from the arguments Facade launched it with, else from
 * the environment; else why there are none. The pipe is the one the workspace's record says the window
 * listens on now - a window that came back can listen on another - and the one it was launched with only
 * where the record names none.
 */
function connectionOf(args: readonly string[]): Connection | string {
	const { FACADE_AGENTS_PIPE: envPipe, FACADE_AGENTS_TOKEN: envToken } = process.env;
	const tokenFile = argumentAfter(args, '--token-file');
	const fromArgs = tokenFile !== undefined;
	const record = recordOf(args);
	const launchedPipe = fromArgs ? argumentAfter(args, '--pipe') : given(envPipe);
	const tokenValue = fromArgs ? tokenFile : given(envToken);
	if (!tokenValue || (!record && !launchedPipe)) {
		return 'the MCP server was started without the required pipe or token';
	}
	const token = fromArgs ? tokenFrom(path.resolve(tokenValue)) : tokenFrom(tokenValue);
	if (Array.isArray(token)) {
		return token[0];
	}
	const window = record ? windowOf(record) : undefined;
	const pipe = window?.pipe ?? launchedPipe;
	if (!pipe) {
		return `the window has not recorded a listening address in ${record}`;
	}
	return { pipe, token, disabled: window?.enabled === false, ...(window ? { window: window.id } : {}) };
}

/** Whether this server was started for an agent or a script at all: a CLI run by hand in a folder Facade wrote a configuration into was not. */
function isConfigured(args: readonly string[]): boolean {
	if (args.includes('--token-file')) {
		return true;
	}
	const { FACADE_AGENTS_RECORD: envRecord, FACADE_AGENTS_PIPE: envPipe, FACADE_AGENTS_TOKEN: envToken } = process.env;
	return !!given(envToken) && (!!given(envRecord) || !!given(envPipe));
}

/**
 * A wait in milliseconds, as the environment variable `name` sets it - an agent's launch, as the person
 * set it, or a test - else `ms`; never longer than a timer takes.
 */
function waitFromEnv(name: string, ms: number): number {
	const value = Number(process.env[name]);
	return Math.min(Number.isFinite(value) && value > 0 ? value : ms, MAX_TIMER_MS);
}

/** Whether a call's `agent` names a run by its number, as `#a7` or `@name #a7`, not by a name alone. */
function namesRun(toolArgs: unknown): boolean {
	const agent = isJsonObject(toolArgs) ? toolArgs.agent : undefined;
	return typeof agent === 'string' && /(^|\s)#a\d+$/i.test(agent.trim());
}

/**
 * What a caller does next after a call whose outcome is not known, as its tool needs it: look before anything goes
 * in twice - never run again by itself (AGENT-DEBUGGING.md, D5; AGENT-MESSAGES.md, M11). `made`, the run a start made;
 * `away`, whether the window went, so that a call that changes nothing waits for it to come back - else it has nothing to do.
 */
function recoveryOf(name: string, toolArgs: unknown, made: number | undefined, away: boolean): string | undefined {
	switch (name) {
		case 'type_text':
		case 'press_keys':
			return namesRun(toolArgs)
				? 'Input may already have been written. Call read_screen for the target before sending more text or keys.'
				: 'Input may already have been written. Identify the original target run, then call read_screen before sending more input.';
		case 'send_message':
			return 'Messages may already have been recorded. Resend only if you establish that they were not recorded.';
		case 'read_messages':
			return 'Messages from this fetch may already be marked delivered. Use read_messages with ids to recover known messages, or all:true for your inbox history. Message IDs remain stable.';
		case 'start_agent':
		case 'stop_agent':
			return made !== undefined || (name === 'stop_agent' && namesRun(toolArgs)) ? 'Inspect the existing run with list_agents before retrying the action.' : 'Inspect list_agents before retrying the action.';
		default:
			return away ? 'Retry after the Facade window reconnects.' : undefined;
	}
}

async function serveMcp(args: readonly string[]): Promise<void> {
	const isAgent = args.includes('--token-file') || args.includes('--agent');
	const waitMs = isAgent ? waitFromEnv('FACADE_AGENTS_WAIT_MS', WINDOW_WAIT_MS) : waitFromEnv('FACADE_SCRIPT_WAIT_MS', SCRIPT_WAIT_MS);
	// A call the window accepted ends with a word from it - progress, then its result - within its own wait;
	// past that and a margin, the window is taken as gone without a word (frozen, killed).
	const silenceMs = waitFromEnv('FACADE_AGENTS_SILENCE_MS', Math.min(Math.max(waitMs, WINDOW_WAIT_MS) + SILENCE_MARGIN_MS, MAX_TIMER_MS));
	// A CLI run by hand where Facade's configuration is gets no Facade tools and no noise (O9).
	const configured = isConfigured(args);
	let hello: Hello | undefined;
	let unavailable = '';
	/** Since when the window is away, through every call: one outage is waited for once, not once per call (O8). */
	let awaySince: number | undefined;
	/** Whether the client was given the record's tools, not the window's: once the window comes, it is told the tools changed. */
	let gaveRecorded = false;
	/** Aborted once the CLI closed the MCP server's input: what waits for the window stops. */
	const stopped = new AbortController();
	/** Set once the window refused this server for good - its token, or a hello it cannot read: nothing to look for. */
	let refused = false;
	/** A hello on its way, which another wait for the window takes too: one hello at a time. */
	let connecting: Promise<Hello | undefined> | undefined;
	/** Whether the window is looked for in the background. */
	let discovering = false;
	/** The window this server said hello to last, as the record named it then (`Connection.window`). */
	let helloWindow: string | undefined;
	/** A hello again on its way (`helloAgain`): one at a time. */
	let sayingAgain: Promise<void> | undefined;
	/** Whether an agent's server watches the record for a window back from a reload, to say hello to it. */
	let watching = false;

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
					unavailable = 'Facade returned a handshake that this version cannot read';
					refused = true;
					return undefined;
				}
				helloWindow = connection.window;
				return received;
			} catch (err) {
				const code = err instanceof PipeClientError ? err.code : undefined;
				if (code === 'UNAUTHORIZED') {
					unavailable = 'Facade no longer accepts this session\'s token';
					refused = true;
					return undefined;
				}
				awaySince ??= Date.now();
				unavailable = code === 'UNREACHABLE' || code === 'NOT_CONNECTED' ? `cannot reach Facade (${messageOf(err)})` : `the Facade window's handshake failed (${messageOf(err)})`;
			}
			if (Date.now() >= deadline) {
				return undefined;
			}
			await timeout(RETRY_MS, stopped.signal);
		}
	};

	/**
	 * The tools: the window's, once it says hello, waiting no longer than a client waits for a server that starts; until
	 * then the same tools as the window wrote them into the record, never a tool of the server's own (L1; O8).
	 */
	const tools = async (maxWaitMs = Math.min(outageLeft(), INITIALIZE_WAIT_MS)): Promise<readonly McpTool[]> => {
		if (!configured) {
			return [];
		}
		if (!hello) {
			connecting ??= connect(maxWaitMs).finally(() => connecting = undefined);
			hello = await connecting;
			if (hello && gaveRecorded) {
				gaveRecorded = false;
				server.toolsChanged();
			}
			if (hello) {
				watchWindow();
			}
		}
		if (!hello) {
			gaveRecorded = true;
			discover();
			return recordedTools(args);
		}
		return hello.tools;
	};

	/**
	 * An agent's server whose client was given the record's tools looks for the window in the background, and says
	 * once it came - its tools listed anew, start_agent's with what only the window knows - rather than waiting for a
	 * call that may never come (O8).
	 */
	const discover = () => {
		if (!isAgent || discovering || refused) {
			return;
		}
		discovering = true;
		void (async () => {
			try {
				while (!hello && !refused && !stopped.signal.aborted) {
					await timeout(DISCOVER_MS, stopped.signal);
					await tools(0);
				}
			} catch (err) {
				// Cancelled, its CLI closed it: nothing more to look for. Whatever else ends the looking is said
				if (!(err instanceof CancelledError)) {
					log(`Could not find the Facade window: ${stackOf(err)}`);
				}
			} finally {
				discovering = false;
			}
		})();
	};

	/**
	 * Says hello again to the window the record names now, where it is not the one this server said hello to: a window
	 * back from a reload - a new extension host - knows which process serves the agent only from a hello, and without
	 * one never sees it end (AGENT-ORCHESTRATION.md, O6, O8). Its tools, where they changed, are listed anew. A window
	 * that does not answer yet is tried again at the next look; one that no longer knows this server's token refuses it
	 * for good.
	 */
	const helloAgain = (connection: Connection): Promise<void> => {
		if (!hello || refused || connection.window === undefined || connection.window === helloWindow) {
			return Promise.resolve();
		}
		sayingAgain ??= (async () => {
			try {
				const received = helloOf(await new PipeClient(connection.pipe, connection.token).hello(AbortSignal.any([stopped.signal, AbortSignal.timeout(RETRY_MS)])));
				if (received && hello) {
					helloWindow = connection.window;
					const changed = !sameJson(received.tools, hello.tools);
					hello = received;
					if (changed) {
						server.toolsChanged();
					}
				}
			} catch (err) {
				if (err instanceof PipeClientError && err.code === 'UNAUTHORIZED') {
					unavailable = 'Facade no longer accepts this session\'s token';
					refused = true;
				}
			}
		})().finally(() => sayingAgain = undefined);
		return sayingAgain;
	};

	/**
	 * An agent's server, once it said hello, looks at the record now and then for a window back from a reload, and says
	 * hello to it as it comes - not only with the next call, which an agent waiting for a message may not make for long.
	 */
	const watchWindow = () => {
		if (!isAgent || watching) {
			return;
		}
		watching = true;
		void (async () => {
			try {
				while (!refused && !stopped.signal.aborted) {
					await timeout(DISCOVER_MS, stopped.signal);
					const connection = connectionOf(args);
					if (typeof connection !== 'string') {
						await helloAgain(connection);
					}
				}
			} catch (err) {
				// Cancelled, its CLI closed it: nothing more to look for. Whatever else ends the watching is said
				if (!(err instanceof CancelledError)) {
					log(`Could not watch for the window to return after a reload: ${stackOf(err)}`);
				}
			}
		})();
	};

	const call = async (name: string, toolArgs: unknown, context: { readonly signal: AbortSignal; progress(message: string): void }): Promise<ToolResult> => {
		if (!hello) {
			// The window may have come since the client listed the tools: said hello to now, the call goes to it
			await tools(0);
			if (!hello) {
				return { text: `${name} did not run: Facade is unavailable (${unavailable || 'reason unknown'}).${refused ? '' : ' Retry after the Facade window reconnects.'}`, isError: true, data: { code: 'UNAVAILABLE' } };
			}
		}
		// A call that finds no window has not run: it waits for the window, as through a reload - for what is
		// left of this outage, which every call shares.
		let waiting = false;
		// The run the call made, once the window said: what a call cut after names.
		let made: number | undefined;
		// What may have happened, and what to do about it, for a call whose outcome is not known
		const afterUnknown = (away: boolean) => {
			const recovery = recoveryOf(name, toolArgs, made, away);
			return `${made !== undefined ? ` Recorded run: #a${made}.` : ''}${recovery ? ` ${recovery}` : ''}`;
		};
		const madeData = () => made !== undefined ? { agent: made } : {};
		for (; ;) {
			const tried = Date.now();
			const connection = connectionOf(args);
			if (typeof connection === 'string') {
				return { text: `${name} did not run: Facade is unavailable (${connection}).`, isError: true, data: { code: 'UNAVAILABLE' } };
			}
			// A window back from a reload is told which process serves the agent before the call goes to it
			await helloAgain(connection);
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
				return result ?? { text: `Facade returned an unreadable result for ${name}. The call may have taken effect; its outcome is unknown.${afterUnknown(false)}`, isError: true, data: { code: 'FAILED' } };
			} catch (err) {
				const code = err instanceof PipeClientError ? err.code : undefined;
				if (silence.signal.aborted && !context.signal.aborted) {
					return { text: `${name} was accepted, but no result or progress arrived for ${Math.round(silenceMs / 1000)} seconds. The call may have taken effect.${afterUnknown(true)}`, isError: true, data: { code: 'UNAVAILABLE', outcome: 'unknown', ...madeData() } };
				}
				if (code === 'CANCELLED' || context.signal.aborted) {
					throw err;
				}
				if (code === 'UNAUTHORIZED') {
					return { text: `This Facade session has ended; ${hello ? `@${hello.name}` : 'this session'} is no longer accepted. Stop working.`, isError: true, data: { code: 'REFUSED' } };
				}
				if (code === 'UNREACHABLE') {
					if (connection.disabled) {
						return { text: `Facade tools are disabled by facade.orchestration.enabled. ${name} did not run.`, isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
					}
					awaySince ??= Date.now();
					if (outageLeft() > 0) {
						if (!waiting) {
							waiting = true;
							context.progress('Waiting for the Facade window to reconnect.');
						}
						// Tried each second: a try the window did not take in time has had its second already (N-43)
						await timeout(Math.min(Math.max(RETRY_MS - (Date.now() - tried), 0), outageLeft()), context.signal);
						continue;
					}
					return { text: `${name} did not run: the Facade window did not reconnect (${clauseOf(messageOf(err))}). Retry after the window reconnects.`, isError: true, data: { code: 'UNAVAILABLE' } };
				}
				if (code === 'TOO_LARGE') {
					return { text: `${name} was rejected before execution: the encoded request exceeds 1 MiB. Put large content in a file and send the file path.`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'REJECTED') {
					return { text: `${name} did not run: Facade could not read the request (${messageOf(err)}).`, isError: true, data: { code: 'INVALID' } };
				}
				if (code === 'NOT_CONNECTED') {
					return { text: `The Facade window disconnected during ${name} (${messageOf(err)}). The call may have taken effect.${afterUnknown(true)}`, isError: true, data: { code: 'UNAVAILABLE', outcome: 'unknown', ...madeData() } };
				}
				return { text: `${name} failed in the Facade window: ${messageOf(err)}`, isError: true, data: { code: 'FAILED' } };
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
		log
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
