// Signs a Windows package's programs with the publisher's certificate (ARCHITECTURE-4.3), the one the IDE's
// build/win32/sign.ts signs with, which Azure Artifact Signing keeps: signtool hashes each file here, the digest goes to Azure
// and the signature comes back. No key is on this machine - the Azure CLI's sign-in is what lets it sign: `az login` on a
// person's computer, azure/login in the release run.
// `node scripts/package.mjs --sign` runs it.
//
// Environment:
//   ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT, ARTIFACT_SIGNING_PROFILE   another account or certificate profile
//                          than the publisher's below.
//   ARTIFACT_SIGNING_DLIB  the Artifact Signing client's x64 `Azure.CodeSigning.Dlib.dll`. Defaults to where its installer
//                          puts it.
//   SIGNTOOL               an x64 `signtool.exe`. Defaults to the newest Windows SDK's.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The publisher's Artifact Signing account and its Public Trust certificate profile (the IDE's IDENTITY I6). */
const ACCOUNT = { endpoint: 'https://eus.codesigning.azure.net/', name: 'facadecode', profile: 'facadecode' };

const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

function findSigntool() {
	if (process.env.SIGNTOOL) {
		return process.env.SIGNTOOL;
	}
	const kits = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
	const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter(name => /^\d+(\.\d+)+$/.test(name)) : [];
	versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	// x64 even on an Arm computer: the Artifact Signing client comes for x64 and x86 only, and the dlib is of signtool's architecture
	const signtool = versions.map(version => path.join(kits, version, 'x64', 'signtool.exe')).find(file => fs.existsSync(file));
	if (!signtool) {
		throw new Error('No signtool.exe. Install the Windows SDK, or set SIGNTOOL.');
	}
	return signtool;
}

function findDlib() {
	if (process.env.ARTIFACT_SIGNING_DLIB) {
		return process.env.ARTIFACT_SIGNING_DLIB;
	}
	// The client was called Trusted Signing before it was renamed; either one signs
	const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	const dlib = ['MicrosoftArtifactSigningClientTools', 'MicrosoftTrustedSigningClientTools']
		.map(folder => path.join(localAppData, 'Microsoft', folder, 'Azure.CodeSigning.Dlib.dll'))
		.find(file => fs.existsSync(file));
	if (!dlib) {
		throw new Error('No Artifact Signing client. Install it with `winget install Microsoft.Azure.ArtifactSigningClientTools`, or set ARTIFACT_SIGNING_DLIB.');
	}
	return dlib;
}

/**
 * What signing needs, found before anything is built: it fails in seconds where something is missing, the Azure sign-in
 * included, where signtool would otherwise get as far as the first file after core's build.
 */
export function createSigner() {
	if (process.platform !== 'win32') {
		throw new Error('Windows programs are signed on Windows.');
	}
	const signtool = findSigntool();
	const dlib = findDlib();
	// `az` is a .cmd, which only a shell runs
	const account = spawnSync('az account show --output none', { shell: true, encoding: 'utf8' });
	if (account.status !== 0) {
		throw new Error(`Not signed in to Azure, or no az command. Sign in as an identity that holds the Certificate Profile Signer role.\n${account.stderr ?? ''}`);
	}
	// Only the Azure CLI's sign-in: the others are tried in turn first otherwise, each waiting to time out
	const metadata = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'facade-sign-')), 'metadata.json');
	fs.writeFileSync(metadata, JSON.stringify({
		Endpoint: process.env.ARTIFACT_SIGNING_ENDPOINT ?? ACCOUNT.endpoint,
		CodeSigningAccountName: process.env.ARTIFACT_SIGNING_ACCOUNT ?? ACCOUNT.name,
		CertificateProfileName: process.env.ARTIFACT_SIGNING_PROFILE ?? ACCOUNT.profile,
		ExcludeCredentials: ['ManagedIdentityCredential', 'EnvironmentCredential', 'WorkloadIdentityCredential', 'SharedTokenCacheCredential',
			'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential']
	}, undefined, '\t'));
	return { signtool, dlib, metadata };
}

/** Whether `file` carries a signature Windows trusts, whoever made it. */
export function isSigned(signer, file) {
	return spawnSync(signer.signtool, ['verify', '/pa', '/q', file]).status === 0;
}

/** Check the embedded signatures on the bytes recovered from the Windows package. */
export function verifyTimestampedSignatures(files) {
	if (process.platform !== 'win32') {
		throw new Error('Windows package signatures must be verified on Windows.');
	}
	const signtool = findSigntool();
	for (const file of files) {
		const result = spawnSync(signtool, ['verify', '/pa', '/tw', file], { stdio: 'inherit' });
		if (result.status !== 0) {
			throw new Error(`Trusted timestamped signature verification failed for ${path.basename(file)}.`);
		}
	}
}

/**
 * Signs the files and timestamps each signature. ⚠️ The certificate lives three days - Azure makes a new one every day - and
 * the timestamp is what keeps a signature valid after it, so it is never left out.
 */
export function sign(signer, files) {
	const result = spawnSync(signer.signtool, ['sign', '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256', '/dlib', signer.dlib, '/dmdf', signer.metadata, ...files], { stdio: 'inherit' });
	if (result.status !== 0) {
		throw new Error(`signtool sign exited with ${result.status ?? result.signal} for ${files.join(', ')}.`);
	}
}

/**
 * Signs every program and library under `dir` that has no trusted signature - ConPTY's come signed by Microsoft - and refuses
 * a folder where one still has none.
 */
export function signFolder(signer, dir) {
	const files = fs.readdirSync(dir, { recursive: true }).map(name => path.join(dir, name)).filter(file => /\.(exe|dll)$/i.test(file));
	const unsigned = files.filter(file => !isSigned(signer, file));
	if (unsigned.length) {
		sign(signer, unsigned);
	}
	const still = files.filter(file => !isSigned(signer, file));
	if (still.length) {
		throw new Error(`Still not signed: ${still.join(', ')}.`);
	}
	console.info(`Signed ${unsigned.map(file => path.relative(dir, file)).join(', ') || 'nothing'}; ${files.length} programs and libraries in ${dir} carry a trusted signature.`);
}
