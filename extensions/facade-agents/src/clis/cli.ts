/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonObject } from '../base/json';

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

/**
 * The groups of a launch's arguments, in the order a launch gives them; a CLI has the groups it uses:
 * `warmUp`, a first message of its own; `connect`, how Facade's tools, skills and settings reach it;
 * `quiet`, what keeps it from stopping at a question nobody is there to answer; `fullAccess`; `model`;
 * `effort`, how hard it thinks; `extra`, the person's own; and `task`, where its task is given as an
 * argument. The arguments of a trust given for a launch come after `connect`.
 */
export const ARG_GROUPS = ['warmUp', 'connect', 'quiet', 'fullAccess', 'model', 'effort', 'extra', 'task'] as const;

/** One of {@link ARG_GROUPS}. */
export type ArgGroup = (typeof ARG_GROUPS)[number];

/**
 * What Facade does in a worktree it made so that the CLI does not stop to ask whether the person trusts
 * it: arguments given that launch alone, or `merge` merged into the JSON file `file`, which the CLI
 * keeps, as it writes the person's answer.
 */
export type TrustConfig =
	| { readonly arguments: readonly string[]; readonly file?: undefined; readonly merge?: undefined }
	| { readonly arguments?: undefined; readonly file: string; readonly merge: JsonObject };

/** How Facade starts a CLI, part by part: the setting `facade.orchestration.<section>.launch`. */
export interface LaunchConfig {
	readonly arguments: { readonly [Group in ArgGroup]?: readonly string[] };
	/** What Facade sets in its environment. */
	readonly environment: { readonly [name: string]: string };
	/** None: it asks, in its terminal. */
	readonly trust?: TrustConfig;
	/** Claude Code's settings for each launch, written to the file its `${settingsFile}` names. */
	readonly settings?: JsonObject;
	/** Milliseconds between typing a line into its terminal and pressing Enter: a CLI can take fast typing for a paste. */
	readonly enterDelay: number;
	/** Milliseconds after its MCP server's hello before a CLI told of its task in its terminal is typed the line that names it. */
	readonly taskDelay: number;
}

/**
 * Whether a CLI started as `config` says runs with YOLO on: its approvals and sandbox off, as its launch's
 * `fullAccess` arguments turn them off - all four built-in CLIs' by default.
 */
export function isYolo(config: CliConfig): boolean {
	return !!config.launch.arguments.fullAccess?.length;
}

/**
 * How Facade starts a CLI: a CLI's definition holds its defaults, and the person changes them with
 * `facade.orchestration.<section>.path` and `.launch`. In an argument, `${name}` stands for a value the launch
 * gives it.
 */
export interface CliConfig {
	/** The file Facade starts, or a command PATH finds; empty for the CLI's command on PATH. */
	readonly path: string;
	readonly launch: LaunchConfig;
}

/**
 * `text` with each `${name}` in it replaced by `values[name]`, whatever is written between the braces;
 * throws, naming `setting`, at one there is no value for: the person's mistake, never passed on.
 */
export function withValues(text: string, values: { readonly [name: string]: string }, setting: string): string {
	return text.replace(/\$\{(?<name>[^}]*)\}/g, (placeholder, name: string) => {
		if (!Object.hasOwn(values, name)) {
			throw new Error(`${setting} has ${placeholder}, for which Facade has no value: it has ${Object.keys(values).map(each => `\${${each}}`).join(', ')}.`);
		}
		return values[name];
	});
}

/**
 * A launch's arguments: the groups of `config` in their order, each `${name}` in them replaced by
 * `values[name]`, with the arguments of a trust given for the launch after `connect` where `uses` has
 * `trust`, and the task left out where `uses` has `task: false`. Throws, naming the setting, at a
 * `${name}` the launch has no value for.
 */
export function launchArgs(cli: AgentCli, config: CliConfig, values: { readonly [name: string]: string }, uses: { readonly trust?: boolean; readonly task?: boolean } = {}): string[] {
	const setting = `facade.orchestration.${cli.section}.launch`;
	const { trust } = config.launch;
	const args: string[] = [];
	for (const group of ARG_GROUPS) {
		if (group !== 'task' || uses.task !== false) {
			args.push(...(config.launch.arguments[group] ?? []).map(arg => withValues(arg, values, `${setting}.arguments.${group}`)));
		}
		if (group === 'connect' && uses.trust && trust?.arguments) {
			args.push(...trust.arguments.map(arg => withValues(arg, values, `${setting}.trust.arguments`)));
		}
	}
	return args;
}

/** What a CLI's launch is given for one agent. */
export interface LaunchInput {
	/** The folder it runs in. */
	readonly folder: string;
	/** Set in a worktree Facade made, for a CLI given the person's trust in its arguments. */
	readonly trusted: boolean;
	/** Its first message, for a CLI that is given its task as an argument. */
	readonly prompt?: string;
	/** The model and how hard it thinks, as the CLI takes them: Facade passes them on as they are. */
	readonly model: string;
	readonly effort: string;
	readonly mcp: McpLaunch;
	readonly skills: readonly Skill[];
	/** How the person has Facade start the CLI. */
	readonly config: CliConfig;
	/** Where the launch writes its own files. */
	readonly runDir: string;
	/** Unique per agent, for the names of those files: its number. */
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

/**
 * What Facade knows of an agent CLI: how to find it, and how to start it in its own UI so that it comes
 * up with nobody at the keyboard - with Facade's MCP server, at full access, the person's trust in a
 * worktree Facade made, and nothing that would stop it at a question. Each launch's configuration is its
 * own: flags, files in its run folder, and files in its folder.
 */
export interface AgentCli {
	/** The id `spawn` and Start Agent use. */
	readonly id: string;
	readonly displayName: string;
	/** Where its settings are: `facade.orchestration.<section>.*`. */
	readonly section: string;
	/** The command to look for on PATH. */
	readonly command: string;
	/** How Facade starts it where the person sets nothing else. */
	readonly defaults: CliConfig;
	/**
	 * For a CLI that keeps the person's trust in a file: what each `${name}` of its `launch.trust` stands
	 * for, for a worktree Facade made, with the person's home folder as its environment `env` says it.
	 */
	trustValues?(worktree: { readonly folder: string; readonly repository: string }, env: Environment): { readonly [name: string]: string };
	/** Its MCP server comes from a file in its folder that every agent there reads: the server finds the agent from its environment. */
	readonly sharedServer?: boolean;
	/**
	 * How it gets its task: `argument`, on its command line; `terminal`, in a file, with a line typed into
	 * its terminal once its MCP server said hello, for a CLI whose first conversation has no MCP tools.
	 */
	readonly task: 'argument' | 'terminal';
	launch(input: LaunchInput, executable: string): LaunchSpec;
}

/** A CLI this machine has: its definition, how the person has Facade start it, and the file Facade starts. */
export interface InstalledCli {
	readonly cli: AgentCli;
	readonly config: CliConfig;
	readonly executable: string;
}
