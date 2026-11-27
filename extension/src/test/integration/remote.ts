/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the integration journeys in remote windows (VERIFICATION G1, G5, J15) in an isolated official VS Code on this computer, with
// Remote-SSH and Dev Containers in an extensions folder of the run's own. An SSH host is one of an SSH configuration file the
// person gives, reachable with no prompt - a key, an agent or a running master connection - running Linux, macOS or Windows, with
// Node and Git, and this extension built there with `npm ci`, `npm run compile`, `npm run bundle` and
// `node scripts/build-it.mjs`; the editor's server goes in a folder of the run's own there. A container host is a container the
// run starts with this computer's Docker, on Linux, from an image with Node, Git and its user `node` - such as `node:24` - this
// extension's folder, built here, mounted at its own path; the editor attaches to it as Dev Containers' Attach to Running
// Container does, and its server goes in the container.
//
// Facade Code Extension's root, Claude Code's configuration and the fake CLIs' records are the run's own on every computer, at one path they all
// resolve, `/tmp/fdrt-…` - on Windows `\tmp\fdrt-…` of the system drive - as the editor gives its extension hosts, local and
// remote, one environment. FACADE_IT_REMOTE_ROOT names another folder for it, the same on every computer, such as /var/tmp for a
// host whose /tmp is short of room. Scenarios, each on every host - a container's remote window standing for the SSH window:
//
//   ssh        the journeys of one window, in an SSH window
//   ssh-ssh    an agent of an SSH window works with an agent of another SSH window on the same host
//   local-ssh  an agent of a local window works with an agent of an SSH window
//   ssh-local  an agent of an SSH window works with an agent of a local window
//   ssh-lifetime  a Facade Code Framework agent keeps its process and screen through the SSH window's lifecycle
//   ssh-multi-window  two Facade Code Framework editor windows share one Facade home on an SSH host
//   ssh-network  two Facade Code Framework Remote-SSH windows attach to one local agent over an explicit SSH connection
//
// and, given two hosts, `hosts`: an agent of an SSH window on the first works with an agent of an SSH window on the second.
//
// FACADE_IT_SSH_CONFIG names the SSH configuration file, FACADE_IT_SSH_HOST its hosts and FACADE_IT_REMOTE_EXTENSION the
// extension's folder on each, in the same order, separated by commas; FACADE_IT_CONTAINER names the image of a container host.
// FACADE_IT_ONLY runs one scenario and FACADE_IT_KEEP keeps what the run left on every computer, a container included.

import { resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as assert from 'assert';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { DaemonOperations, InspectResult } from '../../base/frameworkProtocol';
import { callInFramework, frameworkCall, detachedStartReference, EDITOR_FLAGS, editorBuildCommit, editorProfile, endFramework, endEditors, fakeClis, newRepository, officialEditor, registeredWindow, sanitizedEnvironment, testProcessCleanup, until } from './editors';
import { checkClosedAgent, lifetimeDriverFiles, windowLifetime } from './windowLifetime';
import { multiWindowDriverFiles, frameworkMultiWindow, withFrameworkWindows } from './frameworkMultiWindow';

const SCENARIOS = ['ssh', 'ssh-ssh', 'local-ssh', 'ssh-local', 'hosts', 'ssh-lifetime', 'ssh-multi-window', 'ssh-network', 'ssh-connect'] as const;
type Scenario = typeof SCENARIOS[number];

/** A computer the run reaches over SSH, or a container it starts, as the editor and the run address it. */
interface Host {
	readonly kind: 'ssh' | 'container';
	readonly alias: string;
	/** What a scenario's title says of it. */
	readonly title: string;
	/** As Remote-SSH names it: `linux`, `macOS` or `windows`. */
	readonly platform: string;
	/** The extension's build folder there, with forward slashes. */
	readonly build: string;
	/** The fake CLI there. */
	readonly fake: string;
	/** A path of the run's root, as that host writes it. */
	at(file: string): string;
	/** The editor's address of a path there: one of the run's root, or one with a drive of its own on Windows. */
	uri(file: string): string;
	/** Runs `script` there - with its POSIX shell, or PowerShell on Windows - never asking for a password. */
	run(script: string): string;
}

/** A folder a window opens: on this computer, or on a host. */
type Folder = { readonly local: string } | { readonly host: Host; readonly remote: string };

/** The values of `name`, separated by commas; none where it is not set. */
function listed(name: string): string[] {
	return (process.env[name] ?? '').split(',').map(each => each.trim()).filter(Boolean);
}

function required(name: string, what: string): string[] {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Set ${name} to ${what}.`);
	}
	return value.split(',').map(each => each.trim()).filter(Boolean);
}

/** `value` as one word of a POSIX shell command. */
function quoted(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `value` as one literal of PowerShell. */
function literal(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

/** Why `err`, an SSH command's failure, failed: what the host said, else its message. */
function failureOf(err: unknown): string {
	return (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
}

async function main(): Promise<void> {
	if (process.platform === 'win32') {
		throw new Error('The Remote-SSH journeys run from macOS or Linux: their temporary root is one path on every computer.');
	}
	const executable = officialEditor();
	const aliases = listed('FACADE_IT_SSH_HOST');
	const image = process.env.FACADE_IT_CONTAINER;
	if (!aliases.length && !image) {
		throw new Error('Set FACADE_IT_SSH_HOST to the SSH hosts, FACADE_IT_CONTAINER to a container host\'s image, or both.');
	}
	const config = aliases.length ? path.resolve(required('FACADE_IT_SSH_CONFIG', 'the SSH configuration file that defines the hosts')[0]) : '';
	const folders = aliases.length ? required('FACADE_IT_REMOTE_EXTENSION', 'the absolute path of this extension\'s folder on each host, in the same order') : [];
	if (aliases.length !== folders.length || aliases.length + (image ? 1 : 0) > 2) {
		throw new Error('Give one or two hosts, and the extension\'s folder on each SSH host.');
	}
	// A Linux computer's own Docker, or a VM's that mounts this computer's home (DOCKER_HOST names it), as a Mac's colima does
	if (image && process.platform !== 'linux' && !process.env.DOCKER_HOST) {
		throw new Error('A container host is started with this computer\'s Docker, from Linux.');
	}
	const only = process.env.FACADE_IT_ONLY;
	if (only && !SCENARIOS.includes(only as Scenario)) {
		throw new Error(`FACADE_IT_ONLY is one of ${SCENARIOS.join(', ')}.`);
	}
	const keep = !!process.env.FACADE_IT_KEEP;
	// Facade Code Framework is the current runtime. Use the legacy mode with a checkout of a legacy build.
	const implementation = process.env.FACADE_IT_IMPLEMENTATION ?? 'framework';
	if (implementation !== 'legacy' && implementation !== 'framework') {
		throw new Error('FACADE_IT_IMPLEMENTATION is legacy or framework.');
	}
	const connectOnly = only === 'ssh-connect';
	const attempt = process.env.FACADE_IT_REMOTE_ATTEMPT;
	if (connectOnly && !/^[0-9a-f]{64}$/u.test(attempt ?? '')) {
		throw new Error('Select this proof with ci/check_remote_editor.sh to bind its inputs and attempt.');
	}
	const pinnedVsix = listed('FACADE_IT_REMOTE_VSIXS');
	const remoteServerTar = process.env.FACADE_IT_REMOTE_SERVER_TAR;
	const commit = connectOnly ? editorBuildCommit(executable, '1.147.0') : undefined;
	if (connectOnly && (aliases.length !== 1 || image || pinnedVsix.length !== 3 || !pinnedVsix.every(file => path.isAbsolute(file) && fs.existsSync(file))
		|| !remoteServerTar?.startsWith('/'))) {
		throw new Error('The SSH connect fixture needs one SSH host, three pinned local VSIXs and the pinned remote server tar.');
	}

	const frameworkOnly = connectOnly || only === 'ssh-lifetime' || only === 'ssh-multi-window' || only === 'ssh-network';
	if (frameworkOnly && (implementation !== 'framework' || !aliases.length)) {
		throw new Error(`The ${only} journey needs the Facade Code Framework and an SSH host.`);
	}
	const base = process.env.FACADE_IT_REMOTE_ROOT || '/tmp';
	// Read before this: it removes every variable of Facade Code Extension's and of the CLIs' from this process
	sanitizedEnvironment();

	// One path on every computer: short, for the editor's sockets, and made anew on each
	const root = fs.mkdtempSync(path.posix.join(base, 'fdrt-'));
	const endMatching = testProcessCleanup(root);
	const name = path.basename(root);
	const facade = `${root}/facade`;
	const claude = `${root}/claude`;
	const record = `${root}/fake-cli.log`;

	const hosts: Host[] = aliases.map((alias, index) => {
		const ssh = (command: string[], input?: string) => execFileSync('ssh', ['-F', config, '-o', 'BatchMode=yes', alias, ...command], { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		let windows: boolean;
		try {
			windows = ssh(['echo %OS%']).trim() === 'Windows_NT';
		} catch (err) {
			throw new Error(`${alias} cannot be reached with no prompt: ${failureOf(err)}`);
		}
		const extension = folders[index].replace(/\\/g, '/');
		const build = `${extension}/build`;
		if (windows) {
			// PowerShell, given the whole script encoded - from its standard input it would take it line by line - and printing no progress
			const run = (script: string) => ssh(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')]);
			const drive = run('$env:SystemDrive').trim();
			const at = (file: string) => `${drive}${file.replace(/\//g, '\\')}`;
			// The run's root on the system drive, as Node there resolves `/tmp/…`; a path with a drive of its own keeps it
			const uri = (file: string) => `vscode-remote://ssh-remote+${alias}/${/^[A-Za-z]:/.test(file) ? `${file[0].toLowerCase()}${file.slice(1)}` : `${drive.toLowerCase()}${file}`}`;
			return { kind: 'ssh', alias, title: `${alias}, windows`, platform: 'windows', build, fake: at(`${root}/fake-cli.cmd`), at, uri, run };
		}
		const run = (script: string) => ssh(['sh -s'], script);
		let platform: string;
		try {
			platform = ({ Linux: 'linux', Darwin: 'macOS' } as { readonly [uname: string]: string })[run('uname -s').trim()] ?? '';
		} catch (err) {
			throw new Error(`${alias} cannot run the journeys: ${failureOf(err)}`);
		}
		if (!platform) {
			throw new Error(`${alias} runs neither Linux, macOS nor Windows.`);
		}
		return {
			kind: 'ssh', alias, title: `${alias}, ${platform}`, platform, build, fake: `${root}/fake-cli`,
			at: file => file, uri: file => `vscode-remote://ssh-remote+${alias}${file}`, run
		};
	});
	if (image) {
		// The container, its user `node`'s, with this extension's folder - built here - at its own path, read only
		const folder = path.resolve(__dirname, '..', '..', '..', '..');
		const alias = `${name}-container`;
		try {
			// On the Facade Code Framework the stage's bin/ holds this computer's framework, which the container cannot run: FACADE_IT_REMOTE_BIN names a folder
			// of framework's programs built for the container's platform, which the container sees in its place
			const linuxFramework = process.env.FACADE_IT_REMOTE_BIN ? ['--volume', `${path.resolve(process.env.FACADE_IT_REMOTE_BIN)}:${folder}/build/extension-it/bin:ro`] : [];
			execFileSync('docker', ['run', '--detach', '--name', alias, '--user', 'node', '--volume', `${folder}:${folder}:ro`, ...linuxFramework, image, 'sleep', 'infinity'], { stdio: 'pipe' });
		} catch (err) {
			throw new Error(`A container of ${image} could not be started: ${failureOf(err)}`);
		}
		const run = (script: string) => execFileSync('docker', ['exec', '--interactive', alias, 'sh', '-s'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
		// As Attach to Running Container addresses it: its name, as Docker lists it, in hex-encoded JSON
		const authority = `attached-container+${Buffer.from(JSON.stringify({ containerName: `/${alias}` })).toString('hex')}`;
		hosts.push({
			kind: 'container', alias, title: `${image} container`, platform: 'linux', build: `${folder}/build`, fake: `${root}/fake-cli`,
			at: file => file, uri: file => `vscode-remote://${authority}${file}`, run
		});
	}

	const extension = path.resolve(__dirname, '..', '..', '..', 'extension-it');
	const windowComponent = path.resolve(__dirname, '..', '..', '..', 'window');
	const extensions = path.join(root, 'x');
	const local = { app: path.join(root, 'local-app'), peer: path.join(root, 'local-peer') };
	const editors: ChildProcess[] = [];
	const server = (host: Host) => host.at(`${root}/server`);

	// Every built-in points to a fake on every computer, in the Facade Code Extension settings file of each, written again with each new Facade Code Extension root:
	// the run never starts a person's real CLI (CONFIGURATION-1.1)
	const BUILT_INS = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'];
	const facadeSettings = (fake: string) => JSON.stringify({ clis: Object.fromEntries(BUILT_INS.map(id => [id, { command: fake }])) });
	const localFake = path.join(root, 'fake-cli');
	const localSettings = () => fs.writeFileSync(path.join(facade, 'facade.json'), facadeSettings(localFake), { mode: 0o600 });
	const settings = {
		'security.workspace.trust.enabled': false,
		'terminal.integrated.enablePersistentSessions': false,
		'window.restoreWindows': 'none',
		'workbench.startupEditor': 'none',
		'update.mode': 'none',
		...(implementation === 'legacy' ? { 'facade.framework': 'off' } : {}),
		'extensions.autoUpdate': false,
		'extensions.autoCheckUpdates': false,
		'telemetry.telemetryLevel': 'off',
		...config ? { 'remote.SSH.configFile': config } : {},
		'remote.SSH.serverInstallPath': Object.fromEntries(hosts.filter(host => host.kind === 'ssh').map(host => [host.alias, server(host)])),
		'remote.SSH.remotePlatform': Object.fromEntries(hosts.filter(host => host.kind === 'ssh').map(host => [host.alias, host.platform])),
		'remote.SSH.showLoginTerminal': false,
		'remote.SSH.enableRemoteCommand': false,
		...connectOnly ? { 'remote.SSH.useExecServer': false, 'remote.SSH.localServerDownload': 'off', 'remote.SSH.useLocalServer': false } : {}
	};
	/** A user data folder of the run's own for one editor, new for each scenario: what an earlier one kept there is not this one's. */
	const profile = (editor: string) => {
		const local = editorProfile(root, `u-${editor}`, extensions);
		const { user } = local;
		fs.rmSync(user, { recursive: true, force: true });
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		if (hosts.some(host => host.kind === 'container')) {
			// Dev Containers asks in a dialog - which a test editor refuses - whether to attach to a container, unless its state has the
			// person's earlier yes: the run's own editor has it, as one would that attached before
			fs.mkdirSync(path.join(user, 'User', 'globalStorage'), { recursive: true });
			const state = new DatabaseSync(path.join(user, 'User', 'globalStorage', 'state.vscdb'));
			state.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
			state.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('ms-vscode-remote.remote-containers', JSON.stringify({ userConfirmedAttachToContainerRequiresTrust: true }));
			state.close();
		}
		return local;
	};
	/** What the editor gives its extension hosts, local and remote, with this scenario's own. */
	const environment = (more: { readonly [variable: string]: string } = {}) => ({ FACADE_IT_IMPLEMENTATION: implementation, FACADE_HOME: facade, CLAUDE_CONFIG_DIR: claude, FACADE_IT_RECORD: record, ...more });
	const opened = (folder: Folder) => 'local' in folder ? [folder.local] : ['--folder-uri', folder.host.uri(folder.remote)];
	const workspaceExtension = (folder: Folder) => 'local' in folder ? extension : folder.host.uri(`${folder.host.build}/extension-it`);

	/**
	 * Ends what the run left on `host` - the editor's server, the ptyds, their agents - and its fake CLIs' records there; then its
	 * root where asked, else a new Facade Code Extension root and Claude Code configuration for the next scenario: the records, registry and
	 * remembered locations of one never reach the next.
	 */
	const clean = (host: Host, removeRoot: boolean) => host.kind === 'container' ? cleanContainer(host, removeRoot) : host.run(host.platform === 'windows'
		? `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${literal(name)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Remove-Item -Force -ErrorAction SilentlyContinue -Path ${literal(`${host.at(record)}.*`)}
${removeRoot ? `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ${literal(host.at(root))}` : `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ${literal(host.at(facade))}, ${literal(host.at(claude))}
New-Item -ItemType Directory -Force -Path ${literal(host.at(facade))}, ${literal(host.at(claude))} | Out-Null
[IO.File]::WriteAllText(${literal(host.at(`${facade}/facade.json`))}, ${literal(facadeSettings(host.fake))})`}`
		: `pkill -TERM -f ${quoted(name)}; sleep 0.5; rm -f ${quoted(record)}.*; ${removeRoot ? `rm -rf ${quoted(root)};` : `rm -rf ${quoted(facade)} ${quoted(claude)}; mkdir -m 700 ${quoted(facade)} ${quoted(claude)}; (umask 077; printf '%s' ${quoted(facadeSettings(host.fake))} > ${quoted(`${facade}/facade.json`)});`} true`);

	/**
	 * A container's clean: every process in it but its first - the editor's server, the ptyds, their agents - and the fake CLIs'
	 * records, then a new Facade Code Extension root and Claude Code configuration; or the container itself, where its root goes too.
	 */
	const cleanContainer = (host: Host, removeRoot: boolean) => {
		if (removeRoot) {
			return execFileSync('docker', ['rm', '--force', host.alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		}
		return host.run(`kill -TERM -1 2>/dev/null; sleep 0.5; rm -f ${quoted(record)}.*; rm -rf ${quoted(facade)} ${quoted(claude)}; mkdir -m 700 ${quoted(facade)} ${quoted(claude)}; (umask 077; printf '%s' ${quoted(facadeSettings(host.fake))} > ${quoted(`${facade}/facade.json`)}); true`);
	};

	try {
		fs.mkdirSync(facade, { mode: 0o700 });
		fs.mkdirSync(claude, { mode: 0o700 });
		localSettings();
		fakeClis(root);
		newRepository(local.app);
		newRepository(local.peer);
		// Each host's half: the same root, its Facade Code Extension settings file pointing to its fake, and two repositories
		for (const host of hosts) {
			try {
				host.run(host.platform === 'windows' ? `
foreach ($file in ${literal(`${host.build}/extension-it/package.json`)}, ${literal(`${host.build}/out/test/integration/index.js`)}) {
	if (-not (Test-Path -LiteralPath $file)) { throw "$file is missing" }
}
$root = ${literal(host.at(root))}
New-Item -ItemType Directory -Force -Path $root, "$root\\facade", "$root\\claude" | Out-Null
[IO.File]::WriteAllText("$root\\facade\\facade.json", ${literal(facadeSettings(host.fake))})
# Its paths by name: Windows PowerShell drops the double quotes of an argument it gives a program
$env:FACADE_IT_EDITORS = ${literal(`${host.build}/out/test/integration/editors.js`)}
$env:FACADE_IT_FAKE_ROOT = $root
& node -e 'require(process.env.FACADE_IT_EDITORS).fakeClis(process.env.FACADE_IT_FAKE_ROOT)'
if ($LASTEXITCODE) { throw 'The fake CLI could not be made.' }
foreach ($repo in 'app', 'remote-peer') {
	git init -q -b main "$root\\$repo"
	git -C "$root\\$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m first
}
` : `set -e
umask 077
for file in ${quoted(`${host.build}/extension-it/package.json`)} ${quoted(`${host.build}/out/test/integration/index.js`)}; do
	test -f "$file" || { echo "$file is missing" >&2; exit 1; }
done
node=$("\${SHELL:-sh}" -lc 'command -v node' 2>/dev/null || command -v node)
mkdir ${quoted(root)}
cd ${quoted(root)}
mkdir facade claude
printf '%s' ${quoted(facadeSettings(host.fake))} > facade/facade.json
printf '#!/bin/sh\\nexec %s %s "$@"\\n' "'$node'" ${quoted(quoted(`${host.build}/out/test/integration/fakeCli.js`))} > fake-cli
chmod 755 fake-cli
for repo in app remote-peer; do
	mkdir "$repo"
	git -C "$repo" init -q -b main
	git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m first
done
`);
				if (connectOnly) {
					assert.strictEqual(host.platform, 'linux');
					const installed = `${server(host)}/.vscode-server/bin/${commit}`;
					const metadata = host.run(`set -e
umask 077
mkdir -p ${quoted(installed)}
tar -xzf ${quoted(remoteServerTar!)} --strip-components=1 -C ${quoted(installed)}
node -p ${quoted(`JSON.stringify(require(${JSON.stringify(installed + '/product.json')}))`)}`);
					assert.strictEqual((JSON.parse(metadata) as { commit: string }).commit, commit);
				}

				// A machine setting belongs to the remote server, before its first extension activation.
				if (implementation === 'legacy' && host.platform !== 'windows') {
					const qaMachine = host.kind === 'container'
						? '/home/node/.vscode-server/data/Machine/settings.json'
						: `${server(host)}/.vscode-server/data/Machine/settings.json`;
					const qaValue = 'off';
					const qaText = JSON.stringify({ 'facade.framework': qaValue });
					const qaNode = "const fs=require('fs'),crypto=require('crypto');const p=process.argv[1],s=fs.readFileSync(p,'utf8');console.log(JSON.stringify({path:p,sha256:crypto.createHash('sha256').update(s).digest('hex'),settings:JSON.parse(s)}))";
					const qaReadback = host.run(`set -e
umask 077
mkdir -p ${quoted(path.posix.dirname(qaMachine))}
printf '%s' ${quoted(qaText)} > ${quoted(qaMachine)}
node=$("\${SHELL:-sh}" -lc 'command -v node' 2>/dev/null || command -v node)
"$node" -e ${quoted(qaNode)} ${quoted(qaMachine)}
`);
					console.log('QA_MACHINE_PRESET ' + JSON.stringify({ host: host.alias, file: qaMachine, value: qaValue, readback: qaReadback.trim() }));
				}
			} catch (err) {
				throw new Error(`${host.alias} cannot run the journeys: ${failureOf(err)}. It needs Node and Git, and the extension built for the suite in ${host.build}.`);
			}
		}
		// Remote-SSH and Dev Containers, as the hosts need them, in the run's own extensions folder, from the Marketplace
		const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
		const remotes = [...new Set(hosts.map(host => host.kind === 'ssh' ? 'ms-vscode-remote.remote-ssh' : 'ms-vscode-remote.remote-containers'))];
		const installProfile = profile('install');
		const stagedRemotes = connectOnly ? [...pinnedVsix.flatMap(file => ['--install-extension', file]), '--do-not-include-pack-dependencies']
			: remotes.flatMap(id => ['--install-extension', id]);
		execFileSync(cli, [...cliArgs, ...installProfile.args, ...stagedRemotes],
			{ env: { ...process.env, ...installProfile.env, FACADE_HOME: facade }, stdio: 'inherit' });

		/** An editor of the run that runs no tests, on `folder`; closed with the scenario. */
		const editor = (editorName: string, folder: Folder) => {
			const local = profile(editorName);
			const child = spawn(executable, [...opened(folder), '--new-window', ...local.args, `--extensionDevelopmentPath=${workspaceExtension(folder)}`,
				`--extensionDevelopmentPath=${windowComponent}`, `--extensionEnvironment=${JSON.stringify(environment())}`, ...EDITOR_FLAGS], {
				stdio: 'ignore',
				env: { ...process.env, ...local.env, ...environment() }
			});
			editors.push(child);
			return child;
		};
		/** The suite in an editor on `folder`, with this scenario's variables. */
		const suite = async (editorName: string, folder: Folder, more: { readonly [variable: string]: string }) => {
			const local = profile(editorName);
			const code = await runTests({
				vscodeExecutablePath: executable,
				extensionDevelopmentPath: [workspaceExtension(folder), windowComponent],
				extensionTestsPath: 'local' in folder ? path.join(__dirname, 'index') : folder.host.uri(`${folder.host.build}/out/test/integration/index`),
				launchArgs: [...opened(folder), ...local.args, `--extensionEnvironment=${JSON.stringify(environment(more))}`],
				extensionTestsEnv: { ...local.env, ...environment(more) }
			});
			if (code !== 0) {
				throw new Error(`The ${editorName} journeys failed with exit code ${code}.`);
			}
		};
		/** Another window of the scenario, its label once its component registered it on this computer with the name it has. */
		const peer = async (editorName: string, folder: Folder) => {
			editor(editorName, folder);
			// An SSH window is named for its host by its workspace extension, which tells its component: that is its label
			const label = await registeredWindow(facade, 'local' in folder ? each => each === 'local-peer' : each => each.startsWith(`remote-peer [`) && each.includes(folder.host.alias));
			if (label === undefined) {
				throw new Error(`The ${editorName} window did not join this computer's Facade Code Extension windows.`);
			}
			return label;
		};
		/**
		 * Closes the scenario's editors, then what they left on every computer: the editor's servers - whose extension hosts would
		 * otherwise wait hours for their windows to reconnect - the ptyds and their agents, and the fake CLIs' records.
		 */
		const close = async () => {
			for (const child of editors.splice(0)) {
				child.kill('SIGTERM');
			}
			endMatching(path.join(root, 'u-'));
			await new Promise(resolve => setTimeout(resolve, 2_000));
			endMatching(`${facade}/extension/ptyd`);
			for (const host of hosts) {
				clean(host, false);
			}
			for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
				fs.rmSync(path.join(root, file));
			}
			// This computer's Facade Code Extension root and Claude Code configuration anew too, as each host's
			for (const dir of [facade, claude]) {
				fs.rmSync(dir, { recursive: true, force: true });
				fs.mkdirSync(dir, { mode: 0o700 });
			}
			localSettings();
		};
		const app = (host: Host): Folder => ({ host, remote: `${root}/app` });
		const remotePeer = (host: Host): Folder => ({ host, remote: `${root}/remote-peer` });
		const sshLifetime = async (host: Host) => {
			const folder = app(host);
			const driver = `${root}/lifetime-driver`;
			const out = `${root}/lifetime.jsonl`;
			host.run(`mkdir ${quoted(driver)}\n${Object.entries(lifetimeDriverFiles()).map(([name, contents]) => `printf %s ${quoted(contents)} > ${quoted(`${driver}/${name}`)}`).join('\n')}`);
			const local = profile('lifetime');
			const args = [...opened(folder), '--new-window', ...local.args, `--extensionDevelopmentPath=${workspaceExtension(folder)}`,
				`--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${host.uri(driver)}`, ...EDITOR_FLAGS];
			const env = environment({ FACADE_IT_WINDOW_LIFETIME: out, FACADE_IT_WINDOW_LIFETIME_SSH: '1' });
			const start = () => spawn(executable, [...args, `--extensionEnvironment=${JSON.stringify(env)}`], { env: { ...process.env, ...local.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
			const screen = (agent: string) => host.run(`unset FACADE_AGENT\nFACADE_HOME=${quoted(facade)} ${quoted(`${host.build}/extension-it/bin/facade`)} screen ${quoted(agent)} --lines 120`);
			const query = async <O extends 'agent.list' | 'agent.inspect'>(op: O, args: DaemonOperations[O]['args']): Promise<DaemonOperations[O]['result']> => {
				const probe = 'require(process.argv[1]).frameworkCall(process.argv[2], process.argv[3], JSON.parse(process.argv[4])).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });';
				return JSON.parse(host.run(`node -e ${quoted(probe)} ${quoted(`${host.build}/out/test/integration/editors.js`)} ${quoted(facade)} ${quoted(op)} ${quoted(JSON.stringify(args))}`)) as DaemonOperations[O]['result'];
			};
			await windowLifetime(start, () => host.run(`if [ -f ${quoted(out)} ]; then cat ${quoted(out)}; fi`), async step => {
				if (step.after === 'reload') {
					await checkClosedAgent(step, screen, async () => (await query('agent.list', {})).agents,
						target => query('agent.inspect', { target }), true);
				}
			});
		};
		const sshMultiWindow = async (host: Host, network = false) => {
			const runName = 'multi';
			const driver = `${root}/${runName}-driver`;
			const shared = `${root}/multi-shared`;
			host.run(`git init -q -b main ${quoted(shared)} && git -C ${quoted(shared)} -c user.name=t -c user.email=t@t commit -q --allow-empty -m first`);
			host.run(`mkdir ${quoted(driver)}\n${Object.entries(multiWindowDriverFiles()).map(([name, contents]) => `printf %s ${quoted(contents)} > ${quoted(`${driver}/${name}`)}`).join('\n')}`);
			const files = {
				prefix: `${root}/${runName}`,
				read: (file: string) => host.run(`if [ -f ${quoted(file)} ]; then cat ${quoted(file)}; fi`),
				write: (file: string, text: string) => {
					const temporary = `${file}.new`;
					host.run(`printf %s ${quoted(text)} > ${quoted(temporary)} && mv ${quoted(temporary)} ${quoted(file)}`);
				}
			};
			const profiles = new Map<string, ReturnType<typeof profile>>();
			const start = (folder: string, name: string, control: string, port: number) => {
				let user = profiles.get(name);
				if (!user) {
					user = profile(`${runName}-${name}`);
					fs.writeFileSync(path.join(user.user, 'User', 'settings.json'), JSON.stringify({ ...settings, 'window.dialogStyle': 'custom' }));
					profiles.set(name, user);
				}
				const destination: Folder = { host, remote: folder };
				const env = environment({ FACADE_IT_WINDOW_CONTROL: control });
				const args = [...opened(destination), '--new-window', ...user.args, `--extensionDevelopmentPath=${workspaceExtension(destination)}`,
					`--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${host.uri(driver)}`, `--remote-debugging-port=${port}`, '--locale=en', ...EDITOR_FLAGS,
					`--extensionEnvironment=${JSON.stringify(env)}`];
				const localPath = `${path.join(extension, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
				return spawn(executable, args, { env: { ...process.env, ...user.env, ...env, PATH: localPath }, stdio: ['ignore', 'pipe', 'pipe'] });
			};
			const localFramework = path.join(extension, 'bin', 'facade');
			const daemonLog = path.join(facade, 'framework', 'logs', 'daemon.log');
			const trace = () => fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf8') : '';
			await withFrameworkWindows(files, start, async open => {
				if (connectOnly) {
					const place = `${root}/app`;
					const window = await open(place, 'a');
					assert.deepStrictEqual([window.ready.remote, window.ready.folder, window.ready.home, window.ready.platform],
						['ssh-remote', place, facade, 'linux']);
					assert.ok(window.ready.machineId && window.ready.hostPid);
					const remoteProgram = `${server(host)}/.vscode-server/bin/${commit}/node`;
					const hostBinary = host.run(`readlink -f /proc/${window.ready.hostPid}/exe`).trim();
					assert.strictEqual(hostBinary, remoteProgram, 'the real workspace host uses the pinned SSH server executable');
					const command = host.run(`tr '\\000' ' ' </proc/${window.ready.hostPid}/cmdline`).trim();
					assert.match(command, /--type=extensionHost/u);
					const marker = 'SSH fixture owned terminal';
					const original = await window.act<{ id: string; pid: number; session: string; cwd: string }>({ kind: 'start', screen: marker });
					assert.ok(original.session);
					assert.strictEqual(original.cwd, place);
					await window.act({ kind: 'pin', agent: original.id });
					const owner = await window.act<InspectResult>({ kind: 'inspect', agent: original.id });
					assert.deepStrictEqual([owner.agent.reference.machine_id, owner.agent.reference.agent_id, owner.agent.pid, owner.agent.session, owner.agent.cwd, owner.agent.process],
						[window.ready.machineId, original.id, original.pid, original.session, place, 'running']);
					assert.strictEqual(owner.viewers.length, 1);
					const guestCwd = host.run(`readlink -f /proc/${original.pid}/cwd`).trim();
					assert.strictEqual(guestCwd, place);
					const starts = host.run(`cat ${quoted(record + '.starts.#' + original.id)}`).trim();
					assert.strictEqual(starts, String(original.pid), 'one source of fake CLI startup on the SSH host');
					await window.act({ kind: 'remove', agent: original.id });
					await window.act({ kind: 'wait-for-exit', pid: original.pid });
					await window.close();
					const { remote, folder, home, platform, machineId, hostPid } = window.ready;
					console.log('Facade native SSH connect observation ' + JSON.stringify({
						attempt, authority: host.alias, ready: { remote, folder, home, platform, machineId, hostPid }, started: original,
						owner: { agent: owner.agent.reference, pid: owner.agent.pid, session: owner.agent.session,
							cwd: owner.agent.cwd, process: owner.agent.process, viewers: owner.viewers },
						hostBinary, guestCwd, starts
					}));
					return;
				}

				if (!network) {
					await frameworkMultiWindow(open, {
						folder: `${root}/app`, peer: `${root}/remote-peer`, shared, home: facade, remote: 'ssh-remote',
						files
					});
					return;
				}
				// Use the staged program at the bootstrap's fixed location inside a test-only SSH home.
				const remoteHome = `${root}/ssh-home`;
				const remoteBin = `${remoteHome}/.local/bin`;
				const remoteFramework = `${host.build}/extension-it/bin/facade`;
				const localBin = path.join(root, 'ssh-network-bin');
				const localHome = path.join(root, 'shell-home');
				fs.mkdirSync(localBin, { recursive: true });
				fs.mkdirSync(localHome, { recursive: true });
				const remoteEnv = `env -i HOME=${quoted(remoteHome)} PATH=${quoted(`${remoteBin}:/usr/bin:/bin`)}`;
				fs.writeFileSync(path.join(localBin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh "$@" ${quoted(`exec ${remoteEnv} /bin/sh`)}\n`, { mode: 0o700 });
				const env = {
					...process.env, ...environment(), HOME: localHome, PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ''}`,
					XDG_CONFIG_HOME: path.join(localHome, '.config'), XDG_DATA_HOME: path.join(localHome, '.local', 'share'),
					XDG_CACHE_HOME: path.join(localHome, '.cache'), XDG_STATE_HOME: path.join(localHome, '.local', 'state')
				};
				const call = (...args: string[]) => execFileSync(localFramework, args, { encoding: 'utf8', timeout: 20_000, cwd: local.app, env });
				const remoteVersion = host.run(`set -e
umask 077
mkdir -p ${quoted(remoteBin)}
ln -sf ${quoted(remoteFramework)} ${quoted(`${remoteBin}/facade`)}
printf '%s\n' '#!/bin/sh' 'echo "Package downloads are disabled in this fixture" >&2' 'exit 1' > ${quoted(`${remoteBin}/curl`)}
chmod +x ${quoted(`${remoteBin}/curl`)}
${remoteEnv} ${quoted(`${remoteBin}/facade`)} --version`);
				assert.strictEqual(remoteVersion.trim(), call('--version').trim(), 'the two isolated packages have the same version');
				call('daemon', '--detach');
				const localMachines = async () => (await frameworkCall(facade, 'machine.list', {})).machines;
				const localMachine = (await localMachines()).find(row => row.route?.length === 0);
				assert.ok(localMachine);
				const myId = localMachine.machine_id;
				const localName = 'network-local';
				assert.strictEqual((await frameworkCall(facade, 'machine.rename', { machine: myId, name: localName })).machine_id, myId);
				const first = await open(`${root}/app`, 'a');
				const theirId = first.ready.machineId;
				assert.notStrictEqual(theirId, myId);
				assert.strictEqual(first.ready.remote, 'ssh-remote');
				const name = 'Network QA worker';
				const address = detachedStartReference(call('start', '-d', '--name', name, 'claude'), name);
				const inspect = () => frameworkCall(facade, 'agent.inspect', { target: address });
				const link = spawn(localFramework, ['machine', 'connect', '--home', facade, '-F', config, '-o', 'BatchMode=yes', host.alias],
					{ cwd: local.app, env, stdio: ['ignore', 'pipe', 'pipe'] });
				let linkOutput = '';
				const capture = (chunk: unknown) => { linkOutput = (linkOutput + String(chunk)).slice(-16_000); };
				link.on('error', capture);
				link.stdout.on('data', capture);
				link.stderr.on('data', capture);
				const expectLink = async (connected: boolean) => {
					return await until(`the temporary SSH route to be ${connected ? 'connected' : 'closed'}`, async () => {
						const sessions = new Set<string>();
						const event = /daemon\[(\d+)\] info: machine (\S+) (opened|closed) session SessionId\((\d+)\)/gu;
						for (const [, pid, id, action, session] of trace().matchAll(event)) {
							if (id !== theirId) { continue; }
							if (action === 'opened') { sessions.add(`${pid}:${session}`); }
							else { sessions.delete(`${pid}:${session}`); }
						}
						const machines = await localMachines();
						const machine = machines.find(row => row.machine_id === theirId);
						const routes = machines.find(row => row.machine_id === myId)?.connections.filter(connection =>
							connection.machine_id === theirId && connection.initiator_machine_id === myId
							&& connection.kind === 'temporary' && connection.state === 'connected') ?? [];
						if (!connected) { return machine?.route === undefined && routes.length === 0 && sessions.size === 0 || undefined; }
						return machine?.route?.length === 1 && machine.route[0] === theirId && routes.length === 1
							&& routes[0].transport?.ssh_destination === host.alias && sessions.size === 1 ? [...sessions][0] : undefined;
					}, 45_000).catch(error => {
						console.error(linkOutput, trace());
						throw error;
					});
				};
				try {
					const session = await expectLink(true);
					const before = await until('the local agent to report its PID and session', async () => {
						const { agent } = await inspect();
						return agent.pid && agent.session && agent.process === 'running' ? agent : undefined;
					});
					assert.strictEqual(before.reference.machine_id, myId);
					assert.strictEqual(before.address, address);
					const expectViews = (count: number) => until(`${count} Remote-SSH terminal views of ${address}`, async () => {
						const { agent, viewers } = await inspect();
						assert.deepStrictEqual([agent.address, agent.reference.machine_id, agent.pid, agent.process, agent.session, agent.cwd],
							[address, myId, before.pid, 'running', before.session, before.cwd]);
						return viewers.length === count ? viewers : undefined;
					});
					const firstText = 'Input from the first remote window';
					assert.strictEqual(await first.act<string>({ kind: 'open-shell-agent', name, address, text: firstText }), address);
					assert.strictEqual(await first.act<string>({ kind: 'remote-card', agent: address }), address);
					const [firstViewer] = await expectViews(1);
					const second = await open(`${root}/remote-peer`, 'b');
					assert.strictEqual(second.ready.machineId, theirId);
					assert.strictEqual(second.ready.remote, 'ssh-remote');
					const secondText = 'Input from the second remote window';
					assert.strictEqual(await second.act<string>({ kind: 'open-shell-agent', name, address, text: secondText }), address);
					assert.strictEqual(await second.act<string>({ kind: 'remote-card', agent: address }), address);
					const both = await expectViews(2);
					assert.ok(both.includes(firstViewer));
					const secondViewer = both.find(viewer => viewer !== firstViewer);
					assert.ok(secondViewer, JSON.stringify(both));
					const { agents } = await frameworkCall(facade, 'agent.list', {});
					assert.deepStrictEqual(agents.map(row => [row.address, row.reference.machine_id, row.name]), [[address, myId, name]]);
					const screen = () => call('screen', address, '--lines', '120');
					assert.ok(screen().includes(firstText) && screen().includes(secondText));
					const message = 'Unsupported human recipient marker';
					const rejected = await callInFramework(facade, 'agent.send', { to: '#human', text: message });
					assert.ok('error' in rejected, JSON.stringify(rejected));
					assert.strictEqual(rejected.error.data.reason, 'not_found');
					assert.strictEqual(rejected.error.data.details?.message_ref, undefined);
					assert.ok(!screen().includes(message));
					console.log('  ✔ Both Remote-SSH windows adopted the same local agent and sent input to its terminal');
					await first.close();
					assert.deepStrictEqual(await expectViews(1), [secondViewer]);
					assert.strictEqual(await expectLink(true), session);
					const back = await open(`${root}/app`, 'a');
					assert.strictEqual(back.ready.machineId, theirId);
					await back.act({ kind: 'open-shell-agent', name, address, text: 'Input after reopening the first remote window' });
					assert.deepStrictEqual((await expectViews(2)).sort(), [firstViewer, secondViewer].sort());
					assert.strictEqual(await expectLink(true), session);
					await back.close();
					assert.deepStrictEqual(await expectViews(1), [secondViewer]);
					await second.act({ kind: 'close-shell-view', name });
					await expectViews(0);
					await second.close();
					assert.strictEqual(await expectLink(true), session);
					await endEditors([link]);
					await expectLink(false);
					await expectViews(0);
					assert.strictEqual((await inspect()).agent.pid, before.pid);
					console.log('  ✔ Closing and reopening one window changed its viewer while the SSH route stayed open');
				} finally {
					await endEditors([link]);
					call('stop', address);
				}
			}).finally(async () => { if (network) { await endFramework(facade); } });
		};
		const runs: { readonly scenario: Scenario; readonly title: string; readonly go: () => Promise<void> }[] = [];
		for (const host of hosts) {
			const on = host.title;
			// A suite runs in a test editor, which keeps no state across its start: in a container window Dev Containers would ask it
			// again whether to attach, in a dialog a test editor refuses. Of a container host, the scenario whose suite runs in a local
			// window is run
			const inContainer = host.kind === 'container';
			if (inContainer) {
				console.log(`\nNot run on ${on}: ssh, ssh-ssh and ssh-local, whose suite would run in a container window, which Dev Containers asks a test editor whether to attach to.`);
			}
			runs.push(...([
				{ scenario: 'ssh', title: on, go: () => suite('ssh', app(host), { FACADE_IT_CLI: 'claude' }) },
				{
					scenario: 'ssh-ssh', title: on, go: async () => {
						const label = await peer('remote-peer', remotePeer(host));
						await suite('ssh-ssh', app(host), { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: label, FACADE_IT_PEER_DIR: host.at(`${root}/remote-peer`) });
					}
				},
				{
					scenario: 'local-ssh', title: on, go: async () => {
						// The Facade Code Framework's computers do not work together: of this scenario the local window's own journeys run, the container started beside it
						if (implementation === 'framework') {
							await suite('local-ssh', { local: fs.realpathSync(local.app) }, { FACADE_IT_CLI: 'claude' });
							return;
						}
						const label = await peer('remote-peer', remotePeer(host));
						await suite('local-ssh', { local: fs.realpathSync(local.app) }, { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: label, FACADE_IT_PEER_DIR: host.at(`${root}/remote-peer`), FACADE_IT_PEER_ELSEWHERE: '1' });
					}
				},
				{
					scenario: 'ssh-local', title: on, go: async () => {
						const label = await peer('local-peer', { local: fs.realpathSync(local.peer) });
						await suite('ssh-local', app(host), { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: label, FACADE_IT_PEER_DIR: fs.realpathSync(local.peer), FACADE_IT_PEER_ELSEWHERE: '1' });
					}
				}
			] as const).filter(each => !inContainer || each.scenario === 'local-ssh').filter(each => implementation !== 'framework' || each.scenario === (inContainer ? 'local-ssh' : 'ssh')));
			if (implementation === 'framework') {
				if (host.kind === 'ssh' && host.platform !== 'windows') {
					if (connectOnly) {
						runs.push({ scenario: 'ssh-connect', title: on, go: () => sshMultiWindow(host) });
					}

					runs.push({ scenario: 'ssh-lifetime', title: on, go: () => sshLifetime(host) });
					runs.push({ scenario: 'ssh-multi-window', title: on, go: () => sshMultiWindow(host) });
					runs.push({ scenario: 'ssh-network', title: on, go: () => sshMultiWindow(host, true) });
				}
			}
		}
		if (hosts.length === 2 && hosts[0].kind === 'ssh' && implementation !== 'framework') {
			const [first, second] = hosts;
			runs.push({
				scenario: 'hosts', title: `${first.alias} with ${second.alias}`, go: async () => {
					const label = await peer('remote-peer', remotePeer(second));
					await suite('hosts', app(first), { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: label, FACADE_IT_PEER_DIR: second.at(`${root}/remote-peer`), FACADE_IT_PEER_ELSEWHERE: '1' });
				}
			});
		}
		const selected = runs.filter(each => !only || each.scenario === only);
		if (frameworkOnly && !selected.length) {
			throw new Error(`The ${only} journey needs a Linux or macOS SSH host.`);
		}
		for (const run of selected) {
			console.log(`\nRemote-SSH journeys: ${run.scenario} (${run.title})`);
			try {
				await run.go();
			} finally {
				await close();
			}
		}
	} finally {
		for (const child of editors) {
			child.kill('SIGTERM');
		}
		endMatching(path.join(root, 'u-'));
		// The run's servers go with it, and its root on every computer unless it is kept
		for (const host of hosts) {
			try {
				clean(host, !keep);
			} catch (err) {
				console.error(`Could not clean up ${root} on ${host.alias}: ${failureOf(err)}`);
			}
		}
		if (keep) {
			console.log(`Kept ${root} on this computer and on ${hosts.map(host => host.alias).join(' and ')}`);
		} else {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
