/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a run's CLI can take an ordinary message now (RULES-1.4, CLIS-2.1, 2.3), read from the cells its headless terminal
// draws: its input found where its cursor is, and empty or holding a draft. Never from activity, tracked keystrokes or a key sent
// to see what happens. Each reader recognizes the one layout its CLI was observed drawing, whatever the CLI's version: a version
// that draws it differently is no layout the reader knows, and any screen it does not recognize is `unknown`, which delivery
// treats as unavailable input - nothing is typed into it.

import type { IBufferCell, Terminal } from '@xterm/headless';
import { drawnCells } from './screen';

/** What a reading found: a usable empty input, a draft in it, a native menu or question in its place, or nothing it can vouch for. */
export type InputState = 'usable' | 'draft' | 'interaction' | 'unknown';

/** A reading, with what it rests on in a few words: rows and shapes, never the text on the screen. */
export interface InputReading {
	readonly state: InputState;
	readonly evidence: string;
	/**
	 * A draft as it is drawn - its rows' text, or its CLI's placeholder for a long paste - so that a delivery knows its own message
	 * there (RULES-1.6, CLIS-2.1). It is compared, never logged.
	 */
	readonly draft?: string;
	/** The rows of a draft its CLI scrolled out of its input box, above and below what it shows, by the marks it draws for them (D118). */
	readonly hidden?: Hidden;
}

export interface Hidden {
	readonly above: number;
	readonly below: number;
}

/** Antigravity's marks of rows scrolled out of its input box, `↑ 1 more lines` first in it and `↓ 2 more lines` last. */
const MORE_ABOVE = /^↑ (\d+) more lines?$/u;
const MORE_BELOW = /^↓ (\d+) more lines?$/u;

/** One cell as drawn: its characters, the column it starts at, and whether they are dim or in inverse video. */
export interface InputCell {
	readonly chars: string;
	/** Its column, which a wide character before it in its row makes more than its place there. */
	readonly x: number;
	readonly dim: boolean;
	readonly inverse: boolean;
}

/** The rows the terminal shows, top to bottom, cell by cell - the second half of a wide character left out - and its cursor. */
export interface InputScreen {
	readonly rows: readonly (readonly InputCell[])[];
	/** The cursor's column - a cell's `x`, not its place in its row - and its row on the screen. */
	readonly cursor: { readonly x: number; readonly y: number };
	/** Whether the program is between the start and the end of a synchronized update (`CSI ? 2026 h`): what it draws is not whole yet. */
	readonly drawing?: boolean;
}

type Row = readonly InputCell[];

/** The rows the terminal shows now: its active buffer's screen, cell by cell, and where its cursor is. */
export function inputScreenOf(terminal: Terminal): InputScreen {
	const buffer = terminal.buffer.active;
	const rows: InputCell[][] = [];
	const cell: IBufferCell | undefined = buffer.getNullCell();
	for (let y = 0; y < terminal.rows; y++) {
		rows.push(drawnCells(buffer.getLine(buffer.baseY + y), cell, terminal.cols).map(drawn => ({ ...drawn, chars: drawn.chars || ' ' })));
	}
	return { rows, cursor: { x: buffer.cursorX, y: buffer.cursorY }, drawing: terminal.modes.synchronizedOutputMode };
}

/** The no-break space Claude Code puts between its prompt and its input. */
const NBSP = '\u00a0';

const charAt = (row: Row | undefined, x: number) => row?.[x]?.chars ?? ' ';
/** The cell at column `x`, found by its column: a wide character before it in the row puts it at a lower place there. */
const cellAt = (row: Row | undefined, x: number) => row?.find(cell => cell.x === x);
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
/** A draft's text as its rows draw it, the spaces at each row's end left out. */
const draftOf = (rows: readonly Row[]) => rows.map(row => textOf(row).trimEnd()).join('\n').trimEnd();

/**
 * A native menu as its CLI draws it in place of its input: its selected item and the item under it - or, for a question it draws
 * on one row, that row alone - and where a CLI draws its own lists that are no question, the hint row under the menu that only its
 * questions have, within so many rows.
 */
interface Menu {
	readonly selected: RegExp;
	readonly next?: RegExp;
	readonly hint?: { readonly row: RegExp; readonly within: number };
}

/** Where `menu` is drawn on the screen: the row of its selected item, or -1. */
function menuRow(rows: readonly Row[], menu: Menu): number {
	return rows.findIndex((row, y) => menu.selected.test(textOf(row))
		&& (!menu.next || menu.next.test(textOf(rows[y + 1])))
		&& (!menu.hint || rows.slice(y + 1, y + 1 + menu.hint.within).some(below => menu.hint!.row.test(textOf(below)))));
}

/** No input where the layout has it: one of its CLI's native menus where one is drawn, else nothing to vouch for. */
function noInput(rows: readonly Row[], menus: Menu | readonly Menu[], why: string): InputReading {
	for (const menu of Array.isArray(menus) ? menus as readonly Menu[] : [menus as Menu]) {
		const at = menuRow(rows, menu);
		if (at >= 0) {
			return { state: 'interaction', evidence: `${why}; ${menu.next ? 'a native menu\'s selected item' : 'a native question'} at row ${at + 1}` };
		}
	}
	return { state: 'unknown', evidence: why };
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
		// The rows under the prompt row are indented two columns; marks of rows scrolled out of the box are no part of the draft
		const drawn = [input[0], ...input.slice(1).map(row => row.slice(2))];
		const above = drawn.length > 1 ? MORE_ABOVE.exec(textOf(drawn[0]).trim())?.[1] : undefined;
		const below = drawn.length > 1 ? MORE_BELOW.exec(textOf(drawn[drawn.length - 1]).trim())?.[1] : undefined;
		const shown = drawn.slice(above !== undefined ? 1 : 0, below !== undefined ? -1 : undefined);
		return {
			state: 'draft', evidence: `${where} holds text${above !== undefined || below !== undefined ? ', scrolled' : ''}`, draft: draftOf(shown),
			...above !== undefined || below !== undefined ? { hidden: { above: Number(above ?? 0), below: Number(below ?? 0) } } : {}
		};
	}
	if (input.slice(1).some(row => !isBlank(row))) {
		return { state: 'unknown', evidence: `${where} holds dim text under its prompt row, which is no placeholder` };
	}
	if (cursor.y !== prompt || cursor.x !== 2) {
		return { state: 'unknown', evidence: `${where} is empty, its cursor away from where the input starts` };
	}
	return { state: 'usable', evidence: `${where} is empty${isBlank(input[0]) ? '' : ' but for its dim placeholder'}` };
}

/** An input drawn between two rules, as Claude Code, Muse Code and Antigravity draw theirs. */
interface FrameLayout {
	/** The prompt at the start of its first row. */
	readonly prompt: string;
	/** What follows the prompt on its prompt row where something comes after it. */
	readonly gap: string;
	/** Its upper rule: plain, or with a label in it. */
	readonly upper: RegExp;
	/** The row right under its lower rule, where only a frame with it is its CLI's. */
	readonly footer?: RegExp;
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
	prompt: '❯',
	gap: NBSP,
	upper: /^(?:─+|─{3} [^─]+ ─+)$/,
	menu: { selected: /^ ❯ \S/, next: /^ {3}\S/ }
};

/**
 * Muse Code's input, as 1.4.14 was observed drawing it: a rule - with its label where it offers voice input, `── Voice input (⌥ + v
 * to start) ───`, plain where it does not - then its prompt row, `❯` and a space before the input (`❯` alone while empty), the draft
 * going on in rows indented two spaces - its slash menu among them - then a plain rule, and right under it its own line of the model,
 * its effort and the folder, `  muse-spark-1.3 · max · /work/app`. Its trust question draws no frame but a menu, `⟩ 1  Trust and
 * continue` with `  2  Quit` under it.
 */
const MUSE_FRAME: FrameLayout = {
	prompt: '❯',
	gap: ' ',
	upper: /^(?:─+|─{2} [^─]+ ─+)$/,
	footer: /^ {2}\S[^·]*? · \S/,
	menu: { selected: /^⟩ \d+ +\S/, next: /^ {2}\d+ +\S/ }
};

/**
 * Antigravity's input, as 1.4.12 was observed drawing it: a plain rule, then its prompt row, `>` and a space before the input (`>`
 * alone while empty), the draft going on in rows indented two spaces - a long paste as `[Pasted text #1 +33 lines]` - then a plain
 * rule; its slash menu is drawn under the frame, its own earlier messages above it begin `> ` too. Its trust and permission
 * questions draw no frame but a menu, its selected item `> Yes, I trust this folder` or `> 1. Yes, run command` with the next item
 * under it and its hint `  ↑/↓ Navigate · …` below, which its slash menu - its items commands, `/add-dir` - shares.
 */
const AGY_FRAME: FrameLayout = {
	prompt: '>',
	gap: ' ',
	upper: /^─+$/,
	menu: { selected: /^> (?!\/)\S/, next: /^ {2}\S/, hint: { row: /^ {2}↑\/↓ Navigate · /, within: 8 } }
};

/** A frame's prompt row: its prompt at its start, then its gap and the input, or nothing at all. */
function isPrompt(row: Row, layout: FrameLayout): boolean {
	return charAt(row, 0) === layout.prompt && (charAt(row, 1) === layout.gap || isBlank(row.slice(1)));
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
	if (lower >= rows.length || (layout.footer && !layout.footer.test(textOf(rows[lower + 1])))) {
		return noInput(rows, layout.menu, why);
	}
	return contentOf(rows, prompt, lower, cursor, 'the input frame');
}

/** Codex's native menus, drawn in place of its input: its trust question's `› 1. Trust and continue`, `  2. ...` under it. */
const CODEX_MENU: Menu = { selected: /^› \d+\. \S/, next: /^ {2}\d+\. \S/ };
/** Its footer's first row: the model and the folder, `  GPT-… max · /work/app`, maybe more after them. */
const CODEX_MODEL = /^ {2}\S.*? · (?:[~/]|[A-Za-z]:\\)/;
/**
 * A row of hints under it: `  ← for agents · ? for shortcuts`, or `  tab to queue message` while it works - 0.166.0 draws a status
 * at its right end too, `⚠ 1 warning · f2 to view`, alone on the row while a draft hides its hints.
 */
const CODEX_HINTS = /^ {2}(?:\S.*? · )?(?:\? for shortcuts|tab to queue message)(?: {2,}\S.*?)? *$|^ {20,}\S.*$/;

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

/** Pi's upper rule: plain, with its scroll mark ` ↑ 3 more `, or with its working status after its first two, `── ⠋ Working ───`. */
const PI_UPPER = /^(?:─+|─{2,} \S.*? ─+)$/;
/** Its lower rule: plain, or with its scroll mark ` ↓ 3 more `. */
const PI_LOWER = /^─+(?: ↓ \d+ more ─+)?$/;
/** The rows its scroll marks say are out of its editor, above and below. */
const PI_ABOVE = /^─{2,} ↑ (\d+) more ─+$/;
const PI_BELOW = /^─+ ↓ (\d+) more ─+$/;
/** Its footer's row of figures, which ends in the context it has used: `↑637 ↓15 … 1.3%/131k (auto)`, `?/131k` before it knows. */
const PI_STATS = /(?:^|\s)(?:\d+\.\d%|\?)\/\d+(?:\.\d)?[kM]?(?: \(auto\))?(?:\s|$)/;
/**
 * Its questions and pickers, drawn in place of its editor: a selected item `→ Trust` or `→ ✓ qwen3.8-flash`, the next under it, and
 * their hint `… escape/ctrl+c cancel` below them, which its slash menu has none of.
 */
const PI_MENU: Menu = { selected: /^ ?→ \S/, next: /^ {2,4}\S/, hint: { row: /[Ee]scape\/[Cc]trl\+[Cc]/, within: 40 } };

/**
 * Pi's editor, as 1.4.0 was observed drawing it, which has no prompt: two rules across the terminal with the input between them,
 * from its first column - a long paste as `[paste #1 +33 lines]` - at most 30% of the terminal's rows, at least five, and its own
 * cursor in inverse video where the terminal's is; its slash menu under the lower rule; then its footer at the bottom - the folder,
 * then a row of figures ending in the context used, maybe an extension's status under it. Its questions and pickers draw their own
 * rules in place of the editor, taller than it can be.
 */
function readPiEditor(screen: InputScreen): InputReading {
	const { rows, cursor } = screen;
	let stats = rows.length - 1;
	while (stats >= 0 && isBlank(rows[stats])) {
		stats--;
	}
	if (stats >= 1 && !PI_STATS.test(textOf(rows[stats])) && PI_STATS.test(textOf(rows[stats - 1]))) {
		// An extension's status under it
		stats--;
	}
	if (stats < 3 || !PI_STATS.test(textOf(rows[stats])) || isBlank(rows[stats - 1])) {
		return noInput(rows, PI_MENU, 'no footer of its folder and context at the bottom');
	}
	let lower = stats - 2;
	while (lower >= 0 && !PI_LOWER.test(textOf(rows[lower]))) {
		lower--;
	}
	let upper = lower - 1;
	while (upper >= 0 && !PI_UPPER.test(textOf(rows[upper]))) {
		upper--;
	}
	const height = lower - upper - 1;
	if (upper < 0 || height < 1 || height > Math.max(5, Math.floor(rows.length * 0.3))) {
		return noInput(rows, PI_MENU, 'no editor between two rules above its footer');
	}
	const top = upper + 1;
	const where = `the editor at ${height > 1 ? `rows ${top + 1}-${lower}` : `row ${lower}`}`;
	if (cursor.y < top || cursor.y >= lower || !cellAt(rows[cursor.y], cursor.x)?.inverse) {
		return { state: 'unknown', evidence: `${where} does not have its own cursor where the cursor is, at row ${cursor.y + 1}` };
	}
	const input = rows.slice(top, lower);
	if (input.some(row => row.some(isText))) {
		const above = PI_ABOVE.exec(textOf(rows[upper]))?.[1];
		const below = PI_BELOW.exec(textOf(rows[lower]))?.[1];
		return {
			state: 'draft', evidence: `${where} holds text${above !== undefined || below !== undefined ? ', scrolled' : ''}`, draft: draftOf(input),
			...above !== undefined || below !== undefined ? { hidden: { above: Number(above ?? 0), below: Number(below ?? 0) } } : {}
		};
	}
	// Its padding, a setting, puts the start of an empty editor at most three columns in
	if (height > 1 || cursor.x > 3) {
		return { state: 'unknown', evidence: `${where} is empty, its cursor away from where the input starts` };
	}
	return { state: 'usable', evidence: `${where} is empty` };
}

/**
 * OpenCode's questions in place of its input: its permission request, `┃  △ Permission required`, and a dialog's title row with `esc`
 * at its end, `Commands … esc`.
 */
const OPENCODE_MENUS: readonly Menu[] = [{ selected: /^ *┃ {2}△ Permission required *$/ }, { selected: /^ +\S.*? {2,}esc *$/ }];
/** Its placeholder, the same color as text: `Ask anything… "Fix broken tests"`, in shell mode `Run a command… "ls -la"`. */
const OPENCODE_PLACEHOLDER = /^(?:Ask anything|Run a command)… "/;

/**
 * OpenCode's input box, as 2.1.4 was observed drawing it: a bar `┃` down its left side - a blank row, the input's rows two columns
 * after the bar, a blank row, the row of its agent and model - and its bottom `╹▀▀▀`. A paste of three lines or more shows as
 * `[Pasted ~3 lines]`. It draws no attribute but colors, so its placeholder is known by its words. Its own earlier messages above it
 * have the same bar, with a blank row between: a box the screen gives no way to tell from one of them is nothing to vouch for.
 */
function readOpenCodeBox(screen: InputScreen): InputReading {
	const { rows, cursor } = screen;
	const bar = rows[cursor.y].findIndex(shows);
	const why = `no input box around the cursor at row ${cursor.y + 1}`;
	const barRow = (y: number) => charAt(rows[y], bar) === '┃' && !rows[y].slice(0, bar).some(shows);
	// The box's own rows have nothing in the two columns after the bar: a menu over it starts its items there
	const boxRow = (y: number) => barRow(y) && charAt(rows[y], bar + 1) === ' ' && charAt(rows[y], bar + 2) === ' ';
	const blankRow = (y: number) => barRow(y) && isBlank(rows[y].slice(bar + 1));
	if (bar < 0 || !boxRow(cursor.y) || cursor.x < bar + 3) {
		return noInput(rows, OPENCODE_MENUS, why);
	}
	let border = cursor.y + 1;
	while (border < rows.length && barRow(border)) {
		border++;
	}
	const pad = border - 2;
	if (border >= rows.length || charAt(rows[border], bar) !== '╹' || charAt(rows[border], bar + 1) !== '▀' || pad <= cursor.y
		|| !blankRow(pad) || !boxRow(border - 1) || isBlank(rows[border - 1].slice(bar + 3))) {
		return noInput(rows, OPENCODE_MENUS, why);
	}
	let top = cursor.y - 1;
	while (top >= 0 && boxRow(top) && !blankRow(top)) {
		top--;
	}
	if (top < 0 || !blankRow(top)) {
		return noInput(rows, OPENCODE_MENUS, why);
	}
	const where = `the input box at ${pad - top > 2 ? `rows ${top + 2}-${pad}` : `row ${pad}`}`;
	if (top > 0 && boxRow(top - 1)) {
		// The blank row over the input is an empty line of it with more above, or the box stands right under a message of its own
		return blankRow(top - 1)
			? { state: 'unknown', evidence: `${where} has the bar of something else right above it` }
			: { state: 'draft', evidence: `${where} holds text above an empty line` };
	}
	const input = rows.slice(top + 1, pad).map(row => row.slice(bar + 3));
	const atStart = input.length === 1 && cursor.y === top + 1 && cursor.x === bar + 3;
	const away = { state: 'unknown', evidence: `${where} is empty, its cursor away from where the input starts` } as const;
	if (input.length === 1 && OPENCODE_PLACEHOLDER.test(textOf(input[0]))) {
		return atStart ? { state: 'usable', evidence: `${where} is empty but for its placeholder` } : away;
	}
	if (input.some(row => row.some(isText))) {
		return { state: 'draft', evidence: `${where} holds text`, draft: draftOf(input) };
	}
	return atStart ? { state: 'usable', evidence: `${where} is empty` } : away;
}

/** The input readers by the ID a CLI adapter names (CLIS-2.1): what each reads. */
const READERS: { readonly [adapter: string]: (screen: InputScreen) => InputReading } = {
	'claude-frame': screen => readFrame(screen, CLAUDE_FRAME),
	'codex-prompt': readCodexPrompt,
	'agy-frame': screen => readFrame(screen, AGY_FRAME),
	'muse-frame': screen => readFrame(screen, MUSE_FRAME),
	'pi-frame': readPiEditor,
	'opencode-frame': readOpenCodeBox
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
