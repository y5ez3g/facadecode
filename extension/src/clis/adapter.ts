/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a CLI adapter is (CLIS-2.1, 3.2, 4.2): one versioned definition per CLI that owns its literal invocation - its argument
// groups, vendor flags and quirks, which no setting exposes - and states its capabilities as supported, unavailable or
// unverified with the reason, never more than the evidence holds.

import type { Environment } from './environment';
import type { Capability, ToolsIntegration } from './tools';
import type { LaunchTarget } from './executable';
import type { TrustTarget } from './trust';
import type { SessionIntegration, SessionIntegrationInput } from './identity';

/**
 * The argument groups of an invocation, in the order an adapter gives them (CLIS-3.2): the MCP connection, the CLI's own run
 * settings, the YOLO mapping, model, effort, the trust in the folder for this launch alone (CLIS-3.3, D62), and last a positional
 * initial prompt, after the end of the options. Configured extra arguments keep their literal values before that prompt.
 */
export const GROUP_ORDER = ['resume', 'connect', 'quiet', 'yoloOn', 'yoloOff', 'model', 'effort', 'trust', 'session', 'extra', 'prompt'] as const;

export type Group = (typeof GROUP_ORDER)[number];

/** An adapter's groups, as literal arguments with `${name}`s the adapter fills itself; `extra` is the configured `arguments`. */
export type Groups = { readonly [G in Exclude<Group, 'extra'>]?: readonly string[] };

/**
 * What one launch applies (CLIS-3.2). Its MCP connection (`connect`), model, effort and a native initial prompt (`prompt`) are
 * separate facts of the request; a launch that has none of them never expands those groups.
 */
export interface LaunchUses {
	readonly resume?: boolean;
	readonly session?: boolean;
	readonly yolo: boolean;
	readonly connect: boolean;
	readonly model: boolean;
	readonly effort: boolean;
	readonly prompt: boolean;
}

/** Whether `group` applies to a launch `uses` describes. */
export function applies(group: Group, uses: LaunchUses): boolean {
	switch (group) {
		case 'resume': return !!uses.resume;
		case 'session': return !!uses.session && !uses.resume;
		case 'yoloOn': return uses.yolo;
		case 'yoloOff': return !uses.yolo;
		case 'connect': return uses.connect;
		case 'model': return uses.model;
		case 'effort': return uses.effort;
		case 'prompt': return uses.prompt;
		case 'quiet': return true;
		case 'trust': return true;
		case 'extra': return true;
	}
}

export type { Capability } from './tools';

/**
 * How a CLI's ordinary-message input is read (CLIS-2.1, 2.3): the ptyd input reader that recognizes its input box on the screen by
 * its layout, whatever the CLI's version. A screen it does not recognize is unknown, and nothing is typed into it.
 */
export interface InputReader {
	/** The reader by its ID in ptyd (`ptyd/composer.ts`). */
	readonly adapter: string;
	/** The layouts it was recorded on, as diagnostics name them. */
	readonly evidence: string;
}

/**
 * `args` with each `${name}` replaced by `values[name]` as literal data. Groups are the adapter's own, so a name without a
 * value is a defect of the adapter, never something a person wrote: it throws.
 */
export function expanded(args: readonly string[], values: { readonly [name: string]: string }): string[] {
	return args.map(arg => arg.replace(/\$\{(?<name>[^}]+)\}/g, (placeholder, name: string) => {
		if (!Object.hasOwn(values, name)) {
			throw new Error(`The adapter's argument ${arg} has no value for ${placeholder}.`);
		}
		return values[name];
	}));
}

/**
 * The literal invocation of an adapter's groups for one launch (CLIS-3.1, 3.2): the groups that apply, in {@link GROUP_ORDER}, the
 * configured `extra` arguments among them as they are - a person's literal options, never expanded.
 */
export function invocation(groups: Groups, extra: readonly string[], uses: LaunchUses, values: { readonly [name: string]: string }): string[] {
	const args: string[] = [];
	for (const group of GROUP_ORDER) {
		if (applies(group, uses)) {
			args.push(...group === 'extra' ? extra : expanded(groups[group] ?? [], values));
		}
	}
	return args;
}

/** A `key=value` override of a CLI's configuration among a launch's arguments, as Codex and Muse Code take one (CLIS-1.4, 2.4). */
export interface ConfigOverride {
	/** Where its option is among the arguments, and how many arguments it spans: `-c key=value` two, `-c=key=value` one. */
	readonly index: number;
	readonly span: 1 | 2;
	/** Its key, the text before the first `=`, trimmed. */
	readonly key: string;
	/** The text after that `=`; none where it has none. */
	readonly value?: string;
}

/** The configuration overrides of `args` in their order: `-c` and `--config`, the value apart or after `=` alike. */
export function configOverrides(args: readonly string[]): ConfigOverride[] {
	const overrides: ConfigOverride[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const apart = arg === '-c' || arg === '--config';
		const joined = /^(?:-c|--config)=/.exec(arg)?.[0];
		const text = apart ? args[index + 1] : joined ? arg.slice(joined.length) : undefined;
		if (text === undefined) {
			continue;
		}
		const at = text.indexOf('=');
		overrides.push({ index, span: apart ? 2 : 1, key: (at < 0 ? text : text.slice(0, at)).trim(), ...at < 0 ? {} : { value: text.slice(at + 1) } });
		if (apart) {
			index++;
		}
	}
	return overrides;
}

/** What a launch is asked for and where, as an adapter's values are computed from it. */
export interface LaunchInput {
	readonly sessionId?: string;
	readonly sessionHook?: string;
	readonly yolo: boolean;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly model?: string;
	readonly effort?: string;
	/** The environment the launch starts with, where an adapter reads the person's own CLI settings by it. */
	readonly env?: Environment;
}

/**
 * What a run's start types into its CLI before its first turn (COLLABORATION-2.2), where that turn could not use the Facade tools
 * otherwise: `text` entered into its empty input, its screen waited on until it shows `ready`, then `close` pressed while what it
 * opened still shows.
 */
export interface WarmUp {
	readonly text: string;
	/** A row of its screen once `text` alone is in its input, as a regular expression's source: Enter goes only then. */
	readonly typed: string;
	/** What its screen shows once the tools are there, as a regular expression's source. */
	readonly ready: string;
	/** A row of what `text` opened, as a regular expression's source: `close` goes only while it shows. */
	readonly opened: string;
	/** The key that closes what `text` opened, as press_keys names keys. */
	readonly close: string;
}

/**
 * A CLI's sandbox as a launch leaves it (CLIS-1.3, 4.1): turned on by arguments of the launch (`by`), else by Facade's run settings
 * for it; turned off by arguments; left to the CLI's own configuration; none, where the CLI has no sandbox on this platform; or
 * unknown, for a custom CLI whose configuration Facade does not read (CLIS-3.3, 3.4).
 */
export type SandboxFact = { readonly state: 'on'; readonly by?: readonly string[] } | { readonly state: 'off'; readonly by: readonly string[] } | { readonly state: 'native' | 'none' | 'unknown' };

/**
 * A CLI's approvals as a launch leaves them (CLIS-1.3, 4.1): bypassed by arguments of the launch, its own, none it has, or unknown
 * for a custom CLI (CLIS-3.4).
 */
export type ApprovalFact = { readonly state: 'bypassed'; readonly by: readonly string[] } | { readonly state: 'native' | 'none' | 'unknown' };

/** A CLI adapter (CLIS-2.1, 4.2): a built-in's maintained definition, or a custom CLI's validated configuration (CLIS-3.4). */
export interface CliAdapter {
	/** The API ID: `claude`, `codex`, `agy`, `muse`, `opencode`, `pi`, or a custom CLI's key (CLIS-1.1, 3.4). */
	readonly id: string;
	/** A maintained exact identity across native session changes, required for Pin. */
	readonly sessionIdentity?: boolean;
	/** Vendor integration for exact identity, scoped to this process and preserving native user settings. */
	sessionIntegration?(input: SessionIntegrationInput): SessionIntegration;
	/** Native shortcuts that can replace/fork the exact conversation selected by Facade. */
	readonly identityOptions?: readonly string[];
	readonly displayName: string;
	/** Its settings: `facade.<segment>`, or `facade.custom.<key>`. */
	readonly setting: string;
	/** The command PATH is searched for where its `path` setting is empty; a custom CLI's configured path. */
	readonly command: string;
	readonly groups: Groups;
	/**
	 * Other spellings its CLI takes for an option of its groups - a short form, an alias - by that option: an argument spelled so is the
	 * same option, refused where Facade sets it and replaced where an explicit choice sets it (CLIS-1.4, 3.1).
	 */
	readonly aliases?: { readonly [option: string]: readonly string[] };
	/** Whether an explicit model and effort can be passed (CLIS-1.4); a CLI that cannot take one is refused it, never ignoring it. */
	readonly takes: { readonly model: boolean; readonly effort: boolean };
	/** The values its groups' `${name}`s take for a launch. */
	values(input: LaunchInput): { readonly [name: string]: string };
	/** How it is given the Facade tools (CLIS-2.2). */
	readonly tools?: ToolsIntegration;
	/** The reader of its ordinary-message input (CLIS-2.1); none, and no message is typed into it. */
	readonly input?: InputReader;
	/** How far its native initial prompt argument is verified (COLLABORATION-2.2, D49), where its `prompt` group maps one. */
	readonly initialPrompt?: Capability;
	/** Why `prompt` cannot be its native initial prompt argument, where it cannot - it then goes in after startup. */
	promptProblem?(prompt: string): string | undefined;
	/** Why its initial prompt goes in as the first message after startup, where it has no native prompt argument a run can use. */
	readonly promptAfterStart?: string;
	/** What its start types before its first turn, where that turn could not use the Facade tools otherwise (COLLABORATION-2.2). */
	readonly warmUp?: WarmUp;
	/**
	 * The value its launch gives the variable `name` the tools set (CLIS-1.2), where the tools' value `ours` must keep the person's
	 * own value `theirs` of it; undefined where theirs cannot be read, which then stays as it is, the run without the tools.
	 */
	mergeVariable?(name: string, ours: string, theirs: string | undefined): string | undefined;
	/** What its launch must change in the environment, for a quirk of the CLI's own (CLIS-1.2). */
	adjustEnvironment?(env: { [name: string]: string }, platform: NodeJS.Platform): void;
	/**
	 * Where it keeps trust in folders in a file of its own (CLIS-3.3, D62): its file and its entry for the folder `cwd` a launch starts
	 * in, found with the environment `env` the launch starts with, as the CLI finds them.
	 */
	trustTarget?(cwd: string, env: Environment, platform: NodeJS.Platform): TrustTarget;
	/**
	 * How its own installer's launcher `file` starts it, where the adapter verified that launcher (CLIS-1.2): found with the launch's
	 * environment `env` in `cwd`; undefined for any other file, which is then started as `launchTarget` starts it.
	 */
	launchTarget?(file: string, platform: NodeJS.Platform, env: Environment, cwd: string): LaunchTarget | undefined;
	/**
	 * The screen reader ptyd reads its status with while it sends no OSC 7501 reports, by its ID in `ptyd/screenStatus.ts`: Muse
	 * Code's, which sends none on Windows (CLIS-2.3, D80). Its own reports, where it sends them, always take precedence.
	 */
	readonly screenStatus?: 'muse';
	/**
	 * Its title decorations (CLIS-2.3): status marks its titles start with, titles that only name it, and the placeholder its reports
	 * give for a title before it has one.
	 */
	readonly title: { readonly decoration?: RegExp; readonly names: readonly string[]; readonly placeholder?: RegExp };
	/** Its sandbox for a launch with this YOLO on this platform, as Show Agent Launch says it (CLIS-1.3, 4.1). */
	sandbox(yolo: boolean, platform: NodeJS.Platform): SandboxFact;
	/** Its approvals for a launch with this YOLO (CLIS-1.3, 4.1). */
	approvals(yolo: boolean): ApprovalFact;
	/**
	 * Whether an exit was the CLI's own handling of an interrupt the person typed (RULES-3.3): `ctrlC` says a Ctrl+C went into its
	 * terminal just before. Without the adapter's evidence, no exit is an interrupt.
	 */
	interruptExit(exit: { readonly code?: number; readonly signal?: string; readonly ctrlC: boolean }): boolean;
}

/** The interrupt outcome of a CLI that ends as POSIX programs do on SIGINT: exit 130, or the signal itself, after a Ctrl+C. */
export function sigintExit(exit: { readonly code?: number; readonly signal?: string; readonly ctrlC: boolean }): boolean {
	return exit.ctrlC && (exit.code === 130 || exit.signal === 'SIGINT');
}
