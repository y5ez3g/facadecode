import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePublishedReleases, matchingRun, publishedReleases } from './archive-sync.mjs';
import { validateCatalog } from './archive.mjs';

function release(version) {
	const targets = version === '0.1.0' || version === '0.0.7'
		? ['darwin-arm64', 'linux-x64', 'win32-x64', 'universal']
		: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64', 'universal'];
	return { version, sourceRevision: '1'.repeat(40), evidence: { verification: 'Synthetic fixture' }, artifacts: targets.map(target => {
		const component = target === 'universal' ? 'facadecode-window' : 'facadecode';
		return { target, file: target === 'universal' ? `facadecode-window-${version}.vsix` : `facadecode-${target}-${version}.vsix`,
			sha256: '0'.repeat(64), sourceUrl: `https://facade.gallerycdn.vsassets.io/extensions/facade/${component}/${version}/1/Microsoft.VisualStudio.Services.VSIXPackage` };
	}) };
}

const catalog = releases => ({ schemaVersion: 1, name: '@y5ez3g/facade-extension', repository: 'https://github.com/y5ez3g/facadecode.git', releases });

test('discovery groups platforms and the matching window component in numeric version order', () => {
	const versions = ['0.1.10', '0.1.9'];
	const execution = { versions: versions.flatMap(version => release(version).artifacts.filter(a => a.target !== 'universal').map(a => ({
		version, targetPlatform: a.target, files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: a.sourceUrl }]
	}))) };
	const window = { versions: versions.map(version => ({ version, files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: release(version).artifacts.at(-1).sourceUrl }] })) };
	const discovered = publishedReleases(execution, window);
	assert.deepEqual(discovered.map(r => [r.version, r.artifacts.length]), [['0.1.9', 7], ['0.1.10', 7]]);
	assert.throws(() => publishedReleases(execution, { versions: [] }), /Window Component is missing/);
});

test('synchronization fills an older gap even when a newer version is archived, and is idempotent', async () => {
	const original = catalog([release('0.0.7'), release('0.1.1')]);
	const before = structuredClone(original);
	const published = [release('0.0.7'), release('0.1.0'), release('0.1.1')];
	const calls = [];
	const merged = await mergePublishedReleases(original, published, async r => { calls.push(r.version); return r; });
	assert.deepEqual([calls, merged.releases.map(r => r.version)], [['0.1.0'], ['0.0.7', '0.1.0', '0.1.1']]);
	assert.deepEqual(original, before);
	assert.deepEqual(merged.releases.filter(r => r.version !== '0.1.0'), original.releases);
	assert.deepEqual(await mergePublishedReleases(merged, published, () => { throw new Error('already archived'); }), merged);
});

test('failed verification returns no partially updated catalog', async () => {
	const original = catalog([release('0.0.7')]);
	const before = structuredClone(original);
	await assert.rejects(mergePublishedReleases(original, [release('0.1.0'), release('0.1.1')], async r => {
		if (r.version === '0.1.1') throw new Error('published bytes differ from CI');
		return r;
	}), /published bytes differ/);
	assert.deepEqual(original, before);
});

test('CI matching requires the same version and every original VSIX hash, not just a successful run', async () => {
	const published = release('0.1.0');
	const runs = [{ id: 1 }, { id: 2 }, { id: 3 }];
	const checked = [];
	const winner = await matchingRun(published, runs, async r => r.id === 1 ? '0.0.7' : '0.1.0', async r => {
		checked.push(r.id);
		return r.id === 2 ? published.artifacts.slice(1) : published.artifacts;
	});
	assert.deepEqual([winner.id, checked], [3, [2, 3]]);
	await assert.rejects(matchingRun(published, runs.slice(1, 2), async () => '0.1.0', async () => published.artifacts.map(a => ({ ...a, sha256: 'f'.repeat(64) }))), /no retained successful CI run/);
});

test('historical releases without tags require an explicit source commit', () => {
	validateCatalog(catalog([release('0.1.0')]));
	const missingSource = release('0.1.0');
	delete missingSource.sourceRevision;
	assert.throws(() => validateCatalog(catalog([missingSource])), /Invalid source revision/);
});
