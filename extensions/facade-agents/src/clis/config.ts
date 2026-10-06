/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject, isStringArray, JsonObject } from '../base/json';
import { AgentCli, ARG_GROUPS, ArgGroup, CliConfig, LaunchConfig, TrustConfig } from './cli';

/** The longest a launch waits before typing a CLI its task, or between a line and its Enter: a minute. */
export const MAX_DELAY_MS = 60_000;
/** The longest time, in seconds, the person can give Facade's waits: a day. */
export const MAX_TIME_S = 86_400;

/**
 * A time the person set, in seconds, as milliseconds: kept between one second and {@link MAX_TIME_S}, and
 * `fallbackMs` where the setting holds no number.
 */
export function secondsSetting(value: unknown, fallbackMs: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 1), MAX_TIME_S) * 1000 : fallbackMs;
}

/**
 * How the person has Facade start `cli`: its `path`, and its launch as the CLI's defaults with the person's
 * `launch` over them. `read` gives a setting by its name under `facade.orchestration.<section>.`, as the window
 * has it; the person's `launch` holds only what they change.
 */
export function readCliConfig(cli: AgentCli, read: (name: string) => unknown): CliConfig {
	const path = read('path');
	const launch = read('launch');
	return {
		path: typeof path === 'string' ? path.trim() : cli.defaults.path,
		launch: launchOf(cli.defaults.launch, isJsonObject(launch) ? launch : {})
	};
}

/** Why a CLI this machine does not have, as `config` has it found, is not there: its path setting names nothing, or its command is not on PATH. */
export function whyNotInstalled(cli: AgentCli, config: CliConfig): string {
	return config.path
		? `facade.orchestration.${cli.section}.path is ${JSON.stringify(config.path)}, which is no file, nor a command on this machine's PATH`
		: `${cli.command} is not on this machine's PATH, and facade.orchestration.${cli.section}.path names no other`;
}

/**
 * A launch as the person changed `defaults` with `set`: a part they set replaces the default's, an
 * object - the environment, Claude Code's settings - key by key, and null takes one out; what is not of
 * its part's kind is left out, the default kept.
 */
function launchOf(defaults: LaunchConfig, set: JsonObject): LaunchConfig {
	const trust = trustOf(defaults.trust, set.trust);
	return {
		arguments: argumentsOf(defaults.arguments, set.arguments),
		environment: variablesOf(defaults.environment, set.environment),
		...(trust ? { trust } : {}),
		...(defaults.settings ? { settings: mergedObject(defaults.settings, set.settings) } : {}),
		enterDelay: millisecondsIn(set.enterDelay) ?? defaults.enterDelay,
		taskDelay: millisecondsIn(set.taskDelay) ?? defaults.taskDelay
	};
}

/** The groups of arguments: each one the person set to a list of strings theirs, one set to null none; the rest the defaults'. */
function argumentsOf(defaults: LaunchConfig['arguments'], set: unknown): LaunchConfig['arguments'] {
	const own = isJsonObject(set) ? set : {};
	const groups: { [Group in ArgGroup]?: readonly string[] } = {};
	for (const group of ARG_GROUPS) {
		const value = own[group];
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
function variablesOf(defaults: { readonly [name: string]: string }, set: unknown): { readonly [name: string]: string } {
	const variables: { [name: string]: string } = { ...defaults };
	const keyOf = (name: string) => process.platform === 'win32' ? Object.keys(variables).find(key => key.toUpperCase() === name.toUpperCase()) ?? name : name;
	for (const [name, value] of Object.entries(isJsonObject(set) ? set : {})) {
		if (value === null) {
			delete variables[keyOf(name)];
		} else if (typeof value === 'string') {
			variables[keyOf(name)] = value;
		}
	}
	return variables;
}

/**
 * The trust: none where the person set it to null; their arguments where they set some; else the
 * default's file and entry, each replaced by the person's where they set one; else the default.
 */
function trustOf(defaults: TrustConfig | undefined, set: unknown): TrustConfig | undefined {
	if (set === null) {
		return undefined;
	}
	if (!isJsonObject(set)) {
		return defaults;
	}
	if (isStringArray(set.arguments)) {
		return { arguments: set.arguments };
	}
	const file = typeof set.file === 'string' && set.file.trim() ? set.file.trim() : defaults?.file;
	const merge = isJsonObject(set.merge) ? set.merge : defaults?.merge;
	return file !== undefined && merge !== undefined ? { file, merge } : defaults;
}

/**
 * `defaults` with `set` over it, key by key down through objects: a key set to null taken out, any other
 * value replacing the default's. An object of the person's where the default has none is gone through
 * too, so that no null of theirs reaches the CLI as a value.
 */
function mergedObject(defaults: JsonObject, set: unknown): JsonObject {
	if (!isJsonObject(set)) {
		return defaults;
	}
	const merged: { [key: string]: unknown } = { ...defaults };
	for (const [key, value] of Object.entries(set)) {
		const byDefault = merged[key];
		if (value === null) {
			delete merged[key];
		} else {
			merged[key] = isJsonObject(value) ? mergedObject(isJsonObject(byDefault) ? byDefault : {}, value) : value;
		}
	}
	return merged;
}

/** A number of milliseconds, zero or more, kept to {@link MAX_DELAY_MS}; undefined for anything else. */
function millisecondsIn(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_DELAY_MS) : undefined;
}
