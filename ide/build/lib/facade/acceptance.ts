/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The acceptance case ids in a spec, in the order its tables give them. */
export function caseIds(markdown: string): string[] {
	const ids: string[] = [];
	for (const match of markdown.matchAll(/^\| (?<id>(?:WS|WTA|ID)-\d+) \|/gm)) {
		ids.push(match.groups!.id);
	}
	return ids;
}

/** The titles of the `suite(...)` and `test(...)` calls in a test file, string literals only. */
export function testTitles(source: string): string[] {
	const titles: string[] = [];
	for (const match of source.matchAll(/\b(?:suite|test)(?:\.only|\.skip)?\(\s*(?<quote>['"`])(?<title>(?:\\.|(?!\k<quote>)[^\\])*)\k<quote>/g)) {
		titles.push(match.groups!.title);
	}
	return titles;
}

/** The case ids a title begins with: `WS-17 WS-59 a hidden file is saved` holds two. */
export function leadingIds(title: string): string[] {
	const head = /^(?<ids>(?:(?:WS|WTA|ID)-\d+)(?:[ ,]+(?:WS|WTA|ID)-\d+)*)(?=\s|$|:)/.exec(title);
	return head ? head.groups!.ids.split(/[ ,]+/) : [];
}

export interface ICoverage {
	/** Each case and the tests that name it, in the specs' order. */
	readonly held: ReadonlyMap<string, readonly string[]>;
	/** Cases held by a manual procedure, with the procedure. */
	readonly manual: ReadonlyMap<string, string>;
	/** Cases no test names and no procedure lists. */
	readonly missing: readonly string[];
	/** Ids a test title or the manual list names that no spec has - a typo, or a case since removed. */
	readonly unknown: readonly string[];
}

/**
 * Which acceptance cases a test title or a manual procedure holds, and which nothing does (WORKSPACE.md W15).
 * A title that names a case shows where it is held, not that it passes.
 */
export function coverage(ids: readonly string[], tests: Iterable<{ path: string; source: string }>, manual: Readonly<Record<string, string>>): ICoverage {
	const known = new Set(ids);
	const held = new Map<string, string[]>(ids.map(id => [id, []]));
	const unknown = new Set<string>();
	for (const test of tests) {
		for (const title of testTitles(test.source)) {
			for (const id of leadingIds(title)) {
				const list = held.get(id);
				if (list) {
					list.push(`${test.path}: ${title}`);
				} else {
					unknown.add(id);
				}
			}
		}
	}

	const manualMap = new Map<string, string>();
	for (const [id, procedure] of Object.entries(manual)) {
		if (known.has(id)) {
			manualMap.set(id, procedure);
		} else {
			unknown.add(id);
		}
	}

	const missing = ids.filter(id => held.get(id)!.length === 0 && !manualMap.has(id));
	return { held, manual: manualMap, missing, unknown: [...unknown].sort() };
}
