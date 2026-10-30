// Assembles the extension in build/extension/, as it ships: its manifest and the manifest's translations, which VS Code reads
// only beside it; its README, license and notices; media/; the translations of what the code says; and the code, bundled into
// dist/ - the panel's page in dist/webview/, the one part of dist/ the webview may load (PANEL-3.2).
// Packaging uses this stage; integration fixtures are staged separately.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { filesUnder, hostTarget, nativeProblems } from './native.mjs';
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

// JavaScript dependencies are bundled; the native backend remains an explicit, packaged dependency.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete manifest.scripts;
delete manifest.devDependencies;
const nativeRoot = path.join(root, 'node_modules', 'node-pty');
const nativeManifest = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8'));
manifest.dependencies = { 'node-pty': nativeManifest.version };
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, undefined, '\t')}\n`);
const windowManifest = JSON.parse(fs.readFileSync(path.join(root, 'window', 'package.json'), 'utf8'));
if (windowManifest.version !== manifest.version || !manifest.extensionDependencies?.includes(`${windowManifest.publisher}.${windowManifest.name}`)) {
	throw new Error('The workspace extension must depend on its matching window component.');
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
fs.writeFileSync(path.join(windowStage, 'README.md'), packageReadme(readme));
fs.copyFileSync(path.join(root, 'media', 'icon.png'), path.join(windowStage, 'media', 'icon.png'));
fs.cpSync(path.join(root, 'media'), path.join(stage, 'media'), { recursive: true, filter: source => path.basename(source) !== '.DS_Store' });

// Stage only this build's native target. Linux source builds use build/Release; other targets need their own build.
const nativeStage = path.join(stage, 'node_modules', 'node-pty');
fs.mkdirSync(nativeStage, { recursive: true });
for (const file of ['package.json', 'LICENSE']) {
	fs.copyFileSync(path.join(nativeRoot, file), path.join(nativeStage, file));
}
for (const dir of ['lib', 'typings']) {
	fs.cpSync(path.join(nativeRoot, dir), path.join(nativeStage, dir), {
		recursive: true,
		filter: source => !/\.test\.(?:js|js\.map|d\.ts)$/.test(source) && !source.endsWith('.DS_Store')
	});
}
const target = `${process.platform}-${process.arch}`;
const prebuild = path.join('prebuilds', target);
const nativeDir = fs.existsSync(path.join(nativeRoot, prebuild)) ? prebuild : path.join('build', 'Release');
if (!fs.existsSync(path.join(nativeRoot, nativeDir))) {
	throw new Error(`No node-pty artifacts for ${target}. Install dependencies on the target platform before bundling.`);
}
fs.cpSync(path.join(nativeRoot, nativeDir), path.join(nativeStage, nativeDir), {
	recursive: true,
	filter: source => fs.statSync(source).isDirectory() || /\.(?:node|dll|exe)$/.test(source) || path.basename(source) === 'spawn-helper'
});
const helper = path.join(nativeStage, nativeDir, 'spawn-helper');
if (fs.existsSync(helper)) {
	fs.chmodSync(helper, 0o755);
}
// Preserve the installed production dependency graph, including node-addon-api's license and headers.
const copied = new Set(['node-pty']);
function copyDependencies(packageRoot) {
	const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
	const require = createRequire(path.join(packageRoot, 'package.json'));
	for (const name of Object.keys(pkg.dependencies ?? {})) {
		if (copied.has(name)) continue;
		const dependencyRoot = path.dirname(require.resolve(`${name}/package.json`));
		fs.cpSync(dependencyRoot, path.join(stage, 'node_modules', name), { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
		copied.add(name);
		copyDependencies(dependencyRoot);
	}
}
copyDependencies(nativeRoot);
const stagedRequire = createRequire(path.join(stage, 'package.json'));
if (!stagedRequire.resolve('node-pty').startsWith(`${nativeStage}${path.sep}`)) {
	throw new Error('The native backend resolved outside the staged extension.');
}
stagedRequire('node-pty');
// Each binary staged is this host's by its own header, whatever it is called, and each addon a Node-API one (ARCHITECTURE-4.3)
const problems = nativeProblems(filesUnder(path.join(stage, 'node_modules')), hostTarget());
if (problems.length) {
	throw new Error(`The staged native backend is not ${hostTarget()}'s: ${problems.join('; ')}.`);
}
console.info(`Native PTY: ${nativeManifest.version}, ${hostTarget()}, build runtime ${process.version} (Node-API ${process.versions.napi})`);

const common = { bundle: true, sourcemap: !production, minify: production, minifySyntax: true, logLevel: 'info', define: { FACADE_TEST_MODE: 'false' } };
const builds = [
	{ ...common, entryPoints: { extension: path.join(root, 'src', 'extension.ts') }, outdir: dist, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
	{ ...common, entryPoints: { window: path.join(root, 'src', 'host', 'window.ts') }, outdir: path.join(windowStage, 'dist'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
	// ptyd: run by the extension host's binary as Node, detached; node-pty is native and loads from node_modules beside it
	{ ...common, entryPoints: { ptyd: path.join(root, 'src', 'ptyd', 'main.ts') }, outdir: dist, platform: 'node', format: 'cjs', target: 'node20', external: ['node-pty'] },
	{ ...common, entryPoints: { webview: path.join(root, 'src', 'webview', 'panel.ts') }, outdir: page, platform: 'browser', format: 'iife', target: 'es2022' }
];

if (watch) {
	for (const options of builds) {
		await (await esbuild.context(options)).watch();
	}
} else {
	await Promise.all(builds.map(options => esbuild.build(options)));
}
