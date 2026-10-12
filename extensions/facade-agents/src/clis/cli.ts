/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { JsonObject, mergedObject } from '../base/json';

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
 * The groups of a launch's arguments, in the order a launch gives them (AGENT-LAUNCHER.md, L9):
 * `warmUp`, a first message of its own for a CLI whose MCP servers connect only after one; `connect`,
 * how Facade's tools and skills reach it; `quiet`, what keeps onboarding, tips, surveys and updates from
 * stopping it; `questions`, what takes away the tools that would leave its terminal waiting for someone
 * to pick an answer; `messages`, what lets it read Facade's message files under a sandbox; `yoloOn` and
 * `yoloOff`, of which one applies; `model`; `effort`, how hard it thinks; `extra`, the person's own; and
 * `task`, the short notice of its task. The arguments of a trust given for the launch go before `extra`.
 */
export const ARG_GROUPS = ['warmUp', 'connect', 'quiet', 'questions', 'messages', 'yoloOn', 'yoloOff', 'model', 'effort', 'extra', 'task'] as const;

/** One of {@link ARG_GROUPS}. */
export type ArgGroup = (typeof ARG_GROUPS)[number];

/**
 * What Facade does wherever an agent starts so that the CLI does not stop to ask whether the person
 * trusts the folder - its whole repository: arguments given that launch alone, or `merge` merged into
 * the JSON file `file`, which the CLI keeps, as it writes the person's answer, and Facade never takes back.
 */
export type TrustConfig =
	| { readonly arguments: readonly string[]; readonly file?: undefined; readonly merge?: undefined }
	| { readonly arguments?: undefined; readonly file: string; readonly merge: JsonObject };

/**
 * What an agent started through `start_agent` - by another agent, or by the person's scripts, where nobody may be
 * watching - runs with in place of parts of its launch (AGENT-LAUNCHER.md, L4): each of its groups of arguments in
 * place of the launch's group of that name, an empty one taking it out; its variables over the launch's, one set to
 * null taking the launch's out; and its settings over the launch's, key by key, the same way. An agent the person
 * starts from the UI runs with the launch as it is.
 */
export interface UnattendedLaunch {
	readonly arguments: { readonly [Group in ArgGroup]?: readonly string[] };
	readonly environment: { readonly [name: string]: string | null };
	readonly settings?: JsonObject;
}

/** How Facade starts a CLI, part by part: the setting `facade.agents.<cli>.launch`, or a custom agent's `launch`. */
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
	/** What an agent started through `start_agent` runs with in place of parts of this launch; none: the same launch. */
	readonly unattended?: UnattendedLaunch;
}

/**
 * The launch an agent runs with: `config`'s own for one the person started from the UI; for one started through
 * `start_agent` - `unattended` - with its unattended part in place (L4). Either has no unattended part of its own.
 */
export function launchFor(config: CliConfig, unattended: boolean): CliConfig {
	const { unattended: overlay, ...launch } = config.launch;
	if (!unattended || !overlay) {
		return { ...config, launch };
	}
	const environment: { [name: string]: string } = { ...launch.environment };
	for (const [name, value] of Object.entries(overlay.environment)) {
		// On Windows a variable's name is the same in any case
		const key = process.platform === 'win32' ? Object.keys(environment).find(each => each.toUpperCase() === name.toUpperCase()) ?? name : name;
		if (value === null) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	}
	const settings = overlay.settings ? mergedObject(launch.settings ?? {}, overlay.settings) : launch.settings;
	return { ...config, launch: { ...launch, arguments: { ...launch.arguments, ...overlay.arguments }, environment, ...(settings ? { settings } : {}) } };
}

/**
 * How Facade starts a CLI: a built-in's definition holds its defaults, and the person changes them with
 * `facade.agents.<cli>.enabled`, `.path` and `.launch`; a custom agent's is the person's alone. In an
 * argument, `${name}` stands for a value the launch gives it.
 */
export interface CliConfig {
	/** The file Facade starts, or a command PATH finds; empty for the CLI's command on PATH. */
	readonly path: string;
	/** Whether it is offered, to the person and to agents: a custom agent always is. */
	readonly enabled: boolean;
	readonly launch: LaunchConfig;
	/**
	 * What is wrong in the person's settings of it, each naming the setting: while anything is, it is not
	 * started, and its launch has Facade's own part in place of each wrong one only to be shown.
	 */
	readonly wrong?: readonly string[];
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

/** What one launch applies of a CLI's groups (AGENT-LAUNCHER.md, L9). */
export interface LaunchUses {
	/** Whether it has the agent framework's integration: its `warmUp`, `connect` and `messages`. */
	readonly framework: boolean;
	/** Its YOLO: `yoloOn` where it is on, `yoloOff` where it is off. */
	readonly yolo: boolean;
	/** Whether it was given a model, an effort, a task: each group only where it was. */
	readonly model: boolean;
	readonly effort: boolean;
	readonly task: boolean;
	/** Whether a trust given as arguments goes in. */
	readonly trust: boolean;
}

/**
 * The sandbox a launch of `cli`, as `config` has it, leaves it with: its maintained one, unless the file that
 * carries it is passed by no group the launch applies - then off, as the CLI runs, never on (X-07).
 */
export function sandboxOf(cli: AgentCli, config: CliConfig, uses: LaunchUses): Sandbox {
	const sandbox = uses.yolo ? cli.sandbox.yoloOn : cli.sandbox.yoloOff;
	if (sandbox !== 'on' || cli.sandboxIn === undefined) {
		return sandbox;
	}
	const file = `\${${cli.sandboxIn}}`;
	return ARG_GROUPS.some(group => appliesTo(group, uses) && (config.launch.arguments[group] ?? []).some(arg => arg.includes(file))) ? 'on' : 'off';
}

/** Whether `group` applies to a launch `uses` describes: an empty group adds nothing either way. */
export function appliesTo(group: ArgGroup, uses: LaunchUses): boolean {
	switch (group) {
		case 'warmUp':
		case 'connect':
		case 'messages':
			return uses.framework;
		case 'yoloOn':
			return uses.yolo;
		case 'yoloOff':
			return !uses.yolo;
		case 'model':
			return uses.model;
		case 'effort':
			return uses.effort;
		case 'task':
			return uses.task;
		case 'quiet':
		case 'questions':
		case 'extra':
			return true;
	}
}

/**
 * A launch's arguments: the groups of `config` that apply, in their order, each `${name}` in them
 * replaced by `values[name]`, with the arguments of a trust given for the launch before `extra`. A group
 * that does not apply is not read, so a `${name}` in it needs no value. Throws, naming `setting` - the
 * launch's setting - at a `${name}` the launch has no value for.
 */
export function launchArgs(setting: string, config: CliConfig, values: { readonly [name: string]: string }, uses: LaunchUses): string[] {
	const { trust } = config.launch;
	const args: string[] = [];
	for (const group of ARG_GROUPS) {
		if (group === 'extra' && uses.trust && trust?.arguments) {
			args.push(...trust.arguments.map(arg => withValues(arg, values, `${setting}.trust.arguments`)));
		}
		if (appliesTo(group, uses)) {
			args.push(...(config.launch.arguments[group] ?? []).map(arg => withValues(arg, values, `${setting}.arguments.${group}`)));
		}
	}
	return args;
}

/** How an agent reaches Facade's window, for a launch with the agent framework's integration (AGENT-ORCHESTRATION.md, O9). */
export interface Connection {
	/** Facade's MCP server for this agent. */
	readonly mcp: McpLaunch;
	/** The values of the connection's `${name}`s: `executable`, `shimFile`, `recordDir`, `tokenFile`, `waitMs`. */
	readonly values: { readonly [name: string]: string };
}

/** What a CLI's launch is given for one agent. */
export interface LaunchInput {
	/** The folder it runs in, whose repository - or the folder itself, outside any - it is given the person's trust in. */
	readonly folder: string;
	/** The main checkout of the folder's repository; the folder itself outside any. */
	readonly repository: string;
	/** The home folder, as the environment its terminal starts with has it - as its trust has it (X-58); Facade's own where none is given. */
	readonly home?: string;
	/** Where the files of the workspace's messages are: long messages, and fetches too long for a result (M11). */
	readonly messagesDir: string;
	/** Where the agents' screens are kept: final screens, and reads too long for a result (AGENT-DEBUGGING.md, D6). */
	readonly screensDir: string;
	/** Its YOLO: with its launch's `yoloOn` arguments, or its `yoloOff`. */
	readonly yolo: boolean;
	/** Whether nobody may be watching it: started through `start_agent` (L4). Its `config` is that starter's launch (`launchFor`). */
	readonly unattended: boolean;
	/** Its first line - who it is, and the number of its task (AGENT-MESSAGES.md, M7) - for a CLI given it as an argument. */
	readonly task?: string;
	/** The model and how hard it thinks, as the CLI takes them, where it was given them: Facade passes them on as they are. */
	readonly model?: string;
	readonly effort?: string;
	/** How it reaches Facade, with the agent framework on; none without its integration. */
	readonly connection?: Connection;
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
	 * The content to write instead where the folder has a file at that path already: that file with
	 * Facade's part added, or undefined where it cannot be added.
	 */
	readonly merge?: (theirs: string) => string | undefined;
}

/** A CLI's sandbox, as its launch leaves it: on, off, unavailable where it has none, unknown for a custom agent. */
export type Sandbox = 'on' | 'off' | 'unavailable' | 'unknown';

/**
 * What Facade knows of an agent CLI: how to find it, and how to start it in its own UI - with Facade's
 * MCP server while the agent framework is on, its sandbox and approvals as the agent's YOLO says, given
 * the person's trust in its folder's repository, and with nothing that would stop it at a question nobody
 * is there to answer. Each launch's configuration is its own: flags, files in its run folder, and files in
 * its folder. A custom agent is one too, its launch the person's alone.
 */
export interface AgentCli {
	/** The id `start_agent` and Start Agent use: a built-in's, or a custom agent's name. */
	readonly id: string;
	readonly displayName: string;
	/** Its settings: `facade.agents.<cli>`, or `facade.agents.custom.<name>` for a custom agent. */
	readonly setting: string;
	/** The command to look for on PATH; a custom agent's program. */
	readonly command: string;
	/** How Facade starts it where the person sets nothing else. */
	readonly defaults: CliConfig;
	/**
	 * For a CLI that keeps the person's trust in a file: what each `${name}` of its `launch.trust` stands
	 * for, for a folder an agent starts in and its repository - or the folder itself, outside any - with the
	 * person's home folder as its environment `env` says it.
	 */
	trustValues?(place: { readonly folder: string; readonly repository: string }, env: Environment): { readonly [name: string]: string };
	/**
	 * What of the person's own configuration of it a launch with `args` in `folder` would mix Facade's content
	 * into - an entry of theirs under the name Facade's takes: a sentence naming the file and the entry, or
	 * undefined (AGENT-ORCHESTRATION.md: an unrelated conflicting entry produces a named configuration error).
	 */
	conflict?(args: readonly string[], folder: string, env: Environment): string | undefined;
	/**
	 * Where a setting of the person's own refuses Facade's tools with YOLO off - a deny rule of theirs, which
	 * wins over Facade's allow - for a launch in `folder` as `config` has it: which, in words; undefined for none
	 * (L4, rule 4; N-45: refused, not asked for).
	 */
	exemptionOverride?(config: CliConfig, env: Environment, folder: string): string | undefined;
	/** Its MCP server comes from a file in its folder that every agent there reads: the server finds the agent from its environment. */
	readonly sharedServer?: boolean;
	/**
	 * Its models carry their effort in their names - `gemini-3.8-flash-low`: given with a model, an effort is not
	 * used, the model's is (N-64).
	 */
	readonly modelCarriesEffort?: boolean;
	/**
	 * How it gets the notice of its task: `argument`, on its command line; `terminal`, typed into its
	 * terminal once its MCP server said hello, for a CLI whose first conversation has no MCP tools; `none`
	 * for a custom agent whose launch has no task group.
	 */
	readonly task: 'argument' | 'terminal' | 'none';
	/** Its sandbox with each YOLO, as its maintained launch leaves it. */
	readonly sandbox: { readonly yoloOn: Sandbox; readonly yoloOff: Sandbox };
	/**
	 * The `${name}` of the file its sandbox goes in, where one carries it: the sandbox is on only where a group
	 * the launch applies passes that file - the person's launch may leave it out (X-07).
	 */
	readonly sandboxIn?: string;
	/**
	 * With YOLO off, how Facade's tools go unasked: `precise`, its launch lets Facade's server through alone;
	 * `all`, it has no way to, and lets every tool through, its sandbox still on (AGENT-LAUNCHER.md, L4);
	 * `unknown` for a custom agent.
	 */
	readonly exemption: 'precise' | 'all' | 'unknown';
	/**
	 * Its tools that would leave its terminal waiting for someone to pick an answer: `removed`, by its launch's
	 * `questions` group; `none`, it has none; `kept`, its launch cannot take them away, and its instructions tell
	 * it to ask in words - a limitation its launch record says (AGENT-LAUNCHER.md, L4; N-55); `unknown` for a
	 * custom agent.
	 */
	readonly questionTool: 'removed' | 'none' | 'kept' | 'unknown';
	/** Whether it is the person's own, from `facade.agents.custom`. */
	readonly custom?: boolean;
	/** The version of it the last acceptance run started agents with, as Show Agent Launch shows it; none before one has. */
	readonly verified?: string;
	launch(input: LaunchInput, executable: string): LaunchSpec;
}

/** A CLI this machine has: its definition, how the person has Facade start it, and the file Facade starts. */
export interface InstalledCli {
	readonly cli: AgentCli;
	readonly config: CliConfig;
	readonly executable: string;
}

/**
 * The values every launch has for its `${name}`s (AGENT-LAUNCHER.md, L9): its folder, its repository's main
 * checkout, the home folder, where its messages' and screens' files are, the model, effort and first line it was
 * given, and its connection's. A CLI adds the files of its own launch, and forms of these its arguments need.
 */
export function launchValues(input: LaunchInput): { [name: string]: string } {
	return {
		folder: input.folder,
		repository: input.repository,
		home: input.home ?? os.homedir(),
		messagesDir: input.messagesDir,
		screensDir: input.screensDir,
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {},
		...input.task !== undefined ? { task: input.task } : {},
		...input.connection?.values
	};
}

/**
 * The groups of a built-in's launch that let Facade's server through with YOLO off - its yoloOff, and its
 * connect, where Codex's server setting is - that the person changed from Facade's own, for an agent the person
 * starts or, `unattended`, one started through `start_agent`: theirs to say, no working exemption of Facade's (L4,
 * rule 4; X-38). None for a custom agent, all of whose launch is theirs.
 */
export function exemptionGroupsChanged(cli: AgentCli, config: CliConfig, unattended: boolean): ('yoloOff' | 'connect')[] {
	const theirs = launchFor(config, unattended).launch.arguments;
	const facades = launchFor(cli.defaults, unattended).launch.arguments;
	return cli.custom ? [] : (['yoloOff', 'connect'] as const).filter(group => JSON.stringify(theirs[group] ?? []) !== JSON.stringify(facades[group] ?? []));
}

/** The groups of a launch for `input` that apply: those of its integration and YOLO, and of what it was given - a task only where `task` is. */
export function launchUses(input: LaunchInput, task = input.task !== undefined): LaunchUses {
	return { framework: !!input.connection, yolo: input.yolo, model: input.model !== undefined, effort: input.effort !== undefined, task, trust: true };
}

/** What a launch of `config` takes: Facade's integration, a task, a model and an effort, as `list_agents` tells agents (O6). */
export function capabilitiesOf(cli: AgentCli, config: CliConfig): { readonly integration: boolean; readonly task: boolean; readonly model: boolean; readonly effort: boolean } {
	const has = (group: ArgGroup) => (config.launch.arguments[group]?.length ?? 0) > 0;
	// A CLI that reads Facade's server from its folder has it there; any other only through its connect group,
	// which the person can take out (L9).
	const integration = !!cli.sharedServer || has('connect');
	return { integration, task: integration && cli.task !== 'none' && (cli.task === 'terminal' || has('task')), model: has('model'), effort: has('effort') };
}
