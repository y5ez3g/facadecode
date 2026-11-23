// Pack the programs from a native VSIX, or from a local release build for offline installation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE, CORE_BUILD_FILE, executableBuild, parseCoreBuild, workspaceVersion } from '../../extension/scripts/core.mjs';
import { filesOfZip } from '../../extension/scripts/native.mjs';

export const coreArchive = target => 'facade-core-' + target + (target.startsWith('win32-') ? '.zip' : '.tar.gz');
export const coreVersionFile = 'facade-core-version.txt';
export const coreInstallers = ['install.sh', 'install.ps1'];
export const corePrograms = target => target.startsWith('win32-')
	? ['facade.exe', 'facade-mcp.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
	: ['facade', 'facade-mcp'];

export function verifyArchivePair(archive, vsix, target) {
	const editor = new Map(filesOfZip(vsix).map(file => [file.name, file.bytes]));
	const zip = target.startsWith('win32-') ? new Map(filesOfZip(archive).map(file => [file.name, file.bytes])) : null;
	const member = name => zip ? zip.get(name)
		: execFileSync('tar', ['-xOf', archive, name], { maxBuffer: 64 * 1024 * 1024 });
	for (const program of corePrograms(target)) {
		const expected = editor.get('extension/bin/' + program);
		assert.ok(expected && member(program)?.equals(expected), program + ' differs from the paired VSIX');
	}
	const marker = editor.get('extension/bin/' + CORE_BUILD_FILE);
	assert.ok(marker && member(CORE_BUILD_FILE)?.equals(marker), 'Core archive BUILD differs from the paired VSIX');
	return marker.toString('utf8');
}

function packageCore(target, vsix, binDir, output) {
	const windows = target.startsWith('win32-');
	const programs = corePrograms(target);
	const version = workspaceVersion(fs.readFileSync(path.join(CORE, 'Cargo.toml'), 'utf8'));
	let packaged;
	let marker;
	if (vsix) {
		packaged = new Map(filesOfZip(vsix).map(file => [file.name, file.bytes]));
		const manifest = JSON.parse(packaged.get('extension/package.json').toString());
		assert.equal(manifest.version, version, 'VSIX and core have different versions');
		assert.ok(packaged.get('extension.vsixmanifest').includes('TargetPlatform="' + target + '"'), 'VSIX has a different platform');
		marker = packaged.get('extension/bin/' + CORE_BUILD_FILE)?.toString('utf8');
		assert.ok(parseCoreBuild(marker?.trimEnd())?.revision, 'VSIX has no source-stamped BUILD');
	} else {
		const file = path.join(binDir, CORE_BUILD_FILE);
		if (fs.existsSync(file)) marker = fs.readFileSync(file, 'utf8');
	}
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-core-'));
	try {
		for (const name of programs) {
			const bytes = packaged ? packaged.get('extension/bin/' + name) : fs.readFileSync(path.join(binDir, name));
			assert.ok(bytes?.length, 'Missing core program ' + name);
			const destination = path.join(stage, name);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.writeFileSync(destination, bytes, { mode: 0o755 });
		}
		const reported = target === `${process.platform}-${process.arch}`
			? executableBuild(path.join(stage, programs[0])) : undefined;
		const build = marker?.trimEnd() ?? reported;
		assert.equal(parseCoreBuild(build)?.version, version, 'Package BUILD differs from the workspace version');
		if (marker !== undefined) assert.equal(marker, build + '\n', 'Invalid BUILD marker');
		if (reported !== undefined) assert.equal(reported, build, 'The packaged executable reports a different BUILD');
		fs.writeFileSync(path.join(stage, CORE_BUILD_FILE), build + '\n');
		fs.copyFileSync(path.join(CORE, '..', 'LICENSE.txt'), path.join(stage, 'LICENSE.txt'));
		if (windows) {
			const vendor = path.join(CORE, 'vendor', 'conpty');
			const [conpty] = fs.readdirSync(vendor);
			fs.copyFileSync(path.join(vendor, conpty, 'LICENSE'), path.join(stage, 'conpty', 'LICENSE'));
		}
		fs.mkdirSync(output, { recursive: true });
		const archive = coreArchive(target);
		const destination = path.join(output, archive);
		const entries = windows ? ['facade.exe', 'facade-mcp.exe', 'conpty'] : programs;
		const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
		execFileSync(tar, [windows ? '-acf' : '-czf', destination, '-C', stage, ...entries, CORE_BUILD_FILE, 'LICENSE.txt'], { stdio: 'inherit' });
		const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
		fs.writeFileSync(path.join(output, 'SHA256SUMS'), digest + '  ' + archive + '\n');
		console.log('Packed Facade ' + build + ' in ' + destination);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}

function main(args) {
	const options = new Map();
	while (args.length) {
		const key = args.shift();
		const value = args.shift();
		assert.ok(['--target', '--vsix', '--bin-dir', '--out-dir'].includes(key) && value && !options.has(key), 'Invalid packaging option ' + key);
		options.set(key, value);
	}
	const target = options.get('--target');
	const vsix = options.get('--vsix');
	const binDir = options.get('--bin-dir');
	const output = options.get('--out-dir');
	assert.ok(/^(linux|darwin|win32)-(x64|arm64)$/.test(target) && !!vsix !== !!binDir && output,
		'Usage: package-core.mjs --target TARGET (--vsix FILE | --bin-dir DIRECTORY) --out-dir DIRECTORY');
	packageCore(target, vsix, binDir, path.resolve(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try { main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
