/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Facade MCP server and skill as each CLI is given them (CLIS-2.2, MCP-6.1): per-run launch files and arguments first, and only
// where a CLI requires one a project file, which `injected.ts` writes under its preservation rules. The server is the run's stdio
// shim, routed by the run's ID - an address, never a credential. Each adapter owns its own integration and how far it is verified.

import * as path from 'path';
import type { JsonObject } from '../base/json';

/** A capability as an adapter can stand behind it (CLIS-2.1): supported, unavailable or unverified, with why. */
export interface Capability {
	readonly state: 'supported' | 'unavailable' | 'unverified';
	readonly reason: string;
}

/** The server's name in every CLI's configuration, and the skill's (MCP-6.1, D50). */
export const SERVER_NAME = 'facade';

/**
 * How long a CLI that times its MCP calls lets one of Facade's run, in seconds: the longest wait for a start or a stop MCP-1.3
 * allows, `facade.collaboration.waitSeconds` at 3600, and a minute for the call's own route and answer, so that the CLI never
 * gives up on a call Facade is still answering within its wait.
 */
export const MOST_CALL_SECONDS = 3_660;

/** An MCP stdio server as a CLI's configuration names it: the window's McpServerLaunch, as plain data here. */
export interface McpServer {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/** What a launch with the tools is given (CLIS-2.2): the run's server, the bundled skill's SKILL.md and the run's own folder. */
export interface ToolsInput {
	readonly server: McpServer;
	readonly skill: string;
	/** Where the run's launch files go, in the execution environment's Facade directory. */
	readonly runDir: string;
	/** The platform the CLI runs on, where how it is given the tools depends on it. */
	readonly platform?: NodeJS.Platform;
}

/**
 * Content Facade owns in a project folder (CLIS-2.2): a file, whole, or the member `keys` of a JSON object there - such as
 * `mcpServers.facade` - with the rest of the file the person's. Paths are relative to the launch folder.
 */
export type ProjectWrite =
	| { readonly kind: 'file'; readonly path: string; readonly content: string }
	| { readonly kind: 'entry'; readonly path: string; readonly keys: readonly [string, string]; readonly value: JsonObject };

/** What one launch is given to reach the tools. */
export interface Injection {
	/** The `${name}`s of the adapter's `connect` group. */
	readonly values: { readonly [name: string]: string };
	/** Arguments of the launch alone that go where its `connect` group goes, for an integration whose arguments vary by platform. */
	readonly args?: readonly string[];
	/** Files of the run alone, under its folder: absolute paths. */
	readonly runFiles: readonly { readonly path: string; readonly content: string }[];
	/** Content shared by the runs in the project folder. */
	readonly project: readonly ProjectWrite[];
	/** Routing variables the CLI's environment carries, for a server it starts from a project entry every run shares (CLIS-1.2). */
	readonly env: { readonly [name: string]: string };
}

/** How a CLI is given the Facade tools (CLIS-2.2). */
export interface ToolsIntegration {
	/** How far it is verified, and why. */
	readonly capability: Capability;
	/** Where it goes, in words for Show Agent Launch. */
	where(runDir: string, cwd: string): string;
	inject(input: ToolsInput): Injection;
}

/** The run's folder of launch files, in the Facade directory `home`. */
export function runDirOf(home: string, run: string): string {
	return path.join(home, 'runs', run, 'tools');
}

/** A run's MCP configuration file, as `--mcp-config` reads one. */
export const MCP_CONFIG = 'mcp.json';
/** The skill as Codex and Antigravity read it from a project, and as plugins hold it. */
export const SKILL_FILE = path.join('skills', SERVER_NAME, 'SKILL.md');

/** The one variable a shared server entry keeps: its runtime runs as Node for the server alone, never for an agent CLI (CLIS-1.2). */
const RUNTIME_VARIABLE = 'ELECTRON_RUN_AS_NODE';

/**
 * `server` as a project entry every run in the folder shares, and the run's own variables, which the CLI's environment then carries
 * to the server it starts: a shared entry holds no run's identity, so that it is the same for each and is counted, not replaced.
 */
export function sharedServer(server: McpServer): { readonly server: McpServer; readonly env: { readonly [name: string]: string } } {
	const entries = Object.entries(server.env);
	return {
		server: { command: server.command, args: server.args, env: Object.fromEntries(entries.filter(([name]) => name === RUNTIME_VARIABLE)) },
		env: Object.fromEntries(entries.filter(([name]) => name !== RUNTIME_VARIABLE))
	};
}

/** `server` as an `mcpServers` entry: the shape Claude Code, Qwen Code, Muse Code and Antigravity read. */
export function serverEntry(server: McpServer): JsonObject {
	return { command: server.command, args: [...server.args], env: { ...server.env } };
}

/** An MCP configuration naming `server` alone, as JSON text. */
export function mcpConfigText(server: McpServer): string {
	return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: serverEntry(server) } }, undefined, 2)}\n`;
}

/** A plugin's manifest: its name and what it is. */
export function pluginManifest(): JsonObject {
	return { name: SERVER_NAME, description: 'The Facade Code tools: start agents, send and read messages, and read or type into agent terminals.' };
}
