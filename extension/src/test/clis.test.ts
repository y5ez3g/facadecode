/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { GROUP_ORDER, invocation } from '../clis/adapter';
import { BUILT_IN_ADAPTERS, catalogOf } from '../clis/catalog';
import { claudeAdapter } from '../clis/claude';
import { codexAdapter, tomlString } from '../clis/codex';
import { readCliSettings } from '../clis/config';
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

/** Settings by their full names, as the editor would give them. */
function settings(values: { readonly [name: string]: unknown } = {}): (name: string) => unknown {
	return name => values[name];
}

/** The `pi.cmd` Pi's own Windows installer (pi.dev, for Pi 1.4.0) writes, with its choice of Node `setup`. */
function PI_CMD(setup: string): string {
	return `@ECHO off\r\nSETLOCAL\r\n${setup}\r\n"%node%" "%~dp0pi-launcher.js" %*\r\nSET "pi_exit_code=%ERRORLEVEL%"\r\nIF "%pi_exit_code%"=="9009" (\r\n  IF "%node%"=="node" (\r\n    "%SystemRoot%\\System32\\where.exe" /Q node\r\n    IF ERRORLEVEL 1 GOTO node_missing\r\n  ) ELSE IF NOT EXIST "%node%" GOTO node_missing\r\n)\r\nEXIT /B %pi_exit_code%\r\n:node_missing\r\nECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2\r\nEXIT /B %pi_exit_code%\r\n`;
}
/** The installer's choice of Node where it installed a Node of its own. */
const PI_OWN_NODE = 'SET "node=node"\r\nIF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"';

suite('CLIs: the catalog and its settings (CLIS-1.1, 1.2, 3.1)', () => {

	test('the built-ins in their order, with their API IDs, executables and setting segments', () => {
		assert.deepStrictEqual(BUILT_IN_ADAPTERS.map(adapter => [adapter.displayName, adapter.id, adapter.command, adapter.setting.replace(/^facade\./, '')]), [
			['Claude Code', 'claude', 'claude', 'claude'],
			['Codex', 'codex', 'codex', 'codex'],
			['Antigravity', 'agy', 'agy', 'antigravity'],
			['Muse Code', 'muse', 'muse', 'muse'],
			['OpenCode', 'opencode', 'opencode', 'opencode'],
			['Pi', 'pi', 'pi', 'pi']
		]);
		assert.deepStrictEqual(catalogOf(settings()).entries.map(entry => entry.adapter.id), ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']);
	});

	test('each built-in\'s path is read from its own setting, and a problem with one names that setting alone', () => {
		const entries = catalogOf(settings({ 'facade.antigravity.path': ' C:\\Tools\\agy.exe ', 'facade.muse.path': 7, 'facade.opencode.path': '', 'facade.pi.path': '~/bin/pi' })).entries;
		assert.deepStrictEqual(entries.map(entry => [entry.adapter.id, entry.path, entry.problems.map(problem => problem.text)]), [
			['claude', '', []],
			['codex', '', []],
			['agy', 'C:\\Tools\\agy.exe', []],
			['muse', '', ['facade.muse.path must be a string; received number']],
			['opencode', '', []],
			['pi', '~/bin/pi', []]
		]);
	});

	test('a built-in\'s path is read trimmed; none is its command on PATH; it is offered unless turned off, and its launch adds nothing unless set', () => {
		assert.deepStrictEqual(readCliSettings('facade.claude', key => key === 'path' ? ' /opt/claude ' : undefined), { enabled: true, path: '/opt/claude', arguments: [], environment: {}, problems: [] });
		assert.deepStrictEqual(readCliSettings('facade.claude', () => undefined), { enabled: true, path: '', arguments: [], environment: {}, problems: [] });
	});

	test('a path of the wrong kind, of whitespace alone or with a NUL in it is an error naming its setting, never PATH\'s command in its place', () => {
		assert.deepStrictEqual([7, '   ', 'a\0b'].map(value => readCliSettings('facade.claude', key => key === 'path' ? value : undefined).problems), [
			[{ text: 'facade.claude.path must be a string; received number', said: { kind: 'path_type', values: ['facade.claude', 'number'] } }],
			[{ text: 'facade.claude.path contains only whitespace. Set the program\'s path, or leave it empty to find the CLI on PATH', said: { kind: 'path_blank', values: ['facade.claude'] } }],
			[{ text: 'facade.claude.path contains a NUL character, which no path can hold', said: { kind: 'path_nul', values: ['facade.claude'] } }]
		]);
	});

	test('a launch accepts literal arguments and an environment map alone, in the order and shape given; .enabled turns a built-in off (CLIS-1.1, 3.1)', () => {
		const read = readCliSettings('facade.codex', key => ({ enabled: false, path: ' /opt/codex ', launch: { arguments: ['--search', '-c', 'a=b'], environment: { A: '1', B: null } } })[key]);
		assert.deepStrictEqual(read, { enabled: false, path: '/opt/codex', arguments: ['--search', '-c', 'a=b'], environment: { A: '1', B: null }, problems: [] });
		assert.deepStrictEqual(catalogOf(settings({ 'facade.pi.enabled': false, 'facade.pi.launch': { arguments: ['--x'], environment: { Y: '2' } } })).entries.filter(entry => entry.adapter.id === 'pi').map(entry => [entry.enabled, entry.extra, entry.environment]),
			[[false, ['--x'], { Y: '2' }]]);
	});

	test('an unknown field or a value of the wrong kind is an error naming its setting path, in the order read and by its kind for the person\'s language, never translated or used', () => {
		const read = readCliSettings('facade.claude', key => ({
			enabled: 'yes',
			path: '   ',
			launch: { arguments: { yoloOn: ['--x'] }, environment: { GOOD: 'x', BAD: 1, '': 'y', 'A=B': 'z' }, trust: null, quiet: [] }
		})[key]);
		assert.deepStrictEqual(read.problems.map(problem => [problem.text.split(' ')[0], problem.said.kind]), [
			['facade.claude.enabled', 'enabled_type'],
			['facade.claude.path', 'path_blank'],
			['facade.claude.launch.trust', 'launch_field'],
			['facade.claude.launch.quiet', 'launch_field'],
			['facade.claude.launch.arguments', 'arguments_type'],
			['facade.claude.launch.environment.BAD', 'environment_value'],
			['facade.claude.launch.environment', 'environment_name'],
			['facade.claude.launch.environment', 'environment_name']
		]);
		// Nothing of a wrong part is used, and nothing takes its place silently; a wrong .enabled leaves the default, said as wrong
		assert.deepStrictEqual([read.enabled, read.arguments, read.environment], [true, [], {}]);
		const items = readCliSettings('facade.muse', key => (key === 'launch' ? { arguments: ['ok', 2, 'nul\0'], environment: { NUL: 'a\0' } } : undefined));
		assert.deepStrictEqual(items.problems.map(problem => problem.said), [
			{ kind: 'argument_type', values: ['facade.muse.launch.arguments', '1', 'number'] },
			{ kind: 'argument_nul', values: ['facade.muse.launch.arguments', '2'] },
			{ kind: 'environment_nul', values: ['facade.muse.launch.environment', 'NUL'] }
		]);
		assert.deepStrictEqual(readCliSettings('facade.pi', key => (key === 'launch' ? [] : undefined)).problems.map(problem => problem.text),
			['facade.pi.launch must be an object with arguments and environment; received array']);
	});

	test('a problem names a received value by its type and a variable\'s name up to its =, never a value that may be a secret (CLIS-3.1, 4.1)', () => {
		const read = readCliSettings('facade.claude', key => ({
			enabled: 'sk-enabled',
			path: { token: 'sk-path' },
			launch: { arguments: 'sk-arguments', environment: { 'ANTHROPIC_API_KEY=sk-name': 'x', DB_PASSWORD: 12345678 } }
		})[key]);
		const said = JSON.stringify(read.problems);
		assert.ok(!/sk-|12345678/.test(said), said);
		assert.deepStrictEqual(read.problems.map(problem => problem.said.values.slice(1)), [['string'], ['object'], ['string'], ['"ANTHROPIC_API_KEY=…"'], ['DB_PASSWORD', 'number']]);
	});

	test('a launch argument that repeats an option the adapter sets itself - its run settings or its YOLO mapping, either way - is refused, naming its place; others are the person\'s (CLIS-3.1)', () => {
		const owned = (cli: string, args: readonly string[]) => catalogOf(settings({ [`facade.${cli}.launch`]: { arguments: args } })).entries.find(entry => entry.adapter.setting === `facade.${cli}`)!;
		const claude = owned('claude', ['--verbose', '--settings', '{}', '--dangerously-skip-permissions']);
		assert.deepStrictEqual([claude.extra, claude.problems.map(problem => problem.said)], [[], [
			{ kind: 'launch_owned', values: ['facade.claude.launch.arguments', '1', '--settings'] },
			{ kind: 'launch_owned', values: ['facade.claude.launch.arguments', '3', '--dangerously-skip-permissions'] }
		]]);
		assert.deepStrictEqual([
			owned('codex', ['--sandbox=read-only']).problems.map(problem => problem.said.values[2]),
			owned('antigravity', ['--mode', 'plan']).problems.map(problem => problem.said.values[2]),
			owned('muse', ['--disable-sandbox']).problems.map(problem => problem.said.values[2]),
			owned('opencode', ['--auto']).problems.map(problem => problem.said.values[2]),
			// Codex's generic -c, which its trust uses too, and Pi's flags are the person's
			owned('codex', ['-c', 'model_reasoning_effort=high']).extra,
			owned('pi', ['--approve', '--model', 'x']).extra
		], [['--sandbox'], ['--mode'], ['--disable-sandbox'], ['--auto'], ['-c', 'model_reasoning_effort=high'], ['--approve', '--model', 'x']]);
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
			const found = (configured: string) => resolveExecutable(configured, 'claude', 'facade.claude', env, cwd, platform);
			assert.deepStrictEqual([found(''), found('claude-beta'), found('~/tools/agent'), found('./scripts/agent'), found(onPath)].map(each => each.executable), [onPath, other, inHome, relative, onPath]);
			assert.match(found('missing-cli').problem!, /^facade\.claude\.path is "missing-cli", which was not found on the PATH/);
			assert.match(resolveExecutable('', 'claude', 'facade.claude', { PATH: path.join(temp.dir, 'none') }, cwd, platform).problem!, /^claude was not found on the PATH of a terminal in .*, and facade\.claude\.path does not name its location$/);
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
			assert.strictEqual(resolveExecutable('', 'claude', 'facade.claude', env, cwd, 'darwin').executable, local);
			assert.ok(path.isAbsolute(local));
			// Another launch folder has no such program, whatever this process's own folder holds
			assert.match(resolveExecutable('', 'claude', 'facade.claude', env, temp.dir, 'darwin').problem!, /^claude was not found on the PATH/);
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

	const plan = (input: Partial<PlanInput> & { readonly cli: string }, values: { readonly [name: string]: unknown } = {}, where = destination) =>
		planLaunch(catalogOf(settings(values)), { alias: '#a7', cwd, yolo: true, ...input }, where);
	const failure = (run: () => unknown) => {
		try {
			run();
		} catch (err) {
			return err instanceof CliPlanError ? [err.reason, err.message] : ['thrown', String(err)];
		}
		return 'planned';
	};

	test('Codex uses its native YOLO mapping and trusts this folder by an argument alone, with no later-step integrations', () => {
		for (const yolo of [true, false]) {
			const launch = plan({ cli: 'codex', yolo });
			assert.deepStrictEqual(launch.args, [
				...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
				'-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`
			]);
			assert.deepStrictEqual(launch.trust, { kind: 'arguments', args: ['-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`] });
			assert.strictEqual(launch.env.FACADE_AGENT, '#a7');
		}
		assert.strictEqual(codexAdapter.values({ cwd, platform: 'win32', yolo: false }).folderToml,
			tomlString(fs.realpathSync(cwd).replace(/[A-Z]/g, letter => letter.toLowerCase())));
	});

	test('Codex TOML quotes paths containing quotes, backslashes, controls and Unicode without treating them as configuration syntax', () => {
		assert.strictEqual(tomlString('a"b\\c\t\n\u0000\u007F🌍'), '"a\\"b\\\\c\\t\\n\\u0000\\u007F🌍"');
		assert.throws(() => tomlString('\uD800'), /unpaired/);
		assert.throws(() => tomlString('\uDC00'), /unpaired/);
	});

	test('Claude Code maps YOLO to its native bypass, and with YOLO off turns its sandbox on where it has one, approvals left as they are; its folder is trusted in its own file, YOLO on or off (CLIS-1.3, 3.3)', () => {
		const args = (yolo: boolean) => plan({ cli: 'claude', yolo }).args;
		assert.deepStrictEqual(args(true), ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""}}', '--dangerously-skip-permissions']);
		assert.deepStrictEqual(args(false), ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""},"sandbox":{"enabled":true}}']);
		// Every launch trusts its folder in Claude Code's own file, never by an argument (CLIS-3.3, D62)
		for (const yolo of [true, false]) {
			assert.strictEqual(plan({ cli: 'claude', yolo }).trust.kind, 'file', `${yolo}`);
			assert.ok(!args(yolo).some(arg => /trust/i.test(arg)), `${yolo}`);
		}
		// Windows has no Claude Code sandbox
		assert.deepStrictEqual(JSON.parse(claudeAdapter.values({ yolo: false, cwd, platform: 'win32' }).runSettings), { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' } });
	});

	test('Claude Code\'s run settings hold no more than a run needs: no sandbox setting with YOLO on, no prompt of its own switched off; its title switch is cleared wherever the environment sets it (CLIS-1.3, 2.3)', () => {
		const settingsOf = (planned: { readonly args: readonly string[] }) => JSON.parse(planned.args[planned.args.indexOf('--settings') + 1]);
		const on = settingsOf(plan({ cli: 'claude', yolo: true }));
		assert.deepStrictEqual([on.sandbox, on.skipDangerousModePermissionPrompt], [undefined, undefined]);
		// The host's copy, and one the folder's terminal settings give, are cleared alike: the switch would turn off its status reports
		const where: DestinationEnvironment = { ...destination, terminal: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' } };
		const cleared = [plan({ cli: 'claude' }).env, plan({ cli: 'claude', yolo: false }, {}, where).env].map(env => 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE' in env);
		assert.deepStrictEqual([cleared, settingsOf(plan({ cli: 'claude', yolo: false }, {}, where))], [[false, false], { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, sandbox: { enabled: true } }]);
	});

	test('the groups go in their order: the run\'s own settings, the YOLO mapping, the folder\'s trust, then the configured arguments as they are (CLIS-3.1, 3.2)', () => {
		assert.deepStrictEqual([...GROUP_ORDER], ['quiet', 'yoloOn', 'yoloOff', 'trust', 'extra']);
		const groups = { quiet: ['q', '${value}'], yoloOn: ['on'], trust: ['t'] };
		assert.deepStrictEqual(invocation(groups, [], { yolo: false }, { value: 'v' }), ['q', 'v', 't']);
		// A person's literal option is never expanded: `${value}` stays as written
		assert.deepStrictEqual(invocation(groups, ['--extra', '${value}'], { yolo: true }, { value: 'v' }), ['q', 'v', 'on', 't', '--extra', '${value}']);
	});

	test('the environment: the host\'s, the folder\'s terminal settings, the default profile\'s, the CLI\'s launch environment, then the run\'s variables - null removing - with Claude Code\'s title switch removed (CLIS-1.2, 3.1)', () => {
		const where: DestinationEnvironment = {
			...destination,
			host: { ...destination.host, SHELL_ONLY: 'kept', DROP_ME: 'x', HOST_VALUE: 'from host' },
			terminal: { TERMINAL: '${env:HOST_VALUE} via terminal', DROP_ME: null, LAYERED: 'terminal' },
			profile: { PROFILE: 'p', LAYERED: 'profile', MISSING: '${env:NOT_SET}' },
		};
		const env = plan({ cli: 'claude' }, { 'facade.claude.launch': { environment: { LAUNCHED: '${env:HOST_VALUE} via launch', LAYERED: 'launch', PROFILE: null } } }, where).env;
		assert.deepStrictEqual({ ...env, PATH: undefined, HOME: undefined }, {
			PATH: undefined, HOME: undefined, SHELL_ONLY: 'kept', HOST_VALUE: 'from host', TERMINAL: 'from host via terminal', LAYERED: 'launch', MISSING: '', LAUNCHED: 'from host via launch',
			TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor', FACADE_AGENT: '#a7'
		});
		assert.ok(!('CLAUDE_CODE_DISABLE_TERMINAL_TITLE' in env) && !('ELECTRON_RUN_AS_NODE' in env));
	});

	test('the program is found with the launch\'s own environment: a PATH the folder\'s terminal settings set finds it, and discovery agrees with the plan', () => {
		const other = path.join(temp.dir, 'other');
		const agent = program(other, 'claude');
		const where: DestinationEnvironment = { ...destination, terminal: { PATH: other } };
		assert.strictEqual(plan({ cli: 'claude' }, {}, where).executable, agent);
		assert.strictEqual(discover(catalogOf(settings()), where, cwd).find(each => each.entry.adapter.id === 'claude')?.available, true);
		// A terminal PATH without the program: neither finds it, whatever the host's PATH has
		const empty: DestinationEnvironment = { ...destination, terminal: { PATH: path.join(temp.dir, 'empty') } };
		assert.deepStrictEqual(discover(catalogOf(settings()), empty, cwd).map(each => [each.available, each.notInstalled]), Array(BUILT_IN_ADAPTERS.length).fill([false, true]));
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, {}, empty))[0], 'not_found');
	});

	test('a built-in turned off is not offered and not started, said why (RULES-4.4); its launch arguments follow its own, and its launch environment is its runs\'; one not installed, misconfigured or unknown fails with its actual reason (RULES-5.1)', () => {
		const off = { 'facade.claude.enabled': false };
		let said: unknown;
		try {
			plan({ cli: 'claude' }, off);
		} catch (err) {
			said = err instanceof CliPlanError ? [err.reason, err.message, err.said] : err;
		}
		assert.deepStrictEqual([discover(catalogOf(settings(off)), destination, cwd).map(each => each.entry.adapter.id), said], [
			['codex', 'agy', 'muse', 'opencode', 'pi'],
			['unavailable', 'Claude Code is turned off by facade.claude.enabled', { kind: 'cli_disabled', values: ['Claude Code', 'facade.claude'] }]
		]);
		// A value of .enabled that is no boolean leaves the CLI offered, unavailable with its problem: never hidden in silence
		assert.deepStrictEqual(discover(catalogOf(settings({ 'facade.claude.enabled': 'no' })), destination, cwd).map(each => [each.entry.adapter.id, each.available, each.said?.kind]).slice(0, 2),
			[['claude', false, 'enabled_type'], ['codex', true, undefined]]);
		const launch = { 'facade.claude.launch': { arguments: ['--verbose', '--model', 'opus'], environment: { LAUNCHED: '1' } } };
		const planned = plan({ cli: 'claude' }, launch);
		// Only Claude Code and Codex are installed here
		assert.deepStrictEqual([discover(catalogOf(settings(launch)), destination, cwd).map(each => each.available), planned.args, planned.env.LAUNCHED], [
			[true, true, false, false, false, false], ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""}}', '--dangerously-skip-permissions', '--verbose', '--model', 'opus'], '1'
		]);
		const missing = { 'facade.claude.path': '/nowhere/claude' };
		assert.deepStrictEqual(discover(catalogOf(settings(missing)), destination, cwd).map(each => [each.available, each.notInstalled]).slice(0, 2), [[false, undefined], [true, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, missing))[0], 'not_found');
		const invalid = { 'facade.claude.path': 7 };
		assert.deepStrictEqual(discover(catalogOf(settings(invalid)), destination, cwd).map(each => [each.available, each.problem, each.said?.kind]).slice(0, 2), [[false, 'facade.claude.path must be a string; received number', 'path_type'], [true, undefined, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, invalid))[0], 'configuration_invalid');
		assert.deepStrictEqual(failure(() => plan({ cli: 'gemini' })), ['not_found', 'No CLI "gemini" is configured; the built-ins are claude, codex, agy, muse, opencode and pi']);
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
		assert.deepStrictEqual([true, false].map(yolo => added.map(cli => plan({ cli, yolo }).args)), [
			[['--mode', 'accept-edits', '--dangerously-skip-permissions'], ['--disable-approval', '--disable-sandbox', '--trust-workspace'], ['--auto'], ['--approve']],
			[[], ['--trust-workspace'], [], ['--approve']]
		]);
		// Antigravity keeps its trust in its settings, in the launch's home; the others take it for the launch, or ask none
		assert.deepStrictEqual(added.map(cli => plan({ cli }).trust.kind), ['file', 'arguments', 'arguments', 'arguments']);
		const folder = canonicalFolder(cwd);
		assert.deepStrictEqual(plan({ cli: 'agy', yolo: false }).trust, { kind: 'file', target: { file: path.join(temp.dir, '.gemini', 'antigravity-cli', 'settings.json'), keys: ['trustedWorkspaces'], entry: { item: folder }, folder } });
		for (const cli of added) {
			const launch = plan({ cli });
			assert.deepStrictEqual([launch.cli, launch.command, launch.executable, launch.env.FACADE_AGENT, 'ELECTRON_RUN_AS_NODE' in launch.env], [cli, cli, path.join(bin, cli), '#a7', false]);
		}
		// Muse Code alone is read from its screen where it sends no reports - on Windows (CLIS-2.3, D80); the others report themselves
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
		// Claude Code's run settings are JSON, which cmd.exe cannot be given safely
		const result = failure(() => plan({ cli: 'claude', yolo: false }, {}, windows));
		assert.deepStrictEqual(result[0], 'unsupported');
		assert.match(String(result[1]), /runs through cmd\.exe, which cannot be given the argument .* safely; set facade\.claude\.path to the CLI's own program or Node entry point$/);
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
			plan({ cli: 'pi' }, { 'facade.pi.launch': { arguments: ['--password', 'Hunter2!'] } }, windows);
		} catch (err) {
			said = err instanceof CliPlanError ? [err.reason, err.message.includes('Hunter2'), err.said] : err;
		}
		assert.deepStrictEqual(said, ['unsupported', false, { kind: 'cmd_unsafe_setting', values: [path.join(bin, 'pi.cmd'), 'facade.pi.launch.arguments', '1', '"!"', 'facade.pi'] }]);
	});

	test('a launcher that goes through cmd.exe from a folder whose path cmd.exe reads as its own - a profile named R&D - is refused before anything starts, with the setting that fixes it', () => {
		for (const folder of ['R&D', '100%', 'a^b']) {
			const bin = path.join(temp.dir, folder, 'muse');
			fs.mkdirSync(bin, { recursive: true });
			const muse = path.join(bin, 'muse.cmd');
			fs.writeFileSync(muse, '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
			const windows: DestinationEnvironment = { host: { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
			const result = failure(() => plan({ cli: 'muse' }, {}, windows));
			assert.deepStrictEqual(result, ['unsupported', `${muse} runs through cmd.exe, which cannot be given its path safely; set facade.muse.path to the CLI's own program or Node entry point`], folder);
			try {
				plan({ cli: 'muse' }, {}, windows);
			} catch (err) {
				assert.deepStrictEqual((err as CliPlanError).said, { kind: 'cmd_unsafe_path', values: [muse, 'facade.muse'] });
			}
		}
		// A path with spaces alone is quoted whole, and goes through
		const spaced = path.join(temp.dir, 'Program Files', 'muse');
		fs.mkdirSync(spaced, { recursive: true });
		fs.writeFileSync(path.join(spaced, 'muse.cmd'), '@echo off\r\nexit /b 0\r\n');
		assert.strictEqual(plan({ cli: 'muse' }, {}, { host: { Path: spaced, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' }).executable, path.join(spaced, 'muse.cmd'));
	});
});
