/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { FileLock } from '../base/lock';

/** Environment variables, as `process.env` holds them. */
export type Environment = { readonly [name: string]: string | undefined };

/** How to start Facade's MCP server for one agent. */
export interface McpLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/** A skill handed to every agent at its launch. */
export interface Skill {
	readonly name: string;
	/** When the agent should use it, as the CLI shows the model. */
	readonly description: string;
	/** Its text, in Markdown. */
	readonly body: string;
}

/** A skill's `SKILL.md`, as the CLIs that read skill folders take it. */
export function skillMarkdown(skill: Skill): string {
	return `---\nname: ${yamlText(skill.name)}\ndescription: ${yamlText(skill.description)}\n---\n\n${skill.body}\n`;
}

/**
 * Text as a YAML value in a skill's header: as it is where YAML reads it as that text - words, no `:`
 * or `#`, quotes or line breaks, not a word YAML reads as a boolean or null - else in double quotes,
 * as JSON writes a string, which YAML reads the same.
 */
function yamlText(text: string): string {
	return /^[A-Za-z][^:#"'\\\r\n]*$/.test(text) && text === text.trimEnd() && !/^(?:true|false|yes|no|on|off|null)$/i.test(text) ? text : JSON.stringify(text);
}

/** What a CLI's launch is given for one agent. */
export interface LaunchInput {
	/** The folder it runs in. */
	readonly folder: string;
	/** Set in a worktree Facade made, for a CLI that can be told for one launch that the person trusts the folder. */
	readonly trusted: boolean;
	/** Its first message, for a CLI that is given its task as an argument. */
	readonly prompt?: string;
	readonly model: string;
	readonly mcp: McpLaunch;
	readonly skills: readonly Skill[];
	/** How hard it thinks, for a CLI with `efforts`. */
	readonly effort?: string;
	/** Where the launch writes its own files. */
	readonly runDir: string;
	/** Unique per process, for the names of those files: its PID. */
	readonly slug: string;
}

/** How a CLI is started for one agent. */
export interface LaunchSpec {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** Written into the run folder before the launch, readable by the user only. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
	/** Put into the agent's folder before the launch, and taken back once the last agent that needs them there exits. */
	readonly injected: readonly Injected[];
}

/** A file put into an agent's folder for its launch. */
export interface Injected {
	/** Relative to the folder. */
	readonly path: string;
	readonly content: string;
	/**
	 * The content to write instead where the person has a file of their own at that path, which git
	 * does not track: theirs with Facade's part added, or undefined where it cannot be added.
	 */
	readonly merge?: (theirs: string) => string | undefined;
}

/** How Facade gives a CLI the person's trust in a worktree Facade made, which the person agreed to. */
export interface Trust {
	/**
	 * Records the trust where the CLI keeps it, under `lock`, in the person's home folder as `env` says it;
	 * answers with what it did, for the log.
	 */
	write(worktree: { readonly folder: string; readonly repository: string }, lock: FileLock, env?: Environment): string;
}

/**
 * What Facade knows of an agent CLI: how to find it, which models it offers, and how to start it in its
 * own UI so that it comes up with nobody at the keyboard - with Facade's MCP server, the person's trust
 * in a worktree Facade made, and nothing that would stop it at a question. Each launch's configuration
 * is its own: flags, files in its run folder, and files in its folder.
 */
export interface AgentCli {
	/** The id `spawn` and Start Agent use. */
	readonly id: string;
	readonly displayName: string;
	/** The command to look for on PATH. */
	readonly command: string;
	/** The models Start Agent offers, the suggested one first. */
	readonly models: readonly string[];
	/**
	 * For a CLI that silently uses a model of its own when given one it does not have: the arguments
	 * that make it list its models, and how to read their ids from what it prints.
	 */
	readonly listModels?: { readonly args: readonly string[]; parse(output: string): readonly string[] };
	/** For a CLI that keeps the person's trust in a file rather than taking it per launch. */
	readonly trust?: Trust;
	/** What full access lets it do, the flags that give it, and what Facade does for the person; shown before they agree. */
	fullAccess(): string;
	/** Its MCP server comes from a file in its folder that every agent there reads: the server finds the agent from its environment. */
	readonly sharedServer?: boolean;
	/**
	 * How it gets its task: `argument`, on its command line; `terminal`, in a file, with a line typed into
	 * its terminal once its MCP server said hello, for a CLI whose first conversation has no MCP tools.
	 */
	readonly task: 'argument' | 'terminal';
	/** How long to wait between typing a line into its terminal and pressing Enter, for a CLI that takes fast typing for a paste. */
	readonly enterDelayMs: number;
	/** The levels it thinks at, and its default; the person sets one with `facade.orchestration.<id>.reasoningEffort`. */
	readonly efforts?: { readonly levels: readonly string[]; readonly byDefault: string };
	launch(input: LaunchInput, executable: string): LaunchSpec;
}

/** A CLI this machine has: its definition, and the file `PATH` finds for its command. */
export interface InstalledCli {
	readonly cli: AgentCli;
	readonly executable: string;
}

/** The question the person answers once per CLI before Facade starts it. */
export function fullAccessQuestion(cli: AgentCli): { readonly message: string; readonly detail: string } {
	return {
		message: l10n.t("Let Facade start {0} with full access?", cli.displayName),
		detail: `${cli.fullAccess()}\n\n${l10n.t("Facade asks this once: from then on every {0} agent starts this way, in every window, including those your agents start.", cli.displayName)}`
	};
}
