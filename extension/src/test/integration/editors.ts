/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the integration runners share (ARCHITECTURE-5.2): the official VS Code they run, the environment they leave it, the flags of
// the editors they start themselves, the repositories they open and how they see another editor's window join the Facade windows.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The official VS Code `VSCODE_EXECUTABLE` names, else macOS's standard installation where there is one. */
export function officialEditor(): string {
	const standard = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
	const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' && fs.existsSync(standard) ? standard : undefined);
	if (!executable) {
		throw new Error('Set VSCODE_EXECUTABLE to an official VS Code executable, for example "/Applications/Visual Studio Code.app/Contents/MacOS/Code".');
	}
	officialVsCode(executable);
	return executable;
}

/** The official VS Code only: a derived editor can load its own agent extension and share a data folder with a person's live state. */
function officialVsCode(executable: string): void {
	const dir = path.dirname(executable);
	const candidates = [
		path.join(dir, '..', 'Resources', 'app', 'product.json'),
		path.join(dir, 'resources', 'app', 'product.json'),
		path.join(dir, '..', 'resources', 'app', 'product.json'),
		// Windows keeps each version in a folder of its own beside Code.exe, its archive and the installation that updates alike
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

/**
 * What test-electron gives the suite's editor, for the editors a runner starts itself: no Chromium sandbox among them, as Linux
 * refuses one to an editor unpacked outside the system (microsoft/vscode#84238), and the window then never opens.
 */
export const EDITOR_FLAGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'];

/** Variables an editor, Git or a CLI session could pass on: none of them may reach the test editor. */
export function sanitizedEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (/^(VSCODE_|CLAUDE_|CODEX_|GEMINI_|ANTIGRAVITY_|MUSE_|OPENCODE_|PI_|ANTHROPIC_|OPENAI_|QWEN_|FACADE_|ELECTRON_RUN_AS_NODE$|GIT_ASKPASS$|SSH_ASKPASS$)/.test(name) && name !== 'VSCODE_EXECUTABLE') {
			delete process.env[name];
		}
	}
}

/** A new Git repository at `folder`, with one empty commit, as a person's project is. */
export function newRepository(folder: string): void {
	fs.mkdirSync(folder, { recursive: true });
	const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
	git('init', '-q', '-b', 'main');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
}

/**
 * The label of another editor's window once its window component registered it in the Facade root `facade` on this computer: the
 * first that `matches`. None within `ms`.
 */
export async function registeredWindow(facade: string, matches: (label: string) => boolean, ms = 90_000): Promise<string | undefined> {
	const registry = path.join(facade, 'extension', 'network');
	const labels = () => {
		try {
			return fs.readdirSync(registry).flatMap(file => {
				try {
					const label = (JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8')) as { label?: unknown }).label;
					return typeof label === 'string' ? [label] : [];
				} catch {
					return [];
				}
			});
		} catch {
			return [];
		}
	};
	const end = Date.now() + ms;
	for (;;) {
		const label = labels().find(matches);
		if (label !== undefined || Date.now() > end) {
			return label;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

/**
 * Ends every process whose command line contains `text` - the editors, ptyds and CLIs a run leaves, never anything else - as
 * `pkill -f` does; on Windows, which has none, by each process's command line, the text given by name rather than quoted.
 */
export function endMatching(text: string): void {
	if (process.platform !== 'win32') {
		spawnSync('pkill', ['-TERM', '-f', text]);
		return;
	}
	const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:FACADE_IT_END) -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
	spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FACADE_IT_END: text }, stdio: 'ignore' });
}

/** Where the suite's agent CLI is, in `root`: the program each built-in's path names, and the launchers some are installed with. */
export interface FakeClis {
	readonly fake: string;
	/** Built-ins whose path names a launcher of their own, by CLI ID. */
	readonly launchers: { readonly [cli: string]: string };
}

/**
 * The suite's agent CLI (`fakeCli.js` beside this file, run by this Node) in `root`, as each built-in is installed: elsewhere a
 * script; on Windows a `.cmd` as npm writes one for a package's script, which Facade starts as that script with the Node beside it
 * (CLIS-1.2), and the launchers Muse Code's and Pi's installers write, which Facade starts as they wrote them.
 */
export function fakeClis(root: string): FakeClis {
	const script = path.join(__dirname, 'fakeCli.js');
	if (process.platform !== 'win32') {
		const fake = path.join(root, 'fake-cli');
		fs.writeFileSync(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
		return { fake, launchers: {} };
	}
	const fake = path.join(root, 'fake-cli.cmd');
	fs.copyFileSync(script, path.join(root, 'fakeCli.js'));
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
	// Muse Code's `.cmd`, started through cmd.exe, and the `pi.cmd` of Pi's installer, started as its `pi-launcher.js` with Node
	const museBin = path.join(root, 'muse-bin');
	fs.mkdirSync(museBin);
	const muse = path.join(museBin, 'muse.cmd');
	fs.writeFileSync(muse, `@echo off\r\nsetlocal\r\n"${path.join(root, 'node.exe')}" "${path.join(root, 'fakeCli.js')}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
	const piBin = path.join(root, 'pi-bin');
	fs.mkdirSync(piBin);
	const pi = path.join(piBin, 'pi.cmd');
	fs.copyFileSync(script, path.join(piBin, 'pi-launcher.js'));
	fs.writeFileSync(pi, [
		'@ECHO off', 'SETLOCAL', 'SET "node=node"', '"%node%" "%~dp0pi-launcher.js" %*', 'SET "pi_exit_code=%ERRORLEVEL%"', 'IF "%pi_exit_code%"=="9009" (',
		'  IF "%node%"=="node" (', '    "%SystemRoot%\\System32\\where.exe" /Q node', '    IF ERRORLEVEL 1 GOTO node_missing', '  ) ELSE IF NOT EXIST "%node%" GOTO node_missing', ')',
		'EXIT /B %pi_exit_code%', ':node_missing', 'ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2', 'EXIT /B %pi_exit_code%', ''
	].join('\r\n'));
	return { fake, launchers: { muse, pi } };
}
