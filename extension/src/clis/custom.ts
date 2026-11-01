/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Custom CLIs (CLIS-3.4): `facade.custom` maps a key to `{ path, launch: { start, resume, environment } }`. The key is the CLI's API
// ID, distinct from agent names, and never shadows a built-in's. A definition without an exact-session Resume command containing
// `${sessionId}` is a configuration error. Nothing is invented for it: no YOLO mapping, model, effort or prompt, and no capability is
// configured - an unproved one stays unavailable.

import { isJsonObject } from '../base/json';
import type { CliAdapter } from './adapter';
import { argumentsOf, CliProblem, environmentMapOf, jsonType } from './config';
import type { EnvironmentMap } from './environment';

/** The setting that holds the custom CLIs. */
export const CUSTOM_SETTING = 'facade.custom';

/** The placeholder a custom Resume command carries, the only one a custom argument has (CLIS-3.4). */
export const SESSION_PLACEHOLDER = '${sessionId}';

/** A definition as the settings document shows one, for a problem that says what a custom CLI looks like. */
const EXAMPLE = `{ "path": "my-cli", "launch": { "resume": ["resume", "${SESSION_PLACEHOLDER}"] } }`;

/** A custom CLI's definition as read: its values where valid, and what is wrong, each naming its setting. */
export interface CustomCliSettings {
	readonly key: string;
	/** `facade.custom.<key>`. */
	readonly setting: string;
	/** The program, trimmed (CLIS-1.2). */
	readonly path: string;
	/** The arguments of a new conversation, as configured. */
	readonly start: readonly string[];
	/** The arguments that resume an exact conversation, `${sessionId}` among them. */
	readonly resume: readonly string[];
	readonly environment: EnvironmentMap;
	readonly problems: readonly CliProblem[];
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/**
 * The placeholders of `args`, the arguments at `setting` (CLIS-3.4): `${sessionId}`, and only in Resume, is the one there is - any
 * other is said by its place alone, never quoted, as an argument may hold a secret; so is a session ID a new conversation cannot have.
 */
function placeholderProblems(args: readonly string[], setting: string, resume: boolean): CliProblem[] {
	for (const [index, arg] of args.entries()) {
		if ([...arg.matchAll(/\$\{[^}]*\}/g)].some(match => match[0] !== SESSION_PLACEHOLDER)) {
			return [problem(`${setting}[${index}] uses an unsupported placeholder; ${SESSION_PLACEHOLDER} in resume is the only placeholder a custom CLI's arguments can contain`, 'custom_placeholder', setting, String(index), SESSION_PLACEHOLDER)];
		}
		if (!resume && arg.includes(SESSION_PLACEHOLDER)) {
			return [problem(`${setting}[${index}] uses ${SESSION_PLACEHOLDER}, which only resume can contain: a new conversation has no session ID yet`, 'custom_start_session', setting, String(index), SESSION_PLACEHOLDER)];
		}
	}
	return [];
}

/**
 * Why the key `key` cannot be a custom CLI's ID, beside the built-ins' API IDs `builtIns` (CLIS-3.4); none where it can. An ID names
 * the CLI in every list, so it has a visible character and no control character, and it never shadows a built-in's.
 */
function keyProblem(key: string, builtIns: readonly string[]): CliProblem | undefined {
	const setting = `${CUSTOM_SETTING}.${key}`;
	if (!/[^\s\p{Cf}]/u.test(key) || /\p{Cc}/u.test(key)) {
		return problem(`${CUSTOM_SETTING}: ${JSON.stringify(key)} cannot be a CLI's ID, which must have a visible character and no control character; choose another ID for the custom CLI`, 'custom_key', CUSTOM_SETTING, JSON.stringify(key));
	}
	if (builtIns.includes(key)) {
		return problem(`${setting}: ${JSON.stringify(key)} is the ID of a built-in CLI; choose another ID for the custom CLI`, 'custom_builtin', setting, JSON.stringify(key));
	}
	return undefined;
}

/** The custom definition `value` of the ID `key` (CLIS-3.4). */
function customCliOf(key: string, value: unknown): CustomCliSettings {
	const setting = `${CUSTOM_SETTING}.${key}`;
	const problems: CliProblem[] = [];
	if (!isJsonObject(value)) {
		problems.push(problem(`${setting} must be an object such as ${EXAMPLE}; received ${jsonType(value)}`, 'custom_entry_type', setting, jsonType(value), EXAMPLE));
	}
	const entry = isJsonObject(value) ? value : {};
	for (const field of Object.keys(entry)) {
		if (field === 'capabilities') {
			// What a CLI can do is what its shipped adapter proves, never what a setting claims (CLIS-2.1, 3.4)
			problems.push(problem(`${setting}.capabilities is not a custom CLI setting: capabilities are what a shipped adapter proves, never configured. Remove it`, 'custom_capabilities', setting));
		} else if (field !== 'path' && field !== 'launch') {
			problems.push(problem(`${setting}.${field} is not a custom CLI setting; a custom CLI accepts only path and launch`, 'custom_field', setting, field));
		}
	}
	const configured = entry.path;
	if (configured === undefined) {
		if (isJsonObject(value)) {
			problems.push(problem(`${setting}.path is missing; set it to the program to run`, 'custom_path_missing', setting));
		}
	} else if (typeof configured !== 'string') {
		problems.push(problem(`${setting}.path must be a string; received ${jsonType(configured)}`, 'path_type', setting, jsonType(configured)));
	} else if (!configured.trim()) {
		problems.push(problem(`${setting}.path is empty or contains only whitespace; set it to the program to run`, 'custom_path_empty', setting));
	} else if (configured.includes('\0')) {
		problems.push(problem(`${setting}.path contains a NUL character, which no path can hold`, 'path_nul', setting));
	}
	if (entry.launch !== undefined && !isJsonObject(entry.launch)) {
		problems.push(problem(`${setting}.launch must be an object with start, resume and environment; received ${jsonType(entry.launch)}`, 'custom_launch_type', setting, jsonType(entry.launch)));
	}
	const launch = isJsonObject(entry.launch) ? entry.launch : {};
	for (const field of Object.keys(launch)) {
		if (field !== 'start' && field !== 'resume' && field !== 'environment') {
			problems.push(problem(`${setting}.launch.${field} is not a custom launch setting; a custom launch accepts only start, resume and environment`, 'custom_launch_field', setting, field));
		}
	}
	const start = argumentsOf(launch.start, `${setting}.launch.start`, problems);
	const resume = argumentsOf(launch.resume, `${setting}.launch.resume`, problems);
	// Required, and never an interactive-only definition in its place (CLIS-3.4)
	if (isJsonObject(value) && (entry.launch === undefined || isJsonObject(entry.launch)) && (launch.resume === undefined || (Array.isArray(launch.resume) && !launch.resume.length))) {
		problems.push(problem(`${setting}.launch.resume is required: the arguments that resume an exact conversation, containing ${SESSION_PLACEHOLDER}`, 'custom_resume_missing', setting, SESSION_PLACEHOLDER));
	} else if (resume.length && !resume.some(arg => arg.includes(SESSION_PLACEHOLDER))) {
		problems.push(problem(`${setting}.launch.resume must contain ${SESSION_PLACEHOLDER}, the exact session ID it resumes`, 'custom_resume_placeholder', setting, SESSION_PLACEHOLDER));
	}
	problems.push(...placeholderProblems(start, `${setting}.launch.start`, false), ...placeholderProblems(resume, `${setting}.launch.resume`, true));
	const environment = environmentMapOf(launch.environment, `${setting}.launch.environment`, problems);
	return { key, setting, path: typeof configured === 'string' ? configured.trim() : '', start, resume, environment, problems };
}

/**
 * The custom CLIs of `value`, the setting's object, in configuration order, beside the built-ins' API IDs `builtIns`; and what no
 * custom CLI stands for (CLIS-3.4): the setting itself wrong, which then defines none, or a key that cannot be an ID, which defines
 * no CLI of that ID - so that a built-in's is never doubled.
 */
export function readCustomClis(value: unknown, builtIns: readonly string[]): { readonly clis: readonly CustomCliSettings[]; readonly problems: readonly CliProblem[] } {
	if (value === undefined) {
		return { clis: [], problems: [] };
	}
	if (!isJsonObject(value)) {
		return { clis: [], problems: [problem(`${CUSTOM_SETTING} must be an object of custom CLIs by ID; received ${jsonType(value)}`, 'custom_type', CUSTOM_SETTING, jsonType(value))] };
	}
	const keys = Object.keys(value);
	const problems = keys.map(key => keyProblem(key, builtIns)).filter((each): each is CliProblem => each !== undefined);
	return { clis: keys.filter(key => !keyProblem(key, builtIns)).map(key => customCliOf(key, value[key])), problems };
}

/**
 * The adapter of a custom CLI (CLIS-3.4): its `start` arguments as configured, and nothing of Facade's - no YOLO mapping, no
 * trust given, no status read from its screen. Its sandbox and approvals are its own configuration's, which Facade does not read.
 * Its runs' titles and exits are read by the name and ID each run keeps (`clis/activity.ts`), so that one outlives its definition:
 * `title` and `interruptExit` say the same for the interface.
 */
export function customAdapterOf(settings: CustomCliSettings): CliAdapter {
	return {
		id: settings.key,
		displayName: settings.key,
		setting: settings.setting,
		command: settings.path,
		groups: {},
		takes: { model: false, effort: false },
		values: () => ({}),
		sandbox: () => ({ state: 'unknown' }),
		approvals: () => ({ state: 'unknown' }),
		interruptExit: () => false
	};
}
