/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Discovery and the launch plan (CLIS-1.1, 1.2, 4.2): computed from the catalog, the destination environment and the request
// alone, before any file or process exists. Discovery and launch use the same environment, so the program found is the one
// started; every prerequisite that can be checked is checked here, and a failure carries its actual reason.

import { invocation } from './adapter';
import { Catalog, CatalogEntry, entryOf } from './catalog';
import { CliSaid, shown } from './config';
import { composeEnvironment, Environment, EnvironmentMap, runEnvironment } from './environment';
import { FoundExecutable, isNodeScript, launchTarget, resolveExecutable, unsafeForCmd } from './executable';
import type { TrustTarget } from './trust';

/** The destination environment's own layers (CLIS-1.2), read where the launch will run. */
export interface DestinationEnvironment {
	/** The execution extension host's environment. */
	readonly host: Environment;
	/** `terminal.integrated.env.<platform>` for the location. */
	readonly terminal?: EnvironmentMap;
	/** The default terminal profile's `env` map, where the profile has one. */
	readonly profile?: EnvironmentMap;
	readonly platform: NodeJS.Platform;
}

/** What is asked of the planner (PlanRequest's facts, as plain data). */
export interface PlanInput {
	readonly cli: string;
	/** The run's `#aN` alias, which its environment carries (CLIS-1.2). */
	readonly alias: string;
	readonly cwd: string;
	readonly yolo: boolean;
}

/** How a launch trusts its folder (CLIS-3.3, D62): a native file entry, or an override already in its arguments. */
export type LaunchTrust = {
	readonly kind: 'file';
	readonly target: TrustTarget;
} | { readonly kind: 'arguments' };

/** A launch as planned: the same facts as the core's LaunchPlan, kept as plain data here. */
export interface PlannedLaunch {
	readonly cli: string;
	readonly displayName: string;
	readonly command: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** How it trusts its folder: its entry is for the caller to merge into the CLI's file before the run starts. */
	readonly trust: LaunchTrust;
	/** How ptyd reads its status from its screen while it reports nothing, where its adapter names a reader (CLIS-2.3, D80). */
	readonly screenStatus?: string;
}

/** Why a launch cannot be planned, with the PlanError reason it maps to (RULES-5.1: the actual reason, before any effect). */
export class CliPlanError extends Error {
	constructor(message: string, readonly reason: 'configuration_invalid' | 'not_found' | 'unsupported' | 'unavailable', readonly said?: CliSaid) {
		super(message);
	}
}

/** The environment `entry`'s CLI is found and started with in `cwd`'s destination, before its run's own variables (CLIS-1.2). */
export function environmentOf(entry: CatalogEntry, destination: DestinationEnvironment): { [name: string]: string } {
	const env = composeEnvironment({ host: destination.host, terminal: destination.terminal, profile: destination.profile }, destination.platform);
	entry.adapter.adjustEnvironment?.(env, destination.platform);
	return env;
}

/** Where `entry`'s program is for a launch in `cwd`, found with the launch's own environment (CLIS-1.2). */
export function executableOf(entry: CatalogEntry, env: Environment, cwd: string, platform: NodeJS.Platform): FoundExecutable {
	return resolveExecutable(entry.path, entry.adapter.command, entry.adapter.setting, env, cwd, platform);
}

/** A discovered CLI for a destination folder: whether a new run can start, else why not (CLIS-1.1). */
export interface Discovered {
	readonly entry: CatalogEntry;
	readonly available: boolean;
	readonly problem?: string;
	/** The problem by kind and values, for the person's language. */
	readonly said?: CliSaid;
	/** A built-in with no configured path that is simply not installed here: New Agent does not offer it (LIFECYCLE-1.1). */
	readonly notInstalled?: boolean;
}

/**
 * The catalog for a destination folder, as new starts are offered it (CLIS-1.1): the built-ins in their order, each found with its own
 * launch environment.
 */
export function discover(catalog: Catalog, destination: DestinationEnvironment, cwd: string): readonly Discovered[] {
	return catalog.entries.map(entry => {
		if (entry.problems.length) {
			return { entry, available: false, problem: entry.problems.join('; '), ...entry.said ? { said: entry.said } : {} };
		}
		const found = executableOf(entry, environmentOf(entry, destination), cwd, destination.platform);
		if (found.problem !== undefined) {
			return { entry, available: false, problem: found.problem, said: found.said, ...!entry.path ? { notInstalled: true } : {} };
		}
		return { entry, available: true };
	});
}

/**
 * The launch of `input.cli` in `input.cwd` (CLIS-1.2, 1.3, 3.2, 4.2): its program found with the environment the run starts with, its
 * adapter's literal invocation - its run options and the YOLO mapping - and the run's variables. It writes nothing: a trust kept in a
 * file of the CLI's is its `trust`, for the caller to write before the run starts (CLIS-3.3). Throws CliPlanError with the actual
 * reason.
 */
export function planLaunch(catalog: Catalog, input: PlanInput, destination: DestinationEnvironment): PlannedLaunch {
	const entry = entryOf(catalog, input.cli);
	if (!entry) {
		const ids = catalog.entries.map(each => each.adapter.id);
		throw new CliPlanError(`No CLI ${JSON.stringify(input.cli)} is configured; the built-ins are ${ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : ids.join('')}`, 'not_found');
	}
	const { adapter } = entry;
	if (entry.problems.length) {
		throw new CliPlanError(entry.problems.join('; '), 'configuration_invalid', entry.said);
	}
	const { platform } = destination;
	const env = environmentOf(entry, destination);
	const found = executableOf(entry, env, input.cwd, platform);
	if (found.problem !== undefined) {
		throw new CliPlanError(found.problem, 'not_found', found.said);
	}
	const target = adapter.launchTarget?.(found.executable, platform, env, input.cwd) ?? launchTarget(found.executable, platform, env, input.cwd);
	const values = adapter.values({ yolo: input.yolo, cwd: input.cwd, platform });
	const args = [...target.args, ...invocation(adapter.groups, { yolo: input.yolo }, values)];
	if (isNodeScript(target.executable, platform)) {
		// A Node entry point - what a refusal below advises - that no Node on the PATH can run: Windows cannot run it itself
		throw new CliPlanError(`${target.executable} is a Node script, and Node is not on the PATH to run it`, 'not_found',
			{ kind: 'node_missing', values: [target.executable] });
	}
	if (target.throughCmd) {
		// cmd.exe starts in no UNC folder - a network share's, a WSL distribution's \\wsl$ one - but in the Windows directory,
		// where the CLI would run with the run's permissions: refused before anything starts
		if (/^[\\/]{2}/.test(input.cwd)) {
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot run in the UNC folder ${input.cwd}; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unc_folder', values: [found.executable, input.cwd, adapter.setting] });
		}
		// The program's own path reaches cmd.exe too, quoted only where it holds a space
		if (unsafeForCmd(target.executable)) {
			throw new CliPlanError(`${target.executable} runs through cmd.exe, which cannot be given its path safely; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe_path', values: [target.executable, adapter.setting] });
		}
		const unsafe = args.find(unsafeForCmd);
		if (unsafe !== undefined) {
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given the argument ${shown(unsafe)} safely; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe', values: [found.executable, shown(unsafe), adapter.setting] });
		}
	}
	const runEnv = runEnvironment(env, input.alias, platform);
	return {
		cli: adapter.id,
		displayName: adapter.displayName,
		command: adapter.command,
		executable: target.executable,
		args,
		env: runEnv,
		cwd: input.cwd,
		// Its trust found where the run will look for it: with the environment it starts with (CLIS-1.2, 3.3)
		trust: adapter.trustTarget ? { kind: 'file', target: adapter.trustTarget(input.cwd, runEnv, platform) } : { kind: 'arguments' },
		...adapter.screenStatus ? { screenStatus: adapter.screenStatus } : {}
	};
}
