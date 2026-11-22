/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the integration suite in an isolated official VS Code (ARCHITECTURE-5.2): `VSCODE_EXECUTABLE` names it, else macOS's standard
// installation where there is one. The window opens a fresh repository, with Facade's directory, user data, extensions and fake
// agent CLIs of its own; no inherited editor, Git or CLI credential variables reach it, and nothing it does touches a person's
// profile or agents.

import { runTests } from '@vscode/test-electron';
import * as assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';
import { isDeepStrictEqual } from 'util';
import { coreCall, coreListens, coreProgram, EDITOR_FLAGS, editorProfile, endCore, endEditors, fakeClis, newRepository, officialEditor, registeredWindow, sanitizedEnvironment, testProcessCleanup } from './editors';
import { BUILT_IN_NAMES } from '../../base/names';
import { focusProbe } from './focusProbe';
import { assertTemporaryState, probeEnvironment } from './probeState';
import { checkClosedAgent, lifetimeDriverFiles, windowLifetime } from './windowLifetime';
import { activationFailure, coldCutoverJourney, missingSessionUnpin, multiWindowDriverFiles, rustMultiWindow, sharedAttachJourney, shellHandoff, withRustWindows } from './rustMultiWindow';

/** An entry of Facade's settings file, by its fields (CONFIGURATION-2.2). */
type Entry = { readonly [field: string]: unknown };

/**
 * The built-ins in their catalog order (CLIS-1.1), each with its earlier editor settings' segment, which a released build reads
 * (CONFIGURATION-6.1), and the avatar file its card shows (PANEL-1.3).
 */
const BUILT_INS: readonly { readonly id: string; readonly segment: string; readonly avatar: string }[] = [
	{ id: 'claude', segment: 'claude', avatar: 'avatar-claude.png' },
	{ id: 'codex', segment: 'codex', avatar: 'avatar-codex.png' },
	{ id: 'agy', segment: 'antigravity', avatar: 'avatar-antigravity.png' },
	{ id: 'muse', segment: 'muse', avatar: 'avatar-muse.png' },
	{ id: 'opencode', segment: 'opencode', avatar: 'avatar-opencode.png' },
	{ id: 'pi', segment: 'pi', avatar: 'avatar-pi.png' }
];

const ACCEPTANCE_DRIVERS = new Map([
	['activation-failure', { engine: 'rust', cli: 'claude' }],
	['conversion', { engine: 'old', cli: 'claude' }],
	['expiry', { engine: 'old', cli: 'claude' }],
	['lifetime', { engine: 'rust', cli: 'claude' }],
	['missing-session-unpin', { engine: 'rust', cli: 'claude' }],
	['multi-window', { engine: 'rust', cli: 'claude' }],
	['shell-handoff', { engine: 'rust', cli: 'codex' }],
	['switch', { engine: 'rust', cli: 'claude' }]
] as const);
type AcceptanceDriver = typeof ACCEPTANCE_DRIVERS extends ReadonlyMap<infer Name, unknown> ? Name : never;

/** The command line of the editor at `executable`, which installs a package into a profile (VERIFICATION E05). */
function editorCli(executable: string): string {
	const dir = path.dirname(executable);
	return process.platform === 'darwin' ? path.join(dir, '..', 'Resources', 'app', 'bin', 'code')
		: path.join(dir, 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
}

/** The suite's program: an entry of type `custom` in Facade's settings file, by its name (CONFIGURATION-2.1, 2.3). */
const CUSTOM_CLI = 'my-cli';

/**
 * Takes back the trust each launch gave its folder in Claude Code's configuration `file` (CLIS-3.3): the entries of the run's own
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
	// Compared as the platform names folders: on Windows Claude Code keys them with forward slashes and either case of drive (CLIS-3.3)
	const spelled = (folder: string) => process.platform === 'win32' ? path.win32.resolve(folder).toLowerCase() : folder;
	const base = spelled(root);
	const folders = Object.keys(config.projects ?? {}).filter(folder => spelled(folder) === base || spelled(folder).startsWith(`${base}${path.sep}`));
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
	const expectedTest = process.env.FACADE_IT_EXPECT_TESTS;
	const expectedDriver = process.env.FACADE_IT_EXPECT_DRIVER;
	// For a look at what a run left: its folder kept, and one part of it alone (`journeys`, `cross` or `conversion`)
	const keep = !!process.env.FACADE_IT_KEEP;
	const only = process.env.FACADE_IT_ONLY;
	const attachFake = process.env.FACADE_IT_FAKECLI;
	const attachUpgrade = process.env.FACADE_IT_ATTACH_UPGRADE;
	const prereleaseBuild = process.env.FACADE_IT_PRERELEASE_BUILD;
	// The engine the windows run on: `old`, the default, writes `facade.rustEngine: off` into each profile; `rust` writes `auto`, which the
	// package with core's programs takes to the Rust engine (the setting's own default is `auto`, so the suite always says it)
	const engine = process.env.FACADE_IT_ENGINE ?? 'old';
	if (engine !== 'old' && engine !== 'rust') {
		throw new Error('FACADE_IT_ENGINE is old or rust.');
	}
	// Real agents, for `real` alone: the built-in FACADE_IT_REAL (Claude Code by default) at FACADE_IT_REAL_PATH - FACADE_IT_CLAUDE
	// for Claude Code - and Claude Code's temporary configuration folder FACADE_IT_CLAUDE_CONFIG, signed in for testing. Its terminals
	// get FACADE_IT_REAL_ENV, a JSON object - such as a configuration folder of its own - and the variables FACADE_IT_REAL_PASS names,
	// taken from this environment and never written to a file. State paths must be temporary; a personal home is never inherited.
	// FACADE_IT_REAL_ENTRY instead starts it as an entry added beside the built-ins (CONFIGURATION-2.1): a JSON object of its `name`
	// and its fields but `type` and `command`, which are FACADE_IT_REAL's and its path - a credential in its `env` only as
	// `${env:NAME}` of a variable FACADE_IT_REAL_PASS passes, never written to the settings file.
	const realCli = process.env.FACADE_IT_REAL ?? 'claude';
	const realPath = process.env.FACADE_IT_REAL_PATH ?? (realCli === 'claude' ? process.env.FACADE_IT_CLAUDE : undefined);
	const realConfig = process.env.FACADE_IT_CLAUDE_CONFIG;
	const realEnv = JSON.parse(process.env.FACADE_IT_REAL_ENV ?? '{}') as { [name: string]: string };
	const realArgs: unknown = JSON.parse(process.env.FACADE_IT_REAL_ARGS ?? '[]');
	if (!Array.isArray(realArgs) || realArgs.some(arg => typeof arg !== 'string')) {
		throw new Error('FACADE_IT_REAL_ARGS must be a JSON array of CLI arguments.');
	}
	const realEntry: unknown = JSON.parse(process.env.FACADE_IT_REAL_ENTRY ?? 'null');
	const credential = /key|token|secret|password|auth|credential/i;
	if (realEntry !== null && (typeof realEntry !== 'object' || Array.isArray(realEntry) || typeof (realEntry as { name?: unknown }).name !== 'string'
		|| 'type' in realEntry || 'command' in realEntry
		|| Object.entries((realEntry as { env?: { [name: string]: unknown } }).env ?? {}).some(([name, value]) => credential.test(name) && value !== null && !/^\$\{env:[^}]+\}$/.test(String(value))))) {
		throw new Error('FACADE_IT_REAL_ENTRY must be a JSON object of a name and entry fields but type and command, a credential in its env only as ${env:NAME} of a passed variable.');
	}
	const nativeLifecycle = only === 'real-lifecycle';
	const realState = process.env.FACADE_IT_REAL_STATE;
	const realHome = process.env.FACADE_IT_REAL_HOME === 'keep';
	// YOLO is off for the real journey, unless FACADE_IT_REAL_YOLO=on: Muse Code, whose approvals have no rule for one server's tools,
	// asks before each of Facade's with YOLO off, and on Windows first sets up its sandbox, which a new home has not
	const realYolo = process.env.FACADE_IT_REAL_YOLO === 'on';
	const modelDecisions = process.env.FACADE_IT_REAL_DECISIONS === '1';
	// The update journey's packages: a released build's, FACADE_IT_RELEASED, and the ones it updates to, FACADE_IT_CURRENT - else this build's
	const released = process.env.FACADE_IT_RELEASED;
	const current = process.env.FACADE_IT_CURRENT;
	// One built-in's journeys and conversion alone, FACADE_IT_BUILT_IN, for a quick look at a change
	const builtIn = process.env.FACADE_IT_BUILT_IN;
	if (expectedTest && (!grep || !(only === 'journeys' && BUILT_INS.some(cli => cli.id === builtIn)
		|| only === 'cross' && builtIn === 'claude'))) {
		throw new Error('An exact acceptance test requires an editor journey, its permitted fake CLI and a test filter.');
	}
	if (expectedDriver) {
		const selected = ACCEPTANCE_DRIVERS.get(expectedDriver as AcceptanceDriver);
		if (!selected || expectedDriver !== only || engine !== selected.engine || builtIn !== selected.cli || expectedTest || grep || keep) {
			throw new Error('An exact acceptance driver requires the matching isolated mode, engine and fake CLI.');
		}
	}
	let observedDriver: { name: AcceptanceDriver; engine: 'old' | 'rust' } | undefined;
	const driverPassed = (name: AcceptanceDriver, actual: 'old' | 'rust') => {
		if (expectedDriver === name) {
			const serving = name === 'activation-failure' ? 'old' : engine;
			assert.strictEqual(actual, serving, 'the completed driver exercised its expected serving engine');
			assert.ok(!observedDriver, 'the exact driver runs once');
			observedDriver = { name, engine: actual };
		}
	};
	const passed = Object.fromEntries((process.env.FACADE_IT_REAL_PASS ?? '').split(',').filter(name => name && process.env[name] !== undefined).map(name => [name, process.env[name]!]));
	// A prepared temporary home may be used directly, or copied from an isolated state template.
	const prepared = only === 'real' || nativeLifecycle ? process.env.FACADE_IT_REAL_AGENTS_HOME : undefined;
	if (only === 'real' || nativeLifecycle) {
		probeEnvironment(realEnv, realHome, realConfig);
		probeEnvironment(passed, realHome);
		if (prepared !== undefined) { assertTemporaryState(prepared, 'FACADE_IT_REAL_AGENTS_HOME'); }
		if (realState) { assertTemporaryState(realState, 'FACADE_IT_REAL_STATE'); }
		if (prepared && realState) { throw new Error('Choose a prepared home or a state template, not both.'); }
	}
	// How many agents each group of the pins journey holds: 6 unless FACADE_IT_PINS_PER_GROUP says
	const pinsPerGroup = process.env.FACADE_IT_PINS_PER_GROUP;
	// The focus probe's variables: its cases, such as `N1,F2`, where its evidence goes and how it injects keys
	const probeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FACADE_IT_PROBE_')));
	// Read before this: it removes every variable of Facade's and of the CLIs' from this process
	sanitizedEnvironment();
	// Short paths: the editor's IPC socket under the user data folder must stay within the platform's limit
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fdit-')));
	const endMatching = testProcessCleanup(root);
	const repo = path.join(root, 'app');
	newRepository(repo);

	// An agent CLI that records where it runs and what it was given, as each built-in is installed
	const { fake, launchers } = fakeClis(root);
	const record = path.join(root, 'fake-cli.log');
	// Claude Code's configuration, where each launch trusts its folder (CLIS-3.3): the suite's own, never a person's
	const claudeConfig = path.join(root, 'claude');
	fs.mkdirSync(claudeConfig);
	const home = path.join(root, 'home');
	fs.mkdirSync(home);
	// Only terminal configuration points to this temporary CLI home; the editor keeps its own HOME.
	const agentsHome = prepared ?? path.join(root, 'agents-home');
	fs.mkdirSync(agentsHome, { recursive: true });
	if ((only === 'real' || nativeLifecycle) && realState) { fs.cpSync(realState, agentsHome, { recursive: true }); }
	// Antigravity merges trust into its existing temporary settings (CLIS-3.3).
	fs.mkdirSync(path.join(agentsHome, '.gemini', 'antigravity-cli'), { recursive: true });
	const agySettingsFile = path.join(agentsHome, '.gemini', 'antigravity-cli', 'settings.json');
	if (!fs.existsSync(agySettingsFile)) { fs.writeFileSync(agySettingsFile, '{}\n'); }

	/** What agents' terminals are given - the suite's home folder, and `more` - by the editor's terminal settings. */
	const isolatedStorage = { XDG_CONFIG_HOME: path.join(agentsHome, '.config'), XDG_DATA_HOME: path.join(agentsHome, '.local', 'share'), XDG_CACHE_HOME: path.join(agentsHome, '.cache'), XDG_STATE_HOME: path.join(agentsHome, '.local', 'state') };
	const terminalEnv = (more: { readonly [name: string]: string } = {}) => ({
		'terminal.integrated.env.windows': { USERPROFILE: agentsHome, ...isolatedStorage, ...more },
		'terminal.integrated.env.osx': { HOME: agentsHome, ...isolatedStorage, ...more },
		'terminal.integrated.env.linux': { HOME: agentsHome, ...isolatedStorage, ...more }
	});
	// The editor's settings: the agents' terminals isolated, and nothing that would stop a test. The CLIs are Facade's settings file's.
	const settings = {
		...terminalEnv(),
		'security.workspace.trust.enabled': false,
		'terminal.integrated.enablePersistentSessions': false,
		'window.restoreWindows': 'none',
		'update.mode': 'none',
		'extensions.autoUpdate': false,
		'extensions.autoCheckUpdates': false,
		'facade.rustEngine': engine === 'rust' ? 'auto' : 'off'
	};
	/**
	 * Facade's settings file in the Facade root `facade` (CONFIGURATION-1.1): every built-in's command a fake - the suite never starts
	 * a person's real CLI - each entry of `clis` over its built-in's, an added one as it is, and `yolo` where given.
	 */
	const facadeSettings = (facade: string, clis: { readonly [name: string]: Entry } = {}, yolo?: boolean) => {
		// Resume listing reads the settings entry's effective environment on the Orchestrator machine.
		const fixtureEnv = engine === 'rust' && only !== 'real' && !nativeLifecycle
			? { HOME: agentsHome, USERPROFILE: agentsHome, ...isolatedStorage }
			: undefined;
		const entries: { [name: string]: Entry } = Object.fromEntries(BUILT_INS.map(cli => [cli.id, {
			command: launchers[cli.id] ?? fake, ...(fixtureEnv ? { env: fixtureEnv } : {})
		}]));
		for (const [name, entry] of Object.entries(clis)) {
			entries[name] = { ...entries[name], ...entry };
		}
		fs.mkdirSync(facade, { recursive: true });
		fs.writeFileSync(path.join(facade, 'facade.json'), `${JSON.stringify({ ...yolo !== undefined ? { yolo } : {}, clis: entries }, undefined, '\t')}\n`, { mode: 0o600 });
	};
	/** The entries of the built-ins but `cli`, turned off: `cli` is the one New Agent offers. */
	const alone = (cli: string) => Object.fromEntries(BUILT_INS.filter(each => each.id !== cli).map(each => [each.id, { enabled: false }]));
	const extension = path.resolve(__dirname, '..', '..', '..', 'extension-it');
	const windowComponent = path.resolve(__dirname, '..', '..', '..', 'window');
	/** Core's programs in the stage, and what a run on the Rust engine leaves of them in the Facade root `facade`: ended as core's README ends them. */
	const corePrograms = coreProgram(path.join(extension, 'bin'));
	const endRust = async (facade: string) => {
		if (engine === 'rust') {
			await endCore(facade, expectedTest || expectedDriver ? 45_000 : undefined);
			if ((expectedTest || expectedDriver) && coreListens(facade)) {
				throw new Error('The isolated acceptance test daemon did not exit.');
			}
		}
	};
	/**
	 * One editor of the suite on `folder`, with user data, extensions and a Facade directory of its own - and shared data: without it
	 * VS Code opens the shared storage of the person's own `~/.vscode-shared` (ARCHITECTURE-5.2) - its CLIs `clis` of Facade's
	 * settings file, `yolo` there where given, and the editor's settings `more` beside the suite's.
	 */
	let testProfiles = 0;
	const run = async (name: string, folder: string, env: { readonly [name: string]: string } = {}, clis: { readonly [name: string]: Entry } = {},
		more: { readonly [setting: string]: unknown } = {}, claude = claudeConfig, yolo?: boolean) => {
		const profile = editorProfile(root, `t${++testProfiles}`);
		const { user } = profile;
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, ...more }));
		// Each run numbers its agents from #a1: what an earlier run's CLIs recorded goes first
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		// FACADE_HOME, the root whose `extension` folder is the extension's data (ARCHITECTURE-3.1); a cross-window run shares it
		const facade = path.join(home, name);
		facadeSettings(facade, clis, yolo);
		try {
			await runTests({
				vscodeExecutablePath: executable,
				extensionDevelopmentPath: [extension, windowComponent],
				extensionTestsPath: path.join(__dirname, 'index'),
				launchArgs: [folder, '--disable-extensions', ...profile.args],
				extensionTestsEnv: {
					FACADE_HOME: facade,
					FACADE_IT_RECORD: record,
					FACADE_IT_AGENTS_HOME: agentsHome,
					FACADE_IT_ENGINE: engine,
					CLAUDE_CONFIG_DIR: claude,
					...(grep ? { FACADE_IT_GREP: grep } : {}),
					...(expectedTest ? { FACADE_IT_EXPECT_TESTS: expectedTest } : {}),
					...env,
					...profile.env
				}
			});
		} finally {
			// The cross-window fixture owns both editor holds and cleans their shared services after both close.
			if (name !== 'cross') {
				endMatching(path.join(facade, 'extension', 'ptyd'));
				await endRust(facade);
			}
		}
	};
	/**
	 * A folder window that becomes a multi-root workspace keeps its agents (ARCHITECTURE-2.2). The editor refuses to enter a
	 * workspace in a test run, so this one runs no tests: a driver extension beside Facade Code starts a fake CLI in the folder window
	 * and adds a folder, then, in the extension host the editor restarts, says what Facade shows; this judges it.
	 */
	const conversion = async (cli: typeof BUILT_INS[number], reopening = false, expiry = false) => {
		const suffix = `${cli.id}${expiry ? '-expiry' : reopening ? '-reopen' : ''}`;
		// VS Code puts its main IPC socket below user data on macOS. Its already long canonical TMPDIR leaves no room for
		// names such as u-conversion-opencode or u-conversion-claude-reopen (the Unix socket limit is 103 characters).
		const profile = editorProfile(root, `${BUILT_INS.indexOf(cli)}${expiry ? 'e' : reopening ? 'r' : 'c'}`);
		const solo = path.join(root, `solo-${suffix}`);
		const second = path.join(root, `second-${suffix}`);
		const { user } = profile;
		const facade = path.join(home, `conversion-${suffix}`);
		const out = path.join(root, `conversion-${suffix}.jsonl`);
		const driver = path.join(root, `driver-${suffix}`);
		for (const dir of [solo, second, path.join(user, 'User'), facade, driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// The fake runtime registry keys leases by PID. A different journey's fixture must not reuse a stale lease.
		const more = nativeLifecycle ? terminalEnv(realEnv)
			: engine === 'old' && cli.id === 'muse' ? terminalEnv({ XDG_DATA_HOME: path.join(facade, 'agent-data') }) : {};
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, ...more }));
		facadeSettings(facade, { ...alone(cli.id), ...nativeLifecycle ? { [cli.id]: { command: realPath, args: realArgs } } : {} }, nativeLifecycle ? false : undefined);
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'conversion-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'conversionDriver.js'), path.join(driver, 'extension.js'));
		fs.copyFileSync(path.join(__dirname, 'editors.js'), path.join(driver, 'editors.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		// The flags runTests gives the other parts too: Electron's sandbox cannot start where unprivileged user namespaces are
		// restricted, as on Ubuntu 24.04 and later
		let editorOutput = '';
		const editors: ReturnType<typeof spawn>[] = [];
		const capture = (child: ReturnType<typeof spawn>) => {
			editors.push(child);
			const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
			child.stdout?.on('data', append);
			child.stderr?.on('data', append);
			child.on('error', append);
		};
		const editorEnv = { ...process.env, ...passed, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_CONVERSION: out, FACADE_IT_ENGINE: engine,
			// The first built-in's journey reloads a busy window: twenty agents beside its own (VERIFICATION G2)
			...engine === 'old' && !reopening && !nativeLifecycle && cli === BUILT_INS[0] ? { FACADE_IT_LOAD: '20' } : {},
			FACADE_IT_SECOND: second, FACADE_IT_REOPEN: reopening ? '1' : '0', FACADE_IT_NATIVE: nativeLifecycle ? cli.id : '', CLAUDE_CONFIG_DIR: realConfig ?? claudeConfig };
		let editor = spawn(executable, [solo, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: editorEnv
		});
		capture(editor);
		const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		try {
			const end = Date.now() + (nativeLifecycle ? 180_000 : 90_000);
			while (Date.now() < end && !lines().some(line => line.phase === (reopening ? 'folder' : 'workspace') || line.phase === 'error')) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
			if (reopening) {
				const before = lines().find(line => line.phase === 'folder');
				if (!before) { throw new Error(`Could not pin before closing: ${JSON.stringify(lines())}`); }
				const closeBy = Date.now() + 20_000;
				// Closed once the window's extension host has ended, its extensions deactivated, and on Windows and Linux its application;
				// macOS can keep the application process after its last window closes
				const closed = () => {
					const line = lines().find(each => each.phase === 'closed');
					return !!line && !alive(Number(line.host)) && (process.platform === 'darwin' || editor.exitCode !== null);
				};
				while (!closed() && Date.now() < closeBy) { await new Promise(resolve => setTimeout(resolve, 200)); }
				if (!closed()) { throw new Error('The isolated window did not close.'); }
				if (expiry) {
					const closedAt = Date.now();
					if (nativeLifecycle) { endMatching(path.join(facade, 'extension', 'ptyd'));
			await endRust(facade); }
					// A local window's grace, 90 seconds from its extension host's disconnect, a few seconds before `closedAt` (RULES-4.1):
					// ended about then, well after the close
					const expiresBy = closedAt + 150_000;
					while (alive(Number(before.pid)) && Date.now() < expiresBy) { await new Promise(resolve => setTimeout(resolve, 500)); }
					if (alive(Number(before.pid)) || (!nativeLifecycle && Date.now() - closedAt < 60_000)) { throw new Error('The closed window did not end its process as expected.'); }
					console.log(`  ✔ ${cli.id}: the closed window's process ended after ${Date.now() - closedAt} ms, ${nativeLifecycle ? 'forced exit of the isolated supervisor (not a grace-timer test)' : 'using the production grace period'}`);
				}
				// That application takes a second start's window, and while it still lists the closing window it reloads that one - it keeps
				// one extension development window for the same extensions - and no window comes back, in one run of a few. It is ended
				// first, as Windows and Linux end it with their last window.
				if (process.platform === 'darwin') {
					await endEditors([editor]);
				}
				editor = spawn(executable, [solo, '--new-window', '--disable-extensions', ...profile.args,
					`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
					stdio: ['ignore', 'pipe', 'pipe'], env: editorEnv
				});
				capture(editor);
				const reopenBy = Date.now() + (nativeLifecycle ? 150_000 : 45_000);
				while (Date.now() < reopenBy && !lines().some(line => line.phase === 'reopened' || line.phase === 'error')) { await new Promise(resolve => setTimeout(resolve, 250)); }
				const after = lines().find(line => line.phase === 'reopened');
				// On the Rust engine a run is known by its agent's ID once a window has claimed it, where the first window's was its start's own
				// ID: the process and the session are the run's identity there
				// A local window closed and reopened within its 90 seconds takes its run over, as a reload does - no claim ends it; after its
				// grace the process ended already and the Pin restores the exact session in a new process (RULES-4.1)
				if (!after || (expiry ? after.runId === before.runId || after.pid === before.pid || alive(Number(before.pid)) : (engine === 'rust' ? false : after.runId !== before.runId) || after.pid !== before.pid)
					|| !before.session || after.session !== before.session || after.terminals !== 1 || !alive(Number(after.pid))) {
					throw new Error(`Closing and reopening did not ${expiry ? 'restore' : 'preserve'} the pinned conversation: ${JSON.stringify(lines())}`);
				}
				console.log(`  ✔ ${cli.id}: real window close and ${expiry ? 'reopen after its grace restore the exact pinned session in a new process' : 'immediate reopen preserve Pin, exact session and process'}, with one terminal: ${JSON.stringify(lines())}`);
				if (expectedDriver === 'expiry') {
					assert.match(String(before.runId), /^run-/u, 'the previously pinned run has an old-engine identity');
					if (expiry) { driverPassed('expiry', 'old'); }
				}
				return;
			}
			const said = lines();
			const before = said.find(line => line.phase === 'folder') as { runId: string; name: string; pid: number } | undefined;
			const after = said.find(line => line.phase === 'workspace') as { folders: number; card: { runId: string; name: string; pinned: boolean } | null; terminals: string[] } | undefined;
			console.log(`  Journey: ${suffix}: Pin and Unpin survive reload; a folder window becomes a multi-root workspace and keeps its pinned agent (LIFECYCLE-3.4, ARCHITECTURE-2.2)\n    ${JSON.stringify(said)}`);
			if (!before || !after || after.folders !== 2 || after.card?.runId !== before.runId || !after.card?.pinned || !alive(before.pid)
				|| after.terminals.filter(each => each === before.name).length !== 1 || !['reload-pinned', 'reload-unpinned'].every(phase => said.some(line => line.phase === phase))) {
				throw new Error('Pin/Unpin did not survive reload, or the folder agent was not the same pinned run, live process and one terminal in the workspace it became.');
			}
			console.log('    ✔ Pin and Unpin survive reload; the same pinned run, live process and one terminal survive conversion');
			// Each reload's claim, timed from the reload's request to the reloaded window's runs shown: well within a local window's 90
			// seconds, which a reload must not reach (RULES-4.1, VERIFICATION G2)
			const claims = said.filter(line => line.phase === 'reload-pinned' || line.phase === 'reload-unpinned').map(line => ({ ms: Number(line.claimMs), agents: Number(line.agents) }));
			console.log(`    reload claims: ${claims.map(each => `${each.ms} ms with ${each.agents} agents`).join(', ')}`);
			if (claims.length !== 2 || claims.some(each => !Number.isFinite(each.ms) || each.ms > 45_000)) {
				throw new Error(`A reload's claim took too long or was not timed: ${JSON.stringify(claims)}`);
			}
			if (expectedDriver === 'conversion') {
				assert.match(before.runId, /^run-/u, 'the reloaded pinned run has an old-engine identity');
				driverPassed('conversion', 'old');
			}
		} catch (error) {
			console.error(`Editor output for ${suffix} (exit ${editor.exitCode}, signal ${editor.signalCode}):\n${editorOutput}`);
			throw error;
		} finally {
			try {
				await endEditors(editors);
			} finally {
				endMatching(user);
				endMatching(path.join(facade, 'extension', 'ptyd'));
			await endRust(facade);
			}
		}
	};
	/**
	 * Pins across reloads in a window of two groups, and each way a person changes one (LIFECYCLE-3.4, 3.5, VERIFICATION J12). A driver beside Facade
	 * Code starts the agents, pins every other one and reloads the window three times; this judges what it saw after each: the pinned
	 * agents' tabs alone back, in the Pins' order, each marked before the next opened, the last in front of the active group with the
	 * selection on it, every other tab hidden.
	 */
	const pins = async () => {
		const cli = BUILT_INS[0];
		const folder = path.join(root, 'pins');
		const profile = editorProfile(root, 'p');
		const { user } = profile;
		const facade = path.join(home, 'pins');
		const out = path.join(root, 'pins.jsonl');
		const driver = path.join(root, 'driver-pins');
		for (const dir of [folder, path.join(user, 'User'), facade, driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		facadeSettings(facade, alone(cli.id));
		// Activated at once: after a reload it watches the tabs open from before Facade's restoration begins
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'pins-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['*'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'pinsDriver.js'), path.join(driver, 'extension.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		let editorOutput = '';
		const editor = spawn(executable, [folder, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...passed, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_PINS: out, CLAUDE_CONFIG_DIR: claudeConfig,
				...pinsPerGroup ? { FACADE_IT_PINS_PER_GROUP: pinsPerGroup } : {} }
		});
		const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', append);
		editor.stderr?.on('data', append);
		const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		try {
			const end = Date.now() + 600_000;
			while (Date.now() < end && !lines().some(line => line.phase === 'done' || line.phase === 'error')) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
			const said = lines();
			const problems: string[] = [];
			const error = said.find(line => line.phase === 'error');
			if (error) { problems.push(`driver: ${String(error.error)}`); }
			if (!said.some(line => line.phase === 'done')) { problems.push('the journey did not finish'); }
			type Seen = { wrong: string[]; agents: { alias: string; pinned: boolean; marked?: boolean; group?: number; tabs: number }[]; active?: string; activeGroup: number };
			const shown = (seen: Seen) => seen.agents.map(agent => `${agent.alias}${agent.pinned ? 'P' : ''}${agent.tabs ? `:g${agent.group}${agent.marked ? '*' : ''}` : ':hidden'}`).join(' ');
			for (const line of said.filter(each => /^reload-\d$/.test(each.phase))) {
				const later = line.later as Seen;
				const logged = (line.logged as string[]).filter(each => /(Pinned|Unpinned) #a/.test(each));
				console.log(`  ${line.phase}: marks agreed after ${line.took} ms; later ${shown(later)}; front ${later.active} in group ${later.activeGroup}; tabs opened ${JSON.stringify(line.order)}`);
				for (const each of line.logged as string[]) { console.log(`    log: ${each.slice(0, 160)}`); }
				if (!line.back) { problems.push(`${line.phase}: not every pinned agent's tab came back, or another agent's did`); }
				if (Number(line.took) < 0) { problems.push(`${line.phase}: marks never agreed: ${JSON.stringify((line.settled as Seen).wrong)}`); }
				if (later.wrong.length) { problems.push(`${line.phase}: marks disagree later: ${JSON.stringify(later.wrong)}`); }
				if ((line.moved as string[]).length) { problems.push(`${line.phase}: pinned tabs changed group: ${JSON.stringify(line.moved)}`); }
				if ((line.shown as string[]).length) { problems.push(`${line.phase}: unpinned agents' tabs opened: ${JSON.stringify(line.shown)}`); }
				// One at a time in the Pins' order, each once, each marked before the next opened (LIFECYCLE-3.5)
				if (JSON.stringify(line.order) !== JSON.stringify(line.expectedOrder)) { problems.push(`${line.phase}: tabs opened ${JSON.stringify(line.order)}, not in the Pins' order ${JSON.stringify(line.expectedOrder)}`); }
				if ((line.unmarkedBefore as string[]).length) { problems.push(`${line.phase}: tabs opened before the one before them was marked: ${JSON.stringify(line.unmarkedBefore)}`); }
				// Nothing given back: the last pinned agent's tab in front of its group, that group the active one, the selection on it
				if (!line.front) { problems.push(`${line.phase}: the last pinned agent ${String(line.last)} is not in front of the active group: ${later.active} in group ${later.activeGroup}`); }
				if (!line.selected) { problems.push(`${line.phase}: the panel's selection is not on the last pinned agent ${String(line.last)}`); }
				if ((line.pinChanged as string[]).length) { problems.push(`${line.phase}: Pins changed: ${JSON.stringify(line.pinChanged)}`); }
				if (logged.length) { problems.push(`${line.phase}: the reload changed Pins: ${JSON.stringify(logged)}`); }
			}
			const actions = said.find(line => line.phase === 'actions');
			for (const result of (actions?.results ?? []) as { what: string; alias: string; card: boolean; tab: boolean; wrong: string[]; others: string[]; tookMs: number; activeBefore?: string; activeAfter?: string; groupBefore: number; groupAfter: number; logged: string[] }[]) {
				console.log(`  ${result.what} (${result.alias}): card ${result.card ? 'followed' : 'did NOT follow'}, tab ${result.tab ? 'followed' : 'did NOT follow'} in ${result.tookMs} ms; front ${result.activeBefore} g${result.groupBefore} -> ${result.activeAfter} g${result.groupAfter}`);
				for (const each of result.logged) { console.log(`    log: ${each.slice(0, 160)}`); }
				if (!result.card || !result.tab) { problems.push(`${result.what}: card ${result.card}, tab ${result.tab}`); }
				if (result.wrong.length) { problems.push(`${result.what}: marks disagree after: ${JSON.stringify(result.wrong)}`); }
				if (result.others.length) { problems.push(`${result.what}: other Pins changed: ${JSON.stringify(result.others)}`); }
				// A Pin or Unpin the person asks for shows its tab as a click on its card does (LIFECYCLE-3.4)
				const shows = (result as { shows?: { name: string; group: number } }).shows;
				if (shows && (!(result.activeAfter === shows.name || result.activeAfter?.startsWith(`${shows.name} `)) || result.groupAfter !== shows.group)) { problems.push(`${result.what}: its tab was not shown in front of group ${shows.group}: ${result.activeAfter} in group ${result.groupAfter}`); }
				if (result.what.startsWith('palette') && !shows && (result.activeAfter !== result.activeBefore || result.groupAfter !== result.groupBefore)) { problems.push(`${result.what}: the front changed: ${result.activeBefore} in group ${result.groupBefore} became ${result.activeAfter} in group ${result.groupAfter}`); }
			}
			const setup = said.find(line => line.phase === 'setup');
			if (setup) {
				console.log(`  setup: ${shown(setup.seen as Seen)}; front ${(setup.seen as Seen).active} in group ${(setup.seen as Seen).activeGroup}`);
				for (const each of (setup.logged ?? []) as string[]) { console.log(`    setup log: ${each.slice(0, 260)}`); }
			}
			if (problems.length) {
				throw new Error(`Pins journey:\n    ${problems.join('\n    ')}`);
			}
			console.log('  ✔ Pins: a reload brings back the pinned agents\' tabs alone, in the Pins\' order, each marked before the next, the last in front with the selection on it; marks follow every change of a Pin; no reload changes a Pin');
		} catch (error) {
			console.error(`Editor output for pins (exit ${editor.exitCode}, signal ${editor.signalCode}):\n${editorOutput.slice(-4_000)}`);
			throw error;
		} finally {
			try {
				await endEditors([editor]);
			} finally {
				endMatching(user);
				endMatching(path.join(facade, 'extension', 'ptyd'));
			await endRust(facade);
			}
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
		const profile = editorProfile(root, 'peer');
		const { user } = profile;
		const facade = path.join(home, 'cross');
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		facadeSettings(facade);
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		const editor = spawn(executable, [peer, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, ...EDITOR_FLAGS], {
			stdio: 'ignore',
			env: { ...process.env, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, CLAUDE_CONFIG_DIR: claudeConfig }
		});
		try {
			// The other window is there once its component registered it on this computer
			if (engine === 'old' && await registeredWindow(facade, label => label === 'peer') === undefined) {
				throw new Error('The second editor window did not join this computer\'s Facade windows.');
			}
			await run('cross', repo, { FACADE_IT_CLI: 'claude', FACADE_IT_PEER: 'peer', FACADE_IT_PEER_DIR: fs.realpathSync(peer) });
		} finally {
			try {
				await endEditors([editor]);
			} finally {
				endMatching(user);
				endMatching(path.join(facade, 'extension', 'ptyd'));
				await endRust(facade);
			}
		}
	};
	/**
	 * An update from a released build with a running agent, then a reload (VERIFICATION E05, J17): the released build's two packages
	 * installed in an isolated profile, an agent started there with its tab open, the current packages installed over them and the
	 * window reloaded. The agent stays with its released ptyd, its tab hidden, and each question its CLI asks its terminal is answered
	 * once: with its tab open by the editor, the window passing the answer on; hidden, by the window's headless terminal; open again,
	 * by the editor once more (ARCHITECTURE-2.3, LIFECYCLE-3.5). It needs the released packages and runs only when asked.
	 */
	const update = async () => {
		if (!released) {
			throw new Error('FACADE_IT_ONLY=update installs a released build: set FACADE_IT_RELEASED to a folder holding its facadecode and window VSIX files.');
		}
		const packages = (dir: string) => {
			const files = fs.readdirSync(dir).filter(name => name.endsWith('.vsix'));
			const component = files.find(name => name.includes('-window-')), main = files.find(name => !name.includes('-window-'));
			if (!component || !main) {
				throw new Error(`${dir} must hold a facadecode and a window VSIX file.`);
			}
			// The window component first: the other's extension pack names it
			return [path.join(dir, component), path.join(dir, main)];
		};
		const from = packages(released), to = packages(current ?? path.resolve(__dirname, '..', '..', '..', 'vsix'));
		const folder = path.join(root, 'update');
		newRepository(folder);
		const profile = editorProfile(root, 'upd');
		const { user } = profile;
		const facade = path.join(home, 'update'), out = path.join(root, 'update.jsonl'), driver = path.join(root, 'driver-update');
		for (const dir of [path.join(user, 'User'), facade, driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// The released build reads its CLIs from the editor's settings, as released builds did: the update moves them into Facade's
		// settings file, which the updated build's agents then start by (CONFIGURATION-6)
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings,
			...Object.fromEntries(BUILT_INS.map(cli => [`facade.${cli.segment}.path`, launchers[cli.id] ?? fake])),
			...Object.fromEntries(BUILT_INS.filter(each => each.id !== 'claude').map(each => [`facade.${each.segment}.enabled`, false])) }));
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'update-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'updateDriver.js'), path.join(driver, 'extension.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		const env = { ...process.env, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_UPDATE: out, CLAUDE_CONFIG_DIR: claudeConfig };
		const install = (files: readonly string[]) => {
			for (const file of files) {
				execFileSync(editorCli(executable), [...profile.args, '--install-extension', file, '--force'], { env, stdio: 'pipe', shell: process.platform === 'win32' });
			}
		};
		install(from);
		let editorOutput = '';
		const editor = spawn(executable, [folder, '--new-window', ...profile.args,
			`--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], { stdio: ['ignore', 'pipe', 'pipe'], env });
		const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', append);
		editor.stderr?.on('data', append);
		const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		const phase = async (name: string, ms = 120_000) => {
			const end = Date.now() + ms;
			for (;;) {
				const line = lines().find(each => each.phase === name);
				const failed = lines().find(each => each.phase === 'error');
				if (failed) {
					throw new Error(`The update driver failed: ${failed.message}: ${JSON.stringify(lines())}`);
				}
				if (line) {
					return line;
				}
				if (Date.now() > end) {
					throw new Error(`Timed out waiting for the update journey's ${name}: ${JSON.stringify(lines())}`);
				}
				await new Promise(resolve => setTimeout(resolve, 250));
			}
		};
		const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		/**
		 * What its CLI asks, then each kind of answer it got after, by how many came within a few seconds - and what it got unasked
		 * since the last time it asked, which is to be nothing: the window's own questions' answers are the window's (ARCHITECTURE-2.3).
		 */
		let asked = 0;
		let answered = 0;
		const ask = async (alias: string) => {
			const log = `${record}.stdin.${alias}`;
			const since = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
			const unasked = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(answered, since) : '').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { data: string }).data).join('');
			// Its cursor, the device attributes and its background colour
			fs.writeFileSync(`${record}.quirks.${alias}`, JSON.stringify({ ask: '\x1b[6n\x1b[c\x1b]11;?\x1b\\', asked: ++asked }));
			await new Promise(resolve => setTimeout(resolve, 4_000));
			const got = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(since) : '').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { data: string }).data).join('');
			answered = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
			// eslint-disable-next-line no-control-regex
			return { cursor: got.match(/\x1b\[\d+;\d+R/g)?.length ?? 0, attributes: got.match(/\x1b\[\?[\d;]*c/g)?.length ?? 0, colour: got.match(/\x1b\]11;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g)?.length ?? 0, ...unasked ? { unasked } : {} };
		};
		const once = { cursor: 1, attributes: 1, colour: 1 };
		try {
			const started = await phase('started') as { phase: string; version: string; alias: string; tabs: string[][] };
			const pid = Number(fs.readFileSync(`${record}.${started.alias}`, 'utf8').trim());
			// What it got before it first asked - the released build's terminal opening - is not this journey's
			answered = fs.existsSync(`${record}.stdin.${started.alias}`) ? fs.readFileSync(`${record}.stdin.${started.alias}`, 'utf8').length : 0;
			const before = await ask(started.alias);
			install(to);
			fs.writeFileSync(`${out}.reload`, '');
			const updated = await phase('updated') as { phase: string; version: string; tabs: string[][] };
			// The updated build made Facade's settings file from the editor's settings the released build read (CONFIGURATION-6.1): every
			// built-in with its defaults under what those settings gave it, in a file with comments
			// A file that does not parse is no migration, whatever value a lenient parser makes of it
			const migrated = (() => {
				try {
					const errors: ParseError[] = [];
					const value = parseJsonc(fs.readFileSync(path.join(facade, 'facade.json'), 'utf8'), errors, { allowTrailingComma: true }) as unknown;
					return errors.length ? { unparsed: errors.map(error => error.error) } : value;
				} catch {
					return undefined;
				}
			})();
			// Each built-in shows its type, icon, enabled flag, args, env and migrated program. The file keeps the built-in names.
			const moved = { yolo: true, names: [...BUILT_IN_NAMES], clis: Object.fromEntries(BUILT_INS.map(cli => [cli.id, {
				type: cli.id, icon: cli.id, enabled: cli.id === 'claude', args: [], env: {}, program: launchers[cli.id] ?? fake
			}])) };
			const hidden = await ask(started.alias);
			fs.writeFileSync(`${out}.open`, '');
			const opened = await phase('opened') as { phase: string; tabs: string[][] };
			await new Promise(resolve => setTimeout(resolve, 2_000));
			const shown = await ask(started.alias);
			console.log(`  Journey: update from ${started.version} to ${updated.version} with a running agent, then a reload (E05, J17)\n    ${JSON.stringify({ started, before, updated, hidden, opened, shown })}`);
			const problems = [
				...updated.version === started.version ? ['the window did not reload into the update'] : [],
				...isDeepStrictEqual(migrated, moved) ? [] : [`the settings file was not made from the editor's settings: ${JSON.stringify(migrated)}`],
				...JSON.stringify(before) !== JSON.stringify(once) ? [`with its tab open in the released build its questions were answered ${JSON.stringify(before)}`] : [],
				...updated.tabs.flat().length ? [`its tab came back open after the update: ${JSON.stringify(updated.tabs)}`] : [],
				...JSON.stringify(hidden) !== JSON.stringify(once) ? [`with its tab hidden its questions were answered ${JSON.stringify(hidden)}`] : [],
				...opened.tabs.flat().length !== 1 ? [`Go to Agent did not open its one tab: ${JSON.stringify(opened.tabs)}`] : [],
				...JSON.stringify(shown) !== JSON.stringify(once) ? [`with its tab open again its questions were answered ${JSON.stringify(shown)}`] : [],
				...alive(pid) ? [] : ['its process did not survive the update']
			];
			if (problems.length) {
				throw new Error(`The update journey failed: ${problems.join('; ')}.`);
			}
			console.log('    ✔ the agent kept its process; its tab came back hidden; each question was answered once - by the editor, by the window\'s headless terminal while hidden, and by the editor again');
		} catch (error) {
			console.error(`Editor output for the update journey (exit ${editor.exitCode}, signal ${editor.signalCode}):\n${editorOutput}`);
			throw error;
		} finally {
			try {
				await endEditors([editor]);
			} finally {
				endMatching(profile.env.VSCODE_PORTABLE);
				endMatching(path.join(facade, 'extension', 'ptyd'));
			await endRust(facade);
			}
		}
	};
	/**
	 * Real agents of one built-in working together (VERIFICATION G3): YOLO off, the suite's real journey alone. Each launch trusts its
	 * folder in the CLI's own configuration where it keeps trust in a file (CLIS-3.3) - Claude Code's, or Antigravity's in the home folder
	 * its terminals have: the run takes that back, Antigravity's file restored as it was.
	 */
	const real = async () => {
		const added = realEntry as { readonly name: string; readonly [field: string]: unknown } | null;
		const cli = BUILT_INS.find(each => each.id === realCli);
		if (!cli || !realPath) {
			throw new Error('FACADE_IT_ONLY=real starts a real CLI: set FACADE_IT_REAL to a built-in and FACADE_IT_REAL_PATH to its executable (FACADE_IT_CLAUDE for Claude Code), and give it a configuration signed in for testing.');
		}
		// A real CLI updates nothing of its own while it is tested: Claude Code would download its next version at every start
		const terminals = terminalEnv({ DISABLE_AUTOUPDATER: '1', ...realEnv });
		const agySettings = path.join(agentsHome, '.gemini', 'antigravity-cli', 'settings.json');
		const agyBefore = cli.id === 'agy' ? (fs.existsSync(agySettings) ? fs.readFileSync(agySettings) : null) : undefined;
		try {
			// The other built-ins not installed: the real one is the one New Agent preselects - for an added entry, every built-in, the
			// entry its program
			const others = Object.fromEntries(BUILT_INS.filter(each => added || each !== cli).map(each => [each.id, { command: path.join(root, `unavailable-${each.id}`) }]));
			const { name, ...fields } = added ?? { name: cli.id };
			const started = { [name]: { ...added ? { type: cli.id } : {}, command: realPath, args: realArgs, ...fields } };
			await run('real', repo, { FACADE_IT_REAL: name, FACADE_IT_REAL_BUILTIN: cli.id, FACADE_IT_GREP: 'Journey: real', ...realYolo ? { FACADE_IT_REAL_YOLO: 'on' } : {}, ...modelDecisions ? { FACADE_IT_REAL_DECISIONS: '1' } : {}, ...passed },
				{ ...others, ...started }, terminals, cli.id === 'claude' ? realConfig ?? claudeConfig : claudeConfig, realYolo);
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
	/**
	 * The Rust engine's acceptance on the extension's side, in one window on it (engine.it.ts): the window runs on core of its Facade
	 * root, its terminal's `facade list` shows the editor's agent, Resume Agent restores the record Stop Agent retained, and a program
	 * is told the theme's colours.
	 */
	const rustJourneys = async () => {
		await run('engine', repo, { FACADE_IT_JOURNEY: 'engine', FACADE_IT_GREP: 'Journey: the Rust engine' }, alone('claude'));
	};
	/** Real reload, close, reopen and daemon replacement on Rust, followed by saved Pin restoration (RULES-4.1, 4.2). */
	const rustWindowLifetime = async () => {
		const folder = path.join(root, 'lifetime');
		const profile = editorProfile(root, 'l');
		const { user } = profile;
		const driver = path.join(root, 'driver-lifetime');
		const facade = path.join(home, 'lifetime');
		const out = path.join(root, 'lifetime.jsonl');
		newRepository(folder);
		fs.mkdirSync(path.join(user, 'User'), { recursive: true });
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(settings));
		fs.mkdirSync(driver);
		for (const [name, contents] of Object.entries(lifetimeDriverFiles())) {
			fs.writeFileSync(path.join(driver, name), contents);
		}
		facadeSettings(facade, alone('claude'));
		const env = { ...process.env, FACADE_HOME: facade, FACADE_IT_RECORD: path.join(root, 'lifetime-cli'), FACADE_IT_WINDOW_LIFETIME: out, CLAUDE_CONFIG_DIR: claudeConfig };
		const start = () => spawn(executable, [folder, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS],
			{ env: { ...env, ...profile.env }, stdio: ['ignore', 'pipe', 'pipe'] });
		const screen = (agent: string) => execFileSync(corePrograms, ['screen', agent, '--lines', '120'], { env, encoding: 'utf8', timeout: 20_000 });
		const list = async () => (await coreCall(facade, 'agent.list', {})).agents;
		const inspect = (agent: string) => coreCall(facade, 'agent.inspect', { target: agent });
		console.log('\n  Journey: the Rust window lifetime and saved Pins');
		try {
			await windowLifetime(start, () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', async step => {
				if (step.after === 'reload') {
					await checkClosedAgent(step, screen, list, inspect);
				} else if (step.after === 'pins') {
					const { agent } = await inspect(step.removed);
					const reference = agent.reference;
					assert.deepStrictEqual((await coreCall(facade, 'agent.remove', { target: reference })).reference, reference);
				}
			});
			if (expectedDriver === 'lifetime') {
				const steps = fs.readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
				const began = steps.find(step => step.phase === 'started')?.agent;
				const restored = steps.find(step => step.phase === 'done')?.detail;
				assert.ok(began && restored && /^a\d+$/u.test(began.id), 'the lifetime driver observed a Core agent');
				assert.deepStrictEqual([restored.id, restored.cwd, restored.session], [began.id, began.cwd, began.session]);
				const starts = fs.readFileSync(`${env.FACADE_IT_RECORD}.starts.#${began.id}`, 'utf8').trim().split(/\r?\n/u).map(Number);
				assert.deepStrictEqual(starts, [began.pid, restored.pid], 'one original start and one restoration of the saved Pin');
				driverPassed('lifetime', 'rust');
			}
		} finally {
			await endRust(facade);
		}
	};
	const rustWindows = async (runName: 'multi' | 'handoff' | 'attach' | 'cutover' | 'missing-session-unpin' | 'activation-failure') => {
		const driver = path.join(root, `driver-${runName}`);
		const facade = path.join(home, runName);
		const peer = path.join(root, `${runName}-peer`);
		const shared = path.join(root, `${runName}-shared`);
		if (runName === 'multi') {
			newRepository(peer);
			newRepository(shared);
		}
		fs.mkdirSync(driver);
		for (const [name, contents] of Object.entries(multiWindowDriverFiles())) {
			fs.writeFileSync(path.join(driver, name), contents);
		}
		let prior: { extension: string; driver: string; program: string } | undefined;
		if (runName === 'cutover') {
			assert.ok(prereleaseBuild && path.isAbsolute(prereleaseBuild),
				'Set FACADE_IT_PRERELEASE_BUILD to the absolute staged build of the accepted prerelease editor and Core.');
			assert.ok(attachFake && path.isAbsolute(attachFake) && fs.statSync(attachFake, { throwIfNoEntry: false })?.isFile(),
				'Set FACADE_IT_FAKECLI to the absolute path of the test build of facade-fakecli.');
			const stage = path.join(prereleaseBuild, 'extension-it');
			const oldDriver = path.join(root, 'driver-prerelease');
			const program = coreProgram(path.join(stage, 'bin'));
			assert.ok(fs.statSync(program, { throwIfNoEntry: false })?.isFile(), program);
			fs.mkdirSync(oldDriver);
			for (const [name, contents] of Object.entries(multiWindowDriverFiles(path.join(prereleaseBuild, 'out', 'test', 'integration')))) {
				fs.writeFileSync(path.join(oldDriver, name), contents);
			}
			prior = { extension: stage, driver: oldDriver, program };
		}
		if (runName === 'attach') {
			assert.ok(attachFake && path.isAbsolute(attachFake) && fs.statSync(attachFake, { throwIfNoEntry: false })?.isFile(),
				'Set FACADE_IT_FAKECLI to the absolute path of the test build of facade-fakecli.');
			assert.ok(!attachUpgrade || (path.isAbsolute(attachUpgrade) && fs.statSync(attachUpgrade, { throwIfNoEntry: false })?.isFile()),
				'Use an absolute, isolated program for FACADE_IT_ATTACH_UPGRADE.');
			fs.mkdirSync(facade, { recursive: true });
			const clis = { ...alone('qa-fake'), 'qa-fake': { type: 'custom', program: attachFake } };
			fs.writeFileSync(path.join(facade, 'facade.json'), JSON.stringify({ clis }));
		} else if (prior) {
			facadeSettings(facade, { ...alone('qa-fake'), 'qa-fake': {
				type: 'fake', command: attachFake!, env: {
					FAKECLI_SESSION: '960c20b4-1304-4bf8-bcc0-ef2102ad17c1', FAKECLI_STATUS: '1'
				}
			} });
		} else {
			facadeSettings(facade, alone(runName === 'handoff' ? 'codex' : 'claude'));
		}
		const files = {
			prefix: path.join(root, runName),
			read: (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
			write: (file: string, text: string) => {
				const temporary = `${file}.new`;
				fs.writeFileSync(temporary, text);
				fs.renameSync(temporary, file);
			}
		};
		// Each journey has its own Facade home and can start an a1.
		const env = { ...process.env, FACADE_HOME: facade, FACADE_IT_RECORD: path.join(root, `${runName}-cli`), CLAUDE_CONFIG_DIR: claudeConfig };
		const fallback = runName === 'activation-failure';
		const faultStage = path.join(root, 'extension-with-fault');
		const faultProgram = coreProgram(path.join(faultStage, 'bin'));
		if (fallback) {
			assert.ok(fs.statSync(corePrograms).isFile(), 'the original stage has the bundled native program');
			fs.cpSync(extension, faultStage, { recursive: true });
			// The native program path still exists, so auto selects Rust and actually attempts the spawn.
			fs.unlinkSync(faultProgram);
			fs.mkdirSync(faultProgram);
		}
		const start = (folder: string, name: string, control: string, port: number) => {
			const oldEngine = runName === 'attach' && name === 'old-engine';
			const withComponent = runName === 'multi' || oldEngine || fallback;
			const profile = editorProfile(root, `${runName[0]}-${name}`);
			const userSettings = path.join(profile.user, 'User', 'settings.json');
			if (!fs.existsSync(userSettings)) {
				fs.mkdirSync(path.dirname(userSettings), { recursive: true });
				fs.writeFileSync(userSettings, JSON.stringify({
					...settings, 'window.dialogStyle': 'custom', ...oldEngine ? { 'facade.rustEngine': 'off' } : {}
				}));
			}
			return spawn(executable, [folder, '--new-window', '--disable-extensions', ...profile.args,
				`--extensionDevelopmentPath=${fallback ? faultStage : prior?.extension ?? extension}`,
				...withComponent ? [`--extensionDevelopmentPath=${windowComponent}`] : [],
				`--extensionDevelopmentPath=${prior?.driver ?? driver}`, `--remote-debugging-port=${port}`, '--locale=en', ...EDITOR_FLAGS],
				{ env: { ...env, ...profile.env, FACADE_IT_WINDOW_CONTROL: control,
					...withComponent ? {} : { FACADE_IT_WINDOW_NO_COMPONENT: '1' },
					...fallback ? { FACADE_IT_WINDOW_FALLBACK: '1' } : {} }, stdio: ['ignore', 'pipe', 'pipe'] });
		};
		try {
			await withRustWindows(files, start, open => {
				if (runName === 'multi') {
					return rustMultiWindow(open, { folder: repo, peer, shared, home: facade, remote: null, files });
				}
				if (runName === 'missing-session-unpin') { return missingSessionUnpin(open, repo, env); }
				if (fallback) { return activationFailure(open, repo, env, faultProgram); }
				const shellEnv = {
					...env, ...isolatedStorage, HOME: agentsHome, USERPROFILE: agentsHome,
					APPDATA: path.join(agentsHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(agentsHome, 'AppData', 'Local')
				};
				if (prior) {
					return coldCutoverJourney(open, repo, shellEnv, prior.program, corePrograms, () => { prior = undefined; });
				}
				return runName === 'attach'
					? sharedAttachJourney(open, repo, corePrograms, shellEnv, attachUpgrade)
					: shellHandoff(open, repo, corePrograms, { ...shellEnv, FACADE_IT_AS: 'codex' });
			});
			// Both journeys observe the live Core daemon and an editor view of the same machine-qualified agent.
			if (runName === 'multi') { driverPassed('multi-window', 'rust'); }
			if (runName === 'handoff') { driverPassed('shell-handoff', 'rust'); }
			if (runName === 'missing-session-unpin') { driverPassed('missing-session-unpin', 'rust'); }
			if (fallback) { driverPassed('activation-failure', 'old'); }
		} finally {
			if (prior) {
				endMatching(facade);
			} else {
				await endRust(facade);
			}
			if (runName === 'attach') {
				endMatching(facade);
				endMatching(path.join(root, 'a-old-engine'));
			}
			if (fallback) { endMatching(path.join(facade, 'extension', 'ptyd')); }
		}
	};
	/**
	 * Switching engines (spec 验收): two agents under `off`; the setting `auto` and a reload: both go on, on the old engine; both ended,
	 * a new agent is not started there; reload: the window is on the Rust engine, and Resume Agent continues both saved sessions. The
	 * reloads end a test run's extension host, so a driver beside Facade Code (engineDriver.ts) does the steps and this judges them.
	 */
	const engineSwitch = async () => {
		const solo = path.join(root, 'switch-app');
		const profile = editorProfile(root, 'sw');
		const { user } = profile;
		const facade = path.join(home, 'switch');
		const out = path.join(root, 'switch.jsonl');
		const driver = path.join(root, 'driver-switch');
		for (const dir of [solo, path.join(user, 'User'), driver]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...settings, 'facade.rustEngine': 'off' }));
		facadeSettings(facade, alone('claude'));
		fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'switch-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
		fs.copyFileSync(path.join(__dirname, 'engineDriver.js'), path.join(driver, 'extension.js'));
		fs.copyFileSync(path.join(__dirname, 'resumePickerFixture.js'), path.join(driver, 'resumePickerFixture.js'));
		for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
			fs.rmSync(path.join(root, file));
		}
		let editorOutput = '';
		const editors: ReturnType<typeof spawn>[] = [];
		const editor = spawn(executable, [solo, '--new-window', '--disable-extensions', ...profile.args,
			`--extensionDevelopmentPath=${extension}`, `--extensionDevelopmentPath=${windowComponent}`, `--extensionDevelopmentPath=${driver}`, ...EDITOR_FLAGS], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_SWITCH: out, FACADE_IT_AGENTS_HOME: agentsHome, CLAUDE_CONFIG_DIR: claudeConfig }
		});
		editors.push(editor);
		const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', append);
		editor.stderr?.on('data', append);
		const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		try {
			const end = Date.now() + 240_000;
			while (Date.now() < end && !lines().some(line => line.phase === 'rust' || line.phase === 'error')) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
			const said = lines();
			console.log(`  Journey: switching engines (spec 验收)\n    ${JSON.stringify(said)}`);
			const phase = (name: string) => said.find(line => line.phase === name);
			const two = phase('two') as { before: string; defaultSetting: string; agents: { runId: string; alias: string; session: string }[]; core: boolean } | undefined;
			const still = phase('old-still') as { cards: string[]; alive: boolean[]; core: boolean; setting: string } | undefined;
			const refused = phase('refused') as { cards: number; newCli: string[]; core: boolean } | undefined;
			const rust = phase('rust') as { core: boolean; resumed: { runId: string; session: string }[] } | undefined;
			const problems = [
				...!two || two.agents.length !== 2 || two.core ? ['two agents did not start on the old engine, with no core running'] : [],
				...!still || still.setting !== 'auto' || still.core || still.alive.some(each => !each) || !two || !isDeepStrictEqual([...still.cards].sort(), two.agents.map(agent => agent.runId).sort())
					? ['after `auto` and a reload the two agents did not go on, on the old engine'] : [],
				...!refused || refused.cards !== 0 || refused.newCli.length || refused.core ? ['with both ended, a new agent was started or core was started where the window says to reload'] : [],
				...!rust || !rust.core ? ['the window did not come up on the Rust engine after the second reload'] : [],
				...rust && two && !isDeepStrictEqual(rust.resumed.map(each => each.session).sort(), two.agents.map(agent => agent.session).sort()) ? ['Resume Agent did not continue both saved sessions'] : [],
				...rust && rust.resumed.some(each => !/^[^/]+\/a\d+$/u.test(each.runId)) ? ['one of the sessions has no Orchestrator agent identity'] : [],
				...phase('error') ? [`the driver failed: ${JSON.stringify(phase('error'))}`] : []
			];
			if (problems.length) {
				throw new Error(`Switching engines failed: ${problems.join('; ')}`);
			}
			console.log('    ✔ off → auto keeps the live old agents through one reload. After they end, the next reload starts core and Resume Agent continues both saved sessions');
			if (expectedDriver === 'switch') {
				assert.ok(two);
				assert.deepStrictEqual([two.defaultSetting, two.before], ['auto', 'off']);
				assert.ok(two.agents.every(agent => /^#a\d+$/u.test(agent.alias)), 'the first two agents are old-engine runs');
				driverPassed('switch', 'rust');
			}
		} catch (error) {
			console.error(`Editor output for the engine switch (exit ${editor.exitCode}, signal ${editor.signalCode}):\n${editorOutput}`);
			throw error;
		} finally {
			try {
				await endEditors(editors);
			} finally {
				try {
					console.log('    Ending the engine switch editor and terminal helpers.');
					endMatching(user);
					endMatching(path.join(facade, 'extension', 'ptyd'));
				} finally {
					console.log('    Ending the engine switch Orchestrator.');
					await endRust(facade);
				}
				console.log('    Engine switch cleanup finished.');
			}
		}
	};
	let suiteFailure: unknown;
	try {
		// `custom` alone is the program's journey, without the built-ins' six
		if (!only || only === 'journeys' || only === 'custom') {
			// The journeys once for each built-in: those before it in the catalog not installed, so that it is the one preselected
			for (const [at, cli] of BUILT_INS.entries()) {
				if (only === 'custom' || (builtIn && builtIn !== cli.id)) {
					continue;
				}
				const missing = Object.fromEntries(BUILT_INS.slice(0, at).map(earlier => [earlier.id, { command: path.join(root, `unavailable-${earlier.id}`) }]));
				// Each agent's fake draws its input as this built-in does (CLIS-2.1); Muse Code's as it runs on Windows, reporting nothing:
				// its dot follows its screen (CLIS-2.3)
				const screen = terminalEnv({ FACADE_IT_AS: cli.id, ...cli.id === 'muse' ? { FACADE_IT_SCREEN: 'muse' } : {} });
				await run(at ? cli.id : 'journeys', repo, { FACADE_IT_CLI: cli.id, FACADE_IT_AVATAR: cli.avatar }, missing, screen);
			}
			// A program with every built-in turned off, so that it is the one New Agent offers: started exactly as configured (CLIS-1.1,
			// CONFIGURATION-2.3)
			if (builtIn) {
				return;
			}
			const off = Object.fromEntries(BUILT_INS.map(cli => [cli.id, { enabled: false }]));
			await run('custom', repo, { FACADE_IT_CLI: CUSTOM_CLI, FACADE_IT_AGENTS_HOME: agentsHome }, { ...off, [CUSTOM_CLI]: { type: 'custom', command: fake, args: ['--from-custom', 'two words'] } });
		}
		if (!only || only === 'cross') {
			await crossWindow();
		}
		if (!only || only === 'conversion') {
			for (const cli of BUILT_INS) {
				if (!builtIn || builtIn === cli.id) { await conversion(cli); }
			}
		}
		if (!only || only === 'reopen') {
			for (const cli of BUILT_INS) { await conversion(cli, true); }
		}
		if (engine === 'old' && (!only || only === 'expiry')) {
			// The shared supervisor's real local grace, not a shortened fixture timer.
			if (expectedDriver === 'expiry') { await conversion(BUILT_INS[0], true); }
			await conversion(BUILT_INS[0], true, true);
		}
		// The Rust engine's acceptance on the extension's side: with the engine on, a run of the whole suite has it, and each is asked for alone
		if (['activation-failure', 'engine', 'switch', 'lifetime', 'multi-window', 'missing-session-unpin', 'shell-handoff', 'shared-attach', 'cold-cutover'].includes(only ?? '') && engine !== 'rust') {
			throw new Error(`FACADE_IT_ONLY=${only} runs on the Rust engine: set FACADE_IT_ENGINE=rust.`);
		}
		if (only === 'engine' || (!only && engine === 'rust')) {
			await rustJourneys();
		}
		if (engine === 'rust' && (!only || only === 'lifetime' || only === 'reopen' || only === 'expiry')) {
			await rustWindowLifetime();
		}
		if (engine === 'rust' && (!only || only === 'multi-window')) {
			await rustWindows('multi');
		}
		if (only === 'missing-session-unpin') {
			await rustWindows('missing-session-unpin');
		}
		if (only === 'activation-failure') {
			await rustWindows('activation-failure');
		}
		if (engine === 'rust' && (!only || only === 'shell-handoff')) {
			await rustWindows('handoff');
		}
		if (engine === 'rust' && (only === 'shared-attach' || (!only && attachFake))) {
			await rustWindows('attach');
		}
		if (engine === 'rust' && only === 'cold-cutover') {
			await rustWindows('cutover');
		}
		if (only === 'switch' || (!only && engine === 'rust')) {
			await engineSwitch();
		}
		// Asked for alone, as its three reloads of a window of twelve agents or more take minutes
		if (only === 'pins') {
			await pins();
		}
		// Asked for alone: evidence of keys typed while a mark borrows the focus, and of covered fronts (LIFECYCLE-3.4)
		if (only === 'probe') {
			await focusProbe({ executable, root, home, extension, windowComponent, record, claudeConfig, fake, env: probeEnv, settings, endMatching,
				facadeSettings: facade => facadeSettings(facade, alone('claude')) });
		}
		// Never unasked: it installs a released build's packages
		if (only === 'update') {
			await update();
		}
		// Never unasked: it signs in and uses an account's usage
		if (only === 'real') {
			await real();
		}
		if (nativeLifecycle) {
			const cli = BUILT_INS.find(each => each.id === realCli);
			if (!cli || !realPath) { throw new Error('real-lifecycle requires a built-in CLI and FACADE_IT_REAL_PATH.'); }
			try {
				await conversion(cli);
				await conversion(cli, true);
				if (engine === 'old') { await conversion(cli, true, true); }
			} finally {
				if (cli.id === 'claude') { untrust(path.join(realConfig ?? claudeConfig, '.claude.json'), root); }
			}
		}
	} catch (error) {
		suiteFailure = error;
		throw error;
	} finally {
		try {
			if (keep) {
				console.log(`Kept ${root}`);
			} else {
				console.log('Removing the isolated editor profiles.');
				if (process.platform === 'win32') {
					// Drain test-profile children that can outlive their editor and keep the run directory locked.
					endMatching(`${root}${path.sep}`);
				}
				// On Windows a file a process just ended held can stay locked for a moment
				fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				console.log('Isolated editor profile cleanup finished.');
			}
		} catch (cleanup) {
			throw suiteFailure === undefined ? cleanup : new AggregateError([suiteFailure, cleanup], 'Editor journey and final cleanup both failed.');
		}
	}
	if (expectedDriver) {
		assert.ok(observedDriver, 'the selected acceptance driver completed its assertions');
		console.log('Facade acceptance test ' + JSON.stringify(observedDriver));
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
