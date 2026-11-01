/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The first line's measured widths and location ellipses (PANEL-1.3, D128). Full strings stay in the card's state and hover.
import type { Card } from './protocol';

const canvas = document.createElement('canvas').getContext('2d')!;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Whole-pixel text widths in the same font the label draws. */
function measureIn(element: HTMLElement): (text: string) => number {
	const font = getComputedStyle(element).font;
	return text => {
		canvas.font = font;
		return Math.ceil(canvas.measureText(text).width);
	};
}

/** A short label stays whole; only two long labels use the given share. Where possible each gets at least its ellipsis. */
function widths(total: number, first: number, second: number, share: number, minimum = 0): [number, number] {
	if (first + second <= total) {
		return [first, second];
	}
	let left = Math.min(first, Math.max(Math.round(total * share), total - second));
	const firstMin = Math.min(first, minimum);
	const secondMin = Math.min(second, minimum);
	if (firstMin + secondMin <= total) {
		left = Math.max(firstMin, Math.min(left, total - secondMin));
	}
	return [left, total - left];
}

/** Keep both ends, one more grapheme at the start when odd; never split an emoji or combining sequence. */
function middle(text: string, width: number, measure: (text: string) => number): string {
	if (measure(text) <= width) {
		return text;
	}
	const parts = [...graphemes.segment(text)].map(each => each.segment);
	const cut = (count: number) => `${parts.slice(0, Math.ceil(count / 2)).join('')}…${parts.slice(parts.length - Math.floor(count / 2)).join('')}`;
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
	const fitted = middle(text, limit, measure);
	return { text: fitted, width: Math.min(limit, measure(fitted)) };
}

/** Paint only the resulting text width, so an unfilled grapheme budget cannot become a gap beside the separator. */
function show(element: HTMLElement, fitted: FittedText): void {
	element.style.width = `${fitted.width}px`;
	if (element.textContent !== fitted.text) {
		element.textContent = fitted.text;
	}
}

/** Fit one card from its original strings, so widening or updating it never truncates an already shortened value. */
export function fitCardTop(top: HTMLElement, name: HTMLElement, location: Card['location']): void {
	const place = top.querySelector<HTMLElement>('.place')!;
	const tree = place.querySelector<HTMLElement>('.tree')!;
	const folder = place.querySelector<HTMLElement>('.folder');
	const bullet = place.querySelector<HTMLElement>('.bullet');
	const measureName = measureIn(name);
	const measurePlace = measureIn(tree);
	const gap = parseFloat(getComputedStyle(top).columnGap) || 0;
	const pin = top.querySelector<HTMLElement>('.pin');
	const pinStyle = pin ? getComputedStyle(pin) : undefined;
	// The Pin keeps its actual icon width, margins and extra flex gap before the two text labels share the rest.
	const pinWidth = pin && pinStyle ? pin.getBoundingClientRect().width
		+ (parseFloat(pinStyle.marginLeft) || 0) + (parseFloat(pinStyle.marginRight) || 0) + gap : 0;
	const available = Math.max(0, Math.floor(top.clientWidth - gap - pinWidth));
	const folderWidth = measurePlace(location.folderPrefix ?? '');
	const separatorWidth = bullet ? measurePlace(bullet.textContent ?? '') : 0;
	const treeWidth = measurePlace(location.label);
	const nameWidth = measureName((name.textContent ?? '').replace(/\s+/g, ' '));
	const [, placeLimit] = widths(available, nameWidth, folderWidth + separatorWidth + treeWidth, 0.6);
	let placeWidth: number;
	if (folder && bullet) {
		const separator = Math.min(placeLimit, separatorWidth);
		const textLimit = placeLimit - separator;
		const [folderLimit] = widths(textLimit, folderWidth, treeWidth, 1 / 3, measurePlace('…'));
		const initialFolder = fit(location.folderPrefix!, folderLimit, measurePlace);
		// Whole graphemes rarely fill a budget exactly. Let the worktree use that spare room, then give any of its spare back.
		const fittedTree = fit(location.label, textLimit - initialFolder.width, measurePlace);
		const fittedFolder = fit(location.folderPrefix!, textLimit - fittedTree.width, measurePlace);
		show(folder, fittedFolder);
		show(tree, fittedTree);
		bullet.style.width = `${separator}px`;
		placeWidth = fittedFolder.width + separator + fittedTree.width;
	} else {
		const fitted = fit(location.label, placeLimit, measurePlace);
		show(tree, fitted);
		placeWidth = fitted.width;
	}
	place.style.width = `${placeWidth}px`;
	name.style.width = `${Math.min(nameWidth, available - placeWidth)}px`;
}
