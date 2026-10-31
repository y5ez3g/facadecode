/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GROUP_ORDER, invocation } from '../clis/adapter';
import { BUILT_IN_ADAPTERS, catalogOf } from '../clis/catalog';
import { claudeAdapter } from '../clis/claude';
import { codexAdapter, tomlString } from '../clis/codex';
import { readCliSettings } from '../clis/config';
import { executableAt, launchTarget, resolveExecutable, unsafeForCmd, which } from '../clis/executable';
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

suite('CLIs: the catalog and its settings (CLIS-1.1, 1.2)', () => {

	test('the built-ins in their order, with their API IDs, executables and setting segments', () => {
		assert.deepStrictEqual(BUILT_IN_ADAPTERS.map(adapter => [adapter.displayName, adapter.id, adapter.command, adapter.setting.replace(/^facade\./, '')]), [
			['Claude Code', 'claude', 'claude', 'claude'],
			['Codex', 'codex', 'codex', 'codex']
		]);
		assert.deepStrictEqual(catalogOf(settings()).entries.map(entry => entry.adapter.id), ['claude', 'codex']);
	});

	test('a built-in\'s path is read trimmed; none is its command on PATH', () => {
		assert.deepStrictEqual(readCliSettings('facade.claude', () => ' /opt/claude '), { path: '/opt/claude', problems: [] });
		assert.deepStrictEqual(readCliSettings('facade.claude', () => undefined), { path: '', problems: [] });
	});

	test('a path of the wrong kind, of whitespace alone or with a NUL in it is an error naming its setting, never PATH\'s command in its place', () => {
		assert.deepStrictEqual([7, '   ', 'a\0b'].map(value => readCliSettings('facade.claude', () => value)), [
			{ path: '', problems: ['facade.claude.path must be a string; received 7'], said: { kind: 'path_type', values: ['facade.claude', '7'] } },
			{ path: '', problems: ['facade.claude.path contains only whitespace. Set the program\'s path, or leave it empty to find the CLI on PATH'], said: { kind: 'path_blank', values: ['facade.claude'] } },
			{ path: 'a\0b', problems: ['facade.claude.path contains a NUL character, which no path can hold'], said: { kind: 'path_nul', values: ['facade.claude'] } }
		]);
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
			assert.deepStrictEqual(launch.trust, { kind: 'arguments' });
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

	test('the groups go in their order: the run\'s own settings, then the YOLO mapping', () => {
		assert.deepStrictEqual([...GROUP_ORDER], ['quiet', 'yoloOn', 'yoloOff', 'trust']);
		const groups = { quiet: ['q', '${value}'], yoloOn: ['on'] };
		assert.deepStrictEqual(invocation(groups, { yolo: false }, { value: 'v' }), ['q', 'v']);
		assert.deepStrictEqual(invocation(groups, { yolo: true }, { value: 'v' }), ['q', 'v', 'on']);
	});

	test('the environment: the host\'s, the folder\'s terminal settings, the default profile\'s, then the run\'s variables - null removing - with Claude Code\'s title switch removed (CLIS-1.2)', () => {
		const where: DestinationEnvironment = {
			...destination,
			host: { ...destination.host, SHELL_ONLY: 'kept', DROP_ME: 'x', HOST_VALUE: 'from host' },
			terminal: { TERMINAL: '${env:HOST_VALUE} via terminal', DROP_ME: null, LAYERED: 'terminal' },
			profile: { PROFILE: 'p', LAYERED: 'profile', MISSING: '${env:NOT_SET}' },
		};
		const env = plan({ cli: 'claude' }, {}, where).env;
		assert.deepStrictEqual({ ...env, PATH: undefined, HOME: undefined }, {
			PATH: undefined, HOME: undefined, SHELL_ONLY: 'kept', HOST_VALUE: 'from host', TERMINAL: 'from host via terminal', LAYERED: 'profile', PROFILE: 'p', MISSING: '',
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
		assert.deepStrictEqual(discover(catalogOf(settings()), empty, cwd).map(each => [each.available, each.notInstalled]), [[false, true], [false, true]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, {}, empty))[0], 'not_found');
	});

	test('Claude Code is always offered: a value left in facade.claude.enabled or facade.claude.launch, settings of later steps, changes nothing; one not installed, misconfigured or unknown fails with its actual reason (RULES-5.1)', () => {
		const left = { 'facade.claude.enabled': false, 'facade.claude.launch': { arguments: ['--verbose'], environment: { LEFT: '1' } } };
		const planned = plan({ cli: 'claude' }, left);
		assert.deepStrictEqual([discover(catalogOf(settings(left)), destination, cwd).map(each => each.available), planned.args, 'LEFT' in planned.env], [
			[true, true], ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""}}', '--dangerously-skip-permissions'], false
		]);
		const missing = { 'facade.claude.path': '/nowhere/claude' };
		assert.deepStrictEqual(discover(catalogOf(settings(missing)), destination, cwd).map(each => [each.available, each.notInstalled]), [[false, undefined], [true, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, missing))[0], 'not_found');
		const invalid = { 'facade.claude.path': 7 };
		assert.deepStrictEqual(discover(catalogOf(settings(invalid)), destination, cwd).map(each => [each.available, each.problem]), [[false, 'facade.claude.path must be a string; received 7'], [true, undefined]]);
		assert.deepStrictEqual(failure(() => plan({ cli: 'claude' }, invalid))[0], 'configuration_invalid');
		assert.deepStrictEqual(failure(() => plan({ cli: 'gemini' })), ['not_found', 'No CLI "gemini" is configured; the built-ins are claude and codex']);
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
});
