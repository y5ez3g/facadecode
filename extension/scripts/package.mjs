// Packages the extension as it ships (ARCHITECTURE-4.3): the production build, then a VSIX of the workspace extension in
// build/extension/, with its Framework programs, into build/vsix/. The integration stage is a separate build.
//
// It is made for one target, `--target <target>` or this host's - only ever this host's, whose artifacts the build loads and
// starts a PTY with - and its VSIX names it. The VSIX is read back as it was written: one whose manifest names another target,
// or which carries a binary not of its target, is removed and refused.
//
// Framework's programs go in every package (scripts/framework.mjs); nothing is packaged where framework's version is not the
// extension's, or the extension's copy of the protocol is not framework's. `--sign`, which the release run gives a Windows
// package, signs its programs (scripts/sign.mjs) and packages none that still has no trusted signature.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BIN, FRAMEWORK_BUILD_FILE, buildFramework, checkSources, frameworkTriple, executableBuild, programProblems, zipModes } from './framework.mjs';
import { filesOfZip, nativeProblems, packageTarget } from './native.mjs';
import { createSigner, signFolder } from './sign.mjs';

const root = path.join(import.meta.dirname, '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const out = path.join(root, 'build', 'vsix');
const asked = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : process.argv.find(arg => arg.startsWith('--target='))?.slice('--target='.length);
// Before anything is built: another target than this host's cannot be verified here
const target = packageTarget(asked);
checkSources();
if (process.argv.includes('--sign') && !target.startsWith('win32-')) {
	throw new Error(`Only Windows packages are signed, not ${target}'s.`);
}
const signer = process.argv.includes('--sign') ? createSigner() : undefined;

execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--production'], { stdio: 'inherit' });
let build;
if (frameworkTriple()) {
	build = buildFramework();
	if (signer) {
		signFolder(signer, BIN);
	}
	const program = target.startsWith('win32-') ? 'facade.exe' : 'facade';
	assert.equal(executableBuild(path.join(BIN, program)), build, 'The built executable reports a different BUILD');
	fs.cpSync(BIN, path.join(root, 'build', 'extension', 'bin'), { recursive: true });
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [stage, native] of [['window', false], ['extension', true]]) {
	const dir = path.join(root, 'build', stage);
	const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	const file = path.join(out, native ? `${name}-${target}-${version}.vsix` : `${name}-${version}.vsix`);
	// The stage has bundled JavaScript and native Framework programs. Preserve README links.
	execFileSync(process.execPath, [vsce, 'package', ...(native ? ['--target', target] : []), '--no-rewrite-relative-links', '--out', file], { cwd: dir, stdio: 'inherit' });
	const files = filesOfZip(file);
	const identity = files.find(each => each.name === 'extension.vsixmanifest')?.bytes.toString('utf8').match(/<Identity\b[^>]*>/)?.[0] ?? '';
	const named = identity.match(/\bTargetPlatform="([^"]*)"/)?.[1];
	const buildMarker = files.find(each => each.name === `extension/bin/${FRAMEWORK_BUILD_FILE}`)?.bytes.toString('utf8');
	const problems = [
		...(named === (native ? target : undefined) ? [] : [`its manifest names ${named === undefined ? 'no target' : `the target ${named}`}, not ${native ? target : 'none'}`]),
		...nativeProblems(files, target, { none: !native }),
		...(native ? programProblems(files, target, zipModes(file)) : []),
		...(native && buildMarker !== `${build}\n` ? ['its BUILD marker differs from the compiled build'] : []),
	];
	if (problems.length) {
		fs.rmSync(file, { force: true });
		throw new Error(`${path.basename(file)} is refused and removed: ${problems.join('; ')}.`);
	}
	console.info(`${path.basename(file)}: ${native ? `for ${target} alone, its native binaries all ${target}'s, framework's programs with them` : 'for every target, no native binary'}.`);
}
