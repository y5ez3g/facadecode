/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Discovery and the launch plan (CLIS-1.1, 1.2, 4.2): computed from the catalog, the destination environment and the request
// alone, before any file or process exists. Discovery and launch use the same environment, so the program found is the one
// started; every prerequisite that can be checked is checked here, and a failure carries its actual reason.

import { newSessionId, SESSION_FILE_VARIABLE } from './identity';
import { Capability, CliAdapter, expanded, invocation, WarmUp } from './adapter';
import { BUILT_IN_ADAPTERS, Catalog, CatalogEntry, entryOf } from './catalog';
import { CliSaid, shown } from './config';
import { composeEnvironment, Environment, EnvironmentMap, runEnvironment, setVariable, variableOf } from './environment';
import { FoundExecutable, LaunchTarget, isNodeScript, unsafeCharacterForCmd, launchTarget, resolveExecutable, unsafeForCmd } from './executable';
import type { Injection, ToolsInput } from './tools';
import { CUSTOM_SETTING } from './custom';
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
	/** This start's own model and effort (CLIS-1.4). */
	readonly model?: string;
	readonly effort?: string;
	/** The creation prompt (COLLABORATION-2.2): in the invocation where the adapter maps one that can carry it, else after startup. */
	readonly prompt?: string;
	/** The Facade tools, where orchestration is on (RULES-4.4, CLIS-2.2); absent, nothing is injected. */
	readonly tools?: ToolsInput;
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
	/** The CLI's installed version where its installation says it: diagnostics only (CLIS-2.1). */
	readonly version?: string;
	readonly model?: string;
	readonly effort?: string;
	/** Whether the Facade tools are injected, and why not where they are not (CLIS-2.2). */
	readonly tools: { readonly state: 'injected' | 'not_injected' | 'unavailable'; readonly reason?: string; readonly problem?: 'cmd' | 'files' | 'conflict' | 'variable'; readonly file?: string };
	/** How a requested creation prompt goes in, and the state of the native path (COLLABORATION-2.2, MCP-2.3). */
	readonly prompt?: { readonly path: 'native' | 'post_start'; readonly capability: Capability };
	readonly input: { readonly adapter?: string; readonly capability: Capability };
	/** The files the run's launch needs written before it starts, where the tools are injected (CLIS-2.2). */
	readonly injection?: Injection;
	/** How ptyd reads its status from its screen while it reports nothing, where its adapter names a reader (CLIS-2.3, D80). */
	readonly screenStatus?: string;
	/** What its start types before its first turn, where the tools are injected and its adapter needs it (COLLABORATION-2.2). */
	readonly warmUp?: WarmUp;
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
		return { path: 'post_start', capability: { state: 'unavailable', reason: adapter.promptAfterStart ?? `${adapter.displayName} takes no initial prompt argument; it is sent as the first message after the process starts` } };
	}
	const problem = prompt.includes('\0')
		? 'a prompt with a NUL character cannot be an argument'
		: adapter.promptProblem?.(prompt) ?? (throughCmd && unsafeForCmd(prompt) ? 'the CLI runs through cmd.exe, which cannot be given this prompt as an argument safely' : undefined);
	return problem === undefined
		? { path: 'native', capability: native }
		: { path: 'post_start', capability: { state: 'unavailable', reason: `${problem}; it is sent as the first message after the process starts` } };
}

/**
 * What `adapter` takes for a launch in `cwd` (CLIS-1.4): its own choices, less one whose arguments cmd.exe cannot be given where the
 * launch goes through it - Muse Code's effort, a JSON string, through its `muse.cmd` on Windows.
 */
export function takesThrough(adapter: CliAdapter, throughCmd: boolean, cwd: string, platform: NodeJS.Platform): CliAdapter['takes'] {
	if (!throughCmd) {
		return adapter.takes;
	}
	const passes = (kind: 'model' | 'effort') => {
		if (!adapter.takes[kind]) {
			return false;
		}
		const group = adapter.groups[kind] ?? [];
		return !expanded(group, adapter.values({ yolo: true, cwd, platform, [kind]: 'medium' })).some(unsafeForCmd);
	};
	return { model: passes('model'), effort: passes('effort') };
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

/** Remove configured defaults replaced by explicit model/effort choices, keeping original indices for configuration errors. */
function configuredArguments(args: readonly string[], overrides: readonly string[]): { readonly index: number; readonly value: string }[] {
	const options = new Set<string>();
	const settings = new Set<string>();
	for (let index = 0; index < overrides.length; index++) {
		const option = overrides[index];
		if (option === '-c') {
			settings.add(overrides[++index].split('=', 1)[0].trim());
		} else if (option.startsWith('-')) {
			options.add(option.split('=', 1)[0]);
		}
	}
	const kept: { index: number; value: string }[] = [];
	for (let index = 0; index < args.length; index++) {
		const value = args[index];
		const option = value.split('=', 1)[0];
		if (options.has(option)) {
			if (value === option && index + 1 < args.length) {
				index++;
			}
			continue;
		}
		if (option === '-c') {
			const setting = (value === '-c' ? args[index + 1] : value.slice(3))?.split('=', 1)[0].trim();
			if (setting !== undefined && settings.has(setting)) {
				if (value === '-c') {
					index++;
				}
				continue;
			}
		}
		kept.push({ index, value });
	}
	return kept;
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
	const takes = takesThrough(adapter, target.throughCmd, input.cwd, platform);
	for (const asked of ['model', 'effort'] as const) {
		if (input[asked] !== undefined && !takes[asked]) {
			throw new CliPlanError(`${adapter.displayName} has no supported way to set ${asked === 'model' ? 'a model' : 'an effort'}${adapter.takes[asked] ? ' where it runs through cmd.exe' : ''}; omit ${asked} to use its own default`, 'unsupported');
		}
	}
	const prompt = input.prompt === undefined ? undefined : promptOf(adapter, input.prompt, target.throughCmd);
	const native = prompt?.path === 'native';
	const values = { ...adapter.values({ yolo: input.yolo, cwd: input.cwd, platform, model: input.model, effort: input.effort, env, sessionId, sessionHook: input.sessionHook }), ...sessionId ? { sessionId } : {} };
	// Explicit MCP choices replace only their matching configured options (CLIS-1.4), without duplicate native flags.
	const extra = configuredArguments(input.resume && entry.custom ? entry.custom.resume.map(arg => arg.replace(/\$\{sessionId\}/g, () => input.resume!.sessionId)) : entry.extra, [
		...input.model !== undefined ? adapter.groups.model ?? [] : [],
		...input.effort !== undefined ? adapter.groups.effort ?? [] : []
	]);
	let injection = input.tools ? adapter.tools?.inject({ ...input.tools, platform }) : undefined;
	let tools: PlannedLaunch['tools'] = injection ? { state: 'injected' } : { state: 'not_injected' };
	// The tools' variables on the person's own, where a CLI's variable must keep theirs: one that cannot be read keeps theirs whole,
	// and the CLI starts without the tools rather than without the person's configuration (CLIS-2.2)
	const merged: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(injection?.env ?? {})) {
		const kept = adapter.mergeVariable ? adapter.mergeVariable(name, value, variableOf(env, name, platform)) : value;
		if (kept === undefined) {
			injection = undefined;
			tools = { state: 'unavailable', problem: 'variable', file: name, reason: `${name} in ${adapter.displayName}'s environment could not be read, so Facade leaves it as it is and does not give the agent its tools` };
			break;
		}
		merged[name] = kept;
	}
	const launchWith = (active: Injection | undefined) => {
		const started = { ...env };
		if (active) {
			for (const [name, value] of Object.entries(merged)) { setVariable(started, name, value, platform); }
		}
		const arguments_ = [...active?.args ?? [], ...invocation(adapter.groups, extra.map(each => each.value), {
			yolo: input.yolo, resume: !!input.resume && !entry.custom, session: !!sessionId,
			connect: active !== undefined, model: input.model !== undefined, effort: input.effort !== undefined, prompt: false
		}, { ...values, ...active?.values })];
		// Compose native identity with the complete tool settings. A second --settings must not erase either integration.
		const integration = input.sessionFile && input.sessionHook ? adapter.sessionIntegration?.({
			file: input.sessionFile, hook: input.sessionHook, env: started, cwd: input.cwd, platform, extra: arguments_, tools: active !== undefined, throughCmd: target.throughCmd
		}) : undefined;
		const args = [...target.args, ...integration?.extra ?? arguments_, ...integration?.args ?? [],
			...native ? expanded(adapter.groups.prompt!, { ...values, prompt: input.prompt! }) : []];
		return { args, started, integration };
	};
	let launch = launchWith(injection);
	if (target.throughCmd && injection && launch.args.some(unsafeForCmd) && !launchWith(undefined).args.some(unsafeForCmd)) {
		injection = undefined;
		tools = { state: 'unavailable', problem: 'cmd', reason: `${found.executable} runs through cmd.exe, which cannot be given the Facade tools' arguments safely; set ${adapter.setting}.path to the CLI's own program or Node entry point` };
		launch = launchWith(undefined);
	}
	const { args, started, integration } = launch;
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
		const configured = extra.find(each => unsafeForCmd(each.value))?.index ?? -1;
		if (configured >= 0) {
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
	const runEnv = runEnvironment(started, input.alias, platform);
	if (adapter.sessionIdentity && input.sessionFile) { runEnv[SESSION_FILE_VARIABLE] = input.sessionFile; }
	Object.assign(runEnv, integration?.env);
	const version = installedVersionOf(adapter.id, found.executable)?.version;
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
		// Its trust found where the run will look for it: with the environment it starts with (CLIS-1.2, 3.3)
		trust: trustOf(entry, input.cwd, runEnv, platform, values),
		...version !== undefined ? { version } : {},
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {},
		tools,
		...prompt ? { prompt } : {},
		input: inputOf(adapter),
		...injection ? { injection } : {},
		...adapter.screenStatus ? { screenStatus: adapter.screenStatus } : {},
		// Only for the tools: without them, nothing waits on its first turn
		...injection && adapter.warmUp ? { warmUp: adapter.warmUp } : {}
	};
}
