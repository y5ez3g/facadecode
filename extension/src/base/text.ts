/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `text` cut to at most `max` Unicode code points, its ellipsis included, cut only between whole code points: the display caps
 * of CLIS-2.3 and UX-1.2 count code points, not UTF-16 units.
 */
export function truncateCodePoints(text: string, max: number): string {
	const points = [...text];
	if (points.length <= max) {
		return text;
	}
	return max <= 0 ? '' : `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * Formatting that cannot be seen but changes how text reads (CLIS-2.3): zero-width space, direction marks, embeddings, overrides
 * and isolates, invisible operators and the byte-order mark. Joiners stay, as emoji sequences and some scripts need them.
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_FORMATTING = /[​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** C0 and C1 control characters, DEL among them. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Untrusted text - a CLI's title or status - as one line to display: invisible formatting removed, controls and line breaks as
 * spaces, runs of whitespace as one, trimmed, and at most `max` code points with an ellipsis (CLIS-2.3).
 */
export function displayLine(text: string, max: number): string {
	return truncateCodePoints(text.replace(INVISIBLE_FORMATTING, '').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim(), max);
}

/** A preview of at most `maxLength` UTF-16 units, including its ellipsis, cut only between complete Unicode code points. */
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength <= 0) {
		return '';
	}
	let end = maxLength - 1;
	if (end > 0 && text.codePointAt(end - 1)! > 0xffff) {
		end--;
	}
	return `${text.slice(0, end).trimEnd()}…`;
}
