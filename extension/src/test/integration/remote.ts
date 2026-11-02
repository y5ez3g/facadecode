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
// Facade's root, Claude Code's configuration and the fake CLIs' records are the run's own on every computer, at one path they all
// resolve, `/tmp/fdrt-…` - on Windows `\tmp\fdrt-…` of the system drive - as the editor gives its extension hosts, local and
// remote, one environment. FACADE_IT_REMOTE_ROOT names another folder for it, the same on every computer, such as /var/tmp for a
// host whose /tmp is short of room. Scenarios, each on every host - a container's remote window standing for the SSH window:
//
//   ssh        the journeys of one window, in an SSH window
//   ssh-ssh    an agent of an SSH window works with an agent of another SSH window on the same host
//   local-ssh  an agent of a local window works with an agent of an SSH window
//   ssh-local  an agent of an SSH window works with an agent of a local window
//
// and, given two hosts, `hosts`: an agent of an SSH window on the first works with an agent of an SSH window on the second.
//
// FACADE_IT_SSH_CONFIG names the SSH configuration file, FACADE_IT_SSH_HOST its hosts and FACADE_IT_REMOTE_EXTENSION the
// extension's folder on each, in the same order, separated by commas; FACADE_IT_CONTAINER names the image of a container host.
// FACADE_IT_ONLY runs one scenario and FACADE_IT_KEEP keeps what the run left on every computer, a container included.

import { resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { EDITOR_FLAGS, endMatching, fakeClis, newRepository, officialEditor, registeredWindow, sanitizedEnvironment } from './editors';

const SCENARIOS = ['ssh', 'ssh-ssh', 'local-ssh', 'ssh-local', 'hosts'] as const;
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
	/** The folder of the editor's server's machine settings there. */
	readonly machine: string;
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
	if (image && process.platform !== 'linux') {
		throw new Error('A container host is started with this computer\'s Docker, from Linux.');
	}
	const only = process.env.FACADE_IT_ONLY;
	if (only && !SCENARIOS.includes(only as Scenario)) {
		throw new Error(`FACADE_IT_ONLY is one of ${SCENARIOS.join(', ')}.`);
	}
	const keep = !!process.env.FACADE_IT_KEEP;
	const base = process.env.FACADE_IT_REMOTE_ROOT || '/tmp';
	// Read before this: it removes every variable of Facade's and of the CLIs' from this process
	sanitizedEnvironment();

	// One path on every computer: short, for the editor's sockets, and made anew on each
	const root = fs.mkdtempSync(path.posix.join(base, 'fdrt-'));
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
			const machine = `${at(`${root}/server`)}\\.vscode-server\\data\\Machine`;
			return { kind: 'ssh', alias, title: `${alias}, windows`, platform: 'windows', build, fake: at(`${root}/fake-cli.cmd`), machine, at, uri, run };
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
			kind: 'ssh', alias, title: `${alias}, ${platform}`, platform, build, fake: `${root}/fake-cli`, machine: `${root}/server/.vscode-server/data/Machine`,
			at: file => file, uri: file => `vscode-remote://ssh-remote+${alias}${file}`, run
		};
	});
	if (image) {
		// The container, its user `node`'s, with this extension's folder - built here - at its own path, read only
		const folder = path.resolve(__dirname, '..', '..', '..', '..');
		const alias = `${name}-container`;
		try {
			execFileSync('docker', ['run', '--detach', '--name', alias, '--user', 'node', '--volume', `${folder}:${folder}:ro`, image, 'sleep', 'infinity'], { stdio: 'pipe' });
		} catch (err) {
			throw new Error(`A container of ${image} could not be started: ${failureOf(err)}`);
		}
		const run = (script: string) => execFileSync('docker', ['exec', '--interactive', alias, 'sh', '-s'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
		// As Attach to Running Container addresses it: its name, as Docker lists it, in hex-encoded JSON
		const authority = `attached-container+${Buffer.from(JSON.stringify({ containerName: `/${alias}` })).toString('hex')}`;
		hosts.push({
			kind: 'container', alias, title: `${image} container`, platform: 'linux', build: `${folder}/build`, fake: `${root}/fake-cli`,
			machine: '/home/node/.vscode-server/data/Machine', at: file => file, uri: file => `vscode-remote://${authority}${file}`, run
		});
	}

	const extension = path.resolve(__dirname, '..', '..', '..', 'extension-it');
	const windowComponent = path.resolve(__dirname, '..', '..', '..', 'window');
	const extensions = path.join(root, 'x');
	const local = { app: path.join(root, 'local-app'), peer: path.join(root, 'local-peer') };
	const editors: ChildProcess[] = [];
	const server = (host: Host) => host.at(`${root}/server`);

	// Every built-in points to a fake on every computer: the run never starts a person's real CLI
	const BUILT_INS = ['claude', 'codex', 'antigravity', 'muse', 'opencode', 'pi'];
	const fakes = (fake: string) => Object.fromEntries(BUILT_INS.map(segment => [`facade.${segment}.path`, fake]));
	const localFake = path.join(root, 'fake-cli');
	const settings = {
		...fakes(localFake),
		'security.workspace.trust.enabled': false,
		'terminal.integrated.enablePersistentSessions': false,
		'window.restoreWindows': 'none',
		'workbench.startupEditor': 'none',
		'update.mode': 'none',
		'extensions.autoUpdate': false,
		'extensions.autoCheckUpdates': false,
		'telemetry.telemetryLevel': 'off',
		...config ? { 'remote.SSH.configFile': config } : {},
		'remote.SSH.serverInstallPath': Object.fromEntries(hosts.filter(host => host.kind === 'ssh').map(host => [host.alias, server(host)])),
		'remote.SSH.remotePlatform': Object.fromEntries(hosts.filter(host => host.kind === 'ssh').map(host => [host.alias, host.platform])),
		'remote.SSH.showLoginTerminal': false,
		'remote.SSH.enableRemoteCommand': false
	};
	/** A user data folder of the run's own for one editor, new for each scenario: what an earlier one kept there is not this one's. */
	const userData = (editor: string) => {
		const user = path.join(root, `u-${editor}`);
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
		return user;
	};
	/** What the editor gives its extension hosts, local and remote, with this scenario's own. */
	const environment = (more: { readonly [variable: string]: string } = {}) => ({ FACADE_HOME: facade, CLAUDE_CONFIG_DIR: claude, FACADE_IT_RECORD: record, ...more });
	const profile = (editor: string) => ['--user-data-dir', userData(editor), '--extensions-dir', extensions, '--shared-data-dir', path.join(root, `s-${editor}`)];
	const opened = (folder: Folder) => 'local' in folder ? [folder.local] : ['--folder-uri', folder.host.uri(folder.remote)];
	const workspaceExtension = (folder: Folder) => 'local' in folder ? extension : folder.host.uri(`${folder.host.build}/extension-it`);

	/**
	 * Ends what the run left on `host` - the editor's server, the ptyds, their agents - and its fake CLIs' records there; then its
	 * root where asked, else a new Facade root and Claude Code configuration for the next scenario: the records, registry and
	 * remembered locations of one never reach the next.
	 */
	const clean = (host: Host, removeRoot: boolean) => host.kind === 'container' ? cleanContainer(host, removeRoot) : host.run(host.platform === 'windows'
		? `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${literal(name)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Remove-Item -Force -ErrorAction SilentlyContinue -Path ${literal(`${host.at(record)}.*`)}
${removeRoot ? `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ${literal(host.at(root))}` : `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ${literal(host.at(facade))}, ${literal(host.at(claude))}
New-Item -ItemType Directory -Force -Path ${literal(host.at(facade))}, ${literal(host.at(claude))} | Out-Null`}`
		: `pkill -TERM -f ${quoted(name)}; sleep 0.5; rm -f ${quoted(record)}.*; ${removeRoot ? `rm -rf ${quoted(root)};` : `rm -rf ${quoted(facade)} ${quoted(claude)}; mkdir -m 700 ${quoted(facade)} ${quoted(claude)};`} true`);

	/**
	 * A container's clean: every process in it but its first - the editor's server, the ptyds, their agents - and the fake CLIs'
	 * records, then a new Facade root and Claude Code configuration; or the container itself, where its root goes too.
	 */
	const cleanContainer = (host: Host, removeRoot: boolean) => {
		if (removeRoot) {
			return execFileSync('docker', ['rm', '--force', host.alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		}
		return host.run(`kill -TERM -1 2>/dev/null; sleep 0.5; rm -f ${quoted(record)}.*; rm -rf ${quoted(facade)} ${quoted(claude)}; mkdir -m 700 ${quoted(facade)} ${quoted(claude)}; true`);
	};

	try {
		fs.mkdirSync(facade, { mode: 0o700 });
		fs.mkdirSync(claude, { mode: 0o700 });
		fakeClis(root);
		newRepository(local.app);
		newRepository(local.peer);
		// Each host's half: the same root, the server's machine settings pointing to its fake, and two repositories
		for (const host of hosts) {
			const { machine } = host;
			const machineSettings = JSON.stringify(fakes(host.fake));
			try {
				host.run(host.platform === 'windows' ? `
foreach ($file in ${literal(`${host.build}/extension-it/package.json`)}, ${literal(`${host.build}/out/test/integration/index.js`)}) {
	if (-not (Test-Path -LiteralPath $file)) { throw "$file is missing" }
}
$root = ${literal(host.at(root))}
New-Item -ItemType Directory -Force -Path $root, "$root\\facade", "$root\\claude", ${literal(machine)} | Out-Null
[IO.File]::WriteAllText((Join-Path ${literal(machine)} 'settings.json'), ${literal(machineSettings)})
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
mkdir -p ${quoted(machine)}
printf '%s' ${quoted(machineSettings)} > ${quoted(`${machine}/settings.json`)}
printf '#!/bin/sh\\nexec %s %s "$@"\\n' "'$node'" ${quoted(quoted(`${host.build}/out/test/integration/fakeCli.js`))} > fake-cli
chmod 755 fake-cli
for repo in app remote-peer; do
	mkdir "$repo"
	git -C "$repo" init -q -b main
	git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m first
done
`);
			} catch (err) {
				throw new Error(`${host.alias} cannot run the journeys: ${failureOf(err)}. It needs Node and Git, and the extension built for the suite in ${host.build}.`);
			}
		}
		// Remote-SSH and Dev Containers, as the hosts need them, in the run's own extensions folder, from the Marketplace
		const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
		const remotes = [...new Set(hosts.map(host => host.kind === 'ssh' ? 'ms-vscode-remote.remote-ssh' : 'ms-vscode-remote.remote-containers'))];
		execFileSync(cli, [...cliArgs, ...profile('install'), ...remotes.flatMap(id => ['--install-extension', id])], { stdio: 'inherit' });

		/** An editor of the run that runs no tests, on `folder`; closed with the scenario. */
		const editor = (editorName: string, folder: Folder) => {
			const child = spawn(executable, [...opened(folder), '--new-window', ...profile(editorName), `--extensionDevelopmentPath=${workspaceExtension(folder)}`,
				`--extensionDevelopmentPath=${windowComponent}`, `--extensionEnvironment=${JSON.stringify(environment())}`, ...EDITOR_FLAGS], {
				stdio: 'ignore',
				env: { ...process.env, ...environment() }
			});
			editors.push(child);
			return child;
		};
		/** The suite in an editor on `folder`, with this scenario's variables. */
		const suite = async (editorName: string, folder: Folder, more: { readonly [variable: string]: string }) => {
			const code = await runTests({
				vscodeExecutablePath: executable,
				extensionDevelopmentPath: [workspaceExtension(folder), windowComponent],
				extensionTestsPath: 'local' in folder ? path.join(__dirname, 'index') : folder.host.uri(`${folder.host.build}/out/test/integration/index`),
				launchArgs: [...opened(folder), ...profile(editorName), `--extensionEnvironment=${JSON.stringify(environment(more))}`],
				extensionTestsEnv: environment(more)
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
				throw new Error(`The ${editorName} window did not join this computer's Facade windows.`);
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
			// This computer's Facade root and Claude Code configuration anew too, as each host's
			for (const dir of [facade, claude]) {
				fs.rmSync(dir, { recursive: true, force: true });
				fs.mkdirSync(dir, { mode: 0o700 });
			}
		};
		const app = (host: Host): Folder => ({ host, remote: `${root}/app` });
		const remotePeer = (host: Host): Folder => ({ host, remote: `${root}/remote-peer` });
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
			] as const).filter(each => !inContainer || each.scenario === 'local-ssh'));
		}
		if (hosts.length === 2 && hosts[0].kind === 'ssh') {
			const [first, second] = hosts;
			runs.push({
				scenario: 'hosts', title: `${first.alias} with ${second.alias}`, go: async () => {
					const label = await peer('remote-peer', remotePeer(second));
					await suite('hosts', app(first), { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: label, FACADE_IT_PEER_DIR: second.at(`${root}/remote-peer`), FACADE_IT_PEER_ELSEWHERE: '1' });
				}
			});
		}
		for (const run of runs.filter(each => !only || each.scenario === only)) {
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
