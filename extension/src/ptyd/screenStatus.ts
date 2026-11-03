/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tested native screen evidence (CLIS-2.3): Muse's fallback where it sends no OSC 7501, and Codex 0.166.0's completed-turn
// correction of its aggregate working report. A reader vouches only for the layout its CLI was observed drawing; a
// completed screen it does not know revokes prior screen evidence. Logical lines retain the terminal's real soft wraps;
// hard line breaks are not guessed together. Text inside the input never supplies activity evidence.

import type { StatusKind } from './protocol';

/** A screen read as a status: working, not working, or waiting on the person for `kind`. */
export interface ScreenReading {
	readonly state: 'working' | 'idle' | 'blocked';
	readonly kind?: StatusKind;
}

/** A reader of the rows a run's terminal shows, top to bottom, each without the spaces at its end. */
export type ScreenReader = (rows: readonly string[], clippedStart?: boolean, boldHeads?: ReadonlySet<number>, dimLines?: ReadonlySet<number>, cols?: number) => ScreenReading | undefined;

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
const WORKING = /^[◈◆◇] \S.*\besc to interrupt\)$/u;
/**
 * What stands between its working row and its input while it works: its usage warning, its queued input with what is queued under
 * it, and blank rows.
 */
const USAGE = /^⚠ Usage /u;
const QUEUED = /^◆ Queued input(?: ·|$)/u;
/** Its complete footer identifies the input layout, independently of model names and effort choices. */
const FOOTER = /^ {2}\S.* · \S.* · \S.*$/u;
const HEADER = /^ {2}Muse Code \d+\.\d+\.\d+\b/;
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
			const below = rows.slice(bottom + 1).filter(row => row !== '');
			if (below.length === 1 && FOOTER.test(below[0])) {
				return prompt - 1;
			}
		}
	}
	return undefined;
}

/**
 * Muse Code's screen (1.4.12, 1.4.14): working while its working row stands above its input frame, past only what stands between
 * them; idle only in its complete known resting layout, empty or holding a draft; blocked on sign-in at its sign-in choice, on
 * permission at its trust question, which stand in place of the frame - their words above a frame, left from before, say nothing.
 * Anything else is no reading.
 */
export function museScreen(rows: readonly string[], clippedStart = false, boldHeads?: ReadonlySet<number>): ScreenReading | undefined {
	const frame = museFrame(rows);
	if (frame === undefined) {
		// A partial input frame is not an earlier login/trust prompt left in the conversation.
		if (rows.some(row => PROMPT.test(row) || UPPER_RULE.test(row))) { return undefined; }
		if (SIGN_IN.every(choice => rows.some(row => choice.test(row)))) {
			return { state: 'blocked', kind: 'auth' };
		}
		if (rows.some(row => TRUST.test(row))) {
			return { state: 'blocked', kind: 'permission' };
		}
		return undefined;
	}
	let row = frame - 1;
	const skipHints = () => {
		while (row >= 0 && (rows[row] === '' || USAGE.test(rows[row]))) { row--; }
	};
	skipHints();
	// Queued text is a distinct block. Do not skip arbitrary indented content: it may be an unfamiliar indicator.
	let queued = row;
	while (queued >= 0 && /^(?: {2}|└ )/u.test(rows[queued])) { queued--; }
	const hasQueue = queued >= 0 && QUEUED.test(rows[queued]);
	if (hasQueue) { row = queued - 1; skipHints(); }
	// Muse also uses a diamond for an answer. Its bold marker distinguishes it from the nonbold working animation.
	const answer = (at: number) => rows[at]?.startsWith('◆ ') && boldHeads?.has(at);
	if (row >= 0 && WORKING.test(rows[row]) && !answer(row) && !(row === 0 && clippedStart)) {
		return { state: 'working' };
	}
	if (hasQueue) { return undefined; }
	if (row < 0) { return undefined; }
	if (row === 0 && clippedStart) { return undefined; }
	// Positive layout boundaries: its startup header, a prior conversation block, or a now-dismissed native login/trust screen.
	if (HEADER.test(rows[row]) || TRUST.test(rows[row]) || SIGN_IN.some(choice => choice.test(rows[row]))) {
		return { state: 'idle' };
	}
	while (row >= 0 && rows[row].startsWith('  ')) { row--; }
	if (row >= 0 && !(row === 0 && clippedStart) && (/^(?:❯ |• )/u.test(rows[row]) || answer(row))) {
		return { state: 'idle' };
	}
	return undefined;
}

/**
 * Codex 0.166.0's positive finished-turn evidence, correcting only its aggregate root `working` (CLIS-2.3).
 * A background footer alone is also drawn during streamed answers. Require the native dim turn summary immediately
 * before it, with only spacing between, and the complete composer/footer below. Input text never decides activity.
 */
export const codexCompletedBackground: ScreenReader = (rows, clippedStart = false, _boldHeads, dimLines, cols) => {
	let model = rows.length - 1;
	while (model >= 0 && rows[model] === '') { model--; }
	if (/^ {2}(?:← for agents · )?\? for shortcuts(?: {2,}\S.*)?$/u.test(rows[model] ?? '')
		|| /^ {20,}\S.*$/u.test(rows[model] ?? '')) { model--; }
	if (model < 2 || !/^ {2}\S.*? · (?:[~/]|[A-Za-z]:\\)/u.test(rows[model]) || rows[model - 1] !== '') { return undefined; }
	let prompt = model - 2;
	while (prompt >= 0 && (rows[prompt] === '' || rows[prompt].startsWith('  '))) { prompt--; }
	if (prompt < 0 || !/^›(?: |$)/u.test(rows[prompt])) { return undefined; }
	let background = prompt - 1;
	while (background >= 0 && rows[background] === '') { background--; }
	const count = /^ {2}([1-9]\d*) background terminals? running/u.exec(rows[background] ?? '')?.[1];
	if (!count || !dimLines?.has(background)) { return undefined; }
	const footer = `  ${count} background terminal${count === '1' ? '' : 's'} running · /ps to view · /stop to close`;
	// Its footer is cropped, not soft-wrapped, at the right edge. Only that exact native prefix is known.
	if (rows[background] !== footer && (cols === undefined || rows[background] !== footer.slice(0, cols))) { return undefined; }
	let summary = background - 1;
	while (summary >= 0 && rows[summary] === '') { summary--; }
	if (summary < 0 || summary === 0 && clippedStart || !dimLines.has(summary)
		|| !/^ {2}Worked for (?:\d+[hms] ?)+ • \d{1,2}:\d{2}(?: [AP]M)?$/u.test(rows[summary])) { return undefined; }
	return { state: 'idle' };
};

/** The screen readers, by the ID a CLI adapter names (CLIS-2.3). */
const READERS: { readonly [id: string]: ScreenReader } = { muse: museScreen, 'codex-0.166': codexCompletedBackground };

/** The screen reader `id` names; none for no ID, or one ptyd does not know - a newer window's - which reads nothing. */
export function screenReaderOf(id: string | undefined): ScreenReader | undefined {
	return id !== undefined && Object.hasOwn(READERS, id) ? READERS[id] : undefined;
}
