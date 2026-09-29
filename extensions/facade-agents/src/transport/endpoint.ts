/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { PipeHandlers, PipeServer } from './pipe';

const WINDOW_FILE = 'window.json';

export interface WindowRecord {
	readonly pipe: string;
	readonly pid: number;
	readonly updatedAt: number;
}

/** How to start an MCP server that calls this endpoint. */
export interface McpServerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/**
 * The window's end of the pipe every agent's MCP server calls (WORKTREE-AGENTS.md, section 18). It
 * hands each request to what the host gave it - the registry to know a caller by its token, the
 * contract to answer `/hello` and `/call` - and knows no tool itself. `window.json`, next to the
 * ledger, says which pipe the window listens on, so that a script holding the person's token can
 * reach it.
 */
export class PipeEndpoint<C> {

	private constructor(private readonly dir: string, private readonly server: PipeServer<C>) { }

	/** Listens on `pipe` and records it in `dir`, the workspace's folder under ~/.facade/workspaces. */
	static async start<C>(pipe: string, dir: string, handlers: PipeHandlers<C>): Promise<PipeEndpoint<C>> {
		const server = await PipeServer.listen(pipe, handlers);
		writeWindowRecord(dir, { pipe: server.path, pid: process.pid, updatedAt: Date.now() });
		return new PipeEndpoint(dir, server);
	}

	get pipe(): string {
		return this.server.path;
	}

	/**
	 * An agent's MCP server: the shim beside this file - in `out/transport/` as a development build
	 * runs it, in `dist/` next to the bundled extension - run by this executable as Node, with the file
	 * that holds the agent's token.
	 */
	mcpServer(tokenFile: string): McpServerLaunch {
		return {
			command: process.execPath,
			args: [path.join(__dirname, 'shim.js'), 'mcp', '--pipe', this.pipe, '--token-file', tokenFile],
			env: { ELECTRON_RUN_AS_NODE: '1' }
		};
	}

	dispose(): void {
		this.server.dispose();
		const record = readWindowRecord(this.dir);
		if (record?.pid === process.pid) {
			fs.rmSync(path.join(this.dir, WINDOW_FILE), { force: true });
		}
	}
}

export function readWindowRecord(dir: string): WindowRecord | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, WINDOW_FILE), 'utf8'));
	} catch {
		return undefined;
	}
}

function writeWindowRecord(dir: string, record: WindowRecord): void {
	const file = path.join(dir, WINDOW_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
	fs.renameSync(temp, file);
}
