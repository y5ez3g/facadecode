/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The trust a CLI keeps in a file of its own (CLIS-3.3, D62): the folder a run starts in is trusted as the person trusts it by
// accepting the CLI's question - the CLI's own entry merged into the CLI's own file as the CLI writes it, under the lock the CLI
// takes, every other byte of the file kept - and nothing else of the file is touched. An entry already there writes nothing. A file
// that cannot be read, or not as the CLI writes it, is left as it is, and one the CLI has not made is not made for it (D97): the
// CLI then asks in its terminal. So it does for a folder whose trust would cover far more than it (D97). The entry stays, as the
// person's own answer would: it is theirs to take out.

import * as fs from 'fs';
import { updateJsonFile } from '../base/files';
import type { JsonObject } from '../base/json';
import { addItems, addMembers, applyJsonEdits, JsonEdit, JsonNode, JsonObjectNode, JsonStyle, jsonStyleOf, memberOf, nodeValue, replaceValue } from '../base/jsonc';
import { FileLock, withFileLock } from '../base/lock';

/**
 * Where a CLI keeps its trust in the folder a launch starts in, and what (CLIS-3.3): its file, the keys of its entry there,
 * outermost first, and the entry - a value at those keys, or an item of the list at those keys.
 */
export interface TrustTarget {
	readonly file: string;
	readonly keys: readonly string[];
	/** The value set, or the item a list is given. */
	readonly entry: { readonly value: boolean } | { readonly item: string };
	/** The folder trusted, as the CLI names it. */
	readonly folder: string;
	/** Why no trust is written for this folder: the CLI's trust would cover far more than it (D97). */
	readonly withheld?: string;
}

/**
 * What became of a trust: written, there already, or nothing written - the file not made by the CLI yet, left as it is with why,
 * or the folder one whose trust is withheld, with why.
 */
export type TrustOutcome =
	| { readonly kind: 'written' }
	| { readonly kind: 'there' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'unreadable'; readonly why: string }
	| { readonly kind: 'withheld'; readonly why: string };

/** The entry's value, a list of its item for a list. */
function leafOf(target: TrustTarget): unknown {
	return 'item' in target.entry ? [target.entry.item] : target.entry.value;
}

/** `leaf` inside an object for each of `keys`, outermost first. */
function nested(keys: readonly string[], leaf: unknown): unknown {
	return keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), leaf);
}

/** The entry with the objects it is in, as JSON: what a file that has none of it is given, and what is shown of it. */
export function trustEntryJson(target: TrustTarget): JsonObject {
	return nested(target.keys, leafOf(target)) as JsonObject;
}

/**
 * Merges `target`'s entry into its file (CLIS-3.3, D62) under `lock` - the CLI's own, `<file>.lock`, which `withFileLock` waits for
 * as Claude Code takes it - so that what the CLI writes meanwhile is read again and kept. A file that is not there is not made,
 * nor is the lock taken beside it (D97); one that cannot be read, is no JSON object or has something of another kind where the
 * entry goes is left as it is. A withheld folder is not trusted (D97). Throws where the lock or the write fails.
 */
export function mergeTrust(target: TrustTarget, lock: FileLock = withFileLock): TrustOutcome {
	if (target.withheld !== undefined) {
		return { kind: 'withheld', why: target.withheld };
	}
	if (!fs.existsSync(target.file)) {
		return { kind: 'missing' };
	}
	return lock(target.file, () => updateJsonFile(target.file, (read): { readonly outcome: TrustOutcome; readonly write?: JsonObject | string } => {
		if (read.kind === 'other') {
			return { outcome: { kind: 'unreadable', why: read.why } };
		}
		if (read.kind === 'missing') {
			// Taken away between the look and the lock
			return { outcome: { kind: 'missing' } };
		}
		// The file's own text, edited where the entry goes: its comments, numbers, keys and layout stay as they were
		const edits = trustEdits(read.text, read.tree, target, jsonStyleOf(read.text, read.tree, read.layout.lineEnding, read.layout.indent));
		if (typeof edits === 'string') {
			return { outcome: { kind: 'unreadable', why: edits } };
		}
		return edits.length ? { outcome: { kind: 'written' }, write: applyJsonEdits(read.text, edits) } : { outcome: { kind: 'there' } };
	}));
}

/** What a JSON part is, as a reason names it. */
function kindOf(node: JsonNode): string {
	return node.kind === 'object' ? 'an object' : node.kind === 'array' ? 'a list' : JSON.stringify(node.value);
}

/**
 * The edits of `text`, read as `root`, that give it `target`'s entry: the objects at its keys added where they are not there - a
 * null taken for nothing - and the value set, or the item added to the list, unless what is there already trusts the folder. Why
 * not, where something of another kind is in the entry's way.
 */
function trustEdits(text: string, root: JsonObjectNode, target: TrustTarget, style: JsonStyle): readonly JsonEdit[] | string {
	const { keys, entry } = target;
	let node = root;
	for (const [at, key] of keys.entries()) {
		const member = memberOf(node, key);
		const there = member && !(member.value.kind === 'scalar' && member.value.value === null) ? member.value : undefined;
		if (!there) {
			const value = nested(keys.slice(at + 1), leafOf(target));
			return member ? [replaceValue(text, member.value, value, style)] : addMembers(text, node, [[key, value]], style);
		}
		const where = JSON.stringify(keys.slice(0, at + 1));
		if (at < keys.length - 1) {
			if (there.kind !== 'object') {
				return `has ${kindOf(there)} at ${where}, where an object belongs`;
			}
			node = there;
		} else if ('item' in entry) {
			if (there.kind !== 'array') {
				return `has ${kindOf(there)} at ${where}, where a list belongs`;
			}
			// Only the folder as the CLI names it: one in another case or with other slashes may not be the one a CLI that compares
			// the text trusts, and another item beside it does no harm
			return there.items.some(had => nodeValue(had) === entry.item) ? [] : addItems(text, there, [entry.item], style);
		} else {
			if (there.kind !== 'scalar') {
				return `has ${kindOf(there)} at ${where}, where ${JSON.stringify(entry.value)} belongs`;
			}
			return there.value === entry.value ? [] : [replaceValue(text, there, entry.value, style)];
		}
	}
	return [];
}

/**
 * Trusts `target.folder` for the CLI `cli` names (CLIS-3.3, D62), and what the log says of it: what was merged and where, or why the
 * file was left as it is; nothing for an entry already there. Throws where the lock or the write fails.
 */
export function writeTrust(cli: string, target: TrustTarget, lock: FileLock = withFileLock): string | undefined {
	const outcome = mergeTrust(target, lock);
	switch (outcome.kind) {
		case 'written': return `Trusted ${target.folder} for ${cli}: merged ${JSON.stringify(trustEntryJson(target))} into ${target.file}.`;
		case 'there': return undefined;
		case 'missing': return `Did not trust ${target.folder} for ${cli}: ${target.file} does not exist, and Facade makes no file of ${cli}'s; ${cli} asks in its terminal.`;
		case 'unreadable': return `Did not trust ${target.folder} for ${cli}: ${target.file} ${outcome.why}, so Facade left it as it is; ${cli} asks in its terminal.`;
		case 'withheld': return `Did not trust ${target.folder} for ${cli}: ${outcome.why}; ${cli} asks in its terminal.`;
	}
}
