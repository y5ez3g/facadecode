// Prepares the tested VSIX and framework files on the GitHub Pre-release of their extension/<version> tag.
// The owner-approved publish workflow promotes those bytes to the mirror and the stores.
//
//   node scripts/release.mjs github --tag extension/<v> --input-dir <dir>   tested files of this workflow attempt
//   node scripts/release.mjs github --backfill                              every version in archive/catalog.json
//   node scripts/release.mjs build-needed --tag extension/<v>               whether the complete candidate is already uploaded
//   node scripts/release.mjs verify --tag extension/<v>                     verify an existing GitHub candidate
//   node scripts/release.mjs mirror --tag extension/<v>                     copy the exact candidate to the versioned mirror
//   node scripts/release.mjs stores --tag extension/<v> --manifest-digest <sha256>  publish the verified mirror bytes
//   node scripts/release.mjs promote --tag extension/<v> --manifest-digest <sha256> [--resume] switch the stable origins
//   node scripts/release.mjs version <v>                                    the extension's, the window component's and framework's version
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { frameworkArchive, frameworkInstallers, frameworkVersionFile } from '../../framework/scripts/package-framework.mjs';
import { FRAMEWORK, parseFrameworkBuild, sourceBuild, withWorkspaceVersion } from './framework.mjs';
import { signingRecord, validateSource, verifyArchivePrograms, verifyNativePackages } from './native-package-evidence.mjs';
import {
	SUMS, checksumsText, compareVersions, fileFor, nativeTargets, parseChecksums, sha256, targetsFor, verifyVsix,
} from './release-assets.mjs';
import { publishMirror, pruneMirror } from './release-mirror.mjs';

export { SUMS, checksumsText, compareVersions, fileFor, parseChecksums, sha256, targetsFor, verifyVsix } from './release-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repository = 'y5ez3g/facadecode';
const vsce = '@vscode/vsce@4.1.0';
const ovsx = 'ovsx@1.3.0';
const candidateFile = 'release-candidate.json';
export function versionOfTag(tag) {
	const version = /^extension\/(\d+\.\d+\.\d+)$/.exec(tag ?? '')?.[1];
	assert.ok(version, `Expected a tag extension/<major.minor.patch>, not ${tag}`);
	return version;
}

/** The versions published to the stores before releases went to GitHub first; their original files and hashes. */
export function validateCatalog(catalog) {
	assert.equal(catalog.schemaVersion, 1, 'Unsupported archive catalog');
	assert.equal(catalog.repository, `https://github.com/${repository}.git`);
	assert.ok(Array.isArray(catalog.releases) && catalog.releases.length, 'No releases');
	const versions = new Set();
	for (const release of catalog.releases) {
		assert.match(release.version, /^\d+\.\d+\.\d+$/, 'Expected a release version');
		assert.ok(!versions.has(release.version), 'Duplicate release');
		versions.add(release.version);
		if (release.tag !== undefined) assert.equal(release.tag, `extension/${release.version}`, 'Wrong source tag');
		assert.ok(/^[a-f0-9]{40}$/.test(release.sourceRevision) || (release.tag && release.sourceRevision === release.tag), 'Invalid source revision');
		assert.ok(release.evidence && typeof release.evidence === 'object', 'Missing source evidence');
		assert.deepEqual(release.artifacts.map(a => a.target).sort(), [...targetsFor(release.version)].sort(),
			`Wrong, missing or duplicate platforms for ${release.version}`);
		for (const artifact of release.artifacts) {
			assert.equal(artifact.file, fileFor(release.version, artifact.target), 'Unexpected artifact name');
			assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Invalid SHA-256');
			const url = new URL(artifact.sourceUrl);
			assert.equal(url.protocol, 'https:');
			assert.equal(url.hostname, 'facade.gallerycdn.vsassets.io');
			const component = artifact.target === 'universal' ? 'facadecode-window' : 'facadecode';
			assert.ok(url.pathname.startsWith(`/extensions/facade/${component}/${release.version}/`), 'Artifact URL names another release');
		}
	}
	return catalog;
}

/** The changelog's section for this version, without its heading. */
export function releaseNotes(changelog, version) {
	const lines = changelog.split('\n');
	const start = lines.findIndex(line => line.trim() === `## ${version}`);
	assert.ok(start >= 0, `CHANGELOG.md has no section for ${version}`);
	const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
	return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** The standalone version marker and installers from the candidate's tag. */
function taggedInstallers(build, work, commit) {
	const releaseVersion = path.join(work, frameworkVersionFile);
	fs.writeFileSync(releaseVersion, build + '\n');
	const paths = [];
	for (const file of frameworkInstallers) {
		const installer = path.join(work, file);
		fs.writeFileSync(installer, releaseSource(commit, `framework/${file}`));
		paths.push(installer);
	}
	paths.push(releaseVersion);
	return paths.map(file => ({ file: path.basename(file), path: file, sha256: sha256(fs.readFileSync(file)) }));
}

function candidateAssets(assets) {
	return assets.map(({ target, file, sha256: digest }) => ({ ...(target ? { target } : {}), file, sha256: digest }));
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	return result;
}
function gh(args, options) {
	const result = run('gh', args, options);
	assert.equal(result.status, 0, result.stderr || result.stdout || `gh ${args[0]} failed`);
	return result.stdout;
}
async function download(url) {
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
			assert.ok(response.ok, `${url}: HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			if (attempt >= 2) throw error;
			await new Promise(resolve => setTimeout(resolve, 5000));
		}
	}
}

function existingRelease(tag) {
	const result = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName,assets,isDraft,isPrerelease']);
	if (result.status !== 0) {
		assert.match(result.stderr, /release not found/i, result.stderr || 'Cannot read the release');
		return undefined;
	}
	return JSON.parse(result.stdout);
}

function extensionReleaseVersions({ stable = false } = {}) {
	const flags = stable ? ['--exclude-drafts', '--exclude-pre-releases'] : [];
	return JSON.parse(gh(['release', 'list', '--repo', repository, '--limit', '200', '--json', 'tagName', ...flags]))
		.map(r => /^extension\/(\d+\.\d+\.\d+)$/.exec(r.tagName)?.[1]).filter(Boolean);
}

function frameworkFilesFor(version) {
	return compareVersions(version, '0.1.6') < 0 ? [] : [...nativeTargets.map(frameworkArchive), ...frameworkInstallers, frameworkVersionFile];
}

export function requiredReleaseFiles(version) {
	return [...targetsFor(version).map(target => fileFor(version, target)), ...frameworkFilesFor(version), SUMS];
}

function requireReleaseAssets(release, expected, { allowMissing = false } = {}) {
	const present = release.assets.map(asset => asset.name).sort();
	const expectedNow = allowMissing ? expected.filter(file => present.includes(file)) : [...expected];
	assert.deepStrictEqual(present, expectedNow.sort(), `${release.tagName} has missing, unexpected or duplicate attached files`);
}

export function candidateNeedsBuild(version, release) {
	const present = new Set(release?.assets.map(asset => asset.name));
	if (!present.size) {
		assert.ok(!release || release.isDraft || release.isPrerelease, `extension/${version} is already a stable Release`);
		return true;
	}
	assert.ok(requiredReleaseFiles(version).every(file => present.has(file)),
		`extension/${version} has an incomplete asset upload. Re-run the original failed GitHub Pre-release job to reuse its signed artifacts.`);
	return false;
}

/** Downloads the requested Release assets and checks each against SHA256SUMS and any VSIX manifests. */
function downloadRelease(tag, version, dir, frameworkFiles = []) {
	fs.mkdirSync(dir, { recursive: true });
	const files = targetsFor(version).map(target => ({ target, file: fileFor(version, target) }));
	files.push(...frameworkFiles.map(file => ({ file })));
	const patterns = [SUMS, ...files.map(asset => asset.file)].flatMap(file => ['--pattern', file]);
	gh(['release', 'download', tag, '--repo', repository, '--dir', dir, '--clobber', ...patterns]);
	const sums = parseChecksums(fs.readFileSync(path.join(dir, SUMS), 'utf8'));
	return files.map(({ target, file }) => {
		assert.ok(sums.has(file), `${SUMS} on ${tag} does not list ${file}`);
		const local = path.join(dir, file);
		assert.ok(fs.existsSync(local), `${tag} has no ${file}`);
		assert.equal(sha256(fs.readFileSync(local)), sums.get(file), `${file} on ${tag} differs from ${SUMS}`);
		if (target) verifyVsix(version, target, local);
		return { target, file, path: local, sha256: sums.get(file) };
	});
}

/**
 * Puts the files on the Release of `tag`, creating it at `commit` when it is new. An existing Release keeps every file it
 * has: a file of the same name with other bytes stops the release, and only missing files are added. The Release is then
 * downloaded again and checked file by file.
 */
export function publishGithubRelease({ tag, version, commit, artifacts, framework = [], notes, latest, prerelease = false, work }) {
	const assets = [...artifacts, ...framework];
	const stage = fs.mkdtempSync(path.join(work, `${version}-`));
	fs.writeFileSync(path.join(stage, SUMS), checksumsText(assets));
	const files = [...assets.map(a => a.path), path.join(stage, SUMS)];
	const names = files.map(file => path.basename(file));
	const release = existingRelease(tag);
	if (!release) {
		const notesFile = path.join(stage, 'notes.md');
		fs.writeFileSync(notesFile, notes);
		const flags = prerelease ? ['--draft', '--prerelease', '--latest=false'] : [`--latest=${latest}`];
		gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', `Facade Code Extension ${version}`,
			'--notes-file', notesFile, ...flags, ...files]);
		console.log(`${tag}: Release created with ${assets.length} files and ${SUMS}.`);
	} else {
		if (prerelease) requireReleaseAssets(release, names, { allowMissing: true });
		const existing = fs.mkdtempSync(path.join(work, `${version}-existing-`));
		const present = new Set(release.assets.map(a => a.name));
		if (present.size) gh(['release', 'download', tag, '--repo', repository, '--dir', existing]);
		const missing = files.filter(file => {
			const name = path.basename(file);
			if (!present.has(name)) return true;
			assert.equal(sha256(fs.readFileSync(path.join(existing, name))), sha256(fs.readFileSync(file)),
				`${name} is already on ${tag} with other bytes; the Release is left as it is`);
			return false;
		});
		if (missing.length) gh(['release', 'upload', tag, '--repo', repository, ...missing]);
		if (latest && JSON.parse(gh(['api', `repos/${repository}/releases/latest`])).tag_name !== tag) gh(['release', 'edit', tag, '--repo', repository, '--latest']);
		console.log(`${tag}: Release already there; ${missing.length} missing file(s) added, the rest match byte for byte.`);
	}
	const verify = fs.mkdtempSync(path.join(work, `${version}-check-`));
	const checked = downloadRelease(tag, version, verify, framework.map(asset => asset.file));
	assert.deepEqual(checked.map(a => [a.file, a.sha256]), assets.map(a => [a.file, a.sha256]), `${tag} differs from the released files`);
	assert.equal(sha256(fs.readFileSync(path.join(verify, SUMS))), sha256(fs.readFileSync(path.join(stage, SUMS))),
		`${tag} serves a different ${SUMS}`);
	if (prerelease) {
		const uploaded = existingRelease(tag);
		assert.ok(uploaded, `${tag} disappeared during draft verification`);
		requireReleaseAssets(uploaded, names);
		if (!release || release.isDraft) publishCandidateDraft(tag);
	}
	console.log(`${tag}: downloaded again; all ${assets.length} files match.`);
	return checked;
}

function publishCandidateDraft(tag) {
	gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false']);
}

function resolveCommit(ref) {
	return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
}

function taggedSource(tag, version) {
	const revision = resolveCommit('refs/tags/' + tag);
	const tree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], { cwd: root, encoding: 'utf8' }).trim();
	const manifest = JSON.parse(releaseSource(revision, 'extension/package.json'));
	assert.equal(manifest.version, version, `${tag} is not the tagged extension version ${manifest.version}`);
	return { revision, tree };
}

function releaseSource(commit, file) {
	return execFileSync('git', ['show', `${commit}:${file}`], { cwd: root });
}

function ensureTag(tag, commit) {
	const remote = gh(['api', `repos/${repository}/git/matching-refs/tags/${tag}`]);
	if (JSON.parse(remote).some(ref => ref.ref === `refs/tags/${tag}`)) return;
	gh(['api', '-X', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`]);
	console.log(`${tag}: tag created at the recorded source ${commit}.`);
}

async function backfill(work) {
	const catalog = validateCatalog(JSON.parse(fs.readFileSync(path.join(root, 'archive/catalog.json'), 'utf8')));
	const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
	const releases = [...catalog.releases].sort((a, b) => compareVersions(a.version, b.version));
	const newest = [...releases.map(r => r.version), ...extensionReleaseVersions()].sort(compareVersions).at(-1);
	for (const release of releases) {
		const tag = `extension/${release.version}`;
		const commit = resolveCommit(release.sourceRevision);
		if (release.tag) assert.equal(resolveCommit(release.tag), commit, `${release.tag} does not point to the recorded source`);
		ensureTag(tag, commit);
		const dir = fs.mkdtempSync(path.join(work, `${release.version}-catalog-`));
		const artifacts = [];
		for (const target of targetsFor(release.version)) {
			const recorded = release.artifacts.find(a => a.target === target);
			const bytes = await download(recorded.sourceUrl);
			assert.equal(sha256(bytes), recorded.sha256, `${recorded.file}: SHA-256 mismatch with the catalog`);
			const file = path.join(dir, recorded.file);
			fs.writeFileSync(file, bytes);
			verifyVsix(release.version, target, file);
			artifacts.push({ target, file: recorded.file, path: file, sha256: recorded.sha256 });
		}
		const notes = `${releaseNotes(changelog, release.version)}\n\n---\n\nThe original VSIX files as first published to VS Code ` +
			`Marketplace and Open VSX, byte for byte. Source: ${commit}. Their SHA-256 values are in ${SUMS} and ` +
			`[extension/archive/catalog.json](https://github.com/${repository}/blob/main/extension/archive/catalog.json).\n`;
		publishGithubRelease({ tag, version: release.version, commit, artifacts, notes, latest: release.version === newest, work });
	}
}

async function releaseRun(tag, inputDir, work, packageAttempt = process.env.GITHUB_RUN_ATTEMPT) {
	const version = versionOfTag(tag);
	assert.ok(frameworkFilesFor(version).length, `${tag} uses the historical archive catalog`);
	const source = { ...taggedSource(tag, version), run: process.env.GITHUB_RUN_ID, attempt: packageAttempt };
	const build = sourceBuild(version, source.revision);
	const packages = verifyNativePackages(inputDir, version, source, { requireSigning: true });
	for (const record of packages) {
		assert.equal(record.build, build, record.target + ' native package BUILD differs from the tagged source');
	}
	const packaged = (record, folder, file, target) => {
		const relative = folder + '/' + file;
		return { target, file, path: path.join(inputDir, 'extension-' + record.target, relative), sha256: record.files[relative].sha256 };
	};
	const artifacts = packages.map(record => packaged(record, 'vsix', fileFor(version, record.target), record.target));
	const linux = packages.find(record => record.target === 'linux-x64');
	artifacts.push(packaged(linux, 'vsix', fileFor(version, 'universal'), 'universal'));
	const framework = [
		...packages.map(record => packaged(record, 'framework', frameworkArchive(record.target))),
		...taggedInstallers(build, work, source.revision),
	];
	const candidate = {
		schemaVersion: 1,
		tag,
		source,
		assets: candidateAssets([...artifacts, ...framework]),
		windowsSignatures: Object.fromEntries(packages.filter(record => record.signing).map(record => [record.target, record.signing])),
	};
	const record = path.join(work, candidateFile);
	const recordBytes = JSON.stringify(candidate, null, 2) + '\n';
	fs.writeFileSync(record, recordBytes);
	framework.push({ file: candidateFile, path: record, sha256: sha256(recordBytes) });
	const commit = source.revision;
	const runUrl = `https://github.com/${repository}/actions/runs/${source.run}/attempts/${source.attempt}`;
	const downloads = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
	const install = [
		'### Install the Shell by version',
		'',
		'macOS, Linux and WSL',
		'',
		'```sh',
		`sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" -- --version "$2" --expected-build "$3"' facade-install ${downloads}/install.sh ${version} ${build}`,
		'```',
		'',
		'Windows PowerShell',
		'',
		'```powershell',
		`$response = Invoke-WebRequest -UseBasicParsing '${downloads}/install.ps1'`,
		`& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()))) -Version ${version} -ExpectedBuild ${build}`,
		'```',
		'',
	].join('\n');
	const notes = `${releaseNotes(releaseSource(commit, 'extension/CHANGELOG.md').toString(), version)}\n\n---\n\n` +
		`Built and tested on native runners for every platform by ${runUrl}, from ${commit}. ` +
		`Source, targets and Windows signing evidence are in ${candidateFile}. SHA-256 values for all assets are in ${SUMS}.\n\n${install}`;
	publishGithubRelease({ tag, version, commit, artifacts, framework, notes, latest: false, prerelease: true, work });
}

function verifyCandidate(tag, version, build, assets, candidate) {
	assert.equal(candidate?.schemaVersion, 1, 'Unsupported release candidate record');
	assert.equal(candidate.tag, tag, 'Release candidate record names another version');
	validateSource(candidate.source ?? {});
	const { revision, tree } = taggedSource(tag, version);
	assert.ok(candidate.source.revision === revision && candidate.source.tree === tree, `${tag} has a stale candidate source`);
	const recorded = assets.filter(asset => asset.file !== candidateFile);
	assert.deepStrictEqual(candidate.assets, candidateAssets(recorded), `${tag} files differ from the accepted candidate record`);
	const byName = new Map(recorded.map(asset => [asset.file, asset]));
	for (const file of frameworkInstallers) {
		assert.equal(byName.get(file).sha256, sha256(releaseSource(revision, 'framework/' + file)),
			`${file} differs from the tagged source`);
	}
	const windowsSignatures = {};
	for (const target of nativeTargets) {
		const archive = byName.get(frameworkArchive(target));
		const vsix = byName.get(fileFor(version, target));
		const { programs } = verifyArchivePrograms(archive.path, vsix.path, target, build);
		if (target.startsWith('win32-')) windowsSignatures[target] = signingRecord(programs);
	}
	assert.deepStrictEqual(candidate.windowsSignatures, windowsSignatures, `${tag} signing evidence differs from the packaged programs`);
}

export function verifyReleaseBuild(tag, marker) {
	const version = versionOfTag(tag);
	const build = marker.trimEnd();
	const parsed = parseFrameworkBuild(build);
	assert.ok(parsed?.version === version && marker === build + '\n', `${tag} has an invalid BUILD marker`);
	if (parsed.revision) {
		assert.equal(build, sourceBuild(version, resolveCommit('refs/tags/' + tag)), `${tag} BUILD marker differs from the tag commit`);
	}
	return build;
}

function verifyRelease(tag, work, { prepare = false, requireCandidate = false } = {}) {
	const version = versionOfTag(tag);
	const release = existingRelease(tag);
	assert.ok(release, `${tag} has no GitHub Release. Prepare a candidate first.`);
	assert.equal(release.tagName, tag, 'GitHub returned another Release');
	assert.ok(prepare || !release.isDraft, `${tag} is still a draft. Prepare a Pre-release first.`);
	const frameworkFiles = frameworkFilesFor(version);
	const standalone = frameworkFiles.length !== 0;
	const hasCandidate = release.assets.some(asset => asset.name === candidateFile);
	if (requireCandidate || (prepare && (release.isDraft || release.isPrerelease))) {
		assert.ok(hasCandidate, `${tag} is missing its accepted candidate record ${candidateFile}`);
	}
	if (hasCandidate) {
		assert.ok(standalone, `${tag} has an unexpected standalone candidate record`);
		frameworkFiles.push(candidateFile);
		requireReleaseAssets(release, [...requiredReleaseFiles(version), candidateFile]);
	}
	const assets = downloadRelease(tag, version, work, frameworkFiles);
	const build = standalone ? verifyReleaseBuild(tag, fs.readFileSync(path.join(work, frameworkVersionFile), 'utf8')) : undefined;
	const sums = path.join(work, SUMS);
	if (hasCandidate) {
		const digests = parseChecksums(fs.readFileSync(sums, 'utf8'));
		assert.deepStrictEqual([...digests.keys()].sort(), assets.map(asset => asset.file).sort(), `${tag} has an unexpected ${SUMS} file set`);
		verifyCandidate(tag, version, build, assets, JSON.parse(fs.readFileSync(path.join(work, candidateFile), 'utf8')));
	} else if (build && build !== version) {
		for (const target of nativeTargets) {
			const vsix = assets.find(asset => asset.target === target);
			const archive = assets.find(asset => asset.file === frameworkArchive(target));
			verifyArchivePrograms(archive.path, vsix.path, target, build);
		}
	}
	assets.push({ file: SUMS, path: sums, sha256: sha256(fs.readFileSync(sums)) });
	if (prepare && release.isDraft) publishCandidateDraft(tag);
	console.log(`${tag}: verified ${assets.length} Release files.`);
	return { version, build, assets };
}

async function checkPromotion(version, build) {
	const newest = extensionReleaseVersions({ stable: true }).sort(compareVersions).at(-1);
	assert.ok(!newest || compareVersions(version, newest) >= 0, `Stable Facade is already at ${newest}`);
	const response = await fetch(`https://facadecode.com/${frameworkVersionFile}`, {
		redirect: 'error', signal: AbortSignal.timeout(60_000),
	});
	if (response.status === 404) return;
	assert.ok(response.ok, `The website's stable marker returned HTTP ${response.status}`);
	const mirrored = (await response.text()).trim();
	const current = parseFrameworkBuild(mirrored);
	assert.ok(current, 'The website has an invalid stable BUILD');
	const versionOrder = compareVersions(version, current.version);
	const buildTime = BigInt(parseFrameworkBuild(build).time ?? -1);
	assert.ok(versionOrder > 0 || (versionOrder === 0 && buildTime >= BigInt(current.time ?? -1)),
		`The website is already at Facade ${mirrored}`);
	return mirrored;
}

async function mirrorRun(tag, work) {
	const { version, build, assets } = verifyRelease(tag, work, { requireCandidate: true });
	await checkPromotion(version, build);
	await publishMirror(version, assets, false);
	const digest = assets.find(asset => asset.file === SUMS).sha256;
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${digest}\n`);
}

function requireMirroredManifest(actual, expected) {
	assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Supply the verified mirror manifest digest');
	assert.equal(actual, expected, `The GitHub ${SUMS} changed after mirroring`);
}

async function promoteRun(tag, work, manifest, resume) {
	const { version, build, assets } = verifyRelease(tag, work, { requireCandidate: true });
	requireMirroredManifest(assets.find(asset => asset.file === SUMS).sha256, manifest);
	const stable = await checkPromotion(version, build);
	await publishMirror(version, assets, true, { resume: resume || stable === build });
	gh(['release', 'edit', tag, '--repo', repository, '--prerelease=false', '--latest']);
	assert.equal(JSON.parse(gh(['api', `repos/${repository}/releases/latest`])).tag_name, tag,
		`GitHub Latest did not switch to ${tag}`);
	const versions = extensionReleaseVersions({ stable: true })
		.filter(candidate => frameworkFilesFor(candidate).length).sort((left, right) => compareVersions(right, left));
	await pruneMirror(version, versions);
}

async function marketplaceVersions() {
	const response = await fetch(`https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?nonce=${Date.now()}`, {
		method: 'POST', signal: AbortSignal.timeout(60000),
		headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1', 'Cache-Control': 'no-cache' },
		body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: 'facade.facadecode' }, { filterType: 7, value: 'facade.facadecode-window' }] }], flags: 1 | 2 | 16 | 128 })
	});
	assert.ok(response.ok, `Marketplace query: HTTP ${response.status}`);
	const extensions = (await response.json()).results.flatMap(r => r.extensions);
	return extensions.flatMap(e => e.versions.map(v => ({
		component: e.extensionName, version: v.version, target: v.targetPlatform || 'universal',
		url: v.files?.find(f => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source
	})));
}

/** The Marketplace's download of this file, or undefined while it does not list it. */
export function marketplaceFile(listed, version, artifact) {
	const component = artifact.target === 'universal' ? 'facadecode-window' : 'facadecode';
	return listed.find(v => v.component === component && v.version === version && v.target === artifact.target)?.url;
}

async function openVsxFile(version, artifact) {
	const component = artifact.target === 'universal' ? 'facadecode-window' : `facadecode/${artifact.target}`;
	const response = await fetch(`https://open-vsx.org/api/facade/${component}/${version}?nonce=${Date.now()}`, { signal: AbortSignal.timeout(60000) });
	if (response.status === 404) return undefined;
	assert.ok(response.ok, `Open VSX ${component} ${version}: HTTP ${response.status}`);
	return (await response.json()).files?.download;
}

/** The Window Component first: the execution component's extension pack names it. */
export const storeOrder = artifacts => [...artifacts].sort((a, b) => (b.target === 'universal') - (a.target === 'universal'));

async function stores(tag, work, manifest) {
	const { version, assets } = verifyRelease(tag, work, { requireCandidate: true });
	const artifacts = storeOrder(assets.filter(asset => asset.target));
	requireMirroredManifest(assets.find(asset => asset.file === SUMS).sha256, manifest);
	console.log(`${tag}: ${artifacts.length} VSIX files downloaded from the Release and checked against ${SUMS}.`);
	const listed = await marketplaceVersions();
	const available = [];
	for (const artifact of artifacts) {
		const marketplace = marketplaceFile(listed, version, artifact);
		const open = await openVsxFile(version, artifact);
		if (marketplace) assert.equal(sha256(await download(marketplace)), artifact.sha256, `Marketplace serves another ${artifact.file}`);
		if (open) assert.equal(sha256(await download(open)), artifact.sha256, `Open VSX serves another ${artifact.file}`);
		available.push({ artifact, marketplace, open });
	}
	for (const { artifact, marketplace } of available) {
		if (marketplace) { console.log(`Marketplace already has ${artifact.file}.`); continue; }
		assert.ok(process.env.VSCE_PAT, 'VSCE_PAT is required to publish to VS Code Marketplace');
		const result = run('npx', ['--yes', vsce, 'publish', '--packagePath', artifact.path], { stdio: 'inherit', env: { ...process.env } });
		assert.equal(result.status, 0, `Marketplace refused ${artifact.file}`);
	}
	for (const { artifact, open } of available) {
		if (open) { console.log(`Open VSX already has ${artifact.file}.`); continue; }
		assert.ok(process.env.OVSX_PAT, 'OVSX_PAT is required to publish to Open VSX');
		const result = run('npx', ['--yes', ovsx, 'publish', artifact.path], { stdio: 'inherit', env: { ...process.env } });
		assert.equal(result.status, 0, `Open VSX refused ${artifact.file}`);
	}
	// Both stores serve exactly the Release's bytes; the Marketplace can take some minutes to list a new version.
	for (let attempt = 0, left = artifacts; left.length; attempt++) {
		const now = await marketplaceVersions();
		const pending = [];
		for (const artifact of left) {
			const marketplace = marketplaceFile(now, version, artifact), open = await openVsxFile(version, artifact);
			if (!marketplace || !open) { pending.push(artifact); continue; }
			assert.equal(sha256(await download(marketplace)), artifact.sha256, `Marketplace serves another ${artifact.file}`);
			assert.equal(sha256(await download(open)), artifact.sha256, `Open VSX serves another ${artifact.file}`);
		}
		left = pending;
		if (!left.length) break;
		assert.ok(attempt < 30, `Not yet listed after 15 minutes: ${left.map(a => a.file).join(', ')}`);
		await new Promise(resolve => setTimeout(resolve, 30000));
	}
	console.log(`${tag}: VS Code Marketplace and Open VSX both serve all ${artifacts.length} files byte for byte.`);
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${tag}: Marketplace and Open VSX serve the Release's ${artifacts.length} VSIX files byte for byte.\n`);
}

/** One version for the extension, its window component and framework's workspace: the manifests, the lock file of each. */
export function raiseVersion(version) {
	assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `Expected a version <major.minor.patch>, not ${version}`);
	const rewrite = (file, change) => fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
	const manifest = file => rewrite(file, text => text.replace(/^(\t"version": ")[^"]+/m, `$1${version}`));
	manifest(path.join(root, 'package.json'));
	manifest(path.join(root, 'window', 'package.json'));
	rewrite(path.join(root, 'package-lock.json'), text => {
		const lock = JSON.parse(text);
		lock.version = lock.packages[''].version = version;
		return `${JSON.stringify(lock, undefined, '\t')}\n`;
	});
	rewrite(path.join(FRAMEWORK, 'Cargo.toml'), text => withWorkspaceVersion(text, version));
	// Cargo.lock names each of framework's crates by it; no registry is asked
	const result = run('cargo', ['update', '--workspace', '--offline'], { cwd: FRAMEWORK, stdio: 'inherit' });
	assert.equal(result.status, 0, 'cargo could not update framework\'s Cargo.lock');
	console.log(`Version ${version}: extension, window component, framework. CHANGELOG.md needs its ## ${version} section.`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-release-'));
	try {
		if (command === 'github' && args.includes('--backfill')) await backfill(work);
		else if (command === 'github') {
			await releaseRun(option('--tag'), path.resolve(option('--input-dir') ?? 'missing --input-dir'), work, option('--package-attempt'));
		}
		else if (command === 'build-needed') {
			const tag = option('--tag');
			console.log(candidateNeedsBuild(versionOfTag(tag), existingRelease(tag)));
		}
		else if (command === 'verify') verifyRelease(option('--tag'), work, { prepare: args.includes('--prepare') });
		else if (command === 'mirror') await mirrorRun(option('--tag'), work);
		else if (command === 'promote') await promoteRun(option('--tag'), work, option('--manifest-digest'), args.includes('--resume'));
		else if (command === 'stores') await stores(option('--tag'), work, option('--manifest-digest'));
		else if (command === 'version') raiseVersion(args[0]);
		else throw new Error('Usage: release.mjs <github|build-needed|verify|mirror|stores|promote> --tag extension/<v> | github --backfill | version <v>');
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
