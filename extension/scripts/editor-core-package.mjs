import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { coreArchive } from '../../core/scripts/package-core.mjs';
import { programProblems, zipModes } from './core.mjs';
import { captureNativePackage, evidenceFile, validateSource, verifyArchivePrograms } from './native-package-evidence.mjs';
import { nativeProblems, packageTarget } from './native.mjs';
import { fileFor, sha256, SUMS } from './release-assets.mjs';

/** Read the verified Core programs for the integration fixture's checkout and host. */
export function readEditorCorePackage(root, directory, digest) {
	assert.ok(directory, 'Supply a native package artifact directory.');
	assert.match(digest, /^[0-9a-f]{64}$/u, 'Supply a lowercase SHA-256 for ' + evidenceFile);
	const evidence = fs.readFileSync(path.join(directory, evidenceFile));
	assert.equal(sha256(evidence), digest, 'Native package evidence differs from the supplied SHA-256.');
	const record = JSON.parse(evidence.toString('utf8'));
	validateSource(record.source);
	const git = { cwd: root, encoding: 'utf8' };
	const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], git).trim();
	assert.equal(record.source.tree, tree, 'Native package evidence names a different source tree.');
	assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], git), '',
		'Native package reuse requires the tracked checkout to match HEAD.');
	const target = packageTarget();
	assert.equal(record.target, target, 'Native package evidence names a different host target.');
	const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const vsix = path.join('vsix', fileFor(version, target));
	const archive = path.join('core', coreArchive(target));
	const files = [vsix, path.join('vsix', fileFor(version, 'universal')), archive, path.join('core', SUMS)];
	// Verify and extract from the same private copy even if the input directory is replaced during preparation.
	const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-editor-core-'));
	try {
		for (const file of files) {
			const input = path.join(directory, file);
			assert.ok(fs.lstatSync(input).isFile(), `${file} is not a regular artifact file.`);
			const output = path.join(snapshot, file);
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.copyFileSync(input, output);
		}
		const actual = captureNativePackage(snapshot, target, version, record.source, { signing: record.signing });
		assert.deepEqual(actual, record, 'Native package files differ from the pinned evidence.');
		const workspace = path.join(snapshot, vsix);
		const programs = verifyArchivePrograms(path.join(snapshot, archive), workspace, target, version);
		const binaries = programs.map(([name, bytes]) => ({ name: 'extension/bin/' + name, bytes }));
		const problems = [...nativeProblems(binaries, target), ...programProblems(binaries, target, zipModes(workspace))];
		assert.equal(problems.length, 0, problems.join('\n'));
		return { programs, target, tree };
	} finally {
		fs.rmSync(snapshot, { recursive: true, force: true });
	}
}
