import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import mirrorWorker from '../../.github/release-mirror/worker.mjs';
import { coreArchive, corePrograms } from '../../core/scripts/package-core.mjs';
import {
	candidateNeedsBuild, checksumsText, fileFor, marketplaceFile, parseChecksums, releaseNotes,
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
	await assert.rejects(publishMirror(version, assets, false, credentials), /HTTP 503/);
	await assert.rejects(publishMirror(version, assets, true, credentials), /missing from the staged mirror/);
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

const programsFor = target => corePrograms(target).map(program => [program, 'test fixture ' + target + ' ' + program]);

function writeArchive(directory, target, version, programs, license = 'fixture license') {
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
}

function writeNativePackages(directory, version, source, { mockSigning = false } = {}) {
	const targets = targetsFor(version).filter(target => target !== 'universal');
	for (const target of targets) {
		const root = path.join(directory, 'extension-' + target);
		const programs = programsFor(target);
		vsix(path.join(root, 'vsix', fileFor(version, target)), { name: 'facadecode', version, target, programs });
		vsix(path.join(root, 'vsix', fileFor(version, 'universal')), { name: 'facadecode-window', version, programs: [['fixture', target]] });
		writeArchive(directory, target, version, programs);
		const evidence = captureNativePackage(root, target, version, source);
		if (mockSigning && target.startsWith('win32-')) {
			// The named programs contain fixture text. This models the trusted runner record without exercising SignTool.
			evidence.signing = {
				method: 'windows-authenticode-timestamp',
				programs: Object.fromEntries(programs.map(([name, bytes]) => [name, sha256(bytes)])),
			};
		}
		fs.writeFileSync(path.join(root, evidenceFile), JSON.stringify(evidence));
	}
	return targets;
}

test('the candidate verifier requires every native target and the tested bytes for this source and attempt', t => {
	const version = '0.1.6';
	const source = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), run: '1234', attempt: '1' };
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-candidate-evidence-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const targets = writeNativePackages(directory, version, source);
	assert.deepStrictEqual(verifyNativePackages(directory, version, source).map(record => record.target), targets);
	assert.throws(() => verifyNativePackages(directory, version, source, { requireSigning: true }), /missing trusted signing evidence/);
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
	writeArchive(directory, 'linux-x64', version, programsFor('linux-x64'), 'changed license');
	assert.throws(() => verifyNativePackages(directory, version, source), /package bytes differ from the tested files/);
	writeArchive(directory, 'linux-x64', version, programsFor('linux-arm64'));
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

function disposableRelease(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-release-rehearsal-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const gitDir = path.join(directory, 'git');
	const script = path.join(import.meta.dirname, 'release.mjs');
	const transport = path.join(import.meta.dirname, 'test-fixtures', 'release-transport.mjs');
	const git = (...args) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
	const source = { revision: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), run: '1234', attempt: '1' };
	const version = JSON.parse(git('show', 'HEAD:extension/package.json')).version;
	const tag = 'extension/' + version;
	const oldVersion = '0.0.1';
	const inputs = path.join(directory, 'inputs');
	const mirror = path.join(directory, 'mirror');
	const release = path.join(directory, 'release');
	const marker = path.join(mirror, 'facade-core-version.txt');
	const github = path.join(directory, 'github.json');
	const output = path.join(directory, 'output');
	const logFile = path.join(directory, 'transport.log');
	git('init', '--bare', '--quiet', gitDir);
	const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects');
	fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), objects + '\n');
	git('--git-dir', gitDir, 'update-ref', 'refs/tags/' + tag, source.revision);
	fs.writeFileSync(github, JSON.stringify({ created: false, latest: 'extension/' + oldVersion }));
	fs.mkdirSync(mirror);
	fs.writeFileSync(marker, oldVersion + '\n');
	fs.writeFileSync(logFile, '');
	writeNativePackages(inputs, version, source, { mockSigning: true });
	const command = (mode, args = [], { fault = '', attempt = source.attempt } = {}) => {
		const result = spawnSync(process.execPath, ['--import', transport, script, mode, '--tag', tag, ...args], {
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_DIR: gitDir,
				GITHUB_RUN_ID: source.run,
				GITHUB_RUN_ATTEMPT: attempt,
				GITHUB_OUTPUT: output,
				VSCE_PAT: 'disposable-token',
				OVSX_PAT: 'disposable-token',
				CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
				CLOUDFLARE_API_TOKEN: 'disposable-token',
				FACADE_RELEASE_TEST_ROOT: directory,
				FACADE_RELEASE_TEST_TAG: tag,
				FACADE_RELEASE_TEST_FAULT: fault,
			},
		});
		assert.ifError(result.error);
		return result;
	};
	const prepare = () => command('github', ['--input-dir', inputs]);
	const latest = () => JSON.parse(fs.readFileSync(github, 'utf8')).latest;
	const log = () => fs.readFileSync(logFile, 'utf8');
	return { source, version, tag, oldVersion, inputs, mirror, release, marker, output, command, prepare, latest, log };
}

function checkExit(result, status, message) {
	assert.equal(result.status, status, result.stdout + result.stderr);
	if (message) assert.match(result.stderr, message);
}

function withArtifactChange(file, bytes, action) {
	const original = fs.readFileSync(file);
	try {
		if (bytes === undefined) fs.unlinkSync(file);
		else fs.writeFileSync(file, bytes);
		action();
	} finally {
		fs.writeFileSync(file, original);
	}
}

test('release preparation refuses invalid native inputs before writing the GitHub draft', t => {
	const fixture = disposableRelease(t);
	const win = path.join(fixture.inputs, 'extension-win32-x64', evidenceFile);
	const linux = path.join(fixture.inputs, 'extension-linux-x64');
	const linuxArchive = path.join(linux, 'core', coreArchive('linux-x64'));
	const linuxVsix = path.join(linux, 'vsix', fileFor(fixture.version, 'linux-x64'));
	const inspectWin = action => {
		const record = JSON.parse(fs.readFileSync(win, 'utf8'));
		action(record);
		return JSON.stringify(record);
	};
	withArtifactChange(win, inspectWin(record => { delete record.signing; }), () => {
		checkExit(fixture.prepare(), 1, /win32-x64 is missing trusted signing evidence/);
	});
	withArtifactChange(win, inspectWin(record => { record.signing.programs['facade.exe'] = '0'.repeat(64); }), () => {
		checkExit(fixture.prepare(), 1, /signing evidence differs from the packaged programs/);
	});
	withArtifactChange(win, inspectWin(record => { record.source.attempt = '2'; }), () => {
		checkExit(fixture.prepare(), 1, /stale candidate source or run attempt/);
	});
	withArtifactChange(linuxArchive, 'corrupt archive', () => {
		checkExit(fixture.prepare(), 1, /differs from its candidate SHA256SUMS/);
	});
	withArtifactChange(linuxArchive, undefined, () => {
		checkExit(fixture.prepare(), 1, /Missing or unexpected files in core/);
	});
	withArtifactChange(linuxVsix, fs.readFileSync(linuxVsix), () => {
		vsix(linuxVsix, { target: 'linux-x64', name: 'facadecode', version: fixture.oldVersion });
		checkExit(fixture.prepare(), 1, /wrong version/);
		vsix(linuxVsix, { target: 'linux-arm64', name: 'facadecode', version: fixture.version });
		checkExit(fixture.prepare(), 1, /wrong target/);
	});
	assert.equal(fixture.log(), '');
	assert.equal(fs.existsSync(fixture.release), false);
});

test('retrying the Pre-release job keeps the original package attempt and bytes', t => {
	const fixture = disposableRelease(t);
	const input = ['--input-dir', fixture.inputs];
	checkExit(fixture.command('github', input, { fault: 'draft-download-fails' }), 1, /disposable draft download failed/);
	const draftSums = fs.readFileSync(path.join(fixture.release, 'SHA256SUMS'));
	checkExit(fixture.command('github', input, { attempt: '2' }), 1, /stale candidate source or run attempt/);
	checkExit(fixture.command('github', [...input, '--package-attempt', ''], { attempt: '2' }), 1, /Invalid GitHub attempt/);
	checkExit(fixture.command('github', [...input, '--package-attempt', fixture.source.attempt], { attempt: '2' }), 0);
	assert.deepStrictEqual(fs.readFileSync(path.join(fixture.release, 'SHA256SUMS')), draftSums);
	assert.match(fixture.log(), /github release create\ngithub release download\ngithub release view\ngithub release download\ngithub release download\ngithub release view\ngithub release edit/);
});

test('release preparation leaves a draft closed if GitHub lists an extra attachment', t => {
	const fixture = disposableRelease(t);
	checkExit(fixture.command('github', ['--input-dir', fixture.inputs], { fault: 'extra-draft-asset' }), 1,
		/missing, unexpected or duplicate attached files/);
	checkExit(fixture.command('verify'), 1, /is still a draft/);
	assert.doesNotMatch(fixture.log(), /github release edit/);
});

test('release promotion checks the accepted source and bytes before switching stable', t => {
	const fixture = disposableRelease(t);
	checkExit(fixture.prepare(), 0);
	const sourceRecord = path.join(fixture.release, 'release-candidate.json');
	const candidate = JSON.parse(fs.readFileSync(sourceRecord, 'utf8'));
	assert.deepStrictEqual(candidate.source, fixture.source);
	assert.deepStrictEqual(Object.keys(candidate.windowsSignatures).sort(), ['win32-arm64', 'win32-x64']);
	for (const [target, signing] of Object.entries(candidate.windowsSignatures)) {
		const packageFile = fileFor(fixture.version, target);
		assert.deepStrictEqual(candidate.assets.find(asset => asset.target === target), {
			target, file: packageFile, sha256: sha256(fs.readFileSync(path.join(fixture.release, packageFile))),
		});
		assert.deepStrictEqual(Object.keys(signing.programs).sort(), corePrograms(target).sort());
	}
	const window = fileFor(fixture.version, 'universal');
	const linuxWindow = path.join(fixture.inputs, 'extension-linux-x64', 'vsix', window);
	assert.deepStrictEqual(fs.readFileSync(path.join(fixture.release, window)), fs.readFileSync(linuxWindow));

	checkExit(fixture.command('mirror'), 0);
	const sumFile = path.join(fixture.release, 'SHA256SUMS');
	const digest = sha256(fs.readFileSync(sumFile));
	assert.equal(fs.readFileSync(fixture.output, 'utf8'), 'manifest=' + digest + '\n');
	const promote = fault => fixture.command('promote', ['--manifest-digest', digest], { fault });
	const releaseArchive = path.join(fixture.release, coreArchive('linux-x64'));
	const staged = path.join(fixture.mirror, 'releases', fixture.version);
	const mirroredArchive = path.join(staged, coreArchive('linux-x64'));
	const rewriteSums = (changedFile, action) => {
		const sums = parseChecksums(fs.readFileSync(sumFile, 'utf8'));
		sums.set(path.basename(changedFile), sha256(fs.readFileSync(changedFile)));
		withArtifactChange(sumFile, checksumsText([...sums].map(([file, sha256]) => ({ file, sha256 }))), action);
	};
	withArtifactChange(releaseArchive, 'corrupt', () => {
		checkExit(promote(), 1, /differs from SHA256SUMS/);
		rewriteSums(releaseArchive, () => checkExit(promote(), 1, /files differ from the accepted candidate record/));
	});
	withArtifactChange(releaseArchive, undefined, () => checkExit(promote(), 1, /missing, unexpected or duplicate attached files/));
	withArtifactChange(sourceRecord, undefined, () => checkExit(promote(), 1, /missing its accepted candidate record/));
	const unexpected = path.join(fixture.release, 'unexpected.txt');
	fs.writeFileSync(unexpected, 'unapproved attachment');
	checkExit(promote(), 1, /missing, unexpected or duplicate attached files/);
	fs.unlinkSync(unexpected);
	withArtifactChange(sourceRecord, JSON.stringify({ ...candidate, source: { ...candidate.source, tree: 'f'.repeat(40) } }), () => {
		rewriteSums(sourceRecord, () => checkExit(promote(), 1, /stale candidate source/));
	});
	withArtifactChange(path.join(fixture.release, window), fs.readFileSync(linuxWindow), () => {
		const releaseWindow = path.join(fixture.release, window);
		vsix(releaseWindow, { name: 'facadecode-window', version: fixture.oldVersion });
		rewriteSums(releaseWindow, () => checkExit(promote(), 1, /wrong version/));
	});
	withArtifactChange(mirroredArchive, undefined, () => checkExit(promote(), 1, /missing from the staged mirror/));
	withArtifactChange(mirroredArchive, 'changed at the website', () => checkExit(promote(), 1, /differs from the GitHub Release/));
	checkExit(fixture.command('promote', ['--manifest-digest', '0'.repeat(64)]), 1, /SHA256SUMS changed after mirroring/);
	assert.equal(fs.readFileSync(fixture.marker, 'utf8'), fixture.oldVersion + '\n');
	assert.doesNotMatch(fixture.log(), /r2 put facade-core-version\.txt|github release edit --latest/);
	assert.equal(fixture.latest(), 'extension/' + fixture.oldVersion);

	for (const [fault, mismatch] of [
		['stable-marker-changed', /facade-core-version\.txt differs from the GitHub Release/],
		['stable-alias-changed', /install\.ps1 differs from the GitHub Release/],
	]) {
		withArtifactChange(fixture.marker, fixture.oldVersion + '\n', () => checkExit(promote(fault), 1, mismatch));
		assert.doesNotMatch(fixture.log(), /github release edit --latest/);
		assert.equal(fixture.latest(), 'extension/' + fixture.oldVersion);
	}
	checkExit(promote(), 0);
	assert.equal(fixture.latest(), fixture.tag);
	assert.equal(fs.readFileSync(fixture.marker, 'utf8'), fixture.version + '\n');
	for (const file of fs.readdirSync(fixture.release)) {
		assert.deepStrictEqual(fs.readFileSync(path.join(staged, file)), fs.readFileSync(path.join(fixture.release, file)));
	}
	const actions = fixture.log().split('\n');
	assert.deepStrictEqual(actions.slice(actions.lastIndexOf('r2 put facade-core-version.txt'), -1), [
		'r2 put facade-core-version.txt',
		'website get /facade-core-version.txt',
		'website get /install.sh',
		'website get /install.ps1',
		'website get /facade-core-version.txt',
		'github release edit --latest',
		'github api repos/y5ez3g/facadecode/releases/latest',
		'github release list',
	]);
});

test('partial promotion resumes the same pin and refuses a competing marker', t => {
	const fixture = disposableRelease(t);
	checkExit(fixture.prepare(), 0);
	checkExit(fixture.command('mirror'), 0);
	const digest = sha256(fs.readFileSync(path.join(fixture.release, 'SHA256SUMS')));
	const pin = ['--manifest-digest', digest];
	const marker = fixture.version + '\n';
	const oldLatest = 'extension/' + fixture.oldVersion;
	const markerWrites = () => fixture.log().match(/^r2 put facade-core-version\.txt$/gm)?.length ?? 0;

	checkExit(fixture.command('promote', pin, { fault: 'stable-alias-changed' }), 1,
		/The website accepted the stable marker write.*Stable read-back failed.*install\.ps1 differs/);
	assert.equal(fs.readFileSync(fixture.marker, 'utf8'), marker);
	assert.equal(fixture.latest(), oldLatest);
	assert.equal(markerWrites(), 1);

	checkExit(fixture.command('promote', ['--resume', '--manifest-digest', '0'.repeat(64)]), 1,
		/SHA256SUMS changed after mirroring/);
	withArtifactChange(fixture.marker, '0.0.2\n', () => {
		checkExit(fixture.command('promote', [...pin, '--resume']), 1, /facade-core-version\.txt differs/);
		assert.equal(fs.readFileSync(fixture.marker, 'utf8'), '0.0.2\n');
		assert.equal(fixture.latest(), oldLatest);
	});

	withArtifactChange(fixture.marker, marker, () => {
		checkExit(fixture.command('promote', [...pin, '--resume'], { fault: 'competing-stable-marker' }), 1,
			/facade-core-version\.txt differs/);
		assert.equal(fs.readFileSync(fixture.marker, 'utf8'), '0.0.2\n');
		assert.equal(fixture.latest(), oldLatest);
	});

	checkExit(fixture.command('promote', [...pin, '--resume']), 0);
	checkExit(fixture.command('promote', pin), 0);
	assert.equal(fixture.latest(), fixture.tag);
	assert.equal(fs.readFileSync(fixture.marker, 'utf8'), marker);
	assert.equal(markerWrites(), 1);
});

test('stores refuse wrong existing bytes before uploading any missing package', t => {
	const fixture = disposableRelease(t);
	checkExit(fixture.prepare(), 0);
	checkExit(fixture.command('mirror'), 0);
	const digest = sha256(fs.readFileSync(path.join(fixture.release, 'SHA256SUMS')));
	const pin = ['--manifest-digest', digest];
	checkExit(fixture.command('stores', pin, { fault: 'marketplace-wrong-bytes' }), 1, /Marketplace serves another facadecode-linux-x64/);
	checkExit(fixture.command('stores', pin, { fault: 'open-vsx-wrong-bytes' }), 1, /Open VSX serves another facadecode-linux-x64/);
	assert.equal(fixture.log().match(/store read store-fixture\.invalid\/changed\.vsix/g)?.length, 2);
	assert.doesNotMatch(fixture.log(), /unexpected subprocess|r2 put facade-core-version\.txt|github release edit --latest/);
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
