/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Facade's settings file (CONFIGURATION-1): `facade.json` in the Facade home, JSON with comments and trailing commas. Its text is
// read strictly: a file that is not valid JSON with comments, a key twice in one object, a root that is not an object, a top-level
// key Facade does not have or a top-level value of the wrong kind stops every new start, saying where; nothing is guessed and no
// default stands in. A file with nothing in it - empty, blank, or only whole comments - holds every default. The CLIs are read on
// (`entries.ts`), each on its own, so that a mistake in one leaves the others usable.

import { getNodeValue, Node, parseTree, ParseError, visit } from 'jsonc-parser';
import type { CliProblem } from './config';
import { jsonType } from './config';

/** The settings file's name, in the Facade home (CONFIGURATION-1.1). */
export const SETTINGS_FILE = 'facade.json';

/** One member of `clis`, in the order the file gives them: its name, and its value as written. */
export interface ClisMember {
	readonly name: string;
	readonly value: unknown;
}

/**
 * The settings a file holds (CONFIGURATION-1): `yolo`, true by default, `names` where it has them, and the members of `clis` in their
 * order; and what is wrong with the file as a whole, which stops every new start while it stands.
 */
export interface SettingsSnapshot {
	/** The file, as a problem names it to the person. */
	readonly file: string;
	readonly yolo: boolean;
	/** The names a blank agent name is filled in from, trimmed (LIFECYCLE-2.1); none where the file has no `names`: the built-in list. */
	readonly names?: readonly string[];
	readonly clis: readonly ClisMember[];
	/** What is wrong with the file as a whole; while any stands, no agent starts or resumes (CONFIGURATION-4.1). */
	readonly problems: readonly CliProblem[];
}

/** The settings of a file that does not exist, or holds nothing: every default (CONFIGURATION-1.1). */
export function defaultSettings(file: string): SettingsSnapshot {
	return { file, yolo: true, clis: [], problems: [] };
}

function problem(text: string, kind: string, ...values: string[]): CliProblem {
	return { text, said: { kind, values } };
}

/** The 1-based line and column of `offset` in `text`, its lines ended by CR LF, LF or CR alone, as an editor counts them. */
function positionOf(text: string, offset: number): { readonly line: number; readonly column: number } {
	let line = 1;
	let start = 0;
	for (let index = 0; index < offset && index < text.length; index++) {
		const char = text.charCodeAt(index);
		if (char === 10 || (char === 13 && text.charCodeAt(index + 1) !== 10)) {
			line++;
			start = index + 1;
		}
	}
	return { line, column: offset - start + 1 };
}

/** A problem at `offset` of `text` in `file`: where it is, as an editor counts lines and columns. */
function at(file: string, text: string, offset: number): { readonly where: string; readonly line: string; readonly column: string } {
	const { line, column } = positionOf(text, offset);
	return { where: `${file}:${line}:${column}`, line: String(line), column: String(column) };
}

/** Each key that appears twice in the same object of `text`, by where its second appearance is. */
function duplicateKeys(text: string): { readonly key: string; readonly offset: number }[] {
	const duplicates: { key: string; offset: number }[] = [];
	const objects: Set<string>[] = [];
	visit(text, {
		onObjectBegin: () => { objects.push(new Set()); },
		onObjectEnd: () => { objects.pop(); },
		onObjectProperty: (key, offset) => {
			const seen = objects.at(-1);
			if (!seen) {
				return;
			}
			if (seen.has(key)) {
				duplicates.push({ key, offset });
			}
			seen.add(key);
		}
	}, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
	return duplicates;
}

/** The members of the object node `node`, in the order the text gives them. */
function membersOf(node: Node): { readonly key: string; readonly value: Node | undefined; readonly offset: number }[] {
	return (node.children ?? []).flatMap(property => {
		const [key, value] = property.children ?? [];
		return key && typeof key.value === 'string' ? [{ key: key.value, value, offset: key.offset }] : [];
	});
}

/** The JSON type of the node `node`, as a problem names a value: by its type alone, never its text. */
function typeOf(node: Node | undefined): string {
	return node ? jsonType(getNodeValue(node)) : 'nothing';
}

/**
 * The settings `given` holds, as the file `file` (CONFIGURATION-1): empty, blank or only whole comments for every default; otherwise
 * one object whose `yolo` is true or false, whose `names` is a list of names that are not blank, whose `clis` is an object, and whose
 * `$schema`, where present, is a string. Anything else
 * is said with where it is, and the file's settings are then none: every new start stops until it is fixed (CONFIGURATION-4.1).
 */
export function parseSettings(given: string, file: string): SettingsSnapshot {
	// A byte order mark is no part of the settings, as editors read a JSON file: a file saved with one reads as without it
	const text = given.startsWith('\uFEFF') ? given.slice(1) : given;
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
	const problems: CliProblem[] = [];
	// The first place the text stops being JSON with comments: what follows it is read wrong from there, so it is said alone
	if (errors.length) {
		const place = at(file, text, errors[0].offset);
		problems.push(problem(`${place.where}: this is not valid JSON with comments`, 'settings_syntax', file, place.line, place.column));
	}
	for (const duplicate of duplicateKeys(text)) {
		const place = at(file, text, duplicate.offset);
		problems.push(problem(`${place.where}: ${JSON.stringify(duplicate.key)} appears twice in the same object`, 'settings_duplicate', file, place.line, place.column, JSON.stringify(duplicate.key)));
	}
	if (problems.length) {
		return { ...defaultSettings(file), problems };
	}
	// Nothing at all - an empty, blank or comment-only file - is every default (CONFIGURATION-1.1)
	if (root === undefined) {
		return defaultSettings(file);
	}
	if (root.type !== 'object') {
		return { ...defaultSettings(file), problems: [problem(`${file} must hold one object, such as {}; it holds ${typeOf(root)}`, 'settings_root', file, typeOf(root))] };
	}
	let yolo = true;
	let names: string[] | undefined;
	let clis: ClisMember[] = [];
	for (const { key, value, offset } of membersOf(root)) {
		const place = at(file, text, offset);
		if (key === 'names') {
			names = namesOf(value, file, text, place, problems);
		} else if (key === 'yolo') {
			if (value?.type === 'boolean') {
				yolo = getNodeValue(value) as boolean;
			} else {
				problems.push(problem(`${place.where}: yolo must be true or false; received ${typeOf(value)}`, 'settings_yolo', file, place.line, place.column, typeOf(value)));
			}
		} else if (key === 'clis') {
			if (value?.type === 'object') {
				clis = membersOf(value).map(member => ({ name: member.key, value: member.value ? getNodeValue(member.value) as unknown : undefined }));
			} else {
				problems.push(problem(`${place.where}: clis must be an object of CLIs by name; received ${typeOf(value)}`, 'settings_clis', file, place.line, place.column, typeOf(value)));
			}
		} else if (key === '$schema') {
			if (value?.type !== 'string') {
				problems.push(problem(`${place.where}: $schema must be a string; received ${typeOf(value)}`, 'settings_schema', file, place.line, place.column, typeOf(value)));
			}
		} else {
			problems.push(problem(`${place.where}: ${JSON.stringify(key)} is not a Facade setting; the settings are yolo, names and clis`, 'settings_key', file, place.line, place.column, JSON.stringify(key)));
		}
	}
	return problems.length ? { ...defaultSettings(file), problems } : { file, yolo, ...names ? { names } : {}, clis, problems: [] };
}

/**
 * `names` as the file gives it (LIFECYCLE-2.1): a list of names, each trimmed. Anything else, or a name that is blank, is said with
 * where it is; nothing is skipped or guessed.
 */
function namesOf(value: Node | undefined, file: string, text: string, place: ReturnType<typeof at>, problems: CliProblem[]): string[] | undefined {
	if (value?.type !== 'array') {
		problems.push(problem(`${place.where}: names must be a list of strings; received ${typeOf(value)}`, 'settings_names', file, place.line, place.column, typeOf(value)));
		return undefined;
	}
	const names: string[] = [];
	for (const [index, item] of (value.children ?? []).entries()) {
		const where = at(file, text, item.offset);
		if (item.type !== 'string') {
			problems.push(problem(`${where.where}: names must be a list of strings; received ${typeOf(item)}`, 'settings_names', file, where.line, where.column, typeOf(item)));
		} else if (!(getNodeValue(item) as string).trim()) {
			problems.push(problem(`${where.where}: the name at position ${index + 1} must not be empty or only spaces`, 'settings_name_blank', file, where.line, where.column, String(index + 1)));
		} else {
			names.push((getNodeValue(item) as string).trim());
		}
	}
	return names;
}
