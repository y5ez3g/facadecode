/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentCli, CliConfig, Connection, Environment, InstalledCli, McpLaunch, Skill } from '../clis/cli';
import { Caller } from '../record/events';

/** What is let go of once the window closes. */
export interface Disposable {
	dispose(): void;
}

/** An agent's CLI, started in a terminal. */
export interface TerminalLaunch {
	/** The agent's number: its run, under which the window finds its terminal again, whatever its title. */
	readonly id: number;
	/** Which agent it is, `@claude #a1`: its tab reads so until its CLI sets a title, and then after that title. */
	readonly name: string;
	/** The command of its CLI, as `PATH` knows it: its terminal is drawn with that CLI's logo, or the robot. */
	readonly command: string;
	/** Whether it is a custom agent: drawn with the robot, whatever program it runs (AGENT-LAUNCHER.md, L3; X-60). */
	readonly custom?: boolean;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	/** The folder it runs in, whose row in the workspace bar holds it. */
	readonly cwd: string;
	/**
	 * Whether it is put in front, focused, once it is open: an agent the person started, who is there to
	 * watch it. An agent's child opens without disturbing the window.
	 */
	readonly reveal: boolean;
}

/** How an agent's terminal ended. */
/**
 * How an agent's process is ended: the hang-up closing its tab sends, then - one that outlives its stop's
 * time - termination, then a kill it cannot ignore (X-22).
 */
export type StopSignal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL';

export interface TerminalEnd {
	/** The code its process exited with, where the window knows it. */
	readonly exitCode?: number;
	/** Whether the person closed the terminal. */
	readonly byThePerson: boolean;
	/** Why the person's act closed it, where it was not its tab they closed: their deletion of its worktree (N-04). */
	readonly reason?: 'worktreeDeleted';
}

/**
 * The agents' terminals, each known by its agent's run - the agent's number in the workspace's record -
 * under which the window registered the process its terminal started: through reloads and moves, a new
 * process in that terminal is none of the agent's.
 */
export interface Terminals {
	/**
	 * Starts the CLI in a terminal held under its folder's row, and answers with its process's id, where
	 * the window has it by then; rejects when it did not start.
	 */
	launch(launch: TerminalLaunch): Promise<{ readonly processId?: number }>;
	/** Whether the agent's process still runs in a terminal of the window, found again after a reload; rejects while the window cannot tell. */
	isAlive(id: number): Promise<boolean>;
	/** How the agent's process ended, where `isAlive` found it gone and the window had seen it end; undefined otherwise. */
	endOf?(id: number): TerminalEnd | undefined;
	/** The process of the agent's terminal, where `isAlive` found it running and the window knows it; undefined otherwise. */
	processIdOf?(id: number): number | undefined;
	/** Called once for each agent whose process ends: closed with its terminal, or exited. */
	onDidEnd(listener: (id: number, end: TerminalEnd) => void): Disposable;
	/** Ends the agent's process, as closing its tab ends it, and answers how it ended; rejects while it has not ended yet. */
	stop(id: number, signal?: StopSignal): Promise<{ readonly exitCode?: number }>;
	/**
	 * Types `text` into the agent's terminal as it is, keys and all; false when its process runs in none.
	 * `line`: `begin` - the person's unsent typing there waited for a while, and what they type held back from
	 * here - or `end`, after which it follows: a line typed in parts reaches the CLI whole (X-43).
	 */
	type(id: number, text: string, line?: 'begin' | 'end'): Promise<boolean>;
	/** Puts the agent's terminal in front, going to its folder first; false where it runs in none. */
	reveal(id: number): Promise<boolean>;
	/**
	 * The agents whose terminals work inside `folder` - where they are now, or where they started - their
	 * processes running: this record's by number, and how many of another record's - which deleting it would
	 * end too (X-74); and other windows' agents working there, by their titles - which it would leave without
	 * their folder (N-53).
	 */
	inside(folder: string): Promise<TerminalsInside>;
}

/** The agents working inside a folder, as the window sees them (`Terminals.inside`). */
export interface TerminalsInside {
	readonly agents: readonly number[];
	readonly others: number;
	readonly elsewhere: readonly string[];
}

/** The repository a folder is in, as git reads it. */
export interface Repository {
	/** Its main checkout's folder. */
	readonly main: string;
	/** Whether the folder is in the main checkout - its root, or a folder inside it - rather than in a worktree git added: never deleted. */
	readonly mainCheckout: boolean;
	/**
	 * The worktree the folder is, by its label: the branch checked out in it - the main checkout's too - or
	 * its folder's own name on a detached HEAD. The folder is what names a worktree.
	 */
	readonly worktree: string;
	/** That worktree's HEAD, a full commit id; undefined on a branch with no commit yet, or one git cannot read. */
	readonly head: string | undefined;
}

/** A worktree of a repository, as git lists it. */
export interface ListedWorktree {
	/** Its label: the branch checked out in it, or its folder's own name on a detached HEAD. */
	readonly name: string;
	/** The branch checked out in it; none on a detached HEAD. */
	readonly branch?: string;
	readonly folder: string;
}

/** A worktree `makeWorktree` made: where, what could not be copied into it, and how a git hook failed. */
export interface MadeWorktreeFolder {
	readonly folder: string;
	readonly copyFailures: readonly string[];
	readonly hookFailure?: string;
}

/**
 * How a worktree's setup came out (WORKTREE.md, WT-7): none to run, a `.facade/worktrees.json` that could
 * not be read, every line finished well, the first line that failed - with its exit code and output - its
 * lines sent without shell integration, their completion unknown, or its terminal closed before it finished.
 */
export type SetupOutcome =
	| { readonly kind: 'none' | 'invalid' | 'succeeded' | 'submitted' | 'stopped' }
	| { readonly kind: 'failed'; readonly line: string; readonly exitCode: number; readonly output?: string };

/** What deleting a worktree would lose: files git keeps no copy of, editors with unsaved changes, and its submodules. */
export interface WorktreeChanges {
	/** Changed, staged and untracked files, relative to the worktree, with forward slashes. */
	readonly files: readonly string[];
	/** Files of the worktree open with unsaved changes. */
	readonly unsaved: readonly string[];
	/**
	 * Its submodules - checked out, by path, or else those whose repositories its git directory keeps, by
	 * name - which go with it with any of their commits not pushed (X-14).
	 */
	readonly submodules: readonly string[];
}

/** A file Facade put into a worktree that nobody changed since: where, relative to it with forward slashes, and the SHA-256 of what it holds, in hex. */
export interface OwnedFile {
	readonly path: string;
	readonly sha256: string;
}

/** What `Git.deleteWorktree` deletes, and what is known of it. */
export interface WorktreeDeletion {
	/** Whether its changes go with it, unsaved editors and submodules too. */
	readonly discardChanges: boolean;
	/** What Facade put there and nobody changed: it goes with it all the same, unless changed by then. */
	readonly ownFiles: readonly OwnedFile[];
	/** The main checkout of its repository. */
	readonly main: string;
	/** The agents whose terminals are in it, all stopped: the only agents' terminals the deletion may close. */
	readonly agents: readonly number[];
	/** Whether it is what a deletion left of a worktree: a folder git no longer lists, looked at already. */
	readonly leftover?: boolean;
}

/** The repositories of the workspace's folders. */
export interface Git {
	/** The repository `folder` is in; undefined for a folder with none. */
	repositoryOf(folder: string): Promise<Repository | undefined>;
	/** The worktrees of the repository whose main checkout is `main`, main included. */
	worktreesOf(main: string): Promise<readonly ListedWorktree[]>;
	/** Whether the repository whose main checkout is `main` has a branch called `branch`. */
	hasBranch(main: string, branch: string): Promise<boolean>;
	/** Why `branch` cannot be a branch's name, as git says; undefined where it can. */
	whyNotBranchName(main: string, branch: string): Promise<string | undefined>;
	/**
	 * The folder a worktree of `main` on `branch` is made in, unless that is taken (WORKTREE.md, WT-2.2):
	 * what its run records while the worktree is being made.
	 */
	plannedWorktreeFolder(main: string, branch: string): string;
	/**
	 * A worktree on the new branch `branch`, starting at `startPoint`, made through the window's New
	 * Worktree without its dialog; answers once it is made and its setup started (WT-5.11) - with its folder,
	 * and what could not be copied into it and how a git hook failed, which its caller says. Rejects with
	 * why it could not be made.
	 */
	makeWorktree(main: string, branch: string, startPoint: string): Promise<MadeWorktreeFolder>;
	/** How the setup of the worktree `folder`, which `makeWorktree` made, came out, once it has. */
	setupOutcome(folder: string): Promise<SetupOutcome>;
	/** Closes the setup terminal of the worktree `folder`: its start was cancelled. */
	stopSetup(folder: string): void;
	/** What deleting the worktree `folder` would lose. */
	changesIn(folder: string): Promise<WorktreeChanges>;
	/**
	 * Deletes the worktree `folder` as Delete Worktree does, with nothing asked, its branch kept; rejects with
	 * why it could not. Changes git would lose, as the window finds them deleting it, refuse it unless
	 * `discardChanges` - all but `ownFiles`, what Facade put there that nobody changed.
	 */
	deleteWorktree(folder: string, options: WorktreeDeletion): Promise<void>;
	/**
	 * The `info/exclude` of the repository `folder` is in, which git reads as a `.gitignore` of its
	 * own for every worktree, and the root of `folder`'s worktree, where its lines start from;
	 * undefined for a folder with no repository.
	 */
	excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined>;
	/**
	 * Which of `files`, paths relative to `folder`, git tracks there; with `commit`, which that commit of
	 * the repository has, `folder` its main checkout.
	 */
	tracks(folder: string, files: readonly string[], commit?: string): Promise<ReadonlySet<string>>;
	/** What `file`, a path from the repository's root, holds at `commit` of the repository whose main checkout is `main`; undefined where it has none. */
	fileAt(main: string, commit: string, file: string): Promise<string | undefined>;
	/**
	 * The files of what a deletion left of the worktree of `branch` at `folder` - a folder git no longer lists -
	 * that the branch does not hold as they are: work, which finishing its deletion would lose.
	 */
	leftoverWorkIn(main: string, branch: string, folder: string): Promise<readonly string[]>;
	/**
	 * Which of `files`, paths relative to `folder`, some worktree of its repository has - at the same
	 * place from that worktree's root - as a file git neither tracks nor ignores: a file of the person's,
	 * which a line in the repository's `info/exclude` would leave for git to write over.
	 */
	untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>>;
}

/** The window's workspace. */
export interface Workspace {
	/** Its folders on this machine, by their paths. */
	folders(): readonly string[];
	/** The folder on the person's screen, as the workspace bar has it; none where there is none. */
	activeFolder(): Promise<string | undefined>;
}

/** How much a notice matters to the person: news; something that did not go as it should, which may want them; a failure. */
export type Severity = 'information' | 'warning' | 'error';

/** What Facade tells the person at the keyboard: its texts are written through `@vscode/l10n`, in their language. */
export interface Person {
	/**
	 * A notice of Facade's for the person, shown as `severity` says: a failure as one, never as news (UI-17).
	 * Going to it shows the terminal of `agent`, the agent it is about.
	 */
	tell(text: string, agent: number | undefined, severity: Severity): void;
}

/**
 * What Facade needs the window to do, and nothing of how: the host implements these with VS Code's
 * API and the workbench's `_facade.*` commands, and tests with fakes. Each reports what it found; what
 * that means - a terminal not there, a launch that failed - is the core's to say.
 */
export interface Ports {
	readonly terminals: Terminals;
	readonly git: Git;
	readonly workspace: Workspace;
	readonly person: Person;
}

/** The CLIs Facade knows, those this machine has, the person's custom agents, and the person's switches: each read again at each use. */
export interface CliCatalog {
	/** Every built-in Facade knows, installed or not, in the menu's order. */
	readonly known: readonly AgentCli[];
	/** The person's custom agents, in the order of their setting, each with how it starts and what is wrong in it. */
	custom(): readonly { readonly cli: AgentCli; readonly config: CliConfig }[];
	/** The built-ins this machine has and the person offers, as `refresh` last found them. */
	installed(): readonly InstalledCli[];
	/** Finds the built-ins again, where a terminal finds them now: its PATH, as the person sets it, not Facade's (X-39). */
	refresh?(): Promise<void>;
	/**
	 * `cli`, started as `config` says, where a terminal starting in `folder` with the environment `env` finds
	 * it - the file its path setting names, else its command on that environment's PATH; undefined where it
	 * finds none.
	 */
	locate(cli: AgentCli, config: CliConfig, env: Environment, folder: string): InstalledCli | undefined;
	/** The person's YOLO, for the next agent they start; throws, naming the setting, where it holds neither true nor false. */
	yolo(): boolean;
	/** Whether the agent framework is on: Facade's tools answer, and launches get its integration. */
	framework(): boolean;
	/** How the person has Facade start a built-in. */
	configOf(cli: AgentCli): CliConfig;
	/** The environment a terminal in `folder` starts with, before a launch's own, as the window makes it: with it, where each CLI keeps its files. */
	environment(folder: string): Promise<Environment>;
}

/** How long the core waits, as the person sets it: read again at each use. */
export interface Timing {
	/** How long a new agent has to come up, and a process to end once stopped: the person's timeout. */
	readonly startTimeoutMs: number;
}

/** What every agent is given at its launch, and how it reaches the window. */
export interface AgentSetup {
	/** How an agent reaches Facade through an MCP server of its own, given its token file: the shim, on this window's pipe. */
	connection(tokenFile: string): Connection;
	/** How the MCP server of a CLI with `sharedServer` is started: the same for every agent, which it finds from its environment. */
	sharedMcpServer(): McpLaunch;
	/** What an agent of a CLI with `sharedServer` has in its environment, given its token's file, for its MCP server to find the window and the agent by. */
	agentEnv(tokenFile: string): { readonly [name: string]: string };
	/** The skills every agent is handed, made for the CLIs this machine has then. */
	skills(): readonly Skill[];
	/** What a new agent's task notice says before where its task is: who it is, and who started it. */
	opening(agent: { readonly id: number; readonly name: string; readonly cliName: string }, creator: Caller): string;
}
