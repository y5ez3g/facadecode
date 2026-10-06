/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentCli, Environment, InstalledCli, McpLaunch, Skill } from '../clis/cli';
import { Caller } from '../record/events';

/** What is let go of once the window closes. */
export interface Disposable {
	dispose(): void;
}

/** An agent's CLI, started in a terminal. */
export interface TerminalLaunch {
	/** The terminal's name, which finds it again: unique per process. */
	readonly name: string;
	/** The command of its CLI, as `PATH` knows it: its terminal is drawn with that CLI's logo. */
	readonly command: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	/** The folder it runs in, whose row in the workspace bar holds it. */
	readonly cwd: string;
	/**
	 * Whether it is put in front once it is open: a process the person started, who is there to watch
	 * it. An agent's child opens without disturbing the window.
	 */
	readonly reveal: boolean;
}

/** How an agent's terminal ended. */
export interface TerminalEnd {
	/** The code its process exited with, where the window knows it. */
	readonly exitCode?: number;
	/** Whether the person closed the terminal. */
	readonly byThePerson: boolean;
}

/** The agents' terminals, each known by the name its launch gave it. */
export interface Terminals {
	/** Starts the CLI in a terminal held under its folder's row; rejects when it did not start. */
	launch(launch: TerminalLaunch): Promise<void>;
	/** Whether the terminal of that name still runs, found again after a reload. */
	isAlive(name: string): Promise<boolean>;
	/** Called once for each agent's terminal that ends: closed, or its process gone. */
	onDidEnd(listener: (name: string, end: TerminalEnd) => void): Disposable;
	/** Closes the terminal, which ends the CLI in it. */
	stop(name: string): Promise<void>;
	/** Types `text` into the terminal as it is, keys and all; false when there is no such terminal. */
	type(name: string, text: string): Promise<boolean>;
}

/** The repository a folder is in, as git reads it. */
export interface Repository {
	/** Its main checkout's folder. */
	readonly main: string;
	/** The worktree the folder is: `main` for the main checkout, else its branch. */
	readonly worktree: string;
	/** That worktree's HEAD, a full commit id; undefined on a branch with no commit yet, or one git cannot read. */
	readonly head: string | undefined;
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
	 * Worktree without its dialog; answers with its folder. Rejects with why it could not be made.
	 */
	makeWorktree(main: string, branch: string, startPoint: string): Promise<string>;
	/**
	 * The `info/exclude` of the repository `folder` is in, which git reads as a `.gitignore` of its
	 * own for every worktree, and the root of `folder`'s worktree, where its lines start from;
	 * undefined for a folder with no repository.
	 */
	excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined>;
	/** Which of `files`, paths relative to `folder`, git tracks there. */
	tracks(folder: string, files: readonly string[]): Promise<ReadonlySet<string>>;
	/**
	 * Which of `files`, paths relative to `folder`, some worktree of its repository has - at the same
	 * place from that worktree's root - as a file git neither tracks nor ignores: a file of the person's,
	 * which a line in the repository's `info/exclude` would leave for git to write over.
	 */
	untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>>;
}

/** What Facade tells, and asks, the person at the keyboard: its texts are written through `@vscode/l10n`, in their language. */
export interface Person {
	/** A notice of Facade's for the person. Going to it shows `terminal`, the agent's it is about. */
	tell(text: string, terminal: string | undefined): void;
	/** A modal question, `detail` under `message`: true for `yes`, false for `no`, undefined when the person dismissed it. */
	ask(message: string, detail: string, yes: string, no: string): Promise<boolean | undefined>;
}

/**
 * What Facade needs the window to do, and nothing of how: the host implements these with VS Code's
 * API and the workbench's `_facade.*` commands, and tests with fakes. Each reports what it found; what
 * that means - a terminal not there, a launch that failed - is the core's to say.
 */
export interface Ports {
	readonly terminals: Terminals;
	readonly git: Git;
	readonly person: Person;
}

/** The CLIs Facade knows, and those this machine has. */
export interface CliCatalog {
	/** Every CLI Facade knows, installed or not: what a process's CLI is called, and how it takes its keys. */
	readonly known: readonly AgentCli[];
	/** The CLIs this machine has, looked for again at each start. */
	installed(): readonly InstalledCli[];
	/** The models a CLI on this machine lists, for a CLI with `listModels`; undefined when it lists none. */
	modelsOf(installed: InstalledCli): Promise<readonly string[] | undefined>;
	/** The level the person set for a CLI to think at, by its id. */
	effortFor(cli: string): string | undefined;
	/** The environment the agents' terminals start with, which says where each CLI keeps its files; the extension host's own where left out. */
	environment?(): Environment;
}

/** What every agent is given at its launch, and how it reaches the window. */
export interface AgentSetup {
	/** How an agent's MCP server is started, given its token file: the shim, on this window's pipe. */
	mcpServer(tokenFile: string): McpLaunch;
	/** How the MCP server of a CLI with `sharedServer` is started: the same for every agent, which it finds from its environment. */
	sharedMcpServer(): McpLaunch;
	/** The pipe this window listens on, for an agent that finds it from its environment. */
	pipe(): string;
	/** The skills every agent is handed, made for the CLIs this machine has then. */
	skills(): readonly Skill[];
	/** What a new process's first message says before its task: who it is, and who started it. */
	opening(process: { readonly pid: number; readonly name: string; readonly cliName: string }, parent: Caller): string;
}
