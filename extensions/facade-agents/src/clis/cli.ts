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

/** A skill handed to an agent at its launch (WORKTREE-AGENTS.md, WA-12.5). */
export interface Skill {
	readonly name: string;
	/** When the agent should use it, as the CLI shows the model. */
	readonly description: string;
	/** Its text, in Markdown. */
	readonly body: string;
}

export interface LaunchInput {
	/** Its worktree's folder, which it runs in. */
	readonly folder: string;
	/** Its first message, if it is given one. */
	readonly prompt?: string;
	readonly model: string;
	readonly mcp: McpLaunch;
	/** The command its hooks run: the event goes after it, as `event:stop` (WA-7.1). */
	readonly hookCommand: string;
	readonly skills: readonly Skill[];
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
	/** Written before the launch, readable only by the user. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** What one of a CLI's hooks said happened, in Facade's words (WA-4.5). */
export type HookEvent =
	/** A session begins: at the start, after `/clear`, after a compaction (WA-7.4). */
	| { readonly kind: 'start' }
	/** A turn begins: the person, or something typed, gave it a prompt. */
	| { readonly kind: 'prompt' }
	/** Its turn would end; `continuing` when it goes on only because a Stop hook blocked it before. */
	| { readonly kind: 'stop'; readonly continuing: boolean }
	/** It waits at a permission prompt or a question in its terminal. */
	| { readonly kind: 'waiting'; readonly what: string }
	/** It has been idle at its input box a while. */
	| { readonly kind: 'idle' };

/** The first question a CLI asks in a folder it has not seen, and the answer to pick (section 8). */
export interface FirstRunQuestion {
	/** A line of the screen that asks it. */
	readonly question: RegExp;
	/** The menu line to pick. */
	readonly answer: RegExp;
	/** The line the menu's cursor is on. */
	readonly cursor: RegExp;
}

/**
 * What Facade knows of an agent CLI: how to find it, which models it offers, how to start it in its
 * own interactive UI (WORKTREE-AGENTS.md, section 7), and how it talks through its hooks and its
 * terminal. Each launch's configuration is its own - its flags, and files in its run folder - and
 * nothing goes into the user's own agent configuration. From M4 this comes from the driver data
 * (section 13).
 */
export interface AgentCli {
	/** As `spawn` and Start Agent name it: `claude`. */
	readonly id: string;
	readonly displayName: string;
	/** What to look for on PATH. */
	readonly command: string;
	/** The models Start Agent offers, first the one it suggests. */
	readonly models: readonly string[];
	readonly firstRun?: FirstRunQuestion;
	launch(input: LaunchInput, executable: string): LaunchSpec;
	/** What a hook reported, from the event its command was run with and what the CLI gave it. */
	readHook(event: string, payload: unknown): HookEvent | undefined;
	/** What its session-start hook prints to load `text` ahead of everything else (WA-7.4). */
	openWith(text: string): string;
	/** What its Stop hook prints to go on with `messages` rather than end its turn (WA-6.3). */
	continueWith(messages: string): string;
	/**
	 * The text to type into its terminal for `text`, in the pieces to write one after the other; Enter
	 * follows them (WA-6.4).
	 */
	typing(text: string): readonly string[];
}
