/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject, isStringArray, JsonObject, mergedObject } from '../base/json';
import { AgentCli, ARG_GROUPS, ArgGroup, CliConfig, LaunchConfig, TrustConfig, UnattendedLaunch } from './cli';

/** The longest a launch waits before typing a CLI its task, or between a line and its Enter: a minute. */
export const MAX_DELAY_MS = 60_000;
/** The longest time, in seconds, the person can give Facade's waits: an hour (AGENT-LAUNCHER.md, L7). */
export const MAX_TIME_S = 3_600;

/**
 * A time the person set as `setting`, in whole seconds from one to {@link MAX_TIME_S}, as milliseconds; where
 * they set none, `fallbackMs`. Any other value is not made into one - not rounded, not brought into range -
 * but `fallbackMs` is used, and `wrong` says so, naming the setting (AGENT-LAUNCHER.md, L5; X-59).
 */
export function readSeconds(setting: string, value: unknown, fallbackMs: number): { readonly ms: number; readonly wrong?: string } {
	if (value === undefined) {
		return { ms: fallbackMs };
	}
	if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIME_S) {
		return { ms: value * 1000 };
	}
	return { ms: fallbackMs, wrong: `${setting} is ${shown(value)}, which is no whole number of seconds from 1 to ${MAX_TIME_S}: ${fallbackMs / 1000} s, its default, is used` };
}

/**
 * How the person has Facade start `cli`: whether it is offered, its `path`, and its launch as the CLI's
 * defaults with the person's `launch` over them. `read` gives a setting by its name under `cli.setting`,
 * as the window has it; the person's `launch` holds only what they change. A value of the wrong kind, or
 * a key a launch does not have, is in `wrong`, naming the setting: Facade never falls back to its own
 * value for a setting the person got wrong.
 */
export function readCliConfig(cli: AgentCli, read: (name: string) => unknown): CliConfig {
	const section = cli.setting;
	const wrong: string[] = [];
	const enabled = read('enabled');
	if (enabled !== undefined && typeof enabled !== 'boolean') {
		wrong.push(`${section}.enabled is ${shown(enabled)}, which is neither true nor false`);
	}
	const path = read('path');
	if (path !== undefined && typeof path !== 'string') {
		wrong.push(`${section}.path is ${shown(path)}, which is no text`);
	} else if (typeof path === 'string' && path !== '' && !path.trim()) {
		// Not PATH's in its place: a path set is the file it names (X-59)
		wrong.push(`${section}.path is ${shown(path)}, only spaces, which name no file: give the file, or leave it empty for the ${cli.command} PATH finds`);
	}
	const launch = read('launch');
	if (launch !== undefined && !isJsonObject(launch)) {
		wrong.push(`${section}.launch is ${shown(launch)}, which is no object`);
	}
	return {
		path: typeof path === 'string' ? path.trim() : cli.defaults.path,
		enabled: typeof enabled === 'boolean' ? enabled : cli.defaults.enabled,
		launch: launchOf(cli, isJsonObject(launch) ? launch : {}, `${section}.launch`, wrong),
		...(wrong.length ? { wrong } : {})
	};
}

/**
 * Why a CLI this machine does not have, as `config` has it found, is not there: its path setting names
 * nothing, or its command is not on PATH; with what is wrong in its settings first.
 */
export function whyNotInstalled(cli: AgentCli, config: CliConfig, onPath = 'this machine\'s PATH'): string {
	return [
		...config.wrong ?? [],
		cli.custom
			? `${cli.setting}.path is ${JSON.stringify(config.path)}, which is no file, nor a command on ${onPath}`
			: config.path
				? `${cli.setting}.path is ${JSON.stringify(config.path)}, which is no file, nor a command on ${onPath}`
				: `${cli.command} is not on ${onPath}, and ${cli.setting}.path names no other`
	].join('; ');
}

/** The groups of arguments `cli`'s launch has: a CLI told of its task in its terminal has no task group. */
export function argumentGroupsOf(cli: AgentCli): readonly ArgGroup[] {
	return ARG_GROUPS.filter(group => group !== 'task' || cli.task !== 'terminal');
}

/** A value of the person's as a message shows it: as JSON, cut short. */
export function shown(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * `cli`'s launch as the person changed its defaults with `set`, the setting `setting`: a part they set
 * replaces the default's, an object - the environment, Claude Code's settings - key by key, and null takes
 * one out; its unattended part the same way, part by part (`unattendedOf`). What is wrong goes into `wrong`,
 * the default's part shown in its place.
 */
export function launchOf(cli: AgentCli, set: JsonObject, setting: string, wrong: string[]): LaunchConfig {
	const defaults = cli.defaults.launch;
	const parts = ['arguments', 'environment', 'trust', ...defaults.settings ? ['settings'] : [], 'enterDelay', 'taskDelay', 'unattended'];
	for (const key of Object.keys(set)) {
		if (!parts.includes(key)) {
			wrong.push(`${setting} has ${key}, which ${cli.displayName}'s launch does not have: it has ${parts.join(', ')}`);
		}
	}
	// Part by part, in the order the person reads them.
	const args = argumentsOf(cli, set.arguments, `${setting}.arguments`, wrong);
	const environment = variablesOf(defaults.environment, set.environment, `${setting}.environment`, wrong);
	const trust = trustOf(defaults.trust, set.trust, `${setting}.trust`, wrong);
	return {
		arguments: args,
		environment,
		...(trust ? { trust } : {}),
		...(defaults.settings ? { settings: settingsOf(defaults.settings, set.settings, `${setting}.settings`, wrong) } : {}),
		enterDelay: delayOf(defaults.enterDelay, set.enterDelay, `${setting}.enterDelay`, wrong),
		taskDelay: delayOf(defaults.taskDelay, set.taskDelay, `${setting}.taskDelay`, wrong),
		...(defaults.unattended || set.unattended !== undefined ? { unattended: unattendedOf(cli, set.unattended, `${setting}.unattended`, wrong) } : {})
	};
}

/**
 * The launch's unattended part, for an agent started through `start_agent` (L4): Facade's with the person's `set`
 * over it - a group of arguments they set theirs, one set to null empty, which takes the launch's group out; a
 * variable, or a setting, they set theirs, one set to null kept so, which takes the launch's out.
 */
function unattendedOf(cli: AgentCli, set: unknown, setting: string, wrong: string[]): UnattendedLaunch {
	const defaults = cli.defaults.launch.unattended;
	if (set !== undefined && !isJsonObject(set)) {
		wrong.push(`${setting} is ${shown(set)}, which is no object`);
	}
	const own = isJsonObject(set) ? set : {};
	const parts = ['arguments', 'environment', ...cli.defaults.launch.settings ? ['settings'] : []];
	for (const key of Object.keys(own)) {
		if (!parts.includes(key)) {
			wrong.push(`${setting} has ${key}, which its unattended launch does not have: it has ${parts.join(', ')}`);
		}
	}
	const known = argumentGroupsOf(cli);
	const groups: { [Group in ArgGroup]?: readonly string[] } = { ...defaults?.arguments };
	for (const [group, value] of Object.entries(objectOf(own.arguments, `${setting}.arguments`, wrong))) {
		if (!(known as readonly string[]).includes(group)) {
			wrong.push(`${setting}.arguments has ${group}, which is no group of ${cli.displayName}'s arguments: it has ${known.join(', ')}`);
		} else if (value === null || isStringArray(value)) {
			groups[group as ArgGroup] = value ?? [];
		} else {
			wrong.push(`${setting}.arguments.${group} is ${shown(value)}, which is neither a list of text nor null`);
		}
	}
	const environment: { [name: string]: string | null } = { ...defaults?.environment };
	for (const [name, value] of Object.entries(objectOf(own.environment, `${setting}.environment`, wrong))) {
		if (value === null || typeof value === 'string') {
			environment[variableKey(environment, name)] = value;
		} else {
			wrong.push(`${setting}.environment.${name} is ${shown(value)}, which is neither text nor null`);
		}
	}
	const settings = isJsonObject(own.settings) ? overlaid(defaults?.settings ?? {}, own.settings) : defaults?.settings;
	objectOf(own.settings, `${setting}.settings`, wrong);
	return { arguments: groups, environment, ...(settings ? { settings } : {}) };
}

/** `value`, a part of the person's that is an object, where they set one: none where they did not, and where it is no object - said in `wrong`. */
function objectOf(value: unknown, setting: string, wrong: string[]): JsonObject {
	if (value !== undefined && !isJsonObject(value)) {
		wrong.push(`${setting} is ${shown(value)}, which is no object`);
	}
	return isJsonObject(value) ? value : {};
}

/** `defaults` with `set` over it, key by key down through objects, a null kept: it takes the launch's key out (`launchFor`). */
function overlaid(defaults: JsonObject, set: JsonObject): JsonObject {
	const merged: { [key: string]: unknown } = { ...defaults };
	for (const [key, value] of Object.entries(set)) {
		const byDefault = merged[key];
		merged[key] = isJsonObject(value) && isJsonObject(byDefault) ? overlaid(byDefault, value) : value;
	}
	return merged;
}

/** The groups of arguments: each one the person set to a list of strings theirs, one set to null none; the rest the defaults'. */
function argumentsOf(cli: AgentCli, set: unknown, setting: string, wrong: string[]): LaunchConfig['arguments'] {
	const defaults = cli.defaults.launch.arguments;
	const known = argumentGroupsOf(cli);
	if (set !== undefined && !isJsonObject(set)) {
		wrong.push(`${setting} is ${shown(set)}, which is no object`);
	}
	const own = isJsonObject(set) ? set : {};
	for (const key of Object.keys(own)) {
		if (!(known as readonly string[]).includes(key)) {
			wrong.push(`${setting} has ${key}, which is no group of ${cli.displayName}'s arguments: it has ${known.join(', ')}`);
		}
	}
	const groups: { [Group in ArgGroup]?: readonly string[] } = {};
	for (const group of known) {
		const value = own[group];
		if (value !== undefined && value !== null && !isStringArray(value)) {
			wrong.push(`${setting}.${group} is ${shown(value)}, which is neither a list of text nor null`);
		}
		const args = value === null ? undefined : isStringArray(value) ? value : defaults[group];
		if (args) {
			groups[group] = args;
		}
	}
	return groups;
}

/**
 * The variables: the defaults', each one the person set to text theirs, one set to null taken out. On
 * Windows, which takes a variable's name in any case, the person's is the default's whatever its case.
 */
function variablesOf(defaults: { readonly [name: string]: string }, set: unknown, setting: string, wrong: string[]): { readonly [name: string]: string } {
	if (set !== undefined && !isJsonObject(set)) {
		wrong.push(`${setting} is ${shown(set)}, which is no object`);
	}
	const variables: { [name: string]: string } = { ...defaults };
	for (const [name, value] of Object.entries(isJsonObject(set) ? set : {})) {
		if (value === null) {
			delete variables[variableKey(variables, name)];
		} else if (typeof value === 'string') {
			variables[variableKey(variables, name)] = value;
		} else {
			wrong.push(`${setting}.${name} is ${shown(value)}, which is neither text nor null`);
		}
	}
	return variables;
}

/** The name `variables` has for the variable `name`: on Windows, which takes a name in any case, theirs whatever its case. */
function variableKey(variables: { readonly [name: string]: unknown }, name: string): string {
	return process.platform === 'win32' ? Object.keys(variables).find(key => key.toUpperCase() === name.toUpperCase()) ?? name : name;
}

/**
 * The trust: none where the person set it to null; their arguments where they set some; else the
 * default's file and entry, each replaced by the person's where they set one.
 */
function trustOf(defaults: TrustConfig | undefined, set: unknown, setting: string, wrong: string[]): TrustConfig | undefined {
	if (set === null) {
		return undefined;
	}
	if (set === undefined) {
		return defaults;
	}
	if (!isJsonObject(set)) {
		wrong.push(`${setting} is ${shown(set)}, which is neither an object nor null`);
		return defaults;
	}
	const before = wrong.length;
	for (const key of Object.keys(set)) {
		if (key !== 'arguments' && key !== 'file' && key !== 'merge') {
			wrong.push(`${setting} has ${key}, which a trust does not have: it has arguments, or a file and what to merge into it`);
		}
	}
	const { arguments: args } = set;
	if (args !== undefined) {
		if (!isStringArray(args)) {
			wrong.push(`${setting}.arguments is ${shown(args)}, which is no list of text`);
			return defaults;
		}
		if (set.file !== undefined || set.merge !== undefined) {
			wrong.push(`${setting} has arguments and a file: a trust is given one way or the other`);
			return defaults;
		}
		return wrong.length === before ? { arguments: args } : defaults;
	}
	if (set.file !== undefined && !(typeof set.file === 'string' && set.file.trim())) {
		wrong.push(`${setting}.file is ${shown(set.file)}, which names no file`);
	}
	if (set.merge !== undefined && !isJsonObject(set.merge)) {
		wrong.push(`${setting}.merge is ${shown(set.merge)}, which is no object`);
	}
	const file = typeof set.file === 'string' && set.file.trim() ? set.file.trim() : defaults?.file;
	const merge = isJsonObject(set.merge) ? set.merge : defaults?.merge;
	if (wrong.length === before && (file === undefined || merge === undefined)) {
		wrong.push(`${setting} has ${file === undefined ? 'what to merge, and no file to merge it into' : 'a file, and nothing to merge into it'}`);
	}
	return wrong.length === before && file !== undefined && merge !== undefined ? { file, merge } : defaults;
}

/** Claude Code's settings: the defaults with the person's over them, key by key. */
function settingsOf(defaults: JsonObject, set: unknown, setting: string, wrong: string[]): JsonObject {
	if (set !== undefined && !isJsonObject(set)) {
		wrong.push(`${setting} is ${shown(set)}, which is no object`);
	}
	return mergedObject(defaults, set);
}

/** A delay the person set, in whole milliseconds from 0 to {@link MAX_DELAY_MS}; the default's where they set none. */
function delayOf(byDefault: number, set: unknown, setting: string, wrong: string[]): number {
	if (set === undefined) {
		return byDefault;
	}
	if (typeof set !== 'number' || !Number.isInteger(set) || set < 0 || set > MAX_DELAY_MS) {
		wrong.push(`${setting} is ${shown(set)}, which is no whole number of milliseconds from 0 to ${MAX_DELAY_MS}`);
		return byDefault;
	}
	return set;
}
