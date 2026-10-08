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
import { AgentCli, ARG_GROUPS, LaunchInput, skillMarkdown } from '../clis/cli';
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

/** What a launch of `cli` is given, as the core gives it for #7: its defaults, where a test sets nothing else. */
function inputFor(cli: AgentCli, overrides: Partial<LaunchInput> = {}): LaunchInput {
	return { folder: '/lab', trusted: false, model: 'model-x', effort: 'high', mcp: MCP, skills: [SKILL], config: cli.defaults, runDir: '/runs', messagesDir: '/record/messages', slug: '7', ...overrides };
}

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

	test('Claude Code runs in its own UI at full access, its warning about it off, with Facade\'s server alone and the person\'s own settings, the switches that would stop it at a question with nobody there off - in its environment, where one is, else in its settings - let read the message files, its skill from the run, on the model and at the effort asked for, its first line after the options; without one it starts at its input box; it has no tool for asking with buttons', () => {
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', effort: 'xhigh', prompt: '--- Plan\nAdd clamp.' }), '/bin/claude');
		const file = (name: string) => JSON.parse(spec.files.find(each => path.basename(each.path) === name)?.content ?? 'null');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files.map(each => each.path), config: file('7.mcp.json'), settings: file('7.settings.json'), plugin: file('plugin.json'), skill: spec.files[3]?.content, injected: spec.injected, noTask: claudeCli.launch(inputFor(claudeCli), '/bin/claude').args.includes('--') }, {
			executable: '/bin/claude',
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--strict-mcp-config',
				'--settings', path.join('/runs', '7.settings.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
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
				path.join('/runs', '7.mcp.json'),
				path.join('/runs', '7.settings.json'),
				path.join('/runs', '7.plugin', '.claude-plugin', 'plugin.json'),
				path.join('/runs', '7.plugin', 'skills', 'facade', 'SKILL.md')
			],
			config: { mcpServers: { facade: { type: 'stdio', ...MCP } } },
			settings: { skipDangerousModePermissionPrompt: true, spinnerTipsEnabled: false, emojiCompletionEnabled: false },
			plugin: { name: 'facade', version: '1.0.0', description: 'How to work in Facade Code with your children and the person.', author: { name: 'Facade Code' } },
			skill: SKILL_MD,
			injected: [],
			noTask: false
		});
	});

	test('Codex runs in its own UI at full access, with Facade\'s server and the switches that would stop it at a question as -c overrides, the project\'s hooks unreviewed, in a process of its own, at the effort asked for; its skill goes into the folder', () => {
		const spec = codexCli.launch(inputFor(codexCli, { model: 'gpt-6-luna', effort: 'max', prompt: '--- Plan' }), '/bin/codex');

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
				'--', '--- Plan'
			],
			env: {},
			cwd: '/lab',
			files: [],
			injected: [{ path: '.agents/skills/facade/SKILL.md', content: SKILL_MD }],
			noTask: false
		});
	});

	test('in a worktree Facade made, Codex is told for that launch alone to trust it, after its server, by its real path - only its ASCII letters in lower case on Windows, as Codex keys it - as a table whose key keeps the dots of the path; elsewhere it is not', () => {
		const temp = tempDir('facade-codex-');
		try {
			const worktree = path.join(temp.dir, 'Lab.V2-Ä');
			fs.mkdirSync(worktree);
			const args = (trusted: boolean) => codexCli.launch(inputFor(codexCli, { folder: worktree, trusted }), '/bin/codex').args;
			const key = process.platform === 'win32' ? worktree.replace(/[A-Z]/g, letter => letter.toLowerCase()) : worktree;
			const trusted = args(true);

			assert.deepStrictEqual({ trust: trusted.slice(trusted.indexOf('--no-daemon') + 1, trusted.indexOf('--no-daemon') + 3), untrusted: args(false).filter(arg => arg.startsWith('projects=')) }, {
				trust: ['-c', `projects={ ${JSON.stringify(key)} = { trust_level = "trusted" } }`],
				untrusted: []
			});
		} finally {
			temp.remove();
		}
	});

	test('Codex is given each environment variable of Facade\'s server by its name, in quotes where TOML cannot write it bare', () => {
		const spec = codexCli.launch(inputFor(codexCli, { mcp: { ...MCP, env: { ELECTRON_RUN_AS_NODE: '1', 'NODE.OPTIONS': '--no-warnings' } } }), '/bin/codex');

		assert.strictEqual(spec.args.find(arg => arg.startsWith('mcp_servers.facade.env=')), 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1", "NODE.OPTIONS" = "--no-warnings" }');
	});

	test('Muse Code runs in its own UI at full access - no approvals, no sandbox - its launcher\'s update off, trusting a worktree Facade made for the run alone, at the effort asked for, its first line its prompt argument; its server, which finds the agent from its environment, and its skill go into the folder', () => {
		const spec = museCli.launch(inputFor(museCli, { trusted: true, model: 'muse-spark-1.3', effort: 'max' }), '/bin/muse.cmd');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));
		const firstLine = '[facade] You are @lint #a7, created by @you. Your task is #m12. Call read_messages, read the task, then carry it out.';

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, untrusted: museCli.launch(inputFor(museCli), '/bin/muse.cmd').args, withTask: museCli.launch(inputFor(museCli, { prompt: firstLine }), '/bin/muse.cmd').args.slice(-2) }, {
			executable: '/bin/muse.cmd',
			args: ['--trust-workspace', '--disable-approval', '--disable-sandbox', '--model', 'muse-spark-1.3', '--reasoning-effort', 'max'],
			env: { MUSE_NO_AUTO_UPDATE: '1' },
			cwd: '/lab',
			files: [],
			injected: {
				'.mcp.json': { mcpServers: { facade: { command: MCP.command, args: MCP.args, env: { ...MCP.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS}' } } } },
				'.agents/skills/facade/SKILL.md': SKILL_MD
			},
			untrusted: ['--disable-approval', '--disable-sandbox', '--model', 'model-x', '--reasoning-effort', 'high'],
			withTask: ['high', firstLine]
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

	test('Antigravity runs in its own UI without asking, its background update off, warming up on a first message of its own, the folder of long messages in its workspace, on a model\'s base name with the effort that picks its variant; its server and skill go into the folder as one plugin, which every agent there shares', () => {
		const spec = antigravityCli.launch(inputFor(antigravityCli, { model: 'gemini-3.8-flash', effort: 'medium', prompt: 'Not given here.' }), '/bin/agy.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, task: antigravityCli.task }, {
			executable: '/bin/agy.exe',
			args: ['-i', 'Reply with the single word ready, and nothing else.', '--add-dir', '/record/messages', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash', '--effort', 'medium'],
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
				arguments: { fullAccess: ['--permission-mode', 'bypassPermissions'], extra: ['--add-dir', '/shared/${model}'], effort: null },
				environment: { DISABLE_AUTOUPDATER: null, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
				settings: { spinnerTipsEnabled: null, theme: 'dark', env: { FOO: null, BAR: '1' } }
			}
		};
		const config = readCliConfig(claudeCli, name => set[name]);
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', prompt: 'Plan.', config }), '/bin/claude');
		// Settings of Facade's with an object in them, which the person changes a part of.
		const nested: AgentCli = { ...claudeCli, defaults: { path: '', launch: { ...claudeCli.defaults.launch, settings: { permissions: { allow: ['Read'], deny: ['Write'] } } } } };
		const deeper = readCliConfig(nested, name => name === 'launch' ? { settings: { permissions: { deny: null, ask: ['Bash'] } } } : undefined);

		assert.deepStrictEqual({ args: spec.args, env: spec.env, settings: JSON.parse(spec.files[1].content), deeper: deeper.launch.settings }, {
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--strict-mcp-config',
				'--settings', path.join('/runs', '7.settings.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
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
			settings: { skipDangerousModePermissionPrompt: true, emojiCompletionEnabled: false, theme: 'dark', env: { BAR: '1' } },
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

	test('a part of the launch that holds no value of its kind is the default\'s - arguments that are not a list of strings, a variable that is not text, a delay below zero, a trust of no kind - an empty list is the person\'s, those arguments left out, and a delay is a minute at most; a launch that is no object, or none, is the defaults', () => {
		const set = { arguments: { connect: '--no-daemon', quiet: [], model: ['-m', 4] }, environment: { CODEX_HOME: 7 }, trust: { arguments: 'x' }, enterDelay: -5, taskDelay: 1e12 };
		const { launch: defaults } = codexCli.defaults;

		assert.deepStrictEqual({
			config: readCliConfig(codexCli, name => name === 'launch' ? set : undefined),
			path: readCliConfig(codexCli, name => name === 'path' ? '  /opt/codex/codex  ' : 7).path,
			notAnObject: readCliConfig(codexCli, name => name === 'launch' ? ['--verbose'] : undefined),
			unset: readCliConfig(codexCli, () => undefined)
		}, {
			config: { path: '', launch: { ...defaults, arguments: { ...defaults.arguments, quiet: [] }, taskDelay: MAX_DELAY_MS } },
			path: '/opt/codex/codex',
			notAnObject: codexCli.defaults,
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
		const values = 'it has ${mcpConfig}, ${settingsFile}, ${pluginDir}, ${messagesDir}, ${model}, ${effort}, ${task}.';

		assert.deepStrictEqual([refused({ arguments: { extra: ['--add-dir', '${home}'] } }), refused({ arguments: { model: ['--model', '${model_name}'] } })], [
			`facade.orchestration.claude.launch.arguments.extra has \${home}, for which Facade has no value: ${values}`,
			`facade.orchestration.claude.launch.arguments.model has \${model_name}, for which Facade has no value: ${values}`
		]);
	});

	test('a time the person sets in seconds is one of a second to a day; anything but a number is the default', () => {
		assert.deepStrictEqual([secondsSetting(30, 5000), secondsSetting(0.2, 5000), secondsSetting(1e9, 5000), secondsSetting('30', 5000), secondsSetting(Number.NaN, 5000)], [30_000, 1000, MAX_TIME_S * 1000, 5000, 5000]);
	});

	test('package.json declares Facade\'s own settings - on by default, and one timeout, the code\'s, for whoever asks for advanced settings - and for each CLI where to find it, shown to everyone, and its launch, empty, for whoever asks for advanced settings, each on this machine alone; each part of a launch, and each group of its arguments, has Facade\'s own as the default completion fills in, and its description is short and names the command that shows it all', () => {
		const { sections, commands, texts } = manifest();
		const own = sections.find(each => each.id === 'facade.orchestration')?.properties ?? {};
		const text = (description: string | undefined) => texts[description?.replace(/^%|%$/g, '') ?? ''] ?? '';
		const seen = knownClis().map(cli => {
			const section = sections.find(each => each.id === `facade.orchestration.${cli.section}`);
			const declared = (name: string) => section?.properties[`facade.orchestration.${cli.section}.${name}`];
			const launch = declared('launch');
			const parts = launch?.properties ?? {};
			return {
				names: Object.keys(section?.properties ?? {}),
				defaults: [declared('path')?.default, launch?.default],
				advanced: [declared('path')?.tags, launch?.tags],
				scopes: [declared('path')?.scope, launch?.scope],
				parts: Object.fromEntries(Object.entries(parts).map(([part, schema]) => [part, schema.default])),
				groups: Object.fromEntries(Object.entries(parts.arguments?.properties ?? {}).map(([group, schema]) => [group, schema.default])),
				trustTakesBoth: parts.trust?.dependencies,
				delays: [parts.enterDelay?.maximum, parts.taskDelay?.maximum],
				described: [text(launch?.markdownDescription).includes('**Facade: Show Agent Launch**'), text(launch?.markdownDescription).includes('\n')]
			};
		});

		assert.deepStrictEqual({
			own: Object.keys(own),
			enabled: own['facade.orchestration.enabled']?.default,
			timeout: [own['facade.orchestration.timeout']?.default, own['facade.orchestration.timeout']?.maximum, own['facade.orchestration.timeout']?.tags],
			waits: [START_TIMEOUT_MS, WINDOW_WAIT_MS],
			shows: commands.some(each => each.command === 'facade.agents.showLaunch') && texts['command.showLaunch'],
			seen
		}, {
			own: ['facade.orchestration.enabled', 'facade.orchestration.timeout'],
			enabled: true,
			timeout: [START_TIMEOUT_MS / 1000, MAX_TIME_S, ['advanced']],
			waits: [START_TIMEOUT_MS, START_TIMEOUT_MS],
			shows: 'Show Agent Launch',
			seen: knownClis().map(({ section, task, defaults: { launch } }) => ({
				names: [`facade.orchestration.${section}.path`, `facade.orchestration.${section}.launch`],
				defaults: ['', {}],
				advanced: [undefined, ['advanced']],
				scopes: ['machine', 'machine'],
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

	test('no setting of the extension sits under one of the workbench\'s, whose value would hide it: the agent button\'s list, facade.agents, has none under it', () => {
		const workbench = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'vs', 'workbench', 'contrib', 'terminalLaunchers', 'common', 'terminalLaunchers.ts'), 'utf8');
		const list = /AGENTS_SETTING = '(?<key>[^']+)'/.exec(workbench)?.groups?.key ?? '';
		const keys = manifest().sections.flatMap(section => Object.keys(section.properties));

		assert.deepStrictEqual({ list, under: keys.filter(key => key === list || key.startsWith(`${list}.`)) }, { list: 'facade.agents', under: [] });
	});

	test('Facade: Show Agent Launch shows, by each CLI\'s section, the program Facade runs - with the script it gives Node for an npm shim, and whether cmd.exe runs it - how an agent\'s first line reaches it, its launch as Facade starts it now - Facade\'s own with the person\'s changes over it - and those changes as the person wrote them', () => {
		const yours = { environment: { DISABLE_AUTOUPDATER: null } };
		const config = readCliConfig(claudeCli, name => name === 'launch' ? yours : undefined);
		const document = launchDocument([
			// One that cmd.exe runs takes its first line as its argument too: Facade's own text, which cmd.exe reads nothing in.
			{ cli: claudeCli, config, yours, program: { target: { executable: 'C:/tools/claude.cmd', args: [], throughCmd: true } } },
			{ cli: codexCli, config: codexCli.defaults, yours: undefined, program: { target: { executable: 'C:/node/node.exe', args: ['C:/npm/codex.js'], throughCmd: false } } },
			{ cli: museCli, config: museCli.defaults, yours: {}, program: { target: { executable: 'C:/muse/muse.exe', args: [], throughCmd: false } } },
			{ cli: antigravityCli, config: antigravityCli.defaults, yours: undefined, program: { missing: 'agy is not on this machine\'s PATH' } }
		]);
		const [first, second, ...json] = document.split('\n');
		const launch = (of: AgentCli) => JSON.parse(JSON.stringify(of.defaults.launch));

		assert.deepStrictEqual({ comments: [first.startsWith('// '), second.startsWith('// ')], shown: JSON.parse(json.join('\n')), autoupdater: config.launch.environment.DISABLE_AUTOUPDATER }, {
			comments: [true, true],
			shown: {
				claude: { program: 'C:/tools/claude.cmd', throughCmd: true, task: 'argument', launch: JSON.parse(JSON.stringify(config.launch)), yourChanges: yours },
				codex: { program: 'C:/node/node.exe', script: 'C:/npm/codex.js', task: 'argument', launch: launch(codexCli), yourChanges: {} },
				muse: { program: 'C:/muse/muse.exe', task: 'argument', launch: launch(museCli), yourChanges: {} },
				antigravity: { program: 'not on this machine: agy is not on this machine\'s PATH', launch: launch(antigravityCli), yourChanges: {} }
			},
			autoupdater: undefined
		});
	});

	test('a CLI told of its task in its terminal is given no task group, even one the person set', () => {
		const set = (cli: AgentCli) => readCliConfig(cli, name => name === 'launch' ? { arguments: { task: ['--prompt', '${model}'] } } : undefined);

		assert.deepStrictEqual([museCli, antigravityCli].map(cli => cli.launch(inputFor(cli, { config: set(cli) }), '/bin/cli').args.includes('--prompt')), [false, false]);
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
		const first = [writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env), writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env)];
		const made = JSON.parse(fs.readFileSync(config, 'utf8'));
		const theirs = `${BOM}{\r\n  "theme": "dark",\r\n  "projects": {\r\n    "C:/Other": {\r\n      "allowedTools": []\r\n    }\r\n  }\r\n}\r\n`;
		fs.writeFileSync(config, theirs);
		const merged = writeTrust(claudeCli, claudeCli.defaults, worktree, lock, env);
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
		const outcomes = [writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env), writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)];
		const first = JSON.parse(fs.readFileSync(settings, 'utf8'));
		const theirs = `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me"\n\t]\n}`;
		fs.writeFileSync(settings, theirs);
		writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env);
		const after = fs.readFileSync(settings, 'utf8');
		const other = process.platform === 'win32' ? fs.realpathSync.native(worktree).toUpperCase().split('\\').join('/') : fs.realpathSync.native(worktree);
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [other] }));
		const listed = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env);
		// The same folder through a link of its own, as the person may have opened it.
		const link = path.join(temp.dir, 'clamp-link');
		fs.symlinkSync(worktree, link, 'junction');
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [link] }));
		const linked = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env);

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
			codex: writeTrust(codexCli, codexCli.defaults, worktree, lock, env),
			muse: writeTrust(museCli, museCli.defaults, worktree, lock, env)
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

		assert.deepStrictEqual({ ...said, older, elsewhere, unreadable: writeTrust(claudeCli, claudeCli.defaults, worktree, lock, moved), nothingWritten: fs.readdirSync(home) }, {
			claude: path.join(home, '.claude.json'),
			agy: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
			codex: undefined,
			muse: undefined,
			older: legacy,
			elsewhere: path.join(temp.dir, 'qclaude', '.claude.json'),
			unreadable: `${path.join(temp.dir, 'qclaude', '.claude.json')} could not be read, or is not as Claude Code writes it, and was left alone: Claude Code will ask whether to trust ${repository}.`,
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
			moved: writeTrust(antigravityCli, moved, worktree, lock, env),
			content: JSON.parse(fs.readFileSync(path.join(home, 'agy', 'trusted.json'), 'utf8')),
			unknown: outcome(() => writeTrust(antigravityCli, unknown, worktree, lock, env)),
			none: writeTrust(antigravityCli, none, worktree, lock, env)
		}, {
			moved: `Facade merged ${JSON.stringify({ trustedWorkspaces: [fs.realpathSync.native(repository)] })} into ${path.join(home, 'agy', 'trusted.json')}: Antigravity trusts ${repository} now.`,
			content: { trustedWorkspaces: [fs.realpathSync.native(repository)] },
			unknown: 'facade.orchestration.antigravity.launch.trust.merge has ${repo}, for which Facade has no value: it has ${home}, ${folder}.',
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
			'facade.orchestration.antigravity.launch.trust.file is "agy/trusted.json", which is no absolute path: start it with ${home}.',
			'facade.orchestration.antigravity.launch.trust.file is "~agy/trusted.json", which is no absolute path: start it with ${home}.'
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
