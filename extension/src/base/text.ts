/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The command URI scheme, including the character references HTML links decode before their scheme is checked. */
const COMMAND_SCHEME = new RegExp(`(${
	[...'command'].map(letter => {
		const codes = [letter.charCodeAt(0), letter.toUpperCase().charCodeAt(0)];
		return `(?:${letter}|&#0*(?:${codes.join('|')});?|&#x0*(?:${codes.map(code => code.toString(16)).join('|')});?)`;
	}).join('')
})(:|&colon;?|&#0*58;?|&#x0*3a;?)`, 'gi');

/**
 * Markdown a person may open in VS Code: its editor allows command links, including reference, auto and HTML links. Breaks their URI
 * scheme with a zero-width space. The words and other Markdown stay readable, ordinary links stay usable, and repeating this does
 * nothing more. This is for a displayed record, never the text delivered to an agent (COLLABORATION-3.2).
 */
export function inertCommandLinks(text: string): string {
	return text.replace(COMMAND_SCHEME, '$1​$2');
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A bounded prefix in the requested units, cut only between complete visible characters. */
function truncate(text: string, max: number, length: (text: string) => number): string {
	if (length(text) <= max) { return text; }
	if (max <= 0) { return ''; }
	let used = 0;
	let end = 0;
	for (const { segment, index } of GRAPHEMES.segment(text)) {
		used += length(segment);
		if (used > max - 1) { break; }
		end = index + segment.length;
	}
	return `${text.slice(0, end).trimEnd()}…`;
}

/** `text` cut to at most `max` Unicode code points, ellipsis included, without splitting a grapheme. */
export function truncateCodePoints(text: string, max: number): string {
	return truncate(text, max, value => [...value].length);
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

/**
 * Untrusted text kept whole as several lines - a conversation's complete stored title (CLIS-2.4): invisible formatting removed, each
 * line break one `\n`, other controls as spaces, trimmed, never cut.
 */
export function displayLines(text: string): string {
	return text.replace(INVISIBLE_FORMATTING, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').trim();
}

/** A preview of at most `maxLength` UTF-16 units, including its ellipsis, cut only between complete graphemes. */
export function truncateText(text: string, maxLength: number): string {
	return truncate(text, maxLength, value => value.length);
}
