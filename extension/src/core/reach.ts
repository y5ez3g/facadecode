/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which runs an agent reaches (RULES-4.3) and the one run a reference names (RULES-2.3): resolved once, before any effect, within
// that reach. An exact ID or `#aN` decides; a name must be unique; nothing outside reach is hinted at unless its ID was given.

import { FacadeError } from './errors';
import type { RunFacts } from './ports';

/** Whether `caller` reaches `target`: by its own run's YOLO every run, else its whole creation tree - the runs of its root. */
export function reaches(caller: Pick<RunFacts, 'yolo' | 'root'>, target: Pick<RunFacts, 'root'>): boolean {
	return caller.yolo || caller.root === target.root;
}

/** A run's reference as Facade writes it (LIFECYCLE-2.1): `@name #aN`, the ID deciding. */
export function referenceOf(facts: Pick<RunFacts, 'name' | 'alias'>): string {
	return `@${facts.name} ${facts.alias}`;
}

/** An ID that ends a reference: `#aN` or an exact run ID, alone or after a display name. */
const TRAILING_ID = /^(?:[\s\S]*?\s)?(?<id>#a\d+|run-[0-9a-f]{32})$/;

/** The `#aN` or exact run ID that ends `reference`, alone or after a display name: what decides it (RULES-2.3). */
export function trailingId(reference: string): string | undefined {
	return TRAILING_ID.exec(reference.trim())?.groups?.id;
}

/** What resolving a reference reads of a run: its IDs and name - a run of this window, or one another window lists (RULES-2.3). */
export type Named = Pick<RunFacts, 'id' | 'alias' | 'name'>;

export interface ResolveOptions<T extends Named = RunFacts> {
	/** Runs that exist but are out of reach: named by their exact ID or alias they are refused as `out_of_tree`, by name never found. */
	readonly outside?: readonly T[];
	/**
	 * The runs a name is meant to pick among - live ones for input - so that one live agent and an ended one of the same name are no
	 * ambiguity. An ID resolves to its run whatever it is, and the tool says why that run cannot be used.
	 */
	readonly eligible?: (run: T) => boolean;
}

/**
 * The run `reference` names among `candidates`, the runs in the caller's reach (RULES-2.3): an exact run ID; `#aN`; `name #aN` or
 * `@name #aN`, where the ID decides and the name only describes; or `@name`/`name` naming one agent. A FacadeError otherwise:
 * `ambiguous_reference` listing the IDs, `out_of_tree` for an ID out of reach, else `not_found`.
 */
export function resolveAgent<T extends Named>(reference: string, candidates: readonly T[], options: ResolveOptions<T> = {}): T {
	const text = reference.trim();
	if (/^#human$/i.test(text)) {
		throw new FacadeError('INVALID', 'invalid_argument', '#human is the person, not an agent.');
	}
	if (/^@?human$/i.test(text)) {
		// `@human` is the person unless an agent in reach is named so: then it is ambiguous, and `#human` or an ID decides (RULES-2.3)
		const named = candidates.filter(run => /^human$/i.test(run.name));
		throw named.length
			? new FacadeError('INVALID', 'ambiguous_reference', `@human names the person and ${named.length === 1 ? 'an agent' : `${named.length} agents`} named "human": ${named.map(run => `${referenceOf(run)} (${run.id})`).join(', ')}. Use #human for the person, or the agent's ID.`)
			: new FacadeError('INVALID', 'invalid_argument', '@human is the person, not an agent.');
	}
	const id = trailingId(text) ?? (candidates.some(run => run.id === text) || options.outside?.some(run => run.id === text) ? text : undefined);
	if (id !== undefined) {
		const named = (run: T) => run.id === id || run.alias === id;
		const found = candidates.filter(named);
		if (found.length > 1) {
			// Aliases are unique on this computer; should two windows ever show one, the run ID decides, never a guess (RULES-2.3)
			throw new FacadeError('INVALID', 'ambiguous_reference', `${id} names ${found.length} agents: ${found.map(run => `${referenceOf(run)} (${run.id})`).join(', ')}. Use the agent's run ID.`);
		}
		if (found.length) {
			return found[0];
		}
		if (options.outside?.some(named)) {
			throw new FacadeError('REFUSED', 'out_of_tree', `${id} is not in your creation tree, and without YOLO an agent reaches only the agents of its own tree.`);
		}
		throw notFound(reference);
	}
	const name = text.replace(/^@/, '');
	const named = candidates.filter(run => run.name === name || run.name === text);
	const eligible = options.eligible ? named.filter(options.eligible) : named;
	const choices = eligible.length ? eligible : named;
	if (choices.length === 1) {
		return choices[0];
	}
	if (choices.length > 1) {
		const listed = choices.map(run => `${referenceOf(run)} (${run.id})`).join(', ');
		throw new FacadeError('INVALID', 'ambiguous_reference', `${choices.length} agents are named ${JSON.stringify(name)}: ${listed}. A name shared by several agents needs an ID.`);
	}
	throw notFound(reference);
}

function notFound(reference: string): FacadeError {
	return new FacadeError('NOT_FOUND', 'not_found', `No agent ${JSON.stringify(reference)} was found.`);
}
