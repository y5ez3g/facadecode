/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Card } from '../webview/protocol';

/**
 * What the host sends of a card's details as lines, as tests compare them (PANEL-1.5): `Agent: name · #aN` - who - then its conversation's
 * title where it has one, `Title: value`, and the agent that started it, `Started by: name #aN`. The page orders the rows, saying
 * `No title yet` or `Title unavailable` where there is no title, and when it started.
 */
export function linesOf(card: Pick<Card, 'details' | 'name' | 'alias'>): string[] {
	const { summary, startedBy } = card.details;
	return [
		`Agent: ${[card.name, card.alias].filter(Boolean).join(' · ')}`,
		...summary ? [`${summary.label}${summary.value}`] : [],
		...startedBy !== undefined ? [`Started by: ${startedBy}`] : []
	];
}

/** Where a card's agent works, as its details say it: `Location: …` then `Path: …`, one a line (PANEL-1.5). */
export function placeOf(card: Pick<Card, 'details'>): string {
	const { location, path } = card.details;
	return `${location.label}${location.value}\n${path.label}${path.value}`;
}
