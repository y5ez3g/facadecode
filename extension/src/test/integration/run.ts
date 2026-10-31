/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the integration suite in an isolated official VS Code (ARCHITECTURE-5.2): `VSCODE_EXECUTABLE` names it, else macOS's standard
// installation where there is one. The window opens a fresh repository, with Facade's directory, user data, extensions and fake
// agent CLIs of its own; no inherited editor, Git or CLI credential variables reach it, and nothing it does touches a person's
// profile or agents.

import { runTests } from '@vscode/test-electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EDITOR_FLAGS, endMatching, fakeCli, newRepository, officialEditor, registeredWindow, sanitizedEnvironment } from './editors';

/**
 * Takes back the trust each launch gave its folder in Claude Code's configuration `file` (CLIS-3.3, D62): the entries of the run's own
 * folders under `root`, nothing else; the file is replaced whole, as Claude Code writes it.
 */
function untrust(file: string, root: string): void {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return;
	}
	const config = JSON.parse(text) as { projects?: { [folder: string]: unknown } };
	const folders = Object.keys(config.projects ?? {}).filter(folder => folder === root || folder.startsWith(`${root}${path.sep}`));
	if (!folders.length) {
		return;
	}
	for (const folder of folders) {
		delete config.projects![folder];
	}
	const temporary = `${file}.facade-it-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(config, undefined, 2)}\n`, { mode: fs.statSync(file).mode & 0o777 });
	fs.renameSync(temporary, file);
	console.log(`Took back the trust of ${folders.join(', ')} in ${file}.`);
}

async function main(): Promise<void> {
	const executable = officialEditor();
	const grep = process.env.FACADE_IT_GREP;
	// For a look at what a run left: its folder kept, and one of its editors alone (`journeys` or `conversion`)
	const keep = !!process.env.FACADE_IT_KEEP;
	const only = process.env.FACADE_IT_ONLY;
	// Real Claude Code, for `real` alone: its executable, and its configuration folder - else the person's own, signed in
	const realClaude = process.env.FACADE_IT_CLAUDE;
	const realConfig = process.env.FACADE_IT_CLAUDE_CONFIG;
	sanitizedEnvironment();
	// Short paths: the editor's IPC socket under the user data folder must stay within the platform's limit
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fdit-')));
	const repo = path.join(root, 'app');
	newRepository(repo);

	// A Claude Code that records where it runs and what it was given, run as Node by this run's own
	const fake = fakeCli(root, path.join(__dirname, 'fakeClaude.js'));
	const record = path.join(root, 'fake-claude.log');
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
	const run = async (name: string, folder: string, env: { readonly [name: string]: string } = {}, more: { readonly [setting: string]: unknown } = {}, claude: string | null = claudeConfig) => {
		const user = path.join(root, `u-${name}`);
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, ...more }));
		// Each run numbers its agents from #a1: what an earlier run's CLIs recorded goes first
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		// FACADE_HOME, the root whose `extension` folder is the extension's data (ARCHITECTURE-3.1); a cross-window run shares it
		const facade = path.join(home, name);
		fs.mkdirSync(facade, { recursive: true });
		try {
			await runTests({
				vscodeExecutablePath: executable,
				extensionDevelopmentPath: [extension, windowComponent],
				extensionTestsPath: path.join(__dirname, 'index'),
				launchArgs: [folder, '--disable-extensions', '--user-data-dir', user, '--extensions-dir', path.join(root, `x-${name}`), '--shared-data-dir', path.join(root, `s-${name}`), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
				extensionTestsEnv: {
					FACADE_HOME: facade,
					FACADE_IT_RECORD: record,
					// None: Claude Code's own default, the person's signed-in configuration
					...(claude !== null ? { CLAUDE_CONFIG_DIR: claude } : {}),
					...(grep ? { FACADE_IT_GREP: grep } : {}),
					...env
				}
			});
		} finally {
			// The window's ptyd outlives it, as it is made to: it goes with the run, and the agents it holds with it
			endMatching(path.join(facade, 'extension', 'ptyd'));
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
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
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
			endMatching(user);
			endMatching(path.join(facade, 'extension', 'ptyd'));
		}
	};
	/**
	 * Two windows of one computer (COLLABORATION-1.1, VERIFICATION J15): a second editor - user data and extensions of its own, the same
	 * Facade root, so that both window components meet in this computer's registry - holds another folder while the suite's editor
	 * runs its cross-window journey there. It runs no tests itself; it is closed with its agents afterwards.
	 */
	const crossWindow = async () => {
		const peer = path.join(root, 'peer');
		newRepository(peer);
		const user = path.join(root, 'u-peer');
		const facade = path.join(home, 'cross');
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.mkdirSync(facade, { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		const editor = spawn(executable, [peer, '--new-window', '--disable-extensions', '--user-data-dir', user, '--extensions-dir', path.join(root, 'x-peer'), '--shared-data-dir', path.join(root, 's-peer'),
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, ...EDITOR_FLAGS], {
			stdio: 'ignore',
			env: { ...process.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, CLAUDE_CONFIG_DIR: claudeConfig }
		});
		try {
			// The other window is there once its component registered it on this computer
			if (await registeredWindow(facade, label => label === 'peer') === undefined) {
				throw new Error('The second editor window did not join this computer\'s Facade windows.');
			}
			await run('cross', repo, { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: 'peer', FACADE_IT_PEER_DIR: fs.realpathSync(peer) });
		} finally {
			editor.kill('SIGTERM');
			endMatching(user);
			endMatching(path.join(facade, 'extension', 'ptyd'));
		}
	};
	/**
	 * Real Claude Code agents working together (VERIFICATION G3): YOLO off, the suite's real journey alone. Each launch trusts its folder
	 * in that Claude Code's configuration (D62), the person's own where no folder of its own is given: the run takes that back.
	 */
	const real = async () => {
		if (!realClaude) {
			throw new Error('FACADE_IT_ONLY=real starts real Claude Code: set FACADE_IT_CLAUDE to its executable, and FACADE_IT_CLAUDE_CONFIG to a configuration folder signed in for testing - unset, it is your own.');
		}
		try {
			await run('real', repo, { FACADE_IT_REAL: 'claude', FACADE_IT_GREP: 'real Claude Code' }, { 'facade.claude.path': realClaude, 'facade.yolo': false }, realConfig ?? null);
		} finally {
			untrust(realConfig ? path.join(realConfig, '.claude.json') : path.join(os.homedir(), '.claude.json'), root);
		}
	};
	try {
		if (!only || only === 'journeys') {
			await run('journeys', repo, { FACADE_IT_CLI: 'claude' });
			await run('codex', repo, { FACADE_IT_CLI: 'codex' }, { 'facade.claude.path': path.join(root, 'unavailable-claude') });
		}
		if (!only || only === 'cross') {
			await crossWindow();
		}
		if (!only || only === 'conversion') {
			await conversion();
		}
		// Never unasked: it signs in and uses an account's usage
		if (only === 'real') {
			await real();
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
