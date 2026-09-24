/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds a disk image of this product that another Mac will open: built, signed with a Developer ID,
 * notarized by Apple and stapled. The steps are the ones CI runs, in order, on a developer's Mac.
 *
 *   npm run release-mac                    everything
 *   npm run release-mac -- --skip-build    sign and package the app already in ../VSCode-darwin-<arch>
 *   npm run release-mac -- --skip-notarize signed but not notarized, for a Mac that is yours
 *
 * Environment:
 *   CODESIGN_IDENTITY       the identity to sign with. Left unset, the one "Developer ID Application"
 *                           identity in the keychain is used, and more than one is an error.
 *   NOTARY_KEYCHAIN_PROFILE a `notarytool store-credentials` profile. Defaults to `facade-notary`.
 *   NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER
 *                           an App Store Connect API key used directly, in place of the profile.
 *   VSCODE_ARCH             `arm64` or `x64`. Defaults to this Mac's.
 *
 * The disk image is written next to the build, one directory above the repository.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.dirname(path.dirname(import.meta.dirname));
const outDir = path.dirname(root);
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));

/** How long between two questions to Apple about a submission. */
const POLL_INTERVAL_MS = 60_000;

/**
 * How long a submission may stay in progress before this gives up asking.
 *
 * ⚠️ Not minutes. A Developer ID's first submission took ten and a half hours - Apple looks harder
 * at a team it has not seen before - and later ones take minutes. Giving up is not failing: the
 * submission goes on at Apple, and the message says how to pick it up again.
 */
const POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
	console.log(`\n$ ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, { stdio: 'inherit', cwd: options.cwd ?? root, env: options.env ?? process.env });
	if (result.status !== 0) {
		throw new Error(`${command} exited with ${result.status ?? result.signal}`);
	}
}

function capture(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { encoding: 'utf8', cwd: root });
	return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function findIdentity(): string {
	const configured = process.env.CODESIGN_IDENTITY;
	if (configured) {
		return configured;
	}

	const { stdout } = capture('security', ['find-identity', '-v', '-p', 'codesigning']);
	const identities = [...new Set([...stdout.matchAll(/"(?<name>Developer ID Application: [^"]+)"/g)].map(match => match.groups!.name))];
	if (identities.length === 1) {
		return identities[0];
	}

	throw new Error(identities.length === 0
		? 'No "Developer ID Application" identity in the keychain. Create one at developer.apple.com and install it, or set CODESIGN_IDENTITY.'
		: `More than one "Developer ID Application" identity in the keychain; set CODESIGN_IDENTITY to one of:\n  ${identities.join('\n  ')}`);
}

function notaryCredentials(): string[] {
	const key = process.env.NOTARY_KEY;
	const keyId = process.env.NOTARY_KEY_ID;
	const issuer = process.env.NOTARY_ISSUER;
	if (key && keyId && issuer) {
		return ['--key', key, '--key-id', keyId, '--issuer', issuer];
	}

	return ['--keychain-profile', process.env.NOTARY_KEYCHAIN_PROFILE ?? 'facade-notary'];
}

/**
 * Submits the disk image and asks after it until Apple answers.
 *
 * ⚠️ Not `notarytool submit --wait`. That holds one connection open for as long as Apple takes, and
 * the first submission took long enough for the Mac to lose its network underneath it: the wait
 * died, and the submission went on at Apple with nothing left here asking. A question a minute
 * that shrugs off a failed one survives that.
 */
async function notarize(dmgPath: string): Promise<void> {
	const credentials = notaryCredentials();

	console.log(`\n$ xcrun notarytool submit ${path.basename(dmgPath)}`);
	const submitted = capture('xcrun', ['notarytool', 'submit', dmgPath, ...credentials, '--output-format', 'json']);
	if (!submitted.ok) {
		throw new Error(`notarytool submit failed:\n${submitted.stderr || submitted.stdout}`);
	}

	const id: string = JSON.parse(submitted.stdout).id;
	console.log(`Submitted as ${id}. Asking Apple every ${POLL_INTERVAL_MS / 1000}s.`);

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const info = capture('xcrun', ['notarytool', 'info', id, ...credentials, '--output-format', 'json']);
		if (!info.ok) {
			console.log(`  could not ask (${(info.stderr || info.stdout).trim().split('\n').pop()}); asking again`);
		} else {
			const status: string = JSON.parse(info.stdout).status;
			console.log(`  ${new Date().toISOString()} ${status}`);

			if (status === 'Accepted') {
				return;
			}

			if (status !== 'In Progress') {
				const log = capture('xcrun', ['notarytool', 'log', id, ...credentials]);
				throw new Error(`Notarization ${status}. Apple's log:\n${log.stdout || log.stderr}`);
			}
		}

		await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	throw new Error(`Still in progress after ${POLL_TIMEOUT_MS / 3_600_000}h. The submission goes on at Apple:\n  xcrun notarytool info ${id} ${credentials.join(' ')}\nand once it is Accepted:\n  xcrun stapler staple "${dmgPath}"`);
}

async function main(): Promise<void> {
	const args = new Set(process.argv.slice(2));
	const skipBuild = args.has('--skip-build');
	const skipNotarize = args.has('--skip-notarize');

	if (process.platform !== 'darwin') {
		throw new Error('A disk image is signed and notarized on macOS.');
	}

	const arch = process.env.VSCODE_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
	const env = { ...process.env, VSCODE_ARCH: arch };

	// Before the build, not after it: eight minutes of compiling is a long way to go to find out
	// there is nothing to sign with.
	const identity = findIdentity();
	console.log(`Signing as ${identity}`);

	if (!skipBuild) {
		run('npm', ['run', 'gulp', `vscode-darwin-${arch}-min`], { env });
	}

	const appPath = path.join(outDir, `VSCode-darwin-${arch}`, `${product.nameLong}.app`);
	if (!fs.existsSync(appPath)) {
		throw new Error(`No app at ${appPath}. Build it, or leave out --skip-build.`);
	}

	run('node', [path.join(import.meta.dirname, 'sign.ts'), outDir], { env: { ...env, CODESIGN_IDENTITY: identity } });
	run('codesign', ['--verify', '--deep', '--strict', appPath]);

	run('node', [path.join(import.meta.dirname, 'create-dmg.ts'), outDir, outDir], { env });
	const dmgPath = path.join(outDir, `${product.applicationName}-darwin-${arch}.dmg`);

	// The disk image is signed as well as what is in it, so that it is the image Gatekeeper
	// vouches for when it is opened, and not only the app once it has been copied out.
	run('codesign', ['--force', '--timestamp', '--sign', identity, dmgPath]);

	if (skipNotarize) {
		console.log(`\nSigned, not notarized: ${dmgPath}\nAnother Mac will refuse to open it until it is.`);
		return;
	}

	await notarize(dmgPath);
	run('xcrun', ['stapler', 'staple', dmgPath]);
	run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmgPath]);

	console.log(`\nReady to hand to anyone: ${dmgPath}`);
}

if (import.meta.main) {
	main().catch(err => {
		console.error(`\n${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
