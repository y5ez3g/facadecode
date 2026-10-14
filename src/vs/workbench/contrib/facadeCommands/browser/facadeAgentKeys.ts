/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { CharCode } from '../../../../base/common/charCode.js';

/** What bracketed paste mode wraps a paste in, for the program to take it as one. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * What `raw` sends its process for `text` pasted, as its own paste path sends the person's paste (xterm's `paste`,
 * which VS Code's Paste calls): line breaks as Enter, and in the bracketed-paste markers where the program turned
 * that mode on and the person has not told the terminal to ignore it - `terminal.integrated.ignoreBracketedPasteMode`,
 * which VS Code gives xterm as its `ignoreBracketedPasteMode` option - with no Escape inside them that could end the
 * paste early. Never through xterm itself, whose paste the window takes as the person's typing.
 */
export function pasteSequence(raw: RawXtermTerminal | undefined, text: string): string {
	const lines = text.replace(/\r?\n/g, '\r');
	return raw?.modes.bracketedPasteMode && raw.options.ignoreBracketedPasteMode !== true ? `${PASTE_START}${lines.replace(/\x1b/g, '\u241b')}${PASTE_END}` : lines;
}

/** A key as a keyboard event gives it, for the terminal to encode, and as it is sent without the terminal's help. */
interface INamedKey {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly shiftKey?: boolean;
	readonly ctrlKey?: boolean;
	/** What a terminal in its default modes sends for it. */
	readonly sequence: string;
	/** What it sends with application cursor keys on (DECCKM), where that differs. */
	readonly applicationCursor?: string;
}

/** The keys an agent presses by name, as the agents' extension writes them. */
const NAMED_KEYS: ReadonlyMap<string, INamedKey> = new Map<string, INamedKey>([
	['Enter', { key: 'Enter', code: 'Enter', keyCode: 13, sequence: '\r' }],
	['Escape', { key: 'Escape', code: 'Escape', keyCode: 27, sequence: '\x1b' }],
	['Tab', { key: 'Tab', code: 'Tab', keyCode: 9, sequence: '\t' }],
	['Shift+Tab', { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true, sequence: '\x1b[Z' }],
	['Backspace', { key: 'Backspace', code: 'Backspace', keyCode: 8, sequence: '\x7f' }],
	['Delete', { key: 'Delete', code: 'Delete', keyCode: 46, sequence: '\x1b[3~' }],
	['Up', { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, sequence: '\x1b[A', applicationCursor: '\x1bOA' }],
	['Down', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, sequence: '\x1b[B', applicationCursor: '\x1bOB' }],
	['Right', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, sequence: '\x1b[C', applicationCursor: '\x1bOC' }],
	['Left', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, sequence: '\x1b[D', applicationCursor: '\x1bOD' }],
	['Home', { key: 'Home', code: 'Home', keyCode: 36, sequence: '\x1b[H', applicationCursor: '\x1bOH' }],
	['End', { key: 'End', code: 'End', keyCode: 35, sequence: '\x1b[F', applicationCursor: '\x1bOF' }],
	['PageUp', { key: 'PageUp', code: 'PageUp', keyCode: 33, sequence: '\x1b[5~' }],
	['PageDown', { key: 'PageDown', code: 'PageDown', keyCode: 34, sequence: '\x1b[6~' }],
	['Space', { key: ' ', code: 'Space', keyCode: CharCode.Space, sequence: ' ' }],
	// Ctrl+A to Ctrl+Z: their letter's key with Ctrl held, the letter's control character without the terminal's help
	...Array.from({ length: CharCode.Z - CharCode.A + 1 }, (_, index): [string, INamedKey] => {
		const letter = String.fromCharCode(CharCode.A + index);
		return [`Ctrl+${letter}`, { key: letter.toLowerCase(), code: `Key${letter}`, keyCode: CharCode.A + index, ctrlKey: true, sequence: String.fromCharCode(index + 1) }];
	})
]);

/** One printable character: what a key with nothing held down types - no control, format, private or unassigned code point. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]$/u;

/**
 * Whether `key` is one an agent presses: a name - Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up,
 * Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z - as the agents' extension
 * writes it, or one printable character.
 */
export function isAgentKey(key: string): boolean {
	return NAMED_KEYS.has(key) || PRINTABLE.test(key);
}

/** What xterm's keyboard encoding reads of a key event: the key, and the modifiers held. */
interface IKeyEvent {
	readonly type: 'keydown' | 'keyup';
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly which: number;
	readonly shiftKey: boolean;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly repeat: boolean;
	getModifierState(key: string): boolean;
}

/** The part of xterm that encodes a key event as the terminal sends it, in its modes now: internal to xterm. */
interface IXtermKeyboard {
	evaluateKeyDown(event: IKeyEvent): { readonly key?: string };
	evaluateKeyUp(event: IKeyEvent): { readonly key?: string } | undefined;
}

/** xterm's terminal with the keyboard encoding its core keeps, as `xtermTerminal.ts` reaches the core. */
interface ITerminalWithKeyboard extends RawXtermTerminal {
	readonly _core?: { readonly _keyboardService?: IXtermKeyboard };
}

/** xterm's own keyboard encoding; undefined where this xterm has none. */
function keyboardOf(raw: RawXtermTerminal | undefined): IXtermKeyboard | undefined {
	const keyboard = (raw as ITerminalWithKeyboard | undefined)?._core?._keyboardService;
	return typeof keyboard?.evaluateKeyDown === 'function' && typeof keyboard.evaluateKeyUp === 'function' ? keyboard : undefined;
}

/**
 * What `raw` sends its process for `key`, pressed and let go, as it sends it for a key the person
 * presses: through xterm's own encoding, in the modes the program set - application cursor keys, the
 * kitty keyboard protocol, win32 input mode - without a DOM event, which VS Code's keybindings would see
 * first. A printable character goes as it is, as the terminal sends typed text. Where xterm's encoding
 * is not there, the default and application cursor sequences.
 */
export function keySequences(raw: RawXtermTerminal | undefined, key: string): string[] {
	const named = NAMED_KEYS.get(key);
	if (!named) {
		return [key];
	}
	const keyboard = keyboardOf(raw);
	if (keyboard) {
		const event: IKeyEvent = { type: 'keydown', key: named.key, code: named.code, keyCode: named.keyCode, which: named.keyCode, shiftKey: !!named.shiftKey, ctrlKey: !!named.ctrlKey, altKey: false, metaKey: false, repeat: false, getModifierState: () => false };
		const down = keyboard.evaluateKeyDown(event).key;
		if (down) {
			const up = keyboard.evaluateKeyUp({ ...event, type: 'keyup' })?.key;
			return up ? [down, up] : [down];
		}
	}
	return [raw?.modes.applicationCursorKeysMode && named.applicationCursor || named.sequence];
}

const ESC = 0x1b;
const BEL = 0x07;
const CTRL_C = 0x03;
/** The final characters a control sequence can end with: `@` to `~`. */
const FIRST_FINAL = CharCode.AtSign;
const LAST_FINAL = CharCode.Tilde;
/** A control sequence's final character, for the keys that send one: the cursor keys, Home, End, Shift+Tab, and `~` for the keypad's. */
const KEY_FINALS = new Set(['A', 'B', 'C', 'D', 'H', 'F', 'Z', '~']);
/** A key in the kitty keyboard protocol: `CSI code[:alternates] [; modifiers[:event]] [; text] u`. */
const KITTY_KEY = /^(?<code>\d+)(?::\d*)*(?:;(?<modifiers>\d*)(?::(?<event>\d+))?)?(?:;[\d:]*)?$/;
/** A key in win32 input mode: `CSI Vk ; Sc ; Uc ; Kd ; Cs [; Rc] _`. */
const WIN32_KEY = /^(?<vk>\d+);\d+;(?<char>\d+);(?<down>\d+);(?<state>\d+)(?:;\d+)?$/;
/** The kitty protocol's modifier bits, once 1 is taken off its modifiers: Shift, Alt, Ctrl and Super. */
const KITTY_SHIFT = 1;
const KITTY_ALT_CTRL_SUPER = 2 | 4 | 8;
const KITTY_CTRL = 4;
/** Key up, in the kitty protocol's event types. */
const KITTY_RELEASE = 3;
/** Win32's control key state: the Alt and Ctrl keys, and Shift. */
const WIN32_ALT_CTRL = 0x01 | 0x02 | 0x04 | 0x08;
const WIN32_CTRL = 0x04 | 0x08;
const WIN32_SHIFT = 0x10;

/** What one piece of what a terminal took in is: typed text, Enter or Ctrl+C, another key, or what the terminal answered a program. */
export type InputPiece = 'text' | 'submit' | 'key' | 'reply';

/** The private use area, where the kitty keyboard protocol puts the codes of keys that type nothing. */
const FIRST_PRIVATE_USE = 0xe000;
const LAST_PRIVATE_USE = 0xf8ff;

/** Backspace, as a terminal sends it by default. */
const DELETE = 0x7f;

/**
 * A key with its character `code`: Enter or Ctrl+C sends or drops the line; a printable character, or a
 * line break within the input - Shift+Enter - is typing; any other - Backspace too, which types nothing
 * into an empty input - or one with Ctrl, Alt or Super held, is a key.
 */
function pieceOfChar(code: number, shift: boolean, ctrl: boolean, altOrSuper: boolean): InputPiece {
	if ((code === CharCode.CarriageReturn && !shift) || code === CTRL_C || (ctrl && (code === CharCode.c || code === CharCode.C))) {
		return 'submit';
	}
	if (ctrl || altOrSuper || code === DELETE || (code >= FIRST_PRIVATE_USE && code <= LAST_PRIVATE_USE)) {
		return 'key';
	}
	return code >= CharCode.Space || code === CharCode.CarriageReturn ? 'text' : 'key';
}

/**
 * The pieces of `data` that a terminal took in: each character typed, a bracketed paste as one, and each
 * escape sequence - a key such as the arrows, in the terminal's default encoding, the kitty keyboard
 * protocol's or win32 input mode's, or what the terminal answers a program with on its own: a cursor
 * position, focus coming and going, the mouse - the old report's three bytes with it - a color, its version.
 */
export function inputPieces(data: string): InputPiece[] {
	const pieces: InputPiece[] = [];
	let i = 0;
	while (i < data.length) {
		const code = data.charCodeAt(i);
		if (code !== ESC) {
			pieces.push(pieceOfChar(code, false, false, false));
			i++;
			continue;
		}
		const next = data[i + 1];
		if (next === undefined) {
			// Escape on its own
			pieces.push('key');
			i++;
		} else if (data.startsWith(PASTE_START, i)) {
			// A bracketed paste is typing as a whole: a line break in it sends nothing
			const end = data.indexOf(PASTE_END, i + PASTE_START.length);
			pieces.push('text');
			i = end === -1 ? data.length : end + PASTE_END.length;
		} else if (next === '[' && data[i + 2] === 'M') {
			// The old mouse report, X10's: its button and place are three bytes after it, which type nothing (N-86)
			pieces.push('reply');
			i += 6;
		} else if (next === '[') {
			// A control sequence, which ends at its final character
			let end = i + 2;
			while (end < data.length && !(data.charCodeAt(end) >= FIRST_FINAL && data.charCodeAt(end) <= LAST_FINAL)) {
				end++;
			}
			const body = data.slice(i + 2, end);
			const kitty = data[end] === 'u' ? KITTY_KEY.exec(body)?.groups : undefined;
			const win32 = data[end] === '_' ? WIN32_KEY.exec(body)?.groups : undefined;
			if (kitty) {
				const modifiers = Math.max(0, Number(kitty.modifiers || 1) - 1);
				pieces.push(Number(kitty.event) === KITTY_RELEASE ? 'key' : pieceOfChar(Number(kitty.code), !!(modifiers & KITTY_SHIFT), !!(modifiers & KITTY_CTRL), !!(modifiers & (KITTY_ALT_CTRL_SUPER & ~KITTY_CTRL))));
			} else if (win32) {
				// A key let go, or one that types no character - an arrow, a function key - is no typing
				const state = Number(win32.state);
				const char = Number(win32.char);
				const ctrl = !!(state & WIN32_CTRL);
				const alt = !!(state & (WIN32_ALT_CTRL & ~WIN32_CTRL));
				// AltGr comes as Ctrl and Alt together, with the character it types
				pieces.push(win32.down === '0' || !char ? 'key' : ctrl && alt && char >= CharCode.Space ? 'text' : pieceOfChar(char, !!(state & WIN32_SHIFT), ctrl, alt));
			} else {
				pieces.push(KEY_FINALS.has(data[end]) && /^[\d;]*$/.test(body) ? 'key' : 'reply');
			}
			i = end + 1;
		} else if (next === 'O') {
			// SS3: a cursor or keypad key with application keys on
			pieces.push('key');
			i += 3;
		} else if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
			// A string - an operating system command, a device control string - which ends at BEL or ST
			let end = i + 2;
			while (end < data.length && data.charCodeAt(end) !== BEL && !(data.charCodeAt(end) === ESC && data[end + 1] === '\\')) {
				end++;
			}
			pieces.push('reply');
			i = end + (data.charCodeAt(end) === BEL ? 1 : 2);
		} else {
			// Alt with a key
			pieces.push('key');
			i += 2;
		}
	}
	return pieces;
}
