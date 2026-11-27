// Assembles the extension in build/extension/, as it ships: its manifest and the manifest's translations, which VS Code reads
// only beside it; its README, license and notices; media/; the translations of what the code says; and the code, bundled into
// dist/ - the panel's page in dist/webview/, the one part of dist/ the webview may load (PANEL-3.2).
// Packaging uses this stage; integration fixtures are staged separately.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { packageReadme } from './readme.mjs';

const root = path.join(import.meta.dirname, '..');
const stage = path.join(root, 'build', 'extension');
const windowStage = path.join(root, 'build', 'window');
const dist = path.join(stage, 'dist');
const page = path.join(dist, 'webview');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Assembled anew each time: a file gone from the repository is gone from the extension too
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'l10n'), { recursive: true });
fs.rmSync(windowStage, { recursive: true, force: true });
fs.mkdirSync(path.join(windowStage, 'l10n'), { recursive: true });
fs.mkdirSync(path.join(windowStage, 'media'), { recursive: true });

// JavaScript dependencies are bundled. Facade Code Framework programs are staged by the package build.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.dependencies;
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, undefined, '\t')}\n`);
const windowManifest = JSON.parse(fs.readFileSync(path.join(root, 'window', 'package.json'), 'utf8'));
// Installed with it through its extension pack, never as a dependency that blocks activation in a remote window (ARCHITECTURE-4.3)
if (windowManifest.version !== manifest.version || !manifest.extensionPack?.includes(`${windowManifest.publisher}.${windowManifest.name}`) || manifest.extensionDependencies?.length) {
	throw new Error('The workspace extension must install its matching window component through its extension pack.');
}
// Each component's page installs both: the window component alone shows nothing
if (!windowManifest.extensionPack?.includes(`${manifest.publisher}.${manifest.name}`) || windowManifest.extensionDependencies?.length) {
	throw new Error('The window component must install its workspace extension through its extension pack.');
}
fs.writeFileSync(path.join(windowStage, 'package.json'), `${JSON.stringify(windowManifest, undefined, '\t')}\n`);
for (const file of fs.readdirSync(path.join(root, 'l10n'))) {
	fs.copyFileSync(path.join(root, 'l10n', file), file.startsWith('package.nls') ? path.join(stage, file) : path.join(stage, 'l10n', file));
	fs.copyFileSync(path.join(root, 'l10n', file), file.startsWith('package.nls') ? path.join(windowStage, file) : path.join(windowStage, 'l10n', file));
}
for (const file of ['LICENSE.txt', 'ThirdPartyNotices.txt']) {
	fs.copyFileSync(path.join(root, file), path.join(stage, file));
	fs.copyFileSync(path.join(root, file), path.join(windowStage, file));
}
// Repository setup links belong to the checkout. Preserve all other README content unchanged (ARCHITECTURE-4.1).
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
fs.writeFileSync(path.join(stage, 'README.md'), packageReadme(readme));
// The Marketplace shows it as the extension's Changelog
fs.copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(stage, 'CHANGELOG.md'));
// The window component's own page sends people to Facade Code Extension, which installs it
fs.copyFileSync(path.join(root, 'window', 'README.md'), path.join(windowStage, 'README.md'));
fs.copyFileSync(path.join(root, 'media', 'icon.png'), path.join(windowStage, 'media', 'icon.png'));
fs.cpSync(path.join(root, 'media'), path.join(stage, 'media'), { recursive: true, filter: source => path.basename(source) !== '.DS_Store' });

// jsonc-parser's ES modules: its `main`, a UMD wrapper, requires its parts at run time, which a bundle leaves out
const common = { bundle: true, sourcemap: !production, minify: production, minifySyntax: true, logLevel: 'info', define: { FACADE_TEST_MODE: 'false' },
	alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' } };
const builds = [
	{ ...common, entryPoints: { extension: path.join(root, 'src', 'extension.ts') }, outdir: dist, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
	{ ...common, entryPoints: { window: path.join(root, 'src', 'host', 'window.ts') }, outdir: path.join(windowStage, 'dist'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
	{ ...common, entryPoints: { webview: path.join(root, 'src', 'webview', 'panel.ts') }, outdir: page, platform: 'browser', format: 'iife', target: 'es2022' }
];

if (watch) {
	for (const options of builds) {
		await (await esbuild.context(options)).watch();
	}
} else {
	const results = await Promise.all(builds.map(options => esbuild.build({ ...options, absWorkingDir: root, metafile: true })));
	fs.writeFileSync(path.join(root, 'build', 'bundle-graphs.json'), JSON.stringify(results.map(result => result.metafile)));
}
