/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A run's screen read from ptyd's headless terminal (MCP-5.1): its logical lines, each annotated and as plain text.

import type { IBuffer, IBufferCell, IBufferLine, Terminal } from '@xterm/headless';

export const MOST_SCREEN_LINES = 2_000;

/** Where a screen was read from: the normal buffer with its scrollback, or a full-screen program's alternate buffer. */
export type AgentScreenBuffer = 'normal' | 'alternate';

/** A terminal's screen as text. */
export interface IAgentScreen {
	/** Its lines, top to bottom: inverse-video text marked `[[...]]`, dim text `{{...}}`. */
	readonly lines: readonly string[];
	/** The same lines as plain text, without marks. */
	readonly text: readonly string[];
	readonly buffer: AgentScreenBuffer;
	/** Whether the buffer holds lines with something on them above those read. */
	readonly older: boolean;
	/** Whether the terminal let go of lines above all those it holds: its scrollback is full. */
	readonly trimmed: boolean;
}

const enum Mark {
	None = 0,
	Inverse = 1,
	Dim = 2
}

/** A cell of a line as `readScreen` writes it: its characters, and how they are marked. */
interface IScreenCell {
	readonly chars: string;
	readonly mark: Mark;
}

/** A cell as its row draws it: its characters - empty where nothing was drawn there - the column it starts at, and its marks. */
export interface DrawnCell {
	readonly chars: string;
	/** Its column: a wide character takes two, the second drawn by the first and no cell of its own. */
	readonly x: number;
	readonly dim: boolean;
	readonly inverse: boolean;
}

/**
 * The cells of `line` up to `cols`, left to right, each with the column it starts at: every reader of a terminal's rows walks them so,
 * and finds a column by a cell's `x`, never by its place in the row, which a wide character before it moves (CLIS-2.1).
 */
export function drawnCells(line: IBufferLine | undefined, cell: IBufferCell | undefined, cols = line?.length ?? 0): DrawnCell[] {
	const cells: DrawnCell[] = [];
	for (let x = 0; line && x < cols; x++) {
		const read = line.getCell(x, cell);
		// The second half of a wide character, drawn by the first
		if (!read || read.getWidth() === 0) {
			continue;
		}
		cells.push({ chars: read.getChars(), x, dim: read.isDim() !== 0, inverse: read.isInverse() !== 0 });
	}
	return cells;
}

/**
 * The bottom `count` lines of `raw`'s active buffer - or of the one asked for - as the terminal draws them:
 * the rows a line wraps over joined into one line, blank lines between kept, the spaces a line ends in cut,
 * text in inverse video marked `[[...]]` and dim text `{{...}}` - an item picked by its colors, a cursor a
 * program draws itself, a placeholder, a hint. From the first row with something on it to the lowest of the
 * last such row and the cursor's. The marks are for a reader, not a way back to the terminal's cells.
 */
export function readScreen(raw: Terminal, count: number, which: AgentScreenBuffer | 'active' = 'active'): IAgentScreen {
	const buffer = which === 'active' ? raw.buffer.active : raw.buffer[which];
	const cell = buffer.getNullCell();
	const cursorRow = buffer.baseY + buffer.cursorY;
	let row = buffer.length - 1;
	while (row > cursorRow && isBlankRow(buffer.getLine(row), cell)) {
		row--;
	}
	const lines: string[] = [];
	const text: string[] = [];
	while (row >= 0 && lines.length < count) {
		let start = row;
		while (start > 0 && buffer.getLine(start)?.isWrapped) {
			start--;
		}
		const line = renderLine(buffer, start, row, cell);
		lines.push(line.marked);
		text.push(line.plain);
		row = start - 1;
	}
	let older = false;
	for (let above = row; above >= 0 && !older; above--) {
		older = !isBlankRow(buffer.getLine(above), cell);
	}
	// Blank rows above the first with something on it are not part of the screen
	if (!older) {
		while (lines.length && !lines[lines.length - 1]) {
			lines.pop();
			text.pop();
		}
	}
	// The normal buffer lets go of its oldest rows once it holds its scrollback above the screen
	const trimmed = buffer.type === 'normal' && buffer.length >= raw.rows + (raw.options.scrollback ?? 0);
	return { lines: lines.reverse(), text: text.reverse(), buffer: buffer.type, older, trimmed };
}

/** Whether a row has nothing on it: no characters, nothing in inverse video. */
function isBlankRow(line: IBufferLine | undefined, cell: IBufferCell): boolean {
	if (!line) {
		return true;
	}
	if (line.translateToString(true).trim()) {
		return false;
	}
	for (let x = 0; x < line.length; x++) {
		if (line.getCell(x, cell)?.isInverse()) {
			return false;
		}
	}
	return true;
}

/** The rows `start` to `end` of `buffer` as one line of text, marked as `readScreen` says, and plain. */
function renderLine(buffer: IBuffer, start: number, end: number, cell: IBufferCell): { readonly marked: string; readonly plain: string } {
	const cells: IScreenCell[] = [];
	for (let y = start; y <= end; y++) {
		const row: IScreenCell[] = [];
		let empty = 0;
		for (const drawn of drawnCells(buffer.getLine(y), cell)) {
			empty = drawn.chars ? 0 : empty + 1;
			row.push({ chars: drawn.chars || ' ', mark: (drawn.inverse ? Mark.Inverse : Mark.None) | (drawn.dim ? Mark.Dim : Mark.None) });
		}
		// A row the line wraps on from ends where its text does: a wide character that did not fit leaves an
		// empty cell at its end, which is no space in the line
		cells.push(...(y < end ? row.slice(0, row.length - empty) : row));
	}
	const shown = cells.slice(0, endOfLine(cells));
	return { marked: markedText(shown), plain: shown.map(each => each.chars).join('').trimEnd() };
}

/**
 * Where a line's cells end once the spaces it ends in are cut: after its last character. A cursor drawn
 * as a space in inverse video right after it stays, one space of it; a bar of inverse video an item is
 * picked with ends with the item's text.
 */
function endOfLine(cells: readonly IScreenCell[]): number {
	let end = cells.length;
	while (end > 0 && cells[end - 1].chars === ' ') {
		end--;
	}
	if (end > 0 && cells[end - 1].mark & Mark.Inverse) {
		return end;
	}
	for (let x = end; x < cells.length; x++) {
		if (cells[x].mark & Mark.Inverse) {
			return x + 1;
		}
	}
	return end;
}

/** `cells` as text, each run in inverse video in `[[` and `]]`, each dim run in `{{` and `}}`. */
function markedText(cells: readonly IScreenCell[]): string {
	let text = '';
	let mark = Mark.None;
	for (const { chars, mark: next } of cells) {
		if (next !== mark) {
			text += closing(mark) + opening(next);
			mark = next;
		}
		text += chars;
	}
	return text + closing(mark);
}

/** What a run of text with `mark` starts with. */
function opening(mark: Mark): string {
	return (mark & Mark.Inverse ? '[[' : '') + (mark & Mark.Dim ? '{{' : '');
}

/** What a run of text with `mark` ends with. */
function closing(mark: Mark): string {
	return (mark & Mark.Dim ? '}}' : '') + (mark & Mark.Inverse ? ']]' : '');
}
