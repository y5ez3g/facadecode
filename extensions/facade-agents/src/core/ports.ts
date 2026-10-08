/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentCli, CliConfig, Environment, InstalledCli, McpLaunch, Skill } from '../clis/cli';
import { Caller } from '../record/events';

/** What is let go of once the window closes. */
export interface Disposable {
	dispose(): void;
}

/** An agent's CLI, started in a terminal. */
export interface TerminalLaunch {
	/** The terminal's name, which finds it again: unique per agent. */
	readonly name: string;
	/** The command of its CLI, as `PATH` knows it: its terminal is drawn with that CLI's logo. */
	readonly command: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	/** The folder it runs in, whose row in the workspace bar holds it. */
	readonly cwd: string;
	/**
	 * Whether it is put in front once it is open: an agent the person started, who is there to watch
	 * it. An agent's child opens without disturbing the window.
	 */
	readonly reveal: boolean;
	/** The number of the agent whose run it is. */
	readonly run: number;
	/** The file the window writes its final screen to as it ends. */
	readonly finalScreen: string;
}

/** A terminal's screen as the window read it: its bottom lines, as it draws them. */
export interface TerminalScreen {
	/** Top to bottom: inverse-video text marked `[[...]]`, dim text `{{...}}`. */
	readonly lines: readonly string[];
	/** The normal buffer with its scrollback, or a full-screen program's alternate buffer. */
	readonly buffer: 'normal' | 'alternate';
	/** Whether the buffer holds lines above those read. */
	readonly older: boolean;
	/** Whether the terminal let go of lines above all those it holds: its scrollback is full. */
	readonly trimmed: boolean;
	/** When it was read, in milliseconds since 1970. */
	readonly capturedAt: number;
	/** When the terminal last showed new output, where the window knows it. */
	readonly lastOutput?: number;
	/** Whether its process has ended, the terminal kept open. */
	readonly exited: boolean;
}

/** What input into a terminal did: what went in, and why the rest did not. */
export interface InputEffect {
	/** `applied`: all of it; `partial`: a first part, the terminal ending before the rest; `not_applied`: nothing. */
	readonly outcome: 'applied' | 'partial' | 'not_applied';
	/** Why not all of it went in: the terminal ended, or the input waited behind the person's typing past its time. */
	readonly reason?: 'ended' | 'timeout';
	/** For text: whether it was pasted. */
	readonly pasted?: boolean;
	/** For text: whether Enter followed. */
	readonly entered?: boolean;
	/** For keys: how many went in, from the first. */
	readonly keysSent?: number;
}

/** How a line is typed into a terminal: with Enter after it or not, and how long it may wait for its turn. */
export interface TypeOptions {
	readonly enter: boolean;
	/** How long after the paste Enter is pressed: the time the CLI needs to take the paste in. */
	readonly enterDelayMs: number;
	/** How long it may wait for its turn; none to wait as long as the person's typing holds it. */
	readonly queueTimeoutMs?: number;
}

/** How keys are pressed in a terminal: how long they may wait for their turn. */
export interface KeysOptions {
	/** How long they may wait for their turn; none to wait as long as the person's typing holds them. */
	readonly queueTimeoutMs?: number;
}

/** What the person typed into a terminal, as the window saw their keys: never its screen. */
export interface PersonInput {
	/** Whether they typed since they last pressed Enter there. */
	readonly pending: boolean;
	/** When they last typed there. */
	readonly lastKey?: number;
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
	/**
	 * Closes what the window brought back under that name after its process was gone: a new shell, in
	 * the agent's tab, that is no agent's.
	 */
	closeRevived(name: string): Promise<void>;
	/**
	 * The bottom `lines` lines of the terminal's screen, read without changing anything of it; undefined
	 * where there is no such terminal, or it has no screen. A terminal the window is still giving back
	 * after a reload is waited for.
	 */
	read(name: string, lines: number): Promise<TerminalScreen | undefined>;
	/**
	 * Types `text` into the terminal as one paste and, with `options.enter`, presses Enter after it: in the
	 * terminal's turn, after what the window typed there before, and once the person's typing there lets
	 * it. Undefined where there is no such terminal. Rejects where what went in is not known.
	 */
	type(name: string, text: string, options: TypeOptions): Promise<InputEffect | undefined>;
	/**
	 * Presses `keys` - as `keyOf` names them - in the terminal, in order, as it sends them for keys the
	 * person presses; in its turn as `type` types. Undefined where there is no such terminal. Rejects where
	 * what went in is not known.
	 */
	keys(name: string, keys: readonly string[], options: KeysOptions): Promise<InputEffect | undefined>;
	/** What the person typed into the terminal; undefined where the window cannot tell, or there is no such terminal. */
	input(name: string): Promise<PersonInput | undefined>;
	/**
	 * Tells the window that the terminal is the agent `run`'s, its final screen going to `finalScreen`:
	 * for a terminal the window gave back after a reload. False where there is no such terminal, or the
	 * window keeps no final screens.
	 */
	register(name: string, run: number, finalScreen: string): Promise<boolean>;
	/** Puts the terminal in front of the person; false when there is no such terminal, or it could not be put there. */
	reveal(name: string): Promise<boolean>;
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

/** A notification Facade keeps up by its key: another with the same key takes its place. */
export interface Notification {
	readonly key: string;
	readonly text: string;
	/** Its buttons' labels. */
	readonly buttons: readonly string[];
	/**
	 * The terminal of the agent it is from: while that terminal has the person's focus, the notification
	 * goes quietly into the notification center rather than over what they read.
	 */
	readonly quietIn?: string;
}

/** An agent that ended, as a notice about it shows it. */
export interface EndedAgent {
	readonly id: number;
	readonly name: string;
	/** The name of the terminal it ran in. */
	readonly terminal: string;
	/** Its final screen's file, kept as its terminal ended. */
	readonly finalScreen: string;
	/** How it ended, for the person to read where no final screen was kept. */
	readonly ending: string;
}

/** What Facade tells the person at the keyboard: its texts are written through `@vscode/l10n`, in their language. */
export interface Person {
	/** A notice of Facade's for the person. Going to it shows `terminal`, the agent's it is about. */
	tell(text: string, terminal: string | undefined): void;
	/**
	 * Shows a notification, or updates the one up with its key in place, as Do Not Disturb has it. Answers
	 * with the label of the button pressed; undefined once it closed, or another took its place.
	 */
	notify(notification: Notification): Promise<string | undefined>;
	/** Opens a chat room in an editor, at a message of it. */
	openRoom(file: string, message: number): Promise<void>;
	/** Shows an agent that ended: its terminal while that is still open, else its last screen, read-only; where none was kept, how it ended. */
	showEnded(agent: EndedAgent): Promise<void>;
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

/** The CLIs Facade knows, those this machine has, and how the person has Facade start them: each read again at each use. */
export interface CliCatalog {
	/** Every CLI Facade knows, installed or not: what an agent's CLI is called. */
	readonly known: readonly AgentCli[];
	/** The CLIs this machine has. */
	installed(): readonly InstalledCli[];
	/** How the person has Facade start a CLI Facade knows. */
	configOf(cli: AgentCli): CliConfig;
	/** The environment the agents' terminals start with, before a launch's own: with it, where each CLI keeps its files. */
	environment(): Environment;
}

/** How long the core waits, as the person sets it: read again at each use. */
export interface Timing {
	/**
	 * How long a new agent has to come up - its MCP server's hello - before it is ended as failed: the
	 * person's timeout. A call typing or pressing keys in a terminal waits for its turn no longer.
	 */
	readonly startTimeoutMs: number;
	/**
	 * How long the final screen of an agent that just ended is waited for, the window writing it as the
	 * terminal goes: two seconds where left out.
	 */
	readonly finalScreenWaitMs?: number;
}

/** What every agent is given at its launch, and how it reaches the window. */
export interface AgentSetup {
	/** How an agent's MCP server is started, given its token file: the shim, on this window's pipe. */
	mcpServer(tokenFile: string): McpLaunch;
	/** How the MCP server of a CLI with `sharedServer` is started: the same for every agent, which it finds from its environment. */
	sharedMcpServer(): McpLaunch;
	/** What an agent of a CLI with `sharedServer` has in its environment, given its token, for its MCP server to find the window and the agent by. */
	agentEnv(token: string): { readonly [name: string]: string };
	/** The skills every agent is handed, made for the CLIs this machine has then. */
	skills(): readonly Skill[];
	/** The first line of an agent with a task: who it is, who created it, and the number of its task, which it fetches. */
	firstLine(agent: { readonly id: number; readonly name: string }, creator: Caller, task: number): string;
}
