/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A probe tells a hint from a draft where an input's only row may be either (CLIS-2.1): a space typed where the input starts, then
// Backspace. These compare the row before and after each key; the log gets the row's shape, never its text (ARCHITECTURE-3.3).

import type { InputLine, InputReading } from '../ptyd/protocol';

/** What a probe found the row to be: a hint over an empty input, a draft, or neither for sure. */
export type ProbeVerdict = 'hint' | 'draft' | 'other';

/** The row's characters, a cell each: a blank cell is a space. */
const charsOf = (line: InputLine): readonly string[] => line.cells.map(cell => cell.chars);
const isBlank = (line: InputLine) => line.cells.every(cell => cell.chars.trim() === '');

/** The row as a key of a run's probes: every cell's characters, dim and color. */
export function lineKey(line: InputLine): string {
	return JSON.stringify(line.cells.map(cell => [cell.chars, cell.dim, cell.colored]));
}

/** Whether two readings of the row are the same: its place, cells and cursor, and whether rows under it show something. */
export function sameLine(a: InputLine | undefined, b: InputLine | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return a.y === b.y && a.start === b.start && a.rest === b.rest && a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y && lineKey(a) === lineKey(b);
}

/**
 * `before`'s characters with a space at the cursor's column, as a draft takes one typed there; none where a character shows ahead of
 * the cursor. Its place is found by column from where the input starts: a cell is a column only while it is blank, as a wide character
 * takes two columns and one cell.
 */
function spaced(before: InputLine): string | undefined {
	const chars = charsOf(before);
	let at = 0;
	for (let column = before.start; column < before.cursor.x; column++, at++) {
		if (at < chars.length && chars[at].trim() !== '') {
			return undefined;
		}
	}
	return [...chars.slice(0, at), ' ', ...chars.slice(at)].join('');
}

/**
 * Whether the space went in, by the cursor and the characters alone: the cursor one column on in the same row, and the row the space
 * ahead of what it showed, or the space alone.
 */
export function spaceTaken(before: InputLine, after: InputLine | undefined): boolean {
	return after !== undefined && after.y === before.y && after.cursor.y === before.cursor.y && after.cursor.x === before.cursor.x + 1
		&& (isBlank(after) || spaced(before) !== undefined && charsOf(after).join('') === spaced(before));
}

/**
 * What the row was, once the space went in, by the characters alone: gone, the space left alone, a hint; there still behind the
 * space, a draft; anything else - a row under it, a menu or question - neither for sure.
 */
export function verdictOf(before: InputLine, after: InputReading): ProbeVerdict {
	const line = after.line;
	if (after.state === 'interaction' || line === undefined || line.rest || !spaceTaken(before, line)) {
		return 'other';
	}
	return isBlank(line) ? 'hint' : 'draft';
}

/**
 * Whether Backspace put the input back, every cell and the cursor compared: for a hint, an empty input, or a hint again - maybe
 * another - with the cursor where the input starts and nothing under it; else the row exactly as before the space.
 */
export function restored(verdict: ProbeVerdict, before: InputLine, after: InputReading): boolean {
	const line = after.line;
	if (verdict === 'hint' && (after.state === 'usable'
		|| after.unsure === true && line !== undefined && !line.rest && line.cursor.x === before.cursor.x && line.cursor.y === before.cursor.y)) {
		return true;
	}
	return sameLine(before, line);
}

/**
 * The row's shape for Show Agents Log, never its text (ARCHITECTURE-3.3): its row, its cells in runs - `t` text, `d` dim, `c` colored,
 * `_` blank - the cursor's column, and whether rows under it show something.
 */
export function shapeOf(line: InputLine | undefined): string {
	if (line === undefined) {
		return 'no input row';
	}
	const runs: string[] = [];
	let last = '';
	let count = 0;
	for (const cell of line.cells) {
		const kind = cell.chars.trim() === '' ? '_' : cell.dim ? 'd' : cell.colored ? 'c' : 't';
		if (kind !== last && count > 0) {
			runs.push(`${count}${last}`);
			count = 0;
		}
		last = kind;
		count++;
	}
	if (count > 0) {
		runs.push(`${count}${last}`);
	}
	return `row ${line.y + 1} from column ${line.start + 1}: ${line.cells.length} cells [${runs.join(' ')}], cursor at column ${line.cursor.x + 1}${line.rest ? ', rows under it' : ''}`;
}
