import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { filesOfZip } from './native.mjs';

const historicalTargets = ['darwin-arm64', 'linux-x64', 'win32-x64', 'universal'];
export const nativeTargets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
export const SUMS = 'SHA256SUMS';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const compareVersions = (a, b) => {
	const left = a.split('.').map(Number), right = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] - right[i]; }
	return 0;
};
export const targetsFor = version => compareVersions(version, '0.1.1') < 0 ? historicalTargets : [...nativeTargets, 'universal'];
export const fileFor = (version, target) => target === 'universal' ? `facadecode-window-${version}.vsix` : `facadecode-${target}-${version}.vsix`;
/** A VSIX is the component, version and target its name says, read from its own manifests. */
export function verifyVsix(version, target, file) {
	const files = filesOfZip(file);
	const manifest = JSON.parse(files.find(f => f.name === 'extension/package.json')?.bytes.toString() ?? 'null');
	const window = target === 'universal';
	assert.equal(manifest?.publisher, 'facade', `${path.basename(file)}: wrong publisher`);
	assert.equal(manifest.name, window ? 'facadecode-window' : 'facadecode', `${path.basename(file)}: wrong component`);
	assert.equal(manifest.version, version, `${path.basename(file)}: wrong version`);
	const identity = files.find(f => f.name === 'extension.vsixmanifest')?.bytes.toString() ?? '';
	assert.equal(identity.match(/\bTargetPlatform="([^"]+)"/)?.[1], window ? undefined : target, `${path.basename(file)}: wrong target`);
	assert.equal(identity.match(/<Identity\b[^>]*\bVersion="([^"]+)"/)?.[1], version, `${path.basename(file)}: wrong identity version`);
}

export const checksumsText = artifacts => artifacts.map(a => `${a.sha256}  ${a.file}\n`).join('');
export function parseChecksums(text) {
	const sums = new Map();
	for (const line of text.replace(/\r?\n$/, '').split(/\r?\n/)) {
		const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
		assert.ok(match, `Malformed ${SUMS} line: ${line}`);
		assert.ok(!sums.has(match[2]), `Duplicate ${SUMS} entry: ${match[2]}`);
		sums.set(match[2], match[1]);
	}
	return sums;
}
