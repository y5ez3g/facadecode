/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

let viewport: HTMLDivElement | undefined;
let clipping = { top: 0, left: 0, right: 0, bottom: 0 };

/** The browser's fractional page geometry, shared by wheel, dragging and saved-position restoration. */
export function pageDimensions(): { height: number; content: number; range: number; visibleTop: number; visibleBottom: number } {
	const root = document.documentElement;
	const height = viewport?.getBoundingClientRect().height ?? root.clientHeight;
	const content = Math.max(height, root.getBoundingClientRect().height);
	// A partially occupied device pixel belongs to the scroll range. Ignore DOMRect floating-point noise at an edge.
	const range = Math.max(0, Math.ceil((content - height) * devicePixelRatio - 0.001) / devicePixelRatio);
	return { height, content, range, visibleTop: clipping.top, visibleBottom: height - clipping.bottom };
}

/** Correct the whole page and overlay against the embedding clip, without reading the editor's private DOM. */
export function installViewport(): void {
	viewport = document.createElement('div');
	viewport.className = 'facade-scrollbar-viewport';
	viewport.setAttribute('aria-hidden', 'true');
	document.body.append(viewport);
	let observer: IntersectionObserver | undefined;
	const align = ([entry]: IntersectionObserverEntry[]) => {
		if (!entry?.isIntersecting) { return; }
		const bounds = entry.boundingClientRect, visible = entry.intersectionRect;
		const pixel = (distance: number) => Math.max(0, Math.round(distance * devicePixelRatio) / devicePixelRatio);
		// Cross-origin bounds can round outward. This guard covers that partial pixel, independently of visual padding.
		const guard = entry.rootBounds === null ? 1 / devicePixelRatio : 0;
		clipping = {
			top: pixel(visible.top - bounds.top), left: pixel(visible.left - bounds.left),
			right: pixel(bounds.right - visible.right) + guard, bottom: pixel(bounds.bottom - visible.bottom) + guard
		};
		for (const [edge, distance] of Object.entries({ ...clipping, guard })) {
			const property = `--facade-clip-${edge}`, value = `${distance}px`;
			if (document.body.style.getPropertyValue(property) !== value) { document.body.style.setProperty(property, value); }
		}
	};
	const observe = () => {
		observer?.disconnect();
		const bounds = viewport!.getBoundingClientRect();
		// Full-viewport area avoids thin probes whose raster-rounded height can conceal a clipped column.
		const steps = Math.max(1, Math.ceil(Math.max(bounds.width, bounds.height) * devicePixelRatio * 2));
		observer = new IntersectionObserver(align, { threshold: Array.from({ length: steps + 1 }, (_, index) => index / steps) });
		observer.observe(viewport!);
	};
	new ResizeObserver(observe).observe(viewport);
	const watchScale = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
		observe(); watchScale();
	}, { once: true });
	watchScale();
	observe();
}
