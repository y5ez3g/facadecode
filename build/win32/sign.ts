/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Signs Windows executables with the publisher's certificate (IDENTITY.md I6), which Azure Artifact
 * Signing keeps: signtool hashes each file here, the digest goes to Azure and the signature comes
 * back. No key is on this machine - signing in with `az login` is what lets it sign.
 *
 *   node build/win32/sign.ts <file>...
 *
 * Inno Setup runs it for the installer and its uninstaller, `release-local.ts` for the package.
 *
 * Environment:
 *   ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT, ARTIFACT_SIGNING_PROFILE
 *                          another account or certificate profile than the publisher's below.
 *   ARTIFACT_SIGNING_DLIB  the Artifact Signing client's `Azure.CodeSigning.Dlib.dll`. Defaults to
 *                          where its installer puts it.
 *   SIGNTOOL               `signtool.exe`. Defaults to the newest Windows SDK's.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The publisher's Artifact Signing account and its Public Trust certificate profile. */
const ACCOUNT = {
	endpoint: 'https://eus.codesigning.azure.net/',
	name: 'facadecode',
	profile: 'facadecode',
};

const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

/**
 * How many files one signtool run signs. A run costs a few seconds before its first file, and
 * Windows caps a command line at 32,767 characters.
 */
const BATCH_SIZE = 32;

export interface Signer {
	readonly signtool: string;
	readonly dlib: string;
	readonly metadata: string;
}

function findSigntool(): string {
	if (process.env.SIGNTOOL) {
		return process.env.SIGNTOOL;
	}

	const kits = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
	const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter(name => /^\d+(\.\d+)+$/.test(name)) : [];
	versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	for (const version of versions) {
		const signtool = path.join(kits, version, 'x64', 'signtool.exe');
		if (fs.existsSync(signtool)) {
			return signtool;
		}
	}

	throw new Error('No signtool.exe. Install the Windows SDK, or set SIGNTOOL.');
}

function findDlib(): string {
	if (process.env.ARTIFACT_SIGNING_DLIB) {
		return process.env.ARTIFACT_SIGNING_DLIB;
	}

	// The client was called Trusted Signing before it was renamed; either one signs.
	const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	for (const folder of ['MicrosoftArtifactSigningClientTools', 'MicrosoftTrustedSigningClientTools']) {
		const dlib = path.join(localAppData, 'Microsoft', folder, 'Azure.CodeSigning.Dlib.dll');
		if (fs.existsSync(dlib)) {
			return dlib;
		}
	}

	throw new Error('No Artifact Signing client. Install it with `winget install Microsoft.Azure.ArtifactSigningClientTools`, or set ARTIFACT_SIGNING_DLIB.');
}

/**
 * Finds what signing needs and fails in seconds when something is missing, the Azure sign-in
 * included: without it signtool would get as far as the first file and stop there.
 */
export function createSigner(): Signer {
	if (process.platform !== 'win32') {
		throw new Error('Windows executables are signed on Windows.');
	}

	const signtool = findSigntool();
	const dlib = findDlib();

	// `az` is a .cmd, which only a shell runs
	const account = spawnSync('az account show --output none', { shell: true, encoding: 'utf8' });
	if (account.status !== 0) {
		throw new Error(`Not signed in to Azure, or no az command (winget install Microsoft.AzureCLI). Run \`az login\` as the account that holds the Certificate Profile Signer role.\n${account.stderr ?? ''}`);
	}

	// Only the Azure CLI's sign-in: the others are tried in turn first otherwise, each waiting to time out
	const metadata = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'facade-sign-')), 'metadata.json');
	fs.writeFileSync(metadata, JSON.stringify({
		Endpoint: process.env.ARTIFACT_SIGNING_ENDPOINT ?? ACCOUNT.endpoint,
		CodeSigningAccountName: process.env.ARTIFACT_SIGNING_ACCOUNT ?? ACCOUNT.name,
		CertificateProfileName: process.env.ARTIFACT_SIGNING_PROFILE ?? ACCOUNT.profile,
		ExcludeCredentials: [
			'ManagedIdentityCredential',
			'EnvironmentCredential',
			'WorkloadIdentityCredential',
			'SharedTokenCacheCredential',
			'VisualStudioCredential',
			'VisualStudioCodeCredential',
			'AzurePowerShellCredential',
			'AzureDeveloperCliCredential',
			'InteractiveBrowserCredential',
		],
	}, undefined, '\t'));

	return { signtool, dlib, metadata };
}

/** Whether the file carries a signature Windows trusts, whoever made it. */
export function isSigned(signer: Signer, file: string): boolean {
	return spawnSync(signer.signtool, ['verify', '/pa', '/q', file]).status === 0;
}

/**
 * Whether `file` carries a valid Authenticode signature, checked with `signtool` alone: no Azure sign-in, for
 * checking what was signed before.
 */
export function hasValidSignature(file: string): boolean {
	return spawnSync(findSigntool(), ['verify', '/pa', '/q', file]).status === 0;
}

/**
 * Signs the files, replacing any signature they had, and timestamps each signature.
 *
 * ⚠️ The certificate lives three days - Azure makes a new one every day. The timestamp is what
 * keeps a signature valid after its certificate has expired, so it is never left out.
 */
export function sign(signer: Signer, files: readonly string[]): void {
	for (let i = 0; i < files.length; i += BATCH_SIZE) {
		const batch = files.slice(i, i + BATCH_SIZE);
		const result = spawnSync(signer.signtool, [
			'sign',
			'/fd', 'SHA256',
			'/tr', TIMESTAMP_URL,
			'/td', 'SHA256',
			'/dlib', signer.dlib,
			'/dmdf', signer.metadata,
			...batch
		], { stdio: 'inherit' });
		if (result.status !== 0) {
			throw new Error(`signtool sign exited with ${result.status ?? result.signal} for:\n  ${batch.join('\n  ')}`);
		}
	}
}

if (import.meta.main) {
	try {
		sign(createSigner(), process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
