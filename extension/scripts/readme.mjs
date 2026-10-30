/** Preserve the product description while omitting the checkout-only instructions (ARCHITECTURE-4.1). */
export function packageReadme(readme) {
	const starts = [...readme.matchAll(/<!--\s*repository-only:/g)];
	if (!starts.length) return readme;
	const markers = [...readme.matchAll(/<!-- repository-only:(start|end) -->/g)];
	if (starts.length !== 2 || markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end') {
		throw new Error('README repository-only markers must form one start/end pair.');
	}
	return readme.slice(0, markers[0].index) + readme.slice(markers[1].index + markers[1][0].length);
}
