// Assembles the integration suite's own extension in build/extension-it/: the shipped extension of build/extension/, built in test
// mode with its test commands and the page's probe, and ptyd as it ships (src/test/integration/ptydFixture.ts). Nothing of it
// reaches the shipped extension or a package (UX-3.2).
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'build', 'extension');
const stage = path.join(root, 'build', 'extension-it');
if (!['extension.js', 'ptyd.js'].every(file => fs.existsSync(path.join(shipped, 'dist', file)))) {
	throw new Error('build/extension is not built: run `npm run bundle` first.');
}
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(shipped, stage, { recursive: true });
const common = { outdir: path.join(stage, 'dist'), bundle: true, sourcemap: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'info', define: { FACADE_TEST_MODE: 'true' } };
await Promise.all([
	esbuild.build({ ...common, entryPoints: { extension: path.join(root, 'src', 'extension.ts') }, external: ['vscode'] }),
	esbuild.build({ ...common, entryPoints: { ptyd: path.join(root, 'src', 'test', 'integration', 'ptydFixture.ts') }, external: ['node-pty'] }),
	// The page with its test probe, which the shipped page compiles out (UX-3.2)
	esbuild.build({ ...common, entryPoints: { webview: path.join(root, 'src', 'webview', 'panel.ts') }, outdir: path.join(stage, 'dist', 'webview'), platform: 'browser', format: 'iife', target: 'es2022' })
]);
