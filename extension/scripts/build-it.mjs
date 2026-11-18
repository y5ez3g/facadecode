// Assembles the integration suite's own extension in build/extension-it/: the shipped extension of build/extension/, built in test
// mode with its test commands and the page's probe, core's programs as they ship (scripts/core.mjs), and ptyd as it ships
// (src/test/integration/ptydFixture.ts). Nothing of it reaches the shipped extension or a package (UX-3.2).
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BIN, buildCore, coreTriple } from './core.mjs';

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'build', 'extension');
const stage = path.join(root, 'build', 'extension-it');
if (!['extension.js', 'ptyd.js'].every(file => fs.existsSync(path.join(shipped, 'dist', file)))) {
	throw new Error('build/extension is not built: run `npm run bundle` first.');
}
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(shipped, stage, { recursive: true });
// The Rust engine runs on core's programs, on every supported target
if (coreTriple()) {
	buildCore();
	fs.cpSync(BIN, path.join(stage, 'bin'), { recursive: true });
}
// jsonc-parser's ES modules, as the shipped bundle has them (scripts/build.mjs)
const common = { outdir: path.join(stage, 'dist'), bundle: true, sourcemap: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'info', define: { FACADE_TEST_MODE: 'true' },
	alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' } };
const observeResumePicker = {
	name: 'resume-picker-fixture',
	setup(build) {
		const picker = path.join(root, 'src', 'ui', 'pickers', 'resume.ts');
		const fixture = path.join(root, 'src', 'test', 'integration', 'resumePickerFixture.ts');
		build.onResolve({ filter: /^vscode$/ }, args => path.normalize(args.importer) === picker ? { path: fixture } : undefined);
	}
};
await Promise.all([
	esbuild.build({ ...common, entryPoints: { extension: path.join(root, 'src', 'extension.ts') }, external: ['vscode'], plugins: [observeResumePicker] }),
	esbuild.build({ ...common, entryPoints: { ptyd: path.join(root, 'src', 'test', 'integration', 'ptydFixture.ts') }, external: ['node-pty'] }),
	esbuild.build({ ...common, entryPoints: { shim: path.join(root, 'src', 'transport', 'shim.ts') } }),
	// The page with its test probe, which the shipped page compiles out (UX-3.2)
	esbuild.build({ ...common, entryPoints: { webview: path.join(root, 'src', 'webview', 'panel.ts') }, outdir: path.join(stage, 'dist', 'webview'), platform: 'browser', format: 'iife', target: 'es2022' })
]);
