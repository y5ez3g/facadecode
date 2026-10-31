/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The keys automated input presses and the text it types into a run, encoded as a terminal sends them for the person in the
// modes the run's program set. Without the window's xterm to encode keys, ptyd follows the modes itself.

/** What bracketed paste mode wraps a paste in, for the program to take it as one. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The modes a run's program set that change what a key sends: ptyd's headless terminal keeps them as the program writes. */
export interface KeyModes {
	/** Application cursor keys (DECCKM): the cursor keys, Home and End as SS3. */
	readonly applicationCursorKeys: boolean;
	/** The kitty keyboard protocol's flags in force, 0 where the program asked for none. */
	readonly kittyFlags: number;
	/** Win32 input mode: every key as its press and its release, as Windows' console takes them. */
	readonly win32Input: boolean;
}

export const DEFAULT_KEY_MODES: KeyModes = { applicationCursorKeys: false, kittyFlags: 0, win32Input: false };

/** The kitty protocol's flags: escape codes that tell keys apart, and every key as an escape code. */
const KITTY_DISAMBIGUATE = 1;
const KITTY_ALL_KEYS = 8;

/**
 * Text sent as one input (COLLABORATION-1.2): inside bracketed-paste markers where the program turned that mode on, its line
 * breaks as a terminal pastes them; otherwise as it is, line breaks and tabs included. Other control characters are made visible
 * either way, so that text never presses a key or ends a paste early.
 */
export function pasteSequence(bracketed: boolean, text: string): string {
	// eslint-disable-next-line no-control-regex
	const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, char => {
		const code = char.charCodeAt(0);
		return code < 32 ? String.fromCharCode(0x2400 + code) : code === 127 ? '\u2421' : `\\u${code.toString(16).padStart(4, '0')}`;
	});
	return bracketed ? `${PASTE_START}${clean.replace(/\r\n?|\n/g, '\r')}${PASTE_END}` : clean;
}

/** A key by its name: what a terminal in its default modes sends for it, and what it is in the other encodings. */
interface NamedKey {
	readonly sequence: string;
	/** What it sends with application cursor keys on, where that differs. */
	readonly applicationCursor?: string;
	/** Its code in the kitty protocol, for a key the protocol encodes as `CSI code ; modifiers u`. */
	readonly kitty?: number;
	/** Its virtual key code, and the character it types, in win32 input mode. */
	readonly vk: number;
	readonly char: number;
	readonly shift?: boolean;
	readonly ctrl?: boolean;
}

const A = 'A'.charCodeAt(0);

/** The keys an agent presses by name, as the agents' tools write them. */
const NAMED_KEYS: ReadonlyMap<string, NamedKey> = new Map<string, NamedKey>([
	['Enter', { sequence: '\r', kitty: 13, vk: 13, char: 13 }],
	['Escape', { sequence: '\x1b', kitty: 27, vk: 27, char: 27 }],
	['Tab', { sequence: '\t', kitty: 9, vk: 9, char: 9 }],
	['Shift+Tab', { sequence: '\x1b[Z', kitty: 9, vk: 9, char: 9, shift: true }],
	['Backspace', { sequence: '\x7f', kitty: 127, vk: 8, char: 8 }],
	['Delete', { sequence: '\x1b[3~', vk: 46, char: 0 }],
	['Up', { sequence: '\x1b[A', applicationCursor: '\x1bOA', vk: 38, char: 0 }],
	['Down', { sequence: '\x1b[B', applicationCursor: '\x1bOB', vk: 40, char: 0 }],
	['Right', { sequence: '\x1b[C', applicationCursor: '\x1bOC', vk: 39, char: 0 }],
	['Left', { sequence: '\x1b[D', applicationCursor: '\x1bOD', vk: 37, char: 0 }],
	['Home', { sequence: '\x1b[H', applicationCursor: '\x1bOH', vk: 36, char: 0 }],
	['End', { sequence: '\x1b[F', applicationCursor: '\x1bOF', vk: 35, char: 0 }],
	['PageUp', { sequence: '\x1b[5~', vk: 33, char: 0 }],
	['PageDown', { sequence: '\x1b[6~', vk: 34, char: 0 }],
	['Space', { sequence: ' ', kitty: 32, vk: 32, char: 32 }],
	// Ctrl+A to Ctrl+Z: the letter's control character, or its lower-case letter with Ctrl in the kitty protocol
	...Array.from({ length: 26 }, (_, index): [string, NamedKey] => [
		`Ctrl+${String.fromCharCode(A + index)}`,
		{ sequence: String.fromCharCode(index + 1), kitty: A + 32 + index, vk: A + index, char: index + 1, ctrl: true }
	])
]);

/** One printable character: what a key with nothing held down types - no control, format, private or unassigned code point. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]$/u;

/**
 * Whether `key` is one an agent presses: a name - Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right,
 * Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z - or one printable character.
 */
export function isAgentKey(key: string): boolean {
	return NAMED_KEYS.has(key) || PRINTABLE.test(key);
}

/**
 * What a run is sent for `key`, pressed and let go, as a terminal sends it for the person in `modes`: win32 input mode's
 * press and release; the kitty protocol's escape codes where it has the key send one - Escape and Ctrl with a letter where
 * it tells keys apart, Enter, Tab, Backspace and Space too where every key is one; else the default sequences, the cursor
 * keys, Home and End as SS3 with application cursor keys on. A printable character goes as it is, as typed text does.
 */
export function keySequence(modes: KeyModes, key: string): string {
	const named = NAMED_KEYS.get(key);
	if (!named) {
		return key;
	}
	const modifiers = 1 + (named.shift ? 1 : 0) + (named.ctrl ? 4 : 0);
	if (modes.win32Input) {
		const state = (named.shift ? 0x10 : 0) | (named.ctrl ? 0x08 : 0);
		return `\x1b[${named.vk};0;${named.char};1;${state};1_\x1b[${named.vk};0;${named.char};0;${state};1_`;
	}
	if (named.kitty !== undefined && modes.kittyFlags & (KITTY_DISAMBIGUATE | KITTY_ALL_KEYS)) {
		// Enter, Tab, Backspace and Space unmodified keep their bytes unless every key is an escape code
		const plain = modifiers === 1 && [13, 9, 127, 32].includes(named.kitty);
		if (!plain || modes.kittyFlags & KITTY_ALL_KEYS) {
			return modifiers === 1 ? `\x1b[${named.kitty}u` : `\x1b[${named.kitty};${modifiers}u`;
		}
	}
	return modes.applicationCursorKeys && named.applicationCursor || named.sequence;
}
