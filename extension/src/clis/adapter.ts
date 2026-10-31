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

/**
 * The argument groups of an invocation, in the order an adapter gives them (CLIS-3.2): the MCP connection, the CLI's own run
 * settings, the YOLO mapping, model, effort, the trust in the folder for this launch alone (CLIS-3.3, D62), and last a positional
 * initial prompt, after the end of the options.
 */
export const GROUP_ORDER = ['connect', 'quiet', 'yoloOn', 'yoloOff', 'model', 'effort', 'trust', 'prompt'] as const;

export type Group = (typeof GROUP_ORDER)[number];

/** An adapter's groups, as literal arguments with `${name}`s the adapter fills itself. */
export type Groups = { readonly [G in Group]?: readonly string[] };

/**
 * What one launch applies (CLIS-3.2). Its MCP connection (`connect`), model, effort and a native initial prompt (`prompt`) are
 * separate facts of the request; a launch that has none of them never expands those groups.
 */
export interface LaunchUses {
	readonly yolo: boolean;
	readonly connect: boolean;
	readonly model: boolean;
	readonly effort: boolean;
	readonly prompt: boolean;
}

/** Whether `group` applies to a launch `uses` describes. */
export function applies(group: Group, uses: LaunchUses): boolean {
	switch (group) {
		case 'yoloOn': return uses.yolo;
		case 'yoloOff': return !uses.yolo;
		case 'connect': return uses.connect;
		case 'model': return uses.model;
		case 'effort': return uses.effort;
		case 'prompt': return uses.prompt;
		case 'quiet': return true;
		case 'trust': return true;
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

/** The literal invocation of an adapter's groups for one launch (CLIS-3.2): the groups that apply, in {@link GROUP_ORDER}. */
export function invocation(groups: Groups, uses: LaunchUses, values: { readonly [name: string]: string }): string[] {
	const args: string[] = [];
	for (const group of GROUP_ORDER) {
		if (applies(group, uses)) {
			args.push(...expanded(groups[group] ?? [], values));
		}
	}
	return args;
}

/** What a launch is asked for and where, as an adapter's values are computed from it. */
export interface LaunchInput {
	readonly yolo: boolean;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly model?: string;
	readonly effort?: string;
}

/** A CLI adapter (CLIS-2.1, 4.2): a built-in's maintained definition. */
export interface CliAdapter {
	/** The API ID: `claude`, `codex`, `agy`, `muse`, `opencode` or `pi` (CLIS-1.1). */
	readonly id: string;
	readonly displayName: string;
	/** Its settings: `facade.<segment>`. */
	readonly setting: string;
	/** The command PATH is searched for where its `path` setting is empty. */
	readonly command: string;
	readonly groups: Groups;
	/** Whether an explicit model and effort can be passed (CLIS-1.4); a CLI that cannot take one is refused it, never ignoring it. */
	readonly takes: { readonly model: boolean; readonly effort: boolean };
	/** The values its groups' `${name}`s take for a launch. */
	values(input: LaunchInput): { readonly [name: string]: string };
	/** How it is given the Facade tools (CLIS-2.2). */
	readonly tools: ToolsIntegration;
	/** The reader of its ordinary-message input (CLIS-2.1); none, and no message is typed into it. */
	readonly input?: InputReader;
	/** How far its native initial prompt argument is verified (COLLABORATION-2.2, D49), where its `prompt` group maps one. */
	readonly initialPrompt?: Capability;
	/** Why `prompt` cannot be its native initial prompt argument, where it cannot - it then goes in after startup. */
	promptProblem?(prompt: string): string | undefined;
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
