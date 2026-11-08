/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The first line's measured name (PANEL-1.3). The full name stays in the card's state, its details and its accessible label.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Where text is measured as the page draws it - its fonts and their fallbacks, which a canvas can choose otherwise for CJK text, so
 * that a label's width is the width of what it shows (PANEL-1.3). Hidden, out of the layout of the list, and read for a text only once.
 */
const probe = document.createElement('span');
probe.style.cssText = 'position:absolute;left:0;top:0;white-space:pre';
// In a box of no size, so that a long text measured never widens what the page scrolls
const probeBox = document.createElement('div');
probeBox.setAttribute('aria-hidden', 'true');
probeBox.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
probeBox.append(probe);
const measured = new Map<string, number>();
/** Enough for the labels of a few hundred cards; past it the widths are measured anew. */
const MOST_MEASURED = 4_000;

/** Whole-pixel text widths in the font the label draws. */
function measureIn(element: HTMLElement): (text: string) => number {
	const style = getComputedStyle(element);
	const font = style.font;
	const spacing = style.letterSpacing;
	return text => {
		const key = `${font}\n${spacing}\n${text}`;
		let width = measured.get(key);
		if (width === undefined) {
			if (!probeBox.isConnected) {
				document.body.append(probeBox);
			}
			probe.style.font = font;
			probe.style.letterSpacing = spacing;
			probe.textContent = text;
			width = probe.getBoundingClientRect().width;
			// A page not laid out - its view hidden - measures nothing: such a width is not kept
			if (width > 0 || !text) {
				if (measured.size >= MOST_MEASURED) {
					measured.clear();
				}
				measured.set(key, width);
			}
		}
		return Math.ceil(width);
	};
}

/** Whole graphemes from the start and an ellipsis, as many as fit; nothing where not even the ellipsis does (PANEL-1.3). */
function end(text: string, width: number, measure: (text: string) => number): string {
	if (measure(text) <= width) {
		return text;
	}
	const parts = [...graphemes.segment(text)].map(each => each.segment);
	const cut = (count: number) => `${parts.slice(0, count).join('').trimEnd()}…`;
	if (measure(cut(0)) > width) {
		return '';
	}
	let low = 0;
	let high = parts.length - 1;
	while (low < high) {
		const count = Math.ceil((low + high) / 2);
		if (measure(cut(count)) <= width) {
			low = count;
		} else {
			high = count - 1;
		}
	}
	return cut(low);
}

/** A fitting limit decides the text; its measured result decides the space it actually occupies. */
interface FittedText {
	readonly text: string;
	readonly width: number;
}

function fit(text: string, limit: number, measure: (text: string) => number): FittedText {
	const fitted = end(text, limit, measure);
	return { text: fitted, width: Math.min(limit, measure(fitted)) };
}

/** Paint only the resulting text width. */
function show(element: HTMLElement, fitted: FittedText): void {
	element.style.width = `${fitted.width}px`;
	if (element.textContent !== fitted.text) {
		element.textContent = fitted.text;
	}
}

/**
 * Fit one card's name from its original string, so widening or updating it never truncates an already shortened value: as much of
 * `fullName` as fits beside what else is on the line - its short ID and Pin, whole - ending in an ellipsis where it is cut (PANEL-1.3).
 */
export function fitCardTop(top: HTMLElement, name: HTMLElement, fullName: string): void {
	// Not laid out - its view hidden - a card keeps what it shows, or its whole name, until it is
	if (!top.clientWidth) {
		if (!name.textContent) {
			name.textContent = fullName;
		}
		return;
	}
	const measureName = measureIn(name);
	const line = getComputedStyle(top);
	const gap = parseFloat(line.columnGap) || 0;
	// The Pin and the buttons sit over the line's end at the card's corner, out of its flow: its padding keeps their room (PANEL-1.3)
	let reserved = (parseFloat(line.paddingLeft) || 0) + (parseFloat(line.paddingRight) || 0);
	for (const other of top.children) {
		const style = getComputedStyle(other);
		if (other !== name && style.position !== 'absolute' && other.getClientRects().length) {
			reserved += other.getBoundingClientRect().width + (parseFloat(style.marginRight) || 0) + gap;
		}
	}
	const shownName = fullName.replace(/\s+/g, ' ');
	show(name, fit(shownName, Math.max(0, Math.min(measureName(shownName), Math.floor(top.clientWidth - reserved))), measureName));
}
