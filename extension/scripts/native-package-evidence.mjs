// Capture and verify the exact native package files produced by a candidate's GitHub workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { coreArchive, corePrograms } from '../../core/scripts/package-core.mjs';
import { CORE_BUILD_FILE, parseCoreBuild, sourceBuild } from './core.mjs';
import { filesOfZip, packageTarget } from './native.mjs';
import { fileFor, parseChecksums, sha256, targetsFor, verifyVsix } from './release-assets.mjs';
import { verifyTimestampedSignatures } from './sign.mjs';

export const evidenceFile = 'native-package-evidence.json';

function platforms(version) {
	assert.ok(/^\d+\.\d+\.\d+$/u.test(version ?? ''), 'Supply a candidate version as major.minor.patch.');
	return targetsFor(version).filter(target => target !== 'universal');
}

export function validateSource({ revision, tree, run, attempt }) {
	for (const [field, hash] of Object.entries({ revision, tree })) {
		assert.ok(typeof hash === 'string' && /^[a-f0-9]{40}$/u.test(hash), 'Invalid candidate ' + field);
	}
	for (const [field, number] of Object.entries({ run, attempt })) {
		assert.ok(typeof number === 'string' && /^[1-9][0-9]*$/u.test(number), 'Invalid GitHub ' + field);
	}
}

function fileBytes(directory, relative) {
	const file = path.join(directory, relative);
	assert.ok(fs.lstatSync(file).isFile(), relative + ' is not a regular artifact file');
	return fs.readFileSync(file);
}

function requireFiles(directory, subdirectory, names) {
	const folder = path.join(directory, subdirectory);
	assert.ok(fs.lstatSync(folder).isDirectory(), subdirectory + ' is not an artifact directory');
	assert.deepStrictEqual(fs.readdirSync(folder).sort(), [...names].sort(),
		'Missing or unexpected files in ' + subdirectory);
}

export function verifyArchivePrograms(archive, vsix, target, build) {
	const editor = new Map(filesOfZip(vsix).map(file => [file.name, file.bytes]));
	const windows = target.startsWith('win32-');
	const zip = windows ? new Map(filesOfZip(archive).map(file => [file.name, file.bytes])) : null;
	const member = name => zip ? zip.get(name)
		: execFileSync('tar', ['-xOf', archive, name], { maxBuffer: 64 * 1024 * 1024 });
	const programs = corePrograms(target).map(name => {
		const bytes = editor.get('extension/bin/' + name);
		assert.ok(bytes?.length && member(name)?.equals(bytes), name + ' differs from the paired VSIX');
		return [name, bytes];
	});
	const marker = member(CORE_BUILD_FILE);
	// Earlier release candidates recorded a numeric archive version before VSIXs carried BUILD.
	if (build === undefined || parseCoreBuild(build)?.revision) {
		assert.ok(marker && editor.get('extension/bin/' + CORE_BUILD_FILE)?.equals(marker), 'Core archive BUILD differs from the paired VSIX');
	}
	const text = marker?.toString('utf8');
	if (build !== undefined) assert.equal(text, build + '\n', 'Core archive names a different BUILD');
	return { programs, marker: text };
}

function verifyPackagedSignatures(programs) {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-signature-check-'));
	try {
		const files = programs.map(([name, bytes]) => {
			const file = path.join(stage, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, bytes);
			return file;
		});
		verifyTimestampedSignatures(files);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}

export function signingRecord(programs) {
	return {
		method: 'windows-authenticode-timestamp',
		programs: Object.fromEntries(programs.map(([name, bytes]) => [name, sha256(bytes)])),
	};
}

export function captureNativePackage(directory, target, version, source, { signing, verifySignatures = false } = {}) {
	validateSource(source);
	assert.ok(platforms(version).includes(target), 'Unexpected package target ' + target);
	const vsixName = fileFor(version, target);
	const componentName = fileFor(version, 'universal');
	const vsix = 'vsix/' + vsixName;
	const component = 'vsix/' + componentName;
	const archiveName = coreArchive(target);
	const archive = 'core/' + archiveName;
	const manifest = 'core/SHA256SUMS';
	requireFiles(directory, 'vsix', [vsixName, componentName]);
	requireFiles(directory, 'core', [archiveName, 'SHA256SUMS']);
	const checksumBytes = fileBytes(directory, manifest);
	const files = Object.fromEntries([vsix, component, archive, manifest].map(file => {
		const bytes = file === manifest ? checksumBytes : fileBytes(directory, file);
		return [file, { size: bytes.length, sha256: sha256(bytes) }];
	}));
	verifyVsix(version, target, path.join(directory, vsix));
	verifyVsix(version, 'universal', path.join(directory, component));
	const checksums = parseChecksums(checksumBytes.toString('utf8'));
	assert.deepStrictEqual([...checksums], [[archiveName, files[archive].sha256]],
		archiveName + ' differs from its candidate SHA256SUMS');
	const { programs, marker } = verifyArchivePrograms(path.resolve(directory, archive), path.join(directory, vsix), target);
	const build = marker?.trimEnd();
	const parsed = parseCoreBuild(build);
	assert.equal(parsed?.version, version, 'VSIX BUILD differs from the release version');
	assert.equal(parsed?.revision, source.revision, 'VSIX BUILD differs from the source revision');
	assert.equal(marker, build + '\n', 'Invalid VSIX BUILD marker');
	const record = { target, version, build, source, files };
	if (verifySignatures || signing !== undefined) {
		assert.ok(target.startsWith('win32-'), 'Unexpected Windows signing evidence for ' + target);
		record.signing = signingRecord(programs);
		if (verifySignatures) {
			packageTarget(target);
			verifyPackagedSignatures(programs);
		} else {
			assert.deepStrictEqual(signing, record.signing, target + ' signing evidence differs from the packaged programs');
		}
	}
	return record;
}

export function verifyNativePackages(directory, version, source, { requireSigning = false } = {}) {
	validateSource(source);
	const expected = platforms(version).map(target => 'extension-' + target);
	const present = fs.readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name.startsWith('extension-')).map(entry => entry.name);
	assert.deepStrictEqual(present.sort(), [...expected].sort(), 'Missing or unexpected native package targets');
	return platforms(version).map(target => {
		const folder = 'extension-' + target;
		requireFiles(directory, folder, ['core', evidenceFile, 'vsix']);
		const root = path.join(directory, folder);
		const record = JSON.parse(fileBytes(root, evidenceFile).toString('utf8'));
		assert.deepStrictEqual(record.source, source, target + ' has a stale candidate source or run attempt');
		if (requireSigning && target.startsWith('win32-')) {
			assert.ok(record.signing, target + ' is missing trusted signing evidence');
		}
		const current = captureNativePackage(root, target, version, source, { signing: record.signing });
		assert.deepStrictEqual(record, current, target + ' package bytes differ from the tested files');
		return current;
	});
}

function head(ref) {
	return execFileSync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' }).trim();
}

function main(args) {
	const { values, positionals } = parseArgs({
		args, allowPositionals: true, options: {
			target: { type: 'string' }, version: { type: 'string' }, revision: { type: 'string' },
			tree: { type: 'string' }, run: { type: 'string' }, attempt: { type: 'string' },
			sign: { type: 'boolean' },
		}
	});
	const [mode, directory] = positionals;
	assert.equal(positionals.length, 2, 'Supply a stamp or verify command and the artifact directory.');
	if (mode === 'stamp') {
		const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
		const source = { revision: head('HEAD'), tree: head('HEAD^{tree}'),
			run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
		const record = captureNativePackage(directory, values.target, version, source, { verifySignatures: values.sign });
		assert.equal(record.build, sourceBuild(version), 'Native package BUILD differs from its source commit');
		fs.writeFileSync(path.join(directory, evidenceFile), JSON.stringify(record, null, 2) + '\n');
		console.log('Recorded native package evidence for ' + values.target + ' on ' + source.tree);
		return;
	}
	assert.equal(mode, 'verify', 'Supply a stamp or verify command.');
	const { revision, tree, run, attempt } = values;
	const packages = verifyNativePackages(directory, values.version, { revision, tree, run, attempt }, { requireSigning: values.sign });
	console.log(packages.length + ' native package sets match candidate tree ' + tree + ' and GitHub attempt ' + run + '/' + attempt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try { main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
