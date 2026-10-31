/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { catalogOf } from '../clis/catalog';
import { readCustomClis } from '../clis/custom';
import { describeLaunches } from '../clis/describe';
import { CliPlanError, DestinationEnvironment, discover, planLaunch } from '../clis/plan';
import { tempDir } from './util';

const BUILT_INS = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'];

/** A custom definition as the settings document holds one, its Resume command the required exact-session one. */
const VALID = { path: 'my-cli', launch: { start: ['--fast'], resume: ['resume', '${sessionId}'], environment: { MY_MODE: 'quick', GONE: null } } };

/** What is wrong with the custom definition `value`, by kind and values. */
function problemsOf(value: unknown): unknown[] {
	return readCustomClis({ x: value }, BUILT_INS).clis[0].problems.map(problem => [problem.said.kind, ...problem.said.values]);
}

suite('CLIs: custom CLIs (CLIS-3.4)', () => {

	test('a valid definition is read as configured, in configuration order; no setting, none', () => {
		const read = readCustomClis({ 'my-cli': VALID, other: { path: ' /opt/other ', launch: { resume: ['--resume=${sessionId}'] } } }, BUILT_INS);
		assert.deepStrictEqual(read, {
			clis: [
				{ key: 'my-cli', setting: 'facade.custom.my-cli', path: 'my-cli', start: ['--fast'], resume: ['resume', '${sessionId}'], environment: { MY_MODE: 'quick', GONE: null }, problems: [] },
				{ key: 'other', setting: 'facade.custom.other', path: '/opt/other', start: [], resume: ['--resume=${sessionId}'], environment: {}, problems: [] }
			],
			problems: []
		});
		assert.deepStrictEqual(readCustomClis(undefined, BUILT_INS), { clis: [], problems: [] });
	});

	test('the required exact-session Resume: missing, empty, without ${sessionId}, or in a launch that is no object, is a configuration error', () => {
		assert.deepStrictEqual([
			problemsOf({ path: 'my-cli' }),
			problemsOf({ path: 'my-cli', launch: { start: [] } }),
			problemsOf({ path: 'my-cli', launch: { resume: [] } }),
			problemsOf({ path: 'my-cli', launch: { resume: ['resume', 'last'] } }),
			problemsOf({ path: 'my-cli', launch: ['resume'] })
		], [
			[['custom_resume_missing', 'facade.custom.x', '${sessionId}']],
			[['custom_resume_missing', 'facade.custom.x', '${sessionId}']],
			[['custom_resume_missing', 'facade.custom.x', '${sessionId}']],
			[['custom_resume_placeholder', 'facade.custom.x', '${sessionId}']],
			[['custom_launch_type', 'facade.custom.x', 'array']]
		]);
	});

	test('each wrong field names its setting, and a received value by its type alone - it may be a secret', () => {
		assert.deepStrictEqual([
			problemsOf('sk-live-secret'),
			problemsOf({ ...VALID, path: undefined }),
			problemsOf({ ...VALID, path: 12345 }),
			problemsOf({ ...VALID, path: '  ' }),
			problemsOf({ ...VALID, path: 'my\0cli' }),
			problemsOf({ ...VALID, capabilities: { resume: true }, model: 'x' }),
			problemsOf({ ...VALID, launch: { ...VALID.launch, arguments: [] } }),
			problemsOf({ ...VALID, launch: { ...VALID.launch, start: 'sk-live-secret', environment: { TOKEN: 7 } } })
		], [
			[['custom_entry_type', 'facade.custom.x', 'string', '{ "path": "my-cli", "launch": { "resume": ["resume", "${sessionId}"] } }']],
			[['custom_path_missing', 'facade.custom.x']],
			[['path_type', 'facade.custom.x', 'number']],
			[['custom_path_empty', 'facade.custom.x']],
			[['path_nul', 'facade.custom.x']],
			[['custom_capabilities', 'facade.custom.x'], ['custom_field', 'facade.custom.x', 'model']],
			[['custom_launch_field', 'facade.custom.x', 'arguments']],
			[['arguments_type', 'facade.custom.x.launch.start', 'string'], ['environment_value', 'facade.custom.x.launch.environment', 'TOKEN', 'number']]
		]);
		assert.ok(!JSON.stringify(readCustomClis({ x: 'sk-live-secret', y: { ...VALID, path: 12345 } }, BUILT_INS)).includes('sk-live'));
		assert.deepStrictEqual(readCustomClis(['my-cli'], BUILT_INS).problems.map(problem => problem.said), [{ kind: 'custom_type', values: ['facade.custom', 'array'] }]);
	});

	test('${sessionId} in Resume is the only placeholder, another said by its place and never quoted - it may hold a secret; a new conversation has no session ID', () => {
		assert.deepStrictEqual([
			problemsOf({ path: 'p', launch: { start: ['--a', '--token=${sk-live-secret}'], resume: ['${sessionId}'] } }),
			problemsOf({ path: 'p', launch: { resume: ['--id', '${sessionId}', '${env:HOME}'] } }),
			problemsOf({ path: 'p', launch: { start: ['--resume', '${sessionId}'], resume: ['${sessionId}'] } })
		], [
			[['custom_placeholder', 'facade.custom.x.launch.start', '1', '${sessionId}']],
			[['custom_placeholder', 'facade.custom.x.launch.resume', '2', '${sessionId}']],
			[['custom_start_session', 'facade.custom.x.launch.start', '1', '${sessionId}']]
		]);
		assert.ok(!JSON.stringify(readCustomClis({ x: { path: 'p', launch: { start: ['--token=${sk-live-secret}'], resume: ['${sessionId}'] } } }, BUILT_INS).clis[0].problems).includes('sk-live'));
	});

	test('a key that cannot be an ID - empty, blank, invisible, holding a control character, or a built-in\'s - defines no CLI, said apart: a built-in is never doubled', () => {
		const read = readCustomClis({ codex: VALID, '': VALID, '  ': VALID, 'a\tb': VALID, '\u200b': VALID, 'my-cli': VALID }, BUILT_INS);
		assert.deepStrictEqual([read.clis.map(each => each.key), read.problems.map(problem => problem.said)], [['my-cli'], [
			{ kind: 'custom_builtin', values: ['facade.custom.codex', '"codex"'] },
			{ kind: 'custom_key', values: ['facade.custom', '""'] },
			{ kind: 'custom_key', values: ['facade.custom', '"  "'] },
			{ kind: 'custom_key', values: ['facade.custom', '"a\\tb"'] },
			{ kind: 'custom_key', values: ['facade.custom', '"\u200b"'] }
		]]);
	});
});

suite('CLIs: a custom CLI in the catalog, its discovery and its launch (CLIS-1.1, 3.4)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;
	let bin: string;

	setup(() => {
		temp = tempDir('fd-custom-');
		bin = path.join(temp.dir, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'my-cli'), '#!/bin/sh\nexit 0\n');
		fs.chmodSync(path.join(bin, 'my-cli'), 0o755);
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir }, terminal: { FROM_TERMINAL: 't' }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	const catalog = (custom: unknown) => catalogOf(name => (name === 'facade.custom' ? custom : undefined));

	test('custom CLIs follow the built-ins in configuration order, always offered; a wrong one is offered unavailable with why, never hidden', () => {
		const read = catalog({ 'my-cli': VALID, broken: { path: 'my-cli' }, missing: { ...VALID, path: 'not-there' } });
		assert.deepStrictEqual(read.entries.map(entry => [entry.adapter.id, entry.enabled, entry.extraSetting]).slice(5), [
			['pi', true, 'facade.pi.launch.arguments'],
			['my-cli', true, 'facade.custom.my-cli.launch.start'],
			['broken', true, 'facade.custom.broken.launch.start'],
			['missing', true, 'facade.custom.missing.launch.start']
		]);
		const found = discover(read, destination, cwd).slice(6).map(each => [each.entry.adapter.id, each.available, each.said?.kind, each.notInstalled]);
		assert.deepStrictEqual(found, [['my-cli', true, undefined, undefined], ['broken', false, 'custom_resume_missing', undefined], ['missing', false, 'path_not_on_path', undefined]]);
		assert.deepStrictEqual(catalog('nope').problems.map(problem => problem.said.kind), ['custom_type']);
	});

	test('a custom launch is its path with its start arguments, literally: no YOLO mapping either way, its environment over the terminal\'s, the run\'s alias, no trust Facade knows of', () => {
		const read = catalog({ 'my-cli': { ...VALID, launch: { ...VALID.launch, environment: { MY_MODE: 'quick', SHARED: 'custom', GONE: null } } } });
		const layered: DestinationEnvironment = { ...destination, terminal: { FROM_TERMINAL: 't', SHARED: 'terminal', GONE: 'from-terminal' } };
		const on = planLaunch(read, { cli: 'my-cli', alias: '#a3', cwd, yolo: true }, layered);
		const off = planLaunch(read, { cli: 'my-cli', alias: '#a3', cwd, yolo: false }, layered);
		assert.deepStrictEqual([on.executable, on.args, off.args, on.cwd, on.trust, on.displayName, on.command], [path.join(bin, 'my-cli'), ['--fast'], ['--fast'], cwd, { kind: 'unknown' }, 'my-cli', 'my-cli']);
		assert.deepStrictEqual([on.env.MY_MODE, on.env.SHARED, 'GONE' in on.env, on.env.FROM_TERMINAL, on.env.FACADE_AGENT], ['quick', 'custom', false, 't', '#a3']);
	});

	test('a wrong custom CLI does not start, saying why; an ID not found names facade.custom\'s own errors where it has any', () => {
		const failure = (run: () => unknown) => {
			try {
				run();
			} catch (err) {
				return err instanceof CliPlanError ? [err.reason, err.said?.kind ?? err.message] : ['thrown', String(err)];
			}
			return 'planned';
		};
		const input = { cli: 'my-cli', alias: '#a1', cwd, yolo: true };
		assert.deepStrictEqual([
			failure(() => planLaunch(catalog({ 'my-cli': { path: 'my-cli' } }), input, destination)),
			failure(() => planLaunch(catalog({ 'my-cli': { ...VALID, path: 'not-there' } }), input, destination)),
			failure(() => planLaunch(catalog(['my-cli']), input, destination)),
			failure(() => planLaunch(catalog({}), input, destination))
		], [
			['configuration_invalid', 'custom_resume_missing'],
			['not_found', 'path_not_on_path'],
			['not_found', 'No CLI "my-cli" is configured; the built-ins are claude, codex, agy, muse, opencode and pi; custom CLIs are configured in facade.custom, which has errors: facade.custom must be an object of custom CLIs by ID; received array'],
			['not_found', 'No CLI "my-cli" is configured; the built-ins are claude, codex, agy, muse, opencode and pi, and custom CLIs are configured in facade.custom']
		]);
	});

	test('through cmd.exe, a start argument cmd.exe would read as its own is refused by its place in .launch.start, never quoted', () => {
		const winbin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(winbin);
		fs.writeFileSync(path.join(winbin, 'my-cli.cmd'), '@echo off\r\nsomething.exe %*\r\n');
		const windows: DestinationEnvironment = { host: { Path: winbin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
		try {
			planLaunch(catalog({ 'my-cli': { ...VALID, launch: { ...VALID.launch, start: ['--fast', 'p&ss'] } } }), { cli: 'my-cli', alias: '#a1', cwd, yolo: true }, windows);
			assert.fail('planned');
		} catch (err) {
			assert.ok(err instanceof CliPlanError);
			assert.deepStrictEqual([err.said, err.message.includes('p&ss')], [{ kind: 'cmd_unsafe_setting', values: [path.join(winbin, 'my-cli.cmd'), 'facade.custom.my-cli.launch.start', '1', '"&"', 'facade.custom.my-cli'] }, false]);
		}
	});

	test('Show Agent Launch says a custom CLI\'s launch as a start would have it, its YOLO not applied and its sandbox, approvals and trust unknown to Facade', () => {
		const custom = describeLaunches(catalog({ 'my-cli': VALID }), destination, cwd, true).find(each => each.cli === 'my-cli')!;
		assert.deepStrictEqual([custom.program, custom.args, custom.yolo, custom.sandbox, custom.approvals, custom.trust, custom.setting], [
			{ file: path.join(bin, 'my-cli'), configured: 'my-cli', throughCmd: false }, ['--fast'], undefined, { state: 'unknown' }, { state: 'unknown' }, { kind: 'unknown' }, 'facade.custom.my-cli'
		]);
		assert.deepStrictEqual(custom.environment.variables.filter(each => each.source === 'launch'), [{ source: 'launch', name: 'MY_MODE', value: 'quick' }, { source: 'launch', name: 'GONE', value: null }]);
	});
});
