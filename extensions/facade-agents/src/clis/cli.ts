/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How to start Facade's MCP server for one agent: the shim, with its arguments. */
export interface McpLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

export interface LaunchInput {
	/** Its worktree's folder, which it runs in. */
	readonly folder: string;
	/** Its first message, if it is given one. */
	readonly prompt?: string;
	readonly model: string;
	readonly mcp: McpLaunch;
	/** Where the launch may write its own files. */
	readonly runDir: string;
	/** Unique per incarnation, for the names of those files. */
	readonly slug: string;
}

export interface LaunchSpec {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** Written into the run folder, readable only by the user, before the launch. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
}

/**
 * What Facade knows of an agent CLI: how to find it, which models it offers, and how to start it in
 * its own interactive UI (WORKTREE-AGENTS.md, section 7). Each launch's configuration is its own - its
 * flags, and files in its run folder - and nothing goes into the user's own agent configuration. From
 * M4 this comes from the driver data (section 13).
 */
export interface AgentCli {
	/** As `spawn` and Start Agent name it: `claude`. */
	readonly id: string;
	readonly displayName: string;
	/** What to look for on PATH. */
	readonly command: string;
	/** The models Start Agent offers, first the one it suggests. */
	readonly models: readonly string[];
	launch(input: LaunchInput, executable: string): LaunchSpec;
}
