/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The product's two versions (IDENTITY.md I7): the release version, `facadeVersion`, on every package,
 * and the engine version, upstream's, where extensions are checked against it.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suite, test } from 'node:test';
import { releaseVersion, withBundleVersion } from '../facade/releaseVersion.ts';
import { appVersionFields, bundleVersionFields, checkVersionFields, debianVersionFields, executableVersionFields, readExecutableVersion } from '../facade/versionCheck.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

suite('Facade version', () => {

	test('ID-18 the release version is written once, in product.json, and the engine version stays upstream\'s', () => {
		const product = JSON.parse(read('product.json'));
		const packageJson = JSON.parse(read('package.json'));

		assert.deepStrictEqual({
			release: releaseVersion(product),
			engine: packageJson.version,
			notTheEngine: product.facadeVersion !== packageJson.version,
			// only `releaseVersion` reads it in the build
			readers: ['build/gulpfile.vscode.ts', 'build/gulpfile.vscode.win32.ts', 'build/gulpfile.vscode.linux.ts'].filter(file => /facadeVersion/.test(read(file)))
		}, { release: '0.1.1', engine: '1.138.0', notTheEngine: true, readers: [] });
	});

	test('ID-18 a product.json without a release version stops the build rather than stamping the engine\'s', () => {
		assert.deepStrictEqual(
			[{}, { facadeVersion: '' }, { facadeVersion: '1.0' }, { facadeVersion: 1 }, { facadeVersion: '0.1.0-beta' }].map(product => {
				try {
					return releaseVersion(product);
				} catch {
					return 'stopped';
				}
			}),
			['stopped', 'stopped', 'stopped', 'stopped', 'stopped']);
	});

	test('ID-18 every package is stamped with the release version: the installer, the executables, the bundle, the Debian package', () => {
		const desktop = read('build/gulpfile.vscode.ts');
		const installer = read('build/gulpfile.vscode.win32.ts');
		const linux = read('build/gulpfile.vscode.linux.ts');

		assert.deepStrictEqual({
			installer: installer.includes('Version: releaseVersion(product),') && installer.includes('RawVersion: releaseVersion(product),'),
			executables: desktop.includes(`'file-version': version,`) && desktop.includes(`'product-version': version,`) && desktop.includes(`'FileVersion': version,`) && desktop.includes(`'ProductVersion': version,`),
			mainExecutable: /async function win32OwnExecutables\(cwd: string\): Promise<string\[\]> \{\s*return \[\s*`\$\{product\.nameShort\}\.exe`,/.test(desktop),
			bundle: desktop.includes('packageTasks.push(stampDarwinReleaseVersionTask(destinationFolderName));'),
			debian: linux.includes(`replace('@@VERSION@@', releaseVersion(product) + '-' + linuxPackageRevision)`)
		}, { installer: true, executables: true, mainExecutable: true, bundle: true, debian: true });
	});

	test('ID-18 each package is read back after everything that writes a version: the folder, the installer, the Debian package', () => {
		const desktop = read('build/gulpfile.vscode.ts');
		const installer = read('build/gulpfile.vscode.win32.ts');
		const linux = read('build/gulpfile.vscode.linux.ts');

		assert.deepStrictEqual({
			// last of the packaging steps, on every platform, over the same executables as were stamped
			folder: /packageTasks\.push\(checkReleaseVersionTask\(platform, destinationFolderName\)\);\s*const vscodeTaskCI/.test(desktop),
			sameExecutables: (desktop.match(/await win32OwnExecutables\(cwd\)/g) ?? []).length,
			installer: installer.includes('task.series(cleanTask, buildWin32Setup(arch, target), checkWin32SetupReleaseVersion(arch, target))'),
			debian: linux.includes('task.series(checkDebReleaseVersion(arch), buildDebPackage(arch))')
		}, { folder: true, sameExecutables: 2, installer: true, debian: true });
	});

	test('ID-18 an executable\'s version is read where Windows reads it, the fixed numbers and the strings', () => {
		// the two fixed numbers told apart: a stamped one has the same in both
		const stamped = readExecutableVersion(executable({ file: [0, 1, 0, 0], product: [0, 1, 2, 3] }, { FileVersion: '0.1.0', ProductVersion: '0.1.0', ProductName: 'Facade Code' }));

		assert.deepStrictEqual({
			stamped: stamped && { fileVersion: stamped.fileVersion, productVersion: stamped.productVersion, strings: stamped.strings },
			// no version resource, and not an executable at all
			bare: readExecutableVersion(executable(undefined, {})),
			text: readExecutableVersion(Buffer.from('#!/bin/sh\n'.repeat(10)))
		}, {
			stamped: { fileVersion: '0.1.0.0', productVersion: '0.1.2.3', strings: { FileVersion: '0.1.0', ProductVersion: '0.1.0', ProductName: 'Facade Code' } },
			bare: undefined,
			text: undefined
		});
	});

	test('ID-18 the check fails the build naming every wrong field, and takes Windows\' four numbers and Inno Setup\'s padding for the version', () => {
		const fields = [
			{ artifact: 'Facade Code.exe', field: 'FILEVERSION', found: '0.1.0.0', expected: '0.1.0' },
			{ artifact: 'facade-setup.exe', field: 'ProductVersion', found: '0.1.0             ', expected: '0.1.0' },
			{ artifact: 'spdlog.node', field: 'PRODUCTVERSION', found: '0.0.0.0', expected: '0.1.0' },
			{ artifact: 'rg.exe', field: 'FileVersion', found: undefined, expected: '0.1.0' },
			{ artifact: 'product.json', field: 'version', found: '1.138.0', expected: '1.138.0' },
			{ artifact: 'Info.plist', field: 'CFBundleVersion', found: '1.138.0', expected: '0.1.0' },
		];

		assert.doesNotThrow(() => checkVersionFields([...fields.slice(0, 2), fields[4]]));
		assert.throws(() => checkVersionFields(fields), (error: Error) => {
			assert.deepStrictEqual(error.message.split('\n').slice(1), [
				'  spdlog.node: PRODUCTVERSION is "0.0.0.0", not 0.1.0',
				'  rg.exe: FileVersion is missing, not 0.1.0',
				'  Info.plist: CFBundleVersion is "1.138.0", not 0.1.0',
			]);
			return true;
		});
	});

	test('ID-18 the app\'s own record, the bundle and the Debian package are read back as written', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-version-'));
		try {
			fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ facadeVersion: '0.1.0', version: '1.138.0' }));
			fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.138.0' }));
			fs.writeFileSync(path.join(dir, 'Info.plist'), '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.1.0</string>\n\t<key>CFBundleVersion</key>\n\t<string>1.138.0</string>\n</dict>');
			fs.writeFileSync(path.join(dir, 'control'), 'Package: facade\nVersion: 0.1.0-1760000000\nArchitecture: amd64\n');

			assert.deepStrictEqual([
				...appVersionFields(dir, '0.1.0', '1.138.0'),
				...bundleVersionFields(path.join(dir, 'Info.plist'), '0.1.0'),
				...debianVersionFields(path.join(dir, 'control'), '0.1.0'),
			].map(field => `${field.artifact} ${field.field} ${field.found}`), [
				'product.json facadeVersion 0.1.0',
				'product.json version 1.138.0',
				'package.json version 1.138.0',
				'Info.plist CFBundleShortVersionString 0.1.0',
				'Info.plist CFBundleVersion 1.138.0',
				'DEBIAN/control Version 0.1.0',
			]);
			assert.deepStrictEqual(executableVersionFields(path.join(dir, 'control'), '0.1.0').map(field => field.found), [undefined, undefined, undefined, undefined]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('ID-18 the bundle says the release version where Finder reads one, and nothing else of it changes', () => {
		const plist = [
			'<dict>',
			'\t<key>CFBundleName</key>',
			'\t<string>Facade Code</string>',
			'\t<key>CFBundleShortVersionString</key>',
			'\t<string>1.138.0</string>',
			'\t<key>CFBundleVersion</key>',
			'\t<string>1.138.0</string>',
			'</dict>'
		].join('\n');

		assert.deepStrictEqual(withBundleVersion(plist, '0.1.0'), plist.replace(/1\.138\.0/g, '0.1.0'));
		assert.throws(() => withBundleVersion('<dict></dict>', '0.1.0'), /CFBundleShortVersionString/);
	});
});

/**
 * A PE32+ image whose one resource is a version, laid out as Windows reads it: the resource tree
 * (type 16, a name, a language) to a `VS_VERSIONINFO` of the fixed numbers and one string table.
 * Without `fixed`, an image with no resources.
 */
function executable(fixed: { readonly file: readonly number[]; readonly product: readonly number[] } | undefined, strings: Readonly<Record<string, string>>): Buffer {
	const text = (value: string) => Buffer.from(value + '\0', 'utf16le');
	const aligned = (buffer: Buffer) => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4)]);
	const block = (key: string, type: number, value: Buffer, valueLength: number, children: Buffer[] = []) => {
		const body = Buffer.concat([aligned(Buffer.concat([Buffer.alloc(6), text(key)])), children.length ? aligned(value) : value, ...children.map((child, i) => i < children.length - 1 ? aligned(child) : child)]);
		body.writeUInt16LE(body.length, 0);
		body.writeUInt16LE(valueLength, 2);
		body.writeUInt16LE(type, 4);
		return body;
	};

	let section = Buffer.alloc(0);
	if (fixed) {
		const numbers = Buffer.alloc(52);
		numbers.writeUInt32LE(0xfeef04bd, 0);
		numbers.writeUInt32LE(0x10000, 4);
		[...fixed.file, ...fixed.product].forEach((part, i) => numbers.writeUInt16LE(part, 8 + Math.floor(i / 2) * 4 + (i % 2 ? 0 : 2)));
		const table = block('040904b0', 1, Buffer.alloc(0), 0, Object.entries(strings).map(([key, value]) => block(key, 1, text(value), value.length + 1)));
		const info = block('VS_VERSION_INFO', 0, numbers, numbers.length, [block('StringFileInfo', 1, Buffer.alloc(0), 0, [table])]);

		const directory = (id: number, offset: number) => {
			const entry = Buffer.alloc(24);
			entry.writeUInt16LE(1, 14);
			entry.writeUInt32LE(id, 16);
			entry.writeUInt32LE(offset >>> 0, 20);
			return entry;
		};
		const data = Buffer.alloc(16);
		data.writeUInt32LE(0x1000 + 88, 0);
		data.writeUInt32LE(info.length, 4);
		section = Buffer.concat([directory(16, 0x80000000 | 24), directory(1, 0x80000000 | 48), directory(0x409, 72), data, info]);
	}

	const image = Buffer.alloc(0x200 + section.length);
	image.write('MZ', 0, 'latin1');
	image.writeUInt32LE(0x40, 0x3c);
	image.writeUInt32LE(0x4550, 0x40);
	image.writeUInt16LE(0x8664, 0x44);
	image.writeUInt16LE(1, 0x46);
	image.writeUInt16LE(240, 0x54);
	image.writeUInt16LE(0x20b, 0x58);
	if (fixed) {
		image.writeUInt32LE(0x1000, 0x58 + 112 + 16);
		image.writeUInt32LE(section.length, 0x58 + 112 + 20);
	}
	image.write('.rsrc', 0x148, 'latin1');
	image.writeUInt32LE(section.length, 0x148 + 8);
	image.writeUInt32LE(0x1000, 0x148 + 12);
	image.writeUInt32LE(section.length, 0x148 + 16);
	image.writeUInt32LE(0x200, 0x148 + 20);
	section.copy(image, 0x200);
	return image;
}
