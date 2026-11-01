/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The keys press_keys takes (MCP-5.2): the names ptyd encodes (`ptyd/keys.ts`, kept identical), the familiar aliases an agent
// may write for them, and single printable characters. Anything else is refused before any key goes in.

const A = 'A'.charCodeAt(0);

/** The key names ptyd presses, exactly as it spells them. */
export const KEY_NAMES: readonly string[] = [
	'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp',
	'PageDown', 'Space',
	...Array.from({ length: 26 }, (_, index) => `Ctrl+${String.fromCharCode(A + index)}`)
];

/** Other spellings of those names, lower case: what agents are used to writing. */
const ALIASES: ReadonlyMap<string, string> = new Map([
	['return', 'Enter'],
	['esc', 'Escape'],
	['arrowup', 'Up'],
	['arrowdown', 'Down'],
	['arrowleft', 'Left'],
	['arrowright', 'Right']
]);

/** Every name and alias by its lower-case spelling: a name's case does not matter, a single character's does. */
const BY_LOWER: ReadonlyMap<string, string> = new Map([...KEY_NAMES.map((name): [string, string] => [name.toLowerCase(), name]), ...ALIASES]);

/** One printable character, as ptyd tells it (`ptyd/keys.ts`): no control, format, private, unassigned or surrogate code point. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]$/u;

/** `key` as ptyd names it - a name, an alias or one printable character - or undefined where it is none of them. */
export function normalizeKey(key: string): string | undefined {
	if (PRINTABLE.test(key)) {
		return key;
	}
	return BY_LOWER.get(key.toLowerCase());
}
