/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings of a built-in CLI, read strictly (CLIS-1.1, 1.2, 3.1): `enabled`, `path` and a `launch` of literal `arguments` and
// an `environment` map. Anything else - an unknown field, a value of the wrong kind - is a configuration error naming its setting
// path; it is never translated or replaced by a default, and the person's values are left for them to correct.

import { isJsonObject } from '../base/json';
import { truncateText } from '../base/text';
import type { EnvironmentMap } from './environment';

/** A CLI problem by its kind and values, for the person's language (UX-2.4); its English is said beside it. */
export interface CliSaid {
	readonly kind: string;
	readonly values: readonly string[];
}

/** One configuration problem: its English, as the agents log says it, and the same by kind and values for the person (UX-2.4). */
export interface CliProblem {
	readonly text: string;
	readonly said: CliSaid;
}

/** A built-in's settings as read: its values where valid, and what is wrong, each naming its setting. */
export interface CliSettings {
	/** Whether new starts are offered it (CLIS-1.1); its default where the setting is wrong, which is a problem of its own. */
	readonly enabled: boolean;
	/** The configured program, trimmed; empty for the CLI's command on PATH (CLIS-1.2). */
	readonly path: string;
	/** Literal options, in the order given, in the vendor's options position (CLIS-3.1, 3.2). */
	readonly arguments: readonly string[];
	readonly environment: EnvironmentMap;
	/** What is wrong, in the order the settings are read. */
	readonly problems: readonly CliProblem[];
}

/** A value as a problem quotes it: as JSON, cut short between whole code points. */
export function shown(value: unknown): string {
	return truncateText(JSON.stringify(value) ?? String(value), 60);
}

/**
 * A received launch value as a problem names it: by its JSON type alone, never the value, which may be a secret - a problem reaches
 * the log, the person and Show Agent Launch (CLIS-4.1, ARCHITECTURE-3.3).
 */
export function jsonType(value: unknown): string {
	return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** A variable's name as a problem quotes it: up to any `=`, after which a person may have put its value. */
function shownName(name: string): string {
	const at = name.indexOf('=');
	return JSON.stringify(at < 0 ? name : `${name.slice(0, at)}=…`);
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/** Whether `text` holds a character no path, argument or variable can carry to a process. */
function hasNul(text: string): boolean {
	return text.includes('\0');
}

/** A list of literal arguments at `setting`, else none - said in `problems`. */
export function argumentsOf(value: unknown, setting: string, problems: CliProblem[]): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		problems.push(problem(`${setting} must be an array of strings; received ${jsonType(value)}`, 'arguments_type', setting, jsonType(value)));
		return [];
	}
	const before = problems.length;
	value.forEach((arg: unknown, index) => {
		if (typeof arg !== 'string') {
			problems.push(problem(`${setting}[${index}] must be a string; received ${jsonType(arg)}`, 'argument_type', setting, String(index), jsonType(arg)));
		} else if (hasNul(arg)) {
			problems.push(problem(`${setting}[${index}] contains a NUL character, which no argument can carry`, 'argument_nul', setting, String(index)));
		}
	});
	return problems.length === before ? value as string[] : [];
}

/** An environment map at `setting`: names to a string or null (CLIS-1.2), else none - said in `problems`. */
export function environmentMapOf(value: unknown, setting: string, problems: CliProblem[]): EnvironmentMap {
	if (value === undefined) {
		return {};
	}
	if (!isJsonObject(value)) {
		problems.push(problem(`${setting} must be an object of variable names to strings or null; received ${jsonType(value)}`, 'environment_type', setting, jsonType(value)));
		return {};
	}
	const before = problems.length;
	for (const [name, each] of Object.entries(value)) {
		if (!name || name.includes('=') || hasNul(name)) {
			problems.push(problem(`${setting} has the variable name ${shownName(name)}, which no environment can hold`, 'environment_name', setting, shownName(name)));
		} else if (each !== null && typeof each !== 'string') {
			problems.push(problem(`${setting}.${name} must be a string or null; received ${jsonType(each)}`, 'environment_value', setting, name, jsonType(each)));
		} else if (typeof each === 'string' && hasNul(each)) {
			problems.push(problem(`${setting}.${name} contains a NUL character, which no variable can carry`, 'environment_nul', setting, name));
		}
	}
	return problems.length === before ? value as EnvironmentMap : {};
}

/**
 * A built-in's settings under `setting` (`facade.claude`), as `read` gives each of `enabled`, `path` and `launch` (CLIS-1.1, 1.2,
 * 3.1). A wrong value is a problem naming its path; Facade's default stands in only so the rest can be shown. A launch argument
 * that repeats one of `owned` - an option its adapter sets itself - is one too: the CLI would take the person's in Facade's place.
 */
export function readCliSettings(setting: string, read: (key: 'enabled' | 'path' | 'launch') => unknown, owned: readonly string[] = []): CliSettings {
	const problems: CliProblem[] = [];
	const enabled = read('enabled');
	if (enabled !== undefined && typeof enabled !== 'boolean') {
		problems.push(problem(`${setting}.enabled must be true or false; received ${jsonType(enabled)}`, 'enabled_type', setting, jsonType(enabled)));
	}
	const configured = read('path');
	if (configured !== undefined && typeof configured !== 'string') {
		problems.push(problem(`${setting}.path must be a string; received ${jsonType(configured)}`, 'path_type', setting, jsonType(configured)));
	} else if (typeof configured === 'string' && configured !== '' && !configured.trim()) {
		// Never PATH's command in its place: a path set is the program it names (CLIS-1.2)
		problems.push(problem(`${setting}.path contains only whitespace. Set the program's path, or leave it empty to find the CLI on PATH`, 'path_blank', setting));
	} else if (typeof configured === 'string' && hasNul(configured)) {
		problems.push(problem(`${setting}.path contains a NUL character, which no path can hold`, 'path_nul', setting));
	}
	const launch = read('launch');
	let args: readonly string[] = [];
	let environment: EnvironmentMap = {};
	if (launch !== undefined && !isJsonObject(launch)) {
		problems.push(problem(`${setting}.launch must be an object with arguments and environment; received ${jsonType(launch)}`, 'launch_type', setting, jsonType(launch)));
	} else if (launch !== undefined) {
		// A field of no launch setting - one an earlier build had, or a misspelling - is said, never ignored (CLIS-3.1)
		for (const field of Object.keys(launch)) {
			if (field !== 'arguments' && field !== 'environment') {
				problems.push(problem(`${setting}.launch.${field} is not a launch setting; launch accepts only arguments and environment`, 'launch_field', setting, field));
			}
		}
		args = argumentsOf(launch.arguments, `${setting}.launch.arguments`, problems);
		environment = environmentMapOf(launch.environment, `${setting}.launch.environment`, problems);
		const clashes = args.flatMap((arg, index) => {
			const option = owned.find(each => arg === each || arg.startsWith(`${each}=`));
			return option === undefined ? [] : [problem(`${setting}.launch.arguments[${index}] is ${option}, which Facade sets itself; remove it`, 'launch_owned', `${setting}.launch.arguments`, String(index), option)];
		});
		if (clashes.length) {
			problems.push(...clashes);
			args = [];
		}
	}
	return {
		enabled: typeof enabled === 'boolean' ? enabled : true,
		path: typeof configured === 'string' ? configured.trim() : '',
		arguments: args,
		environment,
		problems
	};
}
