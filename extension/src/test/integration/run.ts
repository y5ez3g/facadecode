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
import { EDITOR_FLAGS, endMatching, fakeClis, newRepository, officialEditor, registeredWindow, sanitizedEnvironment } from './editors';
import { probeEnvironment } from './probeState';

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
	// For a look at what a run left: its folder kept, and one part of it alone (`journeys`, `cross` or `conversion`)
	const keep = !!process.env.FACADE_IT_KEEP;
	const only = process.env.FACADE_IT_ONLY;
	// Real agents, for `real` alone: the built-in FACADE_IT_REAL (Claude Code by default) at FACADE_IT_REAL_PATH - FACADE_IT_CLAUDE
	// for Claude Code - and Claude Code's temporary configuration folder FACADE_IT_CLAUDE_CONFIG, signed in for testing. Its terminals
	// get FACADE_IT_REAL_ENV, a JSON object - such as a configuration folder of its own - and the variables FACADE_IT_REAL_PASS names,
	// taken from this environment and never written to a file. State paths must be temporary; a personal home is never inherited.
	const realCli = process.env.FACADE_IT_REAL ?? 'claude';
	const realPath = process.env.FACADE_IT_REAL_PATH ?? (realCli === 'claude' ? process.env.FACADE_IT_CLAUDE : undefined);
	const realConfig = process.env.FACADE_IT_CLAUDE_CONFIG;
	const realEnv = JSON.parse(process.env.FACADE_IT_REAL_ENV ?? '{}') as { [name: string]: string };
	const realHome = process.env.FACADE_IT_REAL_HOME === 'keep';
	const passed = Object.fromEntries((process.env.FACADE_IT_REAL_PASS ?? '').split(',').filter(name => name && process.env[name] !== undefined).map(name => [name, process.env[name]!]));
	if (only === 'real') {
		probeEnvironment(realEnv, realHome, realConfig);
		probeEnvironment(passed, realHome);
	}
	sanitizedEnvironment();
	// Short paths: the editor's IPC socket under the user data folder must stay within the platform's limit
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fdit-')));
	const repo = path.join(root, 'app');
	newRepository(repo);

	// An agent CLI that records where it runs and what it was given, as each built-in is installed
	const { fake, launchers } = fakeClis(root);
	const record = path.join(root, 'fake-cli.log');
	// Claude Code's configuration, where each launch trusts its folder (CLIS-3.3, D62): the suite's own, never a person's
	const claudeConfig = path.join(root, 'claude');
	fs.mkdirSync(claudeConfig);
	const home = path.join(root, 'home');
	fs.mkdirSync(home);
	// The home folder agents' terminals see, where a CLI such as Antigravity keeps the folders it trusts: the suite's own. Only the
	// terminals' environment names it, as a person's terminal settings could; the editor keeps its own HOME.
	const agentsHome = path.join(root, 'agents-home');
	fs.mkdirSync(agentsHome);
	// Antigravity's settings as it leaves them once it has run there: Facade merges its trust into a file the CLI made, and makes none (D103)
	fs.mkdirSync(path.join(agentsHome, '.gemini', 'antigravity-cli'), { recursive: true });
	fs.writeFileSync(path.join(agentsHome, '.gemini', 'antigravity-cli', 'settings.json'), '{}\n');

	/** What agents' terminals are given - the suite's home folder, and `more` - by the editor's terminal settings. */
	const terminalEnv = (more: { readonly [name: string]: string } = {}) => ({
		'terminal.integrated.env.windows': { USERPROFILE: agentsHome, XDG_CONFIG_HOME: path.join(agentsHome, '.config'), XDG_DATA_HOME: path.join(agentsHome, '.local', 'share'), XDG_CACHE_HOME: path.join(agentsHome, '.cache'), XDG_STATE_HOME: path.join(agentsHome, '.local', 'state'), ...more },
		'terminal.integrated.env.osx': { HOME: agentsHome, XDG_CONFIG_HOME: path.join(agentsHome, '.config'), XDG_DATA_HOME: path.join(agentsHome, '.local', 'share'), XDG_CACHE_HOME: path.join(agentsHome, '.cache'), XDG_STATE_HOME: path.join(agentsHome, '.local', 'state'), ...more },
		'terminal.integrated.env.linux': { HOME: agentsHome, XDG_CONFIG_HOME: path.join(agentsHome, '.config'), XDG_DATA_HOME: path.join(agentsHome, '.local', 'share'), XDG_CACHE_HOME: path.join(agentsHome, '.cache'), XDG_STATE_HOME: path.join(agentsHome, '.local', 'state'), ...more }
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
	const run = async (name: string, folder: string, env: { readonly [name: string]: string } = {}, more: { readonly [setting: string]: unknown } = {}, claude = claudeConfig) => {
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
					FACADE_IT_AGENTS_HOME: agentsHome,
					CLAUDE_CONFIG_DIR: claude,
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
	 * workspace in a test run, so this one runs no tests: a driver extension beside Facade Code starts a fake CLI in the folder window
	 * and adds a folder, then, in the extension host the editor restarts, says what Facade shows; this judges it.
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
		// The flags runTests gives the other parts too: Electron's sandbox cannot start where unprivileged user namespaces are
		// restricted, as on Ubuntu 24.04 and later
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
	 * Real agents of one built-in working together (VERIFICATION G3): YOLO off, the suite's real journey alone. Each launch trusts its
	 * folder in the CLI's own configuration where it keeps trust in a file (D62) - Claude Code's, or Antigravity's in the home folder
	 * its terminals have: the run takes that back, Antigravity's file restored as it was.
	 */
	const real = async () => {
		const cli = BUILT_INS.find(each => each.id === realCli);
		if (!cli || !realPath) {
			throw new Error('FACADE_IT_ONLY=real starts a real CLI: set FACADE_IT_REAL to a built-in and FACADE_IT_REAL_PATH to its executable (FACADE_IT_CLAUDE for Claude Code), and give it a configuration signed in for testing.');
		}
		const terminals = terminalEnv(realEnv);
		const agySettings = path.join(agentsHome, '.gemini', 'antigravity-cli', 'settings.json');
		const agyBefore = cli.id === 'agy' ? (fs.existsSync(agySettings) ? fs.readFileSync(agySettings) : null) : undefined;
		try {
			// The other built-ins not installed: the real one is the one New Agent preselects
			const others = Object.fromEntries(BUILT_INS.filter(each => each !== cli).map(each => [`facade.${each.segment}.path`, path.join(root, `unavailable-${each.id}`)]));
			await run('real', repo, { FACADE_IT_REAL: cli.id, FACADE_IT_GREP: 'Journey: real', ...passed }, { ...others, [`facade.${cli.segment}.path`]: realPath, 'facade.yolo': false, ...terminals }, cli.id === 'claude' ? realConfig ?? claudeConfig : claudeConfig);
		} finally {
			if (cli.id === 'claude') {
				untrust(path.join(realConfig ?? claudeConfig, '.claude.json'), root);
			}
			if (agyBefore === null) {
				fs.rmSync(agySettings, { force: true });
			} else if (agyBefore !== undefined) {
				fs.writeFileSync(agySettings, agyBefore);
				console.log(`Restored ${agySettings} as it was before the run.`);
			}
		}
	};
	try {
		if (!only || only === 'journeys') {
			// The journeys once for each built-in: those before it in the catalog not installed, so that it is the one preselected
			for (const [at, cli] of BUILT_INS.entries()) {
				const missing = Object.fromEntries(BUILT_INS.slice(0, at).map(earlier => [`facade.${earlier.segment}.path`, path.join(root, `unavailable-${earlier.id}`)]));
				// Each agent's fake draws its input as this built-in does (CLIS-2.1); Muse Code's as it runs on Windows, reporting nothing:
				// its dot follows its screen (CLIS-2.3, D80)
				const screen = terminalEnv({ FACADE_IT_AS: cli.id, ...cli.id === 'muse' ? { FACADE_IT_SCREEN: 'muse' } : {} });
				await run(at ? cli.id : 'journeys', repo, { FACADE_IT_CLI: cli.id, FACADE_IT_AVATAR: cli.avatar }, { ...missing, ...screen });
			}
			// A custom CLI with every built-in turned off, so that it is the one New Agent offers: started exactly as configured (CLIS-1.1, 3.4)
			const off = Object.fromEntries(BUILT_INS.map(cli => [`facade.${cli.segment}.enabled`, false]));
			const custom = { [CUSTOM_CLI]: { path: fake, launch: { start: ['--from-custom', 'two words'], resume: ['resume', '${sessionId}'] } } };
			await run('custom', repo, { FACADE_IT_CLI: CUSTOM_CLI, FACADE_IT_AGENTS_HOME: agentsHome }, { ...off, 'facade.custom': custom });
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
			// On Windows a file a process just ended held can stay locked for a moment
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
