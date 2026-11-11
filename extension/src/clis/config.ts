/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How a configuration problem is said (CONFIGURATION-4.1, UX-2.4): its English, and the same by kind and values for the person's
// language; and the readers of the values every entry shares - a list of literal arguments and an environment map - read strictly. A
// value of the wrong kind is a problem naming its setting path, never its value, which may be a secret; it is never replaced by a
// default, and the person's values are left for them to correct.

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
			problems.push(problem(`${setting}[${index}] contains a NUL character, which is not permitted in arguments`, 'argument_nul', setting, String(index)));
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
			problems.push(problem(`${setting} contains invalid environment variable name ${shownName(name)}`, 'environment_name', setting, shownName(name)));
		} else if (each !== null && typeof each !== 'string') {
			problems.push(problem(`${setting}.${name} must be a string or null; received ${jsonType(each)}`, 'environment_value', setting, name, jsonType(each)));
		} else if (typeof each === 'string' && hasNul(each)) {
			problems.push(problem(`${setting}.${name} contains a NUL character, which is not permitted in environment variables`, 'environment_nul', setting, name));
		}
	}
	return problems.length === before ? value as EnvironmentMap : {};
}
