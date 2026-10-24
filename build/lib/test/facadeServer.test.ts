/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Remote SSH's product and build (REMOTE.md R5, R6): the SSH extension built in from Open VSX,
 * the APIs and menu entries it needs, and the server packages the remotes download.
 */

import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { suite, test } from 'node:test';
import es from 'event-stream';
import { Readable } from 'stream';
import File from 'vinyl';
import { checkVersionFields, serverVersionFields } from '../facade/versionCheck.ts';
import { extensionPatches, isExtensionPatched, isSyncedCopyCurrent, markSyncedCopy, patchExtension, patchExtensionFile } from '../facade/extensionPatches.ts';
import { checkServerPackage, createServerTarball, glibcCheckedFiles, glibcCheckEnv, glibcProblems, serverLayoutProblems, serverPackageName, serverSignedFiles, serverTopFolderName, sysrootObjdump, systemTar } from '../facade/serverPackage.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const hasTar = spawnSync(systemTar(), ['--version'], { stdio: 'pipe' }).status === 0;
/** Git for Windows' bash, where this machine has it: what runs the Windows server's POSIX remote CLI. */
const gitBash = process.platform === 'win32' ? [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')].find(file => fs.existsSync(file)) : undefined;
/** A Linux shell to run the Linux server's launcher in, with `setsid` and `ps`: this machine's, or on Windows its WSL's. */
const linuxShell = process.platform === 'linux' ? ['sh'] : process.platform === 'win32' && spawnSync('wsl.exe', ['-e', 'sh', '-c', 'command -v setsid && command -v ps'], { stdio: 'pipe' }).status === 0 ? ['wsl.exe', '-e', 'sh'] : undefined;
/** `file` as the Linux shell names it: WSL's mount of the drive on Windows. */
const linuxPath = (file: string) => process.platform === 'win32' ? `/mnt/${file[0].toLowerCase()}${file.slice(2).replace(/\\/g, '/')}` : file;
const windowsCommandFixture = [
	'if(f=`powershell "md -Force ${h}"',
	',o.trace("Command length (8191 max):",f.length),f.length>8191)throw new g("Command line too long")',
].join('\n');
/** The pinned upstream script, before Facade patches. MIT: jeanp413/open-remote-ssh v0.5.0. */
const upstreamPowerShell = () => read('build/lib/test/fixtures/open-remote-ssh-0.5.0-server-setup.ps1');
const patchedPowerShell = () => patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'src/scripts/server-setup.ps1', upstreamPowerShell());
/** The upstream shell lines targeted by its patches; enough for the standalone lock and failure fixtures. */
const shellPatchFixture = (check = '  SERVER_RUNNING_PROCESS="$( ps -o pid,args | grep $SERVER_PID | grep $SERVER_SCRIPT )"') => [
	'LOCKFILE="$TMP_DIR/server_install.lock"', check,
	'  echo "Warning: flock not available, skipping install lock"',
	'--accept-server-license-terms &> $SERVER_LOGFILE &',
	'# curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"',
	'  pushd "$SERVER_DIR" > /dev/null || exit',
	'  exec 9<>"$LOCKFILE"',
	'  mkdir -p $SERVER_DIR || (',
	'    echo "Error: creating server install directory"',
	'    print_install_results_and_exit 1',
	'  )',
	'  tar -xOf vscode-server.tar.gz > /dev/null 2>&1 || (',
	'    echo "Error downloaded tarball is corrupt or incomplete"',
	'    rm -rf vscode-server.tar.gz',
	'    print_install_results_and_exit 1',
	'  )',
	'  tar -xf vscode-server.tar.gz --strip-components 1 || (',
	'    echo "Error while extracting server contents"',
	'    rm -rf vscode-server.tar.gz',
	'    print_install_results_and_exit 1',
	'  )',
	'  popd > /dev/null || exit',
].join('\n');

suite('Facade remote server', () => {

	test('R5 the SSH and WSL extensions are built in at pinned versions and checksums, for the desktop only', () => {
		const product = JSON.parse(read('product.json'));
		const pinned = (name: string) => {
			const entry = product.builtInExtensions.find((each: { name?: string }) => each.name === name);
			return entry && { version: entry.version, sha256: entry.sha256, repo: entry.repo, clientOnly: entry.clientOnly };
		};

		assert.deepStrictEqual({
			ssh: pinned('jeanp413.open-remote-ssh'),
			wsl: pinned('jeanp413.open-remote-wsl'),
			// the server build leaves client-only extensions out of its packages
			leftOut: read('build/gulpfile.reh.ts').includes('.filter(entry => !entry.clientOnly)'),
		}, {
			ssh: { version: '0.5.0', sha256: '99e72aec520a75e8a6ddb4feccf7353c1ff8e700ca885afe811ba96b6c3b48ca', repo: 'https://github.com/jeanp413/open-remote-ssh', clientOnly: true },
			wsl: { version: '0.0.5', sha256: 'f1025d8a2cf7a2e9b2876bf11d7c97180e597f90a722722c22a94c0d5975a355', repo: 'https://github.com/jeanp413/open-remote-wsl', clientOnly: true },
			leftOut: true,
		});
	});

	test('R5 packaging changes the one line of the built-in WSL extension that keeps it from starting in a workspace without folders - in its pinned version, found exactly once, as open-remote-ssh 0.5.0 changed its own - and nothing else of it', () => {
		const product = JSON.parse(read('product.json'));
		const wsl = product.builtInExtensions.find((each: { name?: string }) => each.name === 'jeanp413.open-remote-wsl');
		// 0.0.5's line, as its bundle has it
		const line = 'if(e=s.workspace.workspaceFolders?.[0].uri,e&&"vscode-remote"===e.scheme)';
		const patched = (version: string, file: string, contents: string, name = 'jeanp413.open-remote-wsl') => {
			try {
				return patchExtensionFile(name, version, file, contents);
			} catch {
				return 'refused';
			}
		};

		assert.deepStrictEqual({
			patched: Object.fromEntries(Object.entries(extensionPatches).map(([name, patches]) => [name, Object.fromEntries([...new Set(patches.map(patch => patch.file))].map(file => [file, { count: patches.filter(patch => patch.file === file).length, versions: [...new Set(patches.filter(patch => patch.file === file).map(patch => patch.version))] }]))])),
			line: patched(wsl?.version, 'out/extension.js', line),
			again: patched(wsl?.version, 'out/extension.js', patched(wsl?.version, 'out/extension.js', line)),
			notThere: patched(wsl?.version, 'out/extension.js', 'nothing like it'),
			twice: patched(wsl?.version, 'out/extension.js', `${line};${line}`),
			// a newer version is looked at again before it is changed
			newer: patched('0.0.6', 'out/extension.js', line),
			otherFile: patched(wsl?.version, 'out/other.js', line),
			otherExtension: patched('1.117.0', 'src/extension.js', line, 'ms-vscode.js-debug'),
			// both ways an extension comes into a package: downloaded, or from the copy already synced
			applied: read('build/lib/builtInExtensions.ts').split('.pipe(patchExtension(extension.name, extension.version))').length - 1,
		}, {
			patched: {
				'jeanp413.open-remote-wsl': { 'out/extension.js': { count: 1, versions: ['0.0.5'] } },
				'jeanp413.open-remote-ssh': { 'src/scripts/server-setup.sh': { count: 11, versions: ['0.5.0'] }, 'lib/extension.js': { count: 6, versions: ['0.5.0'] }, 'src/scripts/server-setup.ps1': { count: 26, versions: ['0.5.0'] } },
			},
			line: 'if(e=s.workspace.workspaceFolders?.[0]?.uri,e&&"vscode-remote"===e.scheme)',
			again: 'if(e=s.workspace.workspaceFolders?.[0]?.uri,e&&"vscode-remote"===e.scheme)',
			notThere: 'refused',
			twice: 'refused',
			newer: 'refused',
			otherFile: line,
			otherExtension: line,
			applied: 2,
		});
	});

	test('R5 packaging patches the built-in SSH extension so it finds the running server on macOS and continues when Windows refuses agent forwarding', () => {
		const product = JSON.parse(read('product.json'));
		const ssh = product.builtInExtensions.find((each: { name?: string }) => each.name === 'jeanp413.open-remote-ssh');
		// 0.5.0's lines, as its setup script and its bundle have them
		const check = '  SERVER_RUNNING_PROCESS="$( ps -o pid,args | grep $SERVER_PID | grep $SERVER_SCRIPT )"';
		const refusal = 'e._callbacks.push(n=>{if(n)return e._client._agentFwdEnabled=!1,void(r&&t(!0!==n?n:new Error("Unable to request agent forwarding")));r&&t()})';

		assert.deepStrictEqual({
			// beside the script's other patched line, its lock (below)
			check: patchExtensionFile('jeanp413.open-remote-ssh', ssh?.version, 'src/scripts/server-setup.sh', shellPatchFixture(check)).split('\n').find(line => line.includes('SERVER_RUNNING_PROCESS=')),
			curl: patchExtensionFile('jeanp413.open-remote-ssh', ssh?.version, 'src/scripts/server-setup.sh', shellPatchFixture(check)).split('\n').find(line => line.startsWith('# curl')),
			refusal: patchExtensionFile('jeanp413.open-remote-ssh', ssh?.version, 'lib/extension.js', [
				refusal,
				'identityfile:"IdentityFile",include:"Include"',
				'.listen(e.localPort,"127.0.0.1")',
				'await this.sshConnection.connect();const j={};',
				windowsCommandFixture,
			].join('\n')).includes('e._callbacks.push(n=>{if(n)return e._client._agentFwdEnabled=!1,void(r&&t(!0!==n?n:void 0));r&&t()})'),
		}, {
			// by its process id, which lists it on macOS as on Linux; a ps without -p, as on BusyBox, lists what it did
			check: '  SERVER_RUNNING_PROCESS="$( (ps -o pid,args -p $SERVER_PID || ps -o pid,args) | grep $SERVER_PID | grep $SERVER_SCRIPT )"',
			curl: '# curl --fail --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"',
			// the refusal only - ssh2 answers it with `true` - and an error of the channel still fails it
			refusal: true,
		});
	});

	test('R5 a long Windows setup crosses cmd as encoded, bounded chunks into a unique script path', async () => {
		if (process.platform !== 'win32') { return; }
		const patched = patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'lib/extension.js', [
			'void(r&&t(!0!==n?n:new Error("Unable to request agent forwarding")))',
			'identityfile:"IdentityFile",include:"Include"',
			'.listen(e.localPort,"127.0.0.1")',
			'await this.sshConnection.connect();const j={};',
			windowsCommandFixture,
		].join('\n'));
		const fallback = patched.slice(patched.indexOf('if(f.length>8191){'));
		const run = new Function('f', 'l', 't', 'e', 'g', `return (async () => { ${fallback}; return f; })();`);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade setup with spaces '));
		const base = path.join(dir, 'setup.ps1');
		const longScript = [
			'$URL = "https://example.test/file?one=1&two=2"',
			'$VALUE = "literal %RM57_TOKEN% < > Unicode 中文"',
			'$LINES = @(',
			...Array.from({ length: 320 }, (_, i) => `  'line ${i} ${'x'.repeat(90)}'`),
			')',
			'[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($VALUE))',
		].join('\n');
		// The real setup calls exit after it starts the server. Cleanup must happen before running it.
		const shortScript = '$VALUE = "other & %RM57_TOKEN% < >"\nexit 0';
		const lengths: number[] = [];
		const ssh = { exec: async (command: string) => {
			lengths.push(command.length);
			const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsVerbatimArguments: true, encoding: 'utf8' });
			return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		} };
		try {
			const installed = await Promise.all([longScript, shortScript].map(script => run('x'.repeat(9000), base, script, ssh, Error)));
			const paths = fs.readdirSync(dir).map(file => path.join(dir, file));
			assert.strictEqual(paths.length, 2);
			assert.deepStrictEqual(paths.map(file => fs.readFileSync(file, 'utf8')).sort(), [`\uFEFF${longScript}`, `\uFEFF${shortScript}`].sort());
			assert.ok(longScript.length > 20000);
			assert.ok(lengths.length > 2 && lengths.every(length => length <= 8191));
			assert.ok(installed.every((command: string) => command.length <= 8191));
			for (const [index, command] of installed.entries()) {
				const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsVerbatimArguments: true, encoding: 'utf8' });
				assert.strictEqual(result.status, 0, result.stderr);
				if (index === 0) { assert.ok(result.stdout.includes(Buffer.from('literal %RM57_TOKEN% < > Unicode 中文').toString('base64'))); }
			}
			assert.deepStrictEqual(fs.readdirSync(dir), []);
			let calls = 0;
			const failing = { exec: async (command: string) => ++calls === 2 ? { stdout: '', stderr: 'forced interruption' } : ssh.exec(command) };
			await assert.rejects(run('x'.repeat(9000), base, longScript, failing, Error), /forced interruption/);
			assert.deepStrictEqual(fs.readdirSync(dir), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 LocalForward entries in the SSH config start client-side tunnels on the ssh2 connection', async () => {
		const name = 'jeanp413.open-remote-ssh';
		const version = '0.5.0';
		const setup = patchExtensionFile(name, version, 'lib/extension.js', [
			'void(r&&t(!0!==n?n:new Error("Unable to request agent forwarding")))',
			'identityfile:"IdentityFile",include:"Include"',
			'.listen(e.localPort,"127.0.0.1")',
			'await this.sshConnection.connect();const j={};',
			windowsCommandFixture,
		].join('\n'));
		const start = 'await this.sshConnection.connect();';
		const end = 'const j={};';
		const injected = setup.slice(setup.indexOf(start) + start.length, setup.indexOf(end));
		const run = new Function('r', 'A', `return (async function () { ${injected} }).call(this);`);
		const requested: unknown[] = [];
		const bound = new Set<number>();
		type Forward = { name: string; localAddr: string; localPort: number; remoteAddr: string; remotePort: number };
		class SSH2Connection {
			readonly activeTunnels: Record<string, Forward> = {};
			async addTunnel(config: Forward) {
				if (bound.has(config.localPort)) { throw new Error('EADDRINUSE'); }
				bound.add(config.localPort);
				this.activeTunnels[config.name] = config;
				requested.push(config);
			}
			async closeTunnel(name: string) {
				bound.delete(this.activeTunnels[name].localPort);
				delete this.activeTunnels[name];
			}
		}
		const errors: string[] = [];
		const context = { sshConnection: new SSH2Connection(), logger: { info() { }, error(message: string) { errors.push(message); } } };
		await run.call(context, { LocalForward: ['47111 127.0.0.1:18765', 'localhost:47112 example.test:8080'] }, { default: SSH2Connection });
		assert.deepStrictEqual(requested, [
			{ name: 'ssh_config_local_127.0.0.1_47111', localAddr: '127.0.0.1', localPort: 47111, remoteAddr: '127.0.0.1', remotePort: 18765 },
			{ name: 'ssh_config_local_localhost_47112', localAddr: 'localhost', localPort: 47112, remoteAddr: 'example.test', remotePort: 8080 },
		]);
		assert.deepStrictEqual(errors, []);
		context.sshConnection = new SSH2Connection();
		await run.call(context, { LocalForward: ['47111 127.0.0.1:18765'] }, { default: SSH2Connection });
		assert.strictEqual(requested.length, 3);
		assert.deepStrictEqual([...bound], [47111]);
		assert.deepStrictEqual(errors, []);
		requested.length = 0;
		await run.call(context, { LocalForward: ['bad line here', '[::1]:47113 [::1]:8080'] }, { default: SSH2Connection });
		assert.deepStrictEqual(requested, [
			{ name: 'ssh_config_local_::1_47113', localAddr: '::1', localPort: 47113, remoteAddr: '::1', remotePort: 8080 },
		]);
		assert.deepStrictEqual(errors, ['Unsupported LocalForward: bad line here']);
		const failingRequests: unknown[] = [];
		const failing = new SSH2Connection();
		failing.addTunnel = async config => {
			failingRequests.push(config);
			if (failingRequests.length === 1) { throw new Error('EADDRINUSE'); }
		};
		await run.call({ ...context, sshConnection: failing }, { LocalForward: ['47114 remote:8080', '47115 remote:8081'] }, { default: SSH2Connection });
		assert.strictEqual(failingRequests.length, 2);
		assert.deepStrictEqual(errors, ['Unsupported LocalForward: bad line here', 'LocalForward 47114 remote:8080 failed']);
		requested.length = 0;
		await run.call({ ...context, sshConnection: { addTunnel() { throw new Error('native SSH already applied this config'); } } }, { LocalForward: ['47114 remote:8080'] }, { default: SSH2Connection });
		assert.deepStrictEqual(requested, []); // native SSH reads the config itself

		assert.match(setup, /identityfile:"IdentityFile",localforward:"LocalForward",include:"Include"/);
		assert.match(setup, /\.listen\(e\.localPort,e\.localAddr\|\|"127\.0\.0\.1"\)/);
		assert.strictEqual(patchExtensionFile(name, version, 'lib/extension.js', setup), setup);
	});

	test('R5 reconnect rebinds LocalForward while the old listener still has an open client socket', async () => {
		const setup = patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'lib/extension.js', [
			'void(r&&t(!0!==n?n:new Error("Unable to request agent forwarding")))',
			'identityfile:"IdentityFile",include:"Include"',
			'.listen(e.localPort,"127.0.0.1")',
			'await this.sshConnection.connect();const j={};',
			windowsCommandFixture,
		].join('\n'));
		const start = 'await this.sshConnection.connect();';
		const injected = setup.slice(setup.indexOf(start) + start.length, setup.indexOf('const j={};'));
		const run = new Function('r', 'A', `return (async function () { ${injected} }).call(this);`);
		type Tunnel = { server: net.Server };
		class SSH2Connection {
			readonly activeTunnels: Record<string, Tunnel> = {};
			async addTunnel(config: { name: string; localPort: number }) {
				const server = net.createServer(socket => socket.end('new listener'));
				await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.localPort, '127.0.0.1', resolve));
				this.activeTunnels[config.name] = { server };
			}
			closeTunnel(name: string): Promise<void> {
				const tunnel = this.activeTunnels[name];
				return new Promise(resolve => tunnel.server.close(() => { delete this.activeTunnels[name]; resolve(); }));
			}
		}
		const old = new SSH2Connection();
		const next = new SSH2Connection();
		const oldServer = net.createServer();
		await new Promise<void>((resolve, reject) => oldServer.once('error', reject).listen(0, '127.0.0.1', resolve));
		const port = (oldServer.address() as net.AddressInfo).port;
		const tunnelName = `ssh_config_local_127.0.0.1_${port}`;
		old.activeTunnels[tunnelName] = { server: oldServer };
		const accepted = once(oldServer, 'connection');
		const heldClient = net.connect(port, '127.0.0.1');
		await once(heldClient, 'connect');
		const [heldPeer] = await accepted as [net.Socket];
		let timer: NodeJS.Timeout | undefined;
		const context = { facadeLocalForwards: old, sshConnection: next, logger: { info() { }, error(error: unknown) { throw error; } } };
		const reconnect = run.call(context, { LocalForward: [`${port} 127.0.0.1:8000`] }, { default: SSH2Connection }) as Promise<void>;
		try {
			await Promise.race([
				reconnect,
				new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('reconnect waited for the old client socket')), 1500); }),
			]);
			assert.strictEqual(next.activeTunnels[tunnelName]?.server.listening, true);
			assert.strictEqual(oldServer.listening, false);
			assert.strictEqual(heldClient.destroyed, false);
		} finally {
			if (timer) { clearTimeout(timer); }
			heldClient.destroy();
			heldPeer.destroy();
			await reconnect;
			if (next.activeTunnels[tunnelName]) { await next.closeTunnel(tunnelName); }
		}
	});

	/** open-remote-ssh's setup script `file`, holding `held` lines between where its lock is taken and let go, as packaging patches it. */
	function setupWithLock(file: 'src/scripts/server-setup.sh' | 'src/scripts/server-setup.ps1', held: string): string {
		const product = JSON.parse(read('product.json'));
		const ssh = product.builtInExtensions.find((each: { name?: string }) => each.name === 'jeanp413.open-remote-ssh');
		if (file === 'src/scripts/server-setup.sh') {
			const fixture = shellPatchFixture('# SERVER_RUNNING_PROCESS="$( ps -o pid,args | grep $SERVER_PID | grep $SERVER_SCRIPT )"');
			const setup = patchExtensionFile('jeanp413.open-remote-ssh', ssh?.version, file, fixture);
			return `${setup.slice(0, setup.indexOf('  pushd "$SERVER_DIR"'))}\n${held}`;
		}
		const setup = patchedPowerShell();
		const start = setup.indexOf('# Facade Code: one setup at a time');
		const end = setup.indexOf('# Validate the commit of the installed server against the expected one (DISTRO_COMMIT)');
		assert.ok(start >= 0 && end > start);
		return `${setup.slice(start, end)}\n${held}\n$LOCK_STREAM.Close()`;
	}

	test('R5 Windows setup reports a parseable exitCode when the downloaded server has another commit', { skip: process.platform !== 'win32' || !hasTar }, () => {
		// Run the exact pinned upstream 0.5.0 script before and after our patch, with the same wrong tarball.
		const original = upstreamPowerShell();
		const patched = patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'src/scripts/server-setup.ps1', original);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-wrong-commit-'));
		const expected = '3427788d9411585422db61ddc70c50b9a5043522';
		const wrong = 'c45fd17340ccc1fa8e6dc8c1c624b344921c061b';
		const scriptId = 'facade-wrong-commit-test';
		try {
			const sourceDir = path.join(dir, 'package', 'facade-server');
			fs.mkdirSync(path.join(sourceDir, 'bin'), { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'product.json'), JSON.stringify({ commit: wrong }));
			fs.writeFileSync(path.join(sourceDir, 'bin', 'facade-server.cmd'), '@echo off\r\n');
			const archive = path.join(dir, 'wrong.tar.gz');
			const tar = spawnSync(systemTar(), ['-czf', archive, '-C', path.join(dir, 'package'), 'facade-server'], { encoding: 'utf8' });
			assert.strictEqual(tar.status, 0, tar.stderr);

			const run = (name: string, template: string) => {
				const runDir = path.join(dir, name);
				const serverDir = path.join(runDir, 'server');
				const tempDir = path.join(runDir, 'temp');
				fs.mkdirSync(serverDir, { recursive: true });
				fs.mkdirSync(tempDir);
				const replacements: Record<string, string> = {
					SEND_ENV_VAR_LINES: '', ENV_VAR_LINES: '', DISTRO_VERSION: '1.138.0', DISTRO_COMMIT: expected,
					DISTRO_QUALITY: 'undefined', DISTRO_VSCODIUM_RELEASE: '0.1.2', MODIFY_PRODUCT_JSON: '$false',
					SERVER_APP_NAME: 'facade-server', SERVER_INITIAL_EXTENSIONS: '', SERVER_LISTEN_FLAG: '--port=0',
					SERVER_DATA_DIR: serverDir, SERVER_DATA_DIR_FLAG: '', SERVER_DOWNLOAD_URL: 'http://127.0.0.1/wrong.tar.gz',
					SERVER_VALIDATION_FLAG: '', SERVER_CONNECTION_TOKEN: 'probe', SCRIPT_ID: scriptId,
				};
				for (const [key, value] of Object.entries(replacements)) {
					template = template.replaceAll(`%%${key}%%`, value);
				}
				assert.doesNotMatch(template, /%%[A-Z_]+%%/);
				// The same valid tarball reaches the real post-download validation branch in both scripts.
				const localArchive = archive.replace(/'/g, "''");
				const download = `function Invoke-RestMethod { param($Uri, $TimeoutSec, $OutFile, $UseBasicParsing, $Proxy, $ErrorAction) Copy-Item -LiteralPath '${localArchive}' -Destination $OutFile }`;
				const file = path.join(runDir, 'setup.ps1');
				fs.writeFileSync(file, `${download}\n${template}`);
				const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
					encoding: 'utf8', timeout: 60_000,
					env: { ...process.env, TEMP: tempDir, TMP: tempDir, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '' },
				});
				assert.strictEqual(result.status, 1, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
				assert.match(result.stdout, new RegExp(`downloaded server commit ${wrong} does not match ${expected}`));
				assert.ok(!fs.existsSync(path.join(serverDir, 'bin', expected, 'product.json')), 'the wrong server must be removed');
				return result.stdout;
			};
			const upstreamOutput = run('upstream', original);
			assert.doesNotMatch(upstreamOutput, new RegExp(`${scriptId}: start`));
			const patchedOutput = run('patched', patched);
			assert.match(patchedOutput, new RegExp(`${scriptId}: start\\s+exitCode==1==`));
			assert.match(patchedOutput, new RegExp(`${scriptId}: end`));
		} finally {
			const tempRoot = fs.realpathSync(os.tmpdir());
			const target = fs.realpathSync(dir);
			assert.ok(target.startsWith(`${tempRoot}${path.sep}`));
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	// Run each failure branch through the pinned upstream PowerShell script with Facade's patches applied. The fixture
	// stubs only the external failure (HTTP, tar, or start); all setup control flow and result printing remain real.
	const windowsFailureCases = [
		{ name: 'unsupported architecture', expected: 'Error architecture not supported', arch: 'x86' },
		{ name: 'directory creation exception', expected: 'Error creating server install directory -', mutate: (s: string) => s.replace('    ni -it d $SERVER_DIR -f -ea si', '    throw "mkdir denied"') },
		{ name: 'directory still missing', expected: 'Error creating server install directory', mutate: (s: string) => s.replace('    ni -it d $SERVER_DIR -f -ea si', '    $null = $true') },
		{ name: 'directory change exception', expected: 'Error while setting up server: directory unavailable', mutate: (s: string) => s.replace('cd $SERVER_DIR -ErrorAction Stop', 'throw "directory unavailable"') },
		{ name: 'install lock timeout', expected: 'Warning: cannot acquire the install lock', lockBlocked: true, mutate: (s: string) => s.replaceAll('sleep 1', 'Start-Sleep -Milliseconds 1') },
		{ name: 'HTTP 404 download', expected: '(404) Not Found', download: 'http404' },
		{ name: 'invalid download URL', expected: 'Error while setting up server:', download: 'badUrl' },
		{ name: 'corrupt tarball', expected: 'Error downloaded tarball is corrupt or incomplete', download: 'corrupt', mutate: (s: string) => s.replace('    tar -xOf vscode-server.tar.gz | Out-Null', '    tar -xOf vscode-server.tar.gz | Out-Null\n    $global:LASTEXITCODE=1') },
		{ name: 'tar extraction failure', expected: 'Error while extracting server contents', download: 'extract', mutate: (s: string) => s.replace('    tar -xf vscode-server.tar.gz --strip-components 1', '    tar -xf vscode-server.tar.gz --strip-components 1\n    $global:LASTEXITCODE=1') },
		{ name: 'server executable missing after extraction', expected: 'Error while installing the server binary', download: 'noScript' },
		{ name: 'token write exception', expected: 'Error while setting up server: token write denied', installed: true, mutate: (s: string) => s.replace('  [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)', '  throw "token write denied"') },
		{ name: 'server process launch exception', expected: 'Error while setting up server:', installed: true, mutate: (s: string) => s.replace('  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID', '  $START_ARGUMENTS.FilePath="C:\\no-such-facade-server.exe"\n  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID') },
		{ name: 'pid write exception', expected: 'Error while setting up server: pid write denied', installed: true, mutate: (s: string) => s.replace('  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID', '  $SERVER_ID = 123456').replace('    [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)', '    throw "pid write denied"') },
		{ name: 'locked installed product read', expected: 'Error while setting up server:', installed: true, lockStale: 'product' },
		{ name: 'locked wrong-commit cleanup', expected: 'Installed server commit', installed: true, wrongInstalled: true, lockStale: 'script' },
		{ name: 'locked stale log deletion', expected: 'Error while setting up server:', installed: true, lockStale: 'log' },
		{ name: 'locked stale pid deletion', expected: 'Error while setting up server:', installed: true, lockStale: 'pid' },
		{ name: 'locked stale token deletion', expected: 'Error while setting up server:', installed: true, lockStale: 'token' },
		{ name: 'locked existing token read', expected: 'Error while setting up server:', installed: true, tokenFile: 'locked', mutate: (s: string) => s.replace('if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*")', 'if($true)') },
		{ name: 'empty existing token', expected: 'Error server token file is empty', installed: true, tokenFile: 'empty', mutate: (s: string) => s.replace('if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*")', 'if($true)') },
		{ name: 'server token missing', expected: 'Error server token file not found', installed: true, mutate: (s: string) => s.replace('  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID', '  $SERVER_ID = $null').replace('if(Test-Path $SERVER_TOKENFILE) {\n  $SERVER_CONNECTION_TOKEN', 'Remove-Item -Force $SERVER_TOKENFILE\nif(Test-Path $SERVER_TOKENFILE) {\n  $SERVER_CONNECTION_TOKEN') },
		{ name: 'server log missing', expected: 'Error server log file not found', installed: true, mutate: (s: string) => s.replace('  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID', '  $SERVER_ID = $null').replace('  sleep -Milliseconds 500', '  sleep -Milliseconds 1') },
		{ name: 'server never listens', expected: 'Error: server did not start successfully', installed: true, logWithoutPort: true, mutate: (s: string) => s.replace('  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID', '  $SERVER_ID = $null').replace('  sleep -Milliseconds 500', '  sleep -Milliseconds 1').replace('$SELECT_ARGUMENTS = @{', 'Set-Content -LiteralPath $SERVER_LOGFILE "server booted without listening"\n$SELECT_ARGUMENTS = @{') },
	] as const;
	for (const failure of windowsFailureCases) {
		test(`R5 Windows ${failure.name} emits one parseable failure result`, { skip: process.platform !== 'win32' || !hasTar }, () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-setup-failure-'));
			const commit = '3427788d9411585422db61ddc70c50b9a5043522';
			const serverDataDir = path.join(dir, 'server');
			const installDir = path.join(serverDataDir, 'bin', commit);
			const tempDir = path.join(dir, 'temp');
			const scriptId = 'facade-failure-probe';
			try {
				fs.mkdirSync(tempDir);
				if ('installed' in failure && failure.installed) {
					fs.mkdirSync(path.join(installDir, 'bin'), { recursive: true });
					fs.writeFileSync(path.join(installDir, 'bin', 'facade-server.cmd'), '@echo off\r\n');
					fs.writeFileSync(path.join(installDir, 'product.json'), JSON.stringify({ commit: 'wrongInstalled' in failure && failure.wrongInstalled ? 'c45fd17340ccc1fa8e6dc8c1c624b344921c061b' : commit }));
				}
				if ('lockBlocked' in failure && failure.lockBlocked) { fs.mkdirSync(path.join(tempDir, 'facade-server-install.lock')); }
				if ('tokenFile' in failure) { fs.writeFileSync(path.join(serverDataDir, `.${commit}.token`), failure.tokenFile === 'empty' ? '' : 'probe'); }
				let prefix = '';
				if ('download' in failure && failure.download !== 'badUrl') {
					const header = 'function Invoke-RestMethod { [CmdletBinding()] param($Uri, $TimeoutSec, $OutFile, $UseBasicParsing, $Proxy) ';
					if (failure.download === 'http404') { prefix = `${header}throw '(404) Not Found' }\n`; }
					else if (failure.download === 'corrupt') { prefix = `${header}Set-Content -LiteralPath $OutFile -Value 'not a tarball' }\n`; }
					else {
						const packageDir = path.join(dir, 'package');
						fs.mkdirSync(path.join(packageDir, 'facade-server'), { recursive: true });
						fs.writeFileSync(path.join(packageDir, 'facade-server', 'product.json'), JSON.stringify({ commit }));
						const archive = path.join(dir, 'missing-executable.tar.gz');
						const tar = spawnSync(systemTar(), ['-czf', archive, '-C', packageDir, 'facade-server'], { encoding: 'utf8' });
						assert.strictEqual(tar.status, 0, tar.stderr);
						prefix = `${header}Copy-Item -LiteralPath '${archive.replace(/'/g, "''")}' -Destination $OutFile }\n`;
					}
				}
				if ('lockStale' in failure || 'tokenFile' in failure && failure.tokenFile === 'locked') {
					const locked = 'lockStale' in failure ? failure.lockStale : 'token';
					const lockedPath = locked === 'product' ? path.join(installDir, 'product.json') : locked === 'script' ? path.join(installDir, 'bin', 'facade-server.cmd') : path.join(serverDataDir, `.${commit}.${locked}`);
					if (!fs.existsSync(lockedPath)) { fs.writeFileSync(lockedPath, locked === 'log' ? 'Extension host agent listening on 41001\n' : 'probe'); }
					prefix += `$testHold=[IO.File]::Open('${lockedPath.replace(/'/g, "''")}','Open','ReadWrite','${locked === 'log' ? 'Read' : 'None'}')\n`;
				}
				let setup = patchedPowerShell();
				if ('mutate' in failure) { setup = failure.mutate(setup); }
				const replacements: Record<string, string> = {
					SEND_ENV_VAR_LINES: '', ENV_VAR_LINES: '', DISTRO_VERSION: '1.138.0', DISTRO_COMMIT: commit,
					DISTRO_QUALITY: 'undefined', DISTRO_VSCODIUM_RELEASE: '0.1.2', MODIFY_PRODUCT_JSON: '$false',
					SERVER_APP_NAME: 'facade-server', SERVER_INITIAL_EXTENSIONS: '', SERVER_LISTEN_FLAG: '--port=0',
					SERVER_DATA_DIR: serverDataDir, SERVER_DATA_DIR_FLAG: '', SERVER_DOWNLOAD_URL: 'download' in failure && failure.download === 'badUrl' ? '://bad-url' : 'http://127.0.0.1:9/missing.tar.gz',
					SERVER_VALIDATION_FLAG: '', SERVER_CONNECTION_TOKEN: 'probe', SCRIPT_ID: scriptId,
				};
				for (const [key, value] of Object.entries(replacements)) { setup = setup.replaceAll(`%%${key}%%`, value); }
				assert.doesNotMatch(setup, /%%[A-Z_]+%%/);
				const file = path.join(dir, 'setup.ps1');
				fs.writeFileSync(file, prefix + setup);
				const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
					encoding: 'utf8', timeout: 20_000,
					env: { ...process.env, TEMP: tempDir, TMP: tempDir, PROCESSOR_ARCHITECTURE: 'arch' in failure ? failure.arch : 'AMD64', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '' },
				});
				assert.strictEqual(result.error, undefined, `${failure.name}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
				assert.ok(result.status === 0 || result.status === 1, `${failure.name}: incomplete PowerShell run (status ${result.status})`);
				assert.ok(result.stdout.includes(failure.expected), `${failure.name}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
				assert.strictEqual(result.stdout.split(`${scriptId}: start`).length - 1, 1, result.stdout);
				assert.match(result.stdout, /exitCode==[1-9][0-9]*==/);
				assert.strictEqual(result.stdout.split(`${scriptId}: end`).length - 1, 1, result.stdout);
				assert.doesNotMatch(result.stdout, /exitCode==0==/);
				if (!('lockBlocked' in failure)) {
					const lockFile = path.join(tempDir, 'facade-server-install.lock');
					if (fs.existsSync(lockFile)) { fs.closeSync(fs.openSync(lockFile, 'r+')); }
				}
			} finally {
				const tempRoot = fs.realpathSync(os.tmpdir());
				const target = fs.realpathSync(dir);
				assert.ok(target.startsWith(`${tempRoot}${path.sep}`));
				fs.rmSync(target, { recursive: true, force: true });
			}
		});
	}

	test('R5 Unix setup failure branches emit one result and cannot fall through to success', t => {
		const bash = process.platform === 'win32' ? gitBash : 'bash';
		if (!bash) { t.skip('no bash'); return; }
		const setup = patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'src/scripts/server-setup.sh', shellPatchFixture());
		const line = (starts: string) => {
			const found = setup.split('\n').find(each => each.startsWith(starts));
			assert.ok(found, starts);
			return found;
		};
		const block = (starts: string, ends: string) => {
			const from = setup.indexOf(starts);
			const to = setup.indexOf(ends, from + starts.length);
			assert.ok(from >= 0 && to > from, starts);
			return setup.slice(from, to);
		};
		const failures = [
			{ name: 'lock descriptor', code: line('  if ! exec 9<>'), preparation: '' },
			{ name: 'install directory', code: block('  mkdir -p "$SERVER_DIR"', '  tar -xOf'), preparation: 'mkdir() { return 1; }' },
			{ name: 'directory entry', code: line('  pushd "$SERVER_DIR"'), preparation: '' },
			{ name: 'tar integrity', code: block('  tar -xOf', '  tar -xf'), preparation: 'tar() { return 1; }' },
			{ name: 'tar extraction', code: block('  tar -xf', '  popd'), preparation: 'tar() { return 1; }' },
			{ name: 'directory exit', code: line('  popd >'), preparation: '' },
		];
		for (const failure of failures) {
			const result: import('child_process').SpawnSyncReturns<string> = spawnSync(bash, ['-c', [
				'SERVER_DIR=/dev/null/child; LOCKFILE=/dev/null/lock',
				'print_install_results_and_exit() { echo "shell-probe: start"; echo "exitCode==$1=="; echo "shell-probe: end"; exit 0; }',
				'rm() { :; }', failure.preparation, failure.code, 'echo reached-success-path',
			].join('\n')], { encoding: 'utf8', timeout: 5000 });
			const resultLines = result.stdout.trim().split(/\r?\n/).filter(each => each.startsWith('shell-probe: ') || each.startsWith('exitCode=='));
			assert.deepStrictEqual({ status: result.status, resultLines }, {
				status: 0, resultLines: ['shell-probe: start', 'exitCode==1==', 'shell-probe: end'],
			}, `${failure.name}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
			assert.doesNotMatch(result.stdout, /reached-success-path/, failure.name);
		}
	});

	test('R5 Windows server setup downloads through HTTP_PROXY when the URL is reachable only through that proxy', async t => {
		if (process.platform !== 'win32') {
			t.skip('PowerShell 5.1 runs on Windows');
			return;
		}
		const patched = patchedPowerShell();
		assert.strictEqual(patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'src/scripts/server-setup.ps1', patched), patched);
		const start = patched.indexOf('$REQUEST_ARGUMENTS = @{');
		const end = patched.indexOf('Invoke-RestMethod @REQUEST_ARGUMENTS') + 'Invoke-RestMethod @REQUEST_ARGUMENTS'.length;
		assert.ok(start >= 0 && end > start);
		const download = patched.slice(start, end).replace('TimeoutSec=20', 'TimeoutSec=3');
		const calls: string[] = [];
		const proxy = http.createServer((req, res) => {
			calls.push(req.url ?? '');
			res.end('via-proxy');
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-http-proxy-'));
		try {
			await new Promise<void>((resolve, reject) => proxy.once('error', reject).listen(0, '127.0.0.1', resolve));
			const address = proxy.address() as net.AddressInfo;
			const script = path.join(dir, 'download.ps1');
			const proxyUrl = `http://127.0.0.1:${address.port}`;
			const run = async (url: string, environment: Record<string, string>, stub = false) => {
				const intercept = stub ? [
					'function Invoke-RestMethod {',
					'  param($Uri, $TimeoutSec, $OutFile, $UseBasicParsing, $Proxy)',
					'  if($PSBoundParameters.ContainsKey("Proxy")) { "proxy=$Proxy" } else { "direct" }',
					'}',
				] : [];
				fs.writeFileSync(script, ['$ErrorActionPreference="Stop"', `$SERVER_DOWNLOAD_URL="${url}"`, ...intercept, download].join('\n'));
				const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:http_proxy|https_proxy|no_proxy)$/i.test(key)));
				return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
				const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
					cwd: dir,
					env: { ...env, ...environment },
				});
				let output = '';
				child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
				child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
				child.once('error', reject);
				child.once('exit', code => resolve({ code, output }));
				});
			};
			const result = await run('http://rm57.invalid/check', { HTTP_PROXY: proxyUrl });
			assert.strictEqual(result.code, 0, result.output);
			assert.deepStrictEqual(calls, ['http://rm57.invalid/check']);
			assert.strictEqual(fs.readFileSync(path.join(dir, 'vscode-server.tar.gz'), 'utf8'), 'via-proxy');
			assert.strictEqual((await run('https://rm57.invalid/check', { HTTPS_PROXY: proxyUrl }, true)).output.trim(), `proxy=${proxyUrl}`);
			assert.strictEqual((await run('https://rm57.invalid/check', { https_proxy: proxyUrl }, true)).output.trim(), `proxy=${proxyUrl}`);
			assert.strictEqual((await run('https://rm57.invalid/check', { HTTP_PROXY: proxyUrl }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', { http_proxy: proxyUrl }, true)).output.trim(), `proxy=${proxyUrl}`);
			assert.strictEqual((await run('http://rm57.invalid/check', { HTTPS_PROXY: proxyUrl }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', { HTTP_PROXY: proxyUrl, NO_PROXY: 'rm57.invalid' }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', { HTTP_PROXY: proxyUrl, NO_PROXY: 'other.invalid, .invalid' }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', { HTTP_PROXY: proxyUrl, NO_PROXY: 'other.invalid' }, true)).output.trim(), `proxy=${proxyUrl}`);
			assert.strictEqual((await run('http://[::1]/check', { HTTP_PROXY: proxyUrl, NO_PROXY: '::1' }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', { http_proxy: proxyUrl, no_proxy: '*' }, true)).output.trim(), 'direct');
			assert.strictEqual((await run('http://rm57.invalid/check', {}, true)).output.trim(), 'direct');
		} finally {
			await new Promise<void>(resolve => proxy.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 SSH setup uses each user\'s server directory for its flock lock when another user\'s shared lock cannot be opened', t => {
		const bash = process.platform === 'win32' ? gitBash : 'bash';
		if (!bash) {
			t.skip('no bash');
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-user-lock-'));
		try {
			const shared = path.join(dir, 'shared');
			const own = path.join(dir, 'user-two');
			fs.mkdirSync(path.join(shared, 'server_install.lock'), { recursive: true }); // a shared lock path this user cannot open as a file
			const setup = setupWithLock('src/scripts/server-setup.sh', '');
			const lockSetup = setup.slice(0, setup.indexOf('# SERVER_RUNNING_PROCESS'));
			const script = path.join(dir, 'lock.sh');
			fs.writeFileSync(script, [
				'set -e',
				`SERVER_DATA_DIR='${own.replace(/\\/g, '/')}'`,
				`TMP_DIR='${shared.replace(/\\/g, '/')}'`,
				lockSetup,
				'exec 9<>"$LOCKFILE"',
				'echo installed',
			].join('\n'));
			const result = spawnSync(bash, [script], { encoding: 'utf8' });
			assert.deepStrictEqual({ status: result.status, output: result.stdout.trim() }, { status: 0, output: 'installed' }, result.stderr);
			assert.strictEqual(fs.existsSync(path.join(own, '.install.flock')), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	/**
	 * Four setups at once, each run by `run` with its name and holding the lock a second; then one finding the lock held
	 * by a process that has ended, and one finding it held by a live process's id with another start - the id used again.
	 * How many held it, whether two ever held it at once, whether it was left behind, and whether the last two took it
	 * over at once.
	 */
	async function lockRuns(dir: string, lock: string, run: (name: string) => Promise<void>, ended: string, reused: string) {
		const log = path.join(dir, 'log');
		await Promise.all(['a', 'b', 'c', 'd'].map(run));
		const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
		let inside: string | undefined;
		let atOnce = false;
		for (const [what, name] of lines.map(line => line.split(' '))) {
			atOnce ||= what === 'in' ? inside !== undefined : inside !== name;
			inside = what === 'in' ? name : undefined;
		}
		const leftBehind = fs.existsSync(path.join(dir, lock));

		const heldBy = async (holder: string, name: string) => {
			fs.writeFileSync(log, '');
			fs.writeFileSync(path.join(dir, lock), holder);
			const started = Date.now();
			await run(name);
			return { log: fs.readFileSync(log, 'utf8').trim().split(/\r?\n/), promptly: Date.now() - started < 8000 };
		};
		return {
			held: lines.filter(line => line.startsWith('out ')).length,
			atOnce,
			leftBehind,
			ended: await heldBy(ended, 'e'),
			reused: await heldBy(reused, 'f'),
		};
	}

	test('R5 macOS setup holds the kernel install lock across concurrent connections, then reacquires it after a holder exits', async t => {
		if (process.platform !== 'darwin' || spawnSync('lockf', ['-h'], { stdio: 'pipe' }).error) {
			t.skip('macOS lockf');
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-setup-lock-'));
		try {
			const script = path.join(dir, 'setup.sh');
			fs.writeFileSync(script, [
				`SERVER_DATA_DIR='${dir.replace(/\\/g, '/')}'`,
				'print_install_results_and_exit() { echo "failed $1" >> "$SERVER_DATA_DIR/log"; exit 1; }',
				setupWithLock('src/scripts/server-setup.sh', 'echo "in $1" >> "$SERVER_DATA_DIR/log"; sleep 1; echo "out $1" >> "$SERVER_DATA_DIR/log"'),
			].join('\n'));
			const run = (name: string) => new Promise<void>(resolve => spawn('bash', [script, name], { stdio: 'ignore' }).on('exit', () => resolve()));

			assert.deepStrictEqual(await lockRuns(dir, '.install.flock', run, 'stale contents', 'another former holder'), {
				held: 4, atOnce: false, leftBehind: true,
				ended: { log: ['in e', 'out e'], promptly: true }, reused: { log: ['in f', 'out f'], promptly: true },
			});
			const patched = patchExtensionFile('jeanp413.open-remote-ssh', '0.5.0', 'src/scripts/server-setup.sh', shellPatchFixture());
			assert.ok(patched.includes('--accept-server-license-terms 9>&- &> $SERVER_LOGFILE &'), 'the long-lived server must not inherit the lock descriptor');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 Windows setup holds an exclusive OS lock until the server listens, even with four concurrent installers', async t => {
		if (process.platform !== 'win32') {
			t.skip('Windows PowerShell');
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-setup-lock-'));
		try {
			const setup = patchedPowerShell();
			assert.ok(setup.indexOf('# Facade Code: one setup at a time') < setup.indexOf('# Validate the commit of the installed server against the expected one (DISTRO_COMMIT)'), 'the lock must protect wrong-commit cleanup');
			const script = path.join(dir, 'setup.ps1');
			fs.writeFileSync(script, [
				'$NAME = $args[0]',
				'function printInstallResults($code) { Add-Content "$env:TEMP\\log" "failed $code" }',
				setupWithLock('src/scripts/server-setup.ps1', 'Add-Content "$env:TEMP\\log" "in $NAME"; Start-Sleep 1; Add-Content "$env:TEMP\\log" "out $NAME"'),
			].join('\n'));
			const env = { ...process.env, TEMP: dir, TMP: dir };
			const run = (name: string) => new Promise<void>(resolve => spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, name], { env, stdio: 'ignore' }).on('exit', () => resolve()));

			// Contents left by prior processes do not block a new exclusive handle.
			const ended = `${spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PID']).stdout.toString().trim()} 1`;

			assert.deepStrictEqual(await lockRuns(dir, 'facade-server-install.lock', run, ended, `${process.pid} 1`), {
				held: 4, atOnce: false, leftBehind: true,
				ended: { log: ['in e', 'out e'], promptly: true }, reused: { log: ['in f', 'out f'], promptly: true },
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 Windows setup opens a leftover empty install lock immediately after its owner exits', { skip: process.platform !== 'win32' }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-empty-windows-lock-'));
		try {
			const lock = path.join(dir, 'facade-server-install.lock');
			fs.writeFileSync(lock, '');
			const file = path.join(dir, 'empty-lock.ps1');
			fs.writeFileSync(file, [
				'function printInstallResults($code) { "exitCode==$code==" }',
				setupWithLock('src/scripts/server-setup.ps1', '"acquired"').replace('for($I = 1; $I -le 30; $I++)', 'for($I = 1; $I -le 3; $I++)').replace('    sleep 1', '    Start-Sleep -Milliseconds 1'),
			].join('\n'));
			const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
				encoding: 'utf8', timeout: 5000, env: { ...process.env, TEMP: dir, TMP: dir },
			});
			assert.deepStrictEqual({ status: result.status, output: result.stdout.trim() }, { status: 0, output: 'acquired' }, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
			assert.strictEqual(fs.existsSync(lock), true);
			fs.closeSync(fs.openSync(lock, 'r+'));
		} finally {
			const tempRoot = fs.realpathSync(os.tmpdir());
			const target = fs.realpathSync(dir);
			assert.ok(target.startsWith(`${tempRoot}${path.sep}`));
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	test('R5 a copy of the extension synced before its patch existed counts as out of date, and is synced again: a window run from the sources loads that copy as it is', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-patched-'));
		try {
			const copy = (contents: string | undefined) => {
				fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
				if (contents !== undefined) {
					fs.mkdirSync(path.join(dir, 'out'));
					fs.writeFileSync(path.join(dir, 'out', 'extension.js'), contents);
				}
				return isExtensionPatched('jeanp413.open-remote-wsl', '0.0.5', dir);
			};

			assert.deepStrictEqual({
				before: copy('a=t.workspace.workspaceFolders?.[0].uri'),
				patched: copy('a=t.workspace.workspaceFolders?.[0]?.uri'),
				missing: copy(undefined),
				// one without patches is as it is
				other: isExtensionPatched('ms-vscode.js-debug', '1.117.0', dir),
			}, { before: false, patched: true, missing: false, other: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 a built-in extension\'s synced copy counts as current only once written whole and patched: a sync cut short leaves its package.json alone, which its version would pass - and on 10-22 such a copy of open-remote-ssh went into a package', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-synced-'));
		try {
			const manifest = (version: string) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
			const current = (name: string, version: string, sha256: string) => isSyncedCopyCurrent(dir, name, version, `${version} ${sha256}`);

			// an extension without patches
			manifest('1.117.0');
			const cutShort = current('ms-vscode.js-debug', '1.117.0', 'aaaa');
			markSyncedCopy(dir, '1.117.0 aaaa');
			const whole = current('ms-vscode.js-debug', '1.117.0', 'aaaa');
			const otherVersion = current('ms-vscode.js-debug', '1.118.0', 'aaaa');
			// the same version pinned again to another package
			const otherChecksum = current('ms-vscode.js-debug', '1.117.0', 'bbbb');
			// written whole, but its patch missing
			fs.mkdirSync(path.join(dir, 'out'));
			fs.writeFileSync(path.join(dir, 'out', 'extension.js'), 'a=t.workspace.workspaceFolders?.[0].uri');
			manifest('0.0.5');
			markSyncedCopy(dir, '0.0.5 cccc');
			const unpatched = current('jeanp413.open-remote-wsl', '0.0.5', 'cccc');
			// a sync that wrote nothing - no package for this platform - leaves no folder to mark
			let nothingWritten = 'marked';
			try {
				markSyncedCopy(path.join(dir, 'gone'), '1.0.0 dddd');
				nothingWritten = fs.existsSync(path.join(dir, 'gone')) ? 'folder made' : 'nothing';
			} catch {
				nothingWritten = 'threw';
			}

			const sources = read('build/lib/builtInExtensions.ts');
			assert.deepStrictEqual({
				cutShort, whole, otherVersion, otherChecksum, unpatched, nothingWritten,
				wired: {
					checked: sources.includes('isSyncedCopyCurrent(getExtensionPath(extension), extension.name, extension.version, syncedStamp(extension))'),
					marked: sources.includes('markSyncedCopy(getExtensionPath(extension), syncedStamp(extension))'),
					stamp: sources.includes('return `${extension.version} ${extension.sha256 ?? \'\'}`;'),
					// the mark stays out of the package
					leftOut: sources.includes('`!${SYNCED_MARK}`'),
				},
			}, {
				cutShort: false, whole: true, otherVersion: false, otherChecksum: false, unpatched: false, nothingWritten: 'nothing',
				wired: { checked: true, marked: true, stamp: true, leftOut: true }
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R5 an extension is not packaged without its patched file: the files patched pass on changed, and a stream without that file fails', async () => {
		const run = (files: File[]) => new Promise<string[] | string>(resolve => {
			const out: string[] = [];
			es.readArray(files).pipe(patchExtension('jeanp413.open-remote-wsl', '0.0.5'))
				.on('data', (file: File) => out.push(`${file.relative.replace(/\\/g, '/')}: ${file.contents?.toString()}`))
				.on('error', (error: Error) => resolve(`error: ${error.message.includes('out/extension.js')}`))
				.on('end', () => resolve(out));
		});
		// A download's files come as streams, unpacked from the VSIX; a synced copy's as buffers
		const file = (relative: string, contents: string, streamed = false) => new File({ cwd: '/', base: '/x', path: `/x/${relative}`, contents: streamed ? Readable.from([Buffer.from(contents)]) : Buffer.from(contents) });

		assert.deepStrictEqual({
			synced: await run([file('jeanp413.open-remote-wsl/package.json', '{}'), file('jeanp413.open-remote-wsl/out/extension.js', 'a=t.workspace.workspaceFolders?.[0].uri')]),
			downloaded: await run([file('jeanp413.open-remote-wsl/package.json', '{}'), file('jeanp413.open-remote-wsl/out/extension.js', 'a=t.workspace.workspaceFolders?.[0].uri', true)]),
			without: await run([file('jeanp413.open-remote-wsl/package.json', '{}')]),
		}, {
			synced: ['jeanp413.open-remote-wsl/package.json: {}', 'jeanp413.open-remote-wsl/out/extension.js: a=t.workspace.workspaceFolders?.[0]?.uri'],
			downloaded: ['jeanp413.open-remote-wsl/package.json: {}', 'jeanp413.open-remote-wsl/out/extension.js: a=t.workspace.workspaceFolders?.[0]?.uri'],
			without: 'error: true',
		});
	});

	test('R5 product.json enables the SSH and WSL extensions\' proposed APIs, their remote menu entries and their use in Restricted Mode', () => {
		const product = JSON.parse(read('product.json'));

		assert.deepStrictEqual({
			proposals: product.extensionEnabledApiProposals,
			// neither declares untrusted workspace support, and each is its window's connection: without a default it is
			// disabled in a restricted window, and its view with it
			untrusted: product.extensionUntrustedWorkspaceSupport,
			tips: Object.fromEntries(Object.entries(product.remoteExtensionTips ?? {}).map(([id, tip]: [string, any]) => [id, {
				command: tip.startEntry?.startCommand,
				platforms: tip.supportedPlatforms ?? 'all',
			}])),
		}, {
			proposals: {
				'jeanp413.open-remote-ssh': ['resolvers', 'contribViewsRemote'],
				'jeanp413.open-remote-wsl': ['resolvers', 'contribViewsRemote'],
			},
			untrusted: {
				'jeanp413.open-remote-ssh': { default: true },
				'jeanp413.open-remote-wsl': { default: true },
			},
			tips: {
				'jeanp413.open-remote-ssh': { command: 'openremotessh.openEmptyWindow', platforms: 'all' },
				'jeanp413.open-remote-wsl': { command: 'openremotewsl.connect', platforms: ['Windows'] },
			},
		});
	});

	test('R6 the download address names the release\'s package, the release left for the extension to fill in', () => {
		const product = JSON.parse(read('product.json'));

		assert.deepStrictEqual({
			template: product.serverDownloadUrlTemplate,
			server: { application: product.serverApplicationName, dataFolder: product.serverDataFolderName },
			// the desktop and the server packages both carry the release version the address names
			stamped: ['build/gulpfile.vscode.ts', 'build/gulpfile.reh.ts']
				.map(file => read(file).includes('json.release = releaseVersion(product);')),
		}, {
			template: 'https://github.com/y5ez3g/facadecode/releases/download/facade/${release}/facade-server-${release}-${os}-${arch}.tar.gz',
			server: { application: 'facade-server', dataFolder: '.facade-server' },
			stamped: [true, true],
		});
	});

	test('R5 the SSH and WSL extensions are listed in ThirdPartyNotices.txt, each with its version, license and where it comes from', () => {
		const notices = read('ThirdPartyNotices.txt');
		const listed = (repository: string, version: string) => notices.includes(`jeanp413/${repository} ${version} - MIT`) && notices.includes(`https://github.com/jeanp413/${repository}`);

		assert.deepStrictEqual({ ssh: listed('open-remote-ssh', '0.5.0'), wsl: listed('open-remote-wsl', '0.0.5') }, { ssh: true, wsl: true });
	});

	test('R6 each desktop platform has a server package task that checks before it packs', () => {
		const reh = read('build/gulpfile.reh.ts');

		assert.deepStrictEqual({
			tarball: reh.includes('vscode-reh-${platform}-${arch}-server-tarball'),
			sign: reh.includes('vscode-reh-${platform}-${arch}-server-sign'),
			rehOnly: /if \(type === 'reh'\) \{\s*BUILD_TARGETS/.test(reh),
			// The task hands every check to `checkServerPackage`, whose refusals the tests below drive
			checks: [
				'checkServerPackage(serverDir, platform, {',
				'layout: () => serverLayoutProblems(serverDir, product.serverApplicationName, platform)',
				'versions: () => checkVersionFields(serverVersionFields(serverDir, release, packageJson.version, commit!))',
				'glibc: () => serverGlibcProblems(serverDir, arch)',
				'unsigned: () => serverSignedFiles(serverDir).filter(file => !hasValidSignature(file))',
			].map(check => reh.includes(check)),
		}, {
			tarball: true,
			sign: true,
			rehOnly: true,
			checks: [true, true, true, true, true],
		});
	});

	test('R6 a server is packaged only past every check its platform needs: a layout problem, a version that is not the release\'s, glibc above the baseline, an unsigned file, or a check not run each refuse it', () => {
		const clean = { layout: () => [], versions: () => { }, glibc: () => [], unsigned: () => [] };
		const refusal = (platform: string, checks: Parameters<typeof checkServerPackage>[2]) => {
			try {
				checkServerPackage('/build/server', platform, checks);
				return 'packaged';
			} catch (err) {
				return (err as Error).message.split('\n')[0];
			}
		};

		assert.deepStrictEqual({
			linux: refusal('linux', clean),
			darwin: refusal('darwin', { layout: clean.layout, versions: clean.versions }),
			win32: refusal('win32', clean),
			layout: refusal('linux', { ...clean, layout: () => ['bin/facade-server is missing'] }),
			version: refusal('win32', { ...clean, versions: () => { throw new Error('product.json: release is "0.1.1", not 0.1.2'); } }),
			glibc: refusal('linux', { ...clean, glibc: () => ['Error: File node has dependency on GLIBCXX > 3.4.25, found 3.4.29'] }),
			glibcNotRun: refusal('linux', { layout: clean.layout, versions: clean.versions }),
			unsigned: refusal('win32', { ...clean, unsigned: () => ['/build/server/node.exe'] }),
			signaturesNotChecked: refusal('win32', { layout: clean.layout, versions: clean.versions }),
		}, {
			linux: 'packaged',
			darwin: 'packaged',
			win32: 'packaged',
			layout: 'The server at /build/server is not what the extension expects:',
			version: 'product.json: release is "0.1.1", not 0.1.2',
			glibc: 'The Linux server is not within the glibc 2.28 baseline:',
			glibcNotRun: 'The Linux server is not within the glibc 2.28 baseline:',
			unsigned: 'The server has unsigned files; sign them first with the -server-sign task:',
			signaturesNotChecked: 'The server has unsigned files; sign them first with the -server-sign task:',
		});
	});

	test('R6 what upstream\'s glibc check prints as an error counts, the GLIBCXX ones it does not fail on included, and it reads the binaries with the sysroot\'s own objdump', () => {
		const output = [
			'Verifying requirements for files: /s/node /s/a.node',
			'Error: File /s/a.node has dependency on GLIBCXX > 3.4.25, found 3.4.29',
			'Error: File /s/node has dependency on GLIBC > 2.28, found 2.34',
		].join('\n');

		assert.deepStrictEqual({ problems: glibcProblems(output), x64: sysrootObjdump('/repo', 'x64'), arm64: sysrootObjdump('/repo', 'arm64') }, {
			problems: [
				'Error: File /s/a.node has dependency on GLIBCXX > 3.4.25, found 3.4.29',
				'Error: File /s/node has dependency on GLIBC > 2.28, found 2.34',
			],
			x64: path.join('/repo', '.build', 'sysroots', 'glibc-2.28-gcc-8.5.0', 'x86_64-linux-gnu', 'x86_64-linux-gnu', 'bin', 'objdump'),
			arm64: path.join('/repo', '.build', 'sysroots', 'glibc-2.28-gcc-8.5.0', 'aarch64-linux-gnu', 'aarch64-linux-gnu', 'bin', 'objdump'),
		});
	});

	test('R6 each file upstream\'s glibc check reads is read by objdump first, selected as its find selects them: native modules, but not those under prebuilds or @parcel/watcher\'s, and executable files named node, not a script of that name; and of those the ELF ones, not another OS\'s module an extension carries', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
			for (const file of ['node', 'node_modules/which/bin/node', 'node_modules/pty/build/Release/pty.node', 'node_modules/pty/prebuilds/linux-x64/pty.node', 'extensions/node_modules/@parcel/watcher/build/watcher.node', 'out/server-main.js', 'bin/facade-server']) {
				fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				fs.writeFileSync(path.join(dir, file), elf);
			}
			// js-debug's Windows module, in every platform's server as in its VSIX: a PE file, which Linux never loads
			fs.mkdirSync(path.join(dir, 'extensions/ms-vscode.js-debug/src'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-x64-msvc.node'), Buffer.from('MZ\x90\x00'));
			// What the mode says on Linux, where the check runs: the server's own node is executable, a script of that name is not
			const executable = (file: string) => path.relative(dir, file) === 'node';

			assert.deepStrictEqual(glibcCheckedFiles(dir, executable).map(file => path.relative(dir, file).split(path.sep).join('/')).sort(), ['node', 'node_modules/pty/build/Release/pty.node']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 a Windows server signs what upstream signs: its executables, native modules and PowerShell scripts, and nothing else', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			for (const file of ['node.exe', 'bin/facade-server.cmd', 'a.dll', 'pty.node', 'out/shellIntegration.ps1', 'm.psm1', 'm.psd1', 'f.ps1xml', 'readme.txt', 'out/main.js']) {
				fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				fs.writeFileSync(path.join(dir, file), '');
			}

			assert.deepStrictEqual(serverSignedFiles(dir).map(file => path.relative(dir, file).split(path.sep).join('/')).sort(), ['a.dll', 'f.ps1xml', 'm.psd1', 'm.psm1', 'node.exe', 'out/shellIntegration.ps1', 'pty.node']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 the server package is named for its release and platform, the release first as in the desktop assets', () => {
		assert.deepStrictEqual([
			serverPackageName('0.1.2', 'linux', 'x64'),
			serverPackageName('0.1.2', 'darwin', 'arm64'),
			serverPackageName('0.1.2', 'win32', 'x64'),
		], [
			'facade-server-0.1.2-linux-x64.tar.gz',
			'facade-server-0.1.2-darwin-arm64.tar.gz',
			'facade-server-0.1.2-win32-x64.tar.gz',
		]);
	});

	test('R6 the version check reads the server\'s release, engine and commit', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ release: '0.1.2', facadeVersion: '0.1.2', version: '1.138.0', commit: 'abc123' }));
			fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.138.0' }));

			assert.deepStrictEqual(
				serverVersionFields(dir, '0.1.2', '1.138.0', 'abc123').map(field => `${field.artifact} ${field.field} ${field.found}`),
				[
					'product.json release 0.1.2',
					'product.json facadeVersion 0.1.2',
					'product.json version 1.138.0',
					'product.json commit abc123',
					'package.json version 1.138.0',
				]);
			assert.throws(() => checkVersionFields(serverVersionFields(dir, '0.1.3', '1.138.0', 'abc123')), /product\.json: release is "0\.1\.2", not 0\.1\.3/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 a server without the launcher the extension starts, what that launcher runs, or facade-agents, is not packaged', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			// the target platform names the launcher and its Node, whatever this machine runs
			assert.deepStrictEqual({
				win32: serverLayoutProblems(dir, 'facade-server', 'win32'),
				linux: serverLayoutProblems(dir, 'facade-server', 'linux'),
			}, {
				win32: [
					'bin/facade-server.cmd is missing: the extension starts the server through it',
					'node.exe is missing: the launcher runs the server with it',
					'out/server-main.js is missing: the launcher starts the server with it',
					'extensions/facade-agents is missing: the server carries the workspace-side built-ins',
				],
				linux: [
					'bin/facade-server is missing: the extension starts the server through it',
					'node is missing: the launcher runs the server with it',
					'out/server-main.js is missing: the launcher starts the server with it',
					'extensions/facade-agents is missing: the server carries the workspace-side built-ins',
				],
			});

			fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'bin', 'facade-server'), '');
			fs.writeFileSync(path.join(dir, 'bin', 'facade-server.cmd'), '');
			fs.writeFileSync(path.join(dir, 'node'), '');
			fs.writeFileSync(path.join(dir, 'node.exe'), '');
			fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'out', 'server-main.js'), '');
			fs.mkdirSync(path.join(dir, 'extensions', 'facade-agents'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'extensions', 'facade-agents', 'package.json'), '{}');

			assert.deepStrictEqual([serverLayoutProblems(dir, 'facade-server', 'win32'), serverLayoutProblems(dir, 'facade-server', 'linux')], [[], []]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 the Windows server packages its remote CLI for Git Bash too, beside the .cmd, under the bare name', () => {
		const win32 = read('build/gulpfile.reh.ts').split(`if (platform === 'win32') {`)[1]?.split('} else if')[0] ?? '';

		assert.deepStrictEqual({
			cmd: win32.includes(`gulp.src('resources/server/bin/remote-cli/code.cmd'`) && win32.includes('.pipe(rename(`bin/remote-cli/${product.applicationName}.cmd`))'),
			posix: win32.includes(`gulp.src('resources/server/bin/remote-cli/code-win32.sh'`) && win32.includes('.pipe(rename(`bin/remote-cli/${product.applicationName}`))'),
		}, { cmd: true, posix: true });
	});

	test('R6 the Windows server\'s remote CLI runs from Git Bash with the server\'s own Node, its arguments as typed', { skip: !gitBash }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			// A server's layout: the script in bin/remote-cli, its Node at the top, a CLI that says what it was given
			fs.mkdirSync(path.join(dir, 'bin', 'remote-cli'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'out'));
			const script = read('resources/server/bin/remote-cli/code-win32.sh').replace(/@@APPNAME@@/g, 'facade').replace(/@@VERSION@@/g, '1.138.0').replace(/@@COMMIT@@/g, 'abc123');
			fs.writeFileSync(path.join(dir, 'bin', 'remote-cli', 'facade'), script);
			fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
			// The CLI resolves a relative path against PWD, which the shell keeps in its own form
			fs.writeFileSync(path.join(dir, 'out', 'server-cli.js'), 'console.log(JSON.stringify({ cli: process.argv[1].replace(/\\\\/g, "/"), pwd: process.env.PWD, args: process.argv.slice(2) }));');
			const from = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-cwd-'));

			const run = spawnSync(gitBash!, ['-c', `cd "$(cygpath -u "$1")" && "$(cygpath -u "$2")" README.md 'two words'`, 'bash', from, path.join(dir, 'bin', 'remote-cli', 'facade')], { encoding: 'utf8' });
			const output = JSON.parse(run.stdout || '{}');

			assert.deepStrictEqual({ status: run.status, cli: output.cli, pwd: output.pwd && path.resolve(output.pwd).toLowerCase(), args: output.args }, {
				status: 0,
				cli: path.join(dir, 'out', 'server-cli.js').replace(/\\/g, '/'),
				pwd: fs.realpathSync(from).toLowerCase(),
				args: ['facade', '1.138.0', 'abc123', 'facade', 'README.md', 'two words'],
			});
			fs.rmSync(from, { recursive: true, force: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 the Linux server runs in a session of its own, its input nothing, under the process id and command it was started with: what started it - the WSL extension\'s wsl.exe, a child of the window\'s extension host - can end without taking it, its terminals and agents along, and both extensions still find it running (REMOTE.md R6)', { skip: !linuxShell }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-launcher-'));
		try {
			fs.writeFileSync(path.join(dir, 'launcher'), read('resources/server/bin/code-server-linux.sh').replace(/\r\n/g, '\n'));
			// The server's layout in the shell's own temporary folder, its Node a stand-in that says where it runs; started as
			// both extensions start it, in the background of a script that keeps its process id
			fs.writeFileSync(path.join(dir, 'run.sh'), [
				'set -e',
				'root="$(mktemp -d)"',
				'mkdir -p "$root/bin" "$root/out"',
				`cp '${linuxPath(path.join(dir, 'launcher'))}' "$root/bin/facade-server"`,
				'printf \'#!/bin/sh\\necho "launcher=$PPID session=$(ps -o sid= -p $PPID | tr -d " ") input=$(readlink /proc/$$/fd/0) marker=${FACADE_SERVER_SESSION:-none} args=$*"\\n\' > "$root/node"',
				'chmod +x "$root/bin/facade-server" "$root/node"',
				'"$root/bin/facade-server" --start-server --host=127.0.0.1 > "$root/log" 2>&1 &',
				'echo "started=$!"',
				'wait',
				'cat "$root/log"',
				'rm -rf "$root"',
				''
			].join('\n'));

			const run = spawnSync(linuxShell![0], [...linuxShell!.slice(1), linuxPath(path.join(dir, 'run.sh'))], { encoding: 'utf8' });
			const said = Object.fromEntries([...run.stdout.matchAll(/(?<name>\w+)=(?<value>\S+)/g)].map(match => [match.groups!.name, match.groups!.value]));

			assert.deepStrictEqual({ status: run.status, sameProcess: said.launcher === said.started, ownSession: said.session === said.started, input: said.input, marker: said.marker }, {
				status: 0, sameProcess: true, ownSession: true, input: '/dev/null', marker: 'none'
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 the tarball holds one top-level folder with the server inside', { skip: !hasTar }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-server-'));
		try {
			const serverDir = path.join(dir, 'vscode-reh-linux-x64');
			fs.mkdirSync(path.join(serverDir, 'bin'), { recursive: true });
			fs.writeFileSync(path.join(serverDir, 'bin', 'facade-server'), '');
			const top = serverTopFolderName('0.1.2', 'linux', 'x64');
			const tarball = path.join(dir, serverPackageName('0.1.2', 'linux', 'x64'));

			createServerTarball(serverDir, tarball, top);

			const listed = spawnSync(systemTar(), ['-tzf', tarball], { encoding: 'utf8' });
			assert.strictEqual(listed.status, 0);
			assert.deepStrictEqual(String(listed.stdout).trim().split(/\r?\n/).sort(), [`${top}/`, `${top}/bin/`, `${top}/bin/facade-server`]);
			// the build is left as it was found
			assert.ok(fs.existsSync(path.join(serverDir, 'bin', 'facade-server')));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('R6 the Linux server is checked against the glibc 2.28 baseline', () => {
		assert.deepStrictEqual(glibcCheckEnv('/repo', '/repo/../vscode-reh-linux-x64', 'x64'), {
			SEARCH_PATH: '/repo/../vscode-reh-linux-x64',
			VSCODE_ARCH: 'x64',
			EXPECTED_GLIBC_VERSION: '2.28',
			EXPECTED_GLIBCXX_VERSION: '3.4.25',
			VSCODE_SYSROOT_DIR: path.join('/repo', '.build', 'sysroots', 'glibc-2.28-gcc-8.5.0'),
		});
	});
});
