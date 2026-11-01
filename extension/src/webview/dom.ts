/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Act, Card, Strings } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

/** The words the panel shows, in the window's language. */
export const strings = (window as unknown as { readonly FACADE_STRINGS: Strings }).FACADE_STRINGS;

/** Where the agents' avatars are. */
const logos = (window as unknown as { readonly FACADE_LOGOS: string }).FACADE_LOGOS;

const vscode = acquireVsCodeApi();

/**
 * This page's generation, made as it loads: the view's webview is a new page each time the view shows, and what the extension sends an
 * earlier one, late, is not for this one (PANEL-3.1).
 */
export const page = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Tells the extension something, as this page. */
export function post(message: { readonly type: string } & Record<string, unknown>): void {
	vscode.postMessage({ ...message, page });
}

/** Where the person was on this view's page, its scroll: kept by the webview as the view hides and shows again, never by the extension. */
export interface Browsing {
	readonly scrollTop: number;
	/** The run of the card the keyboard was on: the list's Tab stop again where that card still is (PANEL-3.1). */
	readonly target?: string;
}

/** The browsing position the page saved before the view was hidden, if any and well formed (PANEL-3.1); nothing else it saved. */
export function savedBrowsing(): Browsing | undefined {
	try {
		const saved = vscode.getState() as { scrollTop?: unknown; target?: unknown } | undefined;
		if (!saved || typeof saved.scrollTop !== 'number' || !Number.isFinite(saved.scrollTop)) {
			return undefined;
		}
		return { scrollTop: Math.max(0, saved.scrollTop), ...(typeof saved.target === 'string' ? { target: saved.target } : {}) };
	} catch {
		return undefined;
	}
}

/** Saves the browsing position, for this view's next page. */
export function saveBrowsing(browsing: Browsing): void {
	try {
		vscode.setState(browsing);
	} catch {
		// A page without saved state starts at the top, as a first page does
	}
}

let actions = 0;

/**
 * Has the extension do what the person did, on the card of run `target` where it is a card's (PANEL-3.1). Answers the action's ID,
 * which the extension's outcome names: this page's generation and a count, so that no other page's action has it.
 */
export function act(what: Act, target?: string): string {
	const action = `${page}-${++actions}`;
	post({ type: 'act', action, what, ...(target !== undefined ? { target } : {}) });
	return action;
}

/** What a field must be: a check of its value. */
export type Check = (value: unknown) => boolean;

export const isString: Check = value => typeof value === 'string';
export const isNumber: Check = value => typeof value === 'number' && Number.isFinite(value);
export const isBoolean: Check = value => typeof value === 'boolean';
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isStrings: Check = value => Array.isArray(value) && value.every(isString);

/** Whether `value` is an object with each field of `required`, those of `optional` it has, each as its check says - and no other. */
export function isShaped(value: unknown, required: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): value is Record<string, unknown> {
	return isObject(value)
		&& Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
		&& Object.keys(value).every(key => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](value[key])));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	element.className = className;
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

/** A button of words, as VS Code's views have them where they have nothing to show. */
export function button(text: string, run: () => void, secondary = false): HTMLButtonElement {
	const element = el('button', secondary ? 'button secondary' : 'button primary', text);
	element.type = 'button';
	element.addEventListener('click', event => {
		event.stopPropagation();
		run();
	});
	return element;
}

/** What a card's face is drawn of: a card drawn again with the same keeps its face node, whose image would flash loading again. */
export function lookOf(avatar: Card['avatar']): string {
	return !avatar ? '' : 'file' in avatar ? `file:${avatar.file}` : `initial:${avatar.color}:${avatar.initial}`;
}

/**
 * A card's face (PANEL-1.3): its CLI maker's avatar, cut round; for a custom CLI, the initial and theme colour the extension chose
 * (UX-2.1); an empty circle for a CLI with neither. Decorative: the card's label says everything it shows.
 */
export function face(avatar: Card['avatar']): HTMLElement {
	const element = el('span', 'face');
	element.setAttribute('aria-hidden', 'true');
	if (avatar && 'file' in avatar) {
		const img = el('img');
		img.src = `${logos}/${avatar.file}`;
		img.alt = '';
		element.append(img);
	} else if (avatar) {
		element.classList.add('initial', `on-${avatar.color}`);
		element.textContent = avatar.initial;
	}
	return element;
}

/**
 * The red, green and blue of a colour as the page computed it, each 0 to 1; none for one it gives otherwise, or for one that is not
 * opaque, whose look depends on what is under it.
 */
function channelsOf(color: string): readonly [number, number, number] | undefined {
	const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color);
	if (rgb) {
		return rgb[4] !== undefined && Number(rgb[4]) < 1 ? undefined : [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
	}
	const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(color);
	return srgb && !(srgb[4] !== undefined && Number(srgb[4]) < 1) ? [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])] : undefined;
}

/** How far apart two computed colours are, as WCAG measures text on its background: 1 to 21; none where either cannot be read. */
export function contrastOf(text: string, background: string): number | undefined {
	const luminance = (channels: readonly [number, number, number]) => {
		const [r, g, b] = channels.map(value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [a, b] = [channelsOf(text), channelsOf(background)];
	if (!a || !b) {
		return undefined;
	}
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/** A formatter for each language the page is in: each state makes every card's hover, and making one costs far more than using it. */
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** How long ago `time` was, as the browser says it in the window's language: now, 5 min. ago, yesterday, 3 days ago (UX-2.4). */
export function relativeTime(time: number): string {
	const language = document.documentElement.lang;
	let format = relativeTimeFormats.get(language);
	if (!format) {
		format = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto', style: 'short' });
		relativeTimeFormats.set(language, format);
	}
	const minutes = Math.floor((Date.now() - time) / 60_000);
	if (minutes < 1) {
		return format.format(0, 'second');
	}
	if (minutes < 60) {
		return format.format(-minutes, 'minute');
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? format.format(-hours, 'hour') : format.format(-Math.floor(hours / 24), 'day');
}
