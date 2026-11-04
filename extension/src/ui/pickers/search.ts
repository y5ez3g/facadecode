/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adds matches for the CLI behind a row's icon without putting its name back in the row (LIFECYCLE-2.3). Native Quick Pick still
 * matches/highlights visible fields. A CLI query can include visible words, such as "claude login"; every word must match.
 */
export function matchesCliSearch(query: string, cli: string, name: string, item: { readonly label: string; readonly description?: string }, place?: string): boolean {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const hidden = `${cli} ${name} ${place ?? ''}`.toLowerCase();
	const visible = `${item.label} ${item.description ?? ''}`.toLowerCase();
	return terms.some(term => hidden.includes(term)) && terms.every(term => hidden.includes(term) || visible.includes(term));
}
