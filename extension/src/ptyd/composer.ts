/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a run's CLI can take an ordinary message now (RULES-1.4, CLIS-2.1, 2.3), read from the cells its headless terminal
// draws: its input found where its cursor is, and empty or holding a draft. Never from activity, tracked keystrokes or a key sent
// to see what happens. Each reader recognizes the one layout its CLI was observed drawing, whatever the CLI's version: a version
// that draws it differently is no layout the reader knows, and any screen it does not recognize is `unknown`, which delivery
// treats as unavailable input - nothing is typed into it.

import type { IBufferCell, Terminal } from '@xterm/headless';

/** What a reading found: a usable empty input, a draft in it, a native menu or question in its place, or nothing it can vouch for. */
export type InputState = 'usable' | 'draft' | 'interaction' | 'unknown';

/** A reading, with what it rests on in a few words: rows and shapes, never the text on the screen. */
export interface InputReading {
	readonly state: InputState;
	readonly evidence: string;
}

/** One cell as drawn: its characters, and whether they are dim or in inverse video. */
export interface InputCell {
	readonly chars: string;
	readonly dim: boolean;
	readonly inverse: boolean;
}

/** The rows the terminal shows, top to bottom, cell by cell - the second half of a wide character left out - and its cursor. */
export interface InputScreen {
	readonly rows: readonly (readonly InputCell[])[];
	/** The cursor's column and its row on the screen. */
	readonly cursor: { readonly x: number; readonly y: number };
	/** Whether the program is between the start and the end of a synchronized update (`CSI ? 2026 h`): what it draws is not whole yet. */
	readonly drawing?: boolean;
}

type Row = readonly InputCell[];

/** The rows the terminal shows now: its active buffer's screen, cell by cell, and where its cursor is. */
export function inputScreenOf(terminal: Terminal): InputScreen {
	const buffer = terminal.buffer.active;
	const rows: InputCell[][] = [];
	let cell: IBufferCell | undefined;
	for (let y = 0; y < terminal.rows; y++) {
		const line = buffer.getLine(buffer.baseY + y);
		const row: InputCell[] = [];
		for (let x = 0; line && x < terminal.cols; x++) {
			cell = line.getCell(x, cell);
			if (!cell || cell.getWidth() === 0) {
				// The second half of a wide character: drawn by the cell before it
				continue;
			}
			row.push({ chars: cell.getChars() || ' ', dim: cell.isDim() !== 0, inverse: cell.isInverse() !== 0 });
		}
		rows.push(row);
	}
	return { rows, cursor: { x: buffer.cursorX, y: buffer.cursorY }, drawing: terminal.modes.synchronizedOutputMode };
}

/** The no-break space Claude Code puts between its prompt and its input. */
const NBSP = '\u00a0';

const charAt = (row: Row | undefined, x: number) => row?.[x]?.chars ?? ' ';
const textOf = (row: Row | undefined) => (row ?? []).map(cell => cell.chars).join('');
/** Whether a cell shows something: a character, not a space of any kind. */
const shows = (cell: InputCell) => cell.chars.trim() !== '';
const isBlank = (row: Row) => !row.some(shows);
/** Text of the person's or Facade's: shown and not dim, inverse or not. Dim is a CLI's placeholder or hint. */
const isText = (cell: InputCell) => shows(cell) && !cell.dim;
/** A row of a field indented under its first: two spaces first, or nothing on it. */
const isContinuation = (row: Row) => charAt(row, 0) === ' ' && charAt(row, 1) === ' ';
/** A rule across the terminal: `─` alone, from its first column to its last. */
const isRule = (row: Row) => /^─+$/.test(textOf(row));

/** A native menu as its CLI draws it in place of its input: its selected item, and the item under it. */
interface Menu {
	readonly selected: RegExp;
	readonly next: RegExp;
}

/** Where `menu` is drawn on the screen: the row of its selected item, or -1. */
function menuRow(rows: readonly Row[], menu: Menu): number {
	return rows.findIndex((row, y) => menu.selected.test(textOf(row)) && menu.next.test(textOf(rows[y + 1])));
}

/** No input where the layout has it: a native menu where one is drawn, else nothing to vouch for. */
function noInput(rows: readonly Row[], menu: Menu, why: string): InputReading {
	const at = menuRow(rows, menu);
	return at >= 0 ? { state: 'interaction', evidence: `${why}; a native menu's selected item at row ${at + 1}` } : { state: 'unknown', evidence: why };
}

/**
 * The input's rows - the prompt row after its two columns of prompt, then the rows under it - read as a draft where any cell holds
 * text; as usable where nothing does but a dim placeholder on the prompt row, with the cursor where the input starts; otherwise as
 * nothing to vouch for: dim text elsewhere, or an empty input with the cursor away from its start, is no layout that was observed.
 */
function contentOf(rows: readonly Row[], prompt: number, end: number, cursor: InputScreen['cursor'], what: string): InputReading {
	const input = [rows[prompt].slice(2), ...rows.slice(prompt + 1, end)];
	const where = `${what} at ${input.length > 1 ? `rows ${prompt + 1}-${end}` : `row ${end}`}`;
	if (input.some(row => row.some(isText))) {
		return { state: 'draft', evidence: `${where} holds text` };
	}
	if (input.slice(1).some(row => !isBlank(row))) {
		return { state: 'unknown', evidence: `${where} holds dim text under its prompt row, which is no placeholder` };
	}
	if (cursor.y !== prompt || cursor.x !== 2) {
		return { state: 'unknown', evidence: `${where} is empty, its cursor away from where the input starts` };
	}
	return { state: 'usable', evidence: `${where} is empty${isBlank(input[0]) ? '' : ' but for its dim placeholder'}` };
}

/** An input drawn between two rules, as Claude Code draws its own. */
interface FrameLayout {
	/** What follows `❯` on its prompt row where something comes after it. */
	readonly gap: string;
	/** Its upper rule: plain, or with a label in it. */
	readonly upper: RegExp;
	/** Its native menus, which it draws with no frame. */
	readonly menu: Menu;
}

/**
 * Claude Code's input, as 2.1.312 was observed drawing it: a rule - plain, or `─── History 1/1 ───` - then its prompt row, `❯` and a
 * no-break space before the input or its dim placeholder (`❯` alone once emptied), the draft going on in rows indented two spaces,
 * then a plain rule. Its slash menu is drawn above the frame. Its permission and trust questions draw no frame but a menu, its
 * selected item ` ❯ 1. Yes` or ` ❯ No, exit` with the next item under it.
 */
const CLAUDE_FRAME: FrameLayout = {
	gap: NBSP,
	upper: /^(?:─+|─{3} [^─]+ ─+)$/,
	menu: { selected: /^ ❯ \S/, next: /^ {3}\S/ }
};

/** A frame's prompt row: `❯` at its start, then its gap and the input, or nothing at all. */
function isPrompt(row: Row, layout: FrameLayout): boolean {
	return charAt(row, 0) === '❯' && (charAt(row, 1) === layout.gap || isBlank(row.slice(1)));
}

/** The frame the cursor is in: up from the cursor to its prompt row under the upper rule, down to its lower rule. */
function readFrame(screen: InputScreen, layout: FrameLayout): InputReading {
	const { rows, cursor } = screen;
	const why = `no input frame around the cursor at row ${cursor.y + 1}`;
	let prompt = cursor.y;
	while (prompt >= 0 && !isPrompt(rows[prompt], layout)) {
		if (!isContinuation(rows[prompt])) {
			return noInput(rows, layout.menu, why);
		}
		prompt--;
	}
	if (prompt < 1 || !layout.upper.test(textOf(rows[prompt - 1]))) {
		return noInput(rows, layout.menu, why);
	}
	let lower = prompt + 1;
	while (lower < rows.length && !isRule(rows[lower])) {
		if (!isContinuation(rows[lower])) {
			return noInput(rows, layout.menu, why);
		}
		lower++;
	}
	if (lower >= rows.length) {
		return noInput(rows, layout.menu, why);
	}
	return contentOf(rows, prompt, lower, cursor, 'the input frame');
}

/** Codex's native menus, drawn in place of its input: its trust question's `› 1. Trust and continue`, `  2. ...` under it. */
const CODEX_MENU: Menu = { selected: /^› \d+\. \S/, next: /^ {2}\d+\. \S/ };
/** Its footer's first row: the model and the folder, `  GPT-… max · /work/app`, maybe more after them. */
const CODEX_MODEL = /^ {2}\S.*? · (?:[~/]|[A-Za-z]:\\)/;
/** A row of hints under it: `  ← for agents · ? for shortcuts`, or `  tab to queue message` while it works. */
const CODEX_HINTS = /^ {2}(?:\S.*? · )?(?:\? for shortcuts|tab to queue message) *$/;

/**
 * Codex's input, as 0.165.0 was observed drawing it, which has no frame: its footer at the bottom of what it draws - the model line, and a row of hints under
 * it where there is one - with a blank row above it, and above that its input: a prompt row `› ` with the input or its dim
 * placeholder, the draft going on in rows indented two spaces. Its own earlier messages begin `› ` too, higher up: the input is the
 * one above the footer, the cursor in it. Its slash menu is drawn above the input.
 */
function readCodexPrompt(screen: InputScreen): InputReading {
	const { rows, cursor } = screen;
	let model = rows.length - 1;
	while (model >= 0 && isBlank(rows[model])) {
		model--;
	}
	if (model >= 0 && CODEX_HINTS.test(textOf(rows[model]))) {
		model--;
	}
	if (model < 2 || !CODEX_MODEL.test(textOf(rows[model])) || !isBlank(rows[model - 1])) {
		return noInput(rows, CODEX_MENU, 'no model line of its footer at the bottom');
	}
	const end = model - 1;
	let prompt = end - 1;
	while (prompt >= 0 && !(charAt(rows[prompt], 0) === '›' && charAt(rows[prompt], 1) === ' ')) {
		if (!isContinuation(rows[prompt])) {
			return noInput(rows, CODEX_MENU, 'no prompt row above its footer');
		}
		prompt--;
	}
	if (prompt < 0) {
		return noInput(rows, CODEX_MENU, 'no prompt row above its footer');
	}
	if (cursor.y < prompt || cursor.y >= end) {
		return noInput(rows, CODEX_MENU, `the cursor at row ${cursor.y + 1} is not in the input above its footer`);
	}
	return contentOf(rows, prompt, end, cursor, 'the input');
}

/** The input readers by the ID a CLI adapter names (CLIS-2.1): what each reads. */
const READERS: { readonly [adapter: string]: (screen: InputScreen) => InputReading } = {
	'claude-frame': screen => readFrame(screen, CLAUDE_FRAME),
	'codex-prompt': readCodexPrompt
};

export const INPUT_ADAPTERS: readonly string[] = Object.keys(READERS);

/** Reads `screen`'s input with `adapter`: an adapter ptyd does not know, or a screen still being drawn, is `unknown`. */
export function readInput(screen: InputScreen, adapter: string): InputReading {
	const read = Object.hasOwn(READERS, adapter) ? READERS[adapter] : undefined;
	if (!read) {
		return { state: 'unknown', evidence: `no input adapter ${JSON.stringify(adapter)}` };
	}
	if (screen.drawing) {
		return { state: 'unknown', evidence: 'its program is in the middle of a synchronized update' };
	}
	if (screen.cursor.y < 0 || screen.cursor.y >= screen.rows.length) {
		return { state: 'unknown', evidence: 'its cursor is not on the screen' };
	}
	return read(screen);
}
