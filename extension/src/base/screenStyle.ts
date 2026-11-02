/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Half-open Unicode code-point offsets into a single screen text, including its newlines. */
export interface ScreenStyle {
	readonly start: number;
	readonly end: number;
	readonly inverse?: true;
	readonly dim?: true;
}

/** One reversible body for a model to read; raw source brackets/braces never become style marks. */
export function screenText(text: string, styles?: readonly ScreenStyle[]): string {
	const escape = (value: string) => value.replace(/[\\[\]{}]/g, '\\$&');
	if (!styles?.length) { return escape(text); }
	const points = [...text], parts: string[] = [];
	let at = 0;
	for (const style of styles) {
		if (!Number.isInteger(style.start) || !Number.isInteger(style.end) || style.start < at || style.end <= style.start || style.end > points.length) {
			throw new Error('The terminal supplied an invalid screen style range.');
		}
		parts.push(escape(points.slice(at, style.start).join('')),
			style.inverse ? '[[' : '', style.dim ? '{{' : '', escape(points.slice(style.start, style.end).join('')),
			style.dim ? '}}' : '', style.inverse ? ']]' : '');
		at = style.end;
	}
	parts.push(escape(points.slice(at).join('')));
	return parts.join('');
}

/** Clip cues when the bottom logical lines of a retained frame are requested. */
export function tailStyles(text: readonly string[], styles: readonly ScreenStyle[] | undefined, count: number): readonly ScreenStyle[] | undefined {
	if (!styles) { return undefined; }
	const skipped = Math.max(0, text.length - count);
	const offset = text.slice(0, skipped).reduce((sum, line) => sum + [...line].length + 1, 0);
	const kept = styles.filter(style => style.end > offset).map(style => ({ ...style, start: Math.max(0, style.start - offset), end: style.end - offset }));
	return kept;
}
