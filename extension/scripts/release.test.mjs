import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import mirrorWorker from '../../.github/release-mirror/worker.mjs';
import { coreArchive, corePrograms } from '../../core/scripts/package-core.mjs';
import {
	candidateNeedsBuild, checksumsText, collectFromRun, fileFor, marketplaceFile, parseChecksums, releaseNotes,
	requiredReleaseFiles, sha256, storeOrder, targetsFor,
	validateCatalog, versionOfTag
} from './release.mjs';
import { publishMirror, pruneMirror } from './release-mirror.mjs';
import { captureNativePackage, evidenceFile, verifyNativePackages } from './native-package-evidence.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../archive/catalog.json'), 'utf8'));

/** A stored (uncompressed) ZIP with the manifests a VSIX carries. */
function vsix(file, { name, version, target, programs = [] }) {
	writeZip(file, [
		['extension/package.json', JSON.stringify({ publisher: 'facade', name, version })],
		['extension.vsixmanifest', `<Identity Id="${name}" Version="${version}" Publisher="facade"${target ? ` TargetPlatform="${target}"` : ''} />`],
		...programs.map(([program, bytes]) => ['extension/bin/' + program, bytes]),
	]);
}

function writeZip(file, content) {
	const entries = content.map(([entry, bytes]) => [Buffer.from(entry), Buffer.from(bytes)]);
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

test('a standalone release requires its complete native, editor and installation asset set', () => {
	const assets = requiredReleaseFiles('0.1.6');
	assert.equal(assets.length, 17);
	assert.equal(new Set(assets).size, 17);
	assert.equal(assets.filter(asset => asset.endsWith('.vsix')).length, 7);
	assert.equal(assets.filter(asset => asset.startsWith('facade-core-') && !asset.endsWith('.txt')).length, 6);
	for (const name of ['install.sh', 'install.ps1', 'facade-core-version.txt', 'SHA256SUMS']) assert.ok(assets.includes(name));
	assert.equal(requiredReleaseFiles('0.1.5').length, 8);
});

test('a partial draft resumes with its original signatures instead of signing a new package', () => {
	const version = '0.1.6';
	const assets = requiredReleaseFiles(version).map(name => ({ name }));
	assert.equal(candidateNeedsBuild(version), true);
	assert.equal(candidateNeedsBuild(version, { isDraft: true, assets: [] }), true);
	assert.equal(candidateNeedsBuild(version, { isDraft: true, assets }), false);
	assert.throws(() => candidateNeedsBuild(version, { isDraft: true, assets: assets.slice(0, -1) }),
		/reuse its signed artifacts/);
});

test('SHA256SUMS is what sha256sum -c reads, and a malformed line is refused', () => {
	const artifacts = [{ file: 'a.vsix', sha256: 'a'.repeat(64) }, { file: 'b.vsix', sha256: 'b'.repeat(64) }];
	const text = checksumsText(artifacts);
	assert.equal(text, `${'a'.repeat(64)}  a.vsix\n${'b'.repeat(64)}  b.vsix\n`);
	assert.deepEqual([...parseChecksums(text)], [['a.vsix', 'a'.repeat(64)], ['b.vsix', 'b'.repeat(64)]]);
	assert.throws(() => parseChecksums('abc  a.vsix\n'), /Malformed/);
	assert.throws(() => parseChecksums(text + text), /Duplicate/);
});

test('the official installer switches to a mirrored release after every asset is verified', async t => {
	const version = '0.1.7';
	const versionFile = 'facade-core-version.txt';
	const contents = new Map([
		['install.sh', 'new Unix installer'],
		['install.ps1', 'new Windows installer'],
		[versionFile, version + '\n'],
		['facade-core-linux-x64.tar.gz', 'new archive'],
	]);
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-mirror-test-'));
	t.after(() => {
		for (const file of contents.keys()) fs.unlinkSync(path.join(folder, file));
		fs.rmdirSync(folder);
	});
	const assets = [...contents].map(([file, content]) => {
		const local = path.join(folder, file);
		fs.writeFileSync(local, content);
		return { file, path: local, sha256: sha256(content) };
	});
	const objects = new Map([
		[versionFile, Buffer.from('0.1.6\n')],
		['releases/0.1.6/install.sh', Buffer.from('old Unix installer')],
	]);
	const RELEASES = {
		get(key) {
			const body = objects.get(key);
			return body ? { body, size: body.length, text: async () => body.toString() } : null;
		},
	};
	let interrupted = true;
	const request = async (url, options) => {
		const address = new URL(url);
		if (address.hostname === 'facadecode.com') return mirrorWorker.fetch(new Request(url), { RELEASES });
		assert.equal(address.hostname, 'api.cloudflare.com');
		assert.equal(options.method, 'PUT');
		const key = address.pathname.split('/objects/')[1];
		if (interrupted && key.endsWith('.tar.gz')) return new Response(null, { status: 503 });
		objects.set(key, options.body);
		return Response.json({ success: true });
	};
	const credentials = { account: 'a'.repeat(32), token: 'test-token', request };
	const installSh = 'https://facadecode.com/install.sh';
	await assert.rejects(publishMirror(version, assets, true, credentials), /HTTP 503/);
	assert.equal(await (await request(installSh)).text(), 'old Unix installer');
	interrupted = false;
	await publishMirror(version, assets, false, credentials);
	assert.equal(await (await request(installSh)).text(), 'old Unix installer');
	await publishMirror(version, assets, true, credentials);
	assert.equal(await (await request(installSh)).text(), contents.get('install.sh'));
	const windows = await request('https://facadecode.com/install.ps1');
	assert.match(windows.headers.get('content-type'), /^text\/plain/);
	assert.equal(await windows.text(), contents.get('install.ps1'));
});

test('website retention keeps ten formal releases and an unpublished candidate', async () => {
	const stable = Array.from({ length: 11 }, (_, at) => `0.2.${10 - at}`);
	const objects = [...stable, '0.2.11'].map(version => ({ key: `releases/${version}/SHA256SUMS` }));
	objects.push({ key: 'facade-core-version.txt' });
	const deleted = [];
	await pruneMirror(stable[0], stable, {
		account: 'a'.repeat(32),
		token: 'test-token',
		request: async (url, { method } = {}) => {
			const location = new URL(url);
			assert.equal(location.hostname, 'api.cloudflare.com');
			if (method === 'DELETE') {
				deleted.push(location.pathname.split('/objects/')[1]);
				return new Response(null, { status: 204 });
			}
			assert.equal(location.searchParams.get('prefix'), 'releases/');
			return Response.json({ success: true, result: objects });
		},
	});
	assert.deepEqual(deleted, ['releases/0.2.0/SHA256SUMS']);
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

test('the candidate verifier requires every native target and the tested bytes for this source and attempt', t => {
	const version = '0.1.6';
	const source = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), run: '1234', attempt: '1' };
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-candidate-evidence-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const targets = targetsFor(version).filter(target => target !== 'universal');
	const programsFor = target => corePrograms(target).map(program => [program, target + ' ' + program]);
	const writeArchive = (target, programs, license = 'fixture license') => {
		const core = path.join(directory, 'extension-' + target, 'core');
		fs.mkdirSync(core, { recursive: true });
		const name = coreArchive(target);
		const archive = path.join(core, name);
		const files = [...programs, ['VERSION', version + '\n'], ['LICENSE.txt', license]];
		if (target.startsWith('win32-')) {
			writeZip(archive, files);
		} else {
			const scratch = fs.mkdtempSync(path.join(directory, 'tar-'));
			try {
				for (const [file, bytes] of files) fs.writeFileSync(path.join(scratch, file), bytes);
				execFileSync('tar', ['-czf', archive, '-C', scratch, ...files.map(([file]) => file)]);
			} finally {
				fs.rmSync(scratch, { recursive: true, force: true });
			}
		}
		fs.writeFileSync(path.join(core, 'SHA256SUMS'), sha256(fs.readFileSync(archive)) + '  ' + name + '\n');
	};
	for (const target of targets) {
		const root = path.join(directory, 'extension-' + target);
		const programs = programsFor(target);
		vsix(path.join(root, 'vsix', fileFor(version, target)), { name: 'facadecode', version, target, programs });
		vsix(path.join(root, 'vsix', fileFor(version, 'universal')), { name: 'facadecode-window', version });
		writeArchive(target, programs);
		fs.writeFileSync(path.join(root, evidenceFile), JSON.stringify(captureNativePackage(root, target, version, source)));
	}
	assert.deepStrictEqual(verifyNativePackages(directory, version, source).map(record => record.target), targets);
	assert.throws(() => verifyNativePackages(directory, version, { ...source, tree: 'c'.repeat(40) }), /stale candidate/);
	assert.throws(() => verifyNativePackages(directory, version, { ...source, attempt: '2' }), /stale candidate/);

	const root = path.join(directory, 'extension-linux-x64');
	const moved = path.join(directory, 'withheld');
	fs.renameSync(root, moved);
	assert.throws(() => verifyNativePackages(directory, version, source), /Missing or unexpected native package targets/);
	fs.renameSync(moved, root);

	const filename = coreArchive('linux-x64');
	const archive = path.join(root, 'core', filename);
	const original = fs.readFileSync(archive);
	fs.writeFileSync(archive, 'altered archive');
	assert.throws(() => verifyNativePackages(directory, version, source), /differs from its candidate SHA256SUMS/);
	writeArchive('linux-x64', programsFor('linux-x64'), 'changed license');
	assert.throws(() => verifyNativePackages(directory, version, source), /package bytes differ from the tested files/);
	writeArchive('linux-x64', programsFor('linux-arm64'));
	assert.throws(() => captureNativePackage(root, 'linux-x64', version, source), /facade differs from the paired VSIX/);
	fs.writeFileSync(archive, original);
	fs.writeFileSync(path.join(root, 'core', 'SHA256SUMS'), sha256(original) + '  ' + filename + '\n');

	const window = path.join(root, 'vsix', fileFor(version, 'universal'));
	const alternate = path.join(root, 'vsix', 'alternate-window.vsix');
	fs.copyFileSync(window, alternate);
	assert.throws(() => verifyNativePackages(directory, version, source), /Missing or unexpected files in vsix/);
	fs.unlinkSync(alternate);
	vsix(window, { name: 'facadecode-window', version: '0.1.5' });
	assert.throws(() => verifyNativePackages(directory, version, source), /wrong version/);
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
