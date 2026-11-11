/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BUILT_IN_NAMES } from '../base/names';

/**
 * A name for an agent whose name is left blank (LIFECYCLE-2.1): at random, one of `names` - facade.json's `names`, else the
 * built-in list - that no agent of `taken` has, ignoring case and surrounding spaces. None where every one is taken or the list is
 * empty: the agent is then named by its ID.
 */
export function suggestName(taken: Iterable<string> = [], names: readonly string[] = BUILT_IN_NAMES, random: () => number = Math.random): string | undefined {
	const used = new Set([...taken].map(name => name.trim().toLowerCase()));
	const free = names.map(name => name.trim()).filter(name => name && !used.has(name.toLowerCase()));
	return free.length ? free[Math.floor(random() * free.length) % free.length] : undefined;
}

/** How a message names an agent (LIFECYCLE-2.1): its name, or its `#aN` where a record from an earlier version kept none. */
export function labelOf(agent: { readonly name: string; readonly alias: string }): string {
	return agent.name || agent.alias;
}

/** A trimmed display label (LIFECYCLE-2.1). Spaces and duplicates are allowed; a blank one is filled in, and IDs identify agents. */
export function normalizeName(raw: string): string {
	return raw.trim();
}

/**
 * The name a record that outlasts the run keeps - its conversation's, its Pin's (LIFECYCLE-2.1): none where the agent is named by its
 * ID, so that the conversation's next agent is named again rather than by an ID it does not have.
 */
export function keptName(agent: { readonly name: string; readonly alias: string }): string {
	return agent.name === agent.alias ? '' : agent.name;
}

/**
 * The names two or more of `runs` have, whole and case-sensitively after trimming: each of those agents shows its short ID on its card
 * and its open tab (PANEL-1.3, LIFECYCLE-2.2). An empty name is none: it shows its ID anyway.
 */
export function repeatedNames(runs: readonly { readonly name: string }[]): ReadonlySet<string> {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const { name } of runs) {
		const trimmed = name.trim();
		if (trimmed) {
			(seen.has(trimmed) ? repeated : seen).add(trimmed);
		}
	}
	return repeated;
}
