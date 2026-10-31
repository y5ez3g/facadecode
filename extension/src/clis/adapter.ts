/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a CLI adapter is (CLIS-2.1, 3.2, 4.2): one versioned definition per CLI that owns its literal invocation - its argument
// groups, vendor flags and quirks, which no setting exposes - and states its capabilities as supported, unavailable or
// unverified with the reason, never more than the evidence holds.

import type { Environment } from './environment';
import type { LaunchTarget } from './executable';
import type { TrustTarget } from './trust';

/**
 * The argument groups of an invocation (CLIS-3.2): run settings, the YOLO mapping, per-launch trust, then the configured
 * `.launch.arguments` in the vendor's options position (CLIS-3.1).
 */
export const GROUP_ORDER = ['quiet', 'yoloOn', 'yoloOff', 'trust', 'extra'] as const;

export type Group = (typeof GROUP_ORDER)[number];

/** An adapter's groups, as literal arguments with `${name}`s the adapter fills itself; `extra` is the configured `arguments`. */
export type Groups = { readonly [G in Exclude<Group, 'extra'>]?: readonly string[] };

/** What one launch applies (CLIS-3.2). */
export interface LaunchUses {
	readonly yolo: boolean;
}

/** Whether `group` applies to a launch `uses` describes. */
export function applies(group: Group, uses: LaunchUses): boolean {
	switch (group) {
		case 'yoloOn': return uses.yolo;
		case 'yoloOff': return !uses.yolo;
		case 'quiet': return true;
		case 'trust': return true;
		case 'extra': return true;
	}
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
	readonly yolo: boolean;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
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
	readonly displayName: string;
	/** Its settings: `facade.<segment>`, or `facade.custom.<key>`. */
	readonly setting: string;
	/** The command PATH is searched for where its `path` setting is empty; a custom CLI's configured path. */
	readonly command: string;
	readonly groups: Groups;
	/** The values its groups' `${name}`s take for a launch. */
	values(input: LaunchInput): { readonly [name: string]: string };
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
