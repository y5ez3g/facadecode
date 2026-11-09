// Releases tested VSIX files (ARCHITECTURE-4.3): first all of them to the GitHub Release of their `extension/<version>` tag,
// then the very files on that Release to VS Code Marketplace and Open VSX. Nothing is rebuilt or repacked on the way.
//
//   node scripts/release.mjs github --tag extension/<v> --input-dir <dir>   files of this run's native CI jobs
//   node scripts/release.mjs github --backfill                              every version in archive/catalog.json
//   node scripts/release.mjs stores --tag extension/<v>                     from the Release to both stores
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { filesOfZip } from './native.mjs';

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
	return new Map(text.trim().split('\n').map(line => {
		const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
		assert.ok(match, `Malformed ${SUMS} line: ${line}`);
		return [match[2], match[1]];
	}));
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
	const result = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName,assets']);
	if (result.status !== 0) {
		assert.match(result.stderr, /release not found/i, result.stderr || 'Cannot read the release');
		return undefined;
	}
	return JSON.parse(result.stdout);
}

function extensionReleaseVersions() {
	return JSON.parse(gh(['release', 'list', '--repo', repository, '--limit', '200', '--json', 'tagName']))
		.map(r => /^extension\/(\d+\.\d+\.\d+)$/.exec(r.tagName)?.[1]).filter(Boolean);
}

/** Downloads every asset of the Release and checks each against SHA256SUMS and its own manifests. */
function downloadRelease(tag, version, dir) {
	fs.mkdirSync(dir, { recursive: true });
	gh(['release', 'download', tag, '--repo', repository, '--dir', dir, '--clobber']);
	const sums = parseChecksums(fs.readFileSync(path.join(dir, SUMS), 'utf8'));
	return targetsFor(version).map(target => {
		const file = fileFor(version, target);
		assert.ok(sums.has(file), `${SUMS} on ${tag} does not list ${file}`);
		const local = path.join(dir, file);
		assert.ok(fs.existsSync(local), `${tag} has no ${file}`);
		assert.equal(sha256(fs.readFileSync(local)), sums.get(file), `${file} on ${tag} differs from ${SUMS}`);
		verifyVsix(version, target, local);
		return { target, file, path: local, sha256: sums.get(file) };
	});
}

/**
 * Puts the files on the Release of `tag`, creating it at `commit` when it is new. An existing Release keeps every file it
 * has: a file of the same name with other bytes stops the release, and only missing files are added. The Release is then
 * downloaded again and checked file by file.
 */
export function publishGithubRelease({ tag, version, commit, artifacts, notes, latest, work }) {
	const stage = fs.mkdtempSync(path.join(work, `${version}-`));
	fs.writeFileSync(path.join(stage, SUMS), checksumsText(artifacts));
	const files = [...artifacts.map(a => a.path), path.join(stage, SUMS)];
	let release = existingRelease(tag);
	if (!release) {
		const notesFile = path.join(stage, 'notes.md');
		fs.writeFileSync(notesFile, notes);
		gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', `Facade Code Extension ${version}`,
			'--notes-file', notesFile, `--latest=${latest}`, ...files]);
		console.log(`${tag}: Release created with ${artifacts.length} VSIX files and ${SUMS}.`);
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
	const checked = downloadRelease(tag, version, fs.mkdtempSync(path.join(work, `${version}-check-`)));
	assert.deepEqual(checked.map(a => [a.file, a.sha256]), artifacts.map(a => [a.file, a.sha256]), `${tag} differs from the released files`);
	console.log(`${tag}: downloaded again; all ${artifacts.length} VSIX files match.`);
	return checked;
}

function resolveCommit(ref) {
	return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
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
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	assert.equal(manifest.version, version, `${tag} is not the checked-out extension version ${manifest.version}`);
	const commit = resolveCommit(tag);
	const artifacts = collectFromRun(version, inputDir);
	const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'a local build';
	const notes = `${releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)}\n\n---\n\n` +
		`Built and tested on native runners for every platform by ${runUrl}, from ${commit}. ` +
		`These files are the ones published to VS Code Marketplace and Open VSX; their SHA-256 values are in ${SUMS}.\n`;
	const newest = [version, ...extensionReleaseVersions()].sort(compareVersions).at(-1);
	publishGithubRelease({ tag, version, commit, artifacts, notes, latest: version === newest, work });
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

async function stores(tag, work) {
	const version = versionOfTag(tag);
	const artifacts = storeOrder(downloadRelease(tag, version, fs.mkdtempSync(path.join(work, `${version}-stores-`))));
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

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-release-'));
	try {
		if (command === 'github' && args.includes('--backfill')) await backfill(work);
		else if (command === 'github') await releaseRun(option('--tag'), path.resolve(option('--input-dir') ?? 'missing --input-dir'), work);
		else if (command === 'stores') await stores(option('--tag'), work);
		else throw new Error('Usage: release.mjs github --tag extension/<v> --input-dir <dir> | github --backfill | stores --tag extension/<v>');
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
