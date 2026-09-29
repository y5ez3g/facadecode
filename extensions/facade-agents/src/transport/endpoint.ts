/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PipeHandlers, PipeServer } from './pipe';

const WINDOW_FILE = 'window.json';
/** Where the launchers of agents' hooks go (WORKTREE-AGENTS.md, section 7). */
const HOOKS_DIR = path.join(os.homedir(), '.facade', 'hooks');

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

	private constructor(private readonly dir: string, private readonly server: PipeServer<C>, private readonly hooksDir: string) { }

	/** Listens on `pipe` and records it in `dir`, the workspace's folder under ~/.facade/workspaces. */
	static async start<C>(pipe: string, dir: string, handlers: PipeHandlers<C>, hooksDir = HOOKS_DIR): Promise<PipeEndpoint<C>> {
		const server = await PipeServer.listen(pipe, handlers);
		writeWindowRecord(dir, { pipe: server.path, pid: process.pid, updatedAt: Date.now() });
		return new PipeEndpoint(dir, server, hooksDir);
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

	/**
	 * The command an agent's hooks run, with their event after it: a launcher under ~/.facade/hooks,
	 * one per run, that starts the shim in its hook mode on this pipe with the agent's token file
	 * (WORKTREE-AGENTS.md, section 7). A CLI runs a hook's command through a shell, which cannot set
	 * the environment the same way everywhere: the launcher sets it.
	 */
	hookCommand(tokenFile: string, run: string): string {
		fs.mkdirSync(this.hooksDir, { recursive: true });
		const command = [process.execPath, path.join(__dirname, 'shim.js'), 'hook', '--pipe', this.pipe, '--token-file', tokenFile];
		const file = path.join(this.hooksDir, `${path.basename(this.dir)}-${run}${process.platform === 'win32' ? '.cmd' : '.sh'}`);
		const script = process.platform === 'win32'
			? ['@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', `${command.map(arg => `"${arg}"`).join(' ')} %*`, ''].join('\r\n')
			: ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec ${command.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')} "$@"`, ''].join('\n');
		fs.writeFileSync(file, script, { mode: 0o700 });
		const launcher = file.split(path.sep).join('/');
		return /\s/.test(launcher) ? `"${launcher}"` : launcher;
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
