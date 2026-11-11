/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLIs of the settings file (CONFIGURATION-2.1, 2.2): `clis` maps a name to an entry of `type`, `command`, `args`, `env`, `model`,
// `effort`, `enabled` and `icon`. A built-in's name configures that built-in; any other name adds a CLI, of a built-in's type or `custom`.
// Each entry is read on its own and stands alone - an added `codex` takes nothing from the `codex` entry - so that a mistake in one
// leaves it alone unavailable, said by its setting path and never its value, and every other entry usable.

import { isJsonObject } from '../base/json';
import { PROGRAM_ICON, ROBOT_ICONS } from '../base/robot';
import { ArgsGrammar, argsProblems } from './args';
import { argumentsOf, CliProblem, environmentMapOf, jsonType } from './config';
import type { EnvironmentMap } from './environment';
import type { ClisMember } from './settingsFile';

/** An entry's fields (CONFIGURATION-2.2). */
const ENTRY_FIELDS: readonly string[] = ['type', 'icon', 'command', 'args', 'env', 'model', 'effort', 'enabled'];

/** The type of a program, which Facade starts in a terminal and gives nothing of its own (CONFIGURATION-2.3). */
export const PROGRAM_TYPE = 'custom';

/** What an entry needs to know of a built-in: its ID, its name, its program, what it takes and what its `args` cannot hold. */
export interface BuiltInFacts {
	readonly id: string;
	readonly displayName: string;
	/** Its program's name, run from the PATH where its entry gives no `command`. */
	readonly command: string;
	readonly takes: { readonly model: boolean; readonly effort: boolean };
	readonly grammar?: ArgsGrammar;
}

/** An entry as read (CONFIGURATION-2.2, 4.1): its values where valid, and what is wrong, each naming its setting path. */
export interface EntrySettings {
	/** Its name: the CLI's ID and display name wherever CLIs are listed (CONFIGURATION-2.1). */
	readonly name: string;
	/** Its setting path, as a problem names it: `clis.codex`, or `clis["Codex · work"]`. */
	readonly setting: string;
	/** Whether it is a built-in's own entry, by the built-in's name. */
	readonly builtIn: boolean;
	/** Its type: a built-in's ID, or `custom`; none where its own is missing or unknown, which is a problem of its own. */
	readonly type?: string;
	/** Its program as written; empty for its type's command on PATH. */
	readonly command: string;
	readonly args: readonly string[];
	readonly env: EnvironmentMap;
	readonly model?: string;
	readonly effort?: string;
	readonly enabled: boolean;
	/** What it shows in the panel, New Agent and its terminal tab (CONFIGURATION-2.4): its own `icon`, else its type's. */
	readonly icon: string;
	readonly problems: readonly CliProblem[];
}

/** The icons an entry can show (CONFIGURATION-2.4): each built-in's own, by its ID, then Facade's robots. */
export function iconsOf(builtIns: readonly BuiltInFacts[]): readonly string[] {
	return [...builtIns.map(each => each.id), ...ROBOT_ICONS];
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/** The setting path of the entry `name`: `clis.codex`, or `clis["Codex · work"]` for a name that is no plain word. */
export function entrySetting(name: string): string {
	return /^[A-Za-z_][\w-]*$/.test(name) ? `clis.${name}` : `clis[${JSON.stringify(name)}]`;
}

/**
 * Why `name` cannot be an added CLI's name (CONFIGURATION-2.1), beside the built-ins `builtIns`; none where it can. It names the CLI
 * in every list, so it has a visible character, no space at either end and no control character, and it is no built-in's ID or name
 * in any letter case - two `Codex` lines in New Agent would be no choice at all.
 */
function nameProblem(name: string, builtIns: readonly BuiltInFacts[]): CliProblem | undefined {
	const setting = entrySetting(name);
	if (!/[^\s\p{Cf}]/u.test(name)) {
		return problem(`${setting}: a CLI's name needs a visible character`, 'entry_name_empty', setting);
	}
	if (name !== name.trim()) {
		return problem(`${setting}: a CLI's name cannot start or end with a space`, 'entry_name_space', setting);
	}
	if (/\p{Cc}/u.test(name)) {
		return problem(`${setting}: a CLI's name cannot hold a control character`, 'entry_name_control', setting);
	}
	const same = builtIns.find(each => [each.id, each.displayName].some(taken => taken.toLowerCase() === name.toLowerCase()));
	if (same) {
		return problem(`${setting}: this is ${same.displayName}'s name; choose another name for this CLI`, 'entry_name_builtin', setting, same.displayName);
	}
	return undefined;
}

/** A text field `field` of `entry` at `setting`: a string with a visible character and no NUL, else none - said in `problems`. */
function textOf(entry: { readonly [field: string]: unknown }, field: string, setting: string, problems: CliProblem[]): string | undefined {
	const value = entry[field];
	const at = `${setting}.${field}`;
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string') {
		problems.push(problem(`${at} must be a string; received ${jsonType(value)}`, 'entry_text_type', at, jsonType(value)));
		return undefined;
	}
	if (!/\S/.test(value)) {
		problems.push(problem(`${at} is empty; set it, or leave it out`, 'entry_text_empty', at));
		return undefined;
	}
	if (value.includes('\0')) {
		problems.push(problem(`${at} contains a NUL character, which it cannot hold`, 'entry_text_nul', at));
		return undefined;
	}
	return value;
}

/** The entry `value` of the name `name` (CONFIGURATION-2.2): its built-in's, where `builtIn` names one, else an added CLI's. */
export function readEntry(name: string, value: unknown, builtIns: readonly BuiltInFacts[]): EntrySettings {
	const setting = entrySetting(name);
	const builtIn = builtIns.find(each => each.id === name);
	const ids = builtIns.map(each => each.id);
	const problems: CliProblem[] = [];
	const named = builtIn ? undefined : nameProblem(name, builtIns);
	if (named) {
		problems.push(named);
	}
	if (!isJsonObject(value)) {
		problems.push(problem(`${setting} must be an object of type, icon, command, args, env, model, effort and enabled; received ${jsonType(value)}`, 'entry_type_object', setting, jsonType(value)));
		return { name, setting, builtIn: !!builtIn, ...builtIn ? { type: builtIn.id } : {}, command: '', args: [], env: {}, enabled: true, icon: builtIn ? builtIn.id : PROGRAM_ICON, problems };
	}
	for (const field of Object.keys(value)) {
		if (!ENTRY_FIELDS.includes(field)) {
			problems.push(problem(`${setting}.${field} is not a field of an entry, which takes ${ENTRY_FIELDS.join(', ')}`, 'entry_field', setting, field, ENTRY_FIELDS.join(', ')));
		}
	}
	// Its type: a built-in's entry is that built-in, which `type` may repeat but never change; an added CLI names its own
	let type: string | undefined;
	const declared = value.type;
	// A wrong type is said by what it should be, never by what it holds (CONFIGURATION-4.1)
	if (builtIn) {
		type = builtIn.id;
		if (declared !== undefined && declared !== builtIn.id) {
			problems.push(problem(`${setting}.type cannot change the ${name} entry's type: it is ${builtIn.displayName}'s; set it back to "${name}" or remove the line`, 'entry_type_builtin', `${setting}.type`, name, builtIn.displayName));
		}
	} else if (declared === undefined) {
		problems.push(problem(`${setting}.type is missing; set it to the CLI it runs: ${[...ids, PROGRAM_TYPE].join(', ')}`, 'entry_type_missing', `${setting}.type`, [...ids, PROGRAM_TYPE].join(', ')));
	} else if (typeof declared !== 'string' || ![...ids, PROGRAM_TYPE].includes(declared)) {
		problems.push(problem(`${setting}.type must be one of ${[...ids, PROGRAM_TYPE].join(', ')}; received ${jsonType(declared)}`, 'entry_type_unknown', `${setting}.type`, [...ids, PROGRAM_TYPE].join(', '), jsonType(declared)));
	} else {
		type = declared;
	}
	const command = textOf(value, 'command', setting, problems);
	if (type === PROGRAM_TYPE && value.command === undefined) {
		problems.push(problem(`${setting}.command is missing; set it to the program to run`, 'entry_command_missing', `${setting}.command`));
	}
	const args = argumentsOf(value.args, `${setting}.args`, problems);
	const facts = builtIns.find(each => each.id === type);
	if (facts?.grammar) {
		problems.push(...argsProblems(args, facts.grammar, `${setting}.args`));
	}
	if (value.env === null) {
		problems.push(problem(`${setting}.env must be an object of variable names to strings or null; received null`, 'environment_type', `${setting}.env`, 'null'));
	}
	const env = value.env === null ? {} : environmentMapOf(value.env, `${setting}.env`, problems);
	const choices: { model?: string; effort?: string } = {};
	for (const choice of ['model', 'effort'] as const) {
		const chosen = textOf(value, choice, setting, problems);
		if (chosen === undefined) {
			continue;
		}
		if (type === PROGRAM_TYPE) {
			problems.push(problem(`${setting}.${choice} is not taken by a program: give its own options in args`, 'entry_choice_program', `${setting}.${choice}`));
		} else if (facts && !facts.takes[choice]) {
			problems.push(problem(`${setting}.${choice} is not taken by ${facts.displayName}, which sets it in its own configuration`, 'entry_choice_unsupported', `${setting}.${choice}`, facts.displayName));
		} else {
			choices[choice] = chosen;
		}
	}
	const enabled = value.enabled;
	if (enabled !== undefined && typeof enabled !== 'boolean') {
		problems.push(problem(`${setting}.enabled must be true or false; received ${jsonType(enabled)}`, 'entry_enabled_type', `${setting}.enabled`, jsonType(enabled)));
	}
	// Its icon: one of the icons there are, said by what it should be, never by what it holds (CONFIGURATION-2.4, 4.1)
	const icons = iconsOf(builtIns);
	const icon = value.icon;
	const shown = typeof icon === 'string' && icons.includes(icon) ? icon : undefined;
	if (icon !== undefined && shown === undefined) {
		problems.push(problem(`${setting}.icon must be one of ${icons.join(', ')}; received ${jsonType(icon)}`, 'entry_icon', `${setting}.icon`, icons.join(', '), jsonType(icon)));
	}
	return {
		name, setting, builtIn: !!builtIn, ...type !== undefined ? { type } : {}, command: command ?? '', args, env, ...choices,
		enabled: typeof enabled === 'boolean' ? enabled : true, icon: shown ?? (type !== undefined && type !== PROGRAM_TYPE ? type : PROGRAM_ICON), problems
	};
}

/**
 * Every entry of `members` - the file's `clis` in its order - beside the built-ins `builtIns` (CONFIGURATION-2.1): each built-in's,
 * its defaults where the file names it not, in the built-ins' order; then the added CLIs in the file's order.
 */
export function readEntries(members: readonly ClisMember[], builtIns: readonly BuiltInFacts[]): readonly EntrySettings[] {
	const ids = builtIns.map(each => each.id);
	return [
		...builtIns.map(builtIn => {
			const member = members.find(each => each.name === builtIn.id);
			return member ? readEntry(member.name, member.value, builtIns) : readEntry(builtIn.id, {}, builtIns);
		}),
		...members.filter(member => !ids.includes(member.name)).map(member => readEntry(member.name, member.value, builtIns))
	];
}
