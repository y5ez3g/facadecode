/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface Disposable {
	dispose(): void;
}

/** An agent's CLI, started in a terminal. */
export interface TerminalLaunch {
	/** The terminal's name, which finds it again: unique per agent's incarnation. */
	readonly name: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	/** The worktree's folder, which it runs in and whose row holds it. */
	readonly cwd: string;
}

/** The agents' terminals. */
export interface Terminals {
	/** Starts the CLI in a terminal held under its worktree's row (WA-9.1); rejects when it did not start. */
	launch(launch: TerminalLaunch): Promise<void>;
	/** Whether the terminal of that name still runs, found again after a reload. */
	isAlive(name: string): Promise<boolean>;
	/** Called once for each agent's terminal that ends: closed, or its process gone. */
	onDidEnd(listener: (name: string, exitCode: number | undefined) => void): Disposable;
}

/** A terminal the IDE found by a name. */
export interface FoundTerminal {
	/** Its whole name. */
	readonly name: string;
}

/** What the person can do in the IDE, for the `ide` tool (WA-9.5). */
export interface Ide {
	openFile(file: string, line: number | undefined): Promise<void>;
	/** Opens a terminal in a folder, under its row; answers with the terminal's name. */
	openTerminal(folder: string, name: string | undefined): Promise<string>;
	/** Types into a terminal found by its name or the start of it; undefined when there is none. */
	sendTerminal(name: string, text: string, enter: boolean): Promise<FoundTerminal | undefined>;
	/**
	 * The last `lines` lines a terminal shows; undefined when there is no such terminal, and no text
	 * while it has shown nothing.
	 */
	readTerminal(name: string, lines: number): Promise<(FoundTerminal & { readonly text?: string }) | undefined>;
	/** Runs any VS Code command, and answers with what it returned. */
	runCommand(id: string, args: readonly unknown[]): Promise<unknown>;
}

/** The repositories of the workspace's folders. */
export interface Git {
	/**
	 * The worktree a folder is (WA-3.1): `main` for a repository's own checkout, whatever branch it is
	 * on; a worktree's branch; the folder's own name for a folder with no repository.
	 */
	worktreeOf(folder: string): Promise<string>;
}

/**
 * What Facade needs the window to do, and nothing of how (WORKTREE-AGENTS.md, WA-18.5): the host
 * implements these with VS Code's API and the workbench's `_facade.*` commands, and tests with fakes.
 * Each reports what it found; what that means - a terminal not there, a launch that failed - is the
 * core's to say.
 */
export interface Ports {
	readonly terminals: Terminals;
	readonly ide: Ide;
	readonly git: Git;
}
