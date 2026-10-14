/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { PipeHandlers, PipeServer } from './pipe';
import { McpTool, TOOLS_FILE } from './protocol';

const WINDOW_FILE = 'window.json';

/** What the window that serves a workspace's agents writes of itself: its pipe, its process, and whether the agent framework is on. */
interface WindowRecord {
	readonly pipe: string;
	readonly pid: number;
	readonly enabled: boolean;
}

/** How to start an MCP server that calls this endpoint. */
export interface McpServerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/**
 * The window's end of the pipe every agent's MCP server calls. It hands each request to what the host
 * gave it - the agent table to know a caller by its token, the contract to answer `/hello` and
 * `/call` - and knows no tool itself. `window.json`, next to the ledger, says which pipe the window
 * listens on, so that a script holding the person's token can reach it; `tools.json`, the tools the host
 * gave it, which an agent's MCP server lists while the window does not answer.
 *
 * The MCP servers are the shim beside this file - in `out/transport/` as a development build runs it,
 * in `dist/` next to the bundled extension - run as Node by this process's own executable.
 */
export class PipeEndpoint<C> {

	private readonly runtime = process.execPath;
	private readonly shim = path.join(__dirname, 'shim.js');

	private constructor(private readonly dir: string, private readonly server: PipeServer<C>, private enabled: boolean) { }

	/**
	 * Listens on `pipe` and records it in `dir`, the workspace's folder under ~/.facade/workspaces, with
	 * whether the agent framework is on - and, where given, `tools`, the tools it serves, which an agent's MCP
	 * server lists while the window does not answer (`TOOLS_FILE`). One that cannot record where it listens does
	 * not listen: its pipe is left for the next try.
	 */
	static async start<C>(pipe: string, dir: string, handlers: PipeHandlers<C>, enabled = true, tools?: readonly McpTool[]): Promise<PipeEndpoint<C>> {
		const server = await PipeServer.listen(pipe, handlers);
		try {
			if (tools) {
				replaceFile(path.join(dir, TOOLS_FILE), JSON.stringify(tools));
			}
			writeWindowRecord(dir, { pipe: server.path, pid: process.pid, enabled });
		} catch (err) {
			server.dispose();
			throw err;
		}
		return new PipeEndpoint(dir, server, enabled);
	}

	/**
	 * Records whether the agent framework is on, for the agents' MCP servers to say at once that it is off
	 * while the window is away (AGENT-LAUNCHER.md, L13).
	 */
	setEnabled(enabled: boolean): void {
		if (enabled !== this.enabled) {
			this.enabled = enabled;
			writeWindowRecord(this.dir, { pipe: this.server.path, pid: process.pid, enabled });
		}
	}

	/** The pipe it listens on. */
	get pipe(): string {
		return this.server.path;
	}

	/**
	 * An agent's MCP server: the shim, run as Node, with the workspace's record - whose `window.json` says
	 * where the window listens now - and the file that holds the agent's token; it waits `waitMs` for the window.
	 */
	mcpServer(tokenFile: string, waitMs: number): McpServerLaunch {
		return {
			command: this.runtime,
			args: [this.shim, 'mcp', '--record', this.dir, '--pipe', this.pipe, '--token-file', tokenFile],
			env: { ELECTRON_RUN_AS_NODE: '1', FACADE_AGENTS_WAIT_MS: String(waitMs) }
		};
	}

	/**
	 * How an agent reaches this window (AGENT-ORCHESTRATION.md, O9): its MCP server, and the values a launch
	 * names them by - `${executable}`, `${shimFile}`, `${pipe}`, `${recordDir}`, `${tokenFile}`, `${waitMs}` - for
	 * a custom agent's connect group to put together a server of its own.
	 */
	connection(tokenFile: string, waitMs: number, recordDir: string): { readonly mcp: McpServerLaunch; readonly values: { readonly [name: string]: string } } {
		return {
			mcp: this.mcpServer(tokenFile, waitMs),
			values: { executable: this.runtime, shimFile: this.shim, pipe: this.pipe, recordDir, tokenFile, waitMs: String(waitMs) }
		};
	}

	/**
	 * An MCP server the same for every agent, for a CLI that reads its servers from a file every agent
	 * in a worktree shares: it finds the window and the agent from the agent's environment, `agentEnv`,
	 * and waits for the window through a reload as an agent's own does.
	 */
	sharedMcpServer(): McpServerLaunch {
		return { command: this.runtime, args: [this.shim, 'mcp', '--agent'], env: { ELECTRON_RUN_AS_NODE: '1' } };
	}

	/**
	 * What an agent whose CLI starts `sharedMcpServer` has in its environment: the workspace's record, the
	 * pipe as a fallback, its token's file - a path, never the token, which every process the agent starts
	 * would inherit (AGENT-ORCHESTRATION.md, O9) - and how long its server waits for the window.
	 */
	agentEnv(tokenFile: string, waitMs: number): { readonly [name: string]: string } {
		return { FACADE_AGENTS_RECORD: this.dir, FACADE_AGENTS_PIPE: this.pipe, FACADE_AGENTS_TOKEN: tokenFile, FACADE_AGENTS_WAIT_MS: String(waitMs) };
	}

	/** Stops listening, and removes the window record if it is still this window's. */
	dispose(): void {
		this.server.dispose();
		const record = readWindowRecord(this.dir);
		if (record?.pid === process.pid) {
			fs.rmSync(path.join(this.dir, WINDOW_FILE), { force: true });
		}
	}
}

/** The record of the window that serves `dir`'s agents, each field checked: undefined when there is none, or it is not one. */
function readWindowRecord(dir: string): WindowRecord | undefined {
	try {
		const read: unknown = JSON.parse(fs.readFileSync(path.join(dir, WINDOW_FILE), 'utf8'));
		if (!isJsonObject(read)) {
			return undefined;
		}
		const { pipe, pid, enabled } = read;
		return typeof pipe === 'string' && typeof pid === 'number' ? { pipe, pid, enabled: enabled !== false } : undefined;
	} catch {
		return undefined;
	}
}

function writeWindowRecord(dir: string, record: WindowRecord): void {
	replaceFile(path.join(dir, WINDOW_FILE), JSON.stringify(record));
}
