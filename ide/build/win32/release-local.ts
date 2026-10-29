/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds a user installer of this product that another Windows PC will run: every executable in it
 * and the installer itself signed with the publisher's certificate. Smart App Control refuses an
 * unsigned executable outright, inside the package as much as the installer.
 *
 *   npm run release-win                    everything
 *   npm run release-win -- --skip-build    sign and package the build already in ../VSCode-win32-<arch>
 *
 * Environment:
 *   VSCODE_ARCH   `x64` or `arm64`. Defaults to this PC's.
 *   and the signing ones `sign.ts` lists.
 *
 * The installer is written next to the build, one directory above the repository.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createSigner, isSigned, sign } from './sign.ts';

const root = path.dirname(path.dirname(import.meta.dirname));
const outDir = path.dirname(root);
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));

/** Runs an npm script, which is a .cmd and so only runs in a shell; the arguments are the build's own. */
function npm(args: string[], env: NodeJS.ProcessEnv): void {
	const command = `npm ${args.join(' ')}`;
	console.log(`\n$ ${command}`);
	const result = spawnSync(command, { stdio: 'inherit', cwd: root, env, shell: true });
	if (result.status !== 0) {
		throw new Error(`${command} exited with ${result.status ?? result.signal}`);
	}
}

/** Every file in the folder Windows would check a signature on before running it. */
function executables(folder: string): string[] {
	return fs.readdirSync(folder, { recursive: true, encoding: 'utf8' })
		.filter(file => /\.(exe|dll|node)$/i.test(file))
		.map(file => path.join(folder, file));
}

function main(): void {
	const skipBuild = process.argv.includes('--skip-build');
	const arch = process.env.VSCODE_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'x64');

	// Before the build, not after it: twenty minutes of compiling is a long way to go to find out
	// there is nothing to sign with.
	const signer = createSigner();
	console.log(`Signing with ${signer.signtool}`);

	// The package step runs signtool by its bare name, to take off the signatures rcedit is about to break
	const env = { ...process.env, VSCODE_ARCH: arch, PATH: `${path.dirname(signer.signtool)};${process.env.PATH}` };

	if (!skipBuild) {
		npm(['run', 'gulp', `vscode-win32-${arch}-min`], env);
		npm(['run', 'gulp', `vscode-win32-${arch}-inno-updater`], env);
	}

	const packagePath = path.join(outDir, `VSCode-win32-${arch}`);
	if (!fs.existsSync(packagePath)) {
		throw new Error(`No build at ${packagePath}. Build it, or leave out --skip-build.`);
	}

	// Electron's and Microsoft's own libraries come signed already; signing them again would only
	// spend the account's monthly allowance of signatures.
	const files = executables(packagePath);
	const unsigned = files.filter(file => !isSigned(signer, file));
	console.log(`\n${files.length} executables, ${unsigned.length} to sign`);
	sign(signer, unsigned);

	const stillUnsigned = files.filter(file => !isSigned(signer, file));
	if (stillUnsigned.length) {
		throw new Error(`Still not signed:\n  ${stillUnsigned.join('\n  ')}`);
	}

	// `--sign` has Inno Setup sign the installer and the uninstaller it writes, through sign.ts
	npm(['run', 'gulp', `vscode-win32-${arch}-user-setup`, '--', '--sign'], env);

	const setupPath = path.join(root, '.build', `win32-${arch}`, 'user-setup', `${product.applicationName}-setup.exe`);
	if (!isSigned(signer, setupPath)) {
		throw new Error(`The installer is not signed: ${setupPath}`);
	}

	const releasePath = path.join(outDir, `${product.applicationName}-win32-${arch}-user-setup.exe`);
	fs.copyFileSync(setupPath, releasePath);
	console.log(`\nReady to hand to anyone: ${releasePath}`);
}

if (import.meta.main) {
	try {
		main();
	} catch (err) {
		console.error(`\n${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
