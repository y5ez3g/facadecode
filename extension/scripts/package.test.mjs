import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { binaryTarget, filesOfZip, hostTarget, nativeProblems, packageTarget } from './native.mjs';
import { packageReadme } from './readme.mjs';

const root = path.join(import.meta.dirname, '..');
const stage = path.join(root, 'build', 'extension');
const start = '<!-- repository-only:start -->';
const end = '<!-- repository-only:end -->';

test('README staging preserves all content outside one optional repository block', () => {
	const plain = '# Product\n\nNothing to omit.\n';
	assert.equal(packageReadme(plain), plain);
	const before = '# Product\n\n';
	const after = '\n\n## License\nMIT.\n';
	assert.equal(packageReadme(`${before}${start}\nLocal setup and links.\n${end}${after}`), before + after);
});

test('malformed README markers fail instead of silently discarding product content', () => {
	for (const content of [start, end, end + start, start + start + end + end, start + end + start + end,
		'<!--repository-only:start -->' + end, start + '<!-- repository-only:unknown -->' + end]) {
		assert.throws(() => packageReadme(content), /one start\/end pair/);
	}
});

test('the bundled extension loads with every module it needs inside it: nothing it requires at run time is left out of the package (UX-3.2)', () => {
	// Its top level runs with a stand-in for the editor's API - each name @types/vscode declares, taking any use - so that a module
	// the bundle left to a run-time require fails here, as a dependency's UMD wrapper would, and not in a person's editor
	const local = createRequire(import.meta.url);
	const declared = fs.readFileSync(local.resolve('@types/vscode/index.d.ts'), 'utf8');
	const any = new Proxy(function stand() {}, { get: (_, key) => key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : any, apply: () => any, construct: () => any });
	const editor = Object.fromEntries([...declared.matchAll(/^\texport (?:namespace|class|enum|const|function|let) ([A-Za-z_$][\w$]*)/gm)].map(([, name]) => [name, any]));
	const Module = local('node:module');
	const load = Module._load;
	Module._load = function (request, ...rest) { return request === 'vscode' ? editor : load.call(this, request, ...rest); };
	try {
		const extension = createRequire(path.join(stage, 'dist', 'extension.js'))('./extension.js');
		assert.equal(typeof extension.activate, 'function');
	} finally {
		Module._load = load;
	}
});

test('the staged product has usable README links and preserves both product and upstream notices', () => {
	const readme = fs.readFileSync(path.join(stage, 'README.md'), 'utf8');
	assert.equal(readme, packageReadme(fs.readFileSync(path.join(root, 'README.md'), 'utf8')));
	for (const [, target] of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		if (!/^[a-z]+:/i.test(target) && !target.startsWith('#')) {
			assert.ok(fs.existsSync(path.join(stage, target)), `Missing README link: ${target}`);
		}
	}
	assert.match(fs.readFileSync(path.join(stage, 'LICENSE.txt'), 'utf8'), /2026 Facade Code contributors/);
	const notices = fs.readFileSync(path.join(stage, 'ThirdPartyNotices.txt'), 'utf8');
	assert.match(notices, /2015 - present Microsoft Corporation/);
	assert.match(notices, /2026 - present Facade Code contributors/);
	// node-pty's Windows build ships ConPTY's conpty.dll and OpenConsole.exe, whose notice is not in node-pty's own
	assert.match(notices, /^ConPTY \(conpty\.dll and OpenConsole\.exe/m);
	assert.doesNotMatch(notices, /^None$/m);
});

test('production manifest and executable bundles exclude the integration commands and CLI fixture (UX-3.2)', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	const extension = fs.readFileSync(path.join(stage, 'dist', 'extension.js'), 'utf8');
	const contributed = new Set(manifest.contributes.commands.map(command => command.command));
	// Every command the bundle registers is a catalog command; test commands and retired IDs are absent
	const registered = new Set([...extension.matchAll(/["'](_?facade\.[A-Za-z.]+)["']/g)].map(match => match[1]).filter(id => !/^facade\.(yolo|claude|codex|antigravity|muse|opencode|pi|locations|lastLaunch|panel)\b/.test(id)));
	for (const id of ['facade.state', 'facade.selectRow', 'facade.probe', 'facade.stopAgent', 'facade.nextAgent', 'facade.startAgent']) {
		assert.ok(!contributed.has(id), `Not a shipped command: ${id}`);
		assert.ok(!registered.has(id), `Registered in the production bundle: ${id}`);
	}
	assert.ok(!/facadeDots\./.test(JSON.stringify(manifest)) && !/facadeDots\./.test(extension), 'No retired facadeDots IDs');
	const ptyd = fs.readFileSync(path.join(stage, 'dist', 'ptyd.js'), 'utf8');
	assert.ok(!ptyd.includes('node_modules.asar'), 'Native loader reaches into the editor');
	assert.ok(!ptyd.includes('fixture>'), 'Integration CLI parser in production');
	const page = fs.readFileSync(path.join(stage, 'dist', 'webview', 'webview.js'), 'utf8');
	assert.ok(!page.includes('FACADE_PROBE'), 'Test probe in the shipped page');
	// The page's folder, the webview's one resource root in dist/, holds the page alone (PANEL-3.2)
	assert.deepStrictEqual(fs.readdirSync(path.join(stage, 'dist', 'webview')).filter(file => !file.endsWith('.map')).sort(), ['webview.js']);
});

test('the staged product carries the font of New Agent\'s own icon and the Codicons notice it needs (PANEL-1.1)', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	const { fontPath } = manifest.contributes.icons['facade-new-agent'].default;
	// A WOFF of its own, beside the manifest
	assert.equal(fs.readFileSync(path.join(stage, fontPath)).subarray(0, 4).toString('latin1'), 'wOFF');
	const notices = fs.readFileSync(path.join(stage, 'ThirdPartyNotices.txt'), 'utf8');
	assert.match(notices, /^@vscode\/codicons: the new-session icon \(media\/new-agent\.woff\)$/m);
	assert.match(notices, /Creative Commons Attribution 4\.0 International Public License/);
});

/** The tables of the WOFF `bytes`, each inflated where it was compressed. */
function wOFFTables(bytes) {
	const tables = new Map();
	for (let i = 0; i < bytes.readUInt16BE(12); i++) {
		const at = 44 + i * 20, name = bytes.subarray(at, at + 4).toString('ascii');
		const offset = bytes.readUInt32BE(at + 4), compressed = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
		const data = bytes.subarray(offset, offset + compressed);
		tables.set(name, compressed < length ? inflateSync(data) : data);
	}
	return tables;
}

/** The glyph the `cmap` table maps each code point to, by its Unicode subtable of format 12, else 4; 0 for none. */
function glyphsOf(cmap) {
	const subtables = Array.from({ length: cmap.readUInt16BE(2) }, (_, i) => ({ platform: cmap.readUInt16BE(4 + i * 8), encoding: cmap.readUInt16BE(6 + i * 8), at: cmap.readUInt32BE(8 + i * 8) }))
		.filter(each => each.platform === 0 || (each.platform === 3 && (each.encoding === 1 || each.encoding === 10)));
	const of = format => subtables.find(each => cmap.readUInt16BE(each.at) === format)?.at;
	const long = of(12);
	if (long !== undefined) {
		const groups = Array.from({ length: cmap.readUInt32BE(long + 12) }, (_, i) => [0, 4, 8].map(field => cmap.readUInt32BE(long + 16 + i * 12 + field)));
		return codePoint => { const group = groups.find(([start, end]) => start <= codePoint && codePoint <= end); return group ? group[2] + codePoint - group[0] : 0; };
	}
	const at = of(4);
	assert.ok(at !== undefined, 'the font maps no Unicode code point');
	const segments = cmap.readUInt16BE(at + 6) / 2;
	const ends = at + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
	return codePoint => {
		for (let i = 0; i < segments; i++) {
			if (cmap.readUInt16BE(ends + i * 2) < codePoint || cmap.readUInt16BE(starts + i * 2) > codePoint) { continue; }
			const delta = cmap.readUInt16BE(deltas + i * 2), range = cmap.readUInt16BE(ranges + i * 2);
			if (!range) { return (codePoint + delta) & 0xFFFF; }
			const glyph = cmap.readUInt16BE(ranges + i * 2 + range + (codePoint - cmap.readUInt16BE(starts + i * 2)) * 2);
			return glyph ? (glyph + delta) & 0xFFFF : 0;
		}
		return 0;
	};
}

/** Each glyph the `COLR` table colors, with which drawing: a COLRv1 paint, else the COLRv0 layers. */
function colorDrawingsOf(colr) {
	const drawings = new Map();
	const records = colr.readUInt32BE(4);
	for (let i = 0; i < colr.readUInt16BE(2); i++) {
		drawings.set(colr.readUInt16BE(records + i * 6), `layers ${colr.readUInt16BE(records + i * 6 + 2)} ${colr.readUInt16BE(records + i * 6 + 4)}`);
	}
	const list = colr.readUInt16BE(0) >= 1 ? colr.readUInt32BE(14) : 0;
	for (let i = 0; list && i < colr.readUInt32BE(list); i++) {
		drawings.set(colr.readUInt16BE(list + 4 + i * 6), `paint ${list + colr.readUInt32BE(list + 4 + i * 6 + 2)}`);
	}
	return drawings;
}

/**
 * Each terminal icon `ids` of the manifest is a glyph of its own in a packaged WOFF with color layers and monochrome outlines, and
 * each layer of its font keeps its true bearing: a zero one shifts nonzero-x layers left, breaking a multicolor glyph even though the
 * font and every code point load. The font maps each icon's code point to a glyph of its own, colored by a drawing of its own: one
 * mapped to another icon's glyph would show that icon.
 */
function assertColorIcons(manifest, ids) {
	const characters = new Set();
	const fonts = new Map();
	for (const id of ids) {
		const { fontPath, fontCharacter } = manifest.contributes.icons[id].default;
		assert.ok(!characters.has(`${fontPath} ${fontCharacter}`), `${id} must have its own glyph`);
		characters.add(`${fontPath} ${fontCharacter}`);
		fonts.set(fontPath, [...fonts.get(fontPath) ?? [], { id, codePoint: parseInt(fontCharacter.slice(1), 16) }]);
	}
	for (const [fontPath, icons] of fonts) {
		const bytes = fs.readFileSync(path.join(stage, fontPath));
		assert.strictEqual(bytes.subarray(0, 4).toString('ascii'), 'wOFF');
		const tables = wOFFTables(bytes);
		for (const required of ['cmap', 'glyf', 'COLR', 'CPAL']) { assert.ok(tables.has(required), `${fontPath}: missing ${required}`); }
		const glyphOf = glyphsOf(tables.get('cmap')), drawings = colorDrawingsOf(tables.get('COLR'));
		const shown = new Map(), drawn = new Map();
		for (const { id, codePoint } of icons) {
			const glyph = glyphOf(codePoint);
			assert.ok(glyph, `${id}: ${fontPath} maps no glyph to U+${codePoint.toString(16).toUpperCase()}`);
			assert.ok(!shown.has(glyph), `${id} shows the glyph of ${shown.get(glyph)}`);
			shown.set(glyph, id);
			assert.ok(drawings.has(glyph), `${id}: glyph ${glyph} of ${fontPath} has no color`);
			assert.ok(!drawn.has(drawings.get(glyph)), `${id} is colored as ${drawn.get(drawings.get(glyph))}`);
			drawn.set(drawings.get(glyph), id);
		}
		const count = tables.get('maxp').readUInt16BE(4), metrics = tables.get('hhea').readUInt16BE(34);
		const long = tables.get('head').readInt16BE(50) === 1;
		const offset = i => long ? tables.get('loca').readUInt32BE(i * 4) : tables.get('loca').readUInt16BE(i * 2) * 2;
		for (let i = 0; i < count; i++) {
			if (offset(i) === offset(i + 1)) { continue; }
			const xMin = tables.get('glyf').readInt16BE(offset(i) + 2);
			const bearing = tables.get('hmtx').readInt16BE(i < metrics ? i * 4 + 2 : metrics * 4 + (i - metrics) * 2);
			assert.strictEqual(bearing, xMin, `${fontPath} glyph ${i}: keep the layer's position`);
		}
	}
}

test('all built-in terminal logos are packaged native icons with color layers and monochrome outlines (LIFECYCLE-2.2)', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	assertColorIcons(manifest, ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'].map(cli => `facade-cli-${cli}`));
});

test('the 16 robots an entry\'s icon can name are packaged: tab glyphs in a font of their own from U+E200 in their order, with color layers and monochrome outlines, and the images of pickers and cards (CONFIGURATION-2.4)', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	const robots = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink', 'aurora', 'sunset', 'ocean', 'orchid', 'pearl', 'graphite'];
	const ids = robots.map(robot => `facade-robot-${robot}`);
	assert.deepStrictEqual(Object.keys(manifest.contributes.icons).filter(id => id.startsWith('facade-robot-')), ids);
	assert.deepStrictEqual(ids.map(id => manifest.contributes.icons[id].default),
		robots.map((_, index) => ({ fontPath: './media/robots.woff', fontCharacter: `\\${(0xE200 + index).toString(16).toUpperCase()}` })));
	assertColorIcons(manifest, ids);
	const images = ['robot-eyes.svg', ...robots.flatMap(robot => [`robot-${robot}.svg`, `robot-${robot}-face.svg`])];
	assert.deepStrictEqual(images.filter(image => !fs.existsSync(path.join(stage, 'media', 'agents', image))), []);
	// The letter avatars they replaced are gone, their font's notice with them
	assert.deepStrictEqual(Object.keys(manifest.contributes.icons).filter(id => id.startsWith('facade-letter-')), []);
	assert.ok(!fs.existsSync(path.join(stage, 'media', 'letters.woff')));
	assert.doesNotMatch(fs.readFileSync(path.join(stage, 'ThirdPartyNotices.txt'), 'utf8'), /IBM Plex/);
});

test('the native backend starts a PTY after the extension is moved outside the repository', { timeout: 15000 }, async t => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-package-'));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const moved = path.join(temp, 'extension');
	fs.cpSync(stage, moved, { recursive: true });
	const require = createRequire(path.join(moved, 'package.json'));
	const movedReal = fs.realpathSync(moved);
	const installed = JSON.parse(fs.readFileSync(path.join(moved, 'node_modules', 'node-pty', 'package.json'), 'utf8'));
	for (const name of ['node-pty', ...Object.keys(installed.dependencies ?? {})]) {
		assert.ok(require.resolve(name).startsWith(`${movedReal}${path.sep}`), `${name} resolved outside the moved extension`);
	}
	const marker = 'facade-packaged-pty-ok';
	// A program needs SystemRoot to start on Windows - Node's random numbers do - and nothing else of this environment
	const env = { TERM: 'xterm-256color', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
	// Started in a process of its own, which says what it saw and exits: on Windows node-pty keeps its console's pipes and worker
	// open after the program ends, which would keep this test's process from ever ending
	const probe = `const native = require('node:module').createRequire(${JSON.stringify(path.join(moved, 'package.json'))})('node-pty');
const child = native.spawn(process.execPath, ['-e', ${JSON.stringify(`process.stdout.write('${marker}'); setTimeout(() => {}, 50);`)}], { name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(temp)}, env: ${JSON.stringify(env)} });
let output = '';
child.onData(chunk => { output += chunk; });
child.onExit(event => process.stdout.write(JSON.stringify({ exitCode: event.exitCode, output }), () => process.exit(0)));`;
	const ran = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 10000 });
	assert.equal(ran.status, 0, `Packaged PTY probe: ${ran.error ?? ran.stderr}`);
	const result = JSON.parse(ran.stdout);
	assert.equal(result.exitCode, 0, `Packaged PTY output: ${result.output}`);
	assert.ok(result.output.includes(marker), `Packaged PTY output: ${result.output}`);
});

/** Headers as each format begins - Mach-O, universal Mach-O, ELF, PE - of the CPU given, and an addon's Node-API entry point. */
function machO(cpu) {
	const bytes = Buffer.alloc(32);
	bytes.writeUInt32LE(0xfeedfacf, 0);
	bytes.writeUInt32LE(cpu, 4);
	return bytes;
}
function universal(...cpus) {
	const bytes = Buffer.alloc(8 + cpus.length * 20);
	bytes.writeUInt32BE(0xcafebabe, 0);
	bytes.writeUInt32BE(cpus.length, 4);
	cpus.forEach((cpu, index) => bytes.writeUInt32BE(cpu, 8 + index * 20));
	return bytes;
}
function elf(machine) {
	const bytes = Buffer.alloc(64);
	bytes.writeUInt32BE(0x7f454c46, 0);
	bytes[5] = 1;
	bytes.writeUInt16LE(machine, 18);
	return bytes;
}
function pe(machine) {
	const bytes = Buffer.alloc(256);
	bytes.writeUInt16LE(0x5a4d, 0);
	bytes.writeUInt32LE(128, 0x3c);
	bytes.writeUInt32LE(0x00004550, 128);
	bytes.writeUInt16LE(machine, 132);
	return bytes;
}
const napi = bytes => Buffer.concat([bytes, Buffer.from('\0_napi_register_module_v1\0')]);
const ARM64 = 0x0100000c;
const X64 = 0x01000007;

test('a native binary\'s own header names its OS and architecture, whatever the file is called', () => {
	assert.deepEqual(binaryTarget(machO(ARM64)), { os: 'darwin', archs: ['arm64'] });
	assert.deepEqual(binaryTarget(universal(X64, ARM64)), { os: 'darwin', archs: ['x64', 'arm64'] });
	assert.deepEqual(binaryTarget(elf(0xb7)), { os: 'linux', archs: ['arm64'] });
	assert.deepEqual(binaryTarget(pe(0x8664)), { os: 'win32', archs: ['x64'] });
	assert.equal(binaryTarget(Buffer.from('#!/bin/sh\necho no binary\n')), undefined);
});

test('a package is made for this host\'s target alone: another, or one with no native extensions, is refused before anything is built', () => {
	assert.equal(packageTarget(undefined, 'darwin-arm64'), 'darwin-arm64');
	assert.equal(packageTarget('linux-x64', 'linux-x64'), 'linux-x64');
	assert.throws(() => packageTarget('linux-x64', 'darwin-arm64'), /verifies darwin-arm64 alone: a linux-x64 package needs its own build on linux-x64/);
	assert.throws(() => packageTarget('darwin-x64', 'darwin-arm64'), /needs its own build/);
	for (const target of ['web', 'universal', 'darwin', 'freebsd-x64']) {
		assert.throws(() => packageTarget(target, target), /no target VS Code installs a native extension for/, target);
	}
	assert.equal(packageTarget(undefined), hostTarget());
});

test('binaries of another target, addons bound to one runtime\'s ABI, or no binary at all are refused', () => {
	const ours = [{ name: 'prebuilds/darwin-arm64/pty.node', bytes: napi(machO(ARM64)) }, { name: 'prebuilds/darwin-arm64/spawn-helper', bytes: machO(ARM64) }, { name: 'lib/index.js', bytes: Buffer.from('module.exports = {};') }];
	assert.deepEqual(nativeProblems(ours, 'darwin-arm64'), []);
	assert.match(nativeProblems(ours, 'darwin-x64').join('\n'), /pty\.node is built for darwin-arm64, not darwin-x64/);
	// Named as this host's, built for another: the header decides
	assert.match(nativeProblems([{ name: 'prebuilds/darwin-arm64/spawn-helper', bytes: elf(0x3e) }], 'darwin-arm64').join(), /built for linux-x64, not darwin-arm64/);
	assert.match(nativeProblems([{ name: 'prebuilds/win32-arm64/pty.node', bytes: napi(pe(0x8664)) }], 'win32-arm64').join(), /built for win32-x64/);
	assert.match(nativeProblems([{ name: 'pty.node', bytes: machO(ARM64) }], 'darwin-arm64').join(), /no Node-API addon/);
	assert.match(nativeProblems([{ name: 'lib/index.js', bytes: Buffer.from('x') }], 'darwin-arm64').join(), /no native binary for darwin-arm64/);
	// A universal binary runs on each of its slices
	assert.deepEqual(nativeProblems([{ name: 'pty.node', bytes: napi(universal(X64, ARM64)) }], 'darwin-x64'), []);
	// A musl build is ELF as a glibc one is
	assert.deepEqual(nativeProblems([{ name: 'build/Release/pty.node', bytes: napi(elf(0xb7)) }], 'alpine-arm64'), []);
	// A package that ships none takes none
	assert.deepEqual(nativeProblems([{ name: 'dist/companion.js', bytes: Buffer.from('x') }], 'darwin-arm64', { none: true }), []);
	assert.match(nativeProblems(ours, 'darwin-arm64', { none: true }).join(), /in a package that ships none/);
});

test('the packaged workspace extension names this host\'s target and carries that target\'s binaries alone', () => {
	const out = path.join(root, 'build', 'vsix');
	const target = hostTarget();
	const { name, version } = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	const runtime = path.join(out, `${name}-${target}-${version}.vsix`);
	assert.ok(fs.existsSync(runtime), `npm run package makes ${path.basename(runtime)} before this check`);
	const identity = files => files.find(each => each.name === 'extension.vsixmanifest').bytes.toString('utf8').match(/<Identity\b[^>]*>/)[0];
	const runtimeFiles = filesOfZip(runtime);
	assert.match(identity(runtimeFiles), new RegExp(`\\bTargetPlatform="${target}"`));
	assert.deepEqual(nativeProblems(runtimeFiles, target), []);
	const binaries = runtimeFiles.filter(each => binaryTarget(each.bytes)).map(each => each.name);
	assert.ok(binaries.length && binaries.every(each => each.startsWith('extension/node_modules/node-pty/')), binaries.join(', '));
	for (const bundle of ['extension.js', 'ptyd.js']) {
		assert.ok(runtimeFiles.some(each => each.name === `extension/dist/${bundle}`), `The package carries dist/${bundle}`);
	}
});

test('the packaged window dependency runs locally, exports no API and contains no native backend or test driver', () => {
	const windowStage = path.join(root, 'build', 'window');
	const manifest = JSON.parse(fs.readFileSync(path.join(windowStage, 'package.json'), 'utf8'));
	const runtime = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
	assert.deepEqual(manifest.extensionKind, ['ui']);
	assert.equal(manifest.api, 'none');
	assert.equal(manifest.version, runtime.version);
	assert.ok(runtime.extensionPack.includes(`${manifest.publisher}.${manifest.name}`));
	assert.equal(runtime.extensionDependencies, undefined);
	assert.deepEqual(manifest.extensionPack, [`${runtime.publisher}.${runtime.name}`]);
	assert.equal(manifest.extensionDependencies, undefined);
	assert.equal(manifest.contributes, undefined);
	assert.equal(manifest.dependencies, undefined);
	const files = filesOfZip(path.join(root, 'build', 'vsix', `${manifest.name}-${manifest.version}.vsix`));
	assert.deepEqual(nativeProblems(files, hostTarget(), { none: true }), []);
	assert.ok(files.some(file => file.name === 'extension/dist/window.js'));
	assert.ok(!files.some(file => /(?:node_modules|test|fixture|probe)\//.test(file.name)));
	const identity = files.find(file => file.name === 'extension.vsixmanifest').bytes.toString('utf8');
	assert.ok(!/\bTargetPlatform=/.test(identity));
	for (const file of files.filter(file => /extension\/package\.nls(?:\.[^.]+)?\.json$/.test(file.name))) {
		const strings = JSON.parse(file.bytes.toString('utf8'));
		assert.ok(strings.windowDisplayName && strings.windowDescription, file.name);
	}
});
