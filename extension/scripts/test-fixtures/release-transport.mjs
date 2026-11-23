// Disposable GitHub CLI and Cloudflare transport for the real release commands.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import mirrorWorker from '../../../.github/release-mirror/worker.mjs';

const fixture = process.env.FACADE_RELEASE_TEST_ROOT;
const tag = process.env.FACADE_RELEASE_TEST_TAG;
const release = path.join(fixture, 'release');
const state = path.join(fixture, 'github.json');
const bucket = path.join(fixture, 'mirror');
const marker = 'facade-core-version.txt';
const log = line => fs.appendFileSync(path.join(fixture, 'transport.log'), line + '\n');
const read = file => fs.existsSync(file) ? fs.readFileSync(file) : undefined;

function github(args) {
	const [kind, command, ...parameters] = args;
	const current = JSON.parse(fs.readFileSync(state, 'utf8'));
	const save = () => fs.writeFileSync(state, JSON.stringify(current));
	log('github ' + kind + ' ' + command + (parameters.includes('--latest') ? ' --latest' : ''));
	const print = object => console.log(JSON.stringify(object));
	if (kind === 'api') {
		assert.equal(command, 'repos/y5ez3g/facadecode/releases/latest');
		print({ tag_name: current.latest });
		return;
	}
	assert.equal(kind, 'release');
	assert.equal(parameters[parameters.indexOf('--repo') + 1], 'y5ez3g/facadecode');
	if (command === 'list') {
		print([{ tagName: current.latest }]);
		return;
	}
	assert.equal(parameters[0], tag);
	switch (command) {
		case 'view':
			if (!current.created) {
				console.error('release not found');
				process.exitCode = 1;
				return;
			}
			print({
				tagName: tag,
				isDraft: current.draft,
				isPrerelease: current.prerelease,
				assets: fs.readdirSync(release).map(name => ({ name })),
			});
			return;
		case 'create': {
			assert.ok(!current.created && parameters.includes('--verify-tag'));
			assert.ok(parameters.includes('--draft') && parameters.includes('--prerelease'));
			const firstFile = parameters.indexOf('--latest=false');
			assert.ok(firstFile > 0);
			fs.mkdirSync(release);
			for (const file of parameters.slice(firstFile + 1)) {
				fs.copyFileSync(file, path.join(release, path.basename(file)));
			}
			if (process.env.FACADE_RELEASE_TEST_FAULT === 'extra-draft-asset') {
				fs.writeFileSync(path.join(release, 'unexpected.txt'), 'unapproved attachment');
			}
			Object.assign(current, { created: true, draft: true, prerelease: true });
			save();
			return;
		}
		case 'download': {
			assert.ok(current.created);
			if (process.env.FACADE_RELEASE_TEST_FAULT === 'draft-download-fails') {
				console.error('disposable draft download failed');
				process.exitCode = 1;
				return;
			}
			const folder = parameters[parameters.indexOf('--dir') + 1];
			const allowed = parameters.flatMap((value, index) => value === '--pattern' ? [parameters[index + 1]] : []);
			for (const file of fs.readdirSync(release)) {
				if (!allowed.length || allowed.includes(file)) fs.copyFileSync(path.join(release, file), path.join(folder, file));
			}
			return;
		}
		case 'edit':
			assert.ok(current.created);
			if (parameters.includes('--draft=false')) current.draft = false;
			if (parameters.includes('--prerelease=false')) current.prerelease = false;
			if (parameters.includes('--latest')) current.latest = tag;
			save();
			return;
		default:
			throw new Error('Unexpected GitHub command ' + command);
	}
}

let stableMarkerReads = 0;
async function request(url, options = {}) {
	const { hostname, pathname } = new URL(url);
	const fault = process.env.FACADE_RELEASE_TEST_FAULT;
	if (fault === 'marketplace-wrong-bytes' || fault === 'open-vsx-wrong-bytes') {
		const version = tag.slice('extension/'.length);
		const download = 'https://store-fixture.invalid/changed.vsix';
		log('store read ' + hostname + pathname);
		if (hostname === 'marketplace.visualstudio.com') {
			assert.equal(options.method, 'POST');
			assert.equal(pathname, '/_apis/public/gallery/extensionquery');
			const versions = fault === 'marketplace-wrong-bytes' ? [{
				version, targetPlatform: 'linux-x64',
				files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: download }],
			}] : [];
			return Response.json({ results: [{ extensions: [{ extensionName: 'facadecode', versions }] }] });
		}
		if (hostname === 'open-vsx.org') {
			if (fault === 'open-vsx-wrong-bytes' && pathname === '/api/facade/facadecode/linux-x64/' + version) {
				return Response.json({ files: { download } });
			}
			return new Response(null, { status: 404 });
		}
		assert.equal(url, download);
		return new Response('other bytes for this advertised target and version');
	}
	if (hostname === 'api.cloudflare.com') {
		assert.match(pathname, /^\/client\/v4\/accounts\/a{32}\/r2\/buckets\/facadecode-releases\/objects\//);
		assert.equal(options.method, 'PUT');
		assert.equal(options.headers.Authorization, 'Bearer disposable-token');
		const key = pathname.split('/objects/')[1];
		const file = path.join(bucket, key);
		log('r2 put ' + key);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, options.body);
		return Response.json({ success: true });
	}
	assert.equal(hostname, 'facadecode.com');
	log('website get ' + pathname);
	if (pathname === '/' + marker) stableMarkerReads++;
	if (fault === 'stable-marker-changed' && stableMarkerReads === 3) return new Response('0.0.0\n');
	if (fault === 'stable-alias-changed' && pathname === '/install.ps1') return new Response('wrong installer');
	const response = await mirrorWorker.fetch(new Request(url), {
		RELEASES: {
			get(key) {
				const body = read(path.join(bucket, key));
				return body ? { body, size: body.length, text: async () => body.toString() } : null;
			},
		},
	});
	if (fault === 'competing-stable-marker' && pathname === '/install.ps1') {
		log('competing stable marker 0.0.2');
		fs.writeFileSync(path.join(bucket, marker), '0.0.2\n');
	}
	return response;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	github(process.argv.slice(2));
} else {
	const spawn = childProcess.spawnSync;
	childProcess.spawnSync = (command, args, options) => {
		if (command !== 'gh') log('unexpected subprocess ' + command);
		assert.equal(command, 'gh', 'Unexpected subprocess in the disposable release');
		return spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], options);
	};
	syncBuiltinESMExports();
	globalThis.fetch = request;
}
