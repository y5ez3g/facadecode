// Discovers missing published snapshots and verifies their original CI bytes (ARCHITECTURE-4.3).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareVersions, validateCatalog, verifyVsix } from './archive.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repository = 'y5ez3g/facadecode';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function publishedReleases(execution, window) {
	const groups = new Map();
	for (const version of execution.versions) {
		if (!/^\d+\.\d+\.\d+$/.test(version.version)) continue;
		if (!groups.has(version.version)) groups.set(version.version, []);
		groups.get(version.version).push(version);
	}
	return [...groups].sort(([a], [b]) => compareVersions(a, b)).map(([version, versions]) => {
		const companion = window.versions.find(v => v.version === version && (!v.targetPlatform || v.targetPlatform === 'universal'));
		assert.ok(companion, `${version}: the published Window Component is missing`);
		return {
			version,
			artifacts: [...versions, companion].map(v => {
				const target = v.targetPlatform || 'universal';
				const sourceUrl = v.files?.find(f => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source;
				assert.ok(sourceUrl, `${version} ${target}: no published VSIX URL`);
				return { target, file: target === 'universal' ? `facadecode-window-${version}.vsix` : `facadecode-${target}-${version}.vsix`,
					sourceUrl, marketplaceLastUpdatedAt: v.lastUpdated };
			})
		};
	});
}

export async function mergePublishedReleases(catalog, published, verify) {
	const result = structuredClone(validateCatalog(catalog));
	const known = new Set(result.releases.map(r => r.version));
	for (const release of published) {
		if (known.has(release.version)) continue;
		const verified = await verify(release);
		assert.equal(verified.version, release.version);
		result.releases.push(verified);
		validateCatalog(result);
		known.add(verified.version);
	}
	result.releases.sort((a, b) => compareVersions(a.version, b.version));
	return result;
}

export async function matchingRun(release, runs, sourceVersion, artifacts) {
	for (const run of runs) {
		if (await sourceVersion(run) !== release.version) continue;
		const files = await artifacts(run);
		if (release.artifacts.every(a => files.some(f => f.file === a.file && f.sha256 === a.sha256))) return run;
	}
	throw new Error(`${release.version}: no retained successful CI run matches every published VSIX; the catalog was not changed`);
}

function gh(args) {
	return execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

async function json(url, options) {
	const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
	assert.ok(response.ok, `${url}: HTTP ${response.status}`);
	return response.json();
}

async function bytes(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
	assert.ok(response.ok, `${url}: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

async function discover() {
	const data = await json(`https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?nonce=${Date.now()}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1', 'Cache-Control': 'no-cache' },
		body: JSON.stringify({ filters: [{ criteria: [
			{ filterType: 7, value: 'facade.facadecode' }, { filterType: 7, value: 'facade.facadecode-window' }
		] }], flags: 1 | 2 | 16 | 128 })
	});
	const extensions = data.results.flatMap(r => r.extensions);
	const execution = extensions.find(e => e.extensionName === 'facadecode');
	const window = extensions.find(e => e.extensionName === 'facadecode-window');
	assert.ok(execution && window, 'Both published extension components must be discoverable');
	return publishedReleases(execution, window);
}

export async function synchronizeCatalog(catalog) {
	const published = await discover();
	const missing = published.filter(r => !catalog.releases.some(existing => existing.version === r.version));
	if (!missing.length) {
		console.log('Archive catalog already covers every discovered published version.');
		return validateCatalog(catalog);
	}
	console.log(`Missing published snapshots: ${missing.map(r => r.version).join(', ')}`);
	const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/workflows/extension-check.yml/runs?status=success&per_page=100`]));
	const runs = pages.flatMap(page => page.workflow_runs);
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-archive-sync-'));
	const versions = new Map(), downloads = new Map();
	const sourceVersion = async run => {
		if (!versions.has(run.id)) {
			const source = JSON.parse(gh(['api', `repos/${repository}/contents/extension/package.json?ref=${run.head_sha}`]));
			versions.set(run.id, JSON.parse(Buffer.from(source.content, 'base64').toString()).version);
		}
		return versions.get(run.id);
	};
	const artifacts = async run => {
		if (!downloads.has(run.id)) {
			const directory = path.join(temporary, String(run.id));
			const available = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts;
			if (!available.some(a => a.name.startsWith('extension-') && !a.expired)) return [];
			console.log(`Checking original CI artifacts from ${run.html_url}`);
			gh(['run', 'download', String(run.id), '--repo', repository, '--pattern', 'extension-*', '--dir', directory]);
			const files = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
				.filter(entry => entry.isFile() && entry.name.endsWith('.vsix'))
				.map(entry => ({ file: entry.name, sha256: hash(fs.readFileSync(path.join(entry.parentPath, entry.name))) }));
			downloads.set(run.id, files);
		}
		return downloads.get(run.id);
	};
	try {
		return await mergePublishedReleases(catalog, missing, async release => {
			const verified = structuredClone(release);
			for (const artifact of verified.artifacts) {
				const original = await bytes(artifact.sourceUrl);
				artifact.sha256 = hash(original);
				const file = path.join(temporary, artifact.file);
				fs.writeFileSync(file, original);
				verifyVsix(verified, artifact, file);
				const component = artifact.target === 'universal' ? 'facadecode-window' : `facadecode/${artifact.target}`;
				const open = await json(`https://open-vsx.org/api/facade/${component}/${release.version}?nonce=${Date.now()}`);
				assert.equal(hash(await bytes(open.files.download)), artifact.sha256, `${artifact.file}: Open VSX differs from Marketplace`);
			}
			const run = await matchingRun(verified, runs, sourceVersion, artifacts);
			verified.sourceRevision = run.head_sha;
			verified.evidence = {
				verification: 'Every Marketplace and Open VSX download matches an original VSIX from the recorded successful CI run byte for byte.',
				ciRun: run.html_url, ciConclusion: run.conclusion, ciHeadRevision: run.head_sha, ciEvent: run.event,
				sourceManifestVersion: release.version,
				packaging: 'Original native CI packages; the published universal component is matched against the retained runner artifacts. No rebuilding or repacking.',
				publishedDownloadChecks: { visualStudioMarketplace: verified.artifacts.length, openVSX: verified.artifacts.length, allMatchCI: true },
				sourceMetadata: 'The recorded source is the workflow head revision. Pull-request jobs may check out a merge ref; the CI run and original artifact hashes retain that provenance.',
				realModelAndRemoteChecks: 'not rerun when synchronizing archive metadata'
			};
			console.log(`${release.version}: both registries and CI run ${run.id} match; adding verified archive metadata.`);
			return verified;
		});
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}
