// Prepares the tested VSIX and core files on the GitHub Pre-release of their extension/<version> tag.
// The owner-approved publish workflow promotes those bytes to the mirror and the stores.
//
//   node scripts/release.mjs github --tag extension/<v> --input-dir <dir>   files of this run's native CI jobs
//   node scripts/release.mjs github --backfill                              every version in archive/catalog.json
//   node scripts/release.mjs build-needed --tag extension/<v>               whether the complete candidate is already uploaded
//   node scripts/release.mjs verify --tag extension/<v>                     verify an existing GitHub candidate
//   node scripts/release.mjs mirror --tag extension/<v>                     copy the exact candidate to the versioned mirror
//   node scripts/release.mjs stores --tag extension/<v> --manifest-digest <sha256>  publish the verified mirror bytes
//   node scripts/release.mjs promote --tag extension/<v> --manifest-digest <sha256> switch the two stable origins
//   node scripts/release.mjs version <v>                                    the extension's, the window component's and core's version
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { coreArchive, coreInstallers, coreVersionFile } from '../../core/scripts/package-core.mjs';
import { CORE, withWorkspaceVersion } from './core.mjs';
import { filesOfZip } from './native.mjs';
import { publishMirror, pruneMirror } from './release-mirror.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repository = 'y5ez3g/facadecode';
const vsce = '@vscode/vsce@4.1.0';
const ovsx = 'ovsx@1.3.0';
const historicalTargets = ['darwin-arm64', 'linux-x64', 'win32-x64', 'universal'];
const nativeTargets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
export const SUMS = 'SHA256SUMS';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const compareVersions = (a, b) => {
	const left = a.split('.').map(Number), right = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] - right[i]; }
	return 0;
};
export const targetsFor = version => compareVersions(version, '0.1.1') < 0 ? historicalTargets : [...nativeTargets, 'universal'];
export const fileFor = (version, target) => target === 'universal' ? `facadecode-window-${version}.vsix` : `facadecode-${target}-${version}.vsix`;
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

/** A VSIX is the component, version and target its name says, read from its own manifests. */
export function verifyVsix(version, target, file) {
	const files = filesOfZip(file);
	const manifest = JSON.parse(files.find(f => f.name === 'extension/package.json')?.bytes.toString() ?? 'null');
	const window = target === 'universal';
	assert.equal(manifest?.publisher, 'facade', `${path.basename(file)}: wrong publisher`);
	assert.equal(manifest.name, window ? 'facadecode-window' : 'facadecode', `${path.basename(file)}: wrong component`);
	assert.equal(manifest.version, version, `${path.basename(file)}: wrong version`);
	const identity = files.find(f => f.name === 'extension.vsixmanifest')?.bytes.toString() ?? '';
	assert.equal(identity.match(/\bTargetPlatform="([^"]+)"/)?.[1], window ? undefined : target, `${path.basename(file)}: wrong target`);
	assert.equal(identity.match(/<Identity\b[^>]*\bVersion="([^"]+)"/)?.[1], version, `${path.basename(file)}: wrong identity version`);
}

export const checksumsText = artifacts => artifacts.map(a => `${a.sha256}  ${a.file}\n`).join('');
export function parseChecksums(text) {
	const sums = new Map();
	for (const line of text.replace(/\r?\n$/, '').split(/\r?\n/)) {
		const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
		assert.ok(match, `Malformed ${SUMS} line: ${line}`);
		assert.ok(!sums.has(match[2]), `Duplicate ${SUMS} entry: ${match[2]}`);
		sums.set(match[2], match[1]);
	}
	return sums;
}

/** The changelog's section for this version, without its heading. */
export function releaseNotes(changelog, version) {
	const lines = changelog.split('\n');
	const start = lines.findIndex(line => line.trim() === `## ${version}`);
	assert.ok(start >= 0, `CHANGELOG.md has no section for ${version}`);
	const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
	return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/**
 * This run's tested files for a version. Every native job uploads the same universal Window Component; linux-x64's copy is
 * the one released, and a run without a file for every target releases nothing.
 */
export function collectFromRun(version, dir) {
	const found = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.vsix'))
		.map(e => path.join(e.parentPath, e.name));
	const unexpected = found.filter(f => !targetsFor(version).some(t => fileFor(version, t) === path.basename(f)));
	assert.deepEqual(unexpected.map(f => path.basename(f)), [], `Files of another version or target in ${dir}`);
	return targetsFor(version).map(target => {
		const file = fileFor(version, target);
		const copies = found.filter(f => path.basename(f) === file).sort();
		assert.ok(copies.length, `${file} is missing from this run's packages`);
		const chosen = target === 'universal' ? copies.find(f => f.includes('linux-x64')) ?? copies[0] : copies[0];
		assert.ok(target === 'universal' || copies.length === 1, `${file} was packaged more than once`);
		verifyVsix(version, target, chosen);
		return { target, file, path: chosen, sha256: sha256(fs.readFileSync(chosen)) };
	});
}

/** The standalone archives tested by the same native jobs as the VSIX files, and the installers from this tag. */
function collectCoreFromRun(version, dir, work, commit) {
	const archives = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.startsWith('facade-core-'));
	const paths = nativeTargets.map(target => {
		const file = coreArchive(target);
		const matches = archives.filter(entry => entry.name === file);
		assert.equal(matches.length, 1, `Expected one tested ${file}, found ${matches.length}`);
		return path.join(matches[0].parentPath, file);
	});
	assert.equal(archives.length, paths.length, 'Unexpected standalone core archive in the run');
	const releaseVersion = path.join(work, coreVersionFile);
	fs.writeFileSync(releaseVersion, version + '\n');
	for (const file of coreInstallers) {
		const installer = path.join(work, file);
		fs.writeFileSync(installer, releaseSource(commit, `core/${file}`));
		paths.push(installer);
	}
	paths.push(releaseVersion);
	return paths.map(file => ({ file: path.basename(file), path: file, sha256: sha256(fs.readFileSync(file)) }));
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

function coreFilesFor(version) {
	return compareVersions(version, '0.1.6') < 0 ? [] : [...nativeTargets.map(coreArchive), ...coreInstallers, coreVersionFile];
}

export function requiredReleaseFiles(version) {
	return [...targetsFor(version).map(target => fileFor(version, target)), ...coreFilesFor(version), SUMS];
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
function downloadRelease(tag, version, dir, coreFiles = []) {
	fs.mkdirSync(dir, { recursive: true });
	const files = targetsFor(version).map(target => ({ target, file: fileFor(version, target) }));
	files.push(...coreFiles.map(file => ({ file })));
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
export function publishGithubRelease({ tag, version, commit, artifacts, core = [], notes, latest, prerelease = false, work }) {
	const assets = [...artifacts, ...core];
	const stage = fs.mkdtempSync(path.join(work, `${version}-`));
	fs.writeFileSync(path.join(stage, SUMS), checksumsText(assets));
	const files = [...assets.map(a => a.path), path.join(stage, SUMS)];
	const release = existingRelease(tag);
	if (!release) {
		const notesFile = path.join(stage, 'notes.md');
		fs.writeFileSync(notesFile, notes);
		const flags = prerelease ? ['--draft', '--prerelease', '--latest=false'] : [`--latest=${latest}`];
		gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', `Facade Code Extension ${version}`,
			'--notes-file', notesFile, ...flags, ...files]);
		console.log(`${tag}: Release created with ${assets.length} files and ${SUMS}.`);
	} else {
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
	const checked = downloadRelease(tag, version, verify, core.map(asset => asset.file));
	assert.deepEqual(checked.map(a => [a.file, a.sha256]), assets.map(a => [a.file, a.sha256]), `${tag} differs from the released files`);
	assert.equal(sha256(fs.readFileSync(path.join(verify, SUMS))), sha256(fs.readFileSync(path.join(stage, SUMS))),
		`${tag} serves a different ${SUMS}`);
	if (prerelease && (!release || release.isDraft)) publishCandidateDraft(tag);
	console.log(`${tag}: downloaded again; all ${assets.length} files match.`);
	return checked;
}

function publishCandidateDraft(tag) {
	gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false']);
}

function resolveCommit(ref) {
	return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
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

async function releaseRun(tag, inputDir, work) {
	const version = versionOfTag(tag);
	const commit = resolveCommit(tag);
	const manifest = JSON.parse(releaseSource(commit, 'extension/package.json'));
	assert.equal(manifest.version, version, `${tag} is not the checked-out extension version ${manifest.version}`);
	const artifacts = collectFromRun(version, inputDir);
	const core = collectCoreFromRun(version, inputDir, work, commit);
	const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'a local build';
	const downloads = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
	const install = [
		'### Install the Shell by version',
		'',
		'macOS, Linux and WSL',
		'',
		'```sh',
		`sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" -- --version "$2"' facade-install ${downloads}/install.sh ${version}`,
		'```',
		'',
		'Windows PowerShell',
		'',
		'```powershell',
		`$response = Invoke-WebRequest -UseBasicParsing '${downloads}/install.ps1'`,
		`& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()))) -Version ${version}`,
		'```',
		'',
	].join('\n');
	const notes = `${releaseNotes(releaseSource(commit, 'extension/CHANGELOG.md').toString(), version)}\n\n---\n\n` +
		`Built and tested on native runners for every platform by ${runUrl}, from ${commit}. ` +
		`SHA-256 values for all assets are in ${SUMS}.\n\n${install}`;
	publishGithubRelease({ tag, version, commit, artifacts, core, notes, latest: false, prerelease: true, work });
}

function verifyRelease(tag, work, prepare = false) {
	const version = versionOfTag(tag);
	const release = existingRelease(tag);
	assert.ok(release, `${tag} has no GitHub Release. Prepare a candidate first.`);
	assert.ok(prepare || !release.isDraft, `${tag} is still a draft. Prepare a Pre-release first.`);
	const coreFiles = coreFilesFor(version);
	const assets = downloadRelease(tag, version, work, coreFiles);
	if (coreFiles.length) {
		assert.equal(fs.readFileSync(path.join(work, coreVersionFile), 'utf8'), version + '\n',
			`${tag} has a version marker for another release`);
	}
	const sums = path.join(work, SUMS);
	assets.push({ file: SUMS, path: sums, sha256: sha256(fs.readFileSync(sums)) });
	if (prepare && release.isDraft) publishCandidateDraft(tag);
	console.log(`${tag}: verified ${assets.length} Release files.`);
	return { version, assets, standalone: coreFiles.length !== 0 };
}

async function checkPromotion(version) {
	const newest = extensionReleaseVersions({ stable: true }).sort(compareVersions).at(-1);
	assert.ok(!newest || compareVersions(version, newest) >= 0, `Stable Facade is already at ${newest}`);
	const response = await fetch(`https://facadecode.com/${coreVersionFile}`, {
		redirect: 'error', signal: AbortSignal.timeout(60_000),
	});
	if (response.status === 404) return;
	assert.ok(response.ok, `The website's stable marker returned HTTP ${response.status}`);
	const mirrored = (await response.text()).trim();
	assert.match(mirrored, /^[0-9]+\.[0-9]+\.[0-9]+$/, 'The website has an invalid stable version');
	assert.ok(compareVersions(version, mirrored) >= 0, `The website is already at Facade ${mirrored}`);
}

async function mirrorRun(tag, work) {
	const { version, assets, standalone } = verifyRelease(tag, work);
	if (standalone) {
		await checkPromotion(version);
		await publishMirror(version, assets, false);
	}
	const digest = assets.find(asset => asset.file === SUMS).sha256;
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${digest}\n`);
}

function requireMirroredManifest(actual, expected) {
	assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Supply the verified mirror manifest digest');
	assert.equal(actual, expected, `The GitHub ${SUMS} changed after mirroring`);
}

async function promoteRun(tag, work, manifest) {
	const { version, assets, standalone } = verifyRelease(tag, work);
	requireMirroredManifest(assets.find(asset => asset.file === SUMS).sha256, manifest);
	if (!standalone) return;
	await checkPromotion(version);
	await publishMirror(version, assets, true);
	gh(['release', 'edit', tag, '--repo', repository, '--prerelease=false', '--latest']);
	assert.equal(JSON.parse(gh(['api', `repos/${repository}/releases/latest`])).tag_name, tag,
		`GitHub Latest did not switch to ${tag}`);
	const versions = extensionReleaseVersions({ stable: true })
		.filter(candidate => coreFilesFor(candidate).length).sort((left, right) => compareVersions(right, left));
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
	const version = versionOfTag(tag);
	const dir = fs.mkdtempSync(path.join(work, `${version}-stores-`));
	const artifacts = storeOrder(downloadRelease(tag, version, dir));
	requireMirroredManifest(sha256(fs.readFileSync(path.join(dir, SUMS))), manifest);
	console.log(`${tag}: ${artifacts.length} VSIX files downloaded from the Release and checked against ${SUMS}.`);
	const listed = await marketplaceVersions();
	for (const artifact of artifacts) {
		if (marketplaceFile(listed, version, artifact)) { console.log(`Marketplace already has ${artifact.file}.`); continue; }
		assert.ok(process.env.VSCE_PAT, 'VSCE_PAT is required to publish to VS Code Marketplace');
		const result = run('npx', ['--yes', vsce, 'publish', '--packagePath', artifact.path], { stdio: 'inherit', env: { ...process.env } });
		assert.equal(result.status, 0, `Marketplace refused ${artifact.file}`);
	}
	for (const artifact of artifacts) {
		if (await openVsxFile(version, artifact)) { console.log(`Open VSX already has ${artifact.file}.`); continue; }
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

/** One version for the extension, its window component and core's workspace: the manifests, the lock file of each. */
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
	rewrite(path.join(CORE, 'Cargo.toml'), text => withWorkspaceVersion(text, version));
	// Cargo.lock names each of core's crates by it; no registry is asked
	const result = run('cargo', ['update', '--workspace', '--offline'], { cwd: CORE, stdio: 'inherit' });
	assert.equal(result.status, 0, 'cargo could not update core\'s Cargo.lock');
	console.log(`Version ${version}: extension, window component, core. CHANGELOG.md needs its ## ${version} section.`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-release-'));
	try {
		if (command === 'github' && args.includes('--backfill')) await backfill(work);
		else if (command === 'github') await releaseRun(option('--tag'), path.resolve(option('--input-dir') ?? 'missing --input-dir'), work);
		else if (command === 'build-needed') {
			const tag = option('--tag');
			console.log(candidateNeedsBuild(versionOfTag(tag), existingRelease(tag)));
		}
		else if (command === 'verify') verifyRelease(option('--tag'), work, args.includes('--prepare'));
		else if (command === 'mirror') await mirrorRun(option('--tag'), work);
		else if (command === 'promote') await promoteRun(option('--tag'), work, option('--manifest-digest'));
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
