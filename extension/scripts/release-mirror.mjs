import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { frameworkInstallers, frameworkVersionFile } from '../../framework/scripts/package-framework.mjs';
import { parseFrameworkBuild } from './framework.mjs';

const website = 'https://facadecode.com';
const bucket = 'facadecode-releases';
const retainedReleases = 10;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function r2Request({
	account = process.env.CLOUDFLARE_ACCOUNT_ID,
	token = process.env.CLOUDFLARE_API_TOKEN,
	request = fetch,
} = {}) {
	assert.match(account ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID for the release mirror');
	assert.ok(token, 'Set CLOUDFLARE_API_TOKEN for the release mirror');
	const objects = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`;
	return (suffix, { headers, ...options } = {}) => request(objects + suffix, {
		...options,
		headers: { ...headers, Authorization: `Bearer ${token}` },
		redirect: 'error',
		signal: AbortSignal.timeout(60_000),
	});
}

/** Stage verified Release assets or verify the website as it switches or resumes stable. */
export async function publishMirror(version, assets, latest, options) {
	const request = options?.request ?? fetch;
	const r2 = r2Request(options);
	const stableFiles = [...frameworkInstallers, frameworkVersionFile];
	const expected = new Map(assets.map(asset => [asset.file, asset.sha256]));
	assert.ok(stableFiles.every(file => expected.has(file)), 'The Release is missing a standalone installer or version marker');
	const markerBytes = readFileSync(assets.find(asset => asset.file === frameworkVersionFile).path);
	const marker = markerBytes.toString('utf8');
	const build = marker.trimEnd();
	assert.ok(parseFrameworkBuild(build)?.version === version && marker === build + '\n', 'The Release BUILD marker names another version');
	const markerDigest = expected.get(frameworkVersionFile);
	assert.equal(sha256(markerBytes), markerDigest, 'The stable marker differs from the GitHub Release');

	async function check(key, digest) {
		const result = await request(`${website}/${key}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
		if (result.status === 404) return false;
		assert.ok(result.ok, `${key} on the release mirror returned HTTP ${result.status}`);
		assert.equal(sha256(Buffer.from(await result.arrayBuffer())), digest, `${key} differs from the GitHub Release`);
		return true;
	}

	async function put(key, bytes) {
		const result = await r2('/' + key, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: bytes,
		});
		assert.ok(result.ok, `Cloudflare upload for ${key} returned HTTP ${result.status}`);
		assert.ok((await result.json()).success, `Cloudflare rejected upload for ${key}`);
	}

	for (const asset of assets) {
		const key = `releases/${version}/${asset.file}`;
		if (await check(key, asset.sha256)) continue;
		assert.ok(!latest, `${key} is missing from the staged mirror`);
		const bytes = readFileSync(asset.path);
		assert.equal(sha256(bytes), asset.sha256, `${asset.file} changed after GitHub verification`);
		await put(key, bytes);
		assert.ok(await check(key, asset.sha256), `${key} is missing after upload`);
	}

	if (latest) {
		const resume = options?.resume;
		if (!resume) await put(frameworkVersionFile, markerBytes);
		try {
			assert.ok(await check(frameworkVersionFile, markerDigest), 'The website has no stable marker for this candidate');
			for (const file of frameworkInstallers) {
				assert.ok(await check(file, expected.get(file)), `${file} is missing from the stable mirror`);
			}
			assert.ok(await check(frameworkVersionFile, markerDigest), 'The stable marker disappeared during read-back');
		} catch (error) {
			if (resume) throw error;
			throw new Error(`The website accepted the stable marker write for Facade Code Framework ${version}. Stable read-back failed. ${error.message}`, { cause: error });
		}
	}
	console.log(`Verified ${assets.length} files for the Facade Code Framework and Facade Code Extension release ${version} at ${website}`);
}

/** Remove only old formal releases from the mirror, after the new stable version is verified. */
export async function pruneMirror(current, stableVersions, options) {
	assert.equal(stableVersions[0], current, 'The new stable release is not yet visible in GitHub’s release list');
	const obsoleteVersions = new Set(stableVersions.slice(retainedReleases));
	if (!obsoleteVersions.size) return;

	const r2 = r2Request(options);
	const keys = [];
	const query = new URLSearchParams({ prefix: 'releases/', per_page: '1000' });
	for (;;) {
		const response = await r2('?' + query);
		assert.ok(response.ok, `Cloudflare list returned HTTP ${response.status}`);
		const page = await response.json();
		assert.ok(page.success && Array.isArray(page.result), 'Cloudflare did not list the release files');
		for (const object of page.result) {
			const version = /^releases\/([0-9]+\.[0-9]+\.[0-9]+)\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/.exec(object.key)?.[1];
			if (obsoleteVersions.has(version)) keys.push(object.key);
		}
		if (!page.result_info?.is_truncated) break;
		const cursor = page.result_info.cursor;
		assert.ok(cursor && cursor !== query.get('cursor'), 'Cloudflare did not advance the listing cursor');
		query.set('cursor', cursor);
	}

	for (const key of keys) {
		const result = await r2('/' + key, { method: 'DELETE' });
		assert.ok(result.ok || result.status === 404, `Cloudflare removal of ${key} returned HTTP ${result.status}`);
	}
	console.log(`Removed ${keys.length} old release files from the website mirror.`);
}
