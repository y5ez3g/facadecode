// Archives tested VSIX bytes without building a product (ARCHITECTURE-4.3).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { filesOfZip } from './native.mjs';

const root = path.resolve(import.meta.dirname, '..');
const registry = 'https://npm.pkg.github.com';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^\d+\.\d+\.\d+$/;
const targets = ['darwin-arm64', 'linux-x64', 'win32-x64', 'universal'];
const compareVersions = (a, b) => {
	const left = a.split('.').map(Number), right = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] - right[i]; }
	return 0;
};

export function validateCatalog(catalog) {
	assert.equal(catalog.schemaVersion, 1, 'Unsupported archive catalog');
	assert.equal(catalog.name, '@y5ez3g/extension', 'Unexpected snapshot package');
	assert.equal(catalog.repository, 'https://github.com/y5ez3g/facadecode.git');
	assert.ok(Array.isArray(catalog.releases) && catalog.releases.length, 'No releases');
	const versions = new Set();
	for (const release of catalog.releases) {
		assert.match(release.version, versionPattern, 'Expected a release version');
		assert.ok(!versions.has(release.version), 'Duplicate release');
		versions.add(release.version);
		assert.equal(release.tag, `extension/${release.version}`, 'Wrong source tag');
		assert.ok(/^[a-f0-9]{40}$/.test(release.sourceRevision) || release.sourceRevision === release.tag, 'Invalid source revision');
		assert.ok(release.evidence && typeof release.evidence === 'object', 'Missing source evidence');
		assert.equal(release.artifacts.length, 4, 'A snapshot needs three execution VSIXs and one window component');
		assert.deepEqual(release.artifacts.map(a => a.target).sort(), [...targets].sort(), 'Wrong or duplicate platforms');
		for (const artifact of release.artifacts) {
			const window = artifact.target === 'universal';
			const expected = window ? `facadecode-window-${release.version}.vsix` : `facadecode-${artifact.target}-${release.version}.vsix`;
			assert.equal(artifact.file, expected, 'Unexpected artifact name');
			assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Invalid SHA-256');
			if (artifact.sourceUrl) {
				const url = new URL(artifact.sourceUrl);
				assert.equal(url.protocol, 'https:');
				assert.equal(url.hostname, 'facade.gallerycdn.vsassets.io');
				const component = window ? 'facadecode-window' : 'facadecode';
				assert.ok(url.pathname.startsWith(`/extensions/facade/${component}/${release.version}/`), 'Artifact URL names another release');
			}
		}
	}
	return catalog;
}

export function verifyArtifact(release, artifact, bytes) {
	assert.equal(sha256(bytes), artifact.sha256, `${artifact.file}: SHA-256 mismatch`);
	// filesOfZip reads a file, so the caller uses this after saving only hash-checked bytes.
	return bytes;
}

export function verifyVsix(release, artifact, file) {
	const bytes = fs.readFileSync(file);
	verifyArtifact(release, artifact, bytes);
	const files = filesOfZip(file);
	const manifest = JSON.parse(files.find(f => f.name === 'extension/package.json')?.bytes.toString() ?? 'null');
	assert.equal(manifest?.publisher, 'facade', 'Wrong VSIX publisher');
	assert.equal(manifest.version, release.version, 'Wrong VSIX version');
	const window = artifact.target === 'universal';
	assert.equal(manifest.name, window ? 'facadecode-window' : 'facadecode', 'Wrong VSIX component');
	const identity = files.find(f => f.name === 'extension.vsixmanifest')?.bytes.toString() ?? '';
	assert.equal(identity.match(/\bTargetPlatform="([^"]+)"/)?.[1], window ? undefined : artifact.target, 'Wrong VSIX target');
	assert.equal(identity.match(/<Identity\b[^>]*\bVersion="([^"]+)"/)?.[1], release.version, 'Wrong VSIX identity version');
}

function npm(args, cwd) {
	const result = spawnSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw result.error;
	return result;
}

function checkedNpm(args, cwd) {
	const result = npm(args, cwd);
	assert.equal(result.status, 0, result.stderr || result.stdout || `npm ${args[0]} failed`);
	return JSON.parse(result.stdout);
}

function resolveRevision(ref) {
	return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
}

export async function prepareRelease(catalog, release, { out, inputDir, resolveSource = resolveRevision } = {}) {
	const sourceCommit = resolveSource(release.sourceRevision);
	assert.match(sourceCommit, /^[a-f0-9]{40}$/);
	assert.equal(resolveSource(release.tag), sourceCommit, `${release.tag} does not point to the recorded source`);
	const stage = fs.mkdtempSync(path.join(out, `${release.version}-`));
	fs.mkdirSync(path.join(stage, 'vsix'));
	for (const artifact of release.artifacts) {
		let bytes;
		if (inputDir) {
			const nested = path.join(inputDir, release.version, artifact.file);
			bytes = fs.readFileSync(fs.existsSync(nested) ? nested : path.join(inputDir, artifact.file));
		} else {
			assert.ok(artifact.sourceUrl, `No source URL for ${artifact.file}; supply --input-dir`);
			const response = await fetch(artifact.sourceUrl, { signal: AbortSignal.timeout(60000) });
			assert.ok(response.ok, `${artifact.file}: download returned ${response.status}`);
			bytes = Buffer.from(await response.arrayBuffer());
		}
		verifyArtifact(release, artifact, bytes);
		const file = path.join(stage, 'vsix', artifact.file);
		fs.writeFileSync(file, bytes);
		verifyVsix(release, artifact, file);
	}
	const checksums = Object.fromEntries(release.artifacts.map(a => [a.file, a.sha256]));
	const snapshot = { schemaVersion: 1, version: release.version, tag: release.tag, sourceCommit,
		repository: catalog.repository, evidence: release.evidence, artifacts: release.artifacts };
	const manifest = { name: catalog.name, version: release.version,
		description: 'Facade Code extension snapshots: original VSIX installers, source records and checksums.',
		license: 'MIT', repository: { type: 'git', url: catalog.repository },
		files: ['snapshot.json', 'checksums.json', ...release.artifacts.map(a => `vsix/${a.file}`)],
		publishConfig: { registry } };
	fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
	fs.writeFileSync(path.join(stage, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
	fs.writeFileSync(path.join(stage, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n');
	fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(stage, 'LICENSE.txt'));
	fs.writeFileSync(path.join(stage, 'README.md'), `# Facade Code Extension ${release.version}\n\n` +
		`This package archives the original VSIX files. Install them through VS Code or publish the same files to VS Code Marketplace and Open VSX.\n\n` +
		`Source tag: ${release.tag}\n\nSource commit: ${sourceCommit}\n\n` +
		`See snapshot.json for provenance and checksums.json for each original VSIX SHA-256. ` +
		`Historical evidence remains historical; archiving runs no product build or native CLI probe.\n\n` +
		`This archive has no npm install hook or executable entry point.\n`);
	const [packed] = checkedNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], stage);
	const tarball = path.join(out, packed.filename);
	const prepared = { version: release.version, tag: release.tag, sourceCommit, stage, tarball, snapshot, checksums,
		files: packed.files.map(f => `package/${f.path}`).sort() };
	verifyTarball(prepared, tarball);
	return prepared;
}

export function verifyTarball(prepared, tarball) {
	const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').filter(e => !e.endsWith('/')).sort();
	assert.deepEqual(entries, prepared.files, 'Unexpected archive package contents');
	const read = name => execFileSync('tar', ['-xOf', tarball, `package/${name}`], { maxBuffer: 16 * 1024 * 1024 });
	const manifest = JSON.parse(read('package.json'));
	assert.equal(manifest.name, '@y5ez3g/extension');
	assert.equal(manifest.version, prepared.version);
	assert.ok(!manifest.scripts && !manifest.bin && !manifest.dependencies, 'A snapshot must not install or run code');
	assert.deepEqual(JSON.parse(read('snapshot.json')), prepared.snapshot, 'Source/evidence metadata changed');
	assert.deepEqual(JSON.parse(read('checksums.json')), prepared.checksums, 'Checksum metadata changed');
	for (const [file, hash] of Object.entries(prepared.checksums)) assert.equal(sha256(read(`vsix/${file}`)), hash, `Archived VSIX changed: ${file}`);
}

async function publishRelease(catalog, prepared, out) {
	const name = `${catalog.name}@${prepared.version}`;
	const existing = npm(['view', name, 'version', '--json', '--registry', registry], root);
	let published = false;
	if (existing.status !== 0) {
		let error;
		try { error = JSON.parse(existing.stdout).error; } catch { /* Report npm's ordinary failure below. */ }
		assert.ok(error?.code === 'E404', existing.stderr || existing.stdout || 'Cannot check registry version');
		const result = npm(['publish', prepared.tarball, '--ignore-scripts', '--registry', registry], root);
		assert.equal(result.status, 0, result.stderr || result.stdout || 'Package publication failed');
		published = true;
	}
	const downloaded = fs.mkdtempSync(path.join(out, `${prepared.version}-registry-`));
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const [packed] = checkedNpm(['pack', name, '--ignore-scripts', '--json', '--registry', registry, '--pack-destination', downloaded], root);
			verifyTarball(prepared, path.join(downloaded, packed.filename));
			return published ? 'published_and_download_verified' : 'existing_package_download_verified';
		} catch (error) {
			lastError = error;
			if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 5000));
		}
	}
	throw lastError;
}

async function main() {
	const args = process.argv.slice(2);
	const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
	const allowed = new Set(['--catalog', '--out', '--input-dir', '--through', '--publish']);
	for (let i = 0; i < args.length; i++) {
		assert.ok(allowed.has(args[i]), `Unknown archive argument: ${args[i]}`);
		if (args[i] !== '--publish') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value: ${args[i]}`); i++; }
	}
	const catalog = validateCatalog(JSON.parse(fs.readFileSync(option('--catalog', path.join(root, 'archive/catalog.json')), 'utf8')));
	const through = option('--through', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
	assert.ok(catalog.releases.some(r => r.version === through), 'The requested release is not in the catalog');
	const out = path.resolve(option('--out', path.join(root, 'build/archive')));
	const inputDir = option('--input-dir');
	const publish = args.includes('--publish');
	if (publish) assert.ok(process.env.NODE_AUTH_TOKEN, 'NODE_AUTH_TOKEN is required for package publication');
	fs.mkdirSync(out, { recursive: true });
	const summary = [];
	for (const release of [...catalog.releases].sort((a, b) => compareVersions(a.version, b.version)).filter(r => compareVersions(r.version, through) <= 0)) {
		const prepared = await prepareRelease(catalog, release, { out, inputDir });
		const status = publish ? await publishRelease(catalog, prepared, out) : 'local_package_verified';
		const result = { package: catalog.name, version: prepared.version, tag: prepared.tag, sourceCommit: prepared.sourceCommit,
			vsixCount: release.artifacts.length, status, tarballSha256: sha256(fs.readFileSync(prepared.tarball)), checksums: prepared.checksums };
		summary.push(result);
		fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
		console.log(`${catalog.name}@${prepared.version}: ${status}, ${release.artifacts.length} original VSIX files`);
		if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${catalog.name}@${prepared.version}: ${status}; source ${prepared.sourceCommit}; ${release.artifacts.length} VSIX hashes verified.\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
