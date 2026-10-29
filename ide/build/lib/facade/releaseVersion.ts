/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The product's release version, as every package carries it (IDENTITY.md I7): `facadeVersion` in
 * `product.json`, the one place it is written. The engine version - `package.json`'s, upstream's - stays
 * what extensions are checked against, and nothing here touches it.
 *
 * ⚠️ Thrown rather than defaulted: a package stamped with the engine's version instead would install as
 * Facade Code 1.138.0, and an installer or apt would never see the real 0.x as an upgrade over it.
 */
export function releaseVersion(product: { readonly facadeVersion?: unknown }): string {
	const version = product.facadeVersion;
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`product.json's facadeVersion is ${JSON.stringify(version)}, not a release version such as 0.1.0`);
	}
	return version;
}

/**
 * `plist`, a macOS bundle's `Info.plist`, saying `version` where Finder and About This Mac read one:
 * `CFBundleShortVersionString` and `CFBundleVersion`. The packager writes the engine's there, from the
 * app's `package.json`, which has to stay the engine's.
 */
export function withBundleVersion(plist: string, version: string): string {
	let stamped = plist;
	for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
		const entry = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
		if (!entry.test(stamped)) {
			throw new Error(`Info.plist has no ${key} to stamp`);
		}
		stamped = stamped.replace(entry, (_, open, close) => `${open}${version}${close}`);
	}
	return stamped;
}
