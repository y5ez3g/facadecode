/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the integration suite in an isolated official VS Code (ARCHITECTURE-5.2): `VSCODE_EXECUTABLE` names it, else macOS's standard
// installation where there is one. The window opens a fresh repository, with Facade's directory, user data, extensions and fake
// agent CLIs of its own; no inherited editor, Git or CLI credential variables reach it, and nothing it does touches a person's
// profile or agents.

import { runTests } from '@vscode/test-electron';
import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The official VS Code only: a derived editor can load its own agent extension and share a data folder with a person's live state. */
function officialVsCode(executable: string): void {
	const dir = path.dirname(executable);
	const candidates = [
		path.join(dir, '..', 'Resources', 'app', 'product.json'),
		path.join(dir, 'resources', 'app', 'product.json'),
		path.join(dir, '..', 'resources', 'app', 'product.json'),
		// The Windows installation that updates in the background keeps each version in a folder of its own beside Code.exe
		...fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name, 'resources', 'app', 'product.json'))
	];
	const files = candidates.filter(each => fs.existsSync(each));
	if (!files.length) {
		throw new Error(`Cannot find product.json beside ${executable}; refusing to run the suite in an unknown editor.`);
	}
	for (const file of files) {
		const product = JSON.parse(fs.readFileSync(file, 'utf8')) as { nameShort?: string; dataFolderName?: string; applicationName?: string };
		if (product.dataFolderName !== '.vscode' || product.applicationName !== 'code') {
			throw new Error(`${executable} is ${product.nameShort ?? 'not VS Code'} (data folder ${product.dataFolderName}); the suite runs only in official VS Code.`);
		}
	}
}

/** Variables an editor, Git or a CLI session could pass on: none of them may reach the test editor. */
function sanitizedEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (/^(VSCODE_|CLAUDE_|CODEX_|GEMINI_|ANTIGRAVITY_|MUSE_|OPENCODE_|PI_|ANTHROPIC_|OPENAI_|FACADE_|ELECTRON_RUN_AS_NODE$|GIT_ASKPASS$|SSH_ASKPASS$)/.test(name) && name !== 'VSCODE_EXECUTABLE') {
			delete process.env[name];
		}
	}
}

/** Ends every process whose command line holds `text`: what a run of the suite started and left, never anything else. */
function endProcessesWith(text: string): void {
	if (process.platform === 'win32') {
		const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:FACADE_IT_END) -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
		spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FACADE_IT_END: text }, stdio: 'ignore' });
	} else {
		spawnSync('pkill', ['-TERM', '-f', text]);
	}
}

/** The built-ins in their catalog order (CLIS-1.1), each with the avatar file its card shows (PANEL-1.3). */
const BUILT_INS: readonly { readonly id: string; readonly segment: string; readonly avatar: string }[] = [
	{ id: 'claude', segment: 'claude', avatar: 'avatar-claude.png' },
	{ id: 'codex', segment: 'codex', avatar: 'avatar-codex.png' },
	{ id: 'agy', segment: 'antigravity', avatar: 'avatar-antigravity.png' },
	{ id: 'muse', segment: 'muse', avatar: 'avatar-muse.png' },
	{ id: 'opencode', segment: 'opencode', avatar: 'avatar-opencode.png' },
	{ id: 'pi', segment: 'pi', avatar: 'avatar-pi.png' }
];

/** The custom CLI's ID: a key of `facade.custom`, never a built-in's (CLIS-3.4). */
const CUSTOM_CLI = 'my-cli';

async function main(): Promise<void> {
	const standard = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
	const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' && fs.existsSync(standard) ? standard : undefined);
	if (!executable) {
		throw new Error('Set VSCODE_EXECUTABLE to an official VS Code executable, for example "/Applications/Visual Studio Code.app/Contents/MacOS/Code".');
	}
	officialVsCode(executable);
	const grep = process.env.FACADE_IT_GREP;
	// For a look at what a run left: its folder kept, and one of its editors alone (`journeys` or `conversion`)
	const keep = !!process.env.FACADE_IT_KEEP;
	const only = process.env.FACADE_IT_ONLY;
	sanitizedEnvironment();
	// Short paths: the editor's IPC socket under the user data folder must stay within the platform's limit
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fdit-')));
	const repo = path.join(root, 'app');
	fs.mkdirSync(repo);
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
	git('init', '-q', '-b', 'main');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');

	// An agent CLI that records where it runs and what it was given, run as Node by this run's own. On Windows it is a `.cmd` as npm
	// writes one for a package's script, which Facade starts as that script with the Node beside it (CLIS-1.2); elsewhere a script.
	const record = path.join(root, 'fake-cli.log');
	let fake: string;
	if (process.platform === 'win32') {
		fake = path.join(root, 'fake-cli.cmd');
		fs.copyFileSync(path.join(__dirname, 'fakeCli.js'), path.join(root, 'fakeCli.js'));
		try {
			fs.linkSync(process.execPath, path.join(root, 'node.exe'));
		} catch {
			fs.copyFileSync(process.execPath, path.join(root, 'node.exe'));
		}
		// npm 11's shim, byte for byte but for the script's name
		fs.writeFileSync(fake, [
			'@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
			'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
			'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fakeCli.js" %*', ''
		].join('\r\n'));
	} else {
		fake = path.join(root, 'fake-cli');
		fs.writeFileSync(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fakeCli.js'))} "$@"\n`, { mode: 0o755 });
	}
	// On Windows two built-ins are installed with launchers of their own, which Facade starts as their installers wrote them
	// (CLIS-1.2): Muse Code's `.cmd`, through cmd.exe, and the `pi.cmd` of Pi's installer, as its `pi-launcher.js` with Node
	const launchers: { [cli: string]: string } = {};
	if (process.platform === 'win32') {
		const museBin = path.join(root, 'muse-bin');
		fs.mkdirSync(museBin);
		launchers.muse = path.join(museBin, 'muse.cmd');
		fs.writeFileSync(launchers.muse, `@echo off\r\nsetlocal\r\n"${path.join(root, 'node.exe')}" "${path.join(root, 'fakeCli.js')}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
		const piBin = path.join(root, 'pi-bin');
		fs.mkdirSync(piBin);
		launchers.pi = path.join(piBin, 'pi.cmd');
		fs.copyFileSync(path.join(__dirname, 'fakeCli.js'), path.join(piBin, 'pi-launcher.js'));
		fs.writeFileSync(launchers.pi, [
			'@ECHO off', 'SETLOCAL', 'SET "node=node"', '"%node%" "%~dp0pi-launcher.js" %*', 'SET "pi_exit_code=%ERRORLEVEL%"', 'IF "%pi_exit_code%"=="9009" (',
			'  IF "%node%"=="node" (', '    "%SystemRoot%\\System32\\where.exe" /Q node', '    IF ERRORLEVEL 1 GOTO node_missing', '  ) ELSE IF NOT EXIST "%node%" GOTO node_missing', ')',
			'EXIT /B %pi_exit_code%', ':node_missing', 'ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2', 'EXIT /B %pi_exit_code%', ''
		].join('\r\n'));
	}
	// Claude Code's configuration, where each launch trusts its folder (CLIS-3.3, D62): the suite's own, never a person's
	const claudeConfig = path.join(root, 'claude');
	fs.mkdirSync(claudeConfig);
	const home = path.join(root, 'home');
	fs.mkdirSync(home);
	// The home folder agents' terminals see, where a CLI such as Antigravity keeps the folders it trusts: the suite's own. Only the
	// terminals' environment names it, as a person's terminal settings could; the editor keeps its own HOME.
	const agentsHome = path.join(root, 'agents-home');
	fs.mkdirSync(agentsHome);

	/** What agents' terminals are given - the suite's home folder, and `more` - by the editor's terminal settings. */
	const isolatedStorage = { XDG_CONFIG_HOME: path.join(agentsHome, '.config'), XDG_DATA_HOME: path.join(agentsHome, '.local', 'share'), XDG_CACHE_HOME: path.join(agentsHome, '.cache'), XDG_STATE_HOME: path.join(agentsHome, '.local', 'state') };
	const terminalEnv = (more: { readonly [name: string]: string } = {}) => ({
		'terminal.integrated.env.windows': { USERPROFILE: agentsHome, ...isolatedStorage, ...more },
		'terminal.integrated.env.osx': { HOME: agentsHome, ...isolatedStorage, ...more },
		'terminal.integrated.env.linux': { HOME: agentsHome, ...isolatedStorage, ...more }
	});
	// Every built-in points to a fake: the suite never starts a person's real CLI.
	const settings = {
		...Object.fromEntries(BUILT_INS.map(cli => [`facade.${cli.segment}.path`, launchers[cli.id] ?? fake])),
		...terminalEnv(),
		'security.workspace.trust.enabled': false,
		'terminal.integrated.enablePersistentSessions': false,
		'window.restoreWindows': 'none'
	};
	const extension = path.resolve(__dirname, '..', '..', '..', 'extension-it');
	const windowComponent = path.resolve(__dirname, '..', '..', '..', 'window');
	/**
	 * One editor of the suite on `folder`, with user data, extensions and a Facade directory of its own - and shared data: without it
	 * VS Code opens the shared storage of the person's own `~/.vscode-shared` (ARCHITECTURE-5.2).
	 */
	const run = async (name: string, folder: string, env: { readonly [name: string]: string } = {}, more: { readonly [setting: string]: unknown } = {}) => {
		const user = path.join(root, `u-${name}`);
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, ...more }));
		// Each run numbers its agents from #a1: what an earlier run's CLIs recorded goes first
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		// FACADE_HOME, the root whose `extension` folder is the extension's data (ARCHITECTURE-3.1)
		const facade = path.join(home, name);
		fs.mkdirSync(facade);
		try {
			await runTests({
				vscodeExecutablePath: executable,
				extensionDevelopmentPath: [extension, windowComponent],
				extensionTestsPath: path.join(__dirname, 'index'),
				launchArgs: [folder, '--disable-extensions', '--user-data-dir', user, '--extensions-dir', path.join(root, `x-${name}`), '--shared-data-dir', path.join(root, `s-${name}`), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				extensionTestsEnv: {
					FACADE_HOME: facade,
					FACADE_IT_RECORD: record,
					CLAUDE_CONFIG_DIR: claudeConfig,
					...(grep ? { FACADE_IT_GREP: grep } : {}),
					...env
				}
			});
		} finally {
			// The window's ptyd outlives it, as it is made to: it goes with the run, and the agents it holds with it
			endProcessesWith(path.join(facade, 'extension', 'ptyd'));
		}
	};
	/**
	 * A folder window that becomes a multi-root workspace keeps its agents (ARCHITECTURE-2.2, D70). The editor refuses to enter a
	 * workspace in a test run, so this one runs no tests: a driver extension beside Facade Code starts a fake CLI in the
	 * folder window and adds a folder, then, in the extension host the editor restarts, says what Facade shows; this judges it.
	 */
	const conversion = async (cli: typeof BUILT_INS[number]) => {
		const solo = path.join(root, `solo-${cli.id}`);
		const second = path.join(root, `second-${cli.id}`);
		const user = path.join(root, `u-conversion-${cli.id}`);
		const facade = path.join(home, `conversion-${cli.id}`);
		const out = path.join(root, `conversion-${cli.id}.jsonl`);
		const driver = path.join(root, `driver-${cli.id}`);
		for (const dir of [solo, second, path.join(user, 'User'), facade, driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, ...Object.fromEntries(BUILT_INS.filter(each => each.id !== cli.id).map(each => [`facade.${each.segment}.enabled`, false])) }));
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'conversion-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'conversionDriver.js'), path.join(driver, 'extension.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		// The flags runTests gives the other parts too: Electron's sandbox cannot start where unprivileged user namespaces are
		// restricted, as on Ubuntu 24.04 and later
		const editor = spawn(executable, [solo, '--new-window', '--disable-extensions', '--user-data-dir', user, '--extensions-dir', path.join(root, `x-conversion-${cli.id}`), '--shared-data-dir', path.join(root, `s-conversion-${cli.id}`),
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'], {
			stdio: 'ignore',
			env: { ...process.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_CONVERSION: out, FACADE_IT_SECOND: second, CLAUDE_CONFIG_DIR: claudeConfig }
		});
		const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		try {
			const end = Date.now() + 90_000;
			while (Date.now() < end && !lines().some(line => line.phase === 'workspace' || line.phase === 'error')) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
			const said = lines();
			const before = said.find(line => line.phase === 'folder') as { runId: string; name: string; pid: number } | undefined;
			const after = said.find(line => line.phase === 'workspace') as { folders: number; card: { runId: string; pinned: boolean } | null; terminals: string[] } | undefined;
			console.log(`  Journey: ${cli.id}: Pin and Unpin survive reload; a folder window becomes a multi-root workspace and keeps its pinned agent (LIFECYCLE-3.4, ARCHITECTURE-2.2, D70)\n    ${JSON.stringify(said)}`);
			if (!before || !after || after.folders !== 2 || after.card?.runId !== before.runId || !after.card.pinned || !alive(before.pid)
				|| after.terminals.filter(each => each === before.name).length !== 1 || !['reload-pinned', 'reload-unpinned'].every(phase => said.some(line => line.phase === phase))) {
				throw new Error('Pin/Unpin did not survive reload, or the folder agent was not the same pinned run, live process and one terminal in the workspace it became.');
			}
			console.log('    ✔ Pin and Unpin survive reload; the same pinned run, live process and one terminal survive conversion');
		} finally {
			editor.kill('SIGTERM');
			endProcessesWith(user);
			endProcessesWith(path.join(facade, 'extension', 'ptyd'));
		}
	};
	try {
		if (only !== 'conversion') {
			// The journeys once for each built-in: those before it in the catalog not installed, so that it is the one preselected
			for (const [at, cli] of BUILT_INS.entries()) {
				const missing = Object.fromEntries(BUILT_INS.slice(0, at).map(earlier => [`facade.${earlier.segment}.path`, path.join(root, `unavailable-${earlier.id}`)]));
				// Muse Code as it runs on Windows, reporting nothing: its dot follows its screen (CLIS-2.3, D80)
				const screen = cli.id === 'muse' ? terminalEnv({ FACADE_IT_SCREEN: 'muse' }) : {};
				await run(at ? cli.id : 'journeys', repo, { FACADE_IT_CLI: cli.id, FACADE_IT_AVATAR: cli.avatar, FACADE_IT_AGENTS_HOME: agentsHome }, { ...missing, ...screen });
			}
			// A custom CLI with every built-in turned off, so that it is the one New Agent offers: started exactly as configured (CLIS-1.1, 3.4)
			const off = Object.fromEntries(BUILT_INS.map(cli => [`facade.${cli.segment}.enabled`, false]));
			const custom = { [CUSTOM_CLI]: { path: fake, launch: { start: ['--from-custom', 'two words'], resume: ['resume', '${sessionId}'] } } };
			await run('custom', repo, { FACADE_IT_CLI: CUSTOM_CLI, FACADE_IT_AGENTS_HOME: agentsHome }, { ...off, 'facade.custom': custom });
		}
		if (only !== 'journeys') {
			for (const cli of BUILT_INS) { await conversion(cli); }
		}
	} finally {
		if (keep) {
			console.log(`Kept ${root}`);
		} else {
			// On Windows a file a process just ended held can stay locked for a moment
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
