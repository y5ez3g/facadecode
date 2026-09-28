/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { HookPolicy } from './common/agents';
import { sleep } from './common/async';
import { IpcClient, IpcClientError } from './common/ipc';
import { McpStdioServer, McpTool, McpToolResult } from './common/mcp';
import { findInstance } from './common/registry';
import { killTree, toSpawnable } from './common/spawn';
import { DISCONNECTED_TOOLS, Role, toolsFor } from './common/tools';

/*
 * Facade's helper process, run by the Facade executable with ELECTRON_RUN_AS_NODE=1, the way the
 * git extension runs askpass:
 *
 *   shim.js mcp --pipe <pipe> --token-file <file>     the MCP server of a worker, as Facade launched it
 *   shim.js mcp --registry <dir>                      the MCP server of a lead, through the plugin
 *   shim.js run --log <file> -- <agent> <args>        a headless worker: runs it, logs its output
 *   shim.js hook --pipe ... --policy <file> <mode>    an agent's command hook
 *
 * The MCP server speaks MCP on stdio and forwards every tool call to the engine in the Facade
 * window over the pipe. It holds no state: when the window reloads, it reconnects.
 */

const VERSION = '0.1.0';
const RECONNECT_MS = 60_000;
const HOOK_TIMEOUT_MS = 20_000;
/** Tools that are safe to repeat when the window reloaded under a call. */
const REPEATABLE = new Set(['get_contract', 'program_status', 'await_events', 'report_progress', 'review_packet', 'whoami', 'who', 'recv', 'read', 'list']);

/**
 * What the window says to a new connection. The workspace's participants get their tools and the
 * model's instructions from it; the program engine's lead and workers get a role.
 */
interface Hello {
	readonly role?: Role;
	readonly name?: string;
	readonly tools?: readonly McpTool[];
	readonly instructions?: string;
}

interface Connection {
	readonly pipe: string;
	readonly token: string;
}

function argument(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Finds the pipe and token, from the most specific source to the least. */
function resolveConnection(args: readonly string[], cwd: string): Connection | string {
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
	const registry = argument(args, '--registry');
	if (registry) {
		const instance = findInstance(registry, cwd);
		if (instance) {
			return { pipe: instance.pipe, token: instance.token };
		}
		return `no Facade window with orchestration turned on has ${cwd} in its workspace`;
	}
	return 'it was started without a pipe or a registry';
}

async function serveMcp(args: readonly string[]): Promise<void> {
	const cwd = process.cwd();
	const isWorker = args.includes('--token-file');
	let hello: Hello | undefined;
	let reason = '';
	let client: IpcClient | undefined;

	/** Says hello to the window; waits through a window reload. Undefined when there is no window. */
	const connect = async (): Promise<Hello | undefined> => {
		const deadline = Date.now() + (isWorker ? RECONNECT_MS : 5_000);
		for (; ;) {
			const connection = resolveConnection(args, cwd);
			if (typeof connection === 'string') {
				reason = connection;
			} else {
				client = new IpcClient(connection.pipe, connection.token);
				try {
					return await client.hello<Hello>();
				} catch (err) {
					reason = err instanceof IpcClientError && err.code === 'UNAUTHORIZED' ? 'Facade no longer accepts this session\'s token' : `Facade is not reachable (${(err as Error).message})`;
					if (err instanceof IpcClientError && err.code === 'UNAUTHORIZED' && isWorker) {
						return undefined;
					}
				}
			}
			if (Date.now() >= deadline) {
				return undefined;
			}
			await sleep(1000);
		}
	};

	const tools = async (): Promise<readonly McpTool[]> => {
		hello ??= await connect();
		if (!hello) {
			return DISCONNECTED_TOOLS;
		}
		return hello.tools ?? (hello.role ? toolsFor(hello.role) : DISCONNECTED_TOOLS);
	};

	const instructions = async (): Promise<string | undefined> => {
		await tools();
		if (hello?.instructions) {
			return hello.instructions;
		}
		return isWorker
			? 'You are working on a task delegated through Facade Code. Call get_contract first, report_progress as you go, ask_lead when a decision blocks you, and finish with submit_result.'
			: 'Facade Code tools for leading a program of features built by other agents in parallel. Use the facade build, plan and review skills.';
	};

	const call = async (name: string, toolArgs: unknown, context: { signal: AbortSignal; progress(message: string): void }): Promise<McpToolResult> => {
		if (name === 'facade_status') {
			return { text: `Facade's tools are not available: ${reason || 'unknown reason'}. Turn on the setting facade.orchestration.enabled in Facade, and start the agent from Facade, in a window whose workspace contains ${cwd}.`, isError: true };
		}
		const deadline = Date.now() + RECONNECT_MS;
		for (; ;) {
			try {
				return await client!.call(name, toolArgs, cwd, context.progress, context.signal) as McpToolResult;
			} catch (err) {
				const failure = err as IpcClientError;
				if (failure.code === 'CANCELLED' || context.signal.aborted) {
					throw err;
				}
				if (failure.code === 'UNAUTHORIZED') {
					if (hello?.name) {
						return { text: `Facade no longer accepts @${hello.name} from this process: it was stopped, or a newer agent took its name. Stop working.`, isError: true };
					}
					return { text: isWorker ? 'This attempt is over: another agent or the lead has the feature now. Stop working.' : 'Facade no longer accepts this session. Restart Claude from Facade.', isError: true };
				}
				const repeatable = REPEATABLE.has(name);
				if (!repeatable || Date.now() >= deadline) {
					return { text: `Facade was not reachable during ${name} (${failure.message}); the window may have reloaded. Call ${name} again${repeatable ? ' in a moment' : ''}.`, isError: true };
				}
				context.progress('Facade is reloading; reconnecting');
				await sleep(1000, context.signal);
				await connect();
			}
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
 * A headless worker: runs the agent in the terminal Facade gave this process, appends its JSON
 * output to the log Facade reads usage from, and shows a line per event.
 */
function runAgent(args: readonly string[]): Promise<void> {
	const run = readRun(args);
	if (!run) {
		process.stderr.write('Usage: shim.js run --log <file> -- <program> <args>\n');
		process.exitCode = 2;
		return Promise.resolve();
	}
	const { logFile, argv } = run;
	// At once: on Windows, the window learns a terminal's process id with the first thing it shows.
	process.stdout.write(`${path.basename(argv[0])} runs headless here. Its output is logged in ${logFile}.\n`);
	// The agent is not Electron: this process's own switch must not reach it.
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const spawnable = toSpawnable(argv, env);
	const out = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
	const child = spawn(spawnable.command, [...spawnable.args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'inherit'], windowsVerbatimArguments: spawnable.windowsVerbatimArguments, windowsHide: true });
	let pending = '';
	child.stdout!.on('data', (chunk: Buffer) => {
		out.write(chunk);
		pending += chunk.toString('utf8');
		let newline: number;
		while ((newline = pending.indexOf('\n')) >= 0) {
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			const shown = describeLine(line);
			if (shown) {
				process.stdout.write(`${shown}\n`);
			}
		}
	});
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(signal, () => killTree(child));
	}
	return new Promise(resolve => {
		child.on('error', err => {
			process.stderr.write(`Could not start ${argv[0]}: ${err.message}\n`);
			process.exitCode = 1;
			out.end(resolve);
		});
		child.on('close', code => {
			process.stdout.write(`\n${argv[0]} exited with code ${code ?? 'unknown'}.\n`);
			process.exitCode = code ?? 1;
			out.end(resolve);
		});
	});
}

/** What `run` runs, from its arguments. */
function readRun(args: readonly string[]): { readonly logFile: string; readonly argv: readonly string[] } | undefined {
	const logFile = argument(args, '--log');
	const separator = args.indexOf('--');
	const argv = separator >= 0 ? args.slice(separator + 1) : [];
	return logFile && argv.length ? { logFile, argv } : undefined;
}

/** One readable line for a line of an agent's JSON stream. */
function describeLine(line: string): string | undefined {
	if (!line.startsWith('{')) {
		return line || undefined;
	}
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		const type = String(event.type ?? event.event ?? 'event');
		const text = findText(event);
		return text ? `[${type}] ${text.replace(/\s+/g, ' ').slice(0, 300)}` : `[${type}]`;
	} catch {
		return line;
	}
}

function findText(value: unknown, depth = 0): string | undefined {
	if (!value || typeof value !== 'object' || depth > 5) {
		return undefined;
	}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if ((key === 'text' || key === 'text_delta' || key === 'result' || key === 'response') && typeof item === 'string' && item.trim()) {
			return item;
		}
		const nested = findText(item, depth + 1);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

/**
 * An agent's command hook. The mode comes last. `agy-pretool` decides from the attempt's policy
 * file: Facade's tools and the acceptance commands are allowed, the git commands the engine owns
 * are refused, and anything else is left to the agent's own prompt. `agy-stop` asks the engine.
 */
async function runHook(args: readonly string[]): Promise<void> {
	const mode = args[args.length - 1];
	const input = await readStdin();
	if (mode.startsWith('event:')) {
		// A workspace participant's hook: tell the window, and print what it answers for the agent.
		const event = mode.slice('event:'.length);
		let output = event === 'agy-stop' ? JSON.stringify({ decision: 'stop' }) : '';
		const connection = resolveConnection(args, process.cwd());
		if (typeof connection !== 'string') {
			try {
				const result = await Promise.race([
					new IpcClient(connection.pipe, connection.token).call('_hook', { event, payload: input }, process.cwd(), () => { }),
					sleep(HOOK_TIMEOUT_MS).then(() => undefined)
				]) as McpToolResult | undefined;
				if (result && !result.isError && result.text) {
					output = result.text;
				}
			} catch {
				// Facade is not there: the agent goes on as if it had no hook.
			}
		}
		if (output) {
			process.stdout.write(`${output}\n`);
		}
		return;
	}
	if (mode === 'agy-pretool') {
		process.stdout.write(`${JSON.stringify(preToolDecision(input, argument(args, '--policy')))}\n`);
		return;
	}
	if (mode === 'agy-stop') {
		let output = JSON.stringify({ decision: 'stop' });
		const connection = resolveConnection(args, process.cwd());
		if (typeof connection !== 'string') {
			try {
				const result = await Promise.race([
					new IpcClient(connection.pipe, connection.token).call('worker_hook', { event: 'agy-stop' }, process.cwd(), () => { }),
					sleep(HOOK_TIMEOUT_MS).then(() => undefined)
				]) as McpToolResult | undefined;
				if (result && !result.isError && result.text) {
					output = result.text;
				}
			} catch {
				// Facade is not there: let the agent stop.
			}
		}
		process.stdout.write(`${output}\n`);
		return;
	}
	process.stderr.write(`Unknown hook mode ${mode}\n`);
	process.exitCode = 2;
}

export function preToolDecision(input: unknown, policyFile: string | undefined): { decision: string; reason?: string } {
	let policy: HookPolicy;
	try {
		policy = JSON.parse(fs.readFileSync(policyFile ?? '', 'utf8')) as HookPolicy;
	} catch {
		return { decision: 'ask' };
	}
	const call = (input as { toolCall?: { name?: unknown; args?: Record<string, unknown> } } | undefined)?.toolCall;
	const tool = typeof call?.name === 'string' ? call.name : '';
	if (tool === 'call_mcp_tool') {
		// Facade's own tools are the worker's protocol; any other server's stay with the agent's own rules.
		return call?.args?.ServerName === policy.server ? { decision: 'allow' } : { decision: 'ask' };
	}
	if (tool === 'run_command') {
		const line = String(call?.args?.CommandLine ?? '').trim();
		const starts = (prefix: string) => line === prefix || line.startsWith(`${prefix} `);
		if (policy.denyCommands.some(starts)) {
			return { decision: 'deny', reason: 'Facade owns the branches: do not merge, rebase, reset, push or switch branches. Call submit_result when you are done.' };
		}
		// Only a plain command: a shell operator could chain anything after an allowed prefix.
		if (!/[;&|<>`$\n]/.test(line) && policy.allowCommands.some(starts)) {
			return { decision: 'allow' };
		}
	}
	return { decision: 'ask' };
}

function readStdin(): Promise<unknown> {
	return new Promise(resolve => {
		const chunks: Buffer[] = [];
		process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
		process.stdin.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				resolve(undefined);
			}
		});
		process.stdin.on('error', () => resolve(undefined));
	});
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case 'mcp': return serveMcp(args);
		case 'run': return runAgent(args);
		case 'hook': return runHook(args);
	}
	process.stderr.write('Usage: shim.js mcp (--pipe <pipe> --token-file <file> | --registry <dir>) | run --log <file> -- <agent> <args> | hook ... <mode>\n');
	process.exitCode = 2;
}

if (require.main === module) {
	main().catch(err => {
		process.stderr.write(`facade shim: ${(err as Error).stack ?? err}\n`);
		process.exitCode = 1;
	});
}
