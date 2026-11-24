// Framework's two programs for the extension (ARCHITECTURE-4.3): `facade` and `facade-mcp`, built in release mode for this host's
// target - on Linux for musl, so one file runs on every Linux - and copied into bin/, from where packaging and the integration
// build take them. A Windows package carries facade.exe and facade-mcp.exe, with ConPTY in bin/conpty/.
//
//   node scripts/framework.mjs [--target <rust target triple>]
//
// This file also holds what packaging checks about framework: that its version is the extension's, that the extension's copy of the
// protocol is framework's, and that a package carries the programs as it should.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binaryTarget } from './native.mjs';

const extension = path.join(import.meta.dirname, '..');
export const FRAMEWORK = path.join(extension, '..', 'framework');
export const BIN = path.join(extension, 'bin');
export const FRAMEWORK_BUILD_FILE = 'VERSION';
/** The programs, by the name each is run by; the Cargo package that builds each is named beside it. */
export const PROGRAMS = { facade: 'facade', 'facade-mcp': 'facade-relay' };

export function parseFrameworkBuild(build) {
	const match = /^([0-9]+\.[0-9]+\.[0-9]+)(?:\+([0-9]+)\.([0-9a-f]{40}))?$/.exec(build);
	if (match && match[0] === build) {
		return { version: match[1], time: match[2], revision: match[3] };
	}
}

export function sourceBuild(version, revision = 'HEAD') {
	const stamp = execFileSync('git', ['log', '--no-walk', '--format=%ct.%H', revision + '^{commit}', '--'], {
		cwd: FRAMEWORK, encoding: 'utf8',
	}).trim();
	const build = `${version}+${stamp}`;
	assert.ok(parseFrameworkBuild(build)?.revision, 'Invalid source build ' + build);
	return build;
}

export function executableBuild(program) {
	const output = execFileSync(program, ['--version'], { encoding: 'utf8' });
	const build = /^facade (.+)\r?\n$/.exec(output)?.[1];
	assert.ok(parseFrameworkBuild(build), `${program} did not report a valid Facade build`);
	return build;
}

/** The Rust target framework is built for on this host, or none for an unsupported host. */
export function frameworkTriple(platform = process.platform, arch = process.arch) {
	const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
	if (!cpu) {
		return undefined;
	}
	return { darwin: `${cpu}-apple-darwin`, linux: `${cpu}-unknown-linux-musl`, win32: `${cpu}-pc-windows-msvc` }[platform];
}

/** Builds framework's release for `triple` and puts its programs and, on Windows, ConPTY in bin/. */
export function buildFramework(triple = frameworkTriple()) {
	if (!triple) {
		throw new Error(`Framework is built for macOS, Windows and Linux on x64 and arm64, not for ${process.platform}-${process.arch}.`);
	}
	const version = workspaceVersion(fs.readFileSync(path.join(FRAMEWORK, 'Cargo.toml'), 'utf8'));
	const build = sourceBuild(version);
	execFileSync('cargo', ['build', '--release', '--locked', '--target', triple, ...Object.values(PROGRAMS).flatMap(name => ['-p', name])], {
		cwd: FRAMEWORK, stdio: 'inherit', env: { ...process.env, FACADE_BUILD: build.slice(version.length + 1) },
	});
	const built = path.join(path.resolve(FRAMEWORK, process.env.CARGO_TARGET_DIR ?? 'target'), triple, 'release');
	fs.rmSync(BIN, { recursive: true, force: true });
	fs.mkdirSync(BIN, { recursive: true });
	const windows = triple.endsWith('-windows-msvc');
	for (const program of Object.keys(PROGRAMS)) {
		const file = windows ? `${program}.exe` : program;
		fs.copyFileSync(path.join(built, file), path.join(BIN, file));
		if (!windows) {
			fs.chmodSync(path.join(BIN, file), 0o755);
		}
	}
	if (windows) {
		fs.mkdirSync(path.join(BIN, 'conpty'));
		for (const file of ['conpty.dll', 'OpenConsole.exe']) {
			fs.copyFileSync(path.join(built, 'conpty', file), path.join(BIN, 'conpty', file));
		}
	}
	fs.writeFileSync(path.join(BIN, FRAMEWORK_BUILD_FILE), build + '\n');
	console.info(`Framework ${build}: ${Object.keys(PROGRAMS).join(', ')} for ${triple} in bin/.`);
	return build;
}

/** A Cargo.toml's `[workspace.package]` table up to its version's digits, with LF or CRLF line ends (Windows checkouts). */
const WORKSPACE_VERSION = /^(\[workspace\.package\]\r?\n(?:(?!\[).*\r?\n)*?version = ")([^"]+)/m;

/** The version of framework's workspace: the `version` of the `[workspace.package]` table of a Cargo.toml. */
export function workspaceVersion(cargoToml) {
	const version = cargoToml.match(WORKSPACE_VERSION)?.[2];
	if (!version) {
		throw new Error('framework/Cargo.toml has no workspace version.');
	}
	return version;
}

/** `cargoToml` with its workspace version `version`. */
export function withWorkspaceVersion(cargoToml, version) {
	workspaceVersion(cargoToml);
	return cargoToml.replace(WORKSPACE_VERSION, `$1${version}`);
}

/** Why the versions - each of `extension`, `window` and `framework` - are not one. */
export function versionProblems(versions) {
	const wanted = versions.extension;
	return Object.entries(versions).filter(([, version]) => version !== wanted).map(([who, version]) => `${who} is ${version}, the extension ${wanted}`);
}

/** Why the extension's copy of the protocol is not framework's. */
export function protocolProblems(copy, source) {
	return copy.equals(source) ? [] : ['src/base/frameworkProtocol.ts is not a copy of framework/protocol/protocol.ts: copy framework\'s file over it'];
}

/** What packaging refuses in this checkout: another version for framework than for the extension, another protocol than framework's. */
export function checkSources() {
	const read = (...parts) => fs.readFileSync(path.join(extension, ...parts));
	const problems = [
		...versionProblems({
			extension: JSON.parse(read('package.json').toString()).version,
			window: JSON.parse(read('window', 'package.json').toString()).version,
			framework: workspaceVersion(read('..', 'framework', 'Cargo.toml').toString())
		}),
		...protocolProblems(read('src', 'base', 'frameworkProtocol.ts'), read('..', 'framework', 'protocol', 'protocol.ts'))
	];
	if (problems.length) {
		throw new Error(`Nothing is packaged: ${problems.join('; ')}.`);
	}
}

/** Whether an ELF64 little-endian file names a dynamic linker - a glibc one - where a musl build is a static one and names none. */
export function namesDynamicLinker(bytes) {
	if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) {
		return false;
	}
	const headers = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
	for (let each = 0; each < count; each++) {
		if (bytes.readUInt32LE(headers + each * size) === 3) {
			return true;
		}
	}
	return false;
}

/** The mode of each file of the ZIP archive at `file`, by name: what its central directory says. */
export function zipModes(file) {
	const zip = fs.readFileSync(file);
	let end = zip.length - 22;
	while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) {
		end--;
	}
	const modes = new Map();
	let at = zip.readUInt32LE(end + 16);
	for (let left = zip.readUInt16LE(end + 10); left > 0; left--) {
		const nameLength = zip.readUInt16LE(at + 28);
		modes.set(zip.toString('utf8', at + 46, at + 46 + nameLength), zip.readUInt32LE(at + 38) >>> 16);
		at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return modes;
}

/**
 * Why `files` - a package's `{ name, bytes }` each, in `modes` by name - carry framework's programs wrongly for `target`: a
 * program or ConPTY file missing, no binary, on Unix not executable, or on Linux not a static one. No problems, none returned.
 * Whose OS and architecture a binary is of is `nativeProblems`'.
 */
export function programProblems(files, target, modes) {
	const inBin = files.filter(file => file.name.startsWith('extension/bin/'));
	const windows = target.startsWith('win32-');
	const required = windows ? ['facade.exe', 'facade-mcp.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'] : Object.keys(PROGRAMS);
	const problems = [];
	for (const program of required) {
		const file = inBin.find(each => each.name === `extension/bin/${program}`);
		if (!file) {
			problems.push(`bin/${program} is not in the package`);
		} else if (!binaryTarget(file.bytes)) {
			problems.push(`bin/${program} is no program`);
		} else if (!windows && !((modes.get(file.name) ?? 0) & 0o100)) {
			problems.push(`bin/${program} is not executable`);
		} else if (target.startsWith('linux-') && namesDynamicLinker(file.bytes)) {
			problems.push(`bin/${program} is not a static musl build: it names a dynamic linker`);
		}
	}
	return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const at = process.argv.indexOf('--target');
	buildFramework(at < 0 ? undefined : process.argv[at + 1]);
}
