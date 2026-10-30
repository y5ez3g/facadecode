// Packages the extension as it ships (ARCHITECTURE-4.3): the production build, then a VSIX of the workspace extension in
// build/extension/, its native backend under node_modules/ with it, into build/vsix/. Never the integration suite's build, never
// published: packaging is local (ARCHITECTURE-5.4).
//
// It is made for one target, `--target <target>` or this host's - only ever this host's, whose artifacts the build loads and
// starts a PTY with - and its VSIX names it. The VSIX is read back as it was written: one whose manifest names another target,
// or which carries a binary not of its target, is removed and refused.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { filesOfZip, nativeProblems, packageTarget } from './native.mjs';

const root = path.join(import.meta.dirname, '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const out = path.join(root, 'build', 'vsix');
const asked = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : process.argv.find(arg => arg.startsWith('--target='))?.slice('--target='.length);
// Before anything is built: another target than this host's cannot be verified here
const target = packageTarget(asked);

execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--production'], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [stage, native] of [['window', false], ['extension', true]]) {
	const dir = path.join(root, 'build', stage);
	const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	const file = path.join(out, native ? `${name}-${target}-${version}.vsix` : `${name}-${version}.vsix`);
	// Its dependencies as the stage holds them - the native backend among them; README links left as they are, with no repository
	execFileSync(process.execPath, [vsce, 'package', ...(native ? ['--target', target] : []), '--no-rewrite-relative-links', '--allow-missing-repository', '--out', file], { cwd: dir, stdio: 'inherit' });
	const files = filesOfZip(file);
	const identity = files.find(each => each.name === 'extension.vsixmanifest')?.bytes.toString('utf8').match(/<Identity\b[^>]*>/)?.[0] ?? '';
	const named = identity.match(/\bTargetPlatform="([^"]*)"/)?.[1];
	const problems = [
		...(named === (native ? target : undefined) ? [] : [`its manifest names ${named === undefined ? 'no target' : `the target ${named}`}, not ${native ? target : 'none'}`]),
		...nativeProblems(files, target, { none: !native })
	];
	if (problems.length) {
		fs.rmSync(file, { force: true });
		throw new Error(`${path.basename(file)} is refused and removed: ${problems.join('; ')}.`);
	}
	console.info(`${path.basename(file)}: ${native ? `for ${target} alone, its native binaries all ${target}'s` : 'for every target, no native binary'}.`);
}
