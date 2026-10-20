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
import { canonicalFolder } from '../base/files';
import { FileLock } from '../base/lock';
import { antigravityCli } from '../clis/antigravity';
import { claudeCli, claudeConfigFile, claudeDenyOf } from '../clis/claude';
import { AgentCli, ARG_GROUPS, capabilitiesOf, connectionFor, effectiveSandbox, LaunchInput, launchFor, LaunchSpec, sandboxOf, skillMarkdown } from '../clis/cli';
import { codexCli } from '../clis/codex';
import { MAX_DELAY_MS, MAX_TIME_S, readCliConfig, readSeconds } from '../clis/config';
import { customAgentOf } from '../clis/custom';
import { launchDocument, starterFacts } from '../clis/describe';
import { HOME_VARIABLE, launchTarget, launchTargetOf, unsafeForCmd, which } from '../clis/executable';
import { museCli } from '../clis/muse';
import { qwenCli } from '../clis/qwen';
import { installedClis, knownClis, locateCli, turnedOffClis } from '../clis/registry';
import { mergeIntoJsonFile, trustProblem, trustTarget, writeTrust } from '../clis/trust';
import { firstLineFor } from '../contract/prompts';
import { customAgentNameProblem, START_TIMEOUT_MS } from '../core/launch';
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
	/** What the names of an object's properties must be: a pattern, names they must not be, and what settings.json says otherwise. */
	readonly propertyNames?: { readonly pattern?: string; readonly not?: { readonly enum?: readonly string[] }; readonly errorMessage?: string };
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

/** An agent's opening, as its launcher gives #7, started through start_agent by #1: its first line without a task. */
const OPENING = firstLineFor({ id: 7, name: 'lint' }, { id: 1, name: 'lead' }, undefined);

/**
 * What a launch of `cli` is given, as the core gives it for #7: its defaults - the launch of its starter, the person
 * where a test says no other (`launchFor`) - YOLO on, with the agent framework, where a test sets nothing else.
 */
function inputFor(cli: AgentCli, overrides: Partial<LaunchInput> = {}): LaunchInput {
	const unattended = overrides.unattended ?? false;
	// Started through start_agent, it has its opening, as the launcher gives it (L9)
	return { folder: '/lab', repository: '/lab', messagesDir: '/record/messages', screensDir: '/record/screens', yolo: true, model: 'model-x', effort: 'high', connection: CONNECTION, skills: [SKILL], runDir: '/runs', slug: '7', ...(unattended ? { opening: OPENING } : {}), ...overrides, unattended, config: launchFor(overrides.config ?? cli.defaults, unattended) };
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

	test('Claude Code runs in its own UI with YOLO on - nothing asked, its sandbox off, its warning about it off - with Facade\'s server beside the person\'s own servers and settings - not the folder\'s .mcp.json entry of Facade\'s own, there for another CLI\'s agent (N-69) - its skill from the run, on the model and at the effort asked for, the task\'s notice after the options. Started through start_agent, its question tool is taken away and what would stop it at a question nobody asked for is off - in its environment, where one is, else in its settings; the person\'s own, from the window, starts at its input box as it usually does (L4)', () => {
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', effort: 'xhigh', task: '--- Plan\nAdd clamp.', unattended: true }), '/bin/claude');
		const persons = claudeCli.launch(inputFor(claudeCli, { model: undefined, effort: undefined }), '/bin/claude');
		const file = (of: LaunchSpec, name: string) => JSON.parse(of.files.find(each => path.basename(each.path) === name)?.content ?? 'null');
		const sandboxOff = process.platform === 'win32' ? {} : { sandbox: { enabled: false } };

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files.map(each => each.path), config: file(spec, '7.mcp.json'), settings: file(spec, '7.settings.json'), plugin: file(spec, 'plugin.json'), skill: spec.files[3]?.content, injected: spec.injected, persons: { args: persons.args, env: persons.env, settings: file(persons, '7.settings.json') } }, {
			executable: '/bin/claude',
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
				'--settings', path.join('/runs', '7.settings.json'),
				'--disallowedTools', 'AskUserQuestion',
				'--add-dir', '/record/messages', '/record/screens',
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
			settings: { disabledMcpjsonServers: ['facade'], spinnerTipsEnabled: false, emojiCompletionEnabled: false, skipDangerousModePermissionPrompt: true, ...sandboxOff },
			plugin: { name: 'facade', version: '1.0.0', description: 'Coordinate agents and communicate with the person in Facade Code.', author: { name: 'Facade Code' } },
			skill: SKILL_MD,
			injected: [],
			persons: {
				args: [
					'--mcp-config', path.join('/runs', '7.mcp.json'),
					'--plugin-dir', path.join('/runs', '7.plugin'),
					'--settings', path.join('/runs', '7.settings.json'),
					'--add-dir', '/record/messages', '/record/screens',
					'--dangerously-skip-permissions'
				],
				env: {},
				settings: { disabledMcpjsonServers: ['facade'], skipDangerousModePermissionPrompt: true, ...sandboxOff }
			}
		});
	});

	test('Codex runs in its own UI with YOLO on - no approvals, no sandbox - with Facade\'s server, its tools approved, and the person\'s trust in its folder as -c overrides, in a process of its own, at the effort asked for; its skill goes into the folder. Started through start_agent, what would update it or show it tips and nudges is off, its question tool is not offered outside plan mode, and the project\'s hooks run unreviewed, trusted for the run; the person\'s own, from the window, starts at its prompt as it usually does, the project\'s hooks theirs to review (L4, rule 3)', () => {
		const spec = codexCli.launch(inputFor(codexCli, { model: 'gpt-6-luna', effort: 'max', task: '--- Plan', unattended: true }), '/bin/codex');
		const connect = [
			'-c', 'mcp_servers.facade.command="/facade/facade"',
			'-c', 'mcp_servers.facade.args=["/facade/shim.js", "mcp", "--pipe", "pipe", "--token-file", "/runs/7.token"]',
			'-c', 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1" }',
			'-c', 'mcp_servers.facade.startup_timeout_sec=30',
			'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
			'-c', 'mcp_servers.facade.required=true',
			'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
			'--no-daemon'
		];

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected: spec.injected, persons: codexCli.launch(inputFor(codexCli, { model: undefined, effort: undefined }), '/bin/codex').args }, {
			executable: '/bin/codex',
			args: [
				...connect,
				'-c', 'check_for_update_on_startup=false',
				'-c', 'tui.show_tooltips=false',
				'-c', 'notice.hide_rate_limit_model_nudge=true',
				'-c', 'features.default_mode_request_user_input=false',
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
			persons: [
				...connect,
				'--dangerously-bypass-approvals-and-sandbox',
				'-c', `projects={ ${LAB_KEY} = { trust_level = "trusted" } }`
			]
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

	test('with YOLO off, each CLI is started with its yoloOff arguments in place of its yoloOn - the person\'s own where they set them - and with everything else as it was. The person\'s own agent: Claude Code and Codex are given their sandbox and Facade\'s server let through alone, and nothing more - what else asks, and when, is theirs, in the mode and the approval policy they set. Through start_agent what would ask is refused unasked - Claude Code\'s edits in its folder let through - and Codex runs no hook; the person\'s groups for their own agents do not reach it, its unattended part\'s in their place. Muse Code keeps its sandbox and asks for nothing, and Antigravity, with no sandbox, asks for nothing - its edits accepted as with YOLO on - whoever started them (L4; X-42)', () => {
		const theirs = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { yoloOn: ['--yolo'], yoloOff: ['--careful'] } } : undefined);
		const swapped = (cli: AgentCli, unattended: boolean, config = cli.defaults) => {
			const on = cli.launch(inputFor(cli, { config, unattended, ...unattended ? { task: 'Plan.' } : {} }), '/bin/cli').args;
			const off = cli.launch(inputFor(cli, { config, unattended, yolo: false, ...unattended ? { task: 'Plan.' } : {} }), '/bin/cli').args;
			return { removed: on.filter(arg => !off.includes(arg)), added: off.filter(arg => !on.includes(arg)) };
		};

		assert.deepStrictEqual({
			persons: [...knownClis().map(cli => swapped(cli, false)), swapped(codexCli, false, theirs)],
			startAgents: [...knownClis().map(cli => swapped(cli, true)), swapped(codexCli, true, theirs)]
		}, {
			persons: [
				{ removed: ['--dangerously-skip-permissions'], added: ['--allowedTools', 'mcp__facade'] },
				{ removed: ['--dangerously-bypass-approvals-and-sandbox'], added: ['--sandbox', 'workspace-write'] },
				{ removed: [], added: [] },
				{ removed: ['--disable-sandbox'], added: [] },
				{ removed: ['--yolo'], added: [] },
				{ removed: ['--yolo'], added: ['--careful'] }
			],
			startAgents: [
				{ removed: ['--dangerously-skip-permissions'], added: ['--permission-mode', 'dontAsk', '--allowedTools', 'mcp__facade', 'Edit(./**)'] },
				{ removed: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], added: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'features.hooks=false'] },
				{ removed: [], added: [] },
				{ removed: ['--disable-sandbox'], added: [] },
				{ removed: ['--yolo'], added: [] },
				{ removed: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], added: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'features.hooks=false'] }
			]
		});
	});

	test('Claude Code\'s sandbox follows the agent\'s YOLO in the settings file of its run, where it has one, the keys of a sandbox setting of the person\'s launch over Facade\'s - a key of theirs alone leaves the rest as Facade has it: with YOLO off, one started through start_agent has no way out of it - a command run outside it would ask - while the person\'s own asks them for one (L4, rule 2; N-70); the warning about skipped permissions is off with YOLO on alone', () => {
		const settingsOf = (yolo: boolean, unattended: boolean, config = claudeCli.defaults) => {
			const { sandbox, skipDangerousModePermissionPrompt } = JSON.parse(claudeCli.launch(inputFor(claudeCli, { yolo, unattended, config }), '/bin/claude').files[0].content);
			return { sandbox, skip: skipDangerousModePermissionPrompt };
		};
		const theirs = readCliConfig(claudeCli, name => name === 'launch' ? { settings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } } } : undefined);
		const keyAlone = readCliConfig(claudeCli, name => name === 'launch' ? { settings: { sandbox: { excludedCommands: ['docker'] } } } : undefined);
		const has = process.platform !== 'win32';

		assert.deepStrictEqual({
			persons: [settingsOf(true, false), settingsOf(false, false)],
			startAgents: [settingsOf(true, true), settingsOf(false, true)],
			theirs: settingsOf(false, true, theirs),
			keyAlone: [settingsOf(false, false, keyAlone), settingsOf(false, true, keyAlone)]
		}, {
			persons: [{ sandbox: has ? { enabled: false } : undefined, skip: true }, { sandbox: has ? { enabled: true } : undefined, skip: undefined }],
			startAgents: [{ sandbox: has ? { enabled: false } : undefined, skip: true }, { sandbox: has ? { enabled: true, allowUnsandboxedCommands: false } : undefined, skip: undefined }],
			theirs: { sandbox: has ? { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false } : { enabled: true, autoAllowBashIfSandboxed: false }, skip: undefined },
			keyAlone: [
				{ sandbox: has ? { enabled: true, excludedCommands: ['docker'] } : { excludedCommands: ['docker'] }, skip: undefined },
				{ sandbox: has ? { enabled: true, allowUnsandboxedCommands: false, excludedCommands: ['docker'] } : { excludedCommands: ['docker'] }, skip: undefined }
			]
		});
	});

	test('with YOLO off, Claude Code started through start_agent runs without the servers of its folder\'s .mcp.json the person has not approved for its project - Facade\'s own entry aside - so that it does not wait at its question "New MCP server found in this project", nor run one nobody reviewed; those approved - in the settings of its launch, the project\'s local settings, Claude Code\'s configuration for the project, or all of them at once - it runs as they are. The person\'s own asks as Claude Code does, and with YOLO on nothing is asked; Show Agent Launch says so in its start_agent column (L4, rule 3; LV-02)', () => {
		const temp = tempDir('facade-mcpjson-');
		try {
			const [lab, config] = ['lab', 'config'].map(name => path.join(temp.dir, name));
			fs.mkdirSync(path.join(lab, '.claude'), { recursive: true });
			fs.mkdirSync(config);
			fs.writeFileSync(path.join(lab, '.mcp.json'), JSON.stringify({ mcpServers: { facade: { command: 'facade' }, 'la13-own': { command: 'own' }, 'in-launch': { command: 'a' }, 'in-local': { command: 'b' }, 'in-config': { command: 'c' } } }));
			fs.writeFileSync(path.join(lab, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['in-local'] }));
			const project = (approval: object) => fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: { [fs.realpathSync(lab)]: { hasTrustDialogAccepted: true, ...approval } } }));
			project({ enabledMcpjsonServers: ['in-config'] });
			const launch = readCliConfig(claudeCli, name => name === 'launch' ? { environment: { CLAUDE_CONFIG_DIR: config }, settings: { enabledMcpjsonServers: ['in-launch'] } } : undefined);
			const offIn = (yolo: boolean, unattended: boolean) => JSON.parse(claudeCli.launch(inputFor(claudeCli, { folder: lab, repository: lab, yolo, unattended, config: launch }), '/bin/claude').files[0].content).disabledMcpjsonServers;
			const shown = () => {
				const place = { folder: lab, repository: lab };
				const document = launchDocument({ folder: lab, yolo: false, framework: true, clis: [{ cli: claudeCli, config: launch, yours: undefined, program: { target: { executable: '/bin/claude', args: [], throughCmd: false } }, trust: { kind: 'none' }, throughStartAgent: starterFacts(claudeCli, launch, place, process.env, true) }] });
				const { whenYouStartIt, throughStartAgent } = JSON.parse(document.split('\n').filter(line => !line.startsWith('// ')).join('\n')).claude;
				return [whenYouStartIt.projectMcpServers, throughStartAgent.projectMcpServers];
			};
			const before = { startAgent: offIn(false, true), yoloOn: offIn(true, true), persons: offIn(false, false), shown: shown() };
			project({ enableAllProjectMcpServers: true });

			assert.deepStrictEqual({ ...before, allApproved: offIn(false, true), allShown: shown()[1] }, {
				startAgent: ['facade', 'la13-own'],
				yoloOn: ['facade'],
				persons: ['facade'],
				shown: [undefined, 'with YOLO off, turned off for the run so that it does not stop to ask about them, since you have not approved them for this project: la13-own'],
				allApproved: ['facade'],
				allShown: 'with YOLO off, none turned off: this folder has no project MCP server that you have not approved for it'
			});
		} finally {
			temp.remove();
		}
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
			{ args: [], files: [], injected: 0 },
			{ args: [], files: ['7.settings.json'], injected: 0 }
		]);
	});

	test('Codex is given each environment variable of Facade\'s server by its name, in quotes where TOML cannot write it bare', () => {
		const spec = codexCli.launch(inputFor(codexCli, { connection: { ...CONNECTION, mcp: { ...MCP, env: { ELECTRON_RUN_AS_NODE: '1', 'NODE.OPTIONS': '--no-warnings' } } } }), '/bin/codex');

		assert.strictEqual(spec.args.find(arg => arg.startsWith('mcp_servers.facade.env=')), 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1", "NODE.OPTIONS" = "--no-warnings" }');
	});

	test('Muse Code runs in its own UI with YOLO on - no approvals, no sandbox - trusting its folder for the run alone, at the effort asked for, set for the run alone - a JSON string, whatever is in it - over the efforts the person keeps for each model, never by the option it saves as theirs (N-75), the task after the options; its server, which finds the agent from its environment, and its skill go into the folder. Started through start_agent its launcher\'s update is off; the person\'s own, from the window, starts at its prompt as it usually does (L4)', () => {
		const spec = museCli.launch(inputFor(museCli, { model: 'muse-spark-1.3', effort: 'max', task: '--- Plan\nAdd clamp.', unattended: true }), '/bin/muse.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));
		const persons = museCli.launch(inputFor(museCli, { model: undefined, effort: undefined }), '/bin/muse.exe');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, persons: { args: persons.args, env: persons.env }, quoted: museCli.launch(inputFor(museCli, { effort: 'high" x' }), '/bin/muse.exe').args[5] }, {
			executable: '/bin/muse.exe',
			args: ['--disable-approval', '--disable-sandbox', '--model', 'muse-spark-1.3', '-c', 'reasoning_effort="max"', '-c', 'model_reasoning_efforts={}', '--trust-workspace', '--', '--- Plan\nAdd clamp.'],
			env: { MUSE_NO_AUTO_UPDATE: '1' },
			cwd: '/lab',
			files: [],
			injected: {
				'.mcp.json': { mcpServers: { facade: { command: MCP.command, args: MCP.args, env: { ...MCP.env, FACADE_AGENTS_RECORD: '${FACADE_AGENTS_RECORD:-}', FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE:-}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN:-}', FACADE_AGENTS_WAIT_MS: '${FACADE_AGENTS_WAIT_MS:-}' } } } },
				'.agents/skills/facade/SKILL.md': SKILL_MD
			},
			persons: { args: ['--disable-approval', '--disable-sandbox', '--trust-workspace'], env: {} },
			quoted: 'reasoning_effort="high\\" x"'
		});
	});

	test('Claude Code\'s sandbox goes in its launch\'s settings file: with YOLO off it is on where the launch passes that file, and off - said so, never on - where the person\'s launch leaves it out (X-07); where the person\'s launch decides it, it is said as theirs - their sandbox setting\'s enabled, or, for a CLI whose arguments set it, unknown once they changed the group that does - never as Facade\'s (L4, rule 4)', () => {
		const uses = (yolo: boolean) => ({ framework: true, yolo, model: false, effort: false, task: false, trust: true });
		const maintained = readCliConfig(claudeCli, () => undefined);
		const withoutQuiet = readCliConfig(claudeCli, name => name === 'launch' ? { arguments: { quiet: null } } : undefined);
		const settingsSandbox = (sandbox: object) => readCliConfig(claudeCli, name => name === 'launch' ? { settings: { sandbox } } : undefined);
		const codexOff = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { yoloOff: ['--sandbox', 'danger-full-access'] } } : undefined);
		const museExtra = readCliConfig(museCli, name => name === 'launch' ? { arguments: { extra: ['--disable-sandbox'] } } : undefined);
		const museOtherExtra = readCliConfig(museCli, name => name === 'launch' ? { arguments: { extra: ['--mcp-config', '${folder}/.mcp.json'] } } : undefined);
		const win = process.platform === 'win32';

		assert.deepStrictEqual({
			maintained: [sandboxOf(claudeCli, maintained, uses(false)), sandboxOf(claudeCli, maintained, uses(true))],
			withoutQuiet: sandboxOf(claudeCli, withoutQuiet, uses(false)),
			theirsOff: sandboxOf(claudeCli, settingsSandbox({ enabled: false }), uses(false)),
			theirsOn: sandboxOf(claudeCli, settingsSandbox({ enabled: true }), uses(true)),
			keyAlone: sandboxOf(claudeCli, settingsSandbox({ excludedCommands: ['docker'] }), uses(false)),
			codex: [sandboxOf(codexCli, readCliConfig(codexCli, () => undefined), uses(false)), sandboxOf(codexCli, codexOff, uses(false)), sandboxOf(codexCli, codexOff, uses(true))],
			muse: [sandboxOf(museCli, museExtra, uses(false)), sandboxOf(museCli, museExtra, uses(true))],
			// An extra group of the person's that names no sandbox leaves it as Facade's
			museOther: [sandboxOf(museCli, museOtherExtra, uses(false)), sandboxOf(museCli, museOtherExtra, uses(true))]
		}, {
			maintained: [win ? 'unavailable' : 'on', 'off'],
			withoutQuiet: win ? 'unavailable' : 'off',
			theirsOff: win ? 'unavailable' : 'off',
			theirsOn: win ? 'unavailable' : 'on',
			keyAlone: win ? 'unavailable' : 'on',
			codex: [win ? 'unavailable' : 'on', win ? 'unavailable' : 'unknown', 'off'],
			muse: ['unknown', 'unknown'],
			museOther: ['on', 'off']
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

	test('Antigravity runs in its own UI without asking, warming up on a first message of its own, on a model\'s base name with the effort that picks its variant; its server and skill go into the folder as one plugin, which every agent there shares. Started through start_agent its background update is off, and its first message has it ask in words; the person\'s own, from the window, is warmed up and updates as it usually does (L4; N-71)', () => {
		const spec = antigravityCli.launch(inputFor(antigravityCli, { model: 'gemini-3.8-flash', effort: 'medium', task: 'Not given here.', unattended: true }), '/bin/agy.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));
		const persons = antigravityCli.launch(inputFor(antigravityCli, { model: undefined, effort: undefined }), '/bin/agy.exe');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, task: antigravityCli.task, persons: { args: persons.args, env: persons.env } }, {
			executable: '/bin/agy.exe',
			args: ['-i', `Reply only with ready. Your terminal may be unattended. ${OPENING}`, '--add-dir', '/record/messages', '--add-dir', '/record/screens', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash', '--effort', 'medium'],
			env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
			cwd: '/lab',
			files: [],
			injected: {
				'.agents/plugins/facade/plugin.json': { name: 'facade' },
				'.agents/plugins/facade/mcp_config.json': { mcpServers: { facade: MCP } },
				'.agents/plugins/facade/skills/facade/SKILL.md': SKILL_MD
			},
			task: 'terminal',
			persons: { args: ['-i', 'Reply only with ready.', '--add-dir', '/record/messages', '--add-dir', '/record/screens', '--mode', 'accept-edits', '--dangerously-skip-permissions'], env: {} }
		});
	});

	test('Qwen Code runs in its own UI with YOLO on - every tool without asking, its sandbox off whatever the person turned on - with Facade\'s server, trusted, from a file of the run, its MCP servers connected before its first prompt, the notice of its task, goes; on the model asked for, at the effort asked for, which goes in its settings for the run, over the administrator\'s, in the scope over all its others - the system defaults left where they were; its skill goes into the folder. Started through start_agent, its question tool is taken away, and its tips, its feedback survey, its update check and its questions about the IDE and the project\'s last session are off in those settings; the person\'s own, from the window, given no effort, starts with no settings of Facade\'s and as it usually does (L4)', () => {
		const temp = tempDir('facade-qwen-');
		try {
			const admin = path.join(temp.dir, 'admin', 'settings.json');
			fs.mkdirSync(path.dirname(admin));
			fs.writeFileSync(admin, '{\n\t// The administrator\'s\n\t"model": { "name": "qwen3.8-max" },\n\t"ui": { "hideTips": false },\n}\n');
			const env = { [HOME_VARIABLE]: temp.dir, QWEN_CODE_SYSTEM_SETTINGS_PATH: admin };
			const spec = qwenCli.launch(inputFor(qwenCli, { env, model: 'qwen3.8-max', effort: 'xhigh', task: '-[facade] You are @q #a7.', unattended: true }), '/bin/qwen');
			const persons = qwenCli.launch(inputFor(qwenCli, { env, model: undefined, effort: undefined }), '/bin/qwen');
			const yoloOff = qwenCli.launch(inputFor(qwenCli, { env, model: undefined, effort: undefined, yolo: false }), '/bin/qwen');
			const file = (of: LaunchSpec, name: string) => JSON.parse(of.files.find(each => path.basename(each.path) === name)?.content ?? 'null');
			const mcpConfig = path.join('/runs', '7.mcp.json');
			const settingsFile = path.join('/runs', '7.settings.json');

			assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files.map(each => each.path), config: file(spec, '7.mcp.json'), settings: file(spec, '7.settings.json'), injected: spec.injected, task: qwenCli.task, persons: { args: persons.args, env: persons.env, files: persons.files.map(each => each.path) }, yoloOff: yoloOff.env, admin: fs.readFileSync(admin, 'utf8') }, {
				executable: '/bin/qwen',
				args: [
					'--mcp-config', mcpConfig,
					'--exclude-tools', 'ask_user_question',
					'--include-directories', '/record/messages', '--include-directories', '/record/screens',
					'--yolo',
					'--model', 'qwen3.8-max',
					'--prompt-interactive=-[facade] You are @q #a7.'
				],
				env: {
					QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
					QWEN_SANDBOX: 'false',
					QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile,
					QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(path.dirname(admin), 'system-defaults.json')
				},
				cwd: '/lab',
				files: [settingsFile, mcpConfig],
				config: { mcpServers: { facade: { command: MCP.command, args: MCP.args, env: MCP.env, timeout: 3_600_000, trust: true, alwaysLoadTools: true } } },
				settings: { model: { name: 'qwen3.8-max', reasoningEffort: 'xhigh' }, ui: { hideTips: true, enableFollowupSuggestions: false, enableUserFeedback: false, enableWelcomeBack: false }, ide: { hasSeenNudge: true }, general: { enableAutoUpdate: false } },
				injected: [{ path: '.agents/skills/facade/SKILL.md', content: SKILL_MD }],
				task: 'argument',
				persons: { args: ['--mcp-config', mcpConfig, '--include-directories', '/record/messages', '--include-directories', '/record/screens', '--yolo'], env: { QWEN_CODE_LEGACY_MCP_BLOCKING: '1', QWEN_SANDBOX: 'false' }, files: [mcpConfig] },
				yoloOff: { QWEN_CODE_LEGACY_MCP_BLOCKING: '1' },
				admin: '{\n\t// The administrator\'s\n\t"model": { "name": "qwen3.8-max" },\n\t"ui": { "hideTips": false },\n}\n'
			});
		} finally {
			temp.remove();
		}
	});

	test('Qwen Code\'s settings for the run go over the administrator\'s, which a start that cannot read them refuses, naming the file and leaving it as it is; with no file there, they are Facade\'s alone. A wait of Facade\'s longer than Qwen Code lets a tool call go without word - as its settings say, which go over its variable, or by default - start_agent\'s, is let go that long in those settings; a shorter one is left as it is', () => {
		const temp = tempDir('facade-qwen-');
		try {
			const admin = path.join(temp.dir, 'settings.json');
			const user = path.join(temp.dir, '.qwen', 'settings.json');
			fs.writeFileSync(admin, '{ not json');
			fs.mkdirSync(path.dirname(user));
			const env = { [HOME_VARIABLE]: temp.dir, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(temp.dir, 'none.json') };
			const refused = outcome(() => qwenCli.launch(inputFor(qwenCli, { env: { ...env, QWEN_CODE_SYSTEM_SETTINGS_PATH: admin } }), '/bin/qwen'));
			const none = qwenCli.launch(inputFor(qwenCli, { env }), '/bin/qwen');
			const waitingOf = (waitMs: string, theirs: object = {}, variables: object = {}) => {
				fs.writeFileSync(user, JSON.stringify(theirs));
				const spec = qwenCli.launch(inputFor(qwenCli, { effort: undefined, env: { ...env, ...variables }, connection: { ...CONNECTION, values: { ...CONNECTION.values, waitMs } } }), '/bin/qwen');
				const settings = spec.files.find(each => path.basename(each.path) === '7.settings.json');
				return settings ? JSON.parse(settings.content).mcp?.toolIdleTimeoutMs : undefined;
			};

			assert.deepStrictEqual({
				refused: [refused.startsWith(`${admin} `), refused.includes('left the file unchanged'), refused.includes('facade.agents.qwen.launch')],
				left: fs.readFileSync(admin, 'utf8'),
				none: JSON.parse(none.files[0].content),
				waits: [waitingOf('120000'), waitingOf('240000'), waitingOf('250000'), waitingOf('3600000')],
				theirs: [waitingOf('120000', { mcp: { toolIdleTimeoutMs: 60_000 } }), waitingOf('250000', { mcp: { toolIdleTimeoutMs: 3_600_000 } }), waitingOf('120000', {}, { QWEN_CODE_MCP_TOOL_IDLE_TIMEOUT_MS: '60000' })]
			}, {
				refused: [true, true, true],
				left: '{ not json',
				none: { model: { reasoningEffort: 'high' } },
				waits: [undefined, undefined, 310_000, 3_600_000],
				theirs: [180_000, undefined, 180_000]
			});
		} finally {
			temp.remove();
		}
	});

	test('Qwen Code\'s settings for the run go over the administrator\'s as it merges one scope over another: a list it adds together has both - whole, or each entry once - an object it merges one level deep has the launch\'s keys in place of theirs, any other value is the launch\'s, and objects are merged key by key', () => {
		const temp = tempDir('facade-qwen-');
		try {
			const admin = path.join(temp.dir, 'admin.json');
			fs.writeFileSync(admin, JSON.stringify({
				permissions: { deny: ['run_shell_command'] },
				mcp: { excluded: ['old'] },
				mcpServers: { a: { command: 'a', args: ['1'] }, b: { command: 'b' } },
				tools: { sandbox: true },
				context: { includeDirectories: ['/x'] },
				hooks: { Stop: [{ hooks: [] }] },
				ui: { hideTips: false }
			}));
			const config = readCliConfig(qwenCli, name => name === 'launch' ? {
				settings: {
					permissions: { deny: ['run_shell_command', 'web_fetch'] },
					mcp: { excluded: ['new'] },
					mcpServers: { a: { command: 'a2' } },
					tools: { sandbox: false },
					context: { includeDirectories: ['/y'] },
					hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
					ui: { theme: 'Default' }
				}
			} : undefined);
			const spec = qwenCli.launch(inputFor(qwenCli, { config, env: { [HOME_VARIABLE]: temp.dir, QWEN_CODE_SYSTEM_SETTINGS_PATH: admin } }), '/bin/qwen');

			assert.deepStrictEqual(JSON.parse(spec.files.find(each => path.basename(each.path) === '7.settings.json')?.content ?? 'null'), {
				permissions: { deny: ['run_shell_command', 'web_fetch'] },
				mcp: { excluded: ['old', 'new'] },
				mcpServers: { a: { command: 'a2' }, b: { command: 'b' } },
				tools: { sandbox: false },
				context: { includeDirectories: ['/x', '/y'] },
				hooks: { Stop: [{ hooks: [] }, { hooks: [{ type: 'command', command: 'x' }] }] },
				ui: { hideTips: false, theme: 'Default' },
				model: { reasoningEffort: 'high' }
			});
		} finally {
			temp.remove();
		}
	});

	test('Qwen Code takes a model by its option and an effort in its settings for the run, as no option of its takes one: both are offered to agents, and the effort is withheld where the person took that setting out; a value that names neither is the settings\' own; Claude Code\'s settings, which take none, offer none (L9)', () => {
		const withoutEffort = readCliConfig(qwenCli, name => name === 'launch' ? { settings: { model: { reasoningEffort: null } } } : undefined);
		const fixed = readCliConfig(qwenCli, name => name === 'launch' ? { settings: { model: { reasoningEffort: 'low' }, general: { note: '${folder}' } } } : undefined);
		const claudeInSettings = readCliConfig(claudeCli, name => name === 'launch' ? { arguments: { model: null }, settings: { model: '${model}' } } : undefined);
		const settingsOf = (config = qwenCli.defaults) => JSON.parse(qwenCli.launch(inputFor(qwenCli, { config, env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(os.tmpdir(), 'facade-qwen-none', 'settings.json') } }), '/bin/qwen').files.find(file => path.basename(file.path) === '7.settings.json')?.content ?? 'null');

		assert.deepStrictEqual({
			maintained: capabilitiesOf(qwenCli, launchFor(qwenCli.defaults, true)),
			withoutEffort: capabilitiesOf(qwenCli, launchFor(withoutEffort, true)),
			others: knownClis().filter(cli => cli !== qwenCli).map(cli => capabilitiesOf(cli, launchFor(cli.defaults, true)).effort),
			claudeInSettings: capabilitiesOf(claudeCli, launchFor(claudeInSettings, true)).model,
			settings: [settingsOf(), settingsOf(withoutEffort), settingsOf(fixed)]
		}, {
			maintained: { integration: true, task: true, model: true, effort: true },
			withoutEffort: { integration: true, task: true, model: true, effort: false },
			others: [true, true, true, true],
			claudeInSettings: false,
			settings: [{ model: { reasoningEffort: 'high' } }, null, { model: { reasoningEffort: 'low' }, general: { note: '${folder}' } }]
		});
	});
});

suite('CLIs: how the person has Facade start each one', () => {

	test('every part of a launch is the person\'s to change, and only what they set changes: a group of arguments replaced, its `${name}`s given their values, one set to null left out; a variable of Facade\'s replaced or, set to null, taken out; Claude Code\'s settings key by key, down through objects - theirs too, so that no null reaches Claude Code; its unattended part\'s the same way, over the launch for an agent started through start_agent', () => {
		const set: { [name: string]: unknown } = {
			launch: {
				arguments: { yoloOn: ['--permission-mode', 'bypassPermissions'], extra: ['--add-dir', '/shared/${model}'], effort: null },
				environment: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
				settings: { theme: 'dark', env: { FOO: null, BAR: '1' } },
				unattended: { environment: { DISABLE_AUTOUPDATER: null }, settings: { spinnerTipsEnabled: null } }
			}
		};
		const config = readCliConfig(claudeCli, name => set[name]);
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', task: 'Plan.', config, unattended: true }), '/bin/claude');
		// Settings of Facade's with an object in them, which the person changes a part of.
		const nested: AgentCli = { ...claudeCli, defaults: { path: '', enabled: true, launch: { ...claudeCli.defaults.launch, settings: { permissions: { allow: ['Read'], deny: ['Write'] } } } } };
		const deeper = readCliConfig(nested, name => name === 'launch' ? { settings: { permissions: { deny: null, ask: ['Bash'] } } } : undefined);

		assert.deepStrictEqual({ args: spec.args, env: spec.env, settings: JSON.parse(spec.files[0].content), deeper: deeper.launch.settings }, {
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
				'--settings', path.join('/runs', '7.settings.json'),
				'--disallowedTools', 'AskUserQuestion',
				'--add-dir', '/record/messages', '/record/screens',
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
			settings: { skipDangerousModePermissionPrompt: true, emojiCompletionEnabled: false, disabledMcpjsonServers: ['facade'], theme: 'dark', env: { BAR: '1' }, ...process.platform === 'win32' ? {} : { sandbox: { enabled: false } } },
			deeper: { permissions: { allow: ['Read'], ask: ['Bash'] } }
		});
	});

	test('on Windows, which takes a variable\'s name in any case, the person\'s variable is Facade\'s whatever its case - set to null it takes Facade\'s out, set to text it replaces it - in its unattended part too, which goes over the launch\'s the same way; elsewhere one of another case is another variable', () => {
		// A launch whose variables apply to every agent, and the person's own in another case
		const variables: AgentCli = { ...claudeCli, defaults: { ...claudeCli.defaults, launch: { ...claudeCli.defaults.launch, environment: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' } } } };
		const config = readCliConfig(variables, name => name === 'launch' ? { environment: { disable_autoupdater: null, claude_code_auto_connect_ide: 'true' }, unattended: { environment: { claude_code_ide_skip_auto_install: null } } } : undefined);
		const { environment } = config.launch;
		const unattended = launchFor(config, true).launch.environment;
		const seen = { updater: [environment.DISABLE_AUTOUPDATER, environment.disable_autoupdater], ide: [environment.CLAUDE_CODE_AUTO_CONNECT_IDE, environment.claude_code_auto_connect_ide], install: [unattended.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, unattended.claude_code_ide_skip_auto_install] };

		assert.deepStrictEqual(seen, process.platform === 'win32'
			? { updater: [undefined, undefined], ide: ['true', undefined], install: [undefined, undefined] }
			: { updater: ['1', undefined], ide: ['false', 'true'], install: ['1', undefined] });
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
					'Unknown field \'sandbox\' in facade.agents.codex.launch. Codex\'s launch accepts: arguments, environment, trust, enterDelay, taskDelay, unattended',
					`Unknown argument group 'warmup' in facade.agents.codex.launch.arguments. Codex accepts: ${groups}`,
					'facade.agents.codex.launch.arguments.connect must be an array of strings or null; received "--no-daemon"',
					'facade.agents.codex.launch.arguments.model must be an array of strings or null; received ["-m",4]',
					'facade.agents.codex.launch.environment.CODEX_HOME must be a string or null; received 7',
					'facade.agents.codex.launch.trust.arguments must be an array of strings; received "x"',
					`facade.agents.codex.launch.enterDelay must be an integer from 0 to ${MAX_DELAY_MS} milliseconds; received -5`,
					`facade.agents.codex.launch.taskDelay must be an integer from 0 to ${MAX_DELAY_MS} milliseconds; received 1000000000000`
				]
			},
			path: '/opt/codex/codex',
			notAnObject: { ...codexCli.defaults, wrong: ['facade.agents.codex.enabled must be true or false; received 7', 'facade.agents.codex.path must be a string; received 7', 'facade.agents.codex.launch must be an object; received ["--verbose"]'] },
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
		const values = 'Supported variables: ${folder}, ${repository}, ${home}, ${messagesDir}, ${screensDir}, ${model}, ${effort}, ${executable}, ${shimFile}, ${pipe}, ${recordDir}, ${tokenFile}, ${waitMs}, ${mcpConfig}, ${settingsFile}, ${pluginDir}.';

		assert.deepStrictEqual([refused({ arguments: { extra: ['--add-dir', '${hostname}'] } }), refused({ arguments: { model: ['--model', '${model_name}'] } })], [
			`Setting 'facade.agents.claude.launch.arguments.extra' contains an unknown variable '\${hostname}'. ${values}`,
			`Setting 'facade.agents.claude.launch.arguments.model' contains an unknown variable '\${model_name}'. ${values}`
		]);
	});

	test('a launch has Facade\'s integration through its connect group - a built-in\'s that the person took out, or a custom agent\'s left out, has none - but for a CLI that reads Facade\'s server from its folder', () => {
		const without = (cli: AgentCli) => capabilitiesOf(cli, readCliConfig(cli, name => name === 'launch' ? { arguments: { connect: null } } : undefined)).integration;
		assert.deepStrictEqual(Object.fromEntries(knownClis().map(cli => [cli.id, [capabilitiesOf(cli, cli.defaults).integration, without(cli)]])), {
			claude: [true, false],
			codex: [true, false],
			agy: [true, true],
			muse: [true, true],
			qwen: [true, false]
		});
	});

	test('a custom agent whose task group is in its launch\'s unattended part alone takes a task through start_agent - the launch an agent starts it with has the group, and its notice goes there - and one the person starts, given none, has none to take (L9; M7)', () => {
		const { cli, config } = customAgentOf('bot', { path: '/bin/bot', launch: { arguments: { connect: ['--mcp', '${mcpConfig}'] }, unattended: { arguments: { task: ['--', '${task}'] } } } }, undefined);
		const notice = '[facade] You are @b1 #a7, created by @lead #a1. Your task is #m3.';

		assert.deepStrictEqual({
			throughStartAgent: capabilitiesOf(cli, launchFor(config, true)).task,
			fromTheUi: capabilitiesOf(cli, launchFor(config, false)).task,
			args: cli.launch(inputFor(cli, { config, unattended: true, task: notice }), '/bin/bot').args
		}, {
			throughStartAgent: true,
			fromTheUi: false,
			args: ['--mcp', path.join('/runs', '7.mcp.json'), '--', notice]
		});
	});

	test('a custom agent\'s launch waits 250 milliseconds between a line typed into its terminal and its Enter, and nothing before its first line, where the person sets no delays of their own (L9)', () => {
		const delays = (launch: unknown) => {
			const { config } = customAgentOf('bot', { path: '/bin/bot', ...(launch !== undefined ? { launch } : {}) }, undefined);
			return [config.launch.enterDelay, config.launch.taskDelay];
		};

		assert.deepStrictEqual([delays(undefined), delays({}), delays({ enterDelay: 900, taskDelay: 3_000 })], [[250, 0], [250, 0], [900, 3_000]]);
	});

	test('every launch has the same values - where it runs, its repository, the home folder, where its messages are, and what it was given - each CLI\'s own files besides', () => {
		const extra = (cli: AgentCli) => cli.launch(inputFor(cli, { config: readCliConfig(cli, name => name === 'launch' ? { arguments: { extra: ['${folder}', '${repository}', '${home}', '${messagesDir}'] } } : undefined) }), '/bin/cli').args.slice(-4);
		assert.deepStrictEqual(knownClis().map(extra), knownClis().map(() => ['/lab', '/lab', os.homedir(), '/record/messages']));
	});

	test('a CLI that reads Facade\'s server from its folder is given that server, which every agent there shares, with the connection\'s values all the same - its executable, its shim, the record, the agent\'s token file and its wait - as every other CLI is, for the person\'s groups to use (O9; L9)', () => {
		const shared = { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--agent'], env: { ELECTRON_RUN_AS_NODE: '1' } };
		const values = ['${executable}', '${shimFile}', '${recordDir}', '${tokenFile}', '${waitMs}'];
		const given = (cli: AgentCli) => {
			const connection = connectionFor(cli, shared, CONNECTION);
			const config = readCliConfig(cli, name => name === 'launch' ? { arguments: { extra: values } } : undefined);
			return { server: connection.mcp === shared ? 'shared' : 'its own', values: cli.launch(inputFor(cli, { config, connection }), '/bin/cli').args.filter(arg => Object.values(CONNECTION.values).includes(arg)) };
		};
		const each = { values: ['/facade/facade', '/facade/shim.js', '/record', '/runs/7.token', '120000'] };

		assert.deepStrictEqual(Object.fromEntries(knownClis().map(cli => [cli.id, given(cli)])), {
			claude: { server: 'its own', ...each },
			codex: { server: 'its own', ...each },
			agy: { server: 'shared', ...each },
			muse: { server: 'shared', ...each },
			qwen: { server: 'its own', ...each }
		});
	});

	test('a time the person sets in seconds is a whole number of them, from one to an hour; any other value is not made into one - its default is used, and that is said, naming the setting (X-59)', () => {
		const read = (value: unknown) => readSeconds('facade.agents.timeout', value, 120_000);
		const wrong = (shown: string) => ({ ms: 120_000, wrong: `facade.agents.timeout must be an integer from 1 to ${MAX_TIME_S} seconds; received ${shown}. Using the default of 120 seconds` });

		assert.deepStrictEqual([read(undefined), read(30), read(MAX_TIME_S), read(0), read(3601), read(1.5), read('30'), read(Number.NaN)], [
			{ ms: 120_000 }, { ms: 30_000 }, { ms: MAX_TIME_S * 1000 }, wrong('0'), wrong('3601'), wrong('1.5'), wrong('"30"'), wrong('null')
		]);
	});

	test('package.json declares the agents\' settings in three groups: Agents - YOLO and the agent framework\'s switch, on by default, and one timeout, the code\'s - then each built-in - whether it is offered and where to find it, and its launch, empty - then Custom Agents; each on this machine alone, and shown on the one page Configure Agents opens, whatever the person\'s setting for advanced settings: the timeout and the launches are said to be advanced in their descriptions, not hidden by a tag (L7); each part of a launch, its unattended part\'s too, and each group of its arguments, has Facade\'s own as the default completion fills in, and its description is short and names the command that shows it all; the three commands are under Agents', () => {
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
				advanced: [declared('enabled')?.tags, declared('path')?.tags, launch?.tags, text(launch?.markdownDescription).startsWith('Advanced: ')],
				scopes: [declared('enabled')?.scope, declared('path')?.scope, launch?.scope],
				parts: Object.fromEntries(Object.entries(parts).map(([part, schema]) => [part, schema.default])),
				groups: Object.fromEntries(Object.entries(parts.arguments?.properties ?? {}).map(([group, schema]) => [group, schema.default])),
				unattended: Object.fromEntries(Object.entries(parts.unattended?.properties ?? {}).map(([part, schema]) => [part, part === 'arguments' ? { whole: schema.default, groups: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([group, each]) => [group, each.default])) } : schema.default])),
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
			timeout: [own['facade.agents.timeout']?.default, own['facade.agents.timeout']?.maximum, own['facade.agents.timeout']?.tags, text(own['facade.agents.timeout']?.markdownDescription).startsWith('Advanced: ')],
			waits: [START_TIMEOUT_MS, WINDOW_WAIT_MS],
			custom: [custom?.default, custom?.scope],
			commands: commands.map(each => each.command),
			category: texts['command.category'],
			seen
		}, {
			sections: ['facade.agents', 'facade.agents.claude', 'facade.agents.codex', 'facade.agents.antigravity', 'facade.agents.muse', 'facade.agents.qwen', 'facade.agents.custom'],
			own: ['facade.agents.yolo', 'facade.orchestration.enabled', 'facade.agents.timeout'],
			switches: [true, undefined, true, undefined],
			timeout: [START_TIMEOUT_MS / 1000, MAX_TIME_S, undefined, true],
			waits: [START_TIMEOUT_MS, START_TIMEOUT_MS],
			custom: [{}, 'machine'],
			commands: ['facade.agents.startAgent', 'facade.agents.openChatRoom', 'facade.agents.deleteChatRooms', 'facade.agents.showLog', 'facade.agents.showLaunch'],
			category: 'Agents',
			seen: knownClis().map(({ setting, task, defaults: { launch } }) => ({
				names: [`${setting}.enabled`, `${setting}.path`, `${setting}.launch`],
				defaults: [true, '', {}],
				advanced: [undefined, undefined, undefined, true],
				scopes: ['machine', 'machine', 'machine'],
				parts: { arguments: launch.arguments, environment: launch.environment, trust: launch.trust, ...(launch.settings ? { settings: launch.settings } : {}), enterDelay: launch.enterDelay, taskDelay: launch.taskDelay, unattended: launch.unattended },
				// A CLI told of its task in its terminal takes no task group.
				groups: Object.fromEntries(ARG_GROUPS.filter(group => group !== 'task' || task === 'argument').map(group => [group, launch.arguments[group]])),
				// Its unattended part, part by part - its arguments whole and each group of them - as completion fills it in (L4)
				unattended: { arguments: { whole: launch.unattended?.arguments, groups: Object.fromEntries(ARG_GROUPS.filter(group => group !== 'task' || task === 'argument').map(group => [group, launch.unattended?.arguments[group]])) }, environment: launch.unattended?.environment, ...(launch.settings ? { settings: launch.unattended?.settings } : {}) },
				// One given its trust in its arguments has no file of Facade's to complete one of the person's.
				trustTakesBoth: launch.trust?.file === undefined ? { file: ['merge'], merge: ['file'] } : undefined,
				delays: [MAX_DELAY_MS, MAX_DELAY_MS],
				described: [true, false]
			}))
		});
	});

	test('settings.json checks a custom agent\'s name as the person types it, as a start checks it: one an agent can have, neither a built-in\'s id nor a reserved name - and says what a name is (L9)', () => {
		const { sections, texts } = manifest();
		const names = sections.find(each => each.id === 'facade.agents.custom')?.properties['facade.agents.custom']?.propertyNames;
		const bySchema = (name: string) => new RegExp(names?.pattern ?? '').test(name) && !(names?.not?.enum ?? []).includes(name);
		const builtIns = new Set(knownClis().map(cli => cli.id));
		const candidates = ['bot', 'my.bot_2-x', '7up', 'a'.repeat(40), 'a'.repeat(41), 'My Bot', 'Bot', '-bot', '.bot', '', 'claude', 'codex', 'agy', 'muse', 'qwen', 'antigravity', 'human', 'you', 'me', 'facade', 'all', 'everyone', 'init', 'kernel'];

		assert.deepStrictEqual({
			names: candidates.map(name => [name, bySchema(name)]),
			says: texts[names?.errorMessage?.replace(/^%|%$/g, '') ?? '']
		}, {
			names: candidates.map(name => [name, customAgentNameProblem(name, builtIns) === undefined]),
			says: 'A custom agent\'s name must be 1 to 40 lowercase letters, digits, dots, dashes, or underscores, starting with a letter or digit. It cannot be a built-in agent\'s ID (claude, codex, agy, muse, qwen) or a reserved name (human, you, me, facade, all, everyone, init, kernel).'
		});
	});

	test('Agents: Show Agent Launch shows the folder it is for, whether YOLO and the agent framework are on, what an agent the person starts and one started through start_agent each run with, and by each agent\'s setting the program Facade runs - with the script it gives Node for an npm shim, and whether cmd.exe runs it - whether a built-in is offered, how its task\'s notice reaches it, for either starter its sandbox with YOLO on and off, whether Facade\'s tools are asked for and whether it can put up a question, the trust it is given and where, what is wrong in the person\'s settings of it, the version last verified, its launch as Facade starts it now - Facade\'s own with the person\'s changes over it - and those changes as the person wrote them', () => {
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
				{ cli: antigravityCli, config: antigravityCli.defaults, yours: undefined, program: { missing: 'agy is not on the PATH used by a terminal in that folder' }, trust: { kind: 'cannot', why: 'the file is no absolute path' } }
			]
		});
		const parts = (document: string) => {
			const lines = document.split('\n');
			const comments = lines.filter(line => line.startsWith('// '));
			return { comments, shown: JSON.parse(lines.slice(comments.length).join('\n')) };
		};
		const launch = (of: AgentCli) => JSON.parse(JSON.stringify(of.defaults.launch));
		const on = parts(shownWith(true));
		// Codex whose connect group the person wrote without Facade's approval line, and what would refuse its start (X-38)
		const connect = codexCli.defaults.launch.arguments.connect?.filter(arg => !arg.includes('default_tools_approval_mode')).filter((arg, i, all) => !(arg === '-c' && (all[i + 1] === '-c' || all[i + 1] === '--no-daemon')));
		const theirConnect = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { connect } } : undefined);
		const problems = ['Cannot start Codex: /home/.codex/config.toml already defines an MCP server named facade. Codex would merge Facade\'s server into that entry. Rename or remove the existing entry.'];
		const theirs = parts(launchDocument({ folder: '/lab', yolo: false, framework: true, clis: [{ cli: codexCli, config: theirConnect, yours: { arguments: { connect } }, program: { target: { executable: '/bin/codex', args: [], throughCmd: false } }, trust: { kind: 'none' }, problems }] })).shown.codex;
		const sandboxOff = process.platform === 'win32' ? 'unavailable' : 'on';
		const yoursToAnswer = 'kept: it can show a question for you to answer, as it does outside Facade';
		const toldInWords = 'kept: no launch can remove its question tool, so the instructions it gets at start tell it to ask through Facade messages; if asked for that tool by name, it can still show a question';
		const changedConnect = 'as set by your launch\'s connect group: Facade\'s default exempts its server from approval, and you changed it';

		assert.deepStrictEqual({
			comments: [on.comments.length, on.comments[0].includes('/lab'), on.comments[1].includes('YOLO is on'), parts(shownWith(false)).comments[1].includes('YOLO is off'), parts(shownWith({ wrong: 'facade.agents.yolo is "yes"' })).comments[1].includes('"yes"'), on.comments[2].includes('unattended part'), on.comments[3].includes('is on'), parts(shownWith(true, false)).comments[3].includes('is off')],
			shown: on.shown,
			theirs: { yours: theirs.whenYouStartIt.facadeTools, startAgent: theirs.throughStartAgent.facadeTools, cannotStart: theirs.cannotStart }
		}, {
			comments: [7, true, true, true, true, true, true, true],
			shown: {
				claude: {
					program: 'C:/tools/claude.cmd', throughCmd: true, offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'denied: /home/.claude/settings.json denies mcp__facade', approvalsWithYoloOff: 'asks you, as its CLI does', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'denied: /home/.claude/settings.json denies mcp__facade', approvalsWithYoloOff: 'edits in its folder are allowed without asking; anything else that would ask is denied without asking', questions: 'removed by its launch\'s questions group: it asks through Facade messages', projectMcpServers: 'with YOLO off, the project MCP servers in its folder that you have not approved for it are turned off for the run, so that it does not stop to ask about them' },
					trust: { file: '/home/.claude.json', merge: { projects: { '/lab': { hasTrustDialogAccepted: true } } }, kept: 'permanently: Facade never removes it' }, wrongSettings: ['Unknown field \'extra\' in facade.agents.claude.launch. Claude Code\'s launch accepts: arguments, environment, trust, settings, enterDelay, taskDelay, unattended'], verified: '2.1.296', launch: JSON.parse(JSON.stringify(config.launch)), yourChanges: yours
				},
				codex: {
					program: 'C:/node/node.exe', script: 'C:/npm/codex.js', offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'never asked: its launch exempts only Facade\'s server from approval', approvalsWithYoloOff: 'asks you, as its CLI does', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'never asked: its launch exempts only Facade\'s server from approval', approvalsWithYoloOff: 'anything that would ask is denied without asking', questions: 'removed by its launch\'s questions group: it asks through Facade messages' },
					trust: { arguments: ['-c', 'projects={ ${folder} = { trust_level = "trusted" } }'] }, verified: '0.162.1', launch: launch(codexCli), yourChanges: {}
				},
				muse: {
					program: 'C:/muse/muse.exe', offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: 'on' }, facadeTools: 'never asked: it cannot exempt only Facade\'s server, so with YOLO off it asks for nothing; its sandbox stays on', approvalsWithYoloOff: 'nothing asked, nothing denied: it cannot exempt only Facade tools, so its approvals are off', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: 'on' }, facadeTools: 'never asked: it cannot exempt only Facade\'s server, so with YOLO off it asks for nothing; its sandbox stays on', approvalsWithYoloOff: 'nothing asked, nothing denied: it cannot exempt only Facade tools, so its approvals are off', questions: toldInWords },
					trust: 'none: the CLI asks whether you trust the folder', verified: '1.4.4', launch: launch(museCli), yourChanges: {}
				},
				antigravity: {
					program: 'not found: agy is not on the PATH used by a terminal in that folder', offered: true, task: 'typed',
					whenYouStartIt: { sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' }, facadeTools: 'never asked: it cannot exempt only Facade\'s server, so with YOLO off it asks for nothing; it has no sandbox', approvalsWithYoloOff: 'nothing asked, nothing denied: it cannot exempt only Facade tools, so its approvals are off', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' }, facadeTools: 'never asked: it cannot exempt only Facade\'s server, so with YOLO off it asks for nothing; it has no sandbox', approvalsWithYoloOff: 'nothing asked, nothing denied: it cannot exempt only Facade tools, so its approvals are off', questions: toldInWords },
					trust: 'cannot be granted: the file is no absolute path', verified: '1.3.2', launch: launch(antigravityCli), yourChanges: {}
				}
			},
			theirs: { yours: changedConnect, startAgent: changedConnect, cannotStart: problems }
		});
	});

	test('Show Agent Launch says, for each agent, whether it can put up a question that waits for someone to pick an answer: the person\'s own can, theirs to answer; through start_agent, Claude Code\'s and Codex\'s are taken away unless the person empties their unattended questions group, Muse Code\'s and Antigravity\'s cannot be, and what they are told as they start makes up for it; a custom agent\'s is as its launch says (L4; N-55)', () => {
		const shown = (cli: AgentCli, launch?: unknown) => {
			const config = readCliConfig(cli, name => name === 'launch' ? launch : undefined);
			const document = launchDocument({ folder: '/lab', yolo: true, framework: true, clis: [{ cli, config, yours: undefined, program: { target: { executable: '/bin/x', args: [], throughCmd: false } }, trust: { kind: 'none' } }] });
			const lines = document.split('\n');
			const each = Object.values(JSON.parse(lines.filter(line => !line.startsWith('// ')).join('\n')) as Record<string, { whenYouStartIt: { questions: string }; throughStartAgent: { questions: string } }>)[0];
			return [each.whenYouStartIt.questions, each.throughStartAgent.questions];
		};
		const yours = 'kept: it can show a question for you to answer, as it does outside Facade';

		assert.deepStrictEqual({
			claude: shown(claudeCli),
			codex: shown(codexCli),
			emptied: shown(claudeCli, { unattended: { arguments: { questions: null } } }),
			muse: shown(museCli),
			custom: shown(customAgentOf('mine', { path: '/bin/mine' }, undefined).cli)
		}, {
			claude: [yours, 'removed by its launch\'s questions group: it asks through Facade messages'],
			codex: [yours, 'removed by its launch\'s questions group: it asks through Facade messages'],
			emptied: [yours, 'kept: your launch empties its questions group, so it can show a question that waits for someone to choose an answer'],
			muse: [yours, 'kept: no launch can remove its question tool, so the instructions it gets at start tell it to ask through Facade messages; if asked for that tool by name, it can still show a question'],
			custom: ['as set by your launch\'s questions group', 'as set by your launch\'s questions group']
		});
	});

	test('Show Agent Launch says that Qwen Code started through start_agent with YOLO off asks as its CLI does - it has no setting that denies without asking - while Facade\'s tools go unasked, and the project MCP servers the person has not approved are turned off for the run; and that its own sandbox is on with each YOLO the person\'s configuration of it or their launch turns it on with, for that starter (L4)', () => {
		const own = 'tools.sandbox in /home/.qwen/settings.json';
		const theirs = 'QWEN_SANDBOX=docker in its environment';
		const document = launchDocument({ folder: '/lab', yolo: false, framework: true, clis: [{ cli: qwenCli, config: qwenCli.defaults, yours: undefined, program: { target: { executable: '/bin/qwen', args: [], throughCmd: false } }, trust: { kind: 'none' }, ownSandbox: { yoloOff: own }, throughStartAgent: { trust: { kind: 'none' }, ownSandbox: { yoloOn: theirs }, serversOff: ['fresh'] } }] });
		const { whenYouStartIt, throughStartAgent } = JSON.parse(document.split('\n').filter(line => !line.startsWith('// ')).join('\n')).qwen;

		assert.deepStrictEqual({ whenYouStartIt, throughStartAgent }, {
			whenYouStartIt: {
				sandbox: { yoloOn: 'off', yoloOff: `on: ${own}; Facade leaves it as it is and has not verified that its tools connect from inside it` },
				facadeTools: 'never asked: its launch exempts only Facade\'s server from approval',
				approvalsWithYoloOff: 'asks you, as its CLI does',
				questions: 'kept: it can show a question for you to answer, as it does outside Facade'
			},
			throughStartAgent: {
				sandbox: { yoloOn: `on: ${theirs}; Facade leaves it as it is and has not verified that its tools connect from inside it`, yoloOff: 'off' },
				facadeTools: 'never asked: its launch exempts only Facade\'s server from approval',
				approvalsWithYoloOff: 'asks, as its CLI does: it has no setting that denies without asking, so with no one watching it can wait at an approval prompt',
				questions: 'removed by its launch\'s questions group: it asks through Facade messages',
				projectMcpServers: 'with YOLO off, turned off for the run so that it does not stop to ask about them, since you have not approved them for this project: fresh'
			}
		});
	});

	test('Show Agent Launch says what an agent started through start_agent gets in the environment and with the settings its launch\'s unattended part gives it - where its trust goes, and a deny rule there that refuses it Facade\'s tools - beside what the person\'s own gets, each one\'s trust shown where the two differ (L9; L10)', () => {
		const temp = tempDir('facade-starters-');
		try {
			const [home, bots, lab] = ['home', 'bots', 'lab'].map(name => path.join(temp.dir, name));
			for (const dir of [home, bots, lab]) {
				fs.mkdirSync(dir);
			}
			// A separate account for the agents tools start, which refuses them Facade's tools
			fs.writeFileSync(path.join(bots, 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp__facade'] } }));
			const yours = { unattended: { environment: { CLAUDE_CONFIG_DIR: bots } } };
			const config = readCliConfig(claudeCli, name => name === 'launch' ? yours : undefined);
			const place = { folder: lab, repository: lab };
			const terminal = { HOME: home, USERPROFILE: home };
			const theirs = starterFacts(claudeCli, config, place, terminal, false);
			const document = launchDocument({ folder: lab, yolo: false, framework: true, clis: [{ cli: claudeCli, config, yours, program: { target: { executable: '/bin/claude', args: [], throughCmd: false } }, trust: theirs.trust, ...(theirs.overridden !== undefined ? { overridden: theirs.overridden } : {}), throughStartAgent: starterFacts(claudeCli, config, place, terminal, true) }] });
			const shown = JSON.parse(document.split('\n').filter(line => !line.startsWith('// ')).join('\n')).claude;

			assert.deepStrictEqual({
				whenYouStartIt: [shown.whenYouStartIt.facadeTools, shown.whenYouStartIt.trust?.file],
				throughStartAgent: [shown.throughStartAgent.facadeTools, shown.throughStartAgent.trust?.file],
				both: shown.trust
			}, {
				whenYouStartIt: ['never asked: its launch exempts only Facade\'s server from approval', path.join(home, '.claude.json')],
				throughStartAgent: [`denied: ${path.join(bots, 'settings.json')} blocks mcp__facade, overriding Facade's allow rule: with YOLO off, Claude Code denies Facade tools`, path.join(bots, '.claude.json')],
				both: undefined
			});
		} finally {
			temp.remove();
		}
	});

	test('a CLI told of its task in its terminal has no task group: one the person sets is wrong, and is never given', () => {
		const config = readCliConfig(antigravityCli, name => name === 'launch' ? { arguments: { task: ['--prompt', '${task}'] } } : undefined);

		assert.deepStrictEqual({ wrong: config.wrong, given: antigravityCli.launch(inputFor(antigravityCli, { config, task: 'Plan.' }), '/bin/agy').args.includes('--prompt') }, {
			wrong: ['Unknown argument group \'task\' in facade.agents.antigravity.launch.arguments. Antigravity accepts: warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra'],
			given: false
		});
	});

	test('Codex takes its effort as one TOML string, written as TOML writes one, whatever is in it: a quote or a line break does not end it, a backslash, a control character and DEL are escaped, other characters kept; half a character no TOML can hold is refused (X-61)', () => {
		const effort = (given: string) => {
			const { args } = codexCli.launch(inputFor(codexCli, { effort: given }), '/bin/codex');
			return args[args.indexOf('--model') + 3];
		};

		assert.deepStrictEqual([effort('max'), effort('high" sandbox_mode = "danger'), effort('two\nlines'), effort('a\\b\u0001\u007Fé'), (() => {
			try {
				return effort('x\uD800');
			} catch (err) {
				return (err as Error).message;
			}
		})()], [
			'model_reasoning_effort="max"',
			'model_reasoning_effort="high\\" sandbox_mode = \\"danger"',
			'model_reasoning_effort="two\\nlines"',
			'model_reasoning_effort="a\\\\b\\u0001\\u007Fé"',
			'"x\\ud800" contains an unpaired UTF-16 surrogate and cannot be stored in Codex\'s TOML configuration.'
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
			first: [`Merged trust entry ${entry} into ${config}; Claude Code is now configured to trust ${worktree.folder}.`, `Trust entry ${entry} already exists in ${config}; Claude Code was already configured to trust ${worktree.folder}.`],
			made: { projects: { [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			merged: `Merged trust entry ${entry} into ${config}; Claude Code is now configured to trust ${worktree.folder}.`,
			after: { theme: 'dark', projects: { 'C:/Other': { allowedTools: [] }, [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			layout: [true, true],
			locked: [config, config, config]
		});
	});

	test('a file that is not a JSON object, or a value in it of another kind than what would be merged there - projects that are not an object, a project that is not one, a list that is not a list - is left alone, and why is said: what the file holds, or the keys of that value; so is a file that kept changing as it was read (L11)', () => {
		const file = path.join(temp.dir, 'settings.json');
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		// Its own problem, as a start refused for it says it first
		const why = (entry: { readonly [key: string]: unknown }) => trustProblem(antigravityCli, readCliConfig(antigravityCli, name => name === 'launch' ? { trust: { file, merge: entry } } : undefined), { folder: repository, repository }, {})?.split(', so Facade')[0];
		const left = (content: string, entry: { readonly [key: string]: unknown }) => {
			fs.writeFileSync(file, content);
			return [mergeIntoJsonFile(file, entry, lock), fs.readFileSync(file, 'utf8') === content, why(entry)];
		};
		const project = { projects: { 'C:/Lab': { hasTrustDialogAccepted: true } } };
		const table = [
			left('{ not json', project),
			left('[]', project),
			left('{"projects":[]}', project),
			left('{"projects":{"C:/Lab":true}}', project),
			left('{"trustedWorkspaces": "everything"}', { trustedWorkspaces: ['C:\\Lab'] }),
			left('{"trustedWorkspaces": {"C:\\\\Lab": true}}', { trustedWorkspaces: ['C:\\Lab'] })
		];
		// Written again, longer, as each read of it ends: it never holds still
		fs.writeFileSync(file, '{}');
		let longer = 0;
		const restore = replaceFsFunction('readFileSync', original => ((...args: Parameters<typeof fs.readFileSync>) => {
			const text = original(...args);
			if (args[0] === file) {
				fs.writeFileSync(file, `{${' '.repeat(++longer)}}`);
			}
			return text;
		}) as typeof fs.readFileSync);
		let changing: unknown[];
		try {
			changing = [mergeIntoJsonFile(file, project, lock), why(project)];
		} finally {
			restore();
		}

		const otherKind = (keys: string) => `${file} contains an incompatible value at ${JSON.stringify(keys)}; Antigravity expects a different type there. Facade cannot configure Antigravity to trust ${repository}. Correct the file, or set facade.agents.antigravity.launch.trust to null so Antigravity can ask for trust itself.`;
		assert.deepStrictEqual({ table, changing }, {
			table: [
				['unreadable', true, `${file} is not valid JSON: Expected a key at offset 2. Facade cannot configure Antigravity to trust ${repository}. Correct the file, or set facade.agents.antigravity.launch.trust to null so Antigravity can ask for trust itself.`],
				['unreadable', true, `${file} contains an array; expected a JSON object. Facade cannot configure Antigravity to trust ${repository}. Correct the file, or set facade.agents.antigravity.launch.trust to null so Antigravity can ask for trust itself.`],
				['unreadable', true, otherKind('projects')],
				['unreadable', true, otherKind('projects.C:/Lab')],
				['unreadable', true, otherKind('trustedWorkspaces')],
				['unreadable', true, otherKind('trustedWorkspaces')]
			],
			changing: ['unreadable', `${file} kept changing during the read. Facade cannot configure Antigravity to trust ${repository}. Correct the file, or set facade.agents.antigravity.launch.trust to null so Antigravity can ask for trust itself.`]
		});
	});

	test('a file with comments and trailing commas, as a settings file has them, is merged into, not left alone; and only where the entry goes: its comments, a number too large for JavaScript, a key written twice, its line endings and its layout - compact, or a line comment after its last part - stay as they were; a file that has the entry already is not written (X-48)', () => {
		const file = path.join(temp.dir, 'settings.json');
		const merged = (content: string, entry: { readonly [key: string]: unknown }) => {
			fs.writeFileSync(file, content);
			return [mergeIntoJsonFile(file, entry, lock), fs.readFileSync(file, 'utf8')];
		};
		const project = { projects: { '/lab': { hasTrustDialogAccepted: true } } };
		const theirs = '{\n  // the person\'s note\n  "theme": "dark", /* theirs */\n  "trustedWorkspaces": [\n    "/a", // first\n  ],\n}\n';

		assert.deepStrictEqual({
			jsonc: merged(theirs, { trustedWorkspaces: ['/lab'] }),
			compact: merged('{"id":12345678901234567890,"a":1,"a":2,"projects":{}}', project),
			comment: merged('{\n\t"a": 1 // one\n}', { b: ['/x'] }),
			crlf: merged('{\r\n  "projects": null\r\n}\r\n', project),
			there: merged(theirs.replace('"/a", // first', '"/a", "/lab", // first'), { trustedWorkspaces: ['/lab'] })
		}, {
			jsonc: ['written', '{\n  // the person\'s note\n  "theme": "dark", /* theirs */\n  "trustedWorkspaces": [\n    "/a", // first\n    "/lab",\n  ],\n}\n'],
			compact: ['written', '{"id":12345678901234567890,"a":1,"a":2,"projects":{"/lab":{"hasTrustDialogAccepted":true}}}'],
			comment: ['written', '{\n\t"a": 1, // one\n\t"b": [\n\t\t"/x"\n\t]\n}'],
			crlf: ['written', '{\r\n  "projects": {\r\n    "/lab": {\r\n      "hasTrustDialogAccepted": true\r\n    }\r\n  }\r\n}\r\n'],
			there: ['there', theirs.replace('"/a", // first', '"/a", "/lab", // first')]
		});
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

	test('Antigravity\'s trust in a folder is merged into its settings once, by the folder as its agent starts in it - through a link, the link: Antigravity trusts exact folders, as its working directory names them (N-85) - into a file that is not there yet or beside what the file holds, laid out as it is; a folder listed already in another case or with other slashes is left as it is, one listed through another link is not', () => {
		const worktree = path.join(temp.dir, 'Clamp');
		fs.mkdirSync(worktree);
		const { home, env } = homeIn('home');
		const settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
		const trusted = { folder: worktree, repository: path.join(temp.dir, 'Lab') };
		const entry = JSON.stringify({ trustedWorkspaces: [path.resolve(worktree)] });
		const outcomes = [writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text, writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text];
		const first = JSON.parse(fs.readFileSync(settings, 'utf8'));
		const theirs = `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me"\n\t]\n}`;
		fs.writeFileSync(settings, theirs);
		writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;
		const after = fs.readFileSync(settings, 'utf8');
		const other = process.platform === 'win32' ? path.resolve(worktree).toUpperCase().split('\\').join('/') : path.resolve(worktree);
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [other] }));
		const listed = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;
		// The same folder through a link of its own: listed so, it is not the folder its agent starts in. An agent
		// started through the link is trusted there, as Antigravity's working directory names it (PS-02's L).
		const link = path.join(temp.dir, 'clamp-link');
		fs.symlinkSync(worktree, link, 'junction');
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [link] }));
		const linked = writeTrust(antigravityCli, antigravityCli.defaults, trusted, lock, env)?.text;
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [fs.realpathSync.native(worktree)] }));
		writeTrust(antigravityCli, antigravityCli.defaults, { ...trusted, folder: link }, lock, env);
		const throughLink = JSON.parse(fs.readFileSync(settings, 'utf8'));

		assert.deepStrictEqual({ outcomes, first, after, listed, linked, throughLink, locked: locked.length }, {
			outcomes: [`Merged trust entry ${entry} into ${settings}; Antigravity is now configured to trust ${worktree}.`, `Trust entry ${entry} already exists in ${settings}; Antigravity was already configured to trust ${worktree}.`],
			first: { trustedWorkspaces: [path.resolve(worktree)] },
			after: `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me",\n\t\t${JSON.stringify(path.resolve(worktree))}\n\t]\n}`,
			listed: `Trust entry ${entry} already exists in ${settings}; Antigravity was already configured to trust ${worktree}.`,
			linked: `Merged trust entry ${entry} into ${settings}; Antigravity is now configured to trust ${worktree}.`,
			throughLink: { trustedWorkspaces: [fs.realpathSync.native(worktree), link] },
			locked: 6
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
			// Its specific problem said (L11)
			unreadable: `${path.join(temp.dir, 'qclaude', '.claude.json')} could not be read: EISDIR: illegal operation on a directory, read. Facade left the file unchanged and could not configure Claude Code to trust ${repository}. Correct the file, or set facade.agents.claude.launch.trust to null so Claude Code can ask for trust itself.`,
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
			moved: `Merged trust entry ${JSON.stringify({ trustedWorkspaces: [fs.realpathSync.native(repository)] })} into ${path.join(home, 'agy', 'trusted.json')}; Antigravity is now configured to trust ${repository}.`,
			content: { trustedWorkspaces: [fs.realpathSync.native(repository)] },
			unknown: 'Setting \'facade.agents.antigravity.launch.trust.merge\' contains an unknown variable \'${repo}\'. Supported variables: ${home}, ${folder}, ${repository}.',
			none: undefined
		});
	});

	test('every CLI\'s trust has the values L9 lists - its folder, its repository and the home folder its terminal has - each as that CLI keeps it; and a launch\'s `${home}` is that home too, not Facade\'s own (X-58; C-LAUNCH-04; C-LAUNCH-34)', () => {
		const repository = path.join(temp.dir, 'Lab');
		const folder = path.join(repository, 'src');
		fs.mkdirSync(folder, { recursive: true });
		const { home, env } = homeIn('terminal-home');
		const trusted = { folder, repository };
		const target = (cli: AgentCli, trust: unknown) => trustTarget(cli, readCliConfig(cli, name => name === 'launch' ? { trust } : undefined), trusted, env);
		const extra = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { extra: ['--home', '${home}'] } } : undefined);
		const args = codexCli.launch(inputFor(codexCli, { config: extra, home }), '/bin/codex').args;

		assert.deepStrictEqual({
			claude: target(claudeCli, { file: '${home}/claude.json', merge: { projects: { '${folder}': { trusted: true } } } }),
			antigravity: target(antigravityCli, { file: '${home}/agy.json', merge: { trustedWorkspaces: ['${repository}'] } }),
			codex: target(codexCli, { file: '${home}/codex.json', merge: { trusted: ['${folder}'] } }),
			home: args.slice(args.indexOf('--home'), args.indexOf('--home') + 2)
		}, {
			claude: { file: path.join(home, 'claude.json'), entry: { projects: { [fs.realpathSync.native(folder).replace(/\\/g, '/')]: { trusted: true } } } },
			antigravity: { file: path.join(home, 'agy.json'), entry: { trustedWorkspaces: [fs.realpathSync.native(repository)] } },
			codex: { file: path.join(home, 'codex.json'), entry: { trusted: [fs.realpathSync.native(folder)] } },
			home: ['--home', home]
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
			'Setting \'facade.agents.antigravity.launch.trust.file\' must be an absolute path; received \'agy/trusted.json\'. For example, use a path under ${home}.',
			'Setting \'facade.agents.antigravity.launch.trust.file\' must be an absolute path; received \'~agy/trusted.json\'. For example, use a path under ${home}.'
		]);
	});

	test('Qwen Code\'s trust in a folder is merged into its trusted folders as an entry for that very folder - it trusts the folders inside one, not the worktrees beside it - kept where it reads it: in QWEN_HOME, a ~ in that the home folder and a relative one from the folder the agent starts in, else in .qwen in the home folder; or in the file QWEN_CODE_TRUSTED_FOLDERS_PATH names - each, where its environment has none, as it takes it from the .env of its own folder, of the home folder, or of the folder a QWEN_HOME found so names', () => {
		const lab = path.join(temp.dir, 'Lab');
		fs.mkdirSync(lab);
		const { home, env } = homeIn('home');
		const targetOf = (more: object) => trustTarget(qwenCli, qwenCli.defaults, { folder: lab, repository: lab }, { ...env, ...more });
		const entry = { [canonicalFolder(lab)]: 'TRUST_FOLDER' };
		const dotenv = (file: string, text: string) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		};
		const set = [targetOf({}), targetOf({ QWEN_HOME: '~/qh' }), targetOf({ QWEN_HOME: 'rel' }), targetOf({ QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(temp.dir, 'trust.json') })];
		dotenv(path.join(home, '.env'), '# the home folder\'s\nexport QWEN_HOME=~/fromenv\n');
		const fromHomeEnv = targetOf({});
		const setWins = targetOf({ QWEN_HOME: '~/qh' });
		dotenv(path.join(home, 'fromenv', '.env'), `QWEN_CODE_TRUSTED_FOLDERS_PATH='${path.join(temp.dir, 'found.json')}'\n`);
		const fromItsOwn = targetOf({});

		assert.deepStrictEqual({ set, fromHomeEnv, setWins, fromItsOwn }, {
			set: [
				{ file: path.join(home, '.qwen', 'trustedFolders.json'), entry },
				{ file: path.join(home, 'qh', 'trustedFolders.json'), entry },
				{ file: path.join(lab, 'rel', 'trustedFolders.json'), entry },
				{ file: path.join(temp.dir, 'trust.json'), entry }
			],
			fromHomeEnv: { file: path.join(home, 'fromenv', 'trustedFolders.json'), entry },
			setWins: { file: path.join(home, 'qh', 'trustedFolders.json'), entry },
			fromItsOwn: { file: path.join(temp.dir, 'found.json'), entry }
		});
	});
});

suite('CLIs: the person\'s own configuration a launch would mix Facade\'s into', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-conflict-');
	});

	teardown(() => {
		temp.remove();
	});

	test('Claude Code: a deny rule that takes Facade\'s tools - in its launch\'s settings, the person\'s own settings, or the project\'s - is found, where and which; one for other tools, or none, is not (L4, rule 4; X-38; YO-09)', () => {
		const home = path.join(temp.dir, 'claude-home');
		const folder = path.join(temp.dir, 'lab');
		fs.mkdirSync(home);
		fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
		const env = { HOME: temp.dir, CLAUDE_CONFIG_DIR: home };
		const deny = (...rules: string[]) => JSON.stringify({ permissions: { deny: rules } });
		const inLaunch = readCliConfig(claudeCli, name => name === 'launch' ? { settings: { permissions: { deny: ['mcp__facade'] } } } : undefined);
		const found = () => claudeDenyOf(claudeCli.defaults, env, folder);

		const none = found();
		fs.writeFileSync(path.join(folder, '.claude', 'settings.local.json'), deny('Bash(rm:*)', 'mcp__facade__stop_agent'));
		const project = found();
		fs.writeFileSync(path.join(home, 'settings.json'), deny('mcp__facade'));
		const own = found();
		fs.writeFileSync(path.join(home, 'settings.json'), deny('mcp__facadeish'));
		fs.rmSync(path.join(folder, '.claude', 'settings.local.json'));

		assert.deepStrictEqual({ none, project, own, other: found(), launch: claudeDenyOf(inLaunch, env, folder) }, {
			none: undefined,
			project: { where: path.join(folder, '.claude', 'settings.local.json'), rule: 'mcp__facade__stop_agent' },
			own: { where: path.join(home, 'settings.json'), rule: 'mcp__facade' },
			other: undefined,
			launch: { where: 'facade.agents.claude.launch.settings', rule: 'mcp__facade' }
		});
	});

	test('Codex: a server of the person\'s named facade - in its own config.toml, as a table, a dotted key or an inline table, or in the project\'s .codex/config.toml up to the repository - is named, its file with it; a name only like it, the words in a string, a file that is no TOML, or a launch without Facade\'s server name nothing (X-47; C-LAUNCH-28)', () => {
		const home = path.join(temp.dir, 'codex-home');
		const repository = path.join(temp.dir, 'lab');
		const folder = path.join(repository, 'src');
		fs.mkdirSync(home);
		fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
		fs.mkdirSync(folder);
		const env = { HOME: temp.dir, CODEX_HOME: home };
		const withServer = codexCli.launch(inputFor(codexCli, { folder }), '/bin/codex').args;
		const without = codexCli.launch(inputFor(codexCli, { folder, connection: undefined }), '/bin/codex').args;
		const user = path.join(home, 'config.toml');
		const named = (text: string, args = withServer) => {
			fs.writeFileSync(user, text);
			return codexCli.conflict?.(args, folder, env, codexCli.defaults) !== undefined;
		};

		const conflicts = {
			table: named('model = "o4"\n\n[mcp_servers.facade]\nurl = "http://localhost:9"\n'),
			subtable: named('[mcp_servers."facade".env]\nTOKEN_NAME = "x"\n'),
			dotted: named('mcp_servers.facade.url = "http://localhost:9" # theirs\n'),
			underServers: named('[mcp_servers]\nfacade = { url = "http://localhost:9" }\n'),
			inline: named('mcp_servers = { other = { command = "x" }, facade = { command = "y", args = ["a", "b"] } }\n'),
			arrayOfTables: named('[[mcp_servers.facade]]\nurl = "x"\n'),
			likeIt: named('[mcp_servers.facade-old]\ncommand = "x"\n[mcp_servers.facadex]\ncommand = "y"\n[profiles.facade]\nmodel = "o4"\nfacade = 1\n'),
			inAString: named('notes = """\n[mcp_servers.facade]\nurl = "x"\n"""\nother = \'mcp_servers.facade.url = 1\'\n'),
			noToml: named('[mcp_servers.facade\nurl = \n'),
			frameworkOff: named('[mcp_servers.facade]\nurl = "x"\n', without)
		};
		fs.writeFileSync(user, 'model = "o4"\n');
		fs.mkdirSync(path.join(repository, '.codex'));
		fs.writeFileSync(path.join(repository, '.codex', 'config.toml'), '[mcp_servers]\nfacade.url = "http://localhost:9"\n');
		const project = codexCli.conflict?.(withServer, folder, env, codexCli.defaults);

		assert.deepStrictEqual({ conflicts, project }, {
			conflicts: { table: true, subtable: true, dotted: true, underServers: true, inline: true, arrayOfTables: true, likeIt: false, inAString: false, noToml: false, frameworkOff: false },
			project: `${path.join(repository, '.codex', 'config.toml')} already defines an MCP server named facade. Codex would merge Facade's server into that entry. Rename or remove the existing entry.`
		});
	});

	/** Qwen Code's settings files in the folder of a test - the administrator's, the person's and the project's - and the environment that has it read them. */
	function qwenPlace() {
		const home = path.join(temp.dir, 'home');
		const folder = path.join(temp.dir, 'lab');
		const admin = path.join(temp.dir, 'admin', 'settings.json');
		const user = path.join(home, '.qwen', 'settings.json');
		const project = path.join(folder, '.qwen', 'settings.json');
		for (const file of [admin, user, project]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
		}
		const settings = (files: { readonly [file: string]: object }) => {
			for (const file of [admin, user, project]) {
				fs.writeFileSync(file, JSON.stringify(files[file] ?? {}));
			}
		};
		return { folder, admin, user, project, settings, env: { [HOME_VARIABLE]: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: admin } };
	}

	test('Qwen Code: what would keep Facade\'s server from it, as it reads it for the launch, is named where it is - the person\'s own option that turns it off, or that allows servers without it, in place of the settings\' lists; mcp.excluded naming it in any scope, by its name now or an older one; mcp.allowed of all its scopes together without it, an empty one too; its tool sandbox, which its project cannot set, with which it refuses to start - the launch\'s own settings counted over the administrator\'s, a list of theirs added to the administrator\'s; a launch without Facade\'s server names none (O9)', () => {
		const { folder, admin, user, project, settings, env } = qwenPlace();
		const withServer = qwenCli.launch(inputFor(qwenCli, { folder, effort: undefined, env }), '/bin/qwen').args;
		const without = qwenCli.launch(inputFor(qwenCli, { folder, effort: undefined, env, connection: undefined }), '/bin/qwen').args;
		const launchWith = (own: object) => readCliConfig(qwenCli, name => name === 'launch' ? { settings: own } : undefined);
		const conflictWith = (files: { readonly [file: string]: object }, args: readonly string[] = withServer, config = qwenCli.defaults) => {
			settings(files);
			return qwenCli.conflict?.(args, folder, env, config);
		};
		const executionSandbox = { executionSandbox: { filesystem: 'workspace-write', network: 'open' } };
		const sandboxed = `${user} sets tools.executionSandbox, with which Qwen Code refuses to start with Facade's MCP server, task and folders. Remove that setting to use Qwen Code as a Facade agent.`;

		assert.deepStrictEqual({
			none: conflictWith({}),
			excluded: conflictWith({ [user]: { mcp: { excluded: ['fac*'] } } }),
			excludedOlder: conflictWith({ [project]: { excludeMCPServers: ['facade'] } }) !== undefined,
			allowedWithout: conflictWith({ [admin]: { mcp: { allowed: ['github'] } } }),
			allowedTogether: conflictWith({ [admin]: { mcp: { allowed: ['github'] } }, [project]: { mcp: { allowed: ['facade'] } } }),
			allowedEmpty: conflictWith({ [user]: { mcp: { allowed: [] } } }),
			sandbox: conflictWith({ [user]: { tools: executionSandbox } }),
			sandboxNotValid: conflictWith({ [user]: { tools: { executionSandbox: true } } }),
			projectSandbox: conflictWith({ [project]: { tools: executionSandbox } }),
			frameworkOff: conflictWith({ [user]: { mcp: { excluded: ['facade'] } } }, without),
			theirOption: conflictWith({ [user]: { mcp: { excluded: ['facade'] } } }, [...withServer, '--allowed-mcp-server-names', 'github', 'facade']),
			theirOptionWithout: conflictWith({}, [...withServer, '--allowedMcpServerNames=github,gitlab']),
			theirOptionAndSandbox: conflictWith({ [user]: { tools: executionSandbox } }, [...withServer, '--allowed-mcp-server-names', 'fac*']),
			turnedOff: conflictWith({}, [...withServer, '--disable-mcp-server', 'github,facade']),
			inLaunch: conflictWith({}, withServer, launchWith({ mcp: { excluded: ['facade'] } })),
			launchListAdded: conflictWith({ [admin]: { mcp: { excluded: ['facade'] } } }, withServer, launchWith({ mcp: { excluded: [] } })),
			launchBesideAdmin: conflictWith({ [admin]: { mcp: { excluded: ['facade'] } } }, withServer, launchWith({ ui: { hideTips: true } }))
		}, {
			none: undefined,
			excluded: `${user} excludes the MCP server named facade (mcp.excluded contains "fac*"), so Qwen Code would not load Facade tools. Remove that entry.`,
			excludedOlder: true,
			allowedWithout: `${admin} limits Qwen Code to the MCP servers in mcp.allowed, which does not include facade, so Qwen Code would not load Facade tools. Add "facade" to mcp.allowed.`,
			allowedTogether: undefined,
			allowedEmpty: `${user} limits Qwen Code to the MCP servers in mcp.allowed, which does not include facade, so Qwen Code would not load Facade tools. Add "facade" to mcp.allowed.`,
			sandbox: sandboxed,
			sandboxNotValid: sandboxed,
			projectSandbox: undefined,
			frameworkOff: undefined,
			theirOption: undefined,
			theirOptionWithout: 'facade.agents.qwen.launch.arguments limits Qwen Code to the MCP servers in --allowed-mcp-server-names, which does not include facade, so Qwen Code would not load Facade tools. Add "facade" to --allowed-mcp-server-names.',
			theirOptionAndSandbox: sandboxed,
			turnedOff: 'facade.agents.qwen.launch.arguments turns off the MCP server named facade (--disable-mcp-server facade), so Qwen Code would not load Facade tools. Remove that value.',
			inLaunch: 'facade.agents.qwen.launch.settings excludes the MCP server named facade (mcp.excluded contains "facade"), so Qwen Code would not load Facade tools. Remove that entry.',
			launchListAdded: `${admin} excludes the MCP server named facade (mcp.excluded contains "facade"), so Qwen Code would not load Facade tools. Remove that entry.`,
			launchBesideAdmin: `${admin} excludes the MCP server named facade (mcp.excluded contains "facade"), so Qwen Code would not load Facade tools. Remove that entry.`
		});
	});

	test('Qwen Code: a rule that denies one of Facade\'s tools - in its launch\'s settings, or in the administrator\'s, the person\'s own or the project\'s settings, by its name now or an older one, or by a pattern that takes them in - is found, where and which; one for other tools, or none, is not; a list of the launch\'s settings is added to the administrator\'s (L4, rule 4)', () => {
		const { folder, admin, user, project, settings, env } = qwenPlace();
		const launchWith = (own: object) => readCliConfig(qwenCli, name => name === 'launch' ? { settings: own } : undefined);
		const deniedBy = (files: { readonly [file: string]: object }, config = qwenCli.defaults) => {
			settings(files);
			return qwenCli.exemptionOverride?.(config, env, folder);
		};

		assert.deepStrictEqual({
			none: deniedBy({}),
			others: deniedBy({ [user]: { permissions: { deny: ['run_shell_command', 'mcp__github__*'] } } }),
			user: deniedBy({ [user]: { permissions: { deny: ['mcp__facade__*'] } } }),
			older: deniedBy({ [project]: { tools: { exclude: ['mcp__facade__send_message'] } } }),
			pattern: deniedBy({ [admin]: { permissions: { deny: ['mcp__*'] } } }),
			launch: deniedBy({}, launchWith({ permissions: { deny: ['mcp__facade'] } })),
			launchListAdded: deniedBy({ [admin]: { permissions: { deny: ['mcp__*'] } } }, launchWith({ permissions: { deny: [] } }))
		}, {
			none: undefined,
			others: undefined,
			user: `${user} denies mcp__facade__*`,
			older: `${project} denies mcp__facade__send_message`,
			pattern: `${admin} denies mcp__*`,
			launch: 'facade.agents.qwen.launch.settings denies mcp__facade',
			launchListAdded: `${admin} denies mcp__*`
		});
	});

	test('Qwen Code: its own sandbox is found where a launch leaves it on, as it decides it - by QWEN_SANDBOX in the environment it starts with, Facade\'s false with YOLO on under the launch\'s own, or by tools.sandbox in the highest scope that sets it, never the project\'s, the launch\'s own settings over the administrator\'s - and the agent\'s sandbox is said on; QWEN_SANDBOX set to false, or the sandbox it runs in already, leaves none (L4)', () => {
		const { folder, admin, user, project, settings, env } = qwenPlace();
		const launchWith = (launch: object) => readCliConfig(qwenCli, name => name === 'launch' ? launch : undefined);
		const ownOf = (files: { readonly [file: string]: object }, more: object = {}, config = qwenCli.defaults, yolo = false) => {
			settings(files);
			return qwenCli.ownSandbox?.(config, yolo, { ...env, ...more }, folder);
		};
		const theirs = launchWith({ environment: { QWEN_SANDBOX: 'docker' } });
		const uses = (yolo: boolean) => ({ framework: true, yolo, model: false, effort: false, task: false, trust: true });
		const found = {
			none: ownOf({}),
			byEnvironment: ownOf({}, { QWEN_SANDBOX: 'docker' }),
			offByEnvironment: ownOf({ [user]: { tools: { sandbox: true } } }, { QWEN_SANDBOX: 'false' }),
			user: ownOf({ [user]: { tools: { sandbox: 'podman' } } }),
			adminOverUser: ownOf({ [user]: { tools: { sandbox: true } }, [admin]: { tools: { sandbox: false } } }),
			project: ownOf({ [project]: { tools: { sandbox: true } } }),
			inOne: ownOf({ [user]: { tools: { sandbox: true } } }, { SANDBOX: 'qwen-code-sandbox' }),
			yoloOn: ownOf({ [user]: { tools: { sandbox: true } } }, {}, qwenCli.defaults, true),
			yoloOnTheirs: ownOf({}, {}, theirs, true),
			inLaunch: ownOf({}, {}, launchWith({ settings: { tools: { sandbox: true } } })),
			launchOverAdmin: ownOf({ [admin]: { tools: { sandbox: true } } }, {}, launchWith({ settings: { tools: { sandbox: false } } }))
		};
		settings({ [user]: { tools: { sandbox: true } } });
		const effective = [false, true].map(yolo => effectiveSandbox(qwenCli, qwenCli.defaults, uses(yolo), env, folder));
		settings({});
		const without = effectiveSandbox(qwenCli, qwenCli.defaults, uses(false), env, folder);
		const theirsWithYolo = effectiveSandbox(qwenCli, theirs, uses(true), env, folder);

		assert.deepStrictEqual({ found, effective, without, theirsWithYolo }, {
			found: {
				none: undefined,
				byEnvironment: 'QWEN_SANDBOX=docker in its environment',
				offByEnvironment: undefined,
				user: `tools.sandbox in ${user}`,
				adminOverUser: undefined,
				project: undefined,
				inOne: undefined,
				yoloOn: undefined,
				yoloOnTheirs: 'QWEN_SANDBOX=docker in its environment',
				inLaunch: 'tools.sandbox in facade.agents.qwen.launch.settings',
				launchOverAdmin: undefined
			},
			effective: ['on', 'off'],
			without: 'off',
			theirsWithYolo: 'on'
		});
	});

	test('Qwen Code: with YOLO off, one started through start_agent runs without the servers of its folder\'s project MCP configuration that the person has not decided on for the folder - its .mcp.json\'s, written as Claude Code reads one, and its project settings\', their variables expanded - which it would stop to ask about, and a doorbell\'s Enter would approve: they are rejected for the run in a copy of the person\'s approvals, theirs left as they are, each by the hash Qwen Code binds an approval to. Those approved or rejected, Facade\'s own and the administrator\'s it runs as it would; the person\'s own, and one with YOLO on, are not asked (L4, rule 3)', () => {
		const { folder, admin, project, settings, env } = qwenPlace();
		const home = path.join(temp.dir, 'home');
		const approvals = path.join(home, '.qwen', 'mcpApprovals.json');
		const keyOf = (dir: string) => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
		// Hashes from Qwen Code's own hashMcpServerConfig (0.25.3)
		const theirs = JSON.stringify({
			[path.resolve(folder)]: {
				approved: { hash: 'eb68c8fa4f95591509ad4b0ed440617b79113cabe813f7f834b3869dd27b85fa', status: 'approved' },
				stale: { hash: 'of an older configuration', status: 'approved' },
				rejected: { hash: '3cfe984956dfac02d7b0e1663e7b5861c39daaef98c0d67137bcf9c15eea097f', status: 'rejected' }
			},
			[path.resolve('/elsewhere')]: { other: { hash: 'x', status: 'approved' } }
		});
		fs.writeFileSync(approvals, theirs);
		fs.writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({
			mcpServers: {
				approved: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
				stale: { command: 'node', args: ['server.js', '--port', '9'], env: { TOKEN: 'x', A: '1' }, description: 'not part of the hash' },
				rejected: { type: 'http', url: 'https://example.invalid/mcp', headers: { Z: '1', A: '2' } },
				fresh: { type: 'sse', url: 'https://example.invalid/sse' },
				facade: { command: 'facade' },
				administered: { command: 'z' }
			}
		}));
		settings({ [admin]: { mcpServers: { administered: { command: 'z' } } }, [project]: { mcpServers: { inSettings: { env: { A: '${TOKEN}' }, command: '$TOOL_BIN/x' } } } });
		const config = readCliConfig(qwenCli, name => name === 'launch' ? { environment: { QWEN_CODE_SYSTEM_SETTINGS_PATH: admin, TOOL_BIN: '/opt/bin', TOKEN: 't' } } : undefined);
		const place = { folder, repository: folder };
		const offFor = (yolo: boolean, unattended: boolean) => qwenCli.projectServersOff?.(launchFor(config, unattended), place, home, yolo, unattended);
		const launched = (yolo: boolean) => qwenCli.launch(inputFor(qwenCli, { folder, config, env: { ...env, ...config.launch.environment }, yolo, unattended: true }), '/bin/qwen');
		const run = launched(false);
		const withYolo = launched(true);
		const runApprovals = run.files.find(each => path.basename(each.path) === '7.approvals.json');

		assert.deepStrictEqual({
			off: offFor(false, true),
			withYolo: offFor(true, true),
			persons: offFor(false, false),
			shown: starterFacts(qwenCli, config, place, { [HOME_VARIABLE]: home }, true).serversOff,
			env: run.env.QWEN_CODE_MCP_APPROVALS_PATH,
			runApprovals: JSON.parse(runApprovals?.content ?? 'null'),
			left: fs.readFileSync(approvals, 'utf8'),
			yoloOn: [withYolo.env.QWEN_CODE_MCP_APPROVALS_PATH, withYolo.files.some(each => path.basename(each.path) === '7.approvals.json')]
		}, {
			off: ['stale', 'fresh', 'inSettings'],
			withYolo: [],
			persons: [],
			shown: ['stale', 'fresh', 'inSettings'],
			env: path.join('/runs', '7.approvals.json'),
			runApprovals: {
				[keyOf('/elsewhere')]: { other: { hash: 'x', status: 'approved' } },
				[keyOf(folder)]: {
					approved: { hash: 'eb68c8fa4f95591509ad4b0ed440617b79113cabe813f7f834b3869dd27b85fa', status: 'approved' },
					stale: { hash: '52e27d506f065d14202a170923d57cd557bdc9aa7503e54ddcb78a426f051a64', status: 'rejected' },
					rejected: { hash: '3cfe984956dfac02d7b0e1663e7b5861c39daaef98c0d67137bcf9c15eea097f', status: 'rejected' },
					fresh: { hash: '61d5c0dd38bca97eb7f471424f8aa3fc95a765dca8aefb522adb17a0fcbd2ee7', status: 'rejected' },
					inSettings: { hash: 'f307e0ffb6f9f91e5e4fa242c25b3590eebf2354aa0b82582a159f05ea247e9f', status: 'rejected' }
				}
			},
			left: theirs,
			yoloOn: [undefined, false]
		});
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

	test('Qwen Code\'s own Windows installer is run as its launcher would run it - the Node it brings with the package\'s script, told the path of that launcher - from the launcher on PATH, which calls the package\'s, or from the package\'s own; the package\'s beside the launcher on PATH where the path it calls, in a folder whose name is not all ASCII, is not written as UTF-8; a .cmd that is neither, or whose Node is gone, and anywhere but Windows, are left to how any program is started (L10)', () => {
		const shim = write('qwen-code/qwen-code/bin/qwen.cmd', ['@echo off', 'setlocal', 'set "ROOT=%~dp0.."', 'set "QWEN_CODE_LAUNCHER_PATH=%ROOT%\\bin\\qwen.cmd"', '"%ROOT%\\node\\node.exe" "%ROOT%\\lib\\cli-entry.js" %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
		const onPath = write('qwen-code/bin/qwen.cmd', `@echo off\r\ncall "${shim}" %*\r\n`);
		const node = write('qwen-code/qwen-code/node/node.exe');
		const script = write('qwen-code/qwen-code/lib/cli-entry.js');
		const other = write('other/qwen.cmd', '@echo off\r\n"%~dp0\\qwen.exe" %*\r\n');
		// The path it calls written in a code page of Windows, not UTF-8: the e with its accent one byte
		const notUtf8 = path.join(path.dirname(onPath), 'qwen-cafe.cmd');
		fs.writeFileSync(notUtf8, Buffer.from(`@echo off\r\ncall "${path.join(temp.dir, `Caf${String.fromCharCode(0xe9)}`, 'qwen-code', 'bin', 'qwen.cmd')}" %*\r\n`, 'latin1'));
		const env = { PATH: path.join(temp.dir, 'nothing-here'), PATHEXT: '.EXE;.CMD' };
		const expected = { executable: node, args: [script], throughCmd: false, env: { QWEN_CODE_LAUNCHER_PATH: shim } };
		const found = {
			fromOnPath: qwenCli.launchTarget?.(onPath, 'win32', env),
			fromShim: qwenCli.launchTarget?.(shim, 'win32', env),
			notUtf8: qwenCli.launchTarget?.(notUtf8, 'win32', env),
			elsewhere: qwenCli.launchTarget?.(onPath, 'linux', env),
			neither: launchTargetOf(qwenCli, other, 'win32', env)
		};
		fs.rmSync(node);

		assert.deepStrictEqual({ ...found, gone: launchTargetOf(qwenCli, onPath, 'win32', env) }, {
			fromOnPath: expected,
			fromShim: expected,
			notUtf8: expected,
			elsewhere: undefined,
			neither: { executable: other, args: [], throughCmd: true },
			gone: { executable: onPath, args: [], throughCmd: true }
		});
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
			known: ['claude', 'codex', 'agy', 'muse', 'qwen'],
			installed: [['claude', first], ['agy', agy]],
			none: []
		});
	});

	test('a built-in this machine has that the person turned off is not among those Facade offers, and is found as turned off - why Start Agent offers none, where it offers none; one not on this machine is neither (L3)', () => {
		executable('bin', 'claude');
		executable('bin', 'codex');
		const env = { PATH: path.join(temp.dir, 'bin'), PATHEXT: '.EXE' };
		const configFor = (cli: AgentCli) => readCliConfig(cli, name => name === 'enabled' ? !['codex', 'agy'].includes(cli.id) : undefined);

		assert.deepStrictEqual({
			offered: installedClis(configFor, env).map(each => each.cli.id),
			turnedOff: turnedOffClis(configFor, env).map(cli => cli.id),
			noneOff: turnedOffClis(cli => cli.defaults, env)
		}, { offered: ['claude'], turnedOff: ['codex'], noneOff: [] });
	});

	test('the CLI Facade starts is the file its path setting names, or the command named there that PATH has; one with none there is not offered', () => {
		const own = executable('own', 'claude-nightly');
		const other = executable('bin', 'codex2');
		const env = { PATH: path.join(temp.dir, 'bin'), PATHEXT: '.EXE' };
		const paths: { [cli: string]: string } = { claude: own, codex: 'codex2', agy: path.join(temp.dir, 'gone', 'agy') };
		const installed = installedClis(cli => readCliConfig(cli, name => name === 'path' ? paths[cli.id] : undefined), env);

		assert.deepStrictEqual(installed.map(each => [each.cli.id, each.executable, each.config.path]), [['claude', own, own], ['codex', other, 'codex2']]);
	});

	test('a path set for a CLI is the file a terminal starting in the agent\'s folder takes it for - ~ its home, a relative one from that folder, not from Facade\'s - never PATH\'s in its place; one of only spaces is wrong, named (X-59; C-LAUNCH-14)', () => {
		const home = path.join(temp.dir, 'home');
		const inHome = executable(path.join('home', 'bin'), 'claude');
		const inFolder = executable(path.join('lab', 'tools'), 'claude');
		executable('path', 'claude');
		const env = { PATH: path.join(temp.dir, 'path'), HOME: home, USERPROFILE: home, PATHEXT: '.EXE' };
		const located = (configured: string, folder?: string) => locateCli(claudeCli, readCliConfig(claudeCli, name => name === 'path' ? configured : undefined), env, folder)?.executable;
		const name = `claude${process.platform === 'win32' ? '.exe' : ''}`;

		assert.deepStrictEqual({
			tilde: located(`~/bin/${name}`, path.join(temp.dir, 'lab')),
			relative: located(`tools/${name}`, path.join(temp.dir, 'lab')),
			relativeNowhere: located(`tools/${name}`),
			spaces: readCliConfig(claudeCli, item => item === 'path' ? '   ' : undefined).wrong
		}, {
			tilde: inHome,
			relative: inFolder,
			relativeNowhere: undefined,
			spaces: ['facade.agents.claude.path contains only spaces ("   "). Provide an executable path, or use an empty string to find claude on PATH']
		});
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
