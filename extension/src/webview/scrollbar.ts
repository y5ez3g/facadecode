/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// VS Code's ScrollbarState geometry and AbstractScrollbar pointer mapping, adapted to the page's native scroll position.
// ScrollableElement's hover/scroll visibility applies to an overlay, never a layout gutter (PANEL-3.3).

import { cancelSmoothScroll } from './wheel';
import type { Scrolling } from './protocol';
import { pageDimensions } from './viewport';

export function installScrollbar(reducedMotion: () => boolean): { setOptions(options: Pick<Scrolling, 'scrollByPage' | 'modernUI'>): void } {
	const root = document.documentElement;
	const bar = document.createElement('div');
	bar.className = 'facade-scrollbar';
	bar.setAttribute('role', 'presentation');
	bar.setAttribute('aria-hidden', 'true');
	bar.hidden = true;
	const thumb = document.createElement('div');
	thumb.className = 'facade-scrollbar-thumb';
	bar.append(thumb);
	document.body.append(bar);
	const isWindows = /Windows/.test(navigator.userAgent);
	let scrollByPage = false;
	let hovered = root.matches(':hover');
	let dragging: { id: number; x: number; y: number; top: number; ratio: number; scrollTop: number } | undefined;
	let hideTimer: number | undefined;
	let frame: number | undefined;
	const clearHide = () => {
		window.clearTimeout(hideTimer);
		hideTimer = undefined;
	};
	const hide = () => {
		clearHide();
		if (!hovered && !dragging) { bar.classList.remove('visible'); }
	};
	const reveal = () => {
		clearHide();
		bar.classList.add('visible');
		if (!hovered && !dragging) { hideTimer = window.setTimeout(hide, 500); }
	};
	const measure = () => {
		const { height, content, range } = pageDimensions();
		const available = bar.getBoundingClientRect().height;
		const size = range ? Math.min(available, Math.max(20, Math.floor(height * available / content))) : available;
		const ratio = range ? (available - size) / range : 0;
		// The native scroller can clamp below our outward-rounded range by part of one device pixel.
		const top = range - root.scrollTop < 1 / devicePixelRatio ? available - size
			: Math.max(0, Math.min(available - size, Math.round(root.scrollTop * ratio * devicePixelRatio) / devicePixelRatio));
		return { height, range, size, ratio, top };
	};
	const finishDrag = (event?: PointerEvent) => {
		if (!dragging || (event && event.pointerId !== dragging.id)) { return; }
		const id = dragging.id;
		dragging = undefined;
		bar.classList.remove('dragging');
		if (bar.hasPointerCapture(id)) { bar.releasePointerCapture(id); }
		// Pointer capture can suppress leave events; the release coordinates decide whether the view is still hovered.
		hovered = event?.type === 'pointerup' && event.pointerType !== 'touch' && event.clientX >= 0 && event.clientX < root.clientWidth
			&& event.clientY >= 0 && event.clientY < root.clientHeight;
		hide();
	};
	const update = () => {
		// Show before measuring: a hidden bar has no clientHeight.
		bar.hidden = pageDimensions().range === 0;
		const { size, top } = measure();
		thumb.style.height = `${size}px`;
		thumb.style.transform = `translateY(${top}px)`;
		if (bar.hidden) { finishDrag(); }
	};
	const scheduleUpdate = () => {
		frame ??= requestAnimationFrame(() => { frame = undefined; update(); });
	};
	const setPosition = (top: number) => {
		cancelSmoothScroll();
		root.scrollTop = Math.max(0, Math.min(measure().range, Math.round(top * devicePixelRatio) / devicePixelRatio));
		update();
	};
	// Delegate from the root: a pointer entering the hidden overlay can still target the card beneath until the next paint.
	root.addEventListener('pointerdown', event => {
		if (event.button !== 0 || dragging || bar.hidden || !bar.classList.contains('visible')) { return; }
		const track = bar.getBoundingClientRect();
		if (event.clientX < track.left || event.clientX >= track.right || event.clientY < track.top || event.clientY >= track.bottom) { return; }
		const y = event.clientY - track.top;
		let geometry = measure();
		if (!geometry.range || !geometry.ratio) { return; }
		event.preventDefault();
		event.stopPropagation();
		cancelSmoothScroll();
		if (y < geometry.top || y > geometry.top + geometry.size) {
			setPosition(scrollByPage
				? root.scrollTop + (y < geometry.top ? -geometry.height : geometry.height)
				: (y - geometry.size / 2) / geometry.ratio);
			geometry = measure();
		}
		dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, top: geometry.top, ratio: geometry.ratio, scrollTop: root.scrollTop };
		bar.setPointerCapture(event.pointerId);
		bar.classList.add('dragging');
		reveal();
	}, { capture: true });
	bar.addEventListener('pointermove', event => {
		if (!dragging || event.pointerId !== dragging.id) { return; }
		event.preventDefault();
		setPosition(isWindows && Math.abs(event.clientX - dragging.x) > 140
			? dragging.scrollTop : (dragging.top + event.clientY - dragging.y) / dragging.ratio);
	});
	window.addEventListener('pointerup', finishDrag);
	window.addEventListener('pointercancel', finishDrag);
	bar.addEventListener('lostpointercapture', finishDrag);
	bar.addEventListener('click', event => event.stopPropagation());
	root.addEventListener('pointerenter', event => {
		if (event.pointerType === 'touch') { return; }
		hovered = true;
		reveal();
	});
	// Capture ending outside can leave the browser's root hover unchanged, so returning need not emit pointerenter.
	root.addEventListener('pointermove', event => {
		if (!hovered && event.pointerType !== 'touch' && event.clientX >= 0 && event.clientX < root.clientWidth
			&& event.clientY >= 0 && event.clientY < root.clientHeight) {
			hovered = true;
			reveal();
		}
	});
	root.addEventListener('pointerleave', () => { hovered = false; hide(); });
	window.addEventListener('blur', () => { finishDrag(); hovered = false; hide(); });
	window.addEventListener('focus', () => {
		hovered = root.matches(':hover');
		if (hovered) { reveal(); }
	});
	window.addEventListener('scroll', () => { scheduleUpdate(); reveal(); }, { passive: true });
	window.addEventListener('resize', scheduleUpdate);
	const size = new ResizeObserver(scheduleUpdate);
	size.observe(document.body);
	size.observe(root);
	size.observe(bar);
	const updateMotion = () => bar.classList.toggle('reduced-motion', reducedMotion());
	new MutationObserver(updateMotion).observe(document.body, { attributes: true, attributeFilter: ['class'] });
	matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', updateMotion);
	updateMotion();
	update();
	if (hovered) { reveal(); }
	return { setOptions: options => {
		scrollByPage = options.scrollByPage === true;
		document.body.classList.toggle('facade-modern', options.modernUI === true);
		bar.classList.toggle('modern', options.modernUI === true);
		update();
	} };
}
