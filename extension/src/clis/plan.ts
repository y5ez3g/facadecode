/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Discovery and the launch plan (CLIS-1.1, 1.2, 4.2): computed from the catalog, the destination environment and the request
// alone, before any file or process exists. Discovery and launch use the same environment, so the program found is the one
// started; every prerequisite that can be checked is checked here, and a failure carries its actual reason.

import { newSessionId, SESSION_FILE_VARIABLE } from './identity';
import { expanded, invocation } from './adapter';
import { BUILT_IN_ADAPTERS, Catalog, CatalogEntry, entryOf } from './catalog';
import { CliSaid, shown } from './config';
import { CUSTOM_SETTING } from './custom';
import { composeEnvironment, Environment, EnvironmentMap, runEnvironment } from './environment';
import { FoundExecutable, LaunchTarget, isNodeScript, launchTarget, resolveExecutable, unsafeCharacterForCmd, unsafeForCmd } from './executable';
import type { TrustTarget } from './trust';

/** The destination environment's own layers (CLIS-1.2), read where the launch will run. */
export interface DestinationEnvironment {
	/** The execution extension host's environment. */
	readonly host: Environment;
	/** `terminal.integrated.env.<platform>` for the location. */
	readonly terminal?: EnvironmentMap;
	/** The default terminal profile's `env` map, where the profile has one. */
	readonly profile?: EnvironmentMap;
	/** That profile's name, as Show Agent Launch names its layer (CLIS-4.1). */
	readonly profileName?: string;
	readonly platform: NodeJS.Platform;
}

/** What is asked of the planner (PlanRequest's facts, as plain data). */
export interface PlanInput {
	readonly resume?: { readonly sessionId: string };
	readonly sessionFile?: string;
	readonly sessionHook?: string;
	readonly cli: string;
	/** The run's `#aN` alias, which its environment carries (CLIS-1.2). */
	readonly alias: string;
	readonly cwd: string;
	readonly yolo: boolean;
}

/**
 * How a launch trusts its folder (CLIS-3.3, D62): a native file entry, or an override already in its arguments - these, none for a
 * CLI that asks no trust question; for a custom CLI, nothing Facade knows of: it starts as configured, and asks in its terminal
 * where it asks (CLIS-3.4).
 */
export type LaunchTrust = {
	readonly kind: 'file';
	readonly target: TrustTarget;
} | { readonly kind: 'arguments'; readonly args: readonly string[] } | { readonly kind: 'unknown' };

/** A launch as planned: the same facts as the core's LaunchPlan, kept as plain data here. */
export interface PlannedLaunch {
	readonly files?: readonly { readonly file: string; readonly content: string }[];
	readonly sessionId?: string;
	readonly exactResume?: boolean;
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
	const env = composeEnvironment({ host: destination.host, terminal: destination.terminal, profile: destination.profile, launch: entry.environment }, destination.platform);
	entry.adapter.adjustEnvironment?.(env, destination.platform);
	return env;
}

/** Where `entry`'s program is for a launch in `cwd`, found with the launch's own environment (CLIS-1.2). */
export function executableOf(entry: CatalogEntry, env: Environment, cwd: string, platform: NodeJS.Platform): FoundExecutable {
	return resolveExecutable(entry.path, entry.adapter.command, entry.adapter.setting, env, cwd, platform);
}

/** How `entry`'s program `file` starts for a launch in `cwd`: as its adapter's verified launcher has it, else as a program (CLIS-1.2). */
export function targetOf(entry: CatalogEntry, file: string, env: Environment, platform: NodeJS.Platform, cwd: string): LaunchTarget {
	return entry.adapter.launchTarget?.(file, platform, env, cwd) ?? launchTarget(file, platform, env, cwd);
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
 * The catalog for a destination folder, as new starts are offered it (CLIS-1.1): the enabled built-ins in their order, then the
 * custom CLIs, each found with its own launch environment. A configuration problem is said in the person's language by its first (UX-2.4).
 */
export function discover(catalog: Catalog, destination: DestinationEnvironment, cwd: string): readonly Discovered[] {
	return catalog.entries.filter(entry => entry.enabled).map(entry => {
		if (entry.problems.length) {
			return { entry, available: false, problem: entry.problems.map(each => each.text).join('; '), said: entry.problems[0].said };
		}
		const found = executableOf(entry, environmentOf(entry, destination), cwd, destination.platform);
		if (found.problem !== undefined) {
			return { entry, available: false, problem: found.problem, said: found.said, ...!entry.path ? { notInstalled: true } : {} };
		}
		return { entry, available: true };
	});
}

/** How a launch of `entry` trusts its folder `cwd` (CLIS-3.3, 3.4), found where the run will look for it: with the environment `env` it starts with. */
function trustOf(entry: CatalogEntry, cwd: string, env: Environment, platform: NodeJS.Platform, values: { readonly [name: string]: string }): LaunchTrust {
	const { adapter } = entry;
	if (entry.custom) {
		return { kind: 'unknown' };
	}
	return adapter.trustTarget ? { kind: 'file', target: adapter.trustTarget(cwd, env, platform) } : { kind: 'arguments', args: expanded(adapter.groups.trust ?? [], values) };
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
		// Where custom CLIs are configured with errors, those may be why: both are said (CLIS-3.4)
		const ids = BUILT_IN_ADAPTERS.map(each => each.id);
		const custom = catalog.problems.length
			? `; custom CLIs are configured in ${CUSTOM_SETTING}, which has errors: ${catalog.problems.map(each => each.text).join('; ')}`
			: `, and custom CLIs are configured in ${CUSTOM_SETTING}`;
		throw new CliPlanError(`No CLI ${JSON.stringify(input.cli)} is configured; the built-ins are ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}${custom}`, 'not_found');
	}
	const { adapter } = entry;
	// A turned-off CLI is not newly started; its runs go on (CLIS-1.1, RULES-4.4)
	if (!entry.enabled) {
		throw new CliPlanError(`${adapter.displayName} is turned off by ${adapter.setting}.enabled`, 'unavailable', { kind: 'cli_disabled', values: [adapter.displayName, adapter.setting] });
	}
	if (entry.problems.length) {
		throw new CliPlanError(entry.problems.map(each => each.text).join('; '), 'configuration_invalid', entry.problems[0].said);
	}
	const { platform } = destination;
	const env = environmentOf(entry, destination);
	const found = executableOf(entry, env, input.cwd, platform);
	if (found.problem !== undefined) {
		throw new CliPlanError(found.problem, 'not_found', found.said);
	}
	const target = targetOf(entry, found.executable, env, platform, input.cwd);
	if (input.resume && (!input.resume.sessionId || input.resume.sessionId.includes('\0') || (!entry.custom && !adapter.groups.resume))) {
		throw new CliPlanError(`${adapter.displayName} cannot resume this exact conversation`, 'unsupported', { kind: 'resume_unsupported', values: [adapter.displayName] });
	}
	const sessionId = input.resume?.sessionId ?? (adapter.groups.session && input.sessionFile ? newSessionId() : undefined);
	const values = { ...adapter.values({ yolo: input.yolo, cwd: input.cwd, platform, sessionId, sessionHook: input.sessionHook }), ...(sessionId ? { sessionId } : {}) };
	const extra = input.resume && entry.custom ? entry.custom.resume.map(arg => arg.replace(/\$\{sessionId\}/g, () => input.resume!.sessionId)) : entry.extra;
	const integration = input.sessionFile && input.sessionHook ? adapter.sessionIntegration?.({ file: input.sessionFile, hook: input.sessionHook, env, cwd: input.cwd, platform, extra }) : undefined;
	const args = [...target.args, ...invocation(adapter.groups, [...integration?.extra ?? extra, ...integration?.args ?? []], { yolo: input.yolo, resume: !!input.resume && !entry.custom, session: !!sessionId }, values)];
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
		const unsafe = args.findIndex(unsafeForCmd);
		// A configured argument is named by its place in the setting and its character, never quoted: it may be a secret (CLIS-4.1)
		const configured = unsafe - (args.length - entry.extra.length);
		if (unsafe >= 0 && configured >= 0) {
			const setting = entry.extraSetting;
			const character = unsafeCharacterForCmd(args[unsafe])!;
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given ${setting}[${configured}] safely, as that argument contains ${character}; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe_setting', values: [found.executable, setting, String(configured), character, adapter.setting] });
		}
		if (unsafe >= 0) {
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given the argument ${shown(args[unsafe])} safely; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe', values: [found.executable, shown(args[unsafe]), adapter.setting] });
		}
	}
	const runEnv = runEnvironment(env, input.alias, platform);
	if (adapter.sessionIdentity && input.sessionFile) { runEnv[SESSION_FILE_VARIABLE] = input.sessionFile; }
	Object.assign(runEnv, integration?.env);
	return {
		...integration?.files ? { files: integration.files } : {},
		cli: adapter.id,
		...(sessionId ? { sessionId } : {}),
		exactResume: !!adapter.sessionIdentity && !!input.sessionFile && !!input.sessionHook && !integration?.unavailable,
		displayName: adapter.displayName,
		command: adapter.command,
		executable: target.executable,
		args,
		env: runEnv,
		cwd: input.cwd,
		trust: trustOf(entry, input.cwd, runEnv, platform, values),
		...adapter.screenStatus ? { screenStatus: adapter.screenStatus } : {}
	};
}
