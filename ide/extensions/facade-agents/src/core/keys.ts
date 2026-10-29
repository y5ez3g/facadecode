/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The letters a Ctrl key goes with, A to Z. */
const LETTERS = Array.from({ length: 26 }, (_, index) => String.fromCharCode('A'.charCodeAt(0) + index));

/** The keys `press_keys` presses by their names, as the window takes them: those with Ctrl are {@link CTRL_KEYS}. */
export const NAMED_KEYS: readonly string[] = [
	'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right',
	'Home', 'End', 'PageUp', 'PageDown', 'Space'
];

/** The keys with Ctrl `press_keys` presses: Ctrl+A to Ctrl+Z. */
export const CTRL_KEYS: readonly string[] = LETTERS.map(letter => `Ctrl+${letter}`);

/** The other names keys go by, as `press_keys` takes them. */
const ALIASES: ReadonlyMap<string, string> = new Map([
	['return', 'Enter'],
	['esc', 'Escape'],
	['arrowup', 'Up'],
	['arrowdown', 'Down'],
	['arrowleft', 'Left'],
	['arrowright', 'Right'],
	...LETTERS.map((letter): [string, string] => [`^${letter.toLowerCase()}`, `Ctrl+${letter}`])
]);

/** Each name and alias without case or spaces, and the name it stands for. */
const BY_FOLDED: ReadonlyMap<string, string> = new Map([...[...NAMED_KEYS, ...CTRL_KEYS].map((name): [string, string] => [fold(name), name]), ...ALIASES]);

/**
 * One printable character: what a key with nothing held down types. Not a control or format character, a
 * private-use or unassigned code point, half a surrogate pair, nor a line or paragraph separator - as the
 * window takes it.
 */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]$/u;

/** A key's name without case or spaces, as it is looked up. */
function fold(name: string): string {
	return name.replace(/\s+/g, '').toLowerCase();
}

/**
 * The key `key` names, as the window takes it: one of {@link NAMED_KEYS} or {@link CTRL_KEYS}, written in
 * any case, with spaces around and between its parts or none - `enter`, `ctrl + c`, `Page Up`; an alias -
 * Return, Esc, ArrowUp and the other arrows, `^A` to `^Z`; or one printable character, as it is, a space
 * being Space. Undefined for any other: a chord, a function key, more than one character.
 */
export function keyOf(key: string): string | undefined {
	if (key === ' ') {
		return 'Space';
	}
	if ([...key].length === 1) {
		return PRINTABLE.test(key) ? key : undefined;
	}
	return BY_FOLDED.get(fold(key));
}
