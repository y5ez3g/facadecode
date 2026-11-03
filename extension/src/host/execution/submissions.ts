/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the person submits in an agent's terminal (PANEL-1.4, D184): an Enter they type over a draft that the run's input reader
// reads, and that the CLI then takes - its input emptied, or a menu or question in its place. The text is the draft as the input
// drew it, never what tracked keystrokes would make of it; a CLI without an input reader submits nothing that Facade can say.

import type { InputReading } from '../../ptyd/composer';

/** How long after an Enter the input is read again for having taken its text, each wait after the one before: some 4 s in all. */
export const SUBMIT_CHECKS_MS: readonly number[] = [100, 250, 500, 1000, 2000];

/** Bracketed paste's start and end, Alt+Enter, and Enter as a terminal types it, or as the kitty keyboard protocol reports it. */
// eslint-disable-next-line no-control-regex
const KEYS = /\x1b\[200~|\x1b\[201~|\x1b\r|\x1b\[13(?:;1)?u|\r/g;

/** The Enters a person types into one terminal: one inside a paste, or Alt+Enter, which CLIs take as a line break, submits nothing. */
export class TypedEnters {
	private pasting = false;

	/** The first Enter in `data` that may submit the input, and its length; a paste's start or end before it is followed. */
	next(data: string): { readonly index: number; readonly length: number } | undefined {
		for (const match of data.matchAll(KEYS)) {
			const key = match[0];
			if (key === '\x1b[200~') {
				this.pasting = true;
			} else if (key === '\x1b[201~') {
				this.pasting = false;
			} else if (!this.pasting && key !== '\x1b\r') {
				return { index: match.index, length: key.length };
			}
		}
		return undefined;
	}
}

/** A draft without the spaces and line breaks its CLI's rows wrap and indent it with. */
const squeezed = (text: string) => text.replace(/\s+/gu, '');

/**
 * Whether the CLI took `draft` after an Enter over it (D184): its input, read again in {@link SUBMIT_CHECKS_MS}'s turns, is empty or
 * shows a menu or question - or another draft, the person typing anew. The same draft, or one with more after it - a line break the
 * Enter typed - is not taken; an input that cannot be read any more says nothing.
 */
export async function taken(draft: string, read: () => Promise<InputReading | undefined>, wait: (ms: number) => Promise<void>, checks: readonly number[] = SUBMIT_CHECKS_MS): Promise<boolean> {
	const before = squeezed(draft);
	for (const ms of checks) {
		await wait(ms);
		const now = await read();
		if (!now) {
			return false;
		}
		if (now.state === 'usable' || now.state === 'interaction') {
			return true;
		}
		if (now.state === 'draft' && !squeezed(now.draft ?? '').startsWith(before)) {
			return true;
		}
	}
	return false;
}

/**
 * What a reading before an Enter says the person submits with it: the draft it reads, where it reads one with text - not one that
 * ends with a backslash, before which CLIs take Enter as a line break, as a terminal's Shift+Enter set up for them types it.
 */
export function submittedDraft(reading: InputReading | undefined): string | undefined {
	const draft = reading?.state === 'draft' ? reading.draft?.trim() : undefined;
	return draft && !draft.endsWith('\\') ? reading!.draft : undefined;
}
