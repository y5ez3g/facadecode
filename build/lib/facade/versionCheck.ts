/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';

/**
 * After a build, every version field of every artifact read back and held against IDENTITY.md I7's
 * table: the release version where a person or a package manager reads one, the engine version where
 * extensions are checked against it. Reading back, rather than trusting the stamping, catches whatever a
 * later step wrote over. A new package or platform is one new reader here and one call where it is made.
 */
export interface IVersionField {
	readonly artifact: string;
	readonly field: string;
	/** `undefined`: the field is not there. */
	readonly found: string | undefined;
	readonly expected: string;
}

/**
 * Fails, naming every field that does not say what it must. Windows writes four numbers where the
 * version has three, `0.1.0.0` for `0.1.0`, and Inno Setup pads its installer's strings with spaces.
 */
export function checkVersionFields(fields: readonly IVersionField[]): void {
	const same = (found: string, expected: string) => found.trim().replace(/^(\d+\.\d+\.\d+)\.0$/, '$1') === expected;
	const wrong = fields.filter(field => field.found === undefined || !same(field.found, field.expected));
	if (wrong.length) {
		throw new Error([
			'The version check failed (IDENTITY.md I7):',
			...wrong.map(field => `  ${field.artifact}: ${field.field} is ${field.found === undefined ? 'missing' : JSON.stringify(field.found)}, not ${field.expected}`)
		].join('\n'));
	}
}

/**
 * The packaged app's own record of both versions: `product.json`'s `facadeVersion`, which the app shows,
 * and its `version` and `package.json`'s, which extensions are checked against.
 */
export function appVersionFields(appRoot: string, release: string, engine: string): IVersionField[] {
	const product = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
	const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
	return [
		{ artifact: 'product.json', field: 'facadeVersion', found: product.facadeVersion, expected: release },
		{ artifact: 'product.json', field: 'version', found: product.version, expected: engine },
		{ artifact: 'package.json', field: 'version', found: packageJson.version, expected: engine },
	];
}

/**
 * The server package's own record of the build (REMOTE.md R6): the release version the download
 * address names, the engine version the handshake checks, and the commit, which must be the
 * desktop package's - a remote refuses a server of another commit.
 */
export function serverVersionFields(serverDir: string, release: string, engine: string, commit: string): IVersionField[] {
	const product = JSON.parse(fs.readFileSync(path.join(serverDir, 'product.json'), 'utf8'));
	const packageJson = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
	return [
		{ artifact: 'product.json', field: 'release', found: product.release, expected: release },
		{ artifact: 'product.json', field: 'facadeVersion', found: product.facadeVersion, expected: release },
		{ artifact: 'product.json', field: 'version', found: product.version, expected: engine },
		{ artifact: 'product.json', field: 'commit', found: product.commit, expected: commit },
		{ artifact: 'package.json', field: 'version', found: packageJson.version, expected: engine },
	];
}

/** A Windows executable's version fields, which Explorer's Details tab and Apps & features read. */
export function executableVersionFields(file: string, release: string): IVersionField[] {
	const version = readExecutableVersion(fs.readFileSync(file));
	const artifact = path.basename(file);
	return [
		{ artifact, field: 'FILEVERSION', found: version?.fileVersion, expected: release },
		{ artifact, field: 'PRODUCTVERSION', found: version?.productVersion, expected: release },
		{ artifact, field: 'FileVersion', found: version?.strings.FileVersion, expected: release },
		{ artifact, field: 'ProductVersion', found: version?.strings.ProductVersion, expected: release },
	];
}

/** A macOS bundle's version keys, which Finder and About This Mac read. */
export function bundleVersionFields(infoPlist: string, release: string): IVersionField[] {
	const plist = fs.readFileSync(infoPlist, 'utf8');
	return ['CFBundleShortVersionString', 'CFBundleVersion'].map(field => ({
		artifact: 'Info.plist',
		field,
		found: new RegExp(`<key>${field}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1],
		expected: release
	}));
}

/** The Debian package's version, which `apt show` reads and upgrades by: the release version, then the package revision. */
export function debianVersionFields(control: string, release: string): IVersionField[] {
	const version = /^Version:\s*(\S+)\s*$/m.exec(fs.readFileSync(control, 'utf8'))?.[1];
	return [{ artifact: 'DEBIAN/control', field: 'Version', found: version?.replace(/-[^-]*$/, ''), expected: release }];
}

export interface IExecutableVersion {
	/** The fixed `FILEVERSION`, four numbers. */
	readonly fileVersion: string;
	/** The fixed `PRODUCTVERSION`, four numbers. */
	readonly productVersion: string;
	/** The first string table: `FileVersion`, `ProductVersion`, `ProductName` and the rest. */
	readonly strings: Readonly<Record<string, string>>;
}

/**
 * The version resource of a Windows executable (PE) image, or `undefined` when it has none: the
 * resource tree's `RT_VERSION` entry, a `VS_VERSIONINFO` block of the fixed versions and the string tables.
 */
export function readExecutableVersion(image: Buffer): IExecutableVersion | undefined {
	if (image.length < 0x40 || image.readUInt16LE(0) !== 0x5a4d /* MZ */) {
		return undefined;
	}
	const header = image.readUInt32LE(0x3c);
	if (image.readUInt32LE(header) !== 0x4550 /* PE\0\0 */) {
		return undefined;
	}
	const sectionCount = image.readUInt16LE(header + 6);
	const optionalHeader = header + 24;
	const sections = optionalHeader + image.readUInt16LE(header + 20);
	const dataDirectories = optionalHeader + (image.readUInt16LE(optionalHeader) === 0x20b /* PE32+ */ ? 112 : 96);
	const offsetOf = (rva: number): number | undefined => {
		for (let i = 0; i < sectionCount; i++) {
			const section = sections + i * 40;
			const start = image.readUInt32LE(section + 12);
			if (rva >= start && rva < start + Math.max(image.readUInt32LE(section + 8), image.readUInt32LE(section + 16))) {
				return rva - start + image.readUInt32LE(section + 20);
			}
		}
		return undefined;
	};

	// The resource tree: types, then names, then languages; the version is type 16, whatever its name or language
	const resources = offsetOf(image.readUInt32LE(dataDirectories + 2 * 8));
	if (resources === undefined) {
		return undefined;
	}
	const entryOf = (directory: number, id?: number): number | undefined => {
		const count = image.readUInt16LE(directory + 12) + image.readUInt16LE(directory + 14);
		for (let i = 0; i < count; i++) {
			const entry = directory + 16 + i * 8;
			if (id === undefined || image.readUInt32LE(entry) === id) {
				return image.readUInt32LE(entry + 4);
			}
		}
		return undefined;
	};
	let entry = entryOf(resources, 16);
	for (let level = 0; level < 2 && entry !== undefined; level++) {
		entry = entry & 0x80000000 ? entryOf(resources + (entry & 0x7fffffff)) : undefined;
	}
	if (entry === undefined || entry & 0x80000000) {
		return undefined;
	}
	const start = offsetOf(image.readUInt32LE(resources + entry));
	if (start === undefined) {
		return undefined;
	}

	// Every block is a length, a value length, a type, a key, then its value and its children, each on a 4-byte boundary
	interface IBlock { readonly key: string; readonly value: number; readonly valueEnd: number; readonly children: IBlock[] }
	const align = (offset: number) => start + ((offset - start + 3) & ~3);
	const readText = (from: number, to: number) => {
		let text = '';
		for (let at = from; at + 1 < to; at += 2) {
			const char = image.readUInt16LE(at);
			if (!char) {
				break;
			}
			text += String.fromCharCode(char);
		}
		return text;
	};
	const readBlock = (at: number): IBlock => {
		const end = at + image.readUInt16LE(at);
		const valueLength = image.readUInt16LE(at + 2);
		const key = readText(at + 6, end);
		const value = align(at + 6 + (key.length + 1) * 2);
		const valueEnd = value + (image.readUInt16LE(at + 4) === 1 /* text, counted in characters */ ? valueLength * 2 : valueLength);
		const children: IBlock[] = [];
		for (let child = align(valueEnd); child + 6 <= end && image.readUInt16LE(child); child = align(child + image.readUInt16LE(child))) {
			children.push(readBlock(child));
		}
		return { key, value, valueEnd, children };
	};

	const info = readBlock(start);
	if (info.key !== 'VS_VERSION_INFO' || info.valueEnd - info.value < 24 || image.readUInt32LE(info.value) !== 0xfeef04bd) {
		return undefined;
	}
	const fixed = (at: number) => {
		const high = image.readUInt32LE(at), low = image.readUInt32LE(at + 4);
		return `${high >>> 16}.${high & 0xffff}.${low >>> 16}.${low & 0xffff}`;
	};
	const strings: Record<string, string> = {};
	for (const field of info.children.find(child => child.key === 'StringFileInfo')?.children[0]?.children ?? []) {
		strings[field.key] = readText(field.value, field.valueEnd);
	}
	return { fileVersion: fixed(info.value + 8), productVersion: fixed(info.value + 16), strings };
}
