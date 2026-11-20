const versionFile = 'facade-core-version.txt';
const installer = /^install\.(?:sh|ps1)$/;
const stableVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const releaseAsset = /^\/releases\/[0-9]+\.[0-9]+\.[0-9]+\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

function missing() {
	return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export default {
	async fetch(request, { RELEASES }) {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
		}

		const { pathname } = new URL(request.url);
		const file = pathname.slice(pathname.lastIndexOf('/') + 1);
		const versioned = releaseAsset.test(pathname);
		let key = pathname.slice(1);
		if (!versioned && key !== versionFile) {
			if (!installer.test(key)) return missing();
			const marker = await RELEASES.get(versionFile);
			const version = (await marker?.text())?.trim();
			if (!stableVersion.test(version ?? '')) return missing();
			key = `releases/${version}/${file}`;
		}

		const head = request.method === 'HEAD';
		const object = head ? await RELEASES.head(key) : await RELEASES.get(key);
		if (!object) return missing();
		const text = installer.test(file) || file === versionFile || file === 'SHA256SUMS';
		return new Response(head ? null : object.body, {
			headers: {
				'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
				'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-store',
				'Content-Length': String(object.size),
				'X-Content-Type-Options': 'nosniff',
			},
		});
	},
};
