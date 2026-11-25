// Replay retained native release tests against the accepted package bytes (ARCHITECTURE-4.3).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frameworkArchive } from '../../framework/scripts/package-framework.mjs';
import { filesOfZip } from './native.mjs';
import { compareVersions, fileFor, nativeTargets, sha256 } from './release-assets.mjs';

const digestPattern = /^[a-f0-9]{64}$/u;
const editorCleanup = 'Isolated editor profile cleanup finished.';
const editorPass = 'Facade acceptance test ';

function artifactBytes(file) {
	assert.ok(fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(), `${file}: missing or invalid evidence file`);
	return fs.readFileSync(file);
}

export function readNativeTestEvidence(directory, digest) {
	assert.match(digest ?? '', digestPattern, 'Supply the reviewed native test evidence digest');
	const bytes = artifactBytes(path.join(directory, 'native-test-evidence.json'));
	assert.equal(sha256(bytes), digest, 'Native test evidence differs from the reviewed digest');
	const evidence = JSON.parse(bytes.toString('utf8'));
	assert.equal(evidence?.schemaVersion, 1, 'Unsupported native test evidence record');
	assert.match(evidence.manifestSha256 ?? '', digestPattern, 'Missing or invalid release manifest digest in native test evidence');
	return evidence;
}

function readTestLog(directory, check, expected, record) {
	const file = `${expected.target}/${check}.log`;
	assert.equal(record?.exitCode, 0, `${file}: missing successful native test record`);
	const { source, target, inputs } = record;
	assert.deepStrictEqual({ source, target, inputs }, expected,
		`${file}: source, target or package inputs differ from the accepted candidate`);
	const bytes = artifactBytes(path.join(directory, file));
	assert.equal(sha256(bytes), record.sha256, `${file}: log differs from the native test record`);
	return bytes.toString('utf8').trimEnd().split(/\r?\n/u);
}

function verifyFrameworkInstall(lines, build, target) {
	const installs = lines.filter(line => line.startsWith(`Installed Facade ${build} in `));
	assert.equal(installs.length, 1, `${target}: missing or repeated successful Framework install`);
	assert.equal(lines.at(-1), `facade ${build}`, `${target}: Framework install did not report the installed Shell BUILD`);
}

function verifyEditorTest(lines, check, target, implementation) {
	const results = lines.filter(line => line.startsWith(editorPass));
	assert.equal(results.length, 1, `${target}/${check}: missing or conflicting editor results`);
	const cleanup = lines.filter(line => line === editorCleanup);
	assert.equal(cleanup.length, 1, `${target}/${check}: missing or repeated editor cleanup`);
	assert.deepStrictEqual(lines.slice(-2), [editorCleanup, editorPass + JSON.stringify({ name: check, implementation })],
		`${target}/${check}: missing exact installed editor result after cleanup`);
}

function verifyEditorInputs(editor, prior, version, target) {
	assert.match(editor?.version ?? '', /^\d+\.\d+\.\d+$/u, `${target}: invalid editor version`);
	assert.match(editor.commit ?? '', /^[a-f0-9]{40}$/u, `${target}: invalid editor commit`);
	assert.match(editor.sha256 ?? '', digestPattern, `${target}: missing editor archive digest`);
	const priorVersion = /^extension\/(\d+\.\d+\.\d+)$/u.exec(prior?.tag ?? '')?.[1];
	assert.ok(priorVersion && compareVersions(priorVersion, version) < 0, `${target}: expected an earlier release for the upgrade`);
	assert.deepStrictEqual(Object.keys(prior.files ?? {}).sort(), [fileFor(priorVersion, target), fileFor(priorVersion, 'universal')].sort(),
		`${target}: missing or wrong prior VSIX pair`);
	for (const digest of Object.values(prior.files)) {
		assert.match(digest, digestPattern, `${target}: invalid prior VSIX digest`);
	}
}

export function verifyNativeTestEvidence(directory, evidence, tag, version, build, source, assets) {
	assert.equal(evidence.tag, tag, 'Native test evidence names another tag');
	assert.deepStrictEqual(evidence.source, source, 'Native test evidence names another candidate source or attempt');
	assert.ok(Array.isArray(evidence.targets), 'Missing native test targets');
	assert.deepStrictEqual(evidence.targets.map(record => record?.target).sort(), [...nativeTargets].sort(),
		'Missing, unexpected or duplicate native test targets');
	const logsDirectory = path.join(directory, 'tests');
	assert.ok(fs.lstatSync(logsDirectory, { throwIfNoEntry: false })?.isDirectory(), 'Missing native test logs directory');
	const digests = new Map(assets.map(({ file, sha256 }) => [file, sha256]));
	const inputs = (...files) => Object.fromEntries(files.map(file => [file, digests.get(file)]));
	return evidence.targets.map(({ target, packageEvidenceSha256, logs }) => {
		assert.ok(fs.lstatSync(path.join(logsDirectory, target), { throwIfNoEntry: false })?.isDirectory(),
			`${target}: missing native test logs`);
		assert.match(packageEvidenceSha256 ?? '', digestPattern, `${target}: missing native package evidence digest`);
		assert.deepStrictEqual(Object.keys(logs ?? {}).sort(), ['framework-install', 'install-pair', 'upgrade-pair'],
			`${target}: missing or unexpected native test records`);
		const context = { source, target };
		const archive = inputs(frameworkArchive(target), target.startsWith('win32-') ? 'install.ps1' : 'install.sh');
		const install = readTestLog(logsDirectory, 'framework-install', { ...context, inputs: archive }, logs['framework-install']);
		verifyFrameworkInstall(install, build, target);
		const nativeFile = fileFor(version, target);
		const pair = inputs(nativeFile, fileFor(version, 'universal'));
		const vsix = assets.find(asset => asset.file === nativeFile);
		const legacy = filesOfZip(vsix.path).some(entry => entry.name === 'extension/dist/ptyd.js');
		const implementation = legacy ? 'legacy' : 'framework';
		for (const check of ['install-pair', 'upgrade-pair']) {
			verifyEditorTest(readTestLog(logsDirectory, check, { ...context, inputs: pair }, logs[check]), check, target, implementation);
		}
		const { editor, prior } = logs['upgrade-pair'];
		verifyEditorInputs(editor, prior, version, target);
		assert.deepStrictEqual(logs['install-pair'].editor, editor, `${target}: install and upgrade used different editor builds`);
		return { target, packageEvidenceSha256, logs };
	});
}
