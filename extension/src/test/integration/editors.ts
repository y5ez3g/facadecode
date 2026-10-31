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
	// macOS's app bundle, Linux's folder, and Windows' archive, which keeps the app in a folder named for its version
	const versioned = fs.readdirSync(dir, { withFileTypes: true }).filter(each => each.isDirectory()).map(each => path.join(dir, each.name, 'resources', 'app', 'product.json'));
	const candidates = [
		path.join(dir, '..', 'Resources', 'app', 'product.json'),
		path.join(dir, 'resources', 'app', 'product.json'),
		path.join(dir, '..', 'resources', 'app', 'product.json'),
		...versioned
	];
	const file = candidates.find(each => fs.existsSync(each));
	if (!file) {
		throw new Error(`Cannot find product.json beside ${executable}; refusing to run the suite in an unknown editor.`);
	}
	const product = JSON.parse(fs.readFileSync(file, 'utf8')) as { nameShort?: string; dataFolderName?: string; applicationName?: string };
	if (product.dataFolderName !== '.vscode' || product.applicationName !== 'code') {
		throw new Error(`${executable} is ${product.nameShort ?? 'not VS Code'} (data folder ${product.dataFolderName}); the suite runs only in official VS Code.`);
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
		if (/^(VSCODE_|CLAUDE_|CODEX_|GEMINI_|ANTHROPIC_|OPENAI_|FACADE_|ELECTRON_RUN_AS_NODE$|GIT_ASKPASS$|SSH_ASKPASS$)/.test(name) && name !== 'VSCODE_EXECUTABLE') {
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
 * Ends every process whose command line contains `pattern` - the editors, ptyds and CLIs a run leaves - as `pkill -f` does; on
 * Windows, which has none, by each process's command line.
 */
export function endMatching(pattern: string): void {
	if (process.platform !== 'win32') {
		spawnSync('pkill', ['-TERM', '-f', pattern]);
		return;
	}
	const literal = pattern.replace(/'/g, "''");
	spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
	], { stdio: 'ignore' });
}

/**
 * The suite's Claude Code as a program of its own, in `root`: a script running `script` with this Node; on Windows - where a CLI is
 * an executable, never a script - this Node made a single executable application of it (nodejs.org/api/single-executable-applications).
 */
export function fakeCli(root: string, script: string): string {
	if (process.platform !== 'win32') {
		const fake = path.join(root, 'fake-claude');
		fs.writeFileSync(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
		return fake;
	}
	const fake = path.join(root, 'fake-claude.exe');
	const blob = path.join(root, 'fake-claude.blob');
	const config = path.join(root, 'fake-claude.json');
	fs.writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true }));
	execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'pipe' });
	fs.copyFileSync(process.execPath, fake);
	execFileSync(process.execPath, [require.resolve('postject/dist/cli.js'), fake, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'pipe' });
	return fake;
}
