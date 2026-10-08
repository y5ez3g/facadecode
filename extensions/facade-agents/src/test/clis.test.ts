/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { messageOf } from '../base/errors';
import { FileLock } from '../base/lock';
import { antigravityCli } from '../clis/antigravity';
import { claudeCli, claudeConfigFile } from '../clis/claude';
import { AgentCli, ARG_GROUPS, capabilitiesOf, LaunchInput, skillMarkdown } from '../clis/cli';
import { codexCli } from '../clis/codex';
import { MAX_DELAY_MS, MAX_TIME_S, readCliConfig, secondsSetting } from '../clis/config';
import { launchDocument } from '../clis/describe';
import { launchTarget, unsafeForCmd, which } from '../clis/executable';
import { museCli } from '../clis/muse';
import { installedClis, knownClis } from '../clis/registry';
import { mergeIntoJsonFile, trustTarget, writeTrust } from '../clis/trust';
import { START_TIMEOUT_MS } from '../core/launch';
import { WINDOW_WAIT_MS } from '../transport/protocol';
import { replaceFsFunction, tempDir } from './util';

const BOM = String.fromCharCode(0xfeff);
const SKILL = { name: 'facade', description: 'How to work in Facade Code.', body: '# Working in Facade Code' };
const SKILL_MD = '---\nname: facade\ndescription: How to work in Facade Code.\n---\n\n# Working in Facade Code\n';
const MCP = { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', '/runs/7.token'], env: { ELECTRON_RUN_AS_NODE: '1' } };
/** How agent #7 reaches the window, as the core gives it. */
const CONNECTION = { mcp: MCP, values: { executable: '/facade/facade', shimFile: '/facade/shim.js', pipe: 'pipe', recordDir: '/record', tokenFile: '/runs/7.token', waitMs: '120000' } };

/** A setting as package.json declares it, and each part of one that is an object. */
interface Declared {
	readonly type?: unknown;
	readonly default?: unknown;
	readonly scope?: string;
	readonly tags?: readonly string[];
	readonly maximum?: number;
	readonly markdownDescription?: string;
	readonly dependencies?: unknown;
	readonly properties?: { readonly [part: string]: Declared };
}

/** What a call came to: `done`, or the message of what it threw. */
function outcome(call: () => unknown): string {
	try {
		call();
		return 'done';
	} catch (err) {
		return messageOf(err);
	}
}

/** What a launch of `cli` is given, as the core gives it for #7: its defaults, YOLO on, with the agent framework, where a test sets nothing else. */
function inputFor(cli: AgentCli, overrides: Partial<LaunchInput> = {}): LaunchInput {
	return { folder: '/lab', repository: '/lab', messagesDir: '/record/messages', yolo: true, model: 'model-x', effort: 'high', connection: CONNECTION, skills: [SKILL], config: cli.defaults, runDir: '/runs', slug: '7', ...overrides };
}

/** The folder `/lab` as Codex keys its trust in it: its path, its drive in lower case on Windows. */
const LAB_KEY = JSON.stringify(process.platform === 'win32' ? path.resolve('/lab').replace(/[A-Z]/g, letter => letter.toLowerCase()) : '/lab');

/** The extension's package.json - its settings and its commands - and its descriptions by key. */
function manifest(): { readonly sections: readonly { readonly id: string; readonly properties: { readonly [key: string]: Declared } }[]; readonly commands: readonly { readonly command: string }[]; readonly texts: { readonly [key: string]: string } } {
	const root = path.join(__dirname, '..', '..');
	const { contributes } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	return {
		sections: contributes.configuration,
		commands: contributes.commands,
		texts: JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'))
	};
}

suite('CLIs: each launch, argument by argument', () => {

	test('Claude Code runs in its own UI with YOLO on - nothing asked, its sandbox off, its warning about it off - with Facade\'s server beside the person\'s own servers and settings, the switches that would stop it at a question nobody asked for off - in its environment, where one is, else in its settings - its question tool taken away, its skill from the run, on the model and at the effort asked for, the task\'s notice after the options; without a task it starts at its input box', () => {
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', effort: 'xhigh', task: '--- Plan\nAdd clamp.' }), '/bin/claude');
		const file = (name: string) => JSON.parse(spec.files.find(each => path.basename(each.path) === name)?.content ?? 'null');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files.map(each => each.path), config: file('7.mcp.json'), settings: file('7.settings.json'), plugin: file('plugin.json'), skill: spec.files[3]?.content, injected: spec.injected, noTask: claudeCli.launch(inputFor(claudeCli), '/bin/claude').args.includes('--') }, {
			executable: '/bin/claude',
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
				'--settings', path.join('/runs', '7.settings.json'),
				'--disallowedTools', 'AskUserQuestion',
				'--add-dir', '/record/messages',
				'--dangerously-skip-permissions',
				'--model', 'opus',
				'--effort', 'xhigh',
				'--', '--- Plan\nAdd clamp.'
			],
			env: {
				CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
				CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
				CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
				DISABLE_AUTOUPDATER: '1',
				CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
				CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1'
			},
			cwd: '/lab',
			files: [
				path.join('/runs', '7.settings.json'),
				path.join('/runs', '7.mcp.json'),
				path.join('/runs', '7.plugin', '.claude-plugin', 'plugin.json'),
				path.join('/runs', '7.plugin', 'skills', 'facade', 'SKILL.md')
			],
			config: { mcpServers: { facade: { type: 'stdio', ...MCP } } },
			settings: { skipDangerousModePermissionPrompt: true, spinnerTipsEnabled: false, emojiCompletionEnabled: false, ...process.platform === 'win32' ? {} : { sandbox: { enabled: false } } },
			plugin: { name: 'facade', version: '1.0.0', description: 'How to work in Facade Code with other agents and the person.', author: { name: 'Facade Code' } },
			skill: SKILL_MD,
			injected: [],
			noTask: false
		});
	});

	test('Codex runs in its own UI with YOLO on - no approvals, no sandbox, the project\'s hooks unreviewed - with Facade\'s server, its tools approved, the person\'s trust in its folder and the switches that would stop it at a question as -c overrides, in a process of its own, at the effort asked for; its skill goes into the folder', () => {
		const spec = codexCli.launch(inputFor(codexCli, { model: 'gpt-6-luna', effort: 'max', task: '--- Plan' }), '/bin/codex');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected: spec.injected, noTask: codexCli.launch(inputFor(codexCli), '/bin/codex').args.includes('--') }, {
			executable: '/bin/codex',
			args: [
				'-c', 'mcp_servers.facade.command="/facade/facade"',
				'-c', 'mcp_servers.facade.args=["/facade/shim.js", "mcp", "--pipe", "pipe", "--token-file", "/runs/7.token"]',
				'-c', 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1" }',
				'-c', 'mcp_servers.facade.startup_timeout_sec=30',
				'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
				'-c', 'mcp_servers.facade.required=true',
				'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
				'--no-daemon',
				'-c', 'check_for_update_on_startup=false',
				'-c', 'tui.show_tooltips=false',
				'-c', 'notice.hide_rate_limit_model_nudge=true',
				'--dangerously-bypass-approvals-and-sandbox',
				'--dangerously-bypass-hook-trust',
				'--model', 'gpt-6-luna',
				'-c', 'model_reasoning_effort="max"',
				'-c', `projects={ ${LAB_KEY} = { trust_level = "trusted" } }`,
				'--', '--- Plan'
			],
			env: {},
			cwd: '/lab',
			files: [],
			injected: [{ path: '.agents/skills/facade/SKILL.md', content: SKILL_MD }],
			noTask: false
		});
	});

	test('Codex is told for each launch alone to trust the folder it starts in, before the person\'s own arguments and its task, by its real path - only its ASCII letters in lower case on Windows, as Codex keys it - as a table whose key keeps the dots of the path', () => {
		const temp = tempDir('facade-codex-');
		try {
			const folder = path.join(temp.dir, 'Lab.V2-Ä');
			fs.mkdirSync(folder);
			const args = codexCli.launch(inputFor(codexCli, { folder }), '/bin/codex').args;
			const real = fs.realpathSync.native(folder);
			const key = process.platform === 'win32' ? real.replace(/[A-Z]/g, letter => letter.toLowerCase()) : real;

			const at = args.findIndex(arg => arg.startsWith('projects='));
			assert.deepStrictEqual(args.slice(at - 1, at + 1), ['-c', `projects={ ${JSON.stringify(key)} = { trust_level = "trusted" } }`]);
		} finally {
			temp.remove();
		}
	});

	test('with YOLO off, each CLI is started with its yoloOff arguments in place of its yoloOn - the person\'s own where they set them - and with everything else as it was: Claude Code and Codex keep their sandboxes and let Facade\'s server alone through, Muse Code keeps its sandbox and asks for nothing, and Antigravity, with no sandbox, asks for nothing', () => {
		const theirs = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { yoloOn: ['--yolo'], yoloOff: ['--careful'] } } : undefined);
		const swapped = (cli: AgentCli, config = cli.defaults) => {
			const on = cli.launch(inputFor(cli, { config, task: 'Plan.' }), '/bin/cli').args;
			const off = cli.launch(inputFor(cli, { config, task: 'Plan.', yolo: false }), '/bin/cli').args;
			return { removed: on.filter(arg => !off.includes(arg)), added: off.filter(arg => !on.includes(arg)) };
		};

		assert.deepStrictEqual([...knownClis().map(cli => swapped(cli)), swapped(codexCli, theirs)], [
			{ removed: ['--dangerously-skip-permissions'], added: ['--allowedTools', 'mcp__facade'] },
			{ removed: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], added: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
			{ removed: ['--mode', 'accept-edits'], added: [] },
			{ removed: ['--disable-sandbox'], added: [] },
			{ removed: ['--yolo'], added: ['--careful'] }
		]);
	});

	test('Claude Code\'s sandbox follows the agent\'s YOLO in the settings file of its run, where it has one, unless the person\'s launch sets its own', () => {
		const sandboxOf = (yolo: boolean, config = claudeCli.defaults) => JSON.parse(claudeCli.launch(inputFor(claudeCli, { yolo, config }), '/bin/claude').files[0].content).sandbox;
		const theirs = readCliConfig(claudeCli, name => name === 'launch' ? { settings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } } } : undefined);

		assert.deepStrictEqual([sandboxOf(true), sandboxOf(false), sandboxOf(true, theirs)], process.platform === 'win32'
			? [undefined, undefined, { enabled: true, autoAllowBashIfSandboxed: false }]
			: [{ enabled: false }, { enabled: true }, { enabled: true, autoAllowBashIfSandboxed: false }]);
	});

	test('without the agent framework a launch has none of its integration - no connect, warm-up or messages group, no server, skill or file in the folder - and the rest as with it', () => {
		const without = (cli: AgentCli) => {
			const spec = cli.launch(inputFor(cli, { connection: undefined, skills: [] }), '/bin/cli');
			return { args: spec.args.filter(arg => /mcp|plugin|warm|ready|daemon/i.test(arg)), files: spec.files.map(file => path.basename(file.path)), injected: spec.injected.length };
		};

		assert.deepStrictEqual(knownClis().map(without), [
			{ args: [], files: ['7.settings.json'], injected: 0 },
			{ args: [], files: [], injected: 0 },
			{ args: [], files: [], injected: 0 },
			{ args: [], files: [], injected: 0 }
		]);
	});

	test('Codex is given each environment variable of Facade\'s server by its name, in quotes where TOML cannot write it bare', () => {
		const spec = codexCli.launch(inputFor(codexCli, { connection: { ...CONNECTION, mcp: { ...MCP, env: { ELECTRON_RUN_AS_NODE: '1', 'NODE.OPTIONS': '--no-warnings' } } } }), '/bin/codex');

		assert.strictEqual(spec.args.find(arg => arg.startsWith('mcp_servers.facade.env=')), 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1", "NODE.OPTIONS" = "--no-warnings" }');
	});

	test('Muse Code runs in its own UI with YOLO on - no approvals, no sandbox - its launcher\'s update off, trusting its folder for the run alone, at the effort asked for, the task after the options; without a task it starts at its prompt; its server, which finds the agent from its environment, and its skill go into the folder', () => {
		const spec = museCli.launch(inputFor(museCli, { model: 'muse-spark-1.3', effort: 'max', task: '--- Plan\nAdd clamp.' }), '/bin/muse.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, noTask: museCli.launch(inputFor(museCli), '/bin/muse.exe').args }, {
			executable: '/bin/muse.exe',
			args: ['--disable-approval', '--disable-sandbox', '--model', 'muse-spark-1.3', '--reasoning-effort', 'max', '--trust-workspace', '--', '--- Plan\nAdd clamp.'],
			env: { MUSE_NO_AUTO_UPDATE: '1' },
			cwd: '/lab',
			files: [],
			injected: {
				'.mcp.json': { mcpServers: { facade: { command: MCP.command, args: MCP.args, env: { ...MCP.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS}' } } } },
				'.agents/skills/facade/SKILL.md': SKILL_MD
			},
			noTask: ['--disable-approval', '--disable-sandbox', '--model', 'model-x', '--reasoning-effort', 'high', '--trust-workspace']
		});
	});

	test('Muse Code\'s server goes beside the person\'s own in their .mcp.json, laid out as theirs is; a file that is not a JSON object, servers that are not an object, or a server of theirs called facade, takes none', () => {
		const merge = museCli.launch(inputFor(museCli), '/bin/muse.cmd').injected.find(file => file.path === '.mcp.json')?.merge;
		const theirs = `${BOM}{\r\n    "mcpServers": {\r\n        "docs": { "command": "docs-mcp" }\r\n    }\r\n}\r\n`;
		const merged = merge?.(theirs) ?? '';

		assert.deepStrictEqual({
			layout: [merged.startsWith(`${BOM}{\r\n    "mcpServers": {\r\n        "docs": {\r\n            "command": "docs-mcp"\r\n        },\r\n        "facade": {`), merged.endsWith('}\r\n')],
			servers: Object.keys(JSON.parse(merged.slice(1)).mcpServers),
			noServers: Object.keys(JSON.parse(merge?.('{"other":1}') ?? '{}')),
			refused: ['[1]', '{ not json', '{"mcpServers":[]}', '{"mcpServers":{"facade":{"command":"theirs"}}}'].map(file => merge?.(file))
		}, {
			layout: [true, true],
			servers: ['docs', 'facade'],
			noServers: ['other', 'mcpServers'],
			refused: [undefined, undefined, undefined, undefined]
		});
	});

	test('Antigravity runs in its own UI without asking, its background update off, warming up on a first message of its own, on a model\'s base name with the effort that picks its variant; its server and skill go into the folder as one plugin, which every agent there shares', () => {
		const spec = antigravityCli.launch(inputFor(antigravityCli, { model: 'gemini-3.8-flash', effort: 'medium', task: 'Not given here.' }), '/bin/agy.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, task: antigravityCli.task }, {
			executable: '/bin/agy.exe',
			args: ['-i', 'Reply with the single word ready, and nothing else.', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash', '--effort', 'medium'],
			env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
			cwd: '/lab',
			files: [],
			injected: {
				'.agents/plugins/facade/plugin.json': { name: 'facade' },
				'.agents/plugins/facade/mcp_config.json': { mcpServers: { facade: MCP } },
				'.agents/plugins/facade/skills/facade/SKILL.md': SKILL_MD
			},
			task: 'terminal'
		});
	});
});

suite('CLIs: how the person has Facade start each one', () => {

	test('every part of a launch is the person\'s to change, and only what they set changes: a group of arguments replaced, its `${name}`s given their values, one set to null left out; a variable of Facade\'s replaced or, set to null, taken out; Claude Code\'s settings key by key, down through objects - theirs too, so that no null reaches Claude Code', () => {
		const set: { [name: string]: unknown } = {
			launch: {
				arguments: { yoloOn: ['--permission-mode', 'bypassPermissions'], extra: ['--add-dir', '/shared/${model}'], effort: null },
				environment: { DISABLE_AUTOUPDATER: null, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
				settings: { spinnerTipsEnabled: null, theme: 'dark', env: { FOO: null, BAR: '1' } }
			}
		};
		const config = readCliConfig(claudeCli, name => set[name]);
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', task: 'Plan.', config }), '/bin/claude');
		// Settings of Facade's with an object in them, which the person changes a part of.
		const nested: AgentCli = { ...claudeCli, defaults: { path: '', enabled: true, launch: { ...claudeCli.defaults.launch, settings: { permissions: { allow: ['Read'], deny: ['Write'] } } } } };
		const deeper = readCliConfig(nested, name => name === 'launch' ? { settings: { permissions: { deny: null, ask: ['Bash'] } } } : undefined);

		assert.deepStrictEqual({ args: spec.args, env: spec.env, settings: JSON.parse(spec.files[0].content), deeper: deeper.launch.settings }, {
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
				'--settings', path.join('/runs', '7.settings.json'),
				'--disallowedTools', 'AskUserQuestion',
				'--add-dir', '/record/messages',
				'--permission-mode', 'bypassPermissions',
				'--model', 'opus',
				'--add-dir', '/shared/opus',
				'--', 'Plan.'
			],
			env: {
				CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
				CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
				CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
				CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
				CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
			},
			settings: { skipDangerousModePermissionPrompt: true, emojiCompletionEnabled: false, theme: 'dark', env: { BAR: '1' }, ...process.platform === 'win32' ? {} : { sandbox: { enabled: false } } },
			deeper: { permissions: { allow: ['Read'], ask: ['Bash'] } }
		});
	});

	test('on Windows, which takes a variable\'s name in any case, the person\'s variable is Facade\'s whatever its case - set to null it takes Facade\'s out, set to text it replaces it - and elsewhere one of another case is another variable', () => {
		const { environment } = readCliConfig(claudeCli, name => name === 'launch' ? { environment: { disable_autoupdater: null, claude_code_auto_connect_ide: 'true' } } : undefined).launch;
		const seen = { updater: [environment.DISABLE_AUTOUPDATER, environment.disable_autoupdater], ide: [environment.CLAUDE_CODE_AUTO_CONNECT_IDE, environment.claude_code_auto_connect_ide] };

		assert.deepStrictEqual(seen, process.platform === 'win32'
			? { updater: [undefined, undefined], ide: ['true', undefined] }
			: { updater: ['1', undefined], ide: ['false', 'true'] });
	});

	test('a value of the wrong kind, or a key a launch does not have, is wrong, naming the setting - a part or a group the launch has not, arguments that are not a list of text, a variable that is not text, a trust of no kind, a launch, a path or a switch of the wrong kind, a delay that is no whole number of milliseconds up to a minute - and Facade\'s own part only shows in its place; an empty list is the person\'s, those arguments left out; nothing set is the defaults', () => {
		const set = { arguments: { connect: '--no-daemon', quiet: [], model: ['-m', 4], task: null, warmup: ['-x'] }, environment: { CODEX_HOME: 7 }, trust: { arguments: 'x' }, enterDelay: -5, taskDelay: 1e12, sandbox: true };
		const { launch: defaults } = codexCli.defaults;
		const groups = 'warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra, task';

		assert.deepStrictEqual({
			config: readCliConfig(codexCli, name => name === 'launch' ? set : undefined),
			path: readCliConfig(codexCli, name => name === 'path' ? '  /opt/codex/codex  ' : undefined).path,
			notAnObject: readCliConfig(codexCli, name => name === 'launch' ? ['--verbose'] : 7),
			unset: readCliConfig(codexCli, () => undefined)
		}, {
			config: {
				path: '',
				enabled: true,
				launch: { ...defaults, arguments: Object.fromEntries(Object.entries({ ...defaults.arguments, quiet: [] }).filter(([group]) => group !== 'task')) },
				wrong: [
					'facade.agents.codex.launch has sandbox, which Codex\'s launch does not have: it has arguments, environment, trust, enterDelay, taskDelay',
					`facade.agents.codex.launch.arguments has warmup, which is no group of Codex's arguments: it has ${groups}`,
					'facade.agents.codex.launch.arguments.connect is "--no-daemon", which is neither a list of text nor null',
					'facade.agents.codex.launch.arguments.model is ["-m",4], which is neither a list of text nor null',
					'facade.agents.codex.launch.environment.CODEX_HOME is 7, which is neither text nor null',
					'facade.agents.codex.launch.trust.arguments is "x", which is no list of text',
					`facade.agents.codex.launch.enterDelay is -5, which is no whole number of milliseconds from 0 to ${MAX_DELAY_MS}`,
					`facade.agents.codex.launch.taskDelay is 1000000000000, which is no whole number of milliseconds from 0 to ${MAX_DELAY_MS}`
				]
			},
			path: '/opt/codex/codex',
			notAnObject: { ...codexCli.defaults, wrong: ['facade.agents.codex.enabled is 7, which is neither true nor false', 'facade.agents.codex.path is 7, which is no text', 'facade.agents.codex.launch is ["--verbose"], which is no object'] },
			unset: codexCli.defaults
		});
	});

	test('the trust is the person\'s to change: set to null there is none, and the CLI asks; their arguments in place of a file; a file of their own, or an entry of their own, each beside the default\'s other half', () => {
		const trust = (set: unknown) => readCliConfig(claudeCli, name => name === 'launch' ? { trust: set } : undefined).launch.trust;
		const { trust: byDefault } = claudeCli.defaults.launch;

		assert.deepStrictEqual([trust(null), trust({ arguments: ['--trust'] }), trust({ file: ' /elsewhere/claude.json ' }), trust({ merge: { trusted: true } }), trust({ file: 7 })], [
			undefined,
			{ arguments: ['--trust'] },
			{ file: '/elsewhere/claude.json', merge: byDefault?.merge },
			{ file: byDefault?.file, merge: { trusted: true } },
			byDefault
		]);
	});

	test('a `${name}` a launch has no value for - whatever is written between the braces - refuses the launch, naming the setting and the values there are', () => {
		const refused = (launch: unknown) => outcome(() => claudeCli.launch(inputFor(claudeCli, { config: readCliConfig(claudeCli, name => name === 'launch' ? launch : undefined) }), '/bin/claude'));
		const values = 'it has ${folder}, ${repository}, ${home}, ${messagesDir}, ${model}, ${effort}, ${executable}, ${shimFile}, ${pipe}, ${recordDir}, ${tokenFile}, ${waitMs}, ${mcpConfig}, ${settingsFile}, ${pluginDir}.';

		assert.deepStrictEqual([refused({ arguments: { extra: ['--add-dir', '${hostname}'] } }), refused({ arguments: { model: ['--model', '${model_name}'] } })], [
			`facade.agents.claude.launch.arguments.extra has \${hostname}, for which Facade has no value: ${values}`,
			`facade.agents.claude.launch.arguments.model has \${model_name}, for which Facade has no value: ${values}`
		]);
	});

	test('a launch has Facade\'s integration through its connect group - a built-in\'s that the person took out, or a custom agent\'s left out, has none - but for a CLI that reads Facade\'s server from its folder', () => {
		const without = (cli: AgentCli) => capabilitiesOf(cli, readCliConfig(cli, name => name === 'launch' ? { arguments: { connect: null } } : undefined)).integration;
		assert.deepStrictEqual(Object.fromEntries(knownClis().map(cli => [cli.id, [capabilitiesOf(cli, cli.defaults).integration, without(cli)]])), {
			claude: [true, false],
			codex: [true, false],
			agy: [true, true],
			muse: [true, true]
		});
	});

	test('every launch has the same values - where it runs, its repository, the home folder, where its messages are, and what it was given - each CLI\'s own files besides', () => {
		const extra = (cli: AgentCli) => cli.launch(inputFor(cli, { config: readCliConfig(cli, name => name === 'launch' ? { arguments: { extra: ['${folder}', '${repository}', '${home}', '${messagesDir}'] } } : undefined) }), '/bin/cli').args.slice(-4);
		assert.deepStrictEqual(knownClis().map(extra), knownClis().map(() => ['/lab', '/lab', os.homedir(), '/record/messages']));
	});

	test('a time the person sets in seconds is one of a second to an hour, in whole seconds; anything but a number is the default', () => {
		assert.deepStrictEqual([secondsSetting(30, 5000), secondsSetting(0.2, 5000), secondsSetting(1e9, 5000), secondsSetting('30', 5000), secondsSetting(Number.NaN, 5000)], [30_000, 1000, MAX_TIME_S * 1000, 5000, 5000]);
	});

	test('package.json declares the agents\' settings in three groups: Agents - YOLO and the agent framework\'s switch, on by default and shown to everyone, and one timeout, the code\'s, for whoever asks for advanced settings - then each built-in - whether it is offered and where to find it, shown to everyone, and its launch, empty, for whoever asks for advanced settings - then Custom Agents; each on this machine alone; each part of a launch, and each group of its arguments, has Facade\'s own as the default completion fills in, and its description is short and names the command that shows it all; the three commands are under Agents', () => {
		const { sections, commands, texts } = manifest();
		const own = sections.find(each => each.id === 'facade.agents')?.properties ?? {};
		const text = (description: string | undefined) => texts[description?.replace(/^%|%$/g, '') ?? ''] ?? '';
		const seen = knownClis().map(cli => {
			const section = sections.find(each => each.id === cli.setting);
			const declared = (name: string) => section?.properties[`${cli.setting}.${name}`];
			const launch = declared('launch');
			const parts = launch?.properties ?? {};
			return {
				names: Object.keys(section?.properties ?? {}),
				defaults: [declared('enabled')?.default, declared('path')?.default, launch?.default],
				advanced: [declared('enabled')?.tags, declared('path')?.tags, launch?.tags],
				scopes: [declared('enabled')?.scope, declared('path')?.scope, launch?.scope],
				parts: Object.fromEntries(Object.entries(parts).map(([part, schema]) => [part, schema.default])),
				groups: Object.fromEntries(Object.entries(parts.arguments?.properties ?? {}).map(([group, schema]) => [group, schema.default])),
				trustTakesBoth: parts.trust?.dependencies,
				delays: [parts.enterDelay?.maximum, parts.taskDelay?.maximum],
				described: [text(launch?.markdownDescription).includes('**Agents: Show Agent Launch**'), text(launch?.markdownDescription).includes('\n')]
			};
		});
		const custom = sections.find(each => each.id === 'facade.agents.custom')?.properties['facade.agents.custom'];

		assert.deepStrictEqual({
			sections: sections.map(each => each.id),
			own: Object.keys(own),
			switches: [own['facade.agents.yolo']?.default, own['facade.agents.yolo']?.tags, own['facade.orchestration.enabled']?.default, own['facade.orchestration.enabled']?.tags],
			timeout: [own['facade.agents.timeout']?.default, own['facade.agents.timeout']?.maximum, own['facade.agents.timeout']?.tags],
			waits: [START_TIMEOUT_MS, WINDOW_WAIT_MS],
			custom: [custom?.default, custom?.scope],
			commands: commands.map(each => each.command),
			category: texts['command.category'],
			seen
		}, {
			sections: ['facade.agents', 'facade.agents.claude', 'facade.agents.codex', 'facade.agents.antigravity', 'facade.agents.muse', 'facade.agents.custom'],
			own: ['facade.agents.yolo', 'facade.orchestration.enabled', 'facade.agents.timeout'],
			switches: [true, undefined, true, undefined],
			timeout: [START_TIMEOUT_MS / 1000, MAX_TIME_S, ['advanced']],
			waits: [START_TIMEOUT_MS, START_TIMEOUT_MS],
			custom: [{}, 'machine'],
			commands: ['facade.agents.startAgent', 'facade.agents.showLog', 'facade.agents.showLaunch'],
			category: 'Agents',
			seen: knownClis().map(({ setting, task, defaults: { launch } }) => ({
				names: [`${setting}.enabled`, `${setting}.path`, `${setting}.launch`],
				defaults: [true, '', {}],
				advanced: [undefined, undefined, ['advanced']],
				scopes: ['machine', 'machine', 'machine'],
				parts: { arguments: launch.arguments, environment: launch.environment, trust: launch.trust, ...(launch.settings ? { settings: launch.settings } : {}), enterDelay: launch.enterDelay, taskDelay: launch.taskDelay },
				// A CLI told of its task in its terminal takes no task group.
				groups: Object.fromEntries(ARG_GROUPS.filter(group => group !== 'task' || task === 'argument').map(group => [group, launch.arguments[group]])),
				// One given its trust in its arguments has no file of Facade's to complete one of the person's.
				trustTakesBoth: launch.trust?.file === undefined ? { file: ['merge'], merge: ['file'] } : undefined,
				delays: [MAX_DELAY_MS, MAX_DELAY_MS],
				described: [true, false]
			}))
		});
	});

	test('Agents: Show Agent Launch shows the folder it is for, whether YOLO and the agent framework are on, and by each agent\'s setting the program Facade runs - with the script it gives Node for an npm shim, and whether cmd.exe runs it - whether a built-in is offered, how its task\'s notice reaches it, its sandbox with YOLO on and off, whether Facade\'s tools are asked for, the trust it is given and where, what is wrong in the person\'s settings of it, the version last verified, its launch as Facade starts it now - Facade\'s own with the person\'s changes over it - and those changes as the person wrote them', () => {
		const yours = { environment: { DISABLE_AUTOUPDATER: null }, extra: [] };
		const config = readCliConfig(claudeCli, name => name === 'launch' ? yours : undefined);
		const shownWith = (yolo: boolean | { readonly wrong: string }, framework = true) => launchDocument({
			folder: '/lab',
			yolo,
			framework,
			clis: [
				{ cli: claudeCli, config, yours, program: { target: { executable: 'C:/tools/claude.cmd', args: [], throughCmd: true } }, trust: { kind: 'file', file: '/home/.claude.json', merge: { projects: { '/lab': { hasTrustDialogAccepted: true } } } }, overridden: '/home/.claude/settings.json denies mcp__facade' },
				{ cli: codexCli, config: codexCli.defaults, yours: undefined, program: { target: { executable: 'C:/node/node.exe', args: ['C:/npm/codex.js'], throughCmd: false } }, trust: { kind: 'arguments', arguments: ['-c', 'projects={ ${folder} = { trust_level = "trusted" } }'] } },
				{ cli: museCli, config: museCli.defaults, yours: {}, program: { target: { executable: 'C:/muse/muse.exe', args: [], throughCmd: false } }, trust: { kind: 'none' } },
				{ cli: antigravityCli, config: antigravityCli.defaults, yours: undefined, program: { missing: 'agy is not on the PATH a terminal there has' }, trust: { kind: 'cannot', why: 'the file is no absolute path' } }
			]
		});
		const parts = (document: string) => {
			const lines = document.split('\n');
			const comments = lines.filter(line => line.startsWith('// '));
			return { comments, shown: JSON.parse(lines.slice(comments.length).join('\n')) };
		};
		const launch = (of: AgentCli) => JSON.parse(JSON.stringify(of.defaults.launch));
		const on = parts(shownWith(true));

		assert.deepStrictEqual({
			comments: [on.comments.length, on.comments[0].includes('/lab'), on.comments[1].includes('YOLO is on'), parts(shownWith(false)).comments[1].includes('YOLO is off'), parts(shownWith({ wrong: 'facade.agents.yolo is "yes"' })).comments[1].includes('"yes"'), on.comments[2].includes('is on'), parts(shownWith(true, false)).comments[2].includes('is off')],
			shown: on.shown
		}, {
			comments: [6, true, true, true, true, true, true],
			shown: {
				claude: { program: 'C:/tools/claude.cmd', throughCmd: true, offered: true, task: 'argument', sandbox: { yoloOn: 'off', yoloOff: process.platform === 'win32' ? 'unavailable' : 'on' }, facadeTools: 'asked for: /home/.claude/settings.json denies mcp__facade', trust: { file: '/home/.claude.json', merge: { projects: { '/lab': { hasTrustDialogAccepted: true } } }, kept: 'for good: Facade never takes it back' }, wrongSettings: ['facade.agents.claude.launch has extra, which Claude Code\'s launch does not have: it has arguments, environment, trust, settings, enterDelay, taskDelay'], verified: 'not yet', launch: JSON.parse(JSON.stringify(config.launch)), yourChanges: yours },
				codex: { program: 'C:/node/node.exe', script: 'C:/npm/codex.js', offered: true, task: 'argument', sandbox: { yoloOn: 'off', yoloOff: process.platform === 'win32' ? 'unavailable' : 'on' }, facadeTools: 'never asked: its launch lets Facade\'s server through alone', trust: { arguments: ['-c', 'projects={ ${folder} = { trust_level = "trusted" } }'] }, verified: 'not yet', launch: launch(codexCli), yourChanges: {} },
				muse: { program: 'C:/muse/muse.exe', offered: true, task: 'argument', sandbox: { yoloOn: 'off', yoloOff: 'on' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing, its sandbox still on', trust: 'none: the CLI asks whether you trust the folder', verified: 'not yet', launch: launch(museCli), yourChanges: {} },
				antigravity: { program: 'not found: agy is not on the PATH a terminal there has', offered: true, task: 'typed', sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing, its sandbox still on', trust: 'cannot be given: the file is no absolute path', verified: 'not yet', launch: launch(antigravityCli), yourChanges: {} }
			}
		});
	});

	test('a CLI told of its task in its terminal has no task group: one the person sets is wrong, and is never given', () => {
		const config = readCliConfig(antigravityCli, name => name === 'launch' ? { arguments: { task: ['--prompt', '${task}'] } } : undefined);

		assert.deepStrictEqual({ wrong: config.wrong, given: antigravityCli.launch(inputFor(antigravityCli, { config, task: 'Plan.' }), '/bin/agy').args.includes('--prompt') }, {
			wrong: ['facade.agents.antigravity.launch.arguments has task, which is no group of Antigravity\'s arguments: it has warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra'],
			given: false
		});
	});

	test('Codex takes its effort as one TOML string, whatever is in it: a quote or a line break does not end it', () => {
		const effort = (given: string) => {
			const { args } = codexCli.launch(inputFor(codexCli, { effort: given }), '/bin/codex');
			return args[args.indexOf('--model') + 3];
		};

		assert.deepStrictEqual([effort('max'), effort('high" sandbox_mode = "danger'), effort('two\nlines')], [
			'model_reasoning_effort="max"',
			'model_reasoning_effort="high\\" sandbox_mode = \\"danger"',
			'model_reasoning_effort="two\\nlines"'
		]);
	});
});

suite('CLIs: a skill as the CLIs read it', () => {

	test('a skill\'s header gives its name and description as YAML reads them: words as they are, and in quotes what YAML would read otherwise', () => {
		const header = (description: string) => skillMarkdown({ name: 'facade', description, body: 'Body.' }).split('\n')[2];

		assert.deepStrictEqual([
			header('How to work in Facade Code, with your children.'),
			header('Use it when: you start children'),
			header('Yes'),
			header('#1 rule'),
			header('The person\'s own'),
			header('two\nlines')
		], [
			'description: How to work in Facade Code, with your children.',
			'description: "Use it when: you start children"',
			'description: "Yes"',
			'description: "#1 rule"',
			'description: "The person\'s own"',
			'description: "two\\nlines"'
		]);
	});
});

suite('CLIs: the person\'s trust, where a CLI keeps it in a file', () => {

	let temp: { dir: string; remove(): void };
	let locked: string[];
	/** The lock the core hands down: here one process, so none is needed - but each use is counted. */
	const lock: FileLock = (file, fn) => {
		locked.push(file);
		return fn();
	};

	setup(() => {
		temp = tempDir('facade-trust-');
		locked = [];
	});

	teardown(() => {
		temp.remove();
	});

	/** The name Claude Code gives the project of `folder`: its real path, forward slashes, an upper-case drive. */
	function claudeKey(folder: string): string {
		const real = fs.realpathSync.native(folder);
		return process.platform === 'win32' ? real.split(path.sep).join('/').replace(/^[a-z]:/, drive => drive.toUpperCase()) : real;
	}

	/** A home folder of the test's own, as an environment gives it. */
	function homeIn(name: string): { readonly home: string; readonly env: { readonly USERPROFILE: string; readonly HOME: string } } {
		const home = path.join(temp.dir, name);
		return { home, env: { USERPROFILE: home, HOME: home } };
	}

	test('Claude Code\'s trust in a repository is merged into its configuration under the repository\'s root, once, into a file that is not there yet or beside what the file holds, laid out as it is', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const { home, env } = homeIn('home');
		const config = path.join(home, '.claude.json');
		const worktree = { folder: path.join(temp.dir, 'Lab-clamp'), repository };
		const first = [writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env)?.text, writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env)?.text];
		const made = JSON.parse(fs.readFileSync(config, 'utf8'));
		const theirs = `${BOM}{\r\n  "theme": "dark",\r\n  "projects": {\r\n    "C:/Other": {\r\n      "allowedTools": []\r\n    }\r\n  }\r\n}\r\n`;
		fs.writeFileSync(config, theirs);
		const merged = writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env)?.text;
		const after = fs.readFileSync(config, 'utf8');

		const entry = JSON.stringify({ projects: { [claudeKey(repository)]: { hasTrustDialogAccepted: true } } });

		assert.deepStrictEqual({ first, made, merged, after: JSON.parse(after.slice(1)), layout: [after.startsWith(`${BOM}{\r\n  "theme": "dark",\r\n`), after.endsWith('}\r\n')], locked }, {
			first: [`Facade merged ${entry} into ${config}: Claude Code trusts ${worktree.folder} now.`, `${config} has ${entry} already: Claude Code trusted ${worktree.folder} before.`],
			made: { projects: { [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			merged: `Facade merged ${entry} into ${config}: Claude Code trusts ${worktree.folder} now.`,
			after: { theme: 'dark', projects: { 'C:/Other': { allowedTools: [] }, [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			layout: [true, true],
			locked: [config, config, config]
		});
	});

	test('a file that is not a JSON object, or a value in it of another kind than what would be merged there - projects that are not an object, a project that is not one, a list that is not a list - is left alone', () => {
		const file = path.join(temp.dir, 'settings.json');
		const left = (content: string, entry: { readonly [key: string]: unknown }) => {
			fs.writeFileSync(file, content);
			return [mergeIntoJsonFile(file, entry, lock), fs.readFileSync(file, 'utf8') === content];
		};
		const project = { projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } };

		assert.deepStrictEqual([
			left('{ not json', project),
			left('[]', project),
			left('{"projects":[]}', project),
			left('{"projects":{"C:/Lab":true}}', project),
			left('{"trustedWorkspaces": "everything"}', { trustedWorkspaces: ['C:\\Lab'] }),
			left('{"trustedWorkspaces": {"C:\\\\Lab": true}}', { trustedWorkspaces: ['C:\\Lab'] })
		], [['unreadable', true], ['unreadable', true], ['unreadable', true], ['unreadable', true], ['unreadable', true], ['unreadable', true]]);
	});

	test('a null in the file where the entry goes holds nothing, as when its key is not there: the entry is written in its place', () => {
		const file = path.join(temp.dir, 'settings.json');
		const merged = (content: string, entry: { readonly [key: string]: unknown }) => {
			fs.writeFileSync(file, content);
			return [mergeIntoJsonFile(file, entry, lock), JSON.parse(fs.readFileSync(file, 'utf8'))];
		};

		assert.deepStrictEqual([
			merged('{"projects": null}', { projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } }),
			merged('{"trustedWorkspaces": null, "theme": "dark"}', { trustedWorkspaces: ['C:\\Lab'] })
		], [
			['written', { projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } }],
			['written', { trustedWorkspaces: ['C:\\Lab'], theme: 'dark' }]
		]);
	});

	test('the CLI\'s own write that comes between Facade\'s read and its write is kept: the file is read again, and the trust merged into what the CLI wrote', () => {
		const config = path.join(temp.dir, '.claude.json');
		fs.writeFileSync(config, '{\n  "numStartups": 1\n}\n');
		let wrote = false;
		const restore = replaceFsFunction('writeFileSync', original => (file, data, options) => {
			original(file, data, options);
			// As Facade writes its new file, Claude Code writes its configuration, once.
			if (typeof file === 'number' && !wrote) {
				wrote = true;
				original(config, '{\n  "numStartups": 22\n}\n');
			}
		});
		let trust: string;
		try {
			trust = mergeIntoJsonFile(config, { projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } }, lock);
		} finally {
			restore();
		}

		assert.deepStrictEqual({ trust, after: JSON.parse(fs.readFileSync(config, 'utf8')), left: fs.readdirSync(temp.dir).sort() }, {
			trust: 'written',
			after: { numStartups: 22, projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } },
			left: ['.claude.json']
		});
	});

	test('Antigravity\'s trust in a folder is merged into its settings once, by the folder\'s real path, into a file that is not there yet or beside what the file holds, laid out as it is; a folder listed already - in another case, with other slashes, or through a link - is left as it is', () => {
		const worktree = path.join(temp.dir, 'Clamp');
		fs.mkdirSync(worktree);
		const { home, env } = homeIn('home');
		const settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
		const trusted = { folder: worktree, repository: path.join(temp.dir, 'Lab') };
		const entry = JSON.stringify({ trustedWorkspaces: [fs.realpathSync.native(worktree)] });
		const outcomes = [writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text, writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text];
		const first = JSON.parse(fs.readFileSync(settings, 'utf8'));
		const theirs = `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me"\n\t]\n}`;
		fs.writeFileSync(settings, theirs);
		writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;
		const after = fs.readFileSync(settings, 'utf8');
		const other = process.platform === 'win32' ? fs.realpathSync.native(worktree).toUpperCase().split('\\').join('/') : fs.realpathSync.native(worktree);
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [other] }));
		const listed = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;
		// The same folder through a link of its own, as the person may have opened it.
		const link = path.join(temp.dir, 'clamp-link');
		fs.symlinkSync(worktree, link, 'junction');
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [link] }));
		const linked = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;

		assert.deepStrictEqual({ outcomes, first, after, listed, linked, locked: locked.length }, {
			outcomes: [`Facade merged ${entry} into ${settings}: Antigravity trusts ${worktree} now.`, `${settings} has ${entry} already: Antigravity trusted ${worktree} before.`],
			first: { trustedWorkspaces: [fs.realpathSync.native(worktree)] },
			after: `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me",\n\t\t${JSON.stringify(fs.realpathSync.native(worktree))}\n\t]\n}`,
			listed: `${settings} has ${entry} already: Antigravity trusted ${worktree} before.`,
			linked: `${settings} has ${entry} already: Antigravity trusted ${worktree} before.`,
			locked: 5
		});
	});

	test('each CLI keeps its trust where it reads it now: Claude Code in CLAUDE_CONFIG_DIR where it is set, else in the home folder - in its folder\'s .config.json where an older version left one - Antigravity in the home folder; Codex and Muse Code are given theirs in their arguments, and nothing is written; a file that cannot be read is left, and the CLI asks', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const { home, env } = homeIn('home');
		const worktree = { folder: repository, repository };
		const where = (cli: AgentCli, environment: { readonly [name: string]: string }) => trustTarget(cli, cli.defaults, worktree, environment)?.file;
		const said = {
			claude: where(claudeCli, env),
			agy: where(antigravityCli, env),
			codex: writeTrust(codexCli, codexCli.defaults, worktree, lock, env)?.text,
			muse: writeTrust(museCli, museCli.defaults, worktree, lock, env)?.text
		};
		// What an older Claude Code left in its folder: it reads that file still.
		const legacy = path.join(home, '.claude', '.config.json');
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, '{}');
		const older = where(claudeCli, env);
		const moved = { ...env, CLAUDE_CONFIG_DIR: path.join(temp.dir, 'qclaude') };
		const elsewhere = claudeConfigFile(moved);
		// A folder where the file would be: it cannot be read.
		fs.mkdirSync(elsewhere, { recursive: true });

		assert.deepStrictEqual({ ...said, older, elsewhere, unreadable: writeTrust(claudeCli, claudeCli.defaults, worktree, lock, moved)?.text, nothingWritten: fs.readdirSync(home) }, {
			claude: path.join(home, '.claude.json'),
			agy: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
			codex: undefined,
			muse: undefined,
			older: legacy,
			elsewhere: path.join(temp.dir, 'qclaude', '.claude.json'),
			unreadable: `${path.join(temp.dir, 'qclaude', '.claude.json')} could not be read, or is not as Claude Code writes it, so Facade left it alone and cannot give Claude Code the person's trust in ${repository}: put the file right, or set facade.agents.claude.launch.trust to null for Claude Code to ask.`,
			nothingWritten: ['.claude']
		});
	});

	test('a trust the person moved goes where they said, its `${name}`s given their values - `${home}` the home folder - and one with a `${name}` there is no value for is refused, naming the setting; one set to null writes nothing', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const { home, env } = homeIn('home');
		const moved = readCliConfig(antigravityCli, name => name === 'launch' ? { trust: { file: '${home}/agy/trusted.json' } } : undefined);
		const unknown = readCliConfig(antigravityCli, name => name === 'launch' ? { trust: { merge: { '${repo}': true } } } : undefined);
		const none = readCliConfig(antigravityCli, name => name === 'launch' ? { trust: null } : undefined);
		const worktree = { folder: repository, repository };

		assert.deepStrictEqual({
			moved: writeTrust(antigravityCli, moved, worktree, lock, env)?.text,
			content: JSON.parse(fs.readFileSync(path.join(home, 'agy', 'trusted.json'), 'utf8')),
			unknown: outcome(() => writeTrust(antigravityCli, unknown, worktree, lock, env)?.text),
			none: writeTrust(antigravityCli, none, worktree, lock, env)?.text
		}, {
			moved: `Facade merged ${JSON.stringify({ trustedWorkspaces: [fs.realpathSync.native(repository)] })} into ${path.join(home, 'agy', 'trusted.json')}: Antigravity trusts ${repository} now.`,
			content: { trustedWorkspaces: [fs.realpathSync.native(repository)] },
			unknown: 'facade.agents.antigravity.launch.trust.merge has ${repo}, for which Facade has no value: it has ${home}, ${folder}.',
			none: undefined
		});
	});

	test('a trust file the person starts with ~ is in the home folder, as ${home} would be; one that is no absolute path otherwise, which would be written wherever the window runs from, is refused, saying how to write it', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const { home, env } = homeIn('home');
		const file = (set: string) => outcome(() => {
			const config = readCliConfig(antigravityCli, name => name === 'launch' ? { trust: { file: set } } : undefined);
			const target = trustTarget(antigravityCli, config, { folder: repository, repository }, env);
			if (target?.file !== path.join(home, 'agy', 'trusted.json')) {
				throw new Error(`written to ${target?.file}`);
			}
		});

		assert.deepStrictEqual([file('~/agy/trusted.json'), file('agy/trusted.json'), file('~agy/trusted.json')], [
			'done',
			'facade.agents.antigravity.launch.trust.file is "agy/trusted.json", which is no absolute path: start it with ${home}.',
			'facade.agents.antigravity.launch.trust.file is "~agy/trusted.json", which is no absolute path: start it with ${home}.'
		]);
	});
});

suite('CLIs: starting one without cmd.exe reading its arguments', () => {

	/** npm 11's shim for a package's command, as `npm install -g` writes it. */
	const NPM_SHIM = [
		'@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
		'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ''
	].join('\r\n');

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-launcher-');
	});

	teardown(() => {
		temp.remove();
	});

	function write(file: string, content = ''): string {
		const full = path.join(temp.dir, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, { mode: 0o755 });
		return full;
	}

	test('npm\'s shim is run as the script it runs, with the Node beside it or the one on PATH; elsewhere than Windows, and for an .exe, nothing changes', () => {
		const shim = write('npm/codex.cmd', NPM_SHIM);
		const script = write('npm/node_modules/@openai/codex/bin/codex.js');
		const onPath = write('bin/node.exe');
		write('bin/node');
		const env = { PATH: path.join(temp.dir, 'bin'), PATHEXT: '.EXE;.CMD' };
		const fromPath = launchTarget(shim, 'win32', env);
		const beside = write('npm/node.exe');

		assert.deepStrictEqual({
			fromPath,
			beside: launchTarget(shim, 'win32', env),
			elsewhere: launchTarget(shim, 'linux', env),
			exe: launchTarget(onPath, 'win32', env)
		}, {
			fromPath: { executable: onPath, args: [script], throughCmd: false },
			beside: { executable: beside, args: [script], throughCmd: false },
			elsewhere: { executable: shim, args: [], throughCmd: false },
			exe: { executable: onPath, args: [], throughCmd: false }
		});
	});

	test('an older npm shim is followed too; a .cmd that is no npm shim, or whose script is gone, goes through cmd.exe', () => {
		const older = write('old/claude.cmd', '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n');
		const script = write('old/node_modules/@anthropic-ai/claude-code/cli.js');
		const node = write('old/node.exe');
		const other = write('muse/muse.cmd', '@echo off\r\npowershell -NoProfile -File "%~dp0muse.ps1" %*\r\n');
		const gone = write('gone/codex.cmd', NPM_SHIM);
		const env = { PATH: '', PATHEXT: '.EXE;.CMD' };

		assert.deepStrictEqual([launchTarget(older, 'win32', env), launchTarget(other, 'win32', env), launchTarget(gone, 'win32', env)], [
			{ executable: node, args: [script], throughCmd: false },
			{ executable: other, args: [], throughCmd: true },
			{ executable: gone, args: [], throughCmd: true }
		]);
	});

	test('on Windows, a task reaches a CLI npm installed under a Chinese name exactly as it was given - &, %PATH%, quotes, line breaks, Chinese - its script run with Node, not through cmd.exe', function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const home = String.fromCharCode(0x5f20, 0x4e09);
		const shim = write(path.join(home, 'npm', 'codex.cmd'), NPM_SHIM);
		write(path.join(home, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
		const target = launchTarget(shim, 'win32', { PATH: path.dirname(process.execPath), PATHEXT: '.EXE;.CMD' });
		const task = `Add a parser & its tests; print %PATH%, "quoted", 'single'\nsecond line\r\nthird ${String.fromCharCode(0x4e2d, 0x6587)} ^ | < > ! ( )`;
		const given = ['--model', 'gpt-6-sol', '--', task];
		const run = spawnSync(target.executable, [...target.args, ...given], { encoding: 'utf8' });

		assert.deepStrictEqual({ throughCmd: target.throughCmd, received: JSON.parse(run.stdout) }, { throughCmd: false, received: given });
	});

	test('npm\'s shim with no Node beside it, and none on PATH or only a version manager\'s .cmd there, goes through cmd.exe, as a .cmd of its own does', () => {
		const shim = write('lone/codex.cmd', NPM_SHIM);
		write('lone/node_modules/@openai/codex/bin/codex.js');
		write('manager/node.cmd', '@"%~dp0v24\\node.exe" %*\r\n');

		assert.deepStrictEqual([
			launchTarget(shim, 'win32', { PATH: path.join(temp.dir, 'nothing-here'), PATHEXT: '.EXE;.CMD' }),
			launchTarget(shim, 'win32', { PATH: path.join(temp.dir, 'manager'), PATHEXT: '.EXE;.CMD' })
		], [{ executable: shim, args: [], throughCmd: true }, { executable: shim, args: [], throughCmd: true }]);
	});

	test('a shim that runs its script with another program, or with options of its own, goes through cmd.exe: Node alone would not run it as it should', () => {
		const bun = NPM_SHIM.replace('SET "_prog=%dp0%\\node.exe"', 'SET "_prog=%dp0%\\bun.exe"').replace('SET "_prog=node"', 'SET "_prog=bun"');
		const flagged = NPM_SHIM.replace('"%_prog%"  "%dp0%', '"%_prog%"  --experimental-vm-modules "%dp0%');
		const shims = [write('bun/codex.cmd', bun), write('flagged/codex.cmd', flagged)];
		write('bun/node_modules/@openai/codex/bin/codex.js');
		write('flagged/node_modules/@openai/codex/bin/codex.js');
		write('bin/node.exe');
		const env = { PATH: path.join(temp.dir, 'bin'), PATHEXT: '.EXE;.CMD' };

		assert.deepStrictEqual(shims.map(shim => launchTarget(shim, 'win32', env)), shims.map(shim => ({ executable: shim, args: [], throughCmd: true })));
	});

	test('what cmd.exe reads as its own, or which ends an argument there, cannot go through it', () => {
		const chinese = String.fromCharCode(0x5f20, 0x4e09);
		const safe = ['sonnet', '--model', 'C:\\Users\\Zhang San\\.facade\\runs\\7.json', `C:\\Users\\${chinese}\\x.json`];
		const unsafe = ['Say "hi"', '100%', 'build & test', 'a|b', 'x>y', 'one\ntwo', 'one\rtwo', '^', 'Hi!', '(x)'];

		assert.deepStrictEqual({ safe: safe.map(unsafeForCmd), unsafe: unsafe.map(unsafeForCmd) }, { safe: safe.map(() => false), unsafe: unsafe.map(() => true) });
	});
});

suite('CLIs: which of them this machine has', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-path-');
	});

	teardown(() => {
		temp.remove();
	});

	/** An executable file of `name` in a folder of the test's own. */
	function executable(folder: string, name: string): string {
		const file = path.join(temp.dir, folder, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
		fs.chmodSync(file, 0o755);
		return file;
	}

	test('the CLIs Facade starts are those it knows that PATH has, each where PATH first has it', () => {
		const first = executable('first', 'claude');
		executable('second', 'claude');
		const agy = executable('second', 'agy');
		const env = { PATH: [path.join(temp.dir, 'first'), path.join(temp.dir, 'second')].join(path.delimiter), PATHEXT: '.EXE' };

		assert.deepStrictEqual({
			known: knownClis().map(cli => cli.id),
			installed: installedClis(cli => cli.defaults, env).map(each => [each.cli.id, each.executable]),
			none: installedClis(cli => cli.defaults, { PATH: '' })
		}, {
			known: ['claude', 'codex', 'agy', 'muse'],
			installed: [['claude', first], ['agy', agy]],
			none: []
		});
	});

	test('the CLI Facade starts is the file its path setting names, or the command named there that PATH has; one with none there is not offered', () => {
		const own = executable('own', 'claude-nightly');
		const other = executable('bin', 'codex2');
		const env = { PATH: path.join(temp.dir, 'bin'), PATHEXT: '.EXE' };
		const paths: { [cli: string]: string } = { claude: own, codex: 'codex2', agy: path.join(temp.dir, 'gone', 'agy') };
		const installed = installedClis(cli => readCliConfig(cli, name => name === 'path' ? paths[cli.id] : undefined), env);

		assert.deepStrictEqual(installed.map(each => [each.cli.id, each.executable, each.config.path]), [['claude', own, own], ['codex', other, 'codex2']]);
	});

	test('a command is found on PATH - a folder in quotes too - or by its own path; a folder of its name is not it', () => {
		const tool = executable('bin', 'tool');
		fs.mkdirSync(path.join(temp.dir, 'dir', `tool${process.platform === 'win32' ? '.exe' : ''}`), { recursive: true });
		const env = { PATH: [path.join(temp.dir, 'dir'), `"${path.join(temp.dir, 'bin')}"`].join(path.delimiter), PATHEXT: '.EXE' };

		assert.deepStrictEqual([which('tool', env), which(tool, {}), which('missing', env), which('tool', {}), which('tool', { Path: path.join(temp.dir, 'bin'), PATHEXT: '.EXE' })], [tool, tool, undefined, undefined, tool]);
	});

	test('the home folder a CLI keeps the person\'s settings in is the one the operating system says, where the environment names none', () => {
		const folder = path.join(temp.dir, 'Lab');
		fs.mkdirSync(folder);

		assert.strictEqual(trustTarget(antigravityCli, antigravityCli.defaults, { folder, repository: folder }, {})?.file, path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'));
	});
});
