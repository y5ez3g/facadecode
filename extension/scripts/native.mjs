// The native backend's target (ARCHITECTURE-4.3; D29): VS Code's name for the OS and architecture a package's native artifacts
// run on, read from the artifacts' own headers - never from their file names - and only ever this host's, where a build loads them
// and starts a PTY with them. A VSIX names that target; one whose artifacts are of another, or whose addons are bound to one
// runtime's ABI rather than Node-API, is refused.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** The targets VS Code installs a platform-specific extension for, but `web`: a native backend runs on none of it. */
export const NATIVE_TARGETS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armhf', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64'];

/** This host's target as VS Code names it: musl Linux is `alpine`, 32-bit ARM `armhf`. */
export function hostTarget() {
	const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
	return `${musl ? 'alpine' : process.platform}-${process.arch === 'arm' ? 'armhf' : process.arch}`;
}

/**
 * The target a package is made for: `asked`, or this host's - and only ever this host's, as a build here verifies this host's
 * artifacts alone; another target needs its own build there. Throws, saying why, for any other.
 */
export function packageTarget(asked, host = hostTarget()) {
	const target = asked ?? host;
	if (!NATIVE_TARGETS.includes(target)) {
		throw new Error(`${target} is no target VS Code installs a native extension for (${NATIVE_TARGETS.join(', ')}).`);
	}
	if (target !== host) {
		throw new Error(`This host builds and verifies ${host} alone: a ${target} package needs its own build on ${target}.`);
	}
	return target;
}

const MACHO = { 0x0100000c: 'arm64', 0x01000007: 'x64' };
const ELF = { 0x3e: 'x64', 0xb7: 'arm64', 0x28: 'armhf' };
const PE = { 0x8664: 'x64', 0xaa64: 'arm64' };

/** What a binary is built for, read from its header - its OS family and architectures - or none where it is no executable or library. */
export function binaryTarget(bytes) {
	if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
		return { os: 'darwin', archs: [MACHO[bytes.readUInt32LE(4)] ?? 'unknown'] };
	}
	if (bytes.length >= 8 && (bytes.readUInt32BE(0) === 0xcafebabe || bytes.readUInt32BE(0) === 0xcafebabf)) {
		// A universal binary: each of its slices, 20 bytes apart, or 32 in the 64-bit form
		const stride = bytes.readUInt32BE(0) === 0xcafebabe ? 20 : 32;
		const archs = [];
		for (let at = 8; archs.length < bytes.readUInt32BE(4) && at + 4 <= bytes.length; at += stride) {
			archs.push(MACHO[bytes.readUInt32BE(at)] ?? 'unknown');
		}
		return { os: 'darwin', archs };
	}
	if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46) {
		return { os: 'linux', archs: [ELF[bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)] ?? 'unknown'] };
	}
	if (bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
		const at = bytes.readUInt32LE(0x3c);
		if (at + 6 <= bytes.length && bytes.readUInt32LE(at) === 0x00004550) {
			return { os: 'win32', archs: [PE[bytes.readUInt16LE(at + 4)] ?? 'unknown'] };
		}
	}
	return undefined;
}

/**
 * Why `files` - `{ name, bytes }` each - are no native backend for `target`: a binary built for another OS or architecture, an addon
 * bound to one runtime's ABI rather than Node-API, which the editor's runtime and this build's share. With `none`, any binary at all
 * is a problem; otherwise having none is. No problems, none returned.
 */
export function nativeProblems(files, target, { none = false } = {}) {
	const [platform, arch] = target.split('-');
	const problems = [];
	let found = 0;
	for (const { name, bytes } of files) {
		const built = binaryTarget(bytes);
		if (!built) {
			continue;
		}
		found++;
		if (none) {
			problems.push(`${name} is a native binary (${built.os}-${built.archs.join('+')}) in a package that ships none`);
		} else if (built.os !== (platform === 'alpine' ? 'linux' : platform) || !built.archs.includes(arch)) {
			problems.push(`${name} is built for ${built.os}-${built.archs.join('+')}, not ${target}`);
		} else if (name.endsWith('.node') && !bytes.includes('napi_register_module_v1')) {
			problems.push(`${name} is no Node-API addon: it is bound to one runtime's ABI`);
		}
	}
	if (!none && !found) {
		problems.push(`no native binary for ${target} is there at all`);
	}
	return problems;
}

/** Every file under `dir`, named by its path there with `/` between parts. */
export function filesUnder(dir) {
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => {
			const file = path.join(entry.parentPath, entry.name);
			return { name: path.relative(dir, file).split(path.sep).join('/'), bytes: fs.readFileSync(file) };
		});
}

/** Every file of the ZIP archive - a VSIX - at `file`, as it holds them: read from its central directory, stored or deflated. */
export function filesOfZip(file) {
	const zip = fs.readFileSync(file);
	let end = zip.length - 22;
	while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) {
		end--;
	}
	if (end < 0) {
		throw new Error(`${file} is no ZIP archive.`);
	}
	const files = [];
	let at = zip.readUInt32LE(end + 16);
	for (let left = zip.readUInt16LE(end + 10); left > 0; left--) {
		if (zip.readUInt32LE(at) !== 0x02014b50) {
			throw new Error(`${file} has a damaged central directory.`);
		}
		const method = zip.readUInt16LE(at + 10);
		const size = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
		if (size === 0xffffffff || local === 0xffffffff) {
			throw new Error(`${file} is a ZIP64 archive, which no VSIX of these needs.`);
		}
		if (method !== 0 && method !== 8) {
			throw new Error(`${name} in ${file} is compressed by method ${method}, which no VSIX of these uses.`);
		}
		const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const stored = zip.subarray(data, data + size);
		if (!name.endsWith('/')) {
			files.push({ name, bytes: method === 0 ? stored : zlib.inflateRawSync(stored) });
		}
		at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return files;
}
