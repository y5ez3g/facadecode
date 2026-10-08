/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { canonicalFolder, isEqualPath, updateJsonFile } from '../base/files';
import { isJsonObject, JsonObject } from '../base/json';
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
	const values = { home: homeOf(env), ...cli.trustValues?.(trusted, env) };
	const file = withValues(trust.file, values, `${setting}.file`).replace(/^~(?=$|[\\/])/, () => values.home);
	if (!path.isAbsolute(file)) {
		throw new Error(`${setting}.file is ${JSON.stringify(file)}, which is no absolute path: start it with \${home}.`);
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
		case 'written': return { outcome, text: `Facade merged ${JSON.stringify(entry)} into ${file}: ${cli.displayName} trusts ${trusted.folder} now.` };
		case 'there': return { outcome, text: `${file} has ${JSON.stringify(entry)} already: ${cli.displayName} trusted ${trusted.folder} before.` };
		case 'unreadable': return { outcome, text: `${file} could not be read, or is not as ${cli.displayName} writes it, so Facade left it alone and cannot give ${cli.displayName} the person's trust in ${trusted.folder}: put the file right, or set ${cli.setting}.launch.trust to null for ${cli.displayName} to ask.` };
	}
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
	return lock(file, () => updateJsonFile(file, (read): { readonly outcome: TrustOutcome; readonly write?: JsonObject } => {
		if (read.kind === 'other') {
			return { outcome: 'unreadable' };
		}
		const merged = mergedInto(read.kind === 'object' ? read.value : {}, entry);
		return merged === 'conflict' ? { outcome: 'unreadable' } : merged === 'same' ? { outcome: 'there' } : { outcome: 'written', write: merged };
	}));
}

/** `entry` merged into `into`: `same` where it changes nothing, `conflict` where a value is of another kind than what would be merged into it. */
function mergedInto(into: JsonObject, entry: JsonObject): JsonObject | 'same' | 'conflict' {
	const merged: { [key: string]: unknown } = { ...into };
	let changed = false;
	for (const [key, value] of Object.entries(entry)) {
		// A null there holds nothing, as when the key is not there.
		const there = into[key] ?? undefined;
		// A value of another kind there is the person's, or the CLI's, and stays as it is.
		if (there !== undefined && (isJsonObject(value) !== isJsonObject(there) || Array.isArray(value) !== Array.isArray(there))) {
			return 'conflict';
		}
		if (isJsonObject(value)) {
			const inner = mergedInto(isJsonObject(there) ? there : {}, value);
			if (inner === 'conflict') {
				return 'conflict';
			}
			merged[key] = inner === 'same' ? there ?? {} : inner;
			changed ||= inner !== 'same' || there === undefined;
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
	return changed ? merged : 'same';
}

/**
 * Whether a list has an item already: the same value, or for paths the same folder - by its real path,
 * through a link or a short name, in any case and with either slash.
 */
function sameItem(had: unknown, item: unknown): boolean {
	if (typeof had === 'string' && typeof item === 'string') {
		return had === item || (path.isAbsolute(had) && path.isAbsolute(item) && isEqualPath(canonicalFolder(had), canonicalFolder(item)));
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
