// Assembles the integration suite's own extension in build/extension-it/: the shipped extension of build/extension/, built in test
// mode with its test commands and the page's probe, and Framework's programs as they ship (scripts/framework.mjs).
// Nothing of the test code reaches the shipped extension or a package (UX-3.2).
// --framework-package DIRECTORY --framework-package-evidence-sha256 DIGEST stages Framework from a verified native package artifact.
// DIGEST is the independently verified SHA-256 of the artifact's native-package-evidence.json.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { BIN, FRAMEWORK_BUILD_FILE, buildFramework, frameworkTriple } from './framework.mjs';

const { values: { 'framework-package': packageDir, 'framework-package-evidence-sha256': evidenceDigest } } = parseArgs({ options: {
	'framework-package': { type: 'string' },
	'framework-package-evidence-sha256': { type: 'string' }
} });
if ((packageDir === undefined) !== (evidenceDigest === undefined)) {
	throw new Error('Supply --framework-package and --framework-package-evidence-sha256 together.');
}

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'build', 'extension');
const stage = path.join(root, 'build', 'extension-it');
if (!fs.existsSync(path.join(shipped, 'dist', 'extension.js'))) {
	throw new Error('build/extension is not built: run `npm run bundle` first.');
}
const packagedFramework = packageDir === undefined ? undefined
	: (await import('./editor-framework-package.mjs')).readEditorFrameworkPackage(root, packageDir, evidenceDigest);
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(shipped, stage, { recursive: true });
const bin = path.join(stage, 'bin');
if (packagedFramework) {
	fs.rmSync(bin, { recursive: true, force: true });
	for (const [name, bytes] of packagedFramework.programs) {
		const file = path.join(bin, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, bytes);
		if (process.platform !== 'win32') {
			fs.chmodSync(file, 0o755);
		}
	}
	fs.writeFileSync(path.join(bin, FRAMEWORK_BUILD_FILE), packagedFramework.marker);
	console.info(`Staged Framework from the verified ${packagedFramework.target} package on tree ${packagedFramework.tree}.`);
} else if (frameworkTriple()) {
	buildFramework();
	fs.cpSync(BIN, bin, { recursive: true });
}
// jsonc-parser's ES modules, as the shipped bundle has them (scripts/build.mjs)
const common = { outdir: path.join(stage, 'dist'), bundle: true, sourcemap: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'info', define: { FACADE_TEST_MODE: 'true' },
	alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' } };
const observeResumePicker = {
	name: 'resume-picker-fixture',
	setup(build) {
		const pickers = new Set(['resume.ts', 'stepping.ts'].map(file => path.join(root, 'src', 'ui', 'pickers', file)));
		const fixture = path.join(root, 'src', 'test', 'integration', 'resumePickerFixture.ts');
		build.onResolve({ filter: /^vscode$/ }, args => pickers.has(path.normalize(args.importer)) ? { path: fixture } : undefined);
	}
};
await Promise.all([
	esbuild.build({ ...common, entryPoints: { extension: path.join(root, 'src', 'extension.ts') }, external: ['vscode'], plugins: [observeResumePicker] }),
	// The page with its test probe, which the shipped page compiles out (UX-3.2)
	esbuild.build({ ...common, entryPoints: { webview: path.join(root, 'src', 'webview', 'panel.ts') }, outdir: path.join(stage, 'dist', 'webview'), platform: 'browser', format: 'iife', target: 'es2022',
		inject: [path.join(root, 'src', 'test', 'integration', 'panelGenerationFixture.ts')] })
]);
