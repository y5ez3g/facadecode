/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { claudeAdapter } from '../clis/claude';
import { describeLaunches } from '../clis/describe';
import { setVariable } from '../clis/environment';
import { CliPlanError, DestinationEnvironment, discover, planLaunch, PlanInput, PlannedLaunch } from '../clis/plan';
import type { McpServer } from '../clis/tools';
import { FACADE_SKILL } from '../schema/skill';
import { catalogFrom, TEST_SETTINGS_FILE } from './settingsFixtures';
import { tempDir } from './util';

const SERVER: McpServer = { command: '/runtime', args: ['/ext/dist/shim.js'], env: { FACADE_RUN: 'run-1' } };

/** What a plan that throws says: its reason and kind, else its English. */
function failure(run: () => unknown): unknown {
	try {
		run();
	} catch (err) {
		return err instanceof CliPlanError ? [err.reason, err.said?.kind ?? err.message, ...err.said?.values ?? []] : ['thrown', String(err)];
	}
	return 'planned';
}

/** The JSON of the run settings file `plan` writes, by its name in the run's folder. */
function runSettingsOf(plan: PlannedLaunch, name: string): { [key: string]: unknown } {
	const file = plan.files?.find(each => path.basename(each.file) === name);
	return file ? JSON.parse(file.content) as { [key: string]: unknown } : assert.fail(`no ${name}`);
}

suite('CLIs: added CLIs and programs, their discovery and their launch (CONFIGURATION-2.1, 2.3, 3.2, 3.3, 5.1)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;
	let bin: string;
	const runDir = '/home/ada/.facade/extension/runs/run-1';

	setup(() => {
		temp = tempDir('fd-custom-');
		bin = path.join(temp.dir, 'bin');
		fs.mkdirSync(bin);
		for (const name of ['my-cli', 'codex', 'claude']) {
			fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
			fs.chmodSync(path.join(bin, name), 0o755);
		}
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir, WORK_TOKEN: 'from-host' }, terminal: { FROM_TERMINAL: 't' }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	const start = (more: Partial<PlanInput> & { readonly cli: string }): PlanInput => ({ alias: '#a1', cwd, yolo: true, runDir, ...more });

	test('the added CLIs follow the built-ins in the file\'s order; a wrong one is offered unavailable with why, never hidden, and one turned off is not offered unless it has an error to say', () => {
		const catalog = catalogFrom({ clis: {
			'Codex · work': { type: 'codex' }, tool: { type: 'custom', command: 'my-cli' }, broken: { type: 'custom' }, missing: { type: 'custom', command: 'not-there' },
			off: { type: 'custom', command: 'my-cli', enabled: false }, 'off and wrong': { type: 'custom', enabled: false }
		} });
		const found = discover(catalog, destination, cwd).slice(6).map(each => [each.entry.adapter.id, each.available, each.said?.kind, each.notInstalled]);
		assert.deepStrictEqual(found, [
			['Codex · work', true, undefined, undefined],
			['tool', true, undefined, undefined],
			['broken', false, 'entry_command_missing', undefined],
			['missing', false, 'path_not_on_path', undefined],
			['off and wrong', false, 'entry_command_missing', undefined]
		]);
	});

	test('a program starts as configured: its command with its args, literally - no YOLO mapping either way, no model or effort, no trust Facade knows of - its env over the terminal\'s, and the run\'s alias', () => {
		const catalog = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', args: ['run', '--yolo', '--', 'x'], env: { MY_MODE: 'quick', FROM_TERMINAL: 'mine', GONE: null } } } });
		const layered: DestinationEnvironment = { ...destination, terminal: { FROM_TERMINAL: 't', GONE: 'from-terminal' } };
		const on = planLaunch(catalog, start({ cli: 'tool', yolo: true }), layered);
		const off = planLaunch(catalog, start({ cli: 'tool', yolo: false }), layered);
		assert.deepStrictEqual([on.executable, on.args, off.args, on.cwd, on.trust, on.displayName, on.command, on.builtIn, on.files], [
			path.join(bin, 'my-cli'), ['run', '--yolo', '--', 'x'], ['run', '--yolo', '--', 'x'], cwd, { kind: 'unknown' }, 'tool', 'my-cli', undefined, undefined
		]);
		assert.deepStrictEqual([on.env.MY_MODE, on.env.FROM_TERMINAL, 'GONE' in on.env, on.env.FACADE_AGENT], ['quick', 'mine', false, '#a1']);
		assert.deepStrictEqual(failure(() => planLaunch(catalog, start({ cli: 'tool', model: 'x' }), destination)), ['unsupported', 'tool has no supported way to set a model; omit model to use its own default']);
	});

	test('an added CLI of a built-in\'s type starts as that built-in does under its own name, with its own entry alone: the built-in\'s own entry gives it nothing', () => {
		const catalog = catalogFrom({ clis: {
			codex: { args: ['--search'], model: 'gpt-5', env: { CODEX_HOME: '/default' } },
			'qwen codex': { type: 'codex', args: ['--profile', 'qwen'], model: 'qwen3-coder', env: { CODEX_HOME: '/qwen' } }
		} });
		const plan = planLaunch(catalog, start({ cli: 'qwen codex' }), destination);
		assert.deepStrictEqual([plan.cli, plan.builtIn, plan.displayName, plan.executable, plan.env.CODEX_HOME, plan.args.includes('--search'), plan.args.includes('--dangerously-bypass-approvals-and-sandbox')], [
			'qwen codex', 'codex', 'qwen codex', path.join(bin, 'codex'), '/qwen', false, true
		]);
		const at = plan.args.indexOf('--model');
		assert.deepStrictEqual([plan.args.slice(at, at + 2), plan.args.slice(plan.args.indexOf('--profile'), plan.args.indexOf('--profile') + 2)], [['--model', 'qwen3-coder'], ['--profile', 'qwen']]);
	});

	test('model and effort: this start\'s choice wins over the entry\'s, each on its own; neither adds no option, and the plan keeps only what the start asked', () => {
		const catalog = catalogFrom({ clis: { claude: { model: 'opus', effort: 'high' }, 'plain claude': { type: 'claude' } } });
		const option = (plan: PlannedLaunch, name: string) => plan.args.includes(name) ? plan.args[plan.args.indexOf(name) + 1] : undefined;
		const entry = planLaunch(catalog, start({ cli: 'claude' }), destination);
		const chosen = planLaunch(catalog, start({ cli: 'claude', effort: 'low' }), destination);
		const plain = planLaunch(catalog, start({ cli: 'plain claude' }), destination);
		assert.deepStrictEqual([
			[option(entry, '--model'), option(entry, '--effort'), entry.model, entry.effort],
			[option(chosen, '--model'), option(chosen, '--effort'), chosen.model, chosen.effort],
			[plain.args.includes('--model'), plain.args.includes('--effort')]
		], [['opus', 'high', undefined, undefined], ['opus', 'low', undefined, 'low'], [false, false]]);
	});

	test('${env:NAME} in env reads the host\'s environment once, never another value of env; a variable the host has not makes the entry unavailable, said by its place; on Windows two names differing in case are one', () => {
		const catalog = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', env: { TOKEN: 'Bearer ${env:WORK_TOKEN}', WORK_TOKEN: 'mine', NESTED: '${env:LITERAL}', EMPTY: '${env:}' } } } });
		const planned = planLaunch(catalog, start({ cli: 'tool' }), { ...destination, host: { ...destination.host, LITERAL: '${env:WORK_TOKEN}' } });
		assert.deepStrictEqual([planned.env.TOKEN, planned.env.WORK_TOKEN, planned.env.NESTED, planned.env.EMPTY], ['Bearer from-host', 'mine', '${env:WORK_TOKEN}', '${env:}']);
		// A variable the host has, empty, reads as empty: only one it has not is an error
		const empty = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', env: { TOKEN: '${env:BLANK}' } } } });
		assert.strictEqual(planLaunch(empty, start({ cli: 'tool' }), { ...destination, host: { ...destination.host, BLANK: '' } }).env.TOKEN, '');
		const missing = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', env: { TOKEN: '${env:NOT_SET}' } } } });
		assert.deepStrictEqual([
			failure(() => planLaunch(missing, start({ cli: 'tool' }), destination)),
			discover(missing, destination, cwd).find(each => each.entry.adapter.id === 'tool')!.said
		], [
			['configuration_invalid', 'env_reference_missing', 'clis.tool.env.TOKEN', 'NOT_SET'],
			{ kind: 'env_reference_missing', values: ['clis.tool.env.TOKEN', 'NOT_SET'] }
		]);
		const twice = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', env: { Path: 'a', PATH: 'b' } } } });
		assert.deepStrictEqual(discover(twice, { ...destination, platform: 'win32' }, cwd).find(each => each.entry.adapter.id === 'tool')!.said,
			{ kind: 'env_case_duplicate', values: ['clis.tool.env', 'Path', 'PATH'] });
	});

	test('an entry turned off that has an error of its own - one the destination finds too - is listed and described with it, and a start says the error before that it is off; the editor\'s terminal layers read a missing variable as empty, as its terminal does (CONFIGURATION-2.2, 3.2, 4.1, CLIS-1.2)', () => {
		const catalog = catalogFrom({ clis: { codex: { enabled: false, env: { KEY: '${env:NO_SUCH}' } }, pi: { enabled: false } } });
		const listed = discover(catalog, destination, cwd);
		const missing = { kind: 'env_reference_missing', values: ['clis.codex.env.KEY', 'NO_SUCH'] };
		assert.deepStrictEqual([
			listed.find(each => each.entry.adapter.id === 'codex')?.said, listed.some(each => each.entry.adapter.id === 'pi'),
			failure(() => planLaunch(catalog, start({ cli: 'codex' }), destination)),
			describeLaunches(catalog, destination, cwd, true).find(each => each.cli === 'codex')?.problems.map(each => each.said)
		], [missing, false, ['configuration_invalid', 'env_reference_missing', 'clis.codex.env.KEY', 'NO_SUCH'], [missing]]);
		// `"PYTHONPATH": "${env:PYTHONPATH}:/work/src"` where the editor has no PYTHONPATH: its terminal reads `:/work/src`, and so does a start
		const terminal = { ...destination, terminal: { PYTHONPATH: '${env:PYTHONPATH}:/work/src' }, profile: { ACCOUNT: '${env:NO_SUCH}' } };
		const tool = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli' } } });
		const planned = planLaunch(tool, start({ cli: 'tool' }), terminal);
		assert.deepStrictEqual([planned.env.PYTHONPATH, planned.env.ACCOUNT, discover(tool, terminal, cwd).find(each => each.entry.adapter.id === 'tool')?.available], [':/work/src', '', true]);
	});

	test('Claude Code\'s run settings are a file of the run, passed by path and never inline: the entry\'s env in its env, a removed key variable written empty, the person\'s --settings merged in', () => {
		const catalog = catalogFrom({ clis: { claude: {
			env: { ANTHROPIC_BASE_URL: 'https://example.com/anthropic', ANTHROPIC_AUTH_TOKEN: '${env:WORK_TOKEN}', ANTHROPIC_API_KEY: null },
			args: ['--verbose', '--settings', '{"env":{"MINE":"1"},"includeCoAuthoredBy":false}']
		} } });
		const plan = planLaunch(catalog, start({ cli: 'claude' }), destination);
		const settings = runSettingsOf(plan, 'claude-settings.json');
		const file = path.join(runDir, 'claude-settings.json');
		assert.deepStrictEqual([settings.env, settings.includeCoAuthoredBy, settings.disabledMcpjsonServers], [
			{ MINE: '1', ANTHROPIC_BASE_URL: 'https://example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'from-host', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }, false, ['facade']
		]);
		assert.deepStrictEqual([plan.args.filter(arg => arg === '--settings').length, plan.args[plan.args.indexOf('--settings') + 1], plan.args.includes('--verbose')], [1, file, true]);
		assert.ok(!plan.args.some(arg => arg.includes('from-host') || arg.includes('MINE')), 'no value inline, where a process list shows it');
		assert.deepStrictEqual([plan.env.ANTHROPIC_AUTH_TOKEN, 'ANTHROPIC_API_KEY' in plan.env], ['from-host', false]);
	});

	test('Claude Code\'s --settings may name a file, from the folder the run starts in; one that cannot be read, or text that is no JSON object, refuses the start by its place, never quoting it', () => {
		fs.writeFileSync(path.join(cwd, 'mine.json'), '{ "env": { "FROM_FILE": "1" } }');
		const withSettings = (value: string) => catalogFrom({ clis: { claude: { args: ['--settings', value] } } });
		// A file that holds no JSON is said without what it holds, which a parser's reason would quote
		fs.writeFileSync(path.join(cwd, 'broken.json'), 'SENTINEL_PRIVATE_123');
		let english = '';
		try { planLaunch(withSettings('broken.json'), start({ cli: 'claude' }), destination); } catch (err) { english = (err as Error).message; }
		assert.ok(english.includes('broken.json') && !english.includes('SENTINEL'), english);
		assert.deepStrictEqual((runSettingsOf(planLaunch(withSettings('mine.json'), start({ cli: 'claude' }), destination), 'claude-settings.json').env as { [name: string]: string }).FROM_FILE, '1');
		assert.deepStrictEqual([
			failure(() => planLaunch(withSettings('gone.json'), start({ cli: 'claude' }), destination)),
			failure(() => planLaunch(withSettings('{"sk-secret": '), start({ cli: 'claude' }), destination)),
			failure(() => planLaunch(catalogFrom({ clis: { claude: { args: ['--settings'] } } }), start({ cli: 'claude' }), destination))
		], [
			['configuration_invalid', 'run_settings_file', 'clis.claude.args[0]', '--settings', '"gone.json"'],
			['configuration_invalid', 'run_settings_text', 'clis.claude.args[0]', '--settings'],
			['configuration_invalid', 'run_settings_missing', 'clis.claude.args[0]', '--settings']
		]);
	});

	test('a variable an entry removes that Claude Code\'s own settings would set again refuses the start, naming where; its two key variables are written empty instead', () => {
		fs.mkdirSync(path.join(cwd, '.claude'));
		fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{ "env": { "HTTPS_PROXY": "http://proxy", "ANTHROPIC_API_KEY": "sk-project" } }');
		const removing = (name: string) => catalogFrom({ clis: { claude: { env: { [name]: null } } } });
		assert.deepStrictEqual([
			failure(() => planLaunch(removing('HTTPS_PROXY'), start({ cli: 'claude' }), destination)),
			(runSettingsOf(planLaunch(removing('ANTHROPIC_API_KEY'), start({ cli: 'claude' }), destination), 'claude-settings.json').env as { [name: string]: string }).ANTHROPIC_API_KEY
		], [
			['configuration_invalid', 'claude_env_readded', 'clis.claude.env.HTTPS_PROXY', 'HTTPS_PROXY', path.join(cwd, '.claude', 'settings.local.json')],
			''
		]);
		const theirs = catalogFrom({ clis: { claude: { env: { NO_PROXY: null }, args: ['--settings', '{"env":{"NO_PROXY":"x"}}'] } } });
		assert.deepStrictEqual(failure(() => planLaunch(theirs, start({ cli: 'claude' }), destination)), ['configuration_invalid', 'claude_env_readded', 'clis.claude.env.NO_PROXY', 'NO_PROXY', 'clis.claude.args[0]']);
	});

	test('CONFIGURATION-3.2: what Facade gives a run last - its alias and session file, every agent terminal\'s variables - holds in Claude Code\'s run settings too, whatever the entry\'s env or the person\'s --settings name, so that its session hook reports for the run', () => {
		const sessionFile = path.join(runDir, 'session.json');
		const catalog = catalogFrom({ clis: { claude: {
			env: { FACADE_AGENT: '#a999', FACADE_CODE_SESSION_FILE: '/wrong/session', ELECTRON_RUN_AS_NODE: '1', TERM_PROGRAM: 'other', MINE: 'kept' },
			args: ['--settings', '{"env":{"FACADE_AGENT":"#a998","FACADE_CODE_SESSION_FILE":"/theirs/session","COLORTERM":"256","ELECTRON_RUN_AS_NODE":"1","THEIRS":"kept"}}']
		} } });
		const plan = planLaunch(catalog, start({ cli: 'claude', alias: '#a123', sessionFile, sessionHook: 'node hook.cjs claude' }), destination);
		const settings = runSettingsOf(plan, 'claude-settings.json');
		// Claude Code sets its settings' env over the environment it starts with, and its session hook runs with what results
		const effective: { [name: string]: unknown } = { ...plan.env, ...settings.env as { [name: string]: string } };
		const names = ['FACADE_AGENT', 'FACADE_CODE_SESSION_FILE', 'TERM_PROGRAM', 'COLORTERM', 'ELECTRON_RUN_AS_NODE', 'MINE', 'THEIRS'];
		assert.deepStrictEqual([names.map(name => plan.env[name]), names.map(name => effective[name])], [
			['#a123', sessionFile, 'vscode', 'truecolor', undefined, 'kept', undefined],
			['#a123', sessionFile, 'vscode', 'truecolor', undefined, 'kept', 'kept']
		]);
		assert.deepStrictEqual([Object.hasOwn(settings.env as object, 'ELECTRON_RUN_AS_NODE'), (settings.hooks as { [event: string]: unknown[] }).SessionStart.length], [false, 1],
			'a variable the run removes is left out of its settings, never written empty');
	});

	test('on Windows, which reads a variable\'s name in any case, Claude Code\'s run settings name each variable once: a removed key variable is written empty by its own spelling whatever spelling sets it again, another removed one is refused in any spelling, and what Facade gives the run last replaces every spelling', () => {
		const build = (removed: readonly string[], theirs: { readonly [name: string]: string }) => claudeAdapter.runSettings!.build({
			yolo: true, cwd, platform: 'win32', env: { USERPROFILE: temp.dir }, entryEnv: { set: {}, removed }, setting: 'clis.claude'
		}, [{ place: 'clis.claude.args[1]', settings: { env: theirs } }]);
		const envOf = (built: ReturnType<typeof build>) => 'settings' in built ? built.settings.env : built.said;
		assert.deepStrictEqual([
			envOf(build(['anthropic_api_key'], { ANTHROPIC_API_KEY: 'sk-theirs' })),
			envOf(build(['Anthropic_Auth_Token'], { anthropic_auth_token: 'theirs' })),
			envOf(build(['https_proxy'], { HTTPS_PROXY: 'http://proxy' }))
		], [
			{ ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' },
			{ ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' },
			{ kind: 'claude_env_readded', values: ['clis.claude.env.https_proxy', 'https_proxy', 'clis.claude.args[1]'] }
		]);
		// Within one source the last spelling is the one Claude Code sets last; a later source, and Facade's own, go over every spelling
		const sources = (theirs: { readonly [name: string]: string }[], removed: readonly string[], set: { readonly [name: string]: string } = {}, platform: NodeJS.Platform = 'win32') =>
			envOf(claudeAdapter.runSettings!.build({ yolo: true, cwd, platform, env: { USERPROFILE: temp.dir, HOME: temp.dir }, entryEnv: { set, removed }, setting: 'clis.claude' },
				theirs.map((env, at) => ({ place: `clis.claude.args[${at * 2 + 1}]`, settings: { env } }))));
		const title = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' };
		assert.deepStrictEqual([
			sources([{ ANTHROPIC_API_KEY: 'UPPER', anthropic_api_key: 'LOWER' }], ['ANTHROPIC_API_KEY']),
			sources([{ ANTHROPIC_API_KEY: 'UPPER', anthropic_api_key: 'LOWER' }], [], { ANTHROPIC_API_KEY: 'ENTRY' }),
			sources([{ anthropic_api_key: 'LOWER', ANTHROPIC_API_KEY: 'UPPER' }], []),
			sources([{ MODE: 'first' }, { mode: 'second' }], []),
			sources([{ MODE: 'first' }, { mode: 'second' }], [], {}, 'darwin')
		], [
			{ ANTHROPIC_API_KEY: '', ...title },
			{ ANTHROPIC_API_KEY: 'ENTRY', ...title },
			{ ANTHROPIC_API_KEY: 'UPPER', ...title },
			{ mode: 'second', ...title },
			{ MODE: 'first', mode: 'second', ...title }
		]);
		const finished = claudeAdapter.runSettings!.finish!({ env: { facade_agent: '#a999', Term_Program: 'other', electron_run_as_node: '1', MINE: 'kept' } },
			{ last: [{ name: 'FACADE_AGENT', value: '#a123' }, { name: 'TERM_PROGRAM', value: 'vscode' }, { name: 'ELECTRON_RUN_AS_NODE', value: undefined }, { name: 'COLORTERM', value: 'truecolor' }], tools: false, env: {}, platform: 'win32' });
		assert.deepStrictEqual(finished, { env: { MINE: 'kept', FACADE_AGENT: '#a123', TERM_PROGRAM: 'vscode' } });
	});

	test('on Windows the run\'s own variables hold under one name, whatever spelling a layer gave them: in the run, and in Claude Code\'s run settings, where its session hook reads them (CONFIGURATION-3.2, CLIS-1.2)', () => {
		const windowsBin = path.join(temp.dir, 'windows');
		fs.mkdirSync(windowsBin);
		fs.writeFileSync(path.join(windowsBin, 'claude.exe'), '');
		const windows: DestinationEnvironment = {
			host: { Path: windowsBin, PATHEXT: '.EXE;.CMD', USERPROFILE: temp.dir, Facade_Agent: '#a998' }, terminal: { facade_agent: '#a997' }, profile: { Term_Program: 'other' }, platform: 'win32'
		};
		const sessionFile = 'C:/correct/session.json';
		const plan = planLaunch(catalogFrom({ clis: { claude: { env: { facade_code_session_file: 'C:/wrong/session' } } } }),
			start({ cli: 'claude', alias: '#a123', sessionFile, sessionHook: 'node hook.cjs claude' }), windows);
		const settings = runSettingsOf(plan, 'claude-settings.json').env as { [name: string]: string };
		const namesOf = (env: { readonly [name: string]: unknown }, name: string) => Object.keys(env).filter(key => key.toLowerCase() === name.toLowerCase());
		// As Windows reads them: one variable by any spelling, the run settings' over the environment it starts with
		const effective = (name: string) => [settings, plan.env].map(env => namesOf(env, name).map(key => env[key])[0]).find(value => value !== undefined);
		assert.deepStrictEqual(['FACADE_AGENT', 'FACADE_CODE_SESSION_FILE', 'TERM_PROGRAM'].map(name => [namesOf(plan.env, name).length, effective(name)]),
			[[1, '#a123'], [1, sessionFile], [1, 'vscode']]);
		assert.deepStrictEqual(namesOf(settings, 'FACADE_CODE_SESSION_FILE'), ['FACADE_CODE_SESSION_FILE']);
	});

	test('CLIS-3.1: an argument another option takes as its value is that option\'s, whatever it looks like - never taken out as --settings, nor moved into Facade\'s own list', () => {
		const catalog = catalogFrom({ clis: { claude: { args: ['--append-system-prompt', '--settings={"theme":"SENTINEL_LITERAL_PROMPT"}', '--system-prompt', '--mcp-config=/mine.json'] } } });
		const plan = planLaunch(catalog, start({ cli: 'claude', tools: { server: SERVER, skill: FACADE_SKILL, runDir } }), destination);
		const after = (option: string) => plan.args[plan.args.indexOf(option) + 1];
		const facade = plan.args.indexOf('--mcp-config');
		assert.deepStrictEqual([
			runSettingsOf(plan, 'claude-settings.json').theme, after('--append-system-prompt'), after('--system-prompt'), plan.args.slice(facade + 1, facade + 3)
		], [undefined, '--settings={"theme":"SENTINEL_LITERAL_PROMPT"}', '--mcp-config=/mine.json', [path.join(runDir, 'mcp.json'), '--plugin-dir']]);
	});

	test('CONFIGURATION-2.2, 5.1: a variable named __proto__ is kept as any other - inherited, set and removed by an entry\'s env, on Windows by any spelling - and in Claude Code\'s run settings from the person\'s --settings', () => {
		const own = (env: { readonly [name: string]: unknown }) => Object.hasOwn(env, '__proto__') ? env['__proto__'] : 'none';
		const host = { ...destination, host: { ...destination.host, ...JSON.parse('{"__proto__":"host"}') as { [name: string]: string } } };
		const tool = (env: string) => planLaunch(catalogFrom(`{"clis":{"tool":{"type":"custom","command":"my-cli","env":${env}}}}`), start({ cli: 'tool' }), host).env;
		assert.deepStrictEqual([own(tool('{}')), own(tool('{"__proto__":"kept"}')), own(tool('{"__proto__":null}'))], ['host', 'kept', 'none']);
		const windows: { [name: string]: string } = JSON.parse('{"__proto__":"a"}');
		setVariable(windows, '__PROTO__', 'b', 'win32');
		assert.deepStrictEqual([Object.keys(windows), own(windows)], [['__proto__'], 'b']);
		const claude = planLaunch(catalogFrom({ clis: { claude: { args: ['--settings', '{"env":{"__proto__":"kept","OK":"kept"},"__proto__":{"top":"kept"}}'] } } }), start({ cli: 'claude' }), destination);
		const settings = runSettingsOf(claude, 'claude-settings.json');
		assert.deepStrictEqual([own(settings.env as { [name: string]: unknown }), (settings.env as { [name: string]: unknown }).OK, own(settings)], ['kept', 'kept', { top: 'kept' }]);
	});

	test('the person\'s --allowedTools and --mcp-config go into Facade\'s own occurrence of each, so that Claude Code keeps both', () => {
		const catalog = catalogFrom({ clis: { claude: { args: ['--allowedTools', 'Bash(git:*)', 'Edit', '--mcp-config=/mine.json', '--verbose'] } } });
		const plan = planLaunch(catalog, start({ cli: 'claude', tools: { server: SERVER, skill: FACADE_SKILL, runDir } }), destination);
		const valuesOf = (option: string) => {
			const at = plan.args.indexOf(option);
			const values: string[] = [];
			for (let index = at + 1; index < plan.args.length && !plan.args[index].startsWith('-'); index++) {
				values.push(plan.args[index]);
			}
			return values;
		};
		assert.deepStrictEqual([
			plan.args.filter(arg => arg === '--allowedTools').length, valuesOf('--allowedTools'),
			plan.args.filter(arg => arg.startsWith('--mcp-config')).length, valuesOf('--mcp-config'), plan.args.includes('--verbose')
		], [1, ['mcp__facade', 'Bash(git:*)', 'Edit'], 1, [path.join(runDir, 'mcp.json'), '/mine.json'], true]);
	});

	test('an end of the options in a built-in\'s args is refused before anything starts: what Facade adds after it - its hooks, the task - stays options and a task (CONFIGURATION-3.1)', () => {
		const catalog = catalogFrom({ clis: { codex: { args: ['--'] }, tool: { type: 'custom', command: 'my-cli', args: ['--', 'x'] } } });
		assert.deepStrictEqual([
			failure(() => planLaunch(catalog, start({ cli: 'codex', prompt: 'Review this change', sessionFile: path.join(cwd, 's.json'), sessionHook: 'hook' }), destination)),
			planLaunch(catalog, start({ cli: 'tool' }), destination).args
		], [['configuration_invalid', 'args_reserved', 'clis.codex.args', '0', '--'], ['--', 'x']]);
	});

	test('CONFIGURATION-3.4: a conversation is resumed, and a pinned agent restored, by the entry that ran it only while it runs the same CLI; one that now runs another says so', () => {
		const catalog = catalogFrom({ clis: { work: { type: 'codex' }, tool: { type: 'custom', command: 'my-cli' } } });
		assert.deepStrictEqual([
			planLaunch(catalog, start({ cli: 'work', resume: { sessionId: '019a-session' }, builtIn: 'codex' }), destination).args.slice(0, 2),
			failure(() => planLaunch(catalog, start({ cli: 'work', resume: { sessionId: '019a-session' }, builtIn: 'claude' }), destination)),
			failure(() => planLaunch(catalog, start({ cli: 'tool', resume: { sessionId: '019a-session' }, builtIn: 'claude' }), destination)),
			// A Pin taken before its CLI named a conversation starts a new one, with the CLI it ran alone
			planLaunch(catalog, start({ cli: 'work', builtIn: 'codex' }), destination).cli,
			failure(() => planLaunch(catalog, start({ cli: 'work', builtIn: 'claude' }), destination))
		], [
			['resume', '019a-session'],
			['unsupported', 'resume_type_changed', 'clis.work', 'Claude Code'],
			['unsupported', 'resume_type_changed', 'clis.tool', 'Claude Code'],
			'work',
			['unsupported', 'pin_type_changed', 'clis.work', 'Claude Code']
		]);
	});

	test('through cmd.exe, a program argument cmd.exe would read as its own is refused by its place in args, never quoted', () => {
		const winbin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(winbin);
		fs.writeFileSync(path.join(winbin, 'my-cli.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		const windows: DestinationEnvironment = { host: { Path: winbin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		const catalog = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', args: ['--fast', 'p&ss'] } } });
		const refused = failure(() => planLaunch(catalog, start({ cli: 'tool' }), windows));
		assert.deepStrictEqual(refused, ['unsupported', 'cmd_unsafe_setting', path.join(winbin, 'my-cli.cmd'), 'clis.tool.args', '1', '"&"', 'clis.tool']);
	});

	test('a CLI the file has not is not started, saying where CLIs are added', () => {
		let english = '';
		try { planLaunch(catalogFrom({}), start({ cli: 'gone' }), destination); } catch (err) { english = (err as Error).message; }
		assert.deepStrictEqual([failure(() => planLaunch(catalogFrom({}), start({ cli: 'gone' }), destination)), english], [
			['not_found', 'cli_not_configured', '"gone"', TEST_SETTINGS_FILE],
			`No CLI "gone" is configured; the built-ins are claude, codex, agy, muse, opencode and pi, and others are added in clis of ${TEST_SETTINGS_FILE}`
		]);
	});

	test('Show Agent Launch says a program\'s launch as a start would have it: its YOLO not applied, its sandbox, approvals and trust unknown to Facade, its env by name', () => {
		const catalog = catalogFrom({ clis: { tool: { type: 'custom', command: 'my-cli', args: ['--fast'], env: { MY_MODE: 'quick', GONE: null } } } });
		const program = describeLaunches(catalog, destination, cwd, true).find(each => each.cli === 'tool')!;
		assert.deepStrictEqual([program.program, program.args, program.yolo, program.sandbox, program.approvals, program.trust, program.setting], [
			{ file: path.join(bin, 'my-cli'), configured: 'my-cli', throughCmd: false }, ['--fast'], undefined, { state: 'unknown' }, { state: 'unknown' }, { kind: 'unknown' }, 'clis.tool'
		]);
		assert.deepStrictEqual(program.environment.variables.filter(each => each.source === 'launch'), [{ source: 'launch', name: 'MY_MODE', value: '<redacted>' }, { source: 'launch', name: 'GONE', value: null }]);
	});
});
