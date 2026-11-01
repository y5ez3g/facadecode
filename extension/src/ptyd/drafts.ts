/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A message's own draft, as its CLI draws it in its input (RULES-1.6, CLIS-2.1): its text, wrapped and indented as the CLI's rows
// draw it, or the placeholder that CLI draws for a paste of its size. A delivery presses Enter over its own draft alone.

import type { Hidden } from './composer';

/** The lines of a text, however its line breaks are written. */
const linesOf = (text: string) => text.split(/\r\n|\r|\n/u).length;
/** The characters of a text, as a CLI may count them: code points, or UTF-16 units; a line break one either way. */
const charsOf = (text: string) => {
	const flat = text.replace(/\r\n?/gu, '\n');
	return [[...flat].length, flat.length];
};

/** Text without its spaces and line breaks, which a CLI's rows add as they wrap and indent it. */
const squeezed = (text: string) => text.replace(/\s+/gu, '');

/** Pi's count of a paste's characters (D118): its line breaks one each, its tabs four spaces, other control characters dropped. */
const piCharsOf = (text: string) => [text.replace(/\r\n|\r/gu, '\n').replace(/\t/gu, '    ').replace(/[\x00-\x09\x0b-\x1f]/gu, '').length];

/** A placeholder its CLI draws for a long paste: whether a draft, squeezed, is it for a paste of `text`. */
interface Placeholder {
	readonly matches: (body: string, text: string) => boolean;
}

/** A placeholder that shows one count of the paste in `pattern`'s first group, which `counts` gives the ways its CLI may count. */
const counted = (pattern: RegExp, counts: (text: string) => readonly number[]): Placeholder => ({
	matches: (body, text) => {
		const count = pattern.exec(body)?.[1];
		return count !== undefined && counts(text).includes(Number(count));
	}
});

/** Each CLI's placeholders for a long paste, by its input reader, as squeezed (CLIS-2.1). */
export const PLACEHOLDERS: { readonly [adapter: string]: readonly Placeholder[] } = {
	// Claude Code's `[Pasted text #1 +N lines]` counts the lines after the first
	'claude-frame': [counted(/^\[Pastedtext#\d+\+(\d+)lines?\]$/u, text => [linesOf(text) - 1])],
	'agy-frame': [counted(/^\[Pastedtext#\d+\+(\d+)lines?\]$/u, text => [linesOf(text)])],
	// `[Pasted Content N chars]`
	'codex-prompt': [counted(/^\[PastedContent(\d+)chars?\]$/u, charsOf)],
	'muse-frame': [counted(/^\[PastedContent(\d+)chars?\]$/u, charsOf)],
	'pi-frame': [
		// `[paste #1 +N lines]` for more than ten lines
		counted(/^\[paste#\d+\+(\d+)lines?\]$/u, text => [linesOf(text)]),
		// `[paste #1 N chars]` for ten lines or fewer of more than 1,000 characters: squeezed, its number runs into its count
		{
			matches: (body, text) => {
				const digits = /^\[paste#(\d+)chars?\]$/u.exec(body)?.[1];
				return digits !== undefined && piCharsOf(text).some(count => digits.length > String(count).length && digits.endsWith(String(count)));
			}
		}
	],
	// `[Pasted ~N lines]`, from three lines on
	'opencode-frame': [counted(/^\[Pasted~(\d+)lines?\]$/u, text => [linesOf(text)])]
};

/** A draft as squeezed, and the same after `lead` where it begins with it: a ptyd from before leads types none. */
function bodiesOf(draft: string, lead: string | undefined): string[] {
	const drawn = squeezed(draft);
	const after = lead !== undefined && squeezed(lead) && drawn.startsWith(squeezed(lead)) ? drawn.slice(squeezed(lead).length) : undefined;
	return [drawn, ...after !== undefined ? [after] : []];
}

/**
 * Whether `body`, a draft squeezed, is `text` drawn whole - or, where its CLI scrolled rows of it out of its input box above and
 * none below, as its paste leaves it, the end of `text` up to its last character (D118).
 */
function isWritten(body: string, text: string, hidden: Hidden | undefined): boolean {
	const whole = squeezed(text);
	if (!hidden || (!hidden.above && !hidden.below)) {
		return body === whole;
	}
	return !hidden.below && body.length > 0 && whole.endsWith(body);
}

/**
 * Whether `draft`, an input as the CLI its reader `adapter` reads draws it, holds `text` alone (RULES-1.6, CLIS-2.1) - after `lead`
 * where that was typed, or without it, as a ptyd from before leads types it: the same characters, but for the spaces and line breaks
 * its rows wrap and indent them with, the rows it scrolled out of its box above where it says so in `hidden`, or the one placeholder
 * that CLI draws for a paste of its size. Anything a person added to it, or took from it, is not.
 */
export function isOwnDraft(draft: string, text: string, adapter: string, lead?: string, hidden?: Hidden): boolean {
	const placeholders = Object.hasOwn(PLACEHOLDERS, adapter) ? PLACEHOLDERS[adapter] : [];
	return bodiesOf(draft, lead).some(body => isWritten(body, text, hidden) || placeholders.some(each => each.matches(body, text)));
}

/**
 * Whether `draft`, held as `text`'s own, is the draft `seen` that its paste showed as (D118): drawn the same, or the text itself - a
 * placeholder's count alone could be a person's later paste of its size, its number being what tells them apart.
 */
export function isSameDraft(draft: string, seen: string, text: string, lead?: string, hidden?: Hidden): boolean {
	return squeezed(draft) === squeezed(seen) || bodiesOf(draft, lead).some(body => isWritten(body, text, hidden));
}
