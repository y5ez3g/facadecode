import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateCatalog, verifyArtifact } from './archive.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../archive/catalog.json'), 'utf8'));

test('the backfill catalog records exactly one original VSIX per platform and window component', () => {
	validateCatalog(catalog);
	for (const version of ['0.0.1', '0.0.2', '0.0.3', '0.0.4', '0.0.5', '0.0.6', '0.0.7']) assert.ok(catalog.releases.some(r => r.version === version));
});

function sixPlatformRelease() {
	const version = '0.1.1';
	return {
		version, tag: `extension/${version}`, sourceRevision: '1'.repeat(40),
		evidence: { verification: 'Synthetic catalog fixture; no product verification claim' },
		artifacts: ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'universal'].map(target => ({
			target, file: target === 'universal' ? `facadecode-window-${version}.vsix` : `facadecode-${target}-${version}.vsix`,
			sha256: '0'.repeat(64)
		}))
	};
}

test('a six-platform release coexists with unchanged historical snapshots (ARCHITECTURE-4.3)', () => {
	const expanded = structuredClone(catalog);
	expanded.releases.push(sixPlatformRelease());
	assert.equal(validateCatalog(expanded), expanded);
	assert.deepEqual(expanded.releases.slice(0, -1), catalog.releases);
});

test('six-platform snapshots refuse missing, duplicate or unknown targets before publication (ARCHITECTURE-4.3)', () => {
	for (const mutate of [
		r => { r.artifacts = r.artifacts.filter(a => a.target !== 'darwin-x64'); },
		r => { r.artifacts = r.artifacts.filter(a => a.target !== 'universal'); },
		r => { r.artifacts = r.artifacts.filter(a => !['darwin-x64', 'linux-arm64', 'win32-arm64'].includes(a.target)); },
		r => { r.artifacts[0] = structuredClone(r.artifacts[1]); },
		r => { r.artifacts[0].target = 'linux-riscv64'; },
		r => { r.artifacts.push(structuredClone(r.artifacts.at(-1))); }
	]) {
		const changed = structuredClone(catalog);
		const release = sixPlatformRelease();
		mutate(release);
		changed.releases.push(release);
		assert.throws(() => validateCatalog(changed));
	}
});

test('a missing platform, repeated version, cross-version URL or unsafe file name fails before downloads/publication', () => {
	for (const mutate of [
		c => c.releases[0].artifacts.pop(),
		c => c.releases.push(structuredClone(c.releases[0])),
		c => { c.releases[0].artifacts[0].sourceUrl = c.releases[1].artifacts[0].sourceUrl; },
		c => { c.releases[0].artifacts[0].file = '../another.vsix'; },
		c => { c.releases[0].sourceRevision = 'main'; }
	]) {
		const changed = structuredClone(catalog);
		mutate(changed);
		assert.throws(() => validateCatalog(changed));
	}
});

test('a changed download is refused before its bytes can enter an archive', () => {
	const bytes = Buffer.from('original archived file');
	const artifact = { file: 'fixture.vsix', sha256: createHash('sha256').update(bytes).digest('hex') };
	assert.equal(verifyArtifact({}, artifact, bytes), bytes);
	assert.throws(() => verifyArtifact({}, artifact, Buffer.from('different file')), /SHA-256 mismatch/);
});
