/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Act, AgoWords, Card, Strings } from './protocol';

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
	return avatar ? `file:${avatar.file}${avatar.eyes ? `+${avatar.eyes}` : ''}` : '';
}

/**
 * A card's face (PANEL-1.3): its CLI's icon, cut round - a built-in's maker avatar, or a robot's face with its eyes over it, which look
 * toward the pointer (CONFIGURATION-2.4). Decorative: the card's label says everything it shows.
 */
export function face(avatar: Card['avatar']): HTMLElement {
	const element = el('span', 'face');
	element.setAttribute('aria-hidden', 'true');
	for (const [file, className] of avatar ? [[avatar.file, ''], ...avatar.eyes ? [[avatar.eyes, 'eyes']] : []] : []) {
		const img = el('img', className);
		img.src = `${logos}/${file}`;
		img.alt = '';
		element.append(img);
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
	return contrastAt(text, background, 1);
}

/**
 * How far apart text drawn at `alpha` over its background reads from that background, as WCAG measures it: 1 to 21; none where
 * either colour cannot be read.
 */
export function contrastAt(text: string, background: string, alpha: number): number | undefined {
	const luminance = (channels: readonly number[]) => {
		const [r, g, b] = channels.map(value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [a, b] = [channelsOf(text), channelsOf(background)];
	if (!a || !b) {
		return undefined;
	}
	const drawn = a.map((value, i) => value * alpha + b[i] * (1 - alpha));
	const [light, dark] = [luminance(drawn), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/**
 * How long ago `time` was, in Resume Agent's words and by its steps (LIFECYCLE-3.2, UX-2.4): now, 45 secs ago, 5 mins ago, 2 hrs ago, 3
 * days ago, 2 wks ago, 4 mos ago, 1 yr ago - so that an agent's start reads as a conversation's last activity does. Where the source's
 * clock is ahead of the host's, which can supply no honest age, its date and time.
 */
export function agoOf(time: number, now: number, words: AgoWords): string {
	if (time > now) {
		return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(time);
	}
	const seconds = Math.round((now - time) / 1_000);
	const count = (one: string, many: string, unit: number) => {
		const n = Math.round(seconds / unit);
		return (n === 1 ? one : many).replace('{0}', String(n));
	};
	return seconds < 30 ? words.now : seconds < 60 ? words.secs.replace('{0}', String(seconds)) : seconds < 3_600 ? count(words.min, words.mins, 60)
		: seconds < 86_400 ? count(words.hr, words.hrs, 3_600) : seconds < 604_800 ? count(words.day, words.days, 86_400)
			: seconds < 2_592_000 ? count(words.wk, words.wks, 604_800) : seconds < 31_536_000 ? count(words.mo, words.mos, 2_592_000)
				: count(words.yr, words.yrs, 31_536_000);
}

/**
 * How long until {@link agoOf}'s words for `time` change, by its own rounding (PANEL-1.5, UX-2.4): `just now` until 30 rounded seconds;
 * seconds at each rounded second; minutes at each half minute they round up, 89.5 s, 149.5 s and on; past the hour, a look each minute.
 * A time ahead of the clock says its date and time until it no longer is ahead, looked at again within a minute as the clock may move.
 */
export function agoChangesIn(time: number, now: number): number {
	const age = now - time;
	if (age < 0) {
		return Math.min(-age, 60_000);
	}
	if (age < 29_500) {
		return 29_500 - age;
	}
	if (age < 59_500) {
		return (Math.round(age / 1_000) + 0.5) * 1_000 - age;
	}
	if (age < 3_599_500) {
		const minutes = Math.round(Math.round(age / 1_000) / 60);
		return Math.min(minutes * 60_000 + 29_500, 3_599_500) - age;
	}
	return 60_000;
}
