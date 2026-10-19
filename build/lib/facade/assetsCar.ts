/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compiles the macOS application icon, `resources/darwin/code.icon`, into the asset catalog the
 * app bundle carries as `Contents/Resources/Assets.car`.
 *
 * macOS 26 and later draw an application icon from the asset catalog that `CFBundleIconName`
 * names, and fall back to the `.icns` only when there is none. Given an `.icns` alone they clip it
 * to their own rounded shape when it is an opaque square, and when it has a shape of its own - the
 * rounded body, margin and shadow the `.icns` needs for macOS 15 and earlier, which draw it as
 * given - they shrink it onto a grey plate. The catalog gives each its own picture: the full square
 * for macOS 26 to clip, and the flattened, rounded ones `actool` renders from it for earlier
 * systems. `code.icns` stays for the disk image and for anything that reads `CFBundleIconFile`.
 *
 * ⚠️ Run it after the application icon changes: `node build/lib/facade/assetsCar.ts`, on a Mac
 * with Xcode 26 or later. Nothing runs it during a build. The output is committed, the way
 * `code.icns` is, so a build needs neither Xcode nor a Mac to produce it.
 *
 * ⚠️ The icon's name in the catalog is the product's long name, because that is what
 * `@vscode/gulp-electron` writes into `CFBundleIconName`. `actool` names an icon after its
 * `.icon` folder, so the source is copied to a folder of that name before it is compiled.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.dirname(path.dirname(path.dirname(import.meta.dirname)));
const DARWIN = path.join(ROOT, 'resources', 'darwin');
const product = JSON.parse(fs.readFileSync(path.join(ROOT, 'product.json'), 'utf8'));

/** Electron's own `LSMinimumSystemVersion`: the oldest macOS the app opens on. */
const MINIMUM_SYSTEM_VERSION = '12.0';

function main(): void {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-assets-car-'));
	try {
		const iconName: string = product.nameLong;
		const source = path.join(work, `${iconName}.icon`);
		const output = path.join(work, 'out');
		fs.cpSync(path.join(DARWIN, 'code.icon'), source, { recursive: true });
		fs.mkdirSync(output);

		const result = spawnSync('xcrun', [
			'actool', source,
			'--compile', output,
			'--platform', 'macosx',
			'--target-device', 'mac',
			'--minimum-deployment-target', MINIMUM_SYSTEM_VERSION,
			'--app-icon', iconName,
			'--output-partial-info-plist', path.join(output, 'partial.plist'),
			'--output-format', 'human-readable-text',
		], { encoding: 'utf8' });
		if (result.status !== 0 || !fs.existsSync(path.join(output, 'Assets.car'))) {
			throw new Error(`actool failed:\n${result.stdout}${result.stderr}`);
		}

		fs.copyFileSync(path.join(output, 'Assets.car'), path.join(DARWIN, 'Assets.car'));
		console.log(`Wrote ${path.relative(ROOT, path.join(DARWIN, 'Assets.car'))} with the icon "${iconName}"`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	main();
}
