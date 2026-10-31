/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Discovery and the launch plan (CLIS-1.1, 1.2, 4.2): computed from the catalog, the destination environment and the request
// alone, before any file or process exists. Discovery and launch use the same environment, so the program found is the one
// started; every prerequisite that can be checked is checked here, and a failure carries its actual reason.

import { Capability, CliAdapter, invocation } from './adapter';
import { Catalog, CatalogEntry, entryOf } from './catalog';
import { CliSaid, shown } from './config';
import { composeEnvironment, Environment, EnvironmentMap, runEnvironment, setVariable } from './environment';
import { FoundExecutable, launchTarget, resolveExecutable, unsafeForCmd } from './executable';
import type { Injection, ToolsInput } from './tools';
import type { TrustTarget } from './trust';
import { installedVersionOf } from './version';

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
	/** This start's own model and effort (CLIS-1.4). */
	readonly model?: string;
	readonly effort?: string;
	/** The creation prompt (COLLABORATION-2.2): in the invocation where the adapter maps one that can carry it, else after startup. */
	readonly prompt?: string;
	/** The Facade tools, where orchestration is on (RULES-4.4, CLIS-2.2); absent, nothing is injected. */
	readonly tools?: ToolsInput;
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
	/** The CLI's installed version where its installation says it: diagnostics only (CLIS-2.1). */
	readonly version?: string;
	readonly model?: string;
	readonly effort?: string;
	/** Whether the Facade tools are injected, and why not where they are not (CLIS-2.2). */
	readonly tools: { readonly state: 'injected' | 'not_injected' | 'unavailable'; readonly reason?: string; readonly problem?: 'cmd' | 'files' | 'conflict'; readonly file?: string };
	/** How a requested creation prompt goes in, and the state of the native path (COLLABORATION-2.2, MCP-2.3). */
	readonly prompt?: { readonly path: 'native' | 'post_start'; readonly capability: Capability };
	readonly input: { readonly adapter?: string; readonly capability: Capability };
	/** The files the run's launch needs written before it starts, where the tools are injected (CLIS-2.2). */
	readonly injection?: Injection;
}

/** Why a launch cannot be planned, with the PlanError reason it maps to (RULES-5.1: the actual reason, before any effect). */
export class CliPlanError extends Error {
	constructor(message: string, readonly reason: 'configuration_invalid' | 'not_found' | 'unsupported' | 'unavailable', readonly said?: CliSaid) {
		super(message);
	}
}

/**
 * How `prompt` goes in (COLLABORATION-2.2, D49): natively where the adapter maps a prompt argument that can carry it - used while
 * unverified, its state reported - else as the first message after the process starts.
 */
function promptOf(adapter: CliAdapter, prompt: string, throughCmd: boolean): { readonly path: 'native' | 'post_start'; readonly capability: Capability } {
	const native = adapter.initialPrompt;
	if (!adapter.groups.prompt || !native) {
		return { path: 'post_start', capability: { state: 'unavailable', reason: `${adapter.displayName} takes no initial prompt argument; it is sent as the first message after the process starts` } };
	}
	const problem = prompt.includes('\0')
		? 'a prompt with a NUL character cannot be an argument'
		: adapter.promptProblem?.(prompt) ?? (throughCmd && unsafeForCmd(prompt) ? 'the CLI runs through cmd.exe, which cannot be given this prompt as an argument safely' : undefined);
	return problem === undefined
		? { path: 'native', capability: native }
		: { path: 'post_start', capability: { state: 'unavailable', reason: `${problem}; it is sent as the first message after the process starts` } };
}

/**
 * A run's ordinary-message input (CLIS-2.1): its CLI's input reader recognizes the input box by its layout, whatever the version, and
 * a screen it does not recognize is never typed into. A CLI without a reader takes no message; direct terminal input still works.
 */
export function inputOf(adapter: CliAdapter): { readonly adapter?: string; readonly capability: Capability } {
	if (!adapter.input) {
		return { capability: { state: 'unavailable', reason: `Facade cannot read the message input of ${adapter.displayName}, so messages to it fail; direct terminal input still works` } };
	}
	return { adapter: adapter.input.adapter, capability: { state: 'supported', reason: `${adapter.input.adapter} reads ${adapter.displayName}'s input by its layout: ${adapter.input.evidence}` } };
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
		throw new CliPlanError(`No CLI ${JSON.stringify(input.cli)} is configured; the built-ins are claude and codex`, 'not_found');
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
	for (const asked of ['model', 'effort'] as const) {
		if (input[asked] !== undefined && !adapter.takes[asked]) {
			throw new CliPlanError(`${adapter.displayName} has no supported way to set ${asked === 'model' ? 'a model' : 'an effort'}; omit ${asked} to use its own default`, 'unsupported');
		}
	}
	const target = launchTarget(found.executable, platform, env, input.cwd);
	const prompt = input.prompt === undefined ? undefined : promptOf(adapter, input.prompt, target.throughCmd);
	const native = prompt?.path === 'native';
	const argsWith = (injection: Injection | undefined) => [...target.args, ...invocation(adapter.groups, {
		yolo: input.yolo, connect: injection !== undefined, model: input.model !== undefined, effort: input.effort !== undefined, prompt: native
	}, {
		...adapter.values({ yolo: input.yolo, cwd: input.cwd, platform, model: input.model, effort: input.effort }),
		...injection?.values,
		...native ? { prompt: input.prompt! } : {}
	})];
	let injection = input.tools ? adapter.tools.inject(input.tools) : undefined;
	let tools: PlannedLaunch['tools'] = injection ? { state: 'injected' } : { state: 'not_injected' };
	let args = argsWith(injection);
	if (target.throughCmd && injection && args.some(unsafeForCmd) && !argsWith(undefined).some(unsafeForCmd)) {
		// The tools alone cannot pass through cmd.exe: the CLI starts without them rather than not at all (MCP-6.1)
		injection = undefined;
		tools = { state: 'unavailable', problem: 'cmd', reason: `${found.executable} runs through cmd.exe, which cannot be given the Facade tools' arguments safely; set ${adapter.setting}.path to the CLI's own program or Node entry point` };
		args = argsWith(undefined);
	}
	if (target.throughCmd) {
		const unsafe = args.find(unsafeForCmd);
		if (unsafe !== undefined) {
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given the argument ${shown(unsafe)} safely; set ${adapter.setting}.path to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe', values: [found.executable, shown(unsafe), adapter.setting] });
		}
	}
	const started = { ...env };
	for (const [name, value] of Object.entries(injection?.env ?? {})) {
		setVariable(started, name, value, platform);
	}
	const runEnv = runEnvironment(started, input.alias, platform);
	const version = installedVersionOf(adapter.id, found.executable)?.version;
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
		...version !== undefined ? { version } : {},
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {},
		tools,
		...prompt ? { prompt } : {},
		input: inputOf(adapter),
		...injection ? { injection } : {}
	};
}
