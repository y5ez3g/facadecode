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
	const candidates = [
		path.join(path.dirname(executable), '..', 'Resources', 'app', 'product.json'),
		path.join(path.dirname(executable), 'resources', 'app', 'product.json'),
		path.join(path.dirname(executable), '..', 'resources', 'app', 'product.json')
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

/** Variables an editor, Git or a CLI session could pass on: none of them may reach the test editor. */
function sanitizedEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (/^(VSCODE_|CLAUDE_|CODEX_|GEMINI_|ANTHROPIC_|OPENAI_|FACADE_|ELECTRON_RUN_AS_NODE$|GIT_ASKPASS$|SSH_ASKPASS$)/.test(name) && name !== 'VSCODE_EXECUTABLE') {
			delete process.env[name];
		}
	}
}

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

	// A Claude Code that records where it runs and what it was given, run as Node by this run's own
	const fake = path.join(root, 'fake-claude');
	const record = path.join(root, 'fake-claude.log');
	fs.writeFileSync(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fakeClaude.js'))} "$@"\n`, { mode: 0o755 });
	// Claude Code's configuration, where each launch trusts its folder (CLIS-3.3, D62): the suite's own, never a person's
	const claudeConfig = path.join(root, 'claude');
	fs.mkdirSync(claudeConfig);
	const home = path.join(root, 'home');
	fs.mkdirSync(home);

	// Every built-in points to a fake: the suite never starts a person's real CLI.
	const settings = {
		'facade.claude.path': fake,
		'facade.codex.path': fake,
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
			spawnSync('pkill', ['-TERM', '-f', path.join(facade, 'extension', 'ptyd')]);
		}
	};
	/**
	 * A folder window that becomes a multi-root workspace keeps its agents (ARCHITECTURE-2.2, D70). The editor refuses to enter a
	 * workspace in a test run, so this one runs no tests: a driver extension beside Facade Code starts a fake Claude Code in the
	 * folder window and adds a folder, then, in the extension host the editor restarts, says what Facade shows; this judges it.
	 */
	const conversion = async () => {
		const solo = path.join(root, 'solo');
		const second = path.join(root, 'second');
		const user = path.join(root, 'u-conversion');
		const facade = path.join(home, 'conversion');
		const out = path.join(root, 'conversion.jsonl');
		const driver = path.join(root, 'driver');
		for (const dir of [solo, second, path.join(user, 'User'), facade, driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'conversion-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'conversionDriver.js'), path.join(driver, 'extension.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		const editor = spawn(executable, [solo, '--new-window', '--disable-extensions', '--user-data-dir', user, '--extensions-dir', path.join(root, 'x-conversion'), '--shared-data-dir', path.join(root, 's-conversion'),
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'], {
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
			const after = said.find(line => line.phase === 'workspace') as { folders: number; card: { runId: string } | null; terminals: string[] } | undefined;
			console.log(`  Journey: a folder window becomes a multi-root workspace and keeps its agents (ARCHITECTURE-2.2, D70)\n    ${JSON.stringify(said)}`);
			if (!before || !after || after.folders !== 2 || after.card?.runId !== before.runId || !alive(before.pid) || after.terminals.filter(each => each === before.name).length !== 1) {
				throw new Error('The agent of the folder window was not the same run, card, live process and one terminal in the workspace it became.');
			}
			console.log('    ✔ the agent started in the folder window is the same run, card, live process and one terminal in the workspace');
		} finally {
			editor.kill('SIGTERM');
			spawnSync('pkill', ['-TERM', '-f', user]);
			spawnSync('pkill', ['-TERM', '-f', path.join(facade, 'extension', 'ptyd')]);
		}
	};
	try {
		if (only !== 'conversion') {
			await run('journeys', repo, { FACADE_IT_CLI: 'claude' });
			await run('codex', repo, { FACADE_IT_CLI: 'codex' }, { 'facade.claude.path': path.join(root, 'unavailable-claude') });
		}
		if (only !== 'journeys') {
			await conversion();
		}
	} finally {
		if (keep) {
			console.log(`Kept ${root}`);
		} else {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
