/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a CLI that reports nothing of itself shows on its screen, read as its status (CLIS-2.3, D80): Muse Code, which sends no
// OSC 7501 on Windows. A reader knows the layout its CLI was observed drawing and vouches only for what that layout shows; a
// screen it does not know is no reading at all, which leaves the run's status as it was. Only rows of text are read, never cells
// a person typed into: the program's own marks decide.

import type { StatusKind } from './protocol';

/** A screen read as a status: working, not working, or waiting on the person for `kind`. */
export interface ScreenReading {
	readonly state: 'working' | 'idle' | 'blocked';
	readonly kind?: StatusKind;
}

/** A reader of the rows a run's terminal shows, top to bottom, each without the spaces at its end. */
export type ScreenReader = (rows: readonly string[]) => ScreenReading | undefined;

/** The top of Muse Code's input: a rule, with a label in it where it offers voice input - `── Voice input (Alt+V to start) ───`. */
const UPPER_RULE = /^(?:─{2} [^─]+ ─+|─+)$/;
/** A rule alone, the bottom of its input. */
const RULE = /^─+$/;
/** Its prompt row: `❯` at the start, then a space and the input, or nothing. */
const PROMPT = /^❯(?: |$)/;
/**
 * Its working row: one of its marks - not its prompt - then what it does and since when, `◈ Thinking (3s · esc to interrupt)`; it
 * stands above the input only while a turn goes on.
 */
const WORKING = /^[^\s❯] \S.*\besc to interrupt\)$/u;
/**
 * What stands between its working row and its input while it works: its usage warning, its queued input with what is queued under
 * it, and blank rows.
 */
const BETWEEN = /^(?:$| {2}|⚠ |◆ Queued input|└ )/u;
/** Its sign-in choice, in place of everything else until the person signs in. */
const SIGN_IN = [/^ *Log in with browser\b/, /^ *Set an API key\b/];
/** Its workspace trust question. */
const TRUST = /^Do you trust this workspace\?$/;

/**
 * Where Muse Code's input frame starts on the screen - its upper rule - found up from its bottom rule: the rows of the input, its
 * own indented two spaces or blank, then its prompt row, then the upper rule. Undefined where the screen shows none.
 */
function museFrame(rows: readonly string[]): number | undefined {
	for (let bottom = rows.length - 1; bottom >= 2; bottom--) {
		if (!RULE.test(rows[bottom])) {
			continue;
		}
		let prompt = bottom - 1;
		while (prompt > 0 && (rows[prompt] === '' || rows[prompt].startsWith('  '))) {
			prompt--;
		}
		if (PROMPT.test(rows[prompt]) && prompt > 0 && UPPER_RULE.test(rows[prompt - 1])) {
			return prompt - 1;
		}
	}
	return undefined;
}

/**
 * Muse Code's screen (1.4.12, 1.4.14): working while its working row stands above its input frame, past only what stands between
 * them; not working while the frame shows without it, empty or holding a draft; blocked on sign-in at its sign-in choice, on
 * permission at its trust question, which stand in place of the frame - their words above a frame, left from before, say nothing.
 * Anything else is no reading.
 */
export function museScreen(rows: readonly string[]): ScreenReading | undefined {
	const frame = museFrame(rows);
	if (frame === undefined) {
		if (SIGN_IN.every(choice => rows.some(row => choice.test(row)))) {
			return { state: 'blocked', kind: 'auth' };
		}
		if (rows.some(row => TRUST.test(row))) {
			return { state: 'blocked', kind: 'permission' };
		}
		return undefined;
	}
	for (let row = frame - 1; row >= 0; row--) {
		if (WORKING.test(rows[row])) {
			return { state: 'working' };
		}
		if (!BETWEEN.test(rows[row])) {
			break;
		}
	}
	return { state: 'idle' };
}

/** The screen readers, by the ID a CLI adapter names (CLIS-2.3). */
const READERS: { readonly [id: string]: ScreenReader } = { muse: museScreen };

/** The screen reader `id` names; none for no ID, or one ptyd does not know - a newer window's - which reads nothing. */
export function screenReaderOf(id: string | undefined): ScreenReader | undefined {
	return id !== undefined && Object.hasOwn(READERS, id) ? READERS[id] : undefined;
}
