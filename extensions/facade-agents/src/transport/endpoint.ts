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

/** The file in a workspace's record that says which window serves its agents, and where. */
export const WINDOW_FILE = 'window.json';

/** An application instance: its main process, by id and start time, which together tell it from a later one (O8). */
export interface AppInstance {
	readonly pid: number;
	readonly start?: number;
}

/**
 * What the window that serves a workspace's agents writes of itself: its pipe, its process, and whether the agent framework
 * is on - and, for the other windows of the machine to find it (AGENT-ORCHESTRATION.md, O8), Facade's version and commit, the
 * workspace's name and first folder, the record's id, this load of the window, its application instance, and - as it
 * closes - that it is closing.
 */
export interface WindowRecord {
	readonly pipe: string;
	readonly pid: number;
	readonly enabled: boolean;
	readonly version?: string;
	readonly commit?: string;
	readonly workspace?: string;
	readonly folder?: string;
	readonly record?: string;
	readonly load?: string;
	readonly instance?: AppInstance;
	readonly closing?: true;
}

/** What a window says of itself in its record beyond its pipe, its process and its switch (O8). */
export type WindowFacts = Pick<WindowRecord, 'version' | 'commit' | 'workspace' | 'folder' | 'record' | 'load' | 'instance'>;

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

	private constructor(private readonly dir: string, private readonly server: PipeServer<C>, private enabled: boolean, private readonly facts: WindowFacts) { }

	/**
	 * Listens on `pipe` and records it in `dir`, the workspace's folder under ~/.facade/workspaces, with
	 * whether the agent framework is on - and, where given, `tools`, the tools it serves, which an agent's MCP
	 * server lists while the window does not answer (`TOOLS_FILE`). One that cannot record where it listens does
	 * not listen: its pipe is left for the next try. `facts` go into the record too, for the other windows of the machine (O8).
	 */
	static async start<C>(pipe: string, dir: string, handlers: PipeHandlers<C>, enabled = true, tools?: readonly McpTool[], facts: WindowFacts = {}): Promise<PipeEndpoint<C>> {
		const server = await PipeServer.listen(pipe, handlers);
		try {
			if (tools) {
				replaceFile(path.join(dir, TOOLS_FILE), JSON.stringify(tools));
			}
			writeWindowRecord(dir, { pipe: server.path, pid: process.pid, enabled, ...facts });
		} catch (err) {
			server.dispose();
			throw err;
		}
		return new PipeEndpoint(dir, server, enabled, facts);
	}

	/**
	 * Records whether the agent framework is on, for the agents' MCP servers to say at once that it is off
	 * while the window is away (AGENT-LAUNCHER.md, L13).
	 */
	setEnabled(enabled: boolean): void {
		if (enabled !== this.enabled) {
			this.enabled = enabled;
			writeWindowRecord(this.dir, { pipe: this.server.path, pid: process.pid, enabled, ...this.facts });
		}
	}

	/**
	 * Says in its record that the window closes: the other windows of the machine take it as gone from now, and send it
	 * nothing more (AGENT-LAUNCHER.md, L6; O8).
	 */
	markClosing(): void {
		writeWindowRecord(this.dir, { pipe: this.server.path, pid: process.pid, enabled: this.enabled, ...this.facts, closing: true });
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

	/**
	 * Stops listening. As the window closes - `closing` - its record goes too, if it is still this window's; through a reload
	 * or an extension host's restart it stays, for the other windows of the machine to tell a window reloading from one gone
	 * (AGENT-ORCHESTRATION.md, O8).
	 */
	dispose(closing = true): void {
		this.server.dispose();
		const record = readWindowRecord(this.dir);
		if (closing && record?.pid === process.pid) {
			fs.rmSync(path.join(this.dir, WINDOW_FILE), { force: true });
		}
	}
}

/** The record of the window that serves `dir`'s agents, each field checked: undefined when there is none, or it is not one. */
export function readWindowRecord(dir: string): WindowRecord | undefined {
	try {
		const read: unknown = JSON.parse(fs.readFileSync(path.join(dir, WINDOW_FILE), 'utf8'));
		if (!isJsonObject(read)) {
			return undefined;
		}
		const { pipe, pid, enabled, version, commit, workspace, folder, record, load, instance, closing } = read;
		const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
		const facts: WindowFacts = Object.fromEntries(Object.entries({ version: text(version), commit: text(commit), workspace: text(workspace), folder: text(folder), record: text(record), load: text(load) }).filter(([, value]) => value !== undefined));
		const app = isJsonObject(instance) && typeof instance.pid === 'number' && Number.isInteger(instance.pid) && instance.pid > 0
			? { pid: instance.pid, ...(typeof instance.start === 'number' ? { start: instance.start } : {}) }
			: undefined;
		return typeof pipe === 'string' && typeof pid === 'number' ? { pipe, pid, enabled: enabled !== false, ...facts, ...(app ? { instance: app } : {}), ...(closing === true ? { closing } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

function writeWindowRecord(dir: string, record: WindowRecord): void {
	replaceFile(path.join(dir, WINDOW_FILE), JSON.stringify(record));
}
