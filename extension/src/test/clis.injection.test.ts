/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { CliAdapter } from '../clis/adapter';
import { Catalog, catalogOf } from '../clis/catalog';
import { claudeAdapter } from '../clis/claude';
import { codexAdapter } from '../clis/codex';
import { antigravityAdapter } from '../clis/antigravity';
import { museAdapter } from '../clis/muse';
import { openCodeAdapter } from '../clis/opencode';
import { piAdapter } from '../clis/pi';
import { acquireProject, injectedRecordOf, markPlanned, PLANNED_ALIVE_MS, reconcileRuns, releaseProject, releaseRun } from '../clis/injected';
import { DestinationEnvironment, inputOf, PlanInput, planLaunch, takesThrough } from '../clis/plan';
import { INPUT_ADAPTERS } from '../ptyd/composer';
import { McpServer, ProjectWrite, runDirOf, ToolsInput } from '../clis/tools';
import type { LaunchPlan, Location, PlanRequest } from '../core/ports';
import type * as HostClisModule from '../host/clis';
import type * as SettingsModule from '../host/settings';
import { instructionsFor } from '../schema/instructions';
import { FACADE_SKILL } from '../schema/skill';
import { TOOLS } from '../schema/tools';
import { tempDir } from './util';
import { withModules } from './withModules';

/** A program the catalog can find: an executable file that is never run. */
function program(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n');
	fs.chmodSync(path.join(dir, name), 0o755);
}

/** The run's shim as the window would give it: the editor's runtime as Node, the shim, and the run and route it serves. */
const SERVER: McpServer = { command: '/Applications/Code.app/runtime', args: ['/ext/dist/shim.js'], env: { ELECTRON_RUN_AS_NODE: '1', FACADE_RUN: 'run-1', FACADE_PTYD: '/tmp/ptyd.sock' } };

/** The text of a file, or undefined where there is none. */
function textOf(file: string): string | undefined {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

suite('CLIs: the Facade tools in each launch (CLIS-2.2, MCP-6.1)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;
	let tools: ToolsInput;

	setup(() => {
		temp = tempDir('fc-inject-');
		const bin = path.join(temp.dir, 'bin');
		for (const name of ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']) {
			program(bin, name);
		}
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir }, platform: 'darwin' };
		tools = { server: SERVER, skill: FACADE_SKILL, runDir: runDirOf(path.join(temp.dir, 'home'), 'run-1') };
	});
	teardown(() => temp.remove());

	const plan = (input: Partial<PlanInput> & { readonly cli: string }, where = destination) =>
		planLaunch(catalogOf(() => undefined), { alias: '#a1', cwd, yolo: true, ...input }, where);

	test('Claude Code: the server in a per-run --mcp-config file, its tools allowed by --allowedTools mcp__facade, the skill in a per-run --plugin-dir plugin; nothing in the project', () => {
		const planned = plan({ cli: 'claude', tools });
		const config = path.join(tools.runDir, 'mcp.json');
		// The connection comes first, before the CLI's own settings and the YOLO mapping (CLIS-3.2)
		assert.deepStrictEqual(planned.args.slice(0, 6), ['--mcp-config', config, '--plugin-dir', path.join(tools.runDir, 'plugin'), '--allowedTools', 'mcp__facade']);
		assert.deepStrictEqual(planned.tools, { state: 'injected' });
		const files = Object.fromEntries(planned.injection!.runFiles.map(each => [path.relative(tools.runDir, each.path), each.content]));
		assert.deepStrictEqual(Object.keys(files), ['mcp.json', path.join('plugin', '.claude-plugin', 'plugin.json'), path.join('plugin', 'skills', 'facade', 'SKILL.md')]);
		assert.deepStrictEqual(JSON.parse(files['mcp.json']), { mcpServers: { facade: { command: SERVER.command, args: SERVER.args, env: SERVER.env } } });
		const manifest = JSON.parse(files[path.join('plugin', '.claude-plugin', 'plugin.json')]);
		assert.strictEqual(manifest.name, 'facade');
		assert.match(manifest.description, /Facade Code tools/);
		assert.strictEqual(files[path.join('plugin', 'skills', 'facade', 'SKILL.md')], FACADE_SKILL);
		assert.deepStrictEqual([planned.injection!.project, planned.injection!.env, planned.env.FACADE_RUN], [[], {}, undefined]);
	});

	test('with YOLO off, Facade\'s own tools still never ask for approval, while the CLI keeps its own approvals and sandbox (CLIS-1.3, D84)', () => {
		const claude = plan({ cli: 'claude', yolo: false, tools });
		assert.ok(claude.args.includes('--allowedTools') && claude.args[claude.args.indexOf('--allowedTools') + 1] === 'mcp__facade', claude.args.join(' '));
		assert.ok(!claude.args.includes('--dangerously-skip-permissions'));
		assert.deepStrictEqual(JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]).sandbox, { enabled: true });
		const codex = plan({ cli: 'codex', yolo: false, tools });
		assert.ok(codex.args.includes('mcp_servers.facade.default_tools_approval_mode="approve"'));
		assert.ok(codex.args.includes('workspace-write') && !codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
		// The server is never made required: a server that fails to start leaves the CLI usable (MCP-6.1)
		assert.ok(!codex.args.some(arg => /required/.test(arg)), codex.args.join(' '));
	});

	test('Codex: the server in -c mcp_servers.facade.* overrides, each a TOML value, approved by default, and the skill in the project\'s .agents/skills/facade', () => {
		const planned = plan({ cli: 'codex', yolo: false, tools: { ...tools, server: { ...SERVER, args: ['/ext/"quoted"/shim.js'], env: { ...SERVER.env, 'A.B': 'x\ny' } } } });
		assert.deepStrictEqual(planned.args.slice(0, 13), [
			'-c', 'mcp_servers.facade.command="/Applications/Code.app/runtime"',
			'-c', 'mcp_servers.facade.args=["/ext/\\"quoted\\"/shim.js"]',
			'-c', 'mcp_servers.facade.env={ "ELECTRON_RUN_AS_NODE" = "1", "FACADE_RUN" = "run-1", "FACADE_PTYD" = "/tmp/ptyd.sock", "A.B" = "x\\ny" }',
			'-c', 'mcp_servers.facade.startup_timeout_sec=30',
			'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
			'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
			'--no-daemon'
		]);
		assert.deepStrictEqual(planned.injection!.project, [{ kind: 'file', path: path.join('.agents', 'skills', 'facade', 'SKILL.md'), content: FACADE_SKILL }]);
		assert.deepStrictEqual([planned.injection!.runFiles, planned.tools], [[], { state: 'injected' }]);
	});

	test('Pi: the server registered for the session by a per-run extension, -e, its tools declared to the model directly, and the skill in a per-run --skill folder; nothing in the project', async () => {
		const planned = plan({ cli: 'pi', tools });
		const extension = path.join(tools.runDir, 'facade-pi.mjs');
		assert.deepStrictEqual(planned.args.slice(0, 4), ['-e', extension, '--skill', path.join(tools.runDir, 'skills', 'facade')]);
		assert.deepStrictEqual([planned.tools, planned.injection!.project, planned.injection!.env, planned.warmUp], [{ state: 'injected' }, [], {}, undefined]);
		const files = Object.fromEntries(planned.injection!.runFiles.map(each => [path.relative(tools.runDir, each.path), each.content]));
		assert.deepStrictEqual(Object.keys(files), ['facade-pi.mjs', path.join('skills', 'facade', 'SKILL.md')]);
		assert.strictEqual(files[path.join('skills', 'facade', 'SKILL.md')], FACADE_SKILL);
		// The extension as Pi loads it: a module whose default export registers the server for the session
		fs.mkdirSync(tools.runDir, { recursive: true });
		fs.writeFileSync(extension, files['facade-pi.mjs']);
		const registered: [string, unknown][] = [];
		// A real dynamic import: the compiled tests are CommonJS, whose import() becomes require
		const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<{ default: (pi: unknown) => void }>;
		const loaded = await importModule(pathToFileURL(extension).href);
		loaded.default({ registerMcpServer: (name: string, config: unknown) => registered.push([name, config]) });
		assert.deepStrictEqual(registered, [['facade', { command: SERVER.command, args: SERVER.args, env: SERVER.env, exposure: 'direct', timeout: 3600, description: 'Facade Code: start, stop and list agents, send and read messages, and read or type into agent terminals.' }]]);
	});

	test('Antigravity: a plugin in the folder\'s .agents/plugins/facade, shared, the run\'s variables in its environment; its tools allowed for the session beside the person\'s own rules; its MCP panel opened before the first turn', () => {
		const settings = path.join(temp.dir, '.gemini', 'antigravity-cli', 'settings.json');
		fs.mkdirSync(path.dirname(settings), { recursive: true });
		fs.writeFileSync(settings, '{\n\t// theirs\n\t"permissions": { "allow": ["command(ls)"], "deny": ["mcp(other_other/*)"] },\n\t"colorScheme": "dark"\n}\n');
		const before = fs.readFileSync(settings, 'utf8');
		const planned = plan({ cli: 'agy', yolo: false, tools });
		assert.strictEqual(planned.args[0], '--settings');
		// --settings replaces a key whole for the session: the person's rules go with Facade's (CLIS-1.3)
		assert.deepStrictEqual(JSON.parse(planned.args[1]), { permissions: { allow: ['command(ls)', 'mcp(facade_facade/*)'], deny: ['mcp(other_other/*)'] } });
		assert.ok(!planned.args.includes('--dangerously-skip-permissions'), 'YOLO off keeps its own approvals');
		assert.strictEqual(fs.readFileSync(settings, 'utf8'), before, 'planning writes nothing');
		const plugin = path.join('.agents', 'plugins', 'facade');
		assert.deepStrictEqual(planned.injection!.project.map(each => each.path), [path.join(plugin, 'plugin.json'), path.join(plugin, 'mcp_config.json'), path.join(plugin, 'skills', 'facade', 'SKILL.md')]);
		const config = planned.injection!.project[1] as Extract<ProjectWrite, { kind: 'file' }>;
		// A shared entry holds no run's identity: the run's variables reach the server through the CLI's environment
		assert.deepStrictEqual(JSON.parse(config.content), { mcpServers: { facade: { command: SERVER.command, args: SERVER.args, env: { ELECTRON_RUN_AS_NODE: '1' } } } });
		assert.deepStrictEqual(planned.injection!.env, { FACADE_RUN: 'run-1', FACADE_PTYD: '/tmp/ptyd.sock' });
		assert.deepStrictEqual([planned.env.FACADE_RUN, planned.env.FACADE_PTYD, planned.env.ELECTRON_RUN_AS_NODE], ['run-1', '/tmp/ptyd.sock', undefined]);
		assert.deepStrictEqual(planned.warmUp, { text: '/mcp', typed: '^> /mcp\\s*$', ready: '✓\\s+facade_facade\\b', opened: '^MCP Servers\\s*$|\\besc Exit\\b', close: 'Escape' });
		// Its first task waits for the tools: it goes as the first message once they are ready
		const prompted = plan({ cli: 'agy', tools, prompt: 'Review the diff' });
		assert.deepStrictEqual(prompted.prompt?.path, 'post_start');
		assert.match(prompted.prompt!.capability.reason, /starts the Facade tools of a folder only with its first turn/);
		assert.ok(!prompted.args.includes('Review the diff'));
		// Settings it cannot read give the rule alone; without the tools, no --settings and nothing typed before the first turn
		fs.writeFileSync(settings, '{ not json');
		assert.deepStrictEqual(JSON.parse(plan({ cli: 'agy', tools }).args[1]), { permissions: { allow: ['mcp(facade_facade/*)'] } });
		const without = plan({ cli: 'agy' });
		assert.deepStrictEqual([without.args.includes('--settings'), without.warmUp], [false, undefined]);
	});

	test('Muse Code: the server for the run alone by -c, its variables references to the CLI\'s environment, the skill in .agents/skills/facade; on Windows, through cmd.exe, the project\'s .mcp.json entry instead, its references empty where unset', () => {
		const planned = plan({ cli: 'muse', tools, prompt: 'Fix the build' });
		const references = { ELECTRON_RUN_AS_NODE: '${FACADE_ELECTRON_RUN_AS_NODE}', FACADE_RUN: '${FACADE_RUN}', FACADE_PTYD: '${FACADE_PTYD}', FACADE_AGENT: '${FACADE_AGENT}' };
		assert.deepStrictEqual(planned.args, ['-c', `mcpServers.facade=${JSON.stringify({ command: SERVER.command, args: SERVER.args, env: references })}`, '--disable-approval', '--disable-sandbox', '--trust-workspace', '--', 'Fix the build']);
		assert.deepStrictEqual(planned.injection!.project, [{ kind: 'file', path: path.join('.agents', 'skills', 'facade', 'SKILL.md'), content: FACADE_SKILL }]);
		// Each reference names a variable the CLI's environment carries; the runtime's under a name no other program reads
		assert.deepStrictEqual([planned.env.FACADE_ELECTRON_RUN_AS_NODE, planned.env.FACADE_RUN, planned.env.FACADE_PTYD, planned.env.FACADE_AGENT, planned.env.ELECTRON_RUN_AS_NODE], ['1', 'run-1', '/tmp/ptyd.sock', '#a1', undefined]);
		assert.deepStrictEqual(planned.prompt?.path, 'native');
		// On Windows its launcher goes through cmd.exe, which cannot carry the entry: it is a shared project entry there
		const windows = museAdapter.tools.inject({ ...tools, platform: 'win32' });
		assert.deepStrictEqual([windows.args, windows.project[0]], [undefined, { kind: 'entry', path: '.mcp.json', keys: ['mcpServers', 'facade'], value: { command: SERVER.command, args: SERVER.args, env: { ELECTRON_RUN_AS_NODE: '1', FACADE_RUN: '${FACADE_RUN:-}', FACADE_PTYD: '${FACADE_PTYD:-}', FACADE_AGENT: '${FACADE_AGENT:-}' } } }]);
		assert.deepStrictEqual(windows.env, { FACADE_RUN: 'run-1', FACADE_PTYD: '/tmp/ptyd.sock' });
	});

	test('a choice cmd.exe cannot carry is not offered where the CLI runs through it: Muse Code\'s effort, a JSON string, before any effect (CLIS-1.4)', () => {
		assert.deepStrictEqual(takesThrough(museAdapter, true, cwd, 'win32'), { model: true, effort: false });
		assert.deepStrictEqual(takesThrough(museAdapter, false, cwd, 'win32'), { model: true, effort: true });
		assert.deepStrictEqual(takesThrough(codexAdapter, true, cwd, 'win32'), { model: true, effort: false }, 'Codex\'s effort is a TOML string too');
		assert.deepStrictEqual(takesThrough(claudeAdapter, true, cwd, 'win32'), { model: true, effort: true });
	});

	test('OpenCode: the server, its tools allowed and the skill as instructions in the run\'s own OPENCODE_CONFIG_CONTENT, on the person\'s own where they set one, with --standalone for a server process of its own', () => {
		const planned = plan({ cli: 'opencode', yolo: false, tools, prompt: 'Explain main.ts' });
		const skill = path.join(tools.runDir, 'skills', 'facade', 'SKILL.md');
		assert.deepStrictEqual(planned.args, ['--standalone', '--prompt', 'Explain main.ts']);
		assert.deepStrictEqual(planned.injection!.runFiles, [{ path: skill, content: FACADE_SKILL }]);
		const facade = { type: 'local', command: [SERVER.command, ...SERVER.args], environment: SERVER.env, enabled: true, timeout: 3_600_000 };
		assert.deepStrictEqual(JSON.parse(planned.env.OPENCODE_CONFIG_CONTENT), { mcp: { facade }, permission: { 'facade_*': 'allow' }, instructions: [skill] });
		assert.deepStrictEqual(planned.injection!.project, []);
		// The person's own inline configuration stays, Facade's rule after theirs
		const theirs = { ...destination, host: { ...destination.host, OPENCODE_CONFIG_CONTENT: '{"permission":"ask","mcp":{"mine":{"type":"local","command":["x"]}},"instructions":["a.md"],"model":"p/m"}' } };
		assert.deepStrictEqual(JSON.parse(plan({ cli: 'opencode', tools }, theirs).env.OPENCODE_CONFIG_CONTENT), {
			permission: { '*': 'ask', 'facade_*': 'allow' }, mcp: { mine: { type: 'local', command: ['x'] }, facade }, instructions: ['a.md', skill], model: 'p/m'
		});
		// Theirs is read as OpenCode reads it, comments and trailing commas allowed
		const commented = { ...destination, host: { ...destination.host, OPENCODE_CONFIG_CONTENT: '{\n\t// theirs\n\t"permission": { "bash": "ask", },\n}' } };
		assert.deepStrictEqual(JSON.parse(plan({ cli: 'opencode', tools }, commented).env.OPENCODE_CONFIG_CONTENT).permission, { bash: 'ask', 'facade_*': 'allow' });
		// One it cannot read stays as it is: the agent starts without the tools rather than without the person's configuration
		const unreadable = { ...destination, host: { ...destination.host, OPENCODE_CONFIG_CONTENT: '{ "model": {env:MODEL} }' } };
		const kept = plan({ cli: 'opencode', tools }, unreadable);
		assert.deepStrictEqual([kept.env.OPENCODE_CONFIG_CONTENT, kept.injection, kept.args.includes('--standalone')], ['{ "model": {env:MODEL} }', undefined, false]);
		assert.deepStrictEqual([kept.tools.state, kept.tools.problem, kept.tools.file], ['unavailable', 'variable', 'OPENCODE_CONFIG_CONTENT']);
		// A prompt it would read as an option goes after startup; without the tools, nothing of Facade's in its environment
		assert.strictEqual(plan({ cli: 'opencode', tools, prompt: '-v' }).prompt?.path, 'post_start');
		const without = plan({ cli: 'opencode' }, theirs);
		assert.deepStrictEqual([without.args.includes('--standalone'), without.env.OPENCODE_CONFIG_CONTENT], [false, theirs.host.OPENCODE_CONFIG_CONTENT]);
	});

	test('Pi\'s prompt is its message after --, except one it would read as a file to attach', () => {
		assert.deepStrictEqual(plan({ cli: 'pi', prompt: 'Fix it' }).args.slice(-3), ['--approve', '--', 'Fix it']);
		const attached = plan({ cli: 'pi', prompt: '@notes.md says why' });
		assert.deepStrictEqual([attached.prompt?.path, attached.args.includes('@notes.md says why')], ['post_start', false]);
		assert.match(attached.prompt!.capability.reason, /starts with @ as a file to attach/);
	});

	test('without tools - orchestration off - nothing is injected and no file is named; planning writes nothing', () => {
		for (const cli of ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']) {
			const planned = plan({ cli });
			assert.deepStrictEqual([planned.tools, planned.injection], [{ state: 'not_injected' }, undefined], cli);
			assert.ok(!planned.args.some(arg => /mcp|plugin-dir|no-daemon|allowedTools|^-e$|--skill|--standalone/.test(arg)), `${cli}: ${planned.args.join(' ')}`);
			// Claude Code's own run settings go with every launch; Antigravity's only with the tools
			assert.ok(cli !== 'agy' || !planned.args.includes('--settings'), planned.args.join(' '));
			assert.ok(!('FACADE_RUN' in planned.env) && !('OPENCODE_CONFIG_CONTENT' in planned.env), cli);
		}
		plan({ cli: 'claude', tools });
		assert.ok(!fs.existsSync(tools.runDir), 'planning writes nothing');
	});

	test('model and effort: each built-in takes both, in its own spelling, only where asked - OpenCode, whose interface takes neither, refuses them (CLIS-1.4)', () => {
		assert.deepStrictEqual([claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, piAdapter, openCodeAdapter].map(each => each.takes),
			[...Array(5).fill({ model: true, effort: true }), { model: false, effort: false }]);
		const agy = plan({ cli: 'agy', model: 'gemini-3.8-flash', effort: 'high' });
		assert.deepStrictEqual(agy.args.slice(agy.args.indexOf('--model'), agy.args.indexOf('--model') + 4), ['--model', 'gemini-3.8-flash', '--effort', 'high']);
		const muse = plan({ cli: 'muse', model: 'muse-spark-1.3', effort: 'max' });
		assert.deepStrictEqual(muse.args.slice(muse.args.indexOf('--model'), muse.args.indexOf('--model') + 6), ['--model', 'muse-spark-1.3', '-c', 'reasoning_effort="max"', '-c', 'model_reasoning_efforts={}']);
		const pi = plan({ cli: 'pi', model: 'qwen/qwen3.8-max', effort: 'low' });
		assert.deepStrictEqual(pi.args.slice(pi.args.indexOf('--model'), pi.args.indexOf('--model') + 4), ['--model', 'qwen/qwen3.8-max', '--thinking', 'low']);
		assert.throws(() => plan({ cli: 'opencode', model: 'p/m' }), /OpenCode has no supported way to set a model/);
		const claude = plan({ cli: 'claude', model: 'opus', effort: 'high' });
		assert.deepStrictEqual(claude.args.slice(claude.args.indexOf('--model'), claude.args.indexOf('--model') + 4), ['--model', 'opus', '--effort', 'high']);
		assert.deepStrictEqual([claude.model, claude.effort], ['opus', 'high']);
		const codex = plan({ cli: 'codex', model: 'gpt-5', effort: 'a "high"\nb' });
		assert.deepStrictEqual(codex.args.slice(codex.args.indexOf('--model'), codex.args.indexOf('--model') + 4), ['--model', 'gpt-5', '-c', 'model_reasoning_effort="a \\"high\\"\\nb"']);
		const neither = plan({ cli: 'claude' });
		assert.ok(!neither.args.includes('--model') && !neither.args.includes('--effort'));
		assert.deepStrictEqual([neither.model, neither.effort], [undefined, undefined]);
	});

	test('the message input is read by each CLI\'s reader whatever its version; there is no version list (CLIS-2.1, D83)', () => {
		assert.deepStrictEqual(inputOf(claudeAdapter), { adapter: 'claude-frame', capability: { state: 'supported', reason: inputOf(claudeAdapter).capability.reason } });
		assert.deepStrictEqual(inputOf(codexAdapter).adapter, 'codex-prompt');
		// Every built-in has a reader ptyd has, recorded on its screens
		const all = [claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, openCodeAdapter, piAdapter];
		assert.deepStrictEqual(all.map(each => inputOf(each).adapter), ['claude-frame', 'codex-prompt', 'agy-frame', 'muse-frame', 'opencode-frame', 'pi-frame']);
		assert.deepStrictEqual(all.map(each => inputOf(each).adapter).filter(id => !INPUT_ADAPTERS.includes(id!)), []);
		for (const each of all) {
			assert.strictEqual(inputOf(each).capability.state, 'supported');
			assert.doesNotMatch(inputOf(each).capability.reason, /\d+\.\d+\.\d+|verified with/);
		}
		const none = inputOf({ ...claudeAdapter, input: undefined });
		assert.deepStrictEqual([none.adapter, none.capability.state], [undefined, 'unavailable']);
		assert.match(none.capability.reason, /Facade cannot read the message input of Claude Code, so messages to it fail; direct terminal input still works/);
		// A plan carries the reader and its state; the version it found is a diagnostic only
		const planned = plan({ cli: 'claude' });
		assert.deepStrictEqual([planned.input.adapter, planned.input.capability.state, planned.version], ['claude-frame', 'supported', undefined]);
	});
});

suite('CLIs: through cmd.exe, the tools never stop a CLI that can start (MCP-6.1, CLIS-1.2)', () => {
	let temp: ReturnType<typeof tempDir>;
	let windows: DestinationEnvironment;
	let cwd: string;

	setup(() => {
		temp = tempDir('fc-cmd-');
		const bin = path.join(temp.dir, 'winbin');
		fs.mkdirSync(bin);
		// A batch file that runs a native program: nothing to start without cmd.exe
		for (const name of ['claude', 'codex', 'toy']) {
			fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\nsomething.exe %*\r\n');
		}
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		windows = { host: { Path: bin, PATHEXT: '.CMD', USERPROFILE: temp.dir }, platform: 'win32' };
	});
	teardown(() => temp.remove());

	const tools = (): ToolsInput => ({ server: SERVER, skill: FACADE_SKILL, runDir: path.join(temp.dir, 'home', 'runs', 'run-1', 'tools') });

	test('a CLI whose own arguments pass starts without the tools, whose quoted arguments cannot: their state unavailable with why', () => {
		// The built-ins' own settings and trust carry quotes; an adapter of plain arguments shows the fallback
		const toy: CliAdapter = {
			...claudeAdapter, id: 'toy', displayName: 'Toy', setting: 'facade.toy', command: 'toy', trustTarget: undefined,
			groups: { connect: ['--mcp', '${mcpConfig}', '--config', '{"x": 1}'], yoloOn: ['--yolo'] }, values: () => ({})
		};
		const catalog: Catalog = { entries: [{ adapter: toy, path: '', problems: [] }] };
		const planned = planLaunch(catalog, { cli: 'toy', alias: '#a1', cwd, yolo: true, tools: tools() }, windows);
		assert.deepStrictEqual([planned.args, planned.injection, planned.tools.state], [['--yolo'], undefined, 'unavailable']);
		assert.match(planned.tools.reason!, /runs through cmd\.exe, which cannot be given the Facade tools' arguments safely; set facade\.toy\.path/);
		// With no tools asked there is nothing to fall back from
		assert.deepStrictEqual(planLaunch(catalog, { cli: 'toy', alias: '#a1', cwd, yolo: true }, windows).tools, { state: 'not_injected' });
	});

	test('a built-in whose own quoted arguments cannot pass through cmd.exe fails to plan with why, tools or not - never a launch with a mangled argument', () => {
		for (const cli of ['claude', 'codex']) {
			for (const withTools of [true, false]) {
				assert.throws(() => planLaunch(catalogOf(() => undefined), { cli, alias: '#a1', cwd, yolo: true, ...withTools ? { tools: tools() } : {} }, windows),
					(err: Error & { reason?: string }) => err.reason === 'unsupported' && /runs through cmd\.exe, which cannot be given the argument/.test(err.message), `${cli} ${withTools}`);
			}
		}
	});
});

suite('CLIs: the native initial prompt (CLIS-3.2, COLLABORATION-2.2, D49)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;

	setup(() => {
		temp = tempDir('fc-prompt-');
		const bin = path.join(temp.dir, 'bin');
		for (const name of ['claude', 'codex']) {
			program(bin, name);
		}
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	const plan = (input: Partial<PlanInput> & { readonly cli: string }) => planLaunch(catalogOf(() => undefined), { alias: '#a1', cwd, yolo: false, ...input }, destination);

	test('Claude Code and Codex take the prompt as their positional argument after --, used while unverified, last of all', () => {
		const prompt = '- Review the changes\n- Report "back"';
		for (const cli of ['claude', 'codex']) {
			const planned = plan({ cli, prompt, tools: { server: SERVER, skill: FACADE_SKILL, runDir: path.join(temp.dir, 'home', 'runs', 'r', 'tools') } });
			assert.deepStrictEqual(planned.args.slice(-2), ['--', prompt], cli);
			assert.deepStrictEqual([planned.prompt?.path, planned.prompt?.capability.state], ['native', 'unverified'], cli);
		}
		assert.strictEqual(plan({ cli: 'claude' }).prompt, undefined);
		assert.ok(!plan({ cli: 'claude' }).args.includes('--'));
	});

	test('a prompt the mapping cannot carry goes after startup, said why: a NUL character', () => {
		const planned = plan({ cli: 'claude', prompt: 'a\0b' });
		assert.deepStrictEqual([planned.prompt?.path, planned.prompt?.capability.state, planned.args.includes('--')], ['post_start', 'unavailable', false]);
		assert.match(planned.prompt!.capability.reason, /NUL character cannot be an argument; it is sent as the first message after the process starts/);
	});
});

suite('CLIs: project files Facade owns (CLIS-2.2)', () => {
	let temp: ReturnType<typeof tempDir>;
	let record: string;
	let cwd: string;

	setup(() => {
		temp = tempDir('fc-project-');
		record = injectedRecordOf(path.join(temp.dir, 'home'));
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
	});
	teardown(() => temp.remove());

	const skill = (content = 'skill v1\n'): ProjectWrite => ({ kind: 'file', path: path.join('.agents', 'skills', 'facade', 'SKILL.md'), content });
	const skillFile = () => path.join(cwd, '.agents', 'skills', 'facade', 'SKILL.md');

	test('the skill is written with the folders it needs, counted per run, and goes with the folders Facade made after the last run lets go', () => {
		assert.strictEqual(acquireProject(record, 'run-a', cwd, [skill()]), undefined);
		assert.strictEqual(acquireProject(record, 'run-b', cwd, [skill()]), undefined);
		assert.strictEqual(textOf(skillFile()), 'skill v1\n');
		assert.deepStrictEqual(releaseProject(record, 'run-a'), []);
		assert.strictEqual(textOf(skillFile()), 'skill v1\n', 'another run still uses it');
		assert.deepStrictEqual(releaseProject(record, 'run-b'), []);
		assert.deepStrictEqual([fs.existsSync(path.join(cwd, '.agents')), fs.existsSync(record)], [false, false]);
	});

	test('a folder of the person\'s stays; a file changed after Facade wrote it stays, with a diagnostic', () => {
		fs.mkdirSync(path.join(cwd, '.agents', 'skills', 'mine'), { recursive: true });
		acquireProject(record, 'run-a', cwd, [skill()]);
		fs.writeFileSync(skillFile(), 'edited by the person\n');
		const diagnostics = releaseProject(record, 'run-a');
		assert.strictEqual(diagnostics.length, 1);
		assert.match(diagnostics[0], /SKILL\.md was changed after Facade wrote it, so it stays/);
		assert.strictEqual(textOf(skillFile()), 'edited by the person\n');
		assert.ok(fs.existsSync(path.join(cwd, '.agents', 'skills', 'mine')));
	});

	test('another facade skill already there is a conflict: nothing is written; the same content already there is used and left as it is', () => {
		fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
		fs.writeFileSync(skillFile(), 'the person\'s own facade skill\n');
		assert.match(acquireProject(record, 'run-a', cwd, [skill()])!, /already exists with other content, such as another facade skill or plugin; Facade leaves it as it is/);
		assert.deepStrictEqual([textOf(skillFile()), fs.existsSync(record)], ['the person\'s own facade skill\n', false]);
		fs.writeFileSync(skillFile(), 'skill v1\n');
		assert.strictEqual(acquireProject(record, 'run-a', cwd, [skill()]), undefined);
		releaseProject(record, 'run-a');
		assert.strictEqual(textOf(skillFile()), 'skill v1\n', 'not Facade\'s to remove');
	});

	test('Facade\'s own file from an earlier version, unchanged since, is brought up to date and keeps its runs; a person\'s byte-exact original comes back', () => {
		acquireProject(record, 'run-a', cwd, [skill('skill v1\n')]);
		assert.strictEqual(acquireProject(record, 'run-b', cwd, [skill('skill v2\n')]), undefined);
		assert.strictEqual(textOf(skillFile()), 'skill v2\n');
		releaseProject(record, 'run-b');
		releaseProject(record, 'run-a');
		assert.strictEqual(fs.existsSync(path.join(cwd, '.agents')), false);
		// An entry merged into the person's own JSON file gives back its exact bytes, comments and BOM included
		const mcp = path.join(cwd, '.mcp.json');
		const original = '﻿{\r\n    // my servers\r\n    "mcpServers": {\r\n        "other": { "command": "x" },\r\n    }\r\n}\r\n';
		fs.writeFileSync(mcp, original);
		assert.strictEqual(acquireProject(record, 'run-c', cwd, [{ kind: 'entry', path: '.mcp.json', keys: ['mcpServers', 'facade'], value: { command: 'node' } }]), undefined);
		assert.match(textOf(mcp)!, /"facade": \{\r\n {12}"command": "node"/);
		releaseProject(record, 'run-c');
		assert.ok(fs.readFileSync(mcp).equals(Buffer.from(original, 'utf8')));
	});

	test('reconcile releases the references of runs no longer alive, keeps those of runs that are, and a run planned moments ago counts as alive', () => {
		const home = path.dirname(record);
		acquireProject(record, 'run-a', cwd, [skill()]);
		acquireProject(record, 'run-b', cwd, [skill()]);
		assert.deepStrictEqual(reconcileRuns(home, ['run-b']), []);
		assert.ok(fs.existsSync(skillFile()));
		markPlanned(home, 'run-c');
		fs.mkdirSync(runDirOf(home, 'run-c'), { recursive: true });
		acquireProject(record, 'run-c', cwd, [skill()]);
		assert.deepStrictEqual(reconcileRuns(home, []), []);
		assert.ok(fs.existsSync(skillFile()) && fs.existsSync(runDirOf(home, 'run-c')), 'planned, not yet listed by ptyd');
		assert.deepStrictEqual(reconcileRuns(home, [], Date.now() + PLANNED_ALIVE_MS + 1_000), []);
		assert.deepStrictEqual([fs.existsSync(path.join(cwd, '.agents')), fs.existsSync(path.dirname(runDirOf(home, 'run-c'))), fs.existsSync(record)], [false, false, false]);
		markPlanned(home, 'run-d');
		assert.deepStrictEqual(releaseRun(home, 'run-d'), []);
		assert.strictEqual(fs.existsSync(path.dirname(runDirOf(home, 'run-d'))), false);
	});

	test('a record that cannot be read is never replaced: a project write is refused with why, and release and reconcile leave it', () => {
		const home = path.dirname(record);
		acquireProject(record, 'run-a', cwd, [skill()]);
		fs.writeFileSync(record, '[]');
		assert.match(acquireProject(record, 'run-b', cwd, [skill()])!, /injected\.json, Facade's record of the project files it wrote, cannot be read: .*; Facade leaves it as it is and writes no project file until it can be read$/);
		assert.match(releaseProject(record, 'run-a')[0], /cannot be read/);
		assert.match(reconcileRuns(home, [])[0], /cannot be read/);
		assert.deepStrictEqual([textOf(record), textOf(skillFile())], ['[]', 'skill v1\n']);
		assert.strictEqual(acquireProject(record, 'run-c', cwd, []), undefined, 'a launch without project content is not affected');
	});
});

suite('CLIs: the planner of the window (CLIS-2.2, RULES-4.4, MCP-1.3)', () => {
	let temp: ReturnType<typeof tempDir>;
	let home: string;
	let location: Location;
	let settings: { [name: string]: unknown };
	let destination: DestinationEnvironment;

	const vscode = {
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		workspace: { getConfiguration: () => ({ get: (name: string) => settings[name] }) }
	};
	const load = withModules({ vscode });
	const { HostClis } = load<typeof HostClisModule>(require.resolve('../host/clis'));
	const { readWaitSeconds, waitSeconds } = load<typeof SettingsModule>(require.resolve('../host/settings'));

	setup(() => {
		temp = tempDir('fc-host-');
		home = path.join(temp.dir, 'home');
		const bin = path.join(temp.dir, 'bin');
		for (const name of ['claude', 'codex']) {
			program(bin, name);
		}
		const cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		location = { id: 'loc-1', uri: `file://${cwd}`, path: cwd, label: 'repo', environment: 'local', folders: [] } as unknown as Location;
		settings = {};
		destination = { host: { PATH: bin, HOME: temp.dir }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	const clis = (log: string[] = []) => new HostClis({ read: name => settings[name], destination: () => destination, home, log: line => log.push(line) });
	const request = (cli: string, run: string, extra: Partial<PlanRequest> = {}): PlanRequest => ({ run, alias: '#a1', name: 'n', cli, location, yolo: true, tools: SERVER, ...extra });

	test('orchestration is on by default, off where the setting is false, and off for a value that is no boolean, said; the timeout is 1-3600 seconds, 120 otherwise, said', () => {
		assert.strictEqual(clis().collaborationEnabled(), true);
		settings['facade.collaboration.enabled'] = false;
		assert.strictEqual(clis().collaborationEnabled(), false);
		settings['facade.collaboration.enabled'] = 'yes';
		const said: string[] = [];
		assert.strictEqual(clis(said).collaborationEnabled(), false);
		assert.deepStrictEqual(said, ['facade.collaboration.enabled must be true or false; received "yes". Agents start without the Facade tools until it is fixed']);
		const logged: string[] = [];
		assert.deepStrictEqual([undefined, 30, 3600, 0, 3601, 2.5, '60'].map(value => waitSeconds(() => value, line => logged.push(line))), [120, 30, 3600, 120, 120, 120, 120]);
		assert.strictEqual(logged.length, 4);
		assert.strictEqual(logged[3], 'facade.collaboration.waitSeconds must be a whole number of seconds from 1 to 3600; received "60". 120 seconds are used until it is fixed');
		assert.deepStrictEqual([readWaitSeconds(() => undefined), readWaitSeconds(() => 0).value], [{ value: 120 }, 120]);
	});

	test('a start with tools has its run and project files written; release removes them; the plan the core gets names no files to write', async () => {
		const planner = clis();
		const claude: LaunchPlan = await planner.plan(request('claude', 'run-1', { prompt: 'hello' }));
		const runDir = runDirOf(home, 'run-1');
		assert.deepStrictEqual([claude.tools, claude.prompt?.path, 'injection' in claude, 'trust' in claude, claude.args.at(-1)], [{ state: 'injected' }, 'native', false, false, 'hello']);
		assert.ok(fs.existsSync(path.join(runDir, 'mcp.json')) && fs.existsSync(path.join(runDir, 'plugin', 'skills', 'facade', 'SKILL.md')));
		const codex = await planner.plan(request('codex', 'run-2', { model: 'gpt-5' }));
		assert.deepStrictEqual([codex.tools.state, codex.model], ['injected', 'gpt-5']);
		assert.strictEqual(textOf(path.join(location.path, '.agents', 'skills', 'facade', 'SKILL.md')), FACADE_SKILL);
		await planner.release('run-1');
		await planner.release('run-2');
		assert.deepStrictEqual([fs.existsSync(path.join(home, 'runs', 'run-1')), fs.existsSync(path.join(location.path, '.agents'))], [false, false]);
		const without = await planner.plan(request('claude', 'run-3', { tools: undefined }));
		assert.deepStrictEqual([without.tools, without.args.includes('--mcp-config'), fs.existsSync(runDirOf(home, 'run-3'))], [{ state: 'not_injected' }, false, false]);
	});

	test('a conflict leaves the CLI to start without the tools, their state unavailable with why, and nothing of the run written', async () => {
		fs.mkdirSync(path.join(location.path, '.agents', 'skills', 'facade'), { recursive: true });
		fs.writeFileSync(path.join(location.path, '.agents', 'skills', 'facade', 'SKILL.md'), 'someone else\'s facade skill\n');
		const codex = await clis().plan(request('codex', 'run-1'));
		assert.strictEqual(codex.tools.state, 'unavailable');
		assert.match(codex.tools.reason!, /already exists with other content/);
		assert.ok(!codex.args.some(arg => arg.includes('mcp_servers')), 'the launch without the tools');
		assert.deepStrictEqual([fs.existsSync(path.join(home, 'runs', 'run-1')), textOf(path.join(location.path, '.agents', 'skills', 'facade', 'SKILL.md'))], [false, 'someone else\'s facade skill\n']);
	});

	test('a start whose project write cannot be recorded - the record unreadable - goes ahead without the tools, says why, and leaves the record as it is', async () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(injectedRecordOf(home), 'not json');
		const codex = await clis().plan(request('codex', 'run-1'));
		assert.strictEqual(codex.tools.state, 'unavailable');
		assert.match(codex.tools.reason!, /cannot be read/);
		assert.deepStrictEqual([textOf(injectedRecordOf(home)), fs.existsSync(path.join(location.path, '.agents'))], ['not json', false]);
	});

	test('reconcile removes the files of runs no longer alive, keeping a run another window planned and has not started', async () => {
		const planner = clis();
		await planner.plan(request('claude', 'run-1'));
		await planner.plan(request('codex', 'run-2'));
		await clis().reconcile([]);
		assert.deepStrictEqual([fs.existsSync(path.join(runDirOf(home, 'run-1'), 'mcp.json')), textOf(path.join(location.path, '.agents', 'skills', 'facade', 'SKILL.md'))], [true, FACADE_SKILL]);
		reconcileRuns(home, ['run-2'], Date.now() + PLANNED_ALIVE_MS + 1_000);
		assert.deepStrictEqual([fs.existsSync(runDirOf(home, 'run-1')), fs.existsSync(path.join(location.path, '.agents', 'skills', 'facade', 'SKILL.md'))], [false, true]);
	});

	test('describe states, for a start here, the choices each CLI takes, its native prompt mapping, its input reader and nothing it does not stand behind; it writes nothing', () => {
		const described = clis().describe(location, true).launches;
		assert.deepStrictEqual(described.map(each => each.cli), ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi']);
		const claude = described[0];
		assert.deepStrictEqual([claude.takes, claude.initialPrompt?.mapping, claude.initialPrompt?.capability.state, claude.input?.adapter, claude.input?.capability.state],
			[{ model: true, effort: true }, ['--', '${prompt}'], 'unverified', 'claude-frame', 'supported']);
		assert.strictEqual(described[1].input?.adapter, 'codex-prompt');
		// Each new built-in: its reader, its choices, and how its first task goes in - Antigravity's after its tools are ready
		assert.deepStrictEqual(described.slice(2).map(each => [each.cli, each.input?.adapter, each.takes, each.initialPrompt?.mapping ?? null, each.initialPrompt?.capability.state]), [
			['agy', 'agy-frame', { model: true, effort: true }, null, 'unavailable'],
			['muse', 'muse-frame', { model: true, effort: true }, ['--', '${prompt}'], 'unverified'],
			['opencode', 'opencode-frame', { model: false, effort: false }, ['--prompt', '${prompt}'], 'unverified'],
			['pi', 'pi-frame', { model: true, effort: true }, ['--', '${prompt}'], 'unverified']
		]);
		assert.match(described[2].initialPrompt!.capability.reason, /first task goes in as its first message once they are ready/);
		// The programs here are no installations naming a version
		assert.deepStrictEqual(described.map(each => each.version), described.map(() => undefined));
		assert.ok(!fs.existsSync(home));
	});
});

suite('Schema: the bundled skill and the server instructions (MCP-6.2)', () => {

	test('the skill teaches the nine tools, startup fields, reach, references, own inbox and finite delivery, and gives the repeated-message sentences verbatim', () => {
		const verbatim = 'The same Facade message can arrive more than once. Use its message ID to recognize a repeat and do not redo work for '
			+ 'that same message. A new send call has a new ID, even if its text matches. A Facade system result about a message is a '
			+ 'separate kind of information, not another copy of that message\'s instruction.';
		assert.ok(FACADE_SKILL.includes(verbatim));
		assert.match(FACADE_SKILL, /^---\nname: facade\ndescription: .+\n---\n/);
		assert.deepStrictEqual(TOOLS.map(tool => tool.name).filter(name => !FACADE_SKILL.includes(`\`${name}\``)), []);
		for (const fact of ['`model`', '`effort`', '`prompt`', '`facade.yolo`', 'creation tree', 'Delivery is finite']) {
			assert.ok(FACADE_SKILL.includes(fact), fact);
		}
		assert.ok(!/facade\.agents\.|Facade Dots/.test(FACADE_SKILL));
		// Mechanics only: no workflow, mandatory reply, escalation, request keys, tasks or authentication
		for (const absent of [/request_id|idempoten/i, /\btask\b/i, /escalat/i, /must (reply|answer|report)/i, /token|credential|authenticat/i]) {
			assert.ok(!absent.test(FACADE_SKILL), String(absent));
		}
	});

	test('the instructions name the run and the Facade Code tools, briefly, with the repeated-message rule', () => {
		const text = instructionsFor('#a7');
		assert.match(text, /#a7/);
		assert.ok(text.includes('The same Facade message can arrive more than once.') && /own inbox/.test(text));
		assert.ok(!/Facade Dots/.test(text));
		assert.ok(text.length < 1500, `${text.length} characters`);
	});
});
