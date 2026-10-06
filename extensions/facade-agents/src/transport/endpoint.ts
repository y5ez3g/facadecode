/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { PipeHandlers, PipeServer } from './pipe';

const WINDOW_FILE = 'window.json';

/** What the window that serves a workspace's agents writes of itself: its pipe, and its process. */
interface WindowRecord {
	readonly pipe: string;
	readonly pid: number;
}

/** How to start an MCP server that calls this endpoint. */
export interface McpServerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/**
 * The window's end of the pipe every agent's MCP server calls. It hands each request to what the host
 * gave it - the process table to know a caller by its token, the contract to answer `/hello` and
 * `/call` - and knows no tool itself. `window.json`, next to the ledger, says which pipe the window
 * listens on, so that a script holding the person's token can reach it.
 *
 * The MCP servers are the shim beside this file - in `out/transport/` as a development build runs it,
 * in `dist/` next to the bundled extension - run as Node by this process's own executable.
 */
export class PipeEndpoint<C> {

	private readonly runtime = process.execPath;
	private readonly shim = path.join(__dirname, 'shim.js');

	private constructor(private readonly dir: string, private readonly server: PipeServer<C>) { }

	/**
	 * Listens on `pipe` and records it in `dir`, the workspace's folder under ~/.facade/workspaces. One
	 * that cannot record where it listens does not listen: its pipe is left for the next try.
	 */
	static async start<C>(pipe: string, dir: string, handlers: PipeHandlers<C>): Promise<PipeEndpoint<C>> {
		const server = await PipeServer.listen(pipe, handlers);
		try {
			writeWindowRecord(dir, { pipe: server.path, pid: process.pid });
		} catch (err) {
			server.dispose();
			throw err;
		}
		return new PipeEndpoint(dir, server);
	}

	/** The pipe it listens on. */
	get pipe(): string {
		return this.server.path;
	}

	/** An agent's MCP server: the shim, run as Node, with the file that holds the agent's token; it waits `waitMs` for the window. */
	mcpServer(tokenFile: string, waitMs: number): McpServerLaunch {
		return {
			command: this.runtime,
			args: [this.shim, 'mcp', '--pipe', this.pipe, '--token-file', tokenFile],
			env: { ELECTRON_RUN_AS_NODE: '1', FACADE_AGENTS_WAIT_MS: String(waitMs) }
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

	/** What an agent whose CLI starts `sharedMcpServer` has in its environment: this pipe, its token, and how long its server waits for the window. */
	agentEnv(token: string, waitMs: number): { readonly [name: string]: string } {
		return { FACADE_AGENTS_PIPE: this.pipe, FACADE_AGENTS_TOKEN: token, FACADE_AGENTS_WAIT_MS: String(waitMs) };
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
		const { pipe, pid } = read;
		return typeof pipe === 'string' && typeof pid === 'number' ? { pipe, pid } : undefined;
	} catch {
		return undefined;
	}
}

function writeWindowRecord(dir: string, record: WindowRecord): void {
	replaceFile(path.join(dir, WINDOW_FILE), JSON.stringify(record));
}
