/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { IpcServer } from '../ipc';
import { McpToolResult } from '../mcp';
import { Kernel } from './kernel';
import { Caller } from './model';
import { AgentHost, callKernelTool, helloFor, HOOK_TOOL, HookHost, IdeHost } from './tools';

/*
 * The window's end of the pipe every agent's MCP server calls (L2-PLAN, step 27). A token names the
 * caller; the tools are the same for everyone. `window.json` next to the ledger says which pipe the
 * window listens on, so a script holding the person's token can act as @you.
 */

export const WINDOW_FILE = 'window.json';

export interface WorkspaceServerOptions {
	readonly kernel: Kernel;
	readonly pipe: string;
	readonly agents?: AgentHost;
	readonly ide?: IdeHost;
	readonly hooks?: HookHost;
	readonly log?: (message: string) => void;
	/** Told of every call, after it ran: delivery uses it to see who is active. */
	readonly onDidCall?: (caller: Caller, tool: string) => void;
}

export interface WindowRecord {
	readonly pipe: string;
	readonly pid: number;
	readonly updatedAt: number;
}

export class WorkspaceServer {

	private constructor(private readonly options: WorkspaceServerOptions, private readonly server: IpcServer<Caller>) { }

	static async start(options: WorkspaceServerOptions): Promise<WorkspaceServer> {
		const kernel = options.kernel;
		const host = { agents: options.agents, ide: options.ide, hooks: options.hooks };
		// The server's handlers run before the object that owns them exists.
		const owner: { current?: WorkspaceServer } = {};
		const server = await IpcServer.listen<Caller>(options.pipe, {
			authenticate: token => kernel.authenticate(token),
			hello: caller => helloFor(host, caller),
			call: async (caller, tool, args, _cwd, context) => {
				const result: McpToolResult = await callKernelTool(kernel, host, caller, tool, args, context.signal, context.progress);
				owner.current?.called(caller, tool);
				return result;
			}
		});
		const workspace = owner.current = new WorkspaceServer(options, server);
		writeWindowRecord(kernel.dir, { pipe: server.path, pid: process.pid, updatedAt: Date.now() });
		return workspace;
	}

	get pipe(): string {
		return this.server.path;
	}

	private called(caller: Caller, tool: string): void {
		if (tool === HOOK_TOOL) {
			// A hook reports its own state; a Stop hook's call is not a sign of a turn.
			return;
		}
		const participant = this.options.kernel.state.participants.get(caller.name);
		if (participant?.kind === 'agent' && participant.incarnation === caller.incarnation && (participant.state === 'starting' || participant.state === 'idle' || participant.state === 'waiting')) {
			// A call is a sign of life: the agent is in a turn.
			this.options.kernel.setState(caller.name, caller.incarnation, 'working');
		}
		try {
			this.options.onDidCall?.(caller, tool);
		} catch (err) {
			this.options.log?.(`[server] after ${tool}: ${(err as Error).message}`);
		}
	}

	dispose(): void {
		this.server.dispose();
		removeWindowRecord(this.options.kernel.dir);
	}
}

export function writeWindowRecord(dir: string, record: WindowRecord): void {
	const file = path.join(dir, WINDOW_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
	fs.renameSync(temp, file);
}

export function readWindowRecord(dir: string): WindowRecord | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, WINDOW_FILE), 'utf8'));
	} catch {
		return undefined;
	}
}

function removeWindowRecord(dir: string): void {
	const record = readWindowRecord(dir);
	if (record?.pid === process.pid) {
		fs.rmSync(path.join(dir, WINDOW_FILE), { force: true });
	}
}
