/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The most a notification shows, ellipsis included (UX-1.2). */
export const NOTIFICATION_LIMIT = 300;

/**
 * A notification's text: one line, at most 300 code points with an ellipsis, with Markdown links and command URIs neutralized
 * so user or CLI text cannot become an action (UX-1.2, ARCHITECTURE-3.2).
 */
export function notificationText(text: string): string {
	const line = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
	const neutral = line.replace(/\]\(/g, ']​(').replace(/\b(command|vscode|vscode-insiders):/gi, '$1​:');
	const points = [...neutral];
	return points.length <= NOTIFICATION_LIMIT ? neutral : `${points.slice(0, NOTIFICATION_LIMIT - 1).join('')}…`;
}
