/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { catalogFrom, runSettingsOf, TEST_SETTINGS_FILE } from './settingsFixtures';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { GROUP_ORDER, invocation } from '../clis/adapter';
import { BUILT_IN_ADAPTERS } from '../clis/catalog';
import { claudeAdapter, claudeRunSettings } from '../clis/claude';
import { codexAdapter, tomlString } from '../clis/codex';
import { shown } from '../clis/config';
import { executableAt, launchTarget, resolveExecutable, unsafeForCmd, which } from '../clis/executable';
import { piInstallerTarget } from '../clis/pi';
import { CliPlanError, DestinationEnvironment, discover, planLaunch, PlanInput } from '../clis/plan';
import { tempDir } from './util';

/** A program the catalog can find: an executable file that is never run. */
function program(dir: string, name: string): string {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
	fs.chmodSync(file, 0o755);
	return file;
}

/** The `pi.cmd` Pi's own Windows installer (pi.dev, for Pi 1.4.0) writes, with its choice of Node `setup`. */
function PI_CMD(setup: string): string {
	return `@ECHO off\r\nSETLOCAL\r\n${setup}\r\n"%node%" "%~dp0pi-launcher.js" %*\r\nSET "pi_exit_code=%ERRORLEVEL%"\r\nIF "%pi_exit_code%"=="9009" (\r\n  IF "%node%"=="node" (\r\n    "%SystemRoot%\\System32\\where.exe" /Q node\r\n    IF ERRORLEVEL 1 GOTO node_missing\r\n  ) ELSE IF NOT EXIST "%node%" GOTO node_missing\r\n)\r\nEXIT /B %pi_exit_code%\r\n:node_missing\r\nECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2\r\nEXIT /B %pi_exit_code%\r\n`;
}
/** The installer's choice of Node where it installed a Node of its own. */
const PI_OWN_NODE = 'SET "node=node"\r\nIF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"';

suite('CLIs: the catalog (CLIS-1.1, CONFIGURATION-2.1)', () => {

	test('the built-ins in their order, with their API IDs, commands and entries in clis', () => {
		assert.deepStrictEqual(BUILT_IN_ADAPTERS.map(adapter => [adapter.displayName, adapter.id, adapter.command, adapter.setting]), [
			['Claude Code', 'claude', 'claude', 'clis.claude'],
			['Codex', 'codex', 'codex', 'clis.codex'],
			['Antigravity', 'agy', 'agy', 'clis.agy'],
			['Muse Code', 'muse', 'muse', 'clis.muse'],
			['OpenCode', 'opencode', 'opencode', 'clis.opencode'],
			['Pi', 'pi', 'pi', 'clis.pi']
		]);
		assert.deepStrictEqual(catalogFrom().entries.map(entry => entry.adapter.id), ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']);
	});

	test('a built-in\'s run settings are merged with the person\'s, never refused; its YOLO mapping is refused, naming its place (CONFIGURATION-3.1, 5.1)', () => {
		const claude = catalogFrom({ clis: { claude: { args: ['--verbose', '--settings', '{}', '--dangerously-skip-permissions'] } } }).entries.find(entry => entry.adapter.id === 'claude')!;
		assert.deepStrictEqual([claude.extra, claude.problems.map(problem => problem.said)], [['--verbose', '--settings', '{}', '--dangerously-skip-permissions'], [
			{ kind: 'args_reserved', values: ['clis.claude.args', '3', '--dangerously-skip-permissions'] }
		]]);
	});
});

suite('CLIs: finding a program as its terminal would (CLIS-1.2)', () => {

	test('an empty path is the command on PATH - a quoted entry too - a simple name is searched on PATH, ~ is the environment\'s home, a relative path is from the launch folder, an absolute one exact', () => {
		const temp = tempDir('fd-exe-');
		try {
			// By this host's rules: a folder here is named as this system names it - on Windows with a drive and its colon, which a
			// POSIX PATH would split - and a program there is one with an extension PATHEXT has
			const platform = process.platform === 'win32' ? 'win32' : 'darwin';
			const ext = platform === 'win32' ? '.cmd' : '';
			const bin = path.join(temp.dir, 'bin');
			const onPath = program(bin, `claude${ext}`);
			const other = program(bin, `claude-beta${ext}`);
			const home = path.join(temp.dir, 'home');
			const inHome = program(home, `tools/agent${ext}`);
			const cwd = path.join(temp.dir, 'work');
			const relative = program(cwd, `scripts/agent${ext}`);
			const env = { PATH: `"${bin}"`, HOME: home, USERPROFILE: home };
			const found = (configured: string) => resolveExecutable(configured, 'claude', 'clis.claude', env, cwd, platform);
			assert.deepStrictEqual([found(''), found('claude-beta'), found('~/tools/agent'), found('./scripts/agent'), found(onPath)].map(each => each.executable), [onPath, other, inHome, relative, onPath]);
			assert.match(found('missing-cli').problem!, /^clis\.claude\.command is "missing-cli", which was not found on the PATH/);
			assert.match(resolveExecutable('', 'claude', 'clis.claude', { PATH: path.join(temp.dir, 'none') }, cwd, platform).problem!, /^claude was not found on the PATH of a terminal in .*, and clis\.claude\.command does not name its location$/);
			// A folder of its name, or a file that cannot be run, is no program
			fs.mkdirSync(path.join(bin, 'claude-dir'));
			const plain = path.join(bin, 'claude-plain');
			fs.writeFileSync(plain, '');
			assert.deepStrictEqual([which('claude-dir', env, platform), which('claude-plain', env, platform), executableAt(plain, env, platform)], [undefined, undefined, undefined]);
		} finally {
			temp.remove();
		}
	});

	test('a relative PATH entry is from the launch folder, so discovery and launch find the same program wherever the extension host runs (CLIS-1.2)', () => {
		const temp = tempDir('fd-exe-');
		try {
			const cwd = path.join(temp.dir, 'work');
			const local = program(path.join(cwd, 'node_modules', '.bin'), 'claude');
			const env = { PATH: 'node_modules/.bin' };
			assert.strictEqual(which('claude', env, 'darwin', cwd), local);
			assert.strictEqual(resolveExecutable('', 'claude', 'clis.claude', env, cwd, 'darwin').executable, local);
			assert.ok(path.isAbsolute(local));
			// Another launch folder has no such program, whatever this process's own folder holds
			assert.match(resolveExecutable('', 'claude', 'clis.claude', env, temp.dir, 'darwin').problem!, /^claude was not found on the PATH/);
		} finally {
			temp.remove();
		}
	});

	test('on Windows a command is found with PATHEXT, a variable named in any case', () => {
		const temp = tempDir('fd-exe-');
		try {
			const cmd = path.join(temp.dir, 'claude.cmd');
			fs.writeFileSync(cmd, '');
			assert.strictEqual(which('claude', { Path: temp.dir, PathExt: '.EXE;.CMD' }, 'win32'), cmd);
		} finally {
			temp.remove();
		}
	});

	test('on Windows only what a launch can start is a program: a PowerShell or Windows Script Host script is not, on PATH or configured (CLIS-1.2)', () => {
		const temp = tempDir('fd-exe-');
		try {
			const first = path.join(temp.dir, 'first'), second = path.join(temp.dir, 'second');
			fs.mkdirSync(first); fs.mkdirSync(second);
			for (const script of ['claude.vbs', 'claude.ps1']) {
				fs.writeFileSync(path.join(first, script), '');
			}
			fs.writeFileSync(path.join(second, 'claude.exe'), '');
			// PATHEXT may list a script Windows runs by its file association, which a launch cannot: the next folder's program is found
			assert.strictEqual(which('claude', { Path: `${first};${second}`, PATHEXT: '.VBS;.EXE' }, 'win32'), path.join(second, 'claude.exe'));
			const configured = resolveExecutable(path.join(first, 'claude.ps1'), 'claude', 'clis.claude', { PATHEXT: '.EXE' }, temp.dir, 'win32');
			assert.deepStrictEqual(configured.problem !== undefined && configured.said, { kind: 'not_runnable', values: ['clis.claude', JSON.stringify(path.join(first, 'claude.ps1')), path.join(first, 'claude.ps1')] });
			for (const runnable of ['x.exe', 'x.com', 'x.cmd', 'x.bat', 'cli.js', 'cli.cjs', 'cli.mjs']) {
				fs.writeFileSync(path.join(second, runnable), '');
				assert.strictEqual(resolveExecutable(path.join(second, runnable), 'claude', 'clis.claude', {}, temp.dir, 'win32').executable, path.join(second, runnable), runnable);
			}
		} finally {
			temp.remove();
		}
	});

	test('npm\'s Windows shim is started as the script it runs with the Node beside it; another .cmd goes through cmd.exe, which is given no argument it reads as its own', () => {
		const temp = tempDir('fd-shim-');
		try {
			const shim = path.join(temp.dir, 'claude.cmd');
			fs.writeFileSync(shim, '@ECHO off\r\nSET "_prog=%dp0%\\node.exe"\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
			fs.writeFileSync(path.join(temp.dir, 'node.exe'), '');
			const script = path.join(temp.dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
			fs.mkdirSync(path.dirname(script), { recursive: true });
			fs.writeFileSync(script, '');
			assert.deepStrictEqual(launchTarget(shim, 'win32', {}), { executable: path.join(temp.dir, 'node.exe'), args: [script], throughCmd: false });
			const own = path.join(temp.dir, 'own.cmd');
			fs.writeFileSync(own, '@echo off\r\nsomething.exe %*\r\n');
			assert.deepStrictEqual(launchTarget(own, 'win32', {}), { executable: own, args: [], throughCmd: true });
			assert.deepStrictEqual(launchTarget(shim, 'darwin', {}), { executable: shim, args: [], throughCmd: false });
			assert.deepStrictEqual(['a&b', '50%', 'x"y', 'line\nbreak', 'two words', '(group)'].map(unsafeForCmd), [true, true, true, true, false, false]);
		} finally {
			temp.remove();
		}
	});

	test('npm\'s Windows shim for a native program starts that program itself; another shape, a program missing, outside the shim\'s folder or no .exe goes through cmd.exe', () => {
		const temp = tempDir('fd-native-shim-');
		try {
			const bin = path.join(temp.dir, 'bin');
			const exe = path.join(bin, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
			fs.mkdirSync(path.dirname(exe), { recursive: true });
			fs.writeFileSync(exe, '');
			fs.mkdirSync(path.join(temp.dir, 'other'));
			fs.writeFileSync(path.join(temp.dir, 'other', 'opencode.exe'), '');
			fs.writeFileSync(path.join(bin, 'node_modules', '@opencode', 'cli', 'bin', 'run.cmd'), '');
			// What npm 11 writes for a package whose bin is a native program, byte for byte
			const npm = (program: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${program}"   %*\r\n`;
			const shim = path.join(bin, 'opencode.cmd');
			const program = 'node_modules\\@opencode\\cli\\bin\\opencode.exe';
			for (const text of [npm(program), npm(program).replace(/\r\n/g, '\n')]) {
				fs.writeFileSync(shim, text);
				assert.deepStrictEqual(launchTarget(shim, 'win32', {}), { executable: exe, args: [], throughCmd: false });
			}
			const through = { executable: shim, args: [], throughCmd: true };
			for (const text of [
				npm('node_modules\\@opencode\\cli\\bin\\missing.exe'),
				npm('..\\other\\opencode.exe'),
				npm('node_modules\\@opencode\\cli\\bin\\run.cmd'),
				// A line of its own before the program: not npm's shim, so not known to start only the program
				npm(program).replace('SETLOCAL\r\n', 'SETLOCAL\r\nSET OPENCODE_CONFIG=x\r\n'),
				`${npm(program)}echo done\r\n`
			]) {
				fs.writeFileSync(shim, text);
				assert.deepStrictEqual(launchTarget(shim, 'win32', {}), through, text);
			}
			fs.writeFileSync(shim, npm(program));
			assert.deepStrictEqual(launchTarget(shim, 'darwin', {}), { executable: shim, args: [], throughCmd: false });
		} finally {
			temp.remove();
		}
	});

	test('Pi\'s installer launcher runs its pi-launcher.js with the Node it chooses - its own Node in LOCALAPPDATA while that is there, else node on PATH; another shape or choice of Node, or no Node of its own on PATH, is left to cmd.exe', () => {
		const temp = tempDir('fd-pi-shim-');
		try {
			const bin = path.join(temp.dir, 'bin');
			const nodeDir = path.join(temp.dir, 'nodejs');
			const local = path.join(temp.dir, 'local');
			fs.mkdirSync(bin);
			fs.mkdirSync(nodeDir);
			const shim = path.join(bin, 'pi.cmd');
			const launcher = path.join(bin, 'pi-launcher.js');
			fs.writeFileSync(launcher, '');
			fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
			const env = { Path: nodeDir, PATHEXT: '.EXE;.CMD', LOCALAPPDATA: local };
			const target = (text: string, where = env, platform: NodeJS.Platform = 'win32') => {
				fs.writeFileSync(shim, text);
				return piInstallerTarget(shim, platform, where, temp.dir);
			};
			const onPath = { executable: path.join(nodeDir, 'node.exe'), args: [launcher], throughCmd: false };
			assert.deepStrictEqual(target(PI_CMD('SET "node=node"')), onPath);
			// The file as this machine's installer wrote it: LF line endings, but for one CRLF
			assert.deepStrictEqual(target(PI_CMD('SET "node=node"').replace(/\r\n/g, '\n').replace('SETLOCAL\n', 'SETLOCAL\r\n')), onPath);
			// Its own Node: used while it is there
			assert.deepStrictEqual(target(PI_CMD(PI_OWN_NODE)), onPath);
			const own = path.join(local, 'pi-node', 'current', 'node.exe');
			fs.mkdirSync(path.dirname(own), { recursive: true });
			fs.writeFileSync(own, '');
			assert.deepStrictEqual(target(PI_CMD(PI_OWN_NODE)), { executable: own, args: [launcher], throughCmd: false });
			// Its message where it finds no Node may be worded otherwise, and its last line end: it still starts only the launcher
			assert.deepStrictEqual(target(PI_CMD('SET "node=node"').replace('Install Node.js 22.19.0 or newer', 'Install Node.js 24 or newer').replace(/\r\n$/, '')), onPath);
			// Not the file Pi's installer writes, whole: another Node, another program, another order or a line of its own - each
			// of which the shim would run otherwise - is left to cmd.exe
			const pathNode = PI_CMD('SET "node=node"');
			assert.deepStrictEqual([
				target(PI_CMD('SET "node=C:\\Other\\node.exe"')),
				target(PI_CMD('SET "node=node"\r\nSET "node=C:\\Other\\node.exe"')),
				target(PI_CMD('SET "node=node"\r\nSET node=C:\\Other\\node.exe')),
				target(PI_CMD(PI_OWN_NODE.split('\r\n').reverse().join('\r\n'))),
				target(pathNode.replace('"%node%" "%~dp0pi-launcher.js" %*', 'IF EXIST "%~dp0pi.exe" "%~dp0pi.exe" %*\r\n"%node%" "%~dp0pi-launcher.js" %*')),
				target(pathNode.replace('SETLOCAL\r\n', 'SETLOCAL\r\nSET "PI_CODING_AGENT_DIR=C:\\elsewhere"\r\n')),
				target(pathNode.replace('SETLOCAL\r\n', 'SETLOCAL\r\nSET NODE_OPTIONS=--inspect\r\n')),
				target(pathNode.replace('pi-launcher.js', 'other.js')),
				target(pathNode.replace('ECHO Pi could not find', 'ECHO Pi could not find & calc &')),
				target('@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n'),
				target(pathNode, env, 'darwin')
			], Array(11).fill(undefined));
			// Node on PATH that is a version manager's .cmd, or none: left to cmd.exe
			fs.rmSync(path.join(nodeDir, 'node.exe'));
			fs.writeFileSync(path.join(nodeDir, 'node.cmd'), '');
			fs.rmSync(own);
			assert.strictEqual(target(PI_CMD('SET "node=node"')), undefined);
			fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
			fs.rmSync(launcher);
			assert.strictEqual(target(PI_CMD('SET "node=node"')), undefined);
		} finally {
			temp.remove();
		}
	});
});

suite('CLIs: the launch plan (CLIS-1.3, 3.2, 4.2)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;

	setup(() => {
		temp = tempDir('fd-plan-');
		const bin = path.join(temp.dir, 'bin');
		program(bin, 'claude');
		program(bin, 'codex');
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	/** The run settings file a launch planned without a folder of its own names. */
	const RUN_SETTINGS = path.join('<run files>', 'claude-settings.json');
	/** A launch of `input` with the settings file's `clis` given. */
	const plan = (input: Partial<PlanInput> & { readonly cli: string }, clis: { readonly [name: string]: unknown } = {}, where = destination) =>
		planLaunch(catalogFrom({ clis }), { alias: '#a7', cwd, yolo: true, ...input }, where);
	const failure = (run: () => unknown) => {
		try {
			run();
		} catch (err) {
			return err instanceof CliPlanError ? [err.reason, err.message] : ['thrown', String(err)];
		}
		return 'planned';
	};

	test('Resume uses the selected exact session and current launch settings; only a maintained identity permits Pin', () => {
		const sessionId = '6e6d2b8f-84b6-4b74-a68a-12522896cad1';
		for (const cli of ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']) {
			// OpenCode sets its model in its own configuration: its entry's args carry the option instead
			const launch = plan({ cli, resume: { sessionId }, sessionFile: '/isolated/run.session.json', sessionHook: 'capture-session', yolo: false }, {
				[cli]: { command: program(temp.dir, cli), ...cli === 'opencode' ? { args: ['--model', 'selected-model'] } : { model: 'selected-model' } }
			});
			assert.deepStrictEqual(launch.args.slice(0, 2), [cli === 'claude' ? '--resume' : cli === 'agy' ? '--conversation' : cli === 'pi' || cli === 'opencode' ? '--session' : 'resume', sessionId]);
			assert.strictEqual(launch.args[launch.args.indexOf('--model') + 1], 'selected-model');
			assert.strictEqual(launch.exactResume, true);
			assert.ok(!launch.args.includes('--session-id'));
		}
		const fresh = plan({ cli: 'claude', sessionFile: '/isolated/run.session.json', sessionHook: 'capture-session' });
		assert.match(fresh.sessionId!, /^[0-9a-f-]{36}$/);
		assert.strictEqual(fresh.args[fresh.args.indexOf('--session-id') + 1], fresh.sessionId);
		assert.strictEqual(fresh.env.FACADE_CODE_SESSION_FILE, '/isolated/run.session.json');
		assert.strictEqual(runSettingsOf(fresh).hooks.SessionStart[0].hooks[0].command, 'capture-session');
		// A program is never resumed: no conversation of it can be found or told apart (CONFIGURATION-2.3)
		assert.throws(() => plan({ cli: 'mine', resume: { sessionId: '$& literal' } }, {
			mine: { type: 'custom', command: program(temp.dir, 'custom'), args: ['start-only'] }
		}), (err: unknown) => err instanceof Error && /cannot resume this exact conversation/.test(err.message));
		// An added CLI of a built-in's type resumes as its built-in does, with its own entry (CONFIGURATION-2.3)
		const own = plan({ cli: 'Codex two', resume: { sessionId: 'selected-session' }, sessionFile: '/isolated/run.session.json', sessionHook: 'capture-session', yolo: false }, {
			'Codex two': { type: 'codex', args: ['--profile', 'two'] }
		});
		assert.deepStrictEqual([own.args.slice(0, 2), own.args.includes('two'), own.builtIn], [['resume', 'selected-session'], true, 'codex']);
	});

	test('configured native continuation shortcuts cannot override the selected exact conversation', () => {
		for (const [cli, argument] of [['claude', '--continue'], ['claude', '-r'], ['claude', '--fork-session'], ['codex', '--last']]) {
			assert.throws(() => plan({ cli, resume: { sessionId: 'selected-session' } }, { [cli]: { args: [argument] } }),
				(err: unknown) => err instanceof CliPlanError && err.reason === 'configuration_invalid');
		}
	});

	test('Codex uses its native YOLO mapping, starts without its update prompt and trusts this folder by an argument alone, with no later-step integrations', () => {
		for (const yolo of [true, false]) {
			const launch = plan({ cli: 'codex', yolo });
			assert.deepStrictEqual(launch.args, [
				// Its update prompt would hold back the first task it is given (CLIS-3.2); embedded, as its -c overrides need it
				'-c', 'check_for_update_on_startup=false', '--no-daemon',
				...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
				'-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`
			]);
			assert.deepStrictEqual(launch.trust, { kind: 'arguments', args: ['-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`] });
			assert.strictEqual(launch.env.FACADE_AGENT, '#a7');
		}
		assert.strictEqual(codexAdapter.values({ cwd, platform: 'win32', yolo: false }).folderToml,
			tomlString(fs.realpathSync(cwd).replace(/[A-Z]/g, letter => letter.toLowerCase())));
	});

	test('Codex selects its completed-background correction only for the installed version that was verified (CLIS-2.3)', () => {
		const metadata = path.join(temp.dir, 'codex-package.json');
		assert.strictEqual(plan({ cli: 'codex' }).screenStatus, undefined);
		for (const version of ['0.165.0', '0.166.0', '0.166.1', '0.167.0', '0.166.0-dev']) {
			fs.writeFileSync(metadata, JSON.stringify({ version }));
			const launch = plan({ cli: 'codex' });
			assert.strictEqual(launch.version, version);
			assert.strictEqual(launch.screenStatus, version === '0.166.0' ? 'codex-0.166' : undefined);
		}
	});

	test('Codex TOML quotes paths containing quotes, backslashes, controls and Unicode without treating them as configuration syntax', () => {
		assert.strictEqual(tomlString('a"b\\c\t\n\u0000\u007F🌍'), '"a\\"b\\\\c\\t\\n\\u0000\\u007F🌍"');
		assert.throws(() => tomlString('\uD800'), /unpaired/);
		assert.throws(() => tomlString('\uDC00'), /unpaired/);
	});

	test('Claude Code maps YOLO to its native bypass, and with YOLO off turns its sandbox on where it has one, approvals left as they are; its folder is trusted in its own file, YOLO on or off (CLIS-1.3, 3.3)', () => {
		const args = (yolo: boolean) => plan({ cli: 'claude', yolo }).args;
		assert.deepStrictEqual([args(true), args(false)], [['--settings', RUN_SETTINGS, '--dangerously-skip-permissions'], ['--settings', RUN_SETTINGS]]);
		assert.deepStrictEqual([runSettingsOf(plan({ cli: 'claude', yolo: true })), runSettingsOf(plan({ cli: 'claude', yolo: false }))], [
			{ env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, disabledMcpjsonServers: ['facade'] },
			{ env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, disabledMcpjsonServers: ['facade'], sandbox: { enabled: true } }
		]);
		// Every launch trusts its folder in Claude Code's own file, never by an argument (CLIS-3.3)
		for (const yolo of [true, false]) {
			assert.strictEqual(plan({ cli: 'claude', yolo }).trust.kind, 'file', `${yolo}`);
			assert.ok(!args(yolo).some(arg => /trust/i.test(arg)), `${yolo}`);
		}
		// Windows has no Claude Code sandbox
		assert.deepStrictEqual(claudeRunSettings(false, 'win32'), { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, disabledMcpjsonServers: ['facade'] });
	});

	test('Claude Code\'s run settings hold no more than a run needs: no sandbox setting with YOLO on, no prompt of its own switched off; its title switch is cleared wherever the environment sets it (CLIS-1.3, 2.3)', () => {
		const on = runSettingsOf(plan({ cli: 'claude', yolo: true }));
		assert.deepStrictEqual([on.sandbox, on.skipDangerousModePermissionPrompt], [undefined, undefined]);
		// The host's copy, and one the folder's terminal settings give, are cleared alike: the switch would turn off its status reports
		const where: DestinationEnvironment = { ...destination, terminal: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' } };
		const cleared = [plan({ cli: 'claude' }).env, plan({ cli: 'claude', yolo: false }, {}, where).env].map(env => 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE' in env);
		assert.deepStrictEqual([cleared, runSettingsOf(plan({ cli: 'claude', yolo: false }, {}, where))], [[false, false], { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, disabledMcpjsonServers: ['facade'], sandbox: { enabled: true } }]);
	});

	test('Claude Code is kept from installing its VS Code extension, whose welcome would wait for Enter in the agent\'s terminal, unless the person set the switch (CLIS-1.2)', () => {
		assert.deepStrictEqual([plan({ cli: 'claude' }).env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL' in plan({ cli: 'codex' }).env], ['1', false]);
		// Whatever value the person gave, in any layer, is theirs: '0' or '' lets Claude Code install its extension
		const given = (where: DestinationEnvironment) => plan({ cli: 'claude' }, {}, where).env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL;
		assert.deepStrictEqual([given({ ...destination, terminal: { CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '0' } }), given({ ...destination, host: { ...destination.host, CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '' } })], ['0', '']);
		assert.strictEqual(plan({ cli: 'claude' }, { claude: { env: { CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: 'false' } } }).env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, 'false');
		// On Windows a spelling of the person's in another case is theirs too, and no second spelling is set beside it
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'claude.exe'), '');
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.EXE', USERPROFILE: temp.dir, Claude_Code_Ide_Skip_Auto_Install: '0' }, platform: 'win32' };
		const env = plan({ cli: 'claude' }, {}, windows).env;
		assert.deepStrictEqual(Object.entries(env).filter(([name]) => /^claude_code_ide_skip_auto_install$/i.test(name)), [['Claude_Code_Ide_Skip_Auto_Install', '0']]);
	});

	test('the groups go in their order: the run\'s own settings, then the YOLO mapping', () => {
		assert.deepStrictEqual([...GROUP_ORDER], ['resume', 'connect', 'quiet', 'yoloOn', 'yoloOff', 'model', 'effort', 'trust', 'session', 'extra', 'prompt']);
		const groups = { quiet: ['q', '${value}'], yoloOn: ['on'], connect: ['--mcp'], prompt: ['--', '${prompt}'] };
		const none = { connect: false, model: false, effort: false, prompt: false };
		assert.deepStrictEqual(invocation(groups, [], { yolo: false, ...none }, { value: 'v' }), ['q', 'v']);
		assert.deepStrictEqual(invocation(groups, [], { yolo: true, ...none }, { value: 'v' }), ['q', 'v', 'on']);
		assert.deepStrictEqual(invocation(groups, [], { yolo: true, ...none, connect: true, prompt: true }, { value: 'v', prompt: '-p' }), ['--mcp', 'q', 'v', 'on', '--', '-p'],
			'the connection comes first, and a prompt last after the end of the options');
		assert.deepStrictEqual(invocation(groups, ['${value}'], { yolo: true, ...none, connect: true, prompt: true }, { value: 'v', prompt: '-p' }), ['--mcp', 'q', 'v', 'on', '${value}', '--', '-p']);
	});

	test('the environment: the host\'s, the folder\'s terminal settings, the default profile\'s, the entry\'s env, then the run\'s variables - null removing - with Claude Code\'s title switch removed (CLIS-1.2, CONFIGURATION-3.2)', () => {
		const where: DestinationEnvironment = {
			...destination,
			host: { ...destination.host, SHELL_ONLY: 'kept', DROP_ME: 'x', HOST_VALUE: 'from host' },
			terminal: { TERMINAL: '${env:HOST_VALUE} via terminal', DROP_ME: null, LAYERED: 'terminal' },
			profile: { PROFILE: 'p', LAYERED: 'profile', EMPTY: '${env:EMPTY_VALUE}' },
			profileName: 'zsh'
		};
		const env = plan({ cli: 'claude' }, { claude: { env: { LAUNCHED: '${env:HOST_VALUE} via launch', LAYERED: 'launch', PROFILE: null } } }, { ...where, host: { ...where.host, EMPTY_VALUE: '' } }).env;
		assert.deepStrictEqual({ ...env, PATH: undefined, HOME: undefined }, {
			PATH: undefined, HOME: undefined, SHELL_ONLY: 'kept', HOST_VALUE: 'from host', EMPTY_VALUE: '', TERMINAL: 'from host via terminal', LAYERED: 'launch', EMPTY: '', LAUNCHED: 'from host via launch',
			CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor', FACADE_AGENT: '#a7'
		});
		assert.ok(!('CLAUDE_CODE_DISABLE_TERMINAL_TITLE' in env) && !('ELECTRON_RUN_AS_NODE' in env));
		// A variable a terminal layer reads that the host has not is read as empty, as the editor's terminal reads it: the CLIs there start
		// (CLIS-1.2); only an entry's own env says it is missing
		const missing: DestinationEnvironment = { ...where, host: { ...where.host, EMPTY_VALUE: '' }, profile: { ...where.profile, MISSING: '${env:NOT_SET}/bin' } };
		assert.deepStrictEqual([plan({ cli: 'claude' }, {}, missing).env.MISSING, discover(catalogFrom(), missing, cwd).find(each => each.entry.adapter.id === 'claude')?.available], ['/bin', true]);
	});

	test('the program is found with the launch\'s own environment: a PATH the folder\'s terminal settings set finds it, and discovery agrees with the plan', () => {
		const other = path.join(temp.dir, 'other');
		const agent = program(other, 'claude');
		const where: DestinationEnvironment = { ...destination, terminal: { PATH: other } };
		assert.strictEqual(plan({ cli: 'claude' }, {}, where).executable, agent);
		assert.strictEqual(discover(catalogFrom(), where, cwd).find(each => each.entry.adapter.id === 'claude')?.available, true);
		// A terminal PATH without the program: neither finds it, whatever the host's PATH has
		const empty: DestinationEnvironment = { ...destination, terminal: { PATH: path.join(temp.dir, 'empty') } };
		assert.deepStrictEqual(discover(catalogFrom(), empty, cwd).map(each => [each.available, each.notInstalled]), Array(BUILT_IN_ADAPTERS.length).fill([false, true]));
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, {}, empty))[0], 'not_found');
	});

	test('a built-in turned off is not offered and not started, said why (RULES-4.4); its args follow its own, and its env is its runs\'; one not installed, misconfigured or unknown fails with its actual reason (RULES-5.1)', () => {
		const off = { claude: { enabled: false } };
		let said: unknown;
		try {
			plan({ cli: 'claude' }, off);
		} catch (err) {
			said = err instanceof CliPlanError ? [err.reason, err.message, err.said] : err;
		}
		assert.deepStrictEqual([discover(catalogFrom({ clis: off }), destination, cwd).map(each => each.entry.adapter.id), said], [
			['codex', 'agy', 'muse', 'opencode', 'pi'],
			['unavailable', 'Claude Code is turned off by clis.claude.enabled', { kind: 'cli_disabled', values: ['Claude Code', 'clis.claude'] }]
		]);
		// A value of enabled that is no boolean leaves the CLI offered, unavailable with its problem: never hidden in silence
		assert.deepStrictEqual(discover(catalogFrom({ clis: { claude: { enabled: 'no' } } }), destination, cwd).map(each => [each.entry.adapter.id, each.available, each.said?.kind]).slice(0, 2),
			[['claude', false, 'entry_enabled_type'], ['codex', true, undefined]]);
		const launch = { claude: { args: ['--verbose'], model: 'opus', env: { LAUNCHED: '1' } } };
		const planned = plan({ cli: 'claude' }, launch);
		// Only Claude Code and Codex are installed here
		assert.deepStrictEqual([discover(catalogFrom({ clis: launch }), destination, cwd).map(each => each.available), planned.args, planned.env.LAUNCHED], [
			[true, true, false, false, false, false], ['--settings', RUN_SETTINGS, '--dangerously-skip-permissions', '--model', 'opus', '--verbose'], '1'
		]);
		const missing = { claude: { command: '/nowhere/claude' } };
		assert.deepStrictEqual(discover(catalogFrom({ clis: missing }), destination, cwd).map(each => [each.available, each.notInstalled]).slice(0, 2), [[false, undefined], [true, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, missing))[0], 'not_found');
		const invalid = { claude: { command: 7 } };
		assert.deepStrictEqual(discover(catalogFrom({ clis: invalid }), destination, cwd).map(each => [each.available, each.problem, each.said?.kind]).slice(0, 2), [[false, 'clis.claude.command must be a string; received number', 'entry_text_type'], [true, undefined, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, invalid))[0], 'configuration_invalid');
		assert.deepStrictEqual(failure(() => plan({ cli: 'gemini' })), ['not_found', `No CLI "gemini" is configured; the built-ins are claude, codex, agy, muse, opencode and pi, and others are added in clis of ${TEST_SETTINGS_FILE}`]);
	});

	test('each built-in\'s sandbox and approvals, as Show Agent Launch says them, name only arguments its launch has (CLIS-1.3, 4.1)', () => {
		const bin = path.join(temp.dir, 'bin');
		for (const adapter of BUILT_IN_ADAPTERS) {
			program(bin, adapter.command);
		}
		const named: string[] = [];
		for (const adapter of BUILT_IN_ADAPTERS) {
			for (const yolo of [true, false]) {
				const args = plan({ cli: adapter.id, yolo }).args;
				for (const fact of [adapter.sandbox(yolo, 'darwin'), adapter.approvals(yolo)]) {
					const by = 'by' in fact ? fact.by ?? [] : [];
					assert.ok(by.every(arg => args.includes(arg)), `${adapter.id} yolo ${yolo}: ${by.join(' ')} in ${args.join(' ')}`);
					named.push(`${adapter.id}${yolo ? '+' : '-'}${fact.state}`);
				}
			}
		}
		assert.deepStrictEqual(named, [
			'claude+native', 'claude+bypassed', 'claude-on', 'claude-native',
			'codex+off', 'codex+bypassed', 'codex-on', 'codex-native',
			'agy+none', 'agy+bypassed', 'agy-none', 'agy-native',
			'muse+off', 'muse+bypassed', 'muse-native', 'muse-native',
			'opencode+none', 'opencode+bypassed', 'opencode-none', 'opencode-native',
			'pi+none', 'pi+none', 'pi-none', 'pi-none'
		]);
		assert.deepStrictEqual(claudeAdapter.sandbox(false, 'win32'), { state: 'none' });
	});

	test('Antigravity, Muse Code, OpenCode and Pi each map YOLO to their own switches and trust their folder as their own questions would, with no later-step integrations (CLIS-1.3, 3.3)', () => {
		const bin = path.join(temp.dir, 'bin');
		const added = ['agy', 'muse', 'opencode', 'pi'];
		added.forEach(name => program(bin, name));
		// Antigravity's run settings, a file of the run, go with every launch of it (CLIS-3.4)
		const settings = ['--settings', path.join('<run files>', 'agy-settings.json')];
		assert.deepStrictEqual([true, false].map(yolo => added.map(cli => plan({ cli, yolo }).args)), [
			[[...settings, '--mode', 'accept-edits', '--dangerously-skip-permissions'], ['--disable-approval', '--disable-sandbox', '--trust-workspace'], ['--auto'], ['--approve']],
			[settings, ['--trust-workspace'], [], ['--approve']]
		]);
		// Antigravity keeps its trust in its settings, in the launch's home; the others take it for the launch, or ask none
		assert.deepStrictEqual(added.map(cli => plan({ cli }).trust.kind), ['file', 'arguments', 'arguments', 'arguments']);
		const folder = canonicalFolder(cwd);
		assert.deepStrictEqual(plan({ cli: 'agy', yolo: false }).trust, { kind: 'file', target: { file: path.join(temp.dir, '.gemini', 'antigravity-cli', 'settings.json'), keys: ['trustedWorkspaces'], entry: { item: folder }, folder } });
		for (const cli of added) {
			const launch = plan({ cli });
			assert.deepStrictEqual([launch.cli, launch.command, launch.executable, launch.env.FACADE_AGENT, 'ELECTRON_RUN_AS_NODE' in launch.env], [cli, cli, path.join(bin, cli), '#a7', false]);
		}
		// Muse Code alone is read from its screen where it sends no reports - on Windows (CLIS-2.3); the others report themselves
		assert.deepStrictEqual(['claude', 'codex', ...added].map(cli => plan({ cli }).screenStatus), [undefined, undefined, undefined, 'muse', undefined, undefined]);
	});

	test('on Windows each new built-in starts through the launcher its installer put on PATH: Muse Code\'s through cmd.exe with arguments it takes safely, OpenCode\'s npm shim as its program, Pi\'s installer launcher as its script with Node', () => {
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir, LOCALAPPDATA: path.join(temp.dir, 'local') }, platform: 'win32' };
		// Muse Code's installer: a .cmd running a PowerShell launcher
		fs.writeFileSync(path.join(bin, 'muse.cmd'), '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
		for (const yolo of [true, false]) {
			const muse = plan({ cli: 'muse', yolo }, {}, windows);
			assert.deepStrictEqual([muse.executable, muse.args], [path.join(bin, 'muse.cmd'), [...yolo ? ['--disable-approval', '--disable-sandbox'] : [], '--trust-workspace']]);
		}
		const exe = path.join(bin, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
		fs.mkdirSync(path.dirname(exe), { recursive: true });
		fs.writeFileSync(exe, '');
		fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n');
		const opencode = plan({ cli: 'opencode' }, {}, windows);
		assert.deepStrictEqual([opencode.executable, opencode.args], [exe, ['--auto']]);
		fs.writeFileSync(path.join(bin, 'node.exe'), '');
		fs.writeFileSync(path.join(bin, 'pi.cmd'), PI_CMD('SET "node=node"'));
		fs.writeFileSync(path.join(bin, 'pi-launcher.js'), '');
		const pi = plan({ cli: 'pi' }, {}, windows);
		assert.deepStrictEqual([pi.executable, pi.args], [path.join(bin, 'node.exe'), [path.join(bin, 'pi-launcher.js'), '--approve']]);
		// Antigravity's own program, and its settings in the Windows home
		fs.writeFileSync(path.join(bin, 'agy.exe'), '');
		const agy = plan({ cli: 'agy' }, {}, windows);
		assert.deepStrictEqual([agy.executable, agy.trust.kind === 'file' && agy.trust.target.file], [path.join(bin, 'agy.exe'), path.join(temp.dir, '.gemini', 'antigravity-cli', 'settings.json')]);
	});

	test('a launch through cmd.exe refuses an argument cmd.exe would read as its own, before anything starts; npm\'s shim runs its script with Node instead', () => {
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		// Claude Code's run settings are a file of the run, given by its path: through cmd.exe where that path is safe for it, refused where it is not
		const runDir = path.join(temp.dir, 'runs', 'run-1');
		const through = plan({ cli: 'claude', yolo: false, runDir }, {}, windows);
		assert.deepStrictEqual([through.executable, through.args.slice(0, 2)], [path.join(bin, 'claude.cmd'), ['--settings', path.join(runDir, 'claude-settings.json')]]);
		const result = failure(() => plan({ cli: 'claude', yolo: false, runDir: path.join(temp.dir, 'R&D', 'run-1') }, {}, windows));
		assert.deepStrictEqual(result[0], 'unsupported');
		assert.match(String(result[1]), /runs through cmd\.exe, which cannot be given the argument .* safely; set clis\.claude\.command to the CLI's own program or Node entry point$/);
		fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\nSET "_prog=%dp0%\\node.exe"\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
		fs.writeFileSync(path.join(bin, 'node.exe'), '');
		const script = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, '');
		const planned = plan({ cli: 'claude', yolo: false }, {}, windows);
		assert.deepStrictEqual([planned.executable, planned.args.slice(0, 2)], [path.join(bin, 'node.exe'), [script, '--settings']]);
	});

	test('a configured argument cmd.exe would read as its own is refused by its place in the setting and its character, never quoted: it may be a secret (CLIS-3.1, 4.1)', () => {
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'pi.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		let said: unknown;
		try {
			plan({ cli: 'pi' }, { pi: { args: ['--password', 'Hunter2!'] } }, windows);
		} catch (err) {
			said = err instanceof CliPlanError ? [err.reason, err.message.includes('Hunter2'), err.said] : err;
		}
		assert.deepStrictEqual(said, ['unsupported', false, { kind: 'cmd_unsafe_setting', values: [path.join(bin, 'pi.cmd'), 'clis.pi.args', '1', '"!"', 'clis.pi'] }]);
	});

	test('a refused configured argument is named with its own character; where the adapter\'s own arguments cannot pass either, those are named, as taking the configured one out would not help (CLIS-1.2)', () => {
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		const said = (cli: string, args: readonly string[], runDir = path.join(temp.dir, 'runs', 'run-1')) => {
			try {
				plan({ cli, runDir }, { [cli]: { args } }, windows);
				return undefined;
			} catch (err) {
				return err instanceof CliPlanError ? err.said : err;
			}
		};
		fs.writeFileSync(path.join(bin, 'pi.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		// Another argument before it holds a quote: the character named is the configured one's own
		assert.deepStrictEqual(said('pi', ['--append-system-prompt', 'say "hi"', '--name', 'R&D']), { kind: 'cmd_unsafe_setting', values: [path.join(bin, 'pi.cmd'), 'clis.pi.args', '1', '"\\""', 'clis.pi'] });
		assert.deepStrictEqual(said('pi', ['--name', 'R&D']), { kind: 'cmd_unsafe_setting', values: [path.join(bin, 'pi.cmd'), 'clis.pi.args', '1', '"&"', 'clis.pi'] });
		// Claude Code's run settings file is the adapter's own argument: where its path cannot pass, it is named, not the configured one
		fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		const configured = said('claude', ['--append-system-prompt', 'a&b']) as { kind: string; values: string[] };
		const own = said('claude', ['--append-system-prompt', 'a&b'], path.join(temp.dir, 'R&D', 'run-1')) as { kind: string; values: string[] };
		assert.deepStrictEqual([configured, own.kind, own.values[1]], [
			{ kind: 'cmd_unsafe_setting', values: [path.join(bin, 'claude.cmd'), 'clis.claude.args', '1', '"&"', 'clis.claude'] }, 'cmd_unsafe', shown(path.join(temp.dir, 'R&D', 'run-1', 'claude-settings.json'))
		]);
	});

	test('a launcher that goes through cmd.exe from a folder whose path cmd.exe reads as its own - a profile named R&D - is refused before anything starts, with the setting that fixes it', () => {
		for (const folder of ['R&D', '100%', 'a^b']) {
			const bin = path.join(temp.dir, folder, 'muse');
			fs.mkdirSync(bin, { recursive: true });
			const muse = path.join(bin, 'muse.cmd');
			fs.writeFileSync(muse, '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
			const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
			const result = failure(() => plan({ cli: 'muse' }, {}, windows));
			assert.deepStrictEqual(result, ['unsupported', `${muse} runs through cmd.exe, which cannot be given its path safely; set clis.muse.command to the CLI's own program or Node entry point`], folder);
			try {
				plan({ cli: 'muse' }, {}, windows);
			} catch (err) {
				assert.deepStrictEqual((err as CliPlanError).said, { kind: 'cmd_unsafe_path', values: [muse, 'clis.muse'] });
			}
		}
		// A path with spaces alone is quoted whole, and goes through
		const spaced = path.join(temp.dir, 'Program Files', 'muse');
		fs.mkdirSync(spaced, { recursive: true });
		fs.writeFileSync(path.join(spaced, 'muse.cmd'), '@echo off\r\nexit /b 0\r\n');
		assert.strictEqual(plan({ cli: 'muse' }, {}, { host: { Path: spaced, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' }).executable, path.join(spaced, 'muse.cmd'));
	});

	test('a launcher that goes through cmd.exe is refused in a UNC folder - a network share, a WSL distribution - where cmd.exe would run it in the Windows directory; a program of its own starts there (CLIS-1.2)', () => {
		const bin = path.join(temp.dir, 'muse-bin');
		fs.mkdirSync(bin, { recursive: true });
		const muse = path.join(bin, 'muse.cmd');
		fs.writeFileSync(muse, '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
		const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		for (const folder of ['\\\\wsl.localhost\\Ubuntu\\home\\ada\\app', '\\\\server\\share\\app', '//server/share/app']) {
			try {
				plan({ cli: 'muse', cwd: folder }, {}, windows);
				assert.fail(`planned in ${folder}`);
			} catch (err) {
				assert.ok(err instanceof CliPlanError, String(err));
				assert.deepStrictEqual([err.reason, err.message, err.said], ['unsupported',
					`${muse} runs through cmd.exe, which cannot run in the UNC folder ${folder}; set clis.muse.command to the CLI's own program or Node entry point`,
					{ kind: 'cmd_unc_folder', values: [muse, folder, 'clis.muse'] }]);
			}
		}
		fs.writeFileSync(path.join(bin, 'muse.exe'), '');
		assert.strictEqual(plan({ cli: 'muse', cwd: '\\\\server\\share\\app' }, {}, windows).executable, path.join(bin, 'muse.exe'));
	});

	test('a Node entry point a refusal advises - .path set to a package\'s cli.js - runs with the Node on the PATH, which Windows needs; with none there it is refused before anything starts (CLIS-1.2)', () => {
		const bin = path.join(temp.dir, 'node-bin');
		const script = path.join(temp.dir, 'pkg', 'cli.js');
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, '');
		const windows = (Path: string): DestinationEnvironment => ({ host: { Path, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir }, platform: 'win32' });
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, { claude: { command: script } }, windows(bin))),
			['not_found', `${script} is a Node script, and Node is not on the PATH to run it`]);
		fs.writeFileSync(path.join(bin, 'node.exe'), '');
		const planned = plan({ cli: 'claude' }, { claude: { command: script } }, windows(bin));
		assert.deepStrictEqual([planned.executable, planned.args[0], planned.args[1]], [path.join(bin, 'node.exe'), script, '--settings']);
	});
});
