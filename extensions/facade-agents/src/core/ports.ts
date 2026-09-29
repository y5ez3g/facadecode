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

/** The agents' terminals, each known by the name its launch gave it. */
export interface Terminals {
	/** Starts the CLI in a terminal held under its worktree's row (WA-9.1); rejects when it did not start. */
	launch(launch: TerminalLaunch): Promise<void>;
	/** Whether the terminal of that name still runs, found again after a reload. */
	isAlive(name: string): Promise<boolean>;
	/** Called once for each agent's terminal that ends: closed, or its process gone. */
	onDidEnd(listener: (name: string, exitCode: number | undefined) => void): Disposable;
	/** Closes the terminal, which ends the CLI in it. */
	stop(name: string): Promise<void>;
	/** Types `text` into the terminal as it is, keys and all; false when there is no such terminal. */
	type(name: string, text: string): Promise<boolean>;
	/** The last lines the terminal shows; undefined while it has shown nothing, or when it is gone. */
	read(name: string, lines: number): Promise<string | undefined>;
	/** When the person last typed into the terminal, if they have. */
	lastInputAt(name: string): Promise<number | undefined>;
	/** Puts the terminal in front, through its worktree's row; false when there is no such terminal. */
	reveal(name: string): Promise<boolean>;
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
	/** A terminal by its name, or by the start of it; undefined when there is none. */
	findTerminal(name: string): Promise<FoundTerminal | undefined>;
	/** Types into the terminal of that whole name, then Enter unless `enter` is false. */
	sendTerminal(name: string, text: string, enter: boolean): Promise<void>;
	/** The last `lines` lines the terminal of that whole name shows; undefined while it has shown nothing. */
	readTerminal(name: string, lines: number): Promise<string | undefined>;
	/** Runs any VS Code command, and answers with what it returned. */
	runCommand(id: string, args: readonly unknown[]): Promise<unknown>;
}

/** The repository a folder is in, as git reads it. */
export interface Repository {
	/** Its main checkout's folder. */
	readonly main: string;
	/** The worktree the folder is (WA-3.1): `main` for the main checkout, else its branch. */
	readonly worktree: string;
	/** That worktree's HEAD, a full commit id. */
	readonly head: string;
}

/** A worktree of a repository, as git lists it. */
export interface ListedWorktree {
	/** `main`, or its branch. */
	readonly name: string;
	readonly folder: string;
}

/** The repositories of the workspace's folders. */
export interface Git {
	/** The repository `folder` is in; undefined for a folder with none. */
	repositoryOf(folder: string): Promise<Repository | undefined>;
	/** The worktrees of the repository whose main checkout is `main`, main included. */
	worktreesOf(main: string): Promise<readonly ListedWorktree[]>;
	/**
	 * A worktree on the new branch `branch`, starting at `startPoint`, made through the window's New
	 * Worktree without its dialog (WA-3.2); answers with its folder. Rejects with why it could not be.
	 */
	makeWorktree(main: string, branch: string, startPoint: string): Promise<string>;
	/** Delete Worktree without its dialog: changes not committed go only with `force` (WA-3.5). */
	deleteWorktree(folder: string, force: boolean): Promise<void>;
}

/** What Facade asks of, and tells, the person at the keyboard. */
export interface Person {
	/**
	 * A message for the person: a notification with its sender and first lines; going to it shows
	 * `terminal`, the agent's the message is from or about, where the person answers by typing
	 * (WA-6.10).
	 */
	notify(from: string, text: string, terminal: string | undefined): void;
	/**
	 * Whether the person lets Facade answer a CLI's first-run questions in the worktrees Facade makes,
	 * asked once per CLI (section 8).
	 */
	allowsFirstRunAnswers(cli: { readonly id: string; readonly displayName: string }): Promise<boolean>;
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
	readonly person: Person;
}
