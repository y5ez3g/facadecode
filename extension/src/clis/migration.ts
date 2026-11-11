/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings the settings file replaced (CONFIGURATION-6.1): the editor settings the published extension read - `facade.yolo`,
// `facade.collaboration.enabled`, each built-in's `facade.<cli>.enabled`, `.path` and `.launch`, and `facade.custom` - copied into
// the file as the entries they stand for, the first time Facade needs the file and finds none. Each value is copied as it is, wrong
// ones too, for the file's own rules to say what is wrong with them, so that nothing is quietly dropped; only a model or effort an
// earlier `arguments` gave plainly moves into its field, which `args` no longer takes. Where two old settings would have to be one
// entry, or an old one has no place in the file, no file is made: each is reported by its old path, and the old settings stay.

import { isJsonObject } from '../base/json';
import { takeChoices } from './args';
import { BUILT_IN_FACTS } from './catalog';
import { settingsText } from './settingsTemplate';

export { settingsText };
import type { CliProblem } from './config';

/** How the old settings are read: by full name, the value the person set at the machine's level; undefined where none is set. */
export type LegacyReader = (name: string) => unknown;

/** Each built-in's old settings segment, by its entry's name (CONFIGURATION-6.1): Antigravity's was `antigravity`. */
const LEGACY_SEGMENTS: readonly { readonly segment: string; readonly name: string }[] = [
	{ segment: 'claude', name: 'claude' },
	{ segment: 'codex', name: 'codex' },
	{ segment: 'antigravity', name: 'agy' },
	{ segment: 'muse', name: 'muse' },
	{ segment: 'opencode', name: 'opencode' },
	{ segment: 'pi', name: 'pi' }
];

/** Every old setting, by full name. */
export const LEGACY_SETTINGS: readonly string[] = [
	'facade.yolo',
	'facade.collaboration.enabled',
	...LEGACY_SEGMENTS.flatMap(({ segment }) => ['enabled', 'path', 'launch'].map(field => `facade.${segment}.${field}`)),
	'facade.custom'
];

/**
 * What a migration did that the person should know (CONFIGURATION-6.3): a choice moved out of `args`, the tools switch that is gone,
 * or an entry whose old values need fixing in the file.
 */
export interface MigrationNote {
	/** `needs_fix`: an entry to fix before it can start; `file_needs_fix`: the file as a whole, which stops every start. */
	readonly kind: 'choice_moved' | 'tools_always' | 'needs_fix' | 'file_needs_fix';
	/** Where: the old setting, and the entry field it went to. */
	readonly from?: string;
	readonly to?: string;
}

/** The settings file the old settings stand for, or why none can be made. */
export type Migration = { readonly kind: 'none' }
	| { readonly kind: 'file'; readonly text: string; readonly notes: readonly MigrationNote[] }
	| { readonly kind: 'conflict'; readonly problems: readonly CliProblem[] };

/** A problem of the old settings: its English, and its kind and values for the person's language. */
function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/**
 * An earlier path as the entry's command (CONFIGURATION-6.1): trimmed, as earlier builds read it, so that it names the same program;
 * any other value as it is, whitespace alone too, which was an error then and is one still.
 */
function commandOf(path: unknown): unknown {
	return typeof path === 'string' && path.trim() ? path.trim() : path;
}

/**
 * The settings file the old settings `read` gives stand for (CONFIGURATION-6.1, 6.2): none where the person set none; else `yolo` and
 * `clis` as the old values were, `launch.resume` and the tools switch left behind as features that are gone. Two old settings that
 * would be one entry, or an old value with no place in an entry, make no file: each is said by its old path.
 */
export function migrationOf(read: LegacyReader): Migration {
	const set = LEGACY_SETTINGS.filter(name => read(name) !== undefined);
	if (!set.length) {
		return { kind: 'none' };
	}
	const problems: CliProblem[] = [];
	const notes: MigrationNote[] = [];
	const clis: [string, { [field: string]: unknown }][] = [];
	// The earlier setting each entry comes from, so that two that would be one entry are both said
	const sources = new Map<string, string>();
	if (read('facade.collaboration.enabled') === false) {
		notes.push({ kind: 'tools_always', from: 'facade.collaboration.enabled' });
	}
	for (const { segment, name } of LEGACY_SEGMENTS) {
		const prefix = `facade.${segment}`;
		const entry: { [field: string]: unknown } = {};
		const enabled = read(`${prefix}.enabled`);
		if (enabled !== undefined) {
			entry.enabled = enabled;
		}
		const command = read(`${prefix}.path`);
		// An empty path was the CLI on PATH, which a missing command is now
		if (command !== undefined && command !== '') {
			entry.command = commandOf(command);
		}
		const launch = read(`${prefix}.launch`);
		if (launch !== undefined) {
			if (!isJsonObject(launch)) {
				problems.push(problem(`${prefix}.launch has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', `${prefix}.launch`));
			} else {
				for (const field of Object.keys(launch).filter(each => each !== 'arguments' && each !== 'environment')) {
					problems.push(problem(`${prefix}.launch.${field} has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', `${prefix}.launch.${field}`));
				}
				if (launch.arguments !== undefined) {
					const args = launch.arguments;
					if (Array.isArray(args) && args.every(each => typeof each === 'string')) {
						// A model or effort given plainly moves into its field, which args no longer takes (CONFIGURATION-6.2)
						const taken = takeChoices(args as string[], name, BUILT_IN_FACTS.find(each => each.id === name)?.grammar ?? { reserved: [] });
						entry.args = taken.args;
						for (const choice of ['model', 'effort'] as const) {
							if (taken[choice] !== undefined) {
								entry[choice] = taken[choice];
								notes.push({ kind: 'choice_moved', from: `${prefix}.launch.arguments`, to: `clis.${name}.${choice}` });
							}
						}
					} else {
						entry.args = args;
					}
				}
				if (launch.environment !== undefined) {
					entry.env = launch.environment;
				}
			}
		}
		if (Object.keys(entry).length) {
			clis.push([name, entry]);
			sources.set(name, prefix);
		}
	}
	const custom = read('facade.custom');
	if (custom !== undefined) {
		if (!isJsonObject(custom)) {
			problems.push(problem('facade.custom has no place in facade.json; fix it or remove it, or write facade.json yourself', 'migration_shape', 'facade.custom'));
		} else {
			for (const [name, value] of Object.entries(custom)) {
				const old = `facade.custom.${name}`;
				if (sources.has(name)) {
					problems.push(problem(`${old} and ${sources.get(name)} would both be clis.${name}; rename or remove one of them, or write facade.json yourself`, 'migration_collision', old, sources.get(name)!, `clis.${name}`));
					continue;
				}
				if (!isJsonObject(value)) {
					problems.push(problem(`${old} has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', old));
					continue;
				}
				const entry: { [field: string]: unknown } = { type: 'custom' };
				for (const field of Object.keys(value).filter(each => each !== 'path' && each !== 'launch')) {
					problems.push(problem(`${old}.${field} has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', `${old}.${field}`));
				}
				if (value.path !== undefined) {
					entry.command = commandOf(value.path);
				}
				const launch = value.launch;
				if (launch !== undefined) {
					if (!isJsonObject(launch)) {
						problems.push(problem(`${old}.launch has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', `${old}.launch`));
					} else {
						for (const field of Object.keys(launch).filter(each => each !== 'start' && each !== 'environment' && each !== 'resume')) {
							problems.push(problem(`${old}.launch.${field} has no place in facade.json; fix it or remove it, or write facade.json yourself`, 'migration_shape', `${old}.launch.${field}`));
						}
						if (launch.start !== undefined) {
							entry.args = launch.start;
						}
						if (launch.environment !== undefined) {
							entry.env = launch.environment;
						}
						// launch.resume is a feature that is gone: Facade cannot resume a program's conversation (CONFIGURATION-2.3, 6.1)
					}
				}
				clis.push([name, entry]);
				sources.set(name, old);
			}
		}
	}
	if (problems.length) {
		return { kind: 'conflict', problems };
	}
	return { kind: 'file', text: settingsText(read('facade.yolo'), clis), notes };
}
