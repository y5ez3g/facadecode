/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { messageOf } from '../base/errors';
import { canonicalFolder, isEqualPath, JsonFile, readJsonFile, updateJsonFile } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
import { addItems, addMembers, applyJsonEdits, JsonEdit, JsonObjectNode, JsonStyle, jsonStyleOf, memberOf, nodeValue, replaceValue } from '../base/jsonc';
import { FileLock } from '../base/lock';
import { AgentCli, CliConfig, Environment, withValues } from './cli';
import { homeOf } from './executable';

/** What became of a trust: written, there already, or the file left alone - one that cannot be read, or not as the CLI writes it. */
export type TrustOutcome = 'written' | 'there' | 'unreadable';

/** A folder an agent starts in, and what trust in it covers: its repository's main checkout - the whole repository - or, outside any repository, the folder itself. */
export interface TrustedFolder {
	readonly folder: string;
	readonly repository: string;
}

/**
 * Where, and what, Facade writes for a CLI that keeps the person's trust in a file, as its
 * `launch.trust` says, each `${name}` in it what the CLI says it stands for - `${home}` the person's home
 * folder in `env`, as a `~` the file starts with is; undefined for a CLI given its trust in its
 * arguments, or none. Throws, naming the setting, at a `${name}` with no value, or a file that is no
 * absolute path, which would be written wherever the window runs from.
 */
export function trustTarget(cli: AgentCli, config: CliConfig, trusted: TrustedFolder, env: Environment): { readonly file: string; readonly entry: JsonObject } | undefined {
	const { trust } = config.launch;
	if (trust?.file === undefined) {
		return undefined;
	}
	const setting = `${cli.setting}.launch.trust`;
	// Every CLI's trust has the values L9 lists - its folder, its repository and the home folder - each in the
	// form the CLI keeps it in where it has one of its own (X-58)
	const values = { home: homeOf(env), folder: canonicalFolder(trusted.folder), repository: canonicalFolder(trusted.repository), ...cli.trustValues?.(trusted, env) };
	const file = withValues(trust.file, values, `${setting}.file`).replace(/^~(?=$|[\\/])/, () => values.home);
	if (!path.isAbsolute(file)) {
		throw new Error(`Setting '${setting}.file' must be an absolute path; received '${file}'. For example, use a path under \${home}.`);
	}
	return { file: path.resolve(file), entry: jsonWithValues(trust.merge, values, `${setting}.merge`) };
}

/**
 * Gives a CLI that keeps it in a file the person's trust in a folder an agent starts in - its whole
 * repository - under `lock`, in the home folder `env` says; answers with what it did and, for the log,
 * what it merged and where - or undefined for a CLI given its trust in its arguments, or none. A file
 * that cannot be read, or not as the CLI writes it, is left alone: `unreadable`, for the launch to fail
 * with rather than wait at the CLI's question (AGENT-LAUNCHER.md, L11).
 */
export function writeTrust(cli: AgentCli, config: CliConfig, trusted: TrustedFolder, lock: FileLock, env: Environment): { readonly outcome: TrustOutcome; readonly text: string } | undefined {
	const target = trustTarget(cli, config, trusted, env);
	if (!target) {
		return undefined;
	}
	const { file, entry } = target;
	const outcome = mergeIntoJsonFile(file, entry, lock);
	switch (outcome) {
		case 'written': return { outcome, text: `Merged trust entry ${JSON.stringify(entry)} into ${file}; ${cli.displayName} is now configured to trust ${trusted.folder}.` };
		case 'there': return { outcome, text: `Trust entry ${JSON.stringify(entry)} already exists in ${file}; ${cli.displayName} was already configured to trust ${trusted.folder}.` };
		case 'unreadable': return { outcome, text: `${whyLeftAlone(file, readJsonFile(file), entry, cli.displayName)}. Facade left the file unchanged and could not configure ${cli.displayName} to trust ${trusted.folder}. Correct the file, or set ${cli.setting}.launch.trust to null so ${cli.displayName} can ask for trust itself.` };
	}
}

/**
 * What would keep `writeTrust` from giving a CLI the person's trust in a folder, as things are now - a
 * `${name}` with no value, a file that cannot be read, or not as the CLI writes it - or undefined where it
 * could: asked before anything is made for a start, a new worktree included (AGENT-LAUNCHER.md, L11). Writes
 * nothing.
 */
export function trustProblem(cli: AgentCli, config: CliConfig, trusted: TrustedFolder, env: Environment): string | undefined {
	let target: ReturnType<typeof trustTarget>;
	try {
		target = trustTarget(cli, config, trusted, env);
	} catch (err) {
		return messageOf(err);
	}
	if (!target) {
		return undefined;
	}
	const read = readJsonFile(target.file);
	if (read.kind === 'missing' || (read.kind === 'object' && mergedInto(read.value, target.entry).kind !== 'conflict')) {
		return undefined;
	}
	return `${whyLeftAlone(target.file, read, target.entry, cli.displayName)}. Facade cannot configure ${cli.displayName} to trust ${trusted.folder}. Correct the file, or set ${cli.setting}.launch.trust to null so ${cli.displayName} can ask for trust itself.`;
}

/**
 * Why a trust file Facade leaves alone is left alone, as the person is told it - its specific problem, not only that
 * there is one (AGENT-LAUNCHER.md, L11): `file`, as `read`, could not be read, is no JSON object, or has where the entry
 * goes a value of another kind, named by its keys.
 */
function whyLeftAlone(file: string, read: JsonFile, entry: JsonObject, cliName: string): string {
	if (read.kind === 'other') {
		return `${file} ${read.why}`;
	}
	const merged = read.kind === 'object' ? mergedInto(read.value, entry) : undefined;
	return merged?.kind === 'conflict'
		? `${file} contains an incompatible value at ${JSON.stringify(merged.at)}; ${cliName} expects a different type there`
		: `${file} could not be read or does not match ${cliName}'s expected format`;
}

/**
 * Merges `entry` into the JSON file `file` as the CLI that keeps it writes the person's answer: objects
 * key by key, a list given each item it lacks - a path to a folder it has under another name is one it
 * has - and any other value set; a null there is taken for nothing there. The rest of the file is kept,
 * and its layout too; a file that is not a JSON object, or a value of another kind than what would be
 * merged into it, is left alone. The CLI writes the file too: it is merged under `lock`, and what the
 * CLI writes meanwhile is read again, and kept.
 */
export function mergeIntoJsonFile(file: string, entry: JsonObject, lock: FileLock): TrustOutcome {
	return lock(file, () => updateJsonFile(file, (read): { readonly outcome: TrustOutcome; readonly write?: JsonObject | string } => {
		if (read.kind === 'other') {
			return { outcome: 'unreadable' };
		}
		if (read.kind === 'missing') {
			const merged = mergedInto({}, entry);
			return merged.kind === 'conflict' ? { outcome: 'unreadable' } : merged.kind === 'same' ? { outcome: 'there' } : { outcome: 'written', write: merged.value };
		}
		// The file's own text, edited where the entry goes: its comments, its numbers, its keys and its
		// layout stay as they were (X-48)
		const edits: JsonEdit[] = [];
		const style = jsonStyleOf(read.text, read.tree, read.layout.lineEnding, read.layout.indent);
		return mergeEdits(read.text, read.tree, entry, style, edits) === 'conflict'
			? { outcome: 'unreadable' }
			: edits.length ? { outcome: 'written', write: applyJsonEdits(read.text, edits) } : { outcome: 'there' };
	}));
}

/** The edits of `text` that merge `entry` into its object `node`, as `mergedInto` merges values, added to `edits`; `conflict` as there. */
function mergeEdits(text: string, node: JsonObjectNode, entry: JsonObject, style: JsonStyle, edits: JsonEdit[]): 'merged' | 'conflict' {
	const added: [string, unknown][] = [];
	for (const [key, value] of Object.entries(entry)) {
		const member = memberOf(node, key);
		// A null there holds nothing, as when the key is not there.
		const there = member && !(member.value.kind === 'scalar' && member.value.value === null) ? member.value : undefined;
		if (there !== undefined && (isJsonObject(value) !== (there.kind === 'object') || Array.isArray(value) !== (there.kind === 'array'))) {
			return 'conflict';
		}
		if (there?.kind === 'object' && isJsonObject(value)) {
			if (mergeEdits(text, there, value, style, edits) === 'conflict') {
				return 'conflict';
			}
		} else if (there?.kind === 'array' && Array.isArray(value)) {
			const missing = value.filter(item => !there.items.some(had => sameItem(nodeValue(had), item)));
			if (missing.length) {
				edits.push(...addItems(text, there, missing, style));
			}
		} else if (there?.kind === 'scalar' && there.value === value) {
			continue;
		} else if (member) {
			edits.push(replaceValue(text, member.value, value, style));
		} else {
			added.push([key, value]);
		}
	}
	if (added.length) {
		edits.push(...addMembers(text, node, added, style));
	}
	return 'merged';
}

/**
 * `entry` merged into `into`: `same` where it changes nothing; a `conflict` where a value is of another kind than what
 * would be merged into it, `at` its keys, dotted - the first such.
 */
function mergedInto(into: JsonObject, entry: JsonObject): { readonly kind: 'merged'; readonly value: JsonObject } | { readonly kind: 'same' } | { readonly kind: 'conflict'; readonly at: string } {
	const merged: { [key: string]: unknown } = { ...into };
	let changed = false;
	for (const [key, value] of Object.entries(entry)) {
		// A null there holds nothing, as when the key is not there.
		const there = into[key] ?? undefined;
		// A value of another kind there is the person's, or the CLI's, and stays as it is.
		if (there !== undefined && (isJsonObject(value) !== isJsonObject(there) || Array.isArray(value) !== Array.isArray(there))) {
			return { kind: 'conflict', at: key };
		}
		if (isJsonObject(value)) {
			const inner = mergedInto(isJsonObject(there) ? there : {}, value);
			if (inner.kind === 'conflict') {
				return { kind: 'conflict', at: `${key}.${inner.at}` };
			}
			merged[key] = inner.kind === 'same' ? there ?? {} : inner.value;
			changed ||= inner.kind !== 'same' || there === undefined;
		} else if (Array.isArray(value)) {
			const list: readonly unknown[] = Array.isArray(there) ? there : [];
			const missing = value.filter(item => !list.some(had => sameItem(had, item)));
			merged[key] = missing.length ? [...list, ...missing] : list;
			changed ||= missing.length > 0 || there === undefined;
		} else {
			merged[key] = value;
			changed ||= there !== value;
		}
	}
	return changed ? { kind: 'merged', value: merged } : { kind: 'same' };
}

/**
 * Whether a list has an item already: the same value, or for paths the same folder - by its real path,
 * through a link or a short name, in any case and with either slash.
 */
function sameItem(had: unknown, item: unknown): boolean {
	if (typeof had === 'string' && typeof item === 'string') {
		// The same path, in another case or with other slashes where the file system takes them so - not through a
		// link: a CLI that keeps folders in a list trusts the one it names (N-85)
		return had === item || (path.isAbsolute(had) && path.isAbsolute(item) && isEqualPath(had, item));
	}
	return JSON.stringify(had) === JSON.stringify(item);
}

/** A JSON value with each `${name}` in its keys and texts replaced by `values[name]`; throws, naming `setting`, at one with no value. */
function jsonWithValues(value: JsonObject, values: { readonly [name: string]: string }, setting: string): JsonObject {
	const replaced = (each: unknown): unknown => typeof each === 'string'
		? withValues(each, values, setting)
		: Array.isArray(each)
			? each.map(replaced)
			: isJsonObject(each)
				? Object.fromEntries(Object.entries(each).map(([key, inner]) => [withValues(key, values, setting), replaced(inner)]))
				: each;
	return replaced(value) as JsonObject;
}
