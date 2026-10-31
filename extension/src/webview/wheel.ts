/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The page's wheel, taken as VS Code's lists take it (PANEL-3.3): VS Code's own code, ported - how a wheel event is read
// (StandardWheelEvent, base/browser/mouseEvent.ts), how a physical mouse wheel is told from a touchpad and what a list's scrollable
// element does with a wheel (MouseWheelClassifier and _onMouseWheel, base/browser/ui/scrollbar/scrollableElement.ts), and its smooth
// scroll (SmoothScrollingOperation, base/common/scrollable.ts). The page's own element scrolls: its scrollbar, keys and screen
// reader stay the page's.

import type { Scrolling } from './protocol';

/** The pixels a wheel's line scrolls. */
const SCROLL_WHEEL_SENSITIVITY = 50;
/** How long a list's smooth scroll takes, where `workbench.list.smoothScrolling` is on. */
const SMOOTH_SCROLL_MS = 125;

const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
/** Chrome before 123 does not factor the device pixel ratio into a wheel event. */
const factorDevicePixelRatio = chrome !== null && Number(chrome[1]) <= 122;
const isMacintosh = /Macintosh|Mac OS X/.test(navigator.userAgent);
const isFirefox = /Firefox\//.test(navigator.userAgent);

/** VS Code's defaults, until the extension says the person's settings. */
let scrolling: Scrolling = { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1 };

/** Takes the person's list settings from now on. */
export function setScrolling(next: Scrolling): void {
	scrolling = next;
}

/** A wheel event's movement in lines, positive up and left, as VS Code reads one. */
function wheelOf(e: WheelEvent): { readonly deltaX: number; readonly deltaY: number } {
	const legacy = e as WheelEvent & { readonly wheelDelta?: number; readonly wheelDeltaX?: number; readonly wheelDeltaY?: number };
	const devicePixelRatio = e.view?.devicePixelRatio || 1;
	const fromWheelDelta = (value: number) => factorDevicePixelRatio ? value / (120 * devicePixelRatio) : value / 120;
	const fromDelta = (value: number) => e.deltaMode === WheelEvent.DOM_DELTA_LINE ? (isFirefox && !isMacintosh ? -value / 3 : -value) : -value / 40;
	let deltaY = legacy.wheelDeltaY !== undefined ? fromWheelDelta(legacy.wheelDeltaY) : fromDelta(e.deltaY);
	const deltaX = legacy.wheelDeltaX !== undefined ? fromWheelDelta(legacy.wheelDeltaX) : fromDelta(e.deltaX);
	// Assume a vertical scroll if nothing else worked
	if (deltaY === 0 && deltaX === 0 && legacy.wheelDelta) {
		deltaY = fromWheelDelta(legacy.wheelDelta);
	}
	return { deltaX, deltaY };
}

/**
 * Whether the wheel events of late come from a physical mouse wheel rather than a touchpad or magic mouse: each scored, the last
 * weighing most, from whether both axes move, whether its deltas are whole, and whether they keep one step.
 */
class MouseWheelClassifier {
	private readonly capacity = 5;
	private readonly memory: { readonly deltaX: number; readonly deltaY: number; score: number }[] = [];
	private front = -1;
	private rear = -1;

	isPhysicalMouseWheel(): boolean {
		if (this.front === -1 && this.rear === -1) {
			return false;
		}
		// 0.5 * last + 0.25 * 2nd last + 0.125 * 3rd last + ...
		let remainingInfluence = 1;
		let score = 0;
		let iteration = 1;
		let index = this.rear;
		for (; ;) {
			const influence = index === this.front ? remainingInfluence : Math.pow(2, -iteration);
			remainingInfluence -= influence;
			score += this.memory[index].score * influence;
			if (index === this.front) {
				break;
			}
			index = (this.capacity + index - 1) % this.capacity;
			iteration++;
		}
		return score <= 0.5;
	}

	/**
	 * On Chrome a wheel's deltas are multiplied by the window's zoom, taken out again here. VS Code reads the window's actual zoom;
	 * a page has `window.zoomLevel` alone, which a window zoomed by itself (`window.zoomPerWindow`) does not change (PANEL-3.3).
	 */
	acceptWheel(deltaX: number, deltaY: number): void {
		const zoom = chrome !== null ? scrolling.zoomFactor : 1;
		this.accept(deltaX * zoom, deltaY * zoom);
	}

	private accept(deltaX: number, deltaY: number): void {
		let previous: { readonly deltaX: number; readonly deltaY: number } | undefined;
		const item = { deltaX, deltaY, score: 0 };
		if (this.front === -1 && this.rear === -1) {
			this.memory[0] = item;
			this.front = 0;
			this.rear = 0;
		} else {
			previous = this.memory[this.rear];
			this.rear = (this.rear + 1) % this.capacity;
			if (this.rear === this.front) {
				// Drop oldest
				this.front = (this.front + 1) % this.capacity;
			}
			this.memory[this.rear] = item;
		}
		item.score = this.scoreOf(item, previous);
	}

	/** Towards 0 for a physical mouse wheel, towards 1 for a touchpad or magic mouse. */
	private scoreOf(item: { readonly deltaX: number; readonly deltaY: number }, previous: { readonly deltaX: number; readonly deltaY: number } | undefined): number {
		if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) {
			// Both axes exercised: definitely not a physical mouse wheel
			return 1;
		}
		let score = 0.5;
		if (!almostInt(item.deltaX) || !almostInt(item.deltaY)) {
			// Non-integer deltas: an indicator that this is not a physical mouse wheel
			score += 0.25;
		}
		// Non-accelerating scroll - deltas that are each other's multiples - is an indicator of a physical mouse wheel
		if (previous) {
			const absDeltaX = Math.abs(item.deltaX);
			const absDeltaY = Math.abs(item.deltaY);
			const absPreviousDeltaX = Math.abs(previous.deltaX);
			const absPreviousDeltaY = Math.abs(previous.deltaY);
			// Min 1 to avoid division by zero, modulo 1 still being 0
			const minDeltaX = Math.max(Math.min(absDeltaX, absPreviousDeltaX), 1);
			const minDeltaY = Math.max(Math.min(absDeltaY, absPreviousDeltaY), 1);
			const maxDeltaX = Math.max(absDeltaX, absPreviousDeltaX);
			const maxDeltaY = Math.max(absDeltaY, absPreviousDeltaY);
			if (maxDeltaX % minDeltaX === 0 && maxDeltaY % minDeltaY === 0) {
				score -= 0.5;
			}
		}
		return Math.min(Math.max(score, 0), 1);
	}
}

function almostInt(value: number): boolean {
	const epsilon = Number.EPSILON * 100;
	return Math.abs(Math.round(value) - value) < 0.01 + epsilon;
}

const classifier = new MouseWheelClassifier();

function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

/** The page's scroll from `from` to `to` over `duration`, eased out; a long one jumps most of the way between two eases. */
function animationOf(from: number, to: number, viewport: number): (completion: number) => number {
	const ease = (a: number, b: number) => (completion: number) => a + (b - a) * easeOutCubic(completion);
	if (Math.abs(from - to) <= 2.5 * viewport) {
		return ease(from, to);
	}
	// Scroll 75% of the viewport at each end
	const first = from < to ? ease(from, from + 0.75 * viewport) : ease(from, from - 0.75 * viewport);
	const last = from < to ? ease(to - 0.75 * viewport, to) : ease(to + 0.75 * viewport, to);
	return completion => completion < 0.33 ? first(completion / 0.33) : last((completion - 0.33) / (1 - 0.33));
}

/** The smooth scroll under way: where it goes, and the frame that moves it next. */
let smooth: { readonly to: number; readonly start: number; readonly duration: number; readonly move: (completion: number) => number; frame: number; at: number } | undefined;

const root = () => document.scrollingElement ?? document.documentElement;
const clamped = (scrollTop: number) => Math.max(0, Math.min(scrollTop, root().scrollHeight - root().clientHeight));

/** Ends a smooth scroll under way where it is: the keyboard moved, or the person took the scrollbar. */
export function cancelSmoothScroll(): void {
	if (smooth) {
		cancelAnimationFrame(smooth.frame);
		smooth = undefined;
	}
}

function smoothTo(to: number): void {
	const now = Date.now();
	cancelSmoothScroll();
	// +10 / -10: as though the animation started already, for a quicker answer to the wheel
	const from = root().scrollTop;
	const next = { to, start: now - 10, duration: SMOOTH_SCROLL_MS + 10, move: animationOf(from, to, root().clientHeight), frame: 0, at: from };
	smooth = next;
	const tick = () => {
		if (smooth !== next) {
			return;
		}
		const completion = (Date.now() - next.start) / next.duration;
		// Whole pixels, cut as a list's scroll position is
		next.at = Math.trunc(completion < 1 ? next.move(completion) : next.to);
		root().scrollTop = next.at;
		if (completion < 1) {
			next.frame = requestAnimationFrame(tick);
		} else {
			smooth = undefined;
		}
	};
	next.frame = requestAnimationFrame(tick);
}

/**
 * Scrolls the page on a wheel as a list of VS Code's scrolls: whole pixels of 50 a line times `workbench.list.mouseWheelScrollSensitivity`
 * - `fastScrollSensitivity` times more with Alt - along the predominant axis alone, gliding only for a physical mouse wheel where
 * `smoothScrolling` is on and the person did not ask for less motion. The list takes every wheel, so that nothing beyond it scrolls;
 * Ctrl's is left to the editor.
 */
export function takeWheel(reducedMotion: () => boolean): void {
	window.addEventListener('wheel', e => {
		if (e.defaultPrevented || e.ctrlKey) {
			return;
		}
		const wheel = wheelOf(e);
		classifier.acceptWheel(wheel.deltaX, wheel.deltaY);
		let deltaY = wheel.deltaY * scrolling.sensitivity;
		let deltaX = wheel.deltaX * scrolling.sensitivity;
		if (Math.abs(deltaY) >= Math.abs(deltaX)) {
			deltaX = 0;
		} else {
			deltaY = 0;
		}
		// Shift turns a vertical scroll horizontal - macOS does so itself - and this list scrolls no further sideways
		if (!isMacintosh && e.shiftKey && !deltaX) {
			deltaX = deltaY;
			deltaY = 0;
		}
		if (e.altKey) {
			deltaY *= scrolling.fastSensitivity;
		}
		if (deltaY) {
			const future = smooth?.to ?? root().scrollTop;
			const delta = SCROLL_WHEEL_SENSITIVITY * deltaY;
			// -0.3 is -1 and 0.3 is 1, so that a slow scroll scrolls at all
			const desired = clamped(future - (delta < 0 ? Math.floor(delta) : Math.ceil(delta)));
			if (desired !== future) {
				if (scrolling.smooth && classifier.isPhysicalMouseWheel() && !reducedMotion()) {
					smoothTo(desired);
				} else {
					cancelSmoothScroll();
					root().scrollTop = desired;
				}
			}
		}
		e.preventDefault();
		e.stopPropagation();
	}, { passive: false });
	// What scrolls the page but the glide - the scrollbar dragged, a key - ends it where it is
	window.addEventListener('scroll', () => {
		if (smooth && Math.abs(root().scrollTop - smooth.at) > 1) {
			cancelSmoothScroll();
		}
	}, { passive: true });
}
