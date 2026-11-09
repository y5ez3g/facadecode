import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
	checksumsText, collectFromRun, fileFor, marketplaceFile, parseChecksums, releaseNotes, sha256, storeOrder, targetsFor,
	validateCatalog, versionOfTag
} from './release.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../archive/catalog.json'), 'utf8'));

/** A stored (uncompressed) ZIP with the manifests a VSIX carries. */
function vsix(file, { name, version, target }) {
	const entries = [
		['extension/package.json', JSON.stringify({ publisher: 'facade', name, version })],
		['extension.vsixmanifest', `<Identity Id="${name}" Version="${version}" Publisher="facade"${target ? ` TargetPlatform="${target}"` : ''} />`]
	].map(([entry, text]) => [Buffer.from(entry), Buffer.from(text)]);
	const locals = [], centrals = [];
	let offset = 0;
	for (const [entry, data] of entries) {
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(entry.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(entry.length, 28); central.writeUInt32LE(offset, 42);
		locals.push(local, entry, data); centrals.push(central, entry);
		offset += 30 + entry.length + data.length;
	}
	const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

/** What download-artifact leaves: one folder per native job, each with its package and a Window Component. */
function ciRun(version, { skip, window = v => ({ name: 'facadecode-window', version: v }) } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-release-test-'));
	for (const target of targetsFor(version).filter(t => t !== 'universal' && t !== skip)) {
		vsix(path.join(dir, `extension-${target}`, fileFor(version, target)), { name: 'facadecode', version, target });
		vsix(path.join(dir, `extension-${target}`, fileFor(version, 'universal')), window(version));
	}
	return dir;
}

test('the catalog of store-first versions keeps one original file per platform and the Window Component', () => {
	validateCatalog(catalog);
	assert.deepEqual(catalog.releases.at(-1).artifacts.map(a => a.target).sort(), [...targetsFor('0.1.1')].sort());
});

test('a missing platform, repeated version, cross-version URL or unsafe file name fails before any download', () => {
	for (const mutate of [
		c => c.releases[0].artifacts.pop(),
		c => c.releases.push(structuredClone(c.releases[0])),
		c => { c.releases[0].artifacts[0].sourceUrl = c.releases[1].artifacts[0].sourceUrl; },
		c => { c.releases[0].artifacts[0].file = '../another.vsix'; },
		c => { c.releases[0].sourceRevision = 'main'; },
		c => { c.releases.at(-1).artifacts = c.releases.at(-1).artifacts.filter(a => a.target !== 'win32-arm64'); }
	]) {
		const changed = structuredClone(catalog);
		mutate(changed);
		assert.throws(() => validateCatalog(changed));
	}
});

test('releases from 0.1.1 carry six native packages, earlier ones their original three', () => {
	assert.deepEqual(targetsFor('0.1.0'), ['darwin-arm64', 'linux-x64', 'win32-x64', 'universal']);
	assert.equal(targetsFor('0.1.1').length, 7);
	assert.equal(targetsFor('0.2.0').length, 7);
	assert.equal(fileFor('0.1.2', 'universal'), 'facadecode-window-0.1.2.vsix');
	assert.equal(fileFor('0.1.2', 'linux-arm64'), 'facadecode-linux-arm64-0.1.2.vsix');
});

test('only extension/<major.minor.patch> tags release', () => {
	assert.equal(versionOfTag('extension/0.1.12'), '0.1.12');
	for (const tag of ['facade/0.1.2', 'extension/0.1', 'extension/v0.1.2', 'extension/0.1.2-rc1', undefined]) assert.throws(() => versionOfTag(tag));
});

test('SHA256SUMS is what sha256sum -c reads, and a malformed line is refused', () => {
	const artifacts = [{ file: 'a.vsix', sha256: 'a'.repeat(64) }, { file: 'b.vsix', sha256: 'b'.repeat(64) }];
	const text = checksumsText(artifacts);
	assert.equal(text, `${'a'.repeat(64)}  a.vsix\n${'b'.repeat(64)}  b.vsix\n`);
	assert.deepEqual([...parseChecksums(text)], [['a.vsix', 'a'.repeat(64)], ['b.vsix', 'b'.repeat(64)]]);
	assert.throws(() => parseChecksums('abc  a.vsix\n'), /Malformed/);
});

test('release notes are the changelog section of that version alone', () => {
	const changelog = '# Changelog\n\n## 0.1.2\n\n- New.\n\n## 0.1.1\n\n- Older.\n- Second.\n\n## 0.1.0\n\n- Oldest.\n';
	assert.equal(releaseNotes(changelog, '0.1.1'), '- Older.\n- Second.');
	assert.equal(releaseNotes(changelog, '0.1.0'), '- Oldest.');
	assert.throws(() => releaseNotes(changelog, '0.1.3'), /no section for 0.1.3/);
	assert.ok(releaseNotes(fs.readFileSync(path.join(import.meta.dirname, '../CHANGELOG.md'), 'utf8'), '0.1.1').length > 0);
});

test('a run releases each native package and linux-x64\'s Window Component, each checked by its own manifests', () => {
	const dir = ciRun('0.1.2');
	const artifacts = collectFromRun('0.1.2', dir);
	assert.deepEqual(artifacts.map(a => a.file), targetsFor('0.1.2').map(t => fileFor('0.1.2', t)));
	const window = artifacts.find(a => a.target === 'universal');
	assert.equal(path.basename(path.dirname(window.path)), 'extension-linux-x64');
	for (const a of artifacts) assert.equal(a.sha256, sha256(fs.readFileSync(a.path)));
});

test('a run missing a platform, or holding another version or a mislabelled package, releases nothing', () => {
	assert.throws(() => collectFromRun('0.1.2', ciRun('0.1.2', { skip: 'win32-arm64' })), /facadecode-win32-arm64-0.1.2.vsix is missing/);
	const stray = ciRun('0.1.2');
	vsix(path.join(stray, 'extension-linux-x64', fileFor('0.1.1', 'linux-x64')), { name: 'facadecode', version: '0.1.1', target: 'linux-x64' });
	assert.throws(() => collectFromRun('0.1.2', stray), /another version or target/);
	assert.throws(() => collectFromRun('0.1.2', ciRun('0.1.2', { window: () => ({ name: 'facadecode-window', version: '0.1.1' }) })), /wrong version/);
	const relabelled = ciRun('0.1.2');
	vsix(path.join(relabelled, 'extension-darwin-x64', fileFor('0.1.2', 'darwin-x64')), { name: 'facadecode', version: '0.1.2', target: 'darwin-arm64' });
	assert.throws(() => collectFromRun('0.1.2', relabelled), /wrong target/);
	const twice = ciRun('0.1.2');
	vsix(path.join(twice, 'extra', fileFor('0.1.2', 'linux-x64')), { name: 'facadecode', version: '0.1.2', target: 'linux-x64' });
	assert.throws(() => collectFromRun('0.1.2', twice), /packaged more than once/);
});

test('the stores get the Window Component before the packages that install it', () => {
	const ordered = storeOrder(targetsFor('0.1.2').map(target => ({ target })));
	assert.equal(ordered[0].target, 'universal');
	assert.equal(ordered.length, 7);
});

test('a Marketplace version counts only for the same component, version and platform', () => {
	const listed = [
		{ component: 'facadecode', version: '0.1.2', target: 'linux-x64', url: 'https://x/linux' },
		{ component: 'facadecode', version: '0.1.1', target: 'darwin-x64', url: 'https://x/old' },
		{ component: 'facadecode-window', version: '0.1.2', target: 'universal', url: 'https://x/window' }
	];
	assert.equal(marketplaceFile(listed, '0.1.2', { target: 'linux-x64' }), 'https://x/linux');
	assert.equal(marketplaceFile(listed, '0.1.2', { target: 'universal' }), 'https://x/window');
	assert.equal(marketplaceFile(listed, '0.1.2', { target: 'darwin-x64' }), undefined);
	assert.equal(marketplaceFile(listed, '0.1.2', { target: 'win32-x64' }), undefined);
});
