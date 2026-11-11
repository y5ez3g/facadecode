/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Discovery and the launch plan (CLIS-1.1, 1.2, 4.2): computed from the catalog, the destination environment and the request
// alone, before any file or process exists. Discovery and launch use the same environment, so the program found is the one
// started; every prerequisite that can be checked is checked here, and a failure carries its actual reason.

import * as path from 'path';
import { newSessionId, SESSION_FILE_VARIABLE } from './identity';
import * as fs from 'fs';
import { Capability, CliAdapter, EntryEnvironment, expanded, FinalVariable, invocation, RunSettingsGiven, WarmUp } from './adapter';
import { argumentUnits, isOption } from './args';
import { BUILT_IN_ADAPTERS, builtInOf, Catalog, CatalogEntry, entryOf, isProgram } from './catalog';
import { CliSaid, shown } from './config';
import { AGENT_TERMINAL_VARIABLES, composeEnvironment, Environment, EnvironmentMap, RUN_VARIABLE, runEnvironment, setVariable, variableOf } from './environment';
import { FoundExecutable, LaunchTarget, isNodeScript, unsafeCharacterForCmd, launchTarget, resolveExecutable, unsafeForCmd } from './executable';
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
	/** That profile's name, as Show Agent Launch names its layer (CLIS-4.1). */
	readonly profileName?: string;
	readonly platform: NodeJS.Platform;
}

/** What is asked of the planner (PlanRequest's facts, as plain data). */
export interface PlanInput {
	/** The exact conversation it resumes. */
	readonly resume?: { readonly sessionId: string };
	/** The built-in that ran what this start continues - a conversation it resumes, an agent its Pin restores - where known (CONFIGURATION-3.4). */
	readonly builtIn?: string;
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
	/** The run's own folder of files, removed when it ends (CLIS-2.2): where a CLI's run settings file goes (CONFIGURATION-4.2). */
	readonly runDir?: string;
}

/** Where a run's own folder is named where none is given, as Show Agent Launch names what only a start has. */
const NO_RUN_DIR = '<run files>';

/**
 * How a launch trusts its folder (CLIS-3.3): a native file entry, or an override already in its arguments - these, none for a
 * CLI that asks no trust question; for a program, nothing Facade knows of: it starts as configured, and asks in its terminal
 * where it asks (CONFIGURATION-2.3).
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
	/** The built-in whose adapter runs it (CONFIGURATION-2.3): its own ID for a built-in, none for a program. */
	readonly builtIn?: string;
	readonly displayName: string;
	readonly command: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** How it trusts its folder: its entry is for the caller to merge into the CLI's file before the run starts. */
	readonly trust: LaunchTrust;
	/** The CLI's installed version where its installation says it: diagnostics and tested status corrections (CLIS-2.1, 2.3). */
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
	/** The adapter's native status layout for ptyd, as a fallback or version-scoped correction (CLIS-2.3). */
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
 * How `prompt` goes in (COLLABORATION-2.2): natively where the adapter maps a prompt argument that can carry it - used while
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
	return adjustedEnvironment(entry, layeredEnvironmentOf(entry, destination), destination.platform);
}

/** The layers of `entry`'s environment in `destination`, before its adapter changes anything for a quirk of its CLI (CLIS-1.2). */
export function layeredEnvironmentOf(entry: CatalogEntry, destination: DestinationEnvironment): { [name: string]: string } {
	return composeEnvironment({ host: destination.host, terminal: destination.terminal, profile: destination.profile, launch: entry.environment }, destination.platform);
}

/** `layered` as `entry`'s adapter changes it for a quirk of its CLI (CLIS-1.2): a copy, `layered` left as it is. */
export function adjustedEnvironment(entry: CatalogEntry, layered: { readonly [name: string]: string }, platform: NodeJS.Platform): { [name: string]: string } {
	const env = { ...layered };
	entry.adapter.adjustEnvironment?.(env, platform);
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
	/** The program found for an available CLI, and the environment it was found with: what its start would use. */
	readonly executable?: string;
	readonly env?: { readonly [name: string]: string };
}

/** Each `${env:NAME}` of `map` at `setting` whose variable the environment `host` has not: never read as empty (CLIS-1.2). */
function missingReferences(map: EnvironmentMap | undefined, setting: string, host: Environment, platform: NodeJS.Platform): { readonly text: string; readonly said: CliSaid }[] {
	const problems: { text: string; said: CliSaid }[] = [];
	for (const [name, value] of Object.entries(map ?? {})) {
		for (const match of typeof value === 'string' ? value.matchAll(/\$\{env:(?<variable>[^}]+)\}/g) : []) {
			const variable = match.groups!.variable;
			if (variableOf(host, variable, platform) === undefined) {
				problems.push({ text: `${setting}.${name} reads \${env:${variable}}, but ${variable} is not in the editor's environment; set it there, or write the value`, said: { kind: 'env_reference_missing', values: [`${setting}.${name}`, variable] } });
			}
		}
	}
	return problems;
}

/**
 * What is wrong with `entry`'s own `env` where it would start (CONFIGURATION-2.2, 3.2): a `${env:NAME}` whose variable the
 * destination's host environment does not have - never read as empty - and, on Windows, two names that differ only in letter case,
 * which are one there.
 */
export function destinationProblems(entry: Pick<CatalogEntry, 'entry' | 'environment'>, destination: Pick<DestinationEnvironment, 'host' | 'platform'>): { readonly text: string; readonly said: CliSaid }[] {
	const setting = `${entry.entry.setting}.env`;
	const problems = missingReferences(entry.environment, setting, destination.host, destination.platform);
	if (destination.platform === 'win32') {
		const seen = new Map<string, string>();
		for (const name of Object.keys(entry.environment)) {
			const earlier = seen.get(name.toLowerCase());
			if (earlier !== undefined) {
				problems.push({ text: `${setting} names ${earlier} and ${name}, which are one variable on Windows; keep one of them`, said: { kind: 'env_case_duplicate', values: [setting, earlier, name] } });
			}
			seen.set(name.toLowerCase(), name);
		}
	}
	return problems;
}

/**
 * What is wrong with `entry`'s configuration where it would start in `destination` (CONFIGURATION-2.2, 3.2, 4.1): its own errors and
 * its `env`'s, there. Said before anything else about it - its `enabled: false` too - by discovery, Resume and planning alike; nothing
 * here looks for its program. The editor's terminal layers are read as its terminal reads them, a missing `${env:NAME}` empty (CLIS-1.2).
 */
export function configurationProblems(entry: CatalogEntry, destination: Pick<DestinationEnvironment, 'host' | 'platform'>): readonly { readonly text: string; readonly said: CliSaid }[] {
	return [...entry.problems, ...destinationProblems(entry, destination)];
}

/**
 * One CLI for a destination folder (CLIS-1.1): whether a new run of it can start there, else why not - its program found with its own
 * launch environment. A configuration problem is said in the person's language by its first (UX-2.4).
 */
export function discoverEntry(entry: CatalogEntry, destination: DestinationEnvironment, cwd: string): Discovered {
	const problems = configurationProblems(entry, destination);
	if (problems.length) {
		return { entry, available: false, problem: problems.map(each => each.text).join('; '), said: problems[0].said };
	}
	const env = environmentOf(entry, destination);
	const found = executableOf(entry, env, cwd, destination.platform);
	if (found.problem !== undefined) {
		// An added CLI is the person's own: one whose program is not here is said with why, never left out (CONFIGURATION-4.1)
		return { entry, available: false, problem: found.problem, said: found.said, ...!entry.path && entry.entry.builtIn ? { notInstalled: true } : {} };
	}
	// A line of it Facade does not support, as its installation names its version: offered as unavailable, saying how to update
	const version = entry.adapter.refusesVersion ? installedVersionOf(builtInOf(entry.adapter.id, entry.adapter.builtIn) ?? entry.adapter.id, found.executable)?.version : undefined;
	const refused = version === undefined ? undefined : entry.adapter.refusesVersion?.(version);
	if (refused) {
		return { entry, available: false, problem: refused.problem, said: refused.said };
	}
	return { entry, available: true, executable: found.executable, env };
}

/** Why an entry turned off by its `enabled` is not newly started; its runs go on (CLIS-1.1, CONFIGURATION-2.2). */
export function turnedOffError(adapter: Pick<CliAdapter, 'displayName' | 'setting'>): CliPlanError {
	return new CliPlanError(`${adapter.displayName} is turned off by ${adapter.setting}.enabled`, 'unavailable', { kind: 'cli_disabled', values: [adapter.displayName, adapter.setting] });
}

/**
 * The catalog for a destination folder, as new starts are offered it (CLIS-1.1): the enabled built-ins in their order, then the added
 * CLIs; a turned-off entry with an error too, which is said rather than hidden (CONFIGURATION-2.2, 4.1).
 */
export function discover(catalog: Catalog, destination: DestinationEnvironment, cwd: string): readonly Discovered[] {
	return catalog.entries.filter(entry => entry.enabled || configurationProblems(entry, destination).length).map(entry => discoverEntry(entry, destination, cwd));
}

/** How a launch of `entry` trusts its folder `cwd` (CLIS-3.3, 3.4), found where the run will look for it: with the environment `env` it starts with. */
function trustOf(entry: CatalogEntry, cwd: string, env: Environment, platform: NodeJS.Platform, values: { readonly [name: string]: string }): LaunchTrust {
	const { adapter } = entry;
	if (isProgram(entry)) {
		return { kind: 'unknown' };
	}
	return adapter.trustTarget ? { kind: 'file', target: adapter.trustTarget(cwd, env, platform) } : { kind: 'arguments', args: expanded(adapter.groups.trust ?? [], values) };
}

/**
 * The person's own run settings for `adapter` among `extra` (CONFIGURATION-3.1): each of its option's values - a JSON object, or a file
 * that holds one, from `cwd` - merged in their order, and the arguments without them, their places kept for what is said of them.
 */
function theirRunSettings(adapter: CliAdapter, extra: readonly { readonly index: number; readonly value: string }[], setting: string, cwd: string): { readonly given: readonly RunSettingsGiven[]; readonly rest: { readonly index: number; readonly value: string }[] } {
	// In each spelling the CLI reads: a Go program's after one dash too
	const grammar = adapter.grammar ?? { reserved: [] };
	const given: RunSettingsGiven[] = [];
	const rest: { index: number; value: string }[] = [];
	// Read as the CLI reads them, each argument once: another option's value that looks like its option is that option's (CLIS-3.1)
	for (const unit of argumentUnits(extra.map(each => each.value), grammar)) {
		const arguments_ = extra.slice(unit.index, unit.index + unit.span);
		if (unit.kind !== 'option' || !isOption(unit.option, adapter.runSettings!.option, grammar) || (unit.form !== 'apart' && unit.form !== 'equals' && unit.form !== 'none')) {
			rest.push(...arguments_);
			continue;
		}
		const place = `${setting}[${extra[unit.index].index}]`;
		const { option } = unit;
		const [text] = unit.values;
		if (text === undefined) {
			throw new CliPlanError(`${place} is ${option} with no value after it`, 'configuration_invalid', { kind: 'run_settings_missing', values: [place, option] });
		}
		let parsed: unknown;
		if (text.trim().startsWith('{')) {
			try { parsed = JSON.parse(text); } catch { parsed = undefined; }
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				// Never quoted: the text may hold a secret
				throw new CliPlanError(`${place} gives ${option} text that is not a JSON object`, 'configuration_invalid', { kind: 'run_settings_text', values: [place, option] });
			}
		} else {
			const file = path.resolve(cwd, text);
			let content: string;
			try {
				content = fs.readFileSync(file, 'utf8');
			} catch (err) {
				// The system's reason names the file alone
				throw new CliPlanError(`${place} gives ${option} ${JSON.stringify(text)}, which cannot be read as a JSON object: ${err instanceof Error ? err.message : String(err)}`, 'configuration_invalid',
					{ kind: 'run_settings_file', values: [place, option, JSON.stringify(text)] });
			}
			// A parser's reason quotes what the file holds, which may be a secret: none is given
			try { parsed = JSON.parse(content); } catch { parsed = undefined; }
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new CliPlanError(`${place} gives ${option} ${JSON.stringify(text)}, which holds no JSON object`, 'configuration_invalid', { kind: 'run_settings_file', values: [place, option, JSON.stringify(text)] });
			}
		}
		given.push({ place, settings: parsed as { readonly [key: string]: unknown } });
	}
	return { given, rest };
}

/**
 * `args` with the person's values of `adapter`'s list options among `configured` moved into Facade's own occurrence of each
 * (CONFIGURATION-3.1), so that the CLI takes both, whichever of two occurrences it would keep; where Facade gives none, theirs stay.
 */
function combineLists(adapter: CliAdapter, own: readonly string[], configured: readonly string[]): { readonly own: string[]; readonly configured: string[] } {
	let ours = [...own];
	let theirs = [...configured];
	for (const spellings of adapter.additive ?? []) {
		const at = ours.findIndex(arg => spellings.includes(arg));
		if (at < 0) {
			continue;
		}
		const moved: string[] = [];
		const kept: string[] = [];
		// Read as the CLI reads them, each argument once; a value that looks like an option, which it reads only right after the option,
		// stays where it is
		for (const unit of argumentUnits(theirs, adapter.grammar ?? { reserved: [] })) {
			if (unit.kind === 'option' && spellings.some(option => isOption(unit.option, option, adapter.grammar ?? { reserved: [] })) && (unit.form === 'apart' || unit.form === 'equals' || unit.form === 'none') && !unit.values.some(value => value.startsWith('-'))) {
				moved.push(...unit.values);
			} else {
				kept.push(...theirs.slice(unit.index, unit.index + unit.span));
			}
		}
		let end = at + 1;
		while (end < ours.length && !ours[end].startsWith('-')) {
			end++;
		}
		ours = [...ours.slice(0, end), ...moved, ...ours.slice(end)];
		theirs = kept;
	}
	return { own: ours, configured: theirs };
}

/**
 * The launch of `input.cli` in `input.cwd` (CLIS-1.2, 1.3, 3.2, 4.2): its program found with the environment the run starts with, its
 * adapter's literal invocation - its run options and the YOLO mapping - and the run's variables. It writes nothing: a trust kept in a
 * file of the CLI's is its `trust`, for the caller to write before the run starts (CLIS-3.3). Throws CliPlanError with the actual
 * reason.
 */
export function planLaunch(catalog: Catalog, input: PlanInput, destination: DestinationEnvironment): PlannedLaunch {
	// A settings file wrong as a whole stops every start, saying where (CONFIGURATION-4.1)
	if (catalog.problems.length) {
		throw new CliPlanError(catalog.problems.map(each => each.text).join('; '), 'configuration_invalid', catalog.problems[0].said);
	}
	const entry = entryOf(catalog, input.cli);
	if (!entry) {
		const ids = BUILT_IN_ADAPTERS.map(each => each.id);
		throw new CliPlanError(`No CLI ${JSON.stringify(input.cli)} is configured; the built-ins are ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}, and others are added in clis of ${catalog.file}`, 'not_found',
			{ kind: 'cli_not_configured', values: [JSON.stringify(input.cli), catalog.file] });
	}
	const { adapter } = entry;
	// What is wrong with its configuration is said first, a turned-off one's too, as New Agent lists it (CONFIGURATION-2.2, 4.1)
	const problems = configurationProblems(entry, destination);
	if (problems.length) {
		throw new CliPlanError(problems.map(each => each.text).join('; '), 'configuration_invalid', problems[0].said);
	}
	// A turned-off CLI is not newly started; its runs go on (CLIS-1.1, RULES-4.4)
	if (!entry.enabled) {
		throw turnedOffError(adapter);
	}
	const { platform } = destination;
	const env = environmentOf(entry, destination);
	const found = executableOf(entry, env, input.cwd, platform);
	if (found.problem !== undefined) {
		throw new CliPlanError(found.problem, 'not_found', found.said);
	}
	const target = targetOf(entry, found.executable, env, platform, input.cwd);
	// The installed version, as its installation names it: kept with the launch; a line of it Facade does not support is not started
	const builtIn = builtInOf(adapter.id, adapter.builtIn);
	const version = installedVersionOf(builtIn ?? adapter.id, found.executable)?.version;
	const refused = version === undefined ? undefined : adapter.refusesVersion?.(version);
	if (refused) {
		throw new CliPlanError(refused.problem, 'unsupported', refused.said);
	}
	// A conversation is resumed, and a pinned agent restored, with the CLI that ran it: an entry that runs another now cannot (CONFIGURATION-3.4)
	if (input.builtIn !== undefined && builtIn !== input.builtIn) {
		const was = BUILT_IN_ADAPTERS.find(each => each.id === input.builtIn)?.displayName ?? input.builtIn;
		const now = builtIn === undefined ? 'a program' : BUILT_IN_ADAPTERS.find(each => each.id === builtIn)?.displayName ?? builtIn;
		throw input.resume
			? new CliPlanError(`${entry.entry.setting} runs ${now} now, but this conversation is ${was}'s; it cannot be resumed with it`, 'unsupported',
				{ kind: 'resume_type_changed', values: [entry.entry.setting, was] })
			: new CliPlanError(`${entry.entry.setting} runs ${now} now, but this agent ran ${was}; it cannot be restored with it`, 'unsupported',
				{ kind: 'pin_type_changed', values: [entry.entry.setting, was] });
	}
	if (input.resume && (!input.resume.sessionId || input.resume.sessionId.includes('\0') || !adapter.groups.resume)) {
		throw new CliPlanError(`${adapter.displayName} cannot resume this exact conversation`, 'unsupported', { kind: 'resume_unsupported', values: [adapter.displayName] });
	}
	const sessionId = input.resume?.sessionId ?? (adapter.groups.session && input.sessionFile ? newSessionId() : undefined);
	const takes = takesThrough(adapter, target.throughCmd, input.cwd, platform);
	// This start's own choice, else its entry's (CONFIGURATION-3.3, CLIS-1.4); the CLI's own where neither names one
	const chosen = { model: input.model ?? entry.model, effort: input.effort ?? entry.effort };
	for (const asked of ['model', 'effort'] as const) {
		if (input[asked] === undefined && chosen[asked] !== undefined && !takes[asked]) {
			throw new CliPlanError(`${entry.entry.setting}.${asked} cannot be passed to ${adapter.displayName} where it runs through cmd.exe; leave it out here`, 'unsupported',
				{ kind: 'choice_through_cmd', values: [`${entry.entry.setting}.${asked}`, adapter.displayName] });
		}
		if (input[asked] !== undefined && !takes[asked]) {
			throw new CliPlanError(`${adapter.displayName} has no supported way to set ${asked === 'model' ? 'a model' : 'an effort'}${adapter.takes[asked] ? ' where it runs through cmd.exe' : ''}; omit ${asked} to use its own default`, 'unsupported');
		}
	}
	const prompt = input.prompt === undefined ? undefined : promptOf(adapter, input.prompt, target.throughCmd);
	const native = prompt?.path === 'native';
	// What the entry's `env` sets, as the launch has it, and what it removes: for a CLI's run settings to carry (CONFIGURATION-5.1)
	const layered = layeredEnvironmentOf(entry, destination);
	const entryEnv: EntryEnvironment = {
		set: Object.fromEntries(Object.entries(entry.environment).flatMap(([name, value]) => value === null ? [] : [[name, variableOf(layered, name, platform) ?? '']])),
		removed: Object.entries(entry.environment).flatMap(([name, value]) => value === null ? [name] : [])
	};
	const launchInput = {
		yolo: input.yolo, cwd: input.cwd, platform, model: chosen.model, effort: chosen.effort, env, sessionId, sessionHook: input.sessionHook,
		runDir: input.runDir ?? NO_RUN_DIR, entryEnv, setting: entry.entry.setting
	};
	let extra: { readonly index: number; readonly value: string }[] = entry.extra.map((value, index) => ({ index, value }));
	// The run's settings in a file of its own, the person's --settings merged into them (CONFIGURATION-3.1, 4.2): written once the
	// run's environment is whole
	let runSettings: { readonly file: string; readonly settings: { readonly [key: string]: unknown } } | undefined;
	const own: { [name: string]: string } = {};
	if (adapter.runSettings) {
		const theirs = theirRunSettings(adapter, extra, entry.extraSetting, input.cwd);
		extra = theirs.rest;
		const built = adapter.runSettings.build(launchInput, theirs.given);
		if ('problem' in built) {
			throw new CliPlanError(built.problem, 'configuration_invalid', built.said);
		}
		runSettings = { file: path.join(input.runDir ?? NO_RUN_DIR, adapter.runSettings.name), settings: built.settings };
		own.runSettings = runSettings.file;
	}
	const values = { ...adapter.values(launchInput), ...sessionId ? { sessionId } : {}, ...own };
	// What the CLI finds where it starts may leave no way to give it the tools that it would run with: it then starts without them
	const offered = input.tools ? adapter.tools?.inject({ ...input.tools, platform, throughCmd: target.throughCmd, cwd: input.cwd, env }) : undefined;
	let injection = offered && !('conflict' in offered) ? offered : undefined;
	let tools: PlannedLaunch['tools'] = offered && 'conflict' in offered
		? { state: 'unavailable', problem: 'conflict', file: offered.conflict.file, reason: offered.conflict.reason }
		: injection ? { state: 'injected' } : { state: 'not_injected' };
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
	const launchWith = (active: Injection | undefined, configured: readonly string[] = extra.map(each => each.value)) => {
		const started = { ...env };
		if (active) {
			for (const [name, value] of Object.entries(merged)) { setVariable(started, name, value, platform); }
		}
		const ownArgs = [...active?.args ?? [], ...invocation(adapter.groups, [], {
			yolo: input.yolo, resume: !!input.resume, session: !!sessionId,
			connect: active !== undefined, model: chosen.model !== undefined, effort: chosen.effort !== undefined, prompt: false
		}, { ...values, ...active?.values })];
		// The person's values of a list option Facade gives too go into Facade's occurrence (CONFIGURATION-3.1)
		const combined = combineLists(adapter, ownArgs, configured);
		const arguments_ = [...combined.own, ...combined.configured];
		// Compose native identity with the complete tool settings. A second --settings must not erase either integration.
		const integration = input.sessionFile && input.sessionHook ? adapter.sessionIntegration?.({
			file: input.sessionFile, hook: input.sessionHook, env: started, cwd: input.cwd, platform, extra: arguments_, tools: active !== undefined,
			instructions: active ? input.tools?.server.instructions : undefined, throughCmd: target.throughCmd, runDir: input.runDir ?? NO_RUN_DIR,
			...runSettings ? { runSettings: runSettings.settings } : {}
		}) : undefined;
		const args = [...target.args, ...integration?.extra ?? arguments_, ...integration?.args ?? [],
			...native ? expanded(adapter.groups.prompt!, { ...values, prompt: input.prompt! }) : []];
		return { args, started, integration };
	};
	let launch = launchWith(injection);
	if (target.throughCmd && injection && launch.args.some(unsafeForCmd) && !launchWith(undefined).args.some(unsafeForCmd)) {
		injection = undefined;
		tools = { state: 'unavailable', problem: 'cmd', reason: `${found.executable} runs through cmd.exe, which cannot be given the Facade tools' arguments safely; set ${adapter.setting}.command to the CLI's own program or Node entry point` };
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
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot run in the UNC folder ${input.cwd}; set ${adapter.setting}.command to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unc_folder', values: [found.executable, input.cwd, adapter.setting] });
		}
		// The program's own path reaches cmd.exe too, quoted only where it holds a space
		if (unsafeForCmd(target.executable)) {
			throw new CliPlanError(`${target.executable} runs through cmd.exe, which cannot be given its path safely; set ${adapter.setting}.command to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe_path', values: [target.executable, adapter.setting] });
		}
		const refused = (arg: string) => new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given the argument ${shown(arg)} safely; set ${adapter.setting}.command to the CLI's own program or Node entry point`, 'unsupported',
			{ kind: 'cmd_unsafe', values: [found.executable, shown(arg), adapter.setting] });
		// An argument of the adapter's own that cannot pass: no configured argument is to blame, nor would taking one out help
		const own = launchWith(injection, []).args.find(unsafeForCmd);
		if (own !== undefined) {
			throw refused(own);
		}
		// A configured argument is named by its place in the setting and its own character, never quoted: it may be a secret (CLIS-4.1)
		const configured = extra.find(each => unsafeForCmd(each.value));
		if (configured) {
			const setting = entry.extraSetting;
			const character = unsafeCharacterForCmd(configured.value)!;
			throw new CliPlanError(`${found.executable} runs through cmd.exe, which cannot be given ${setting}[${configured.index}] safely, as that argument contains ${character}; set ${adapter.setting}.command to the CLI's own program or Node entry point`, 'unsupported',
				{ kind: 'cmd_unsafe_setting', values: [found.executable, setting, String(configured.index), character, adapter.setting] });
		}
		const unsafe = args.find(unsafeForCmd);
		if (unsafe !== undefined) {
			throw refused(unsafe);
		}
	}
	// Each set as the platform names variables - on Windows in any case - so that one name, the run's, holds it
	const runEnv = runEnvironment(started, input.alias, platform);
	if (adapter.sessionIdentity && input.sessionFile) { setVariable(runEnv, SESSION_FILE_VARIABLE, input.sessionFile, platform); }
	for (const [name, value] of Object.entries(integration?.env ?? {})) { setVariable(runEnv, name, value, platform); }
	// What Facade gives the run after its entry's env (CONFIGURATION-3.2's last row), as the run has it: run settings whose variables
	// its CLI sets over its environment hold these too, whatever the entry or the person's own settings named
	const last: readonly FinalVariable[] = [
		...AGENT_TERMINAL_VARIABLES.map(each => each.name), RUN_VARIABLE,
		...adapter.sessionIdentity && input.sessionFile ? [SESSION_FILE_VARIABLE] : [],
		...injection ? Object.keys(merged) : [], ...Object.keys(integration?.env ?? {})
	].map(name => ({ name, value: variableOf(runEnv, name, platform) }));
	const runFiles: { readonly file: string; readonly content: string }[] = [];
	if (runSettings) {
		const given = integration?.runSettings ?? runSettings.settings;
		const finished = adapter.runSettings?.finish?.(given, { last, tools: injection !== undefined, env, platform }) ?? given;
		runFiles.push({ file: runSettings.file, content: `${JSON.stringify(finished, undefined, 2)}\n` });
	}
	const screenStatus = adapter.screenStatus?.(version);
	// The run's settings and what its integration merged are files of the run, removed when it ends (CLIS-2.2, CONFIGURATION-4.2)
	const files = [...integration?.files ?? [], ...runFiles];
	return {
		...files.length ? { files } : {},
		cli: adapter.id,
		...builtIn !== undefined ? { builtIn } : {},
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
		...screenStatus ? { screenStatus } : {},
		// Only for the tools: without them, nothing waits on its first turn
		...injection && adapter.warmUp ? { warmUp: adapter.warmUp } : {}
	};
}
