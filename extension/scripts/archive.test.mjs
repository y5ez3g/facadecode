import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateCatalog, verifyArtifact } from './archive.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../archive/catalog.json'), 'utf8'));

test('the backfill catalog records exactly one original VSIX per platform and window component', () => {
	validateCatalog(catalog);
	for (const version of ['0.0.1', '0.0.2', '0.0.3', '0.0.4', '0.0.5']) assert.ok(catalog.releases.some(r => r.version === version));
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
