/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The spinner a busy agent's tab turns between its logo and its name (LIFECYCLE-2.2): a frame before the name in the title
// its tab is given, as editor tabs draw no icon in a label.

/** Its frames, as Codex draws its own spinner. */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A tab title that is a frame before a name. */
const SPUN = new RegExp(`^[${SPINNER_FRAMES.join('')}] (.*)$`, 'su');

/** The name after the frame where `title` is a frame and a name; undefined where it is not. */
export function spunName(title: string): string | undefined {
	return SPUN.exec(title)?.[1];
}

/** A tab title without the frame before its agent's name: the same tab whichever frame it showed. */
export function unspun(title: string): string {
	return spunName(title) ?? title;
}
