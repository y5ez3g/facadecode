/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a CLI adapter is (CLIS-2.1, 3.2, 4.2): one versioned definition per CLI that owns its literal invocation - its argument
// groups, vendor flags and quirks, which no setting exposes - and states its capabilities as supported, unavailable or
// unverified with the reason, never more than the evidence holds.

import { setOwn } from '../base/json';
import type { ArgsGrammar } from './args';
import type { CliSaid } from './config';
import type { Environment } from './environment';
import type { Capability, ToolsIntegration } from './tools';
import type { LaunchTarget } from './executable';
import type { TrustTarget } from './trust';
import type { SessionIntegration, SessionIntegrationInput } from './identity';

/**
 * The argument groups of an invocation, in the order an adapter gives them (CLIS-3.2): the MCP connection, the CLI's own run
 * settings, the YOLO mapping, model, effort, the trust in the folder for this launch alone (CLIS-3.3), and last a positional
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

/** What a launch is asked for and where, as an adapter's values are computed from it. */
export interface LaunchInput {
	readonly sessionId?: string;
	readonly sessionHook?: string;
	readonly yolo: boolean;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	/** The model and effort the launch passes: this start's own, else its entry's (CONFIGURATION-3.3, CLIS-1.4). */
	readonly model?: string;
	readonly effort?: string;
	/** The environment the launch starts with, where an adapter reads the person's own CLI settings by it. */
	readonly env?: Environment;
	/** The run's own folder of files, removed when it ends (CLIS-2.2): where a run settings file goes. */
	readonly runDir?: string;
	/** What the launch's entry sets in `env` and what it removes (CONFIGURATION-3.2, 5.1), as a CLI's run settings must carry them. */
	readonly entryEnv?: EntryEnvironment;
	/** The launch's entry, by its setting path, as a problem names it: `clis.claude`, or `clis["Claude · work"]`. */
	readonly setting?: string;
}

/** The variables a launch's entry sets - their values as the launch has them - and those it removes (CONFIGURATION-3.2). */
export interface EntryEnvironment {
	readonly set: { readonly [name: string]: string };
	readonly removed: readonly string[];
}

/** A JSON object, as a CLI's settings are one. */
type JsonSettings = { readonly [key: string]: unknown };

function isSettingsObject(value: unknown): value is JsonSettings {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The settings `ours` over the person's own `theirs` (CONFIGURATION-3.1): objects merged key by key; a list of `hooks` by event, theirs
 * first; another list theirs with ours added; any other value ours. Neither is changed.
 */
export function mergeSettings(theirs: JsonSettings, ours: JsonSettings): { [key: string]: unknown } {
	const merged: { [key: string]: unknown } = { ...theirs };
	for (const [key, value] of Object.entries(ours)) {
		// Its own value alone: never one an object inherits, as `__proto__` would read
		const before = Object.hasOwn(merged, key) ? merged[key] : undefined;
		if (key === 'hooks' && isSettingsObject(before) && isSettingsObject(value)) {
			const hooks: { [event: string]: unknown } = { ...before };
			for (const [event, groups] of Object.entries(value)) {
				const earlier = Object.hasOwn(hooks, event) ? hooks[event] : undefined;
				setOwn(hooks, event, [...Array.isArray(earlier) ? earlier : [], ...Array.isArray(groups) ? groups : [groups]]);
			}
			setOwn(merged, key, hooks);
		} else if (isSettingsObject(before) && isSettingsObject(value)) {
			setOwn(merged, key, mergeSettings(before, value));
		} else if (Array.isArray(before) && Array.isArray(value)) {
			setOwn(merged, key, [...before, ...value.filter(each => !before.some(earlier => JSON.stringify(earlier) === JSON.stringify(each)))]);
		} else {
			setOwn(merged, key, value);
		}
	}
	return merged;
}

/** Run settings the person gives in an entry's `args`, by the setting path of the argument that gives them: `clis.claude.args[1]`. */
export interface RunSettingsGiven {
	readonly place: string;
	readonly settings: { readonly [key: string]: unknown };
}

/**
 * A variable Facade gives a run last (CONFIGURATION-3.2, CLIS-1.2) - every agent terminal's, the run's alias and session file, what its
 * tools and session tracking add - with the value the run starts with, or none where the run removes it.
 */
export interface FinalVariable {
	readonly name: string;
	readonly value: string | undefined;
}

/** A run as its run settings are finished for it, once the rest of its launch is planned. */
export interface FinishedRun {
	/** The variables Facade gives the run last, as the run starts with them. */
	readonly last: readonly FinalVariable[];
	/** Whether the run is given the Facade tools. */
	readonly tools: boolean;
	/** The environment the launch starts with, where an adapter reads the person's own CLI settings by it. */
	readonly env: Environment;
	readonly platform: NodeJS.Platform;
}

/**
 * A CLI that takes its settings for one run from a file (CLIS-3.2): Claude Code's `--settings`. Facade's settings go over the person's
 * own given with the same option in its entry's `args`, which are merged into them, never refused (CONFIGURATION-3.1); the merged
 * settings are a file of the run, readable by its user alone, named by its path - never inline, where any user's process list would
 * show what they hold (CONFIGURATION-4.2).
 */
export interface RunSettingsFile {
	/** The option that names the file. */
	readonly option: string;
	/** The file's name in the run's folder. */
	readonly name: string;
	/**
	 * The run's settings: Facade's, over the person's own `theirs` - each given at its place in the entry's `args`, merged in their
	 * order; or why the launch cannot start with them, said by its setting - never a value.
	 */
	build(input: LaunchInput, theirs: readonly RunSettingsGiven[]): { readonly settings: { readonly [key: string]: unknown } } | { readonly problem: string; readonly said: CliSaid };
	/**
	 * `settings` as `run` is given them, with what Facade gives it after the entry and the person's own settings (CLIS-3.4,
	 * CONFIGURATION-3.2): the Facade tools' permission where the run has them; and where the CLI sets the variables of its settings over
	 * the environment it starts with, each variable Facade gives the run last that they name, holding its value in the run - or left out
	 * where the run removes it.
	 */
	finish?(settings: { readonly [key: string]: unknown }, run: FinishedRun): { readonly [key: string]: unknown };
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
 * unknown, for a program whose configuration Facade does not read (CONFIGURATION-2.3).
 */
export type SandboxFact = { readonly state: 'on'; readonly by?: readonly string[] } | { readonly state: 'off'; readonly by: readonly string[] } | { readonly state: 'native' | 'none' | 'unknown' };

/**
 * A CLI's approvals as a launch leaves them (CLIS-1.3, 4.1): bypassed by arguments of the launch, its own, none it has, or unknown
 * for a program (CONFIGURATION-2.3).
 */
export type ApprovalFact = { readonly state: 'bypassed'; readonly by: readonly string[] } | { readonly state: 'native' | 'none' | 'unknown' };

/** A CLI adapter (CLIS-2.1, 4.2): a built-in's maintained definition, or a program's validated entry (CONFIGURATION-2.3). */
export interface CliAdapter {
	/** The API ID: `claude`, `codex`, `agy`, `muse`, `opencode`, `pi`, or the name of an entry added in `clis` (CONFIGURATION-2.1). */
	readonly id: string;
	/** For an added entry of a built-in's type, that built-in (CONFIGURATION-2.3): what Facade keys by CLI is that built-in's. */
	readonly builtIn?: string;
	/** A maintained exact identity across native session changes, required for Pin. */
	readonly sessionIdentity?: boolean;
	/** Vendor integration for exact identity, scoped to this process and preserving native user settings. */
	sessionIntegration?(input: SessionIntegrationInput): SessionIntegration;
	readonly displayName: string;
	/** Its entry in the settings file, as a problem names it: `clis.codex`, or `clis["Codex · work"]` (CONFIGURATION-4.1). */
	readonly setting: string;
	/** The command PATH is searched for where its entry sets no `command`; a program's `command`. */
	readonly command: string;
	readonly groups: Groups;
	/**
	 * Why its installed version `version` is not started (CLIS-1.1), for a line of it Facade does not support: refused where new starts
	 * are offered it and at a start alike, with how to update. Where this is absent, or no version is known, every version starts.
	 */
	refusesVersion?(version: string): { readonly problem: string; readonly said: CliSaid } | undefined;
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
	/**
	 * What its entry's `args` cannot hold (CONFIGURATION-3.1): the options and configuration keys Facade sets or decides itself. A
	 * program has none; every built-in has its own.
	 */
	readonly grammar?: ArgsGrammar;
	/** How it takes its settings for one run from a file, where it does (CLIS-3.2). */
	readonly runSettings?: RunSettingsFile;
	/**
	 * Options that take a list, given by Facade and by the person alike (CONFIGURATION-3.1), each by all its spellings: the person's
	 * values go into Facade's occurrence, so that the CLI takes both whichever of two occurrences it would keep.
	 */
	readonly additive?: readonly (readonly string[])[];
	/** The reader of its ordinary-message input (CLIS-2.1); none, and no message is typed into it. */
	readonly input?: InputReader;
	/** How far its native initial prompt argument is verified (COLLABORATION-2.2), where its `prompt` group maps one. */
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
	 * Where it keeps trust in folders in a file of its own (CLIS-3.3): its file and its entry for the folder `cwd` a launch starts
	 * in, found with the environment `env` the launch starts with, as the CLI finds them.
	 */
	trustTarget?(cwd: string, env: Environment, platform: NodeJS.Platform): TrustTarget;
	/**
	 * How its own installer's launcher `file` starts it, where the adapter verified that launcher (CLIS-1.2): found with the launch's
	 * environment `env` in `cwd`; undefined for any other file, which is then started as `launchTarget` starts it.
	 */
	launchTarget?(file: string, platform: NodeJS.Platform, env: Environment, cwd: string): LaunchTarget | undefined;
	/**
	 * A tested native status layout, by its ID in `ptyd/screenStatus.ts`: Muse's fallback before native reports, or Codex's
	 * completed-turn correction for a known installed version (CLIS-2.3). Unknown versions receive no version-scoped correction.
	 */
	screenStatus?(version: string | undefined): string | undefined;
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
