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
import { claudeCli, claudeConfigFile, claudeDenyOf } from '../clis/claude';
import { AgentCli, ARG_GROUPS, capabilitiesOf, connectionFor, LaunchInput, launchFor, LaunchSpec, sandboxOf, skillMarkdown } from '../clis/cli';
import { codexCli } from '../clis/codex';
import { MAX_DELAY_MS, MAX_TIME_S, readCliConfig, readSeconds } from '../clis/config';
import { customAgentOf } from '../clis/custom';
import { launchDocument, starterFacts } from '../clis/describe';
import { launchTarget, unsafeForCmd, which } from '../clis/executable';
import { museCli } from '../clis/muse';
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
			plugin: { name: 'facade', version: '1.0.0', description: 'How to work in Facade Code with other agents and the person.', author: { name: 'Facade Code' } },
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
				{ removed: ['--yolo'], added: ['--careful'] }
			],
			startAgents: [
				{ removed: ['--dangerously-skip-permissions'], added: ['--permission-mode', 'dontAsk', '--allowedTools', 'mcp__facade', 'Edit(./**)'] },
				{ removed: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], added: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'features.hooks=false'] },
				{ removed: [], added: [] },
				{ removed: ['--disable-sandbox'], added: [] },
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
				shown: [undefined, 'with YOLO off, turned off for the run, so that it does not stop to ask about them - you have not approved them for this project: la13-own'],
				allApproved: ['facade'],
				allShown: 'with YOLO off, none turned off: this folder\'s .mcp.json has no server you have not approved for its project'
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
			{ args: [], files: [], injected: 0 }
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
			args: ['-i', `Reply with the single word ready, and nothing else. Nobody may be watching this terminal. ${OPENING}`, '--add-dir', '/record/messages', '--add-dir', '/record/screens', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash', '--effort', 'medium'],
			env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
			cwd: '/lab',
			files: [],
			injected: {
				'.agents/plugins/facade/plugin.json': { name: 'facade' },
				'.agents/plugins/facade/mcp_config.json': { mcpServers: { facade: MCP } },
				'.agents/plugins/facade/skills/facade/SKILL.md': SKILL_MD
			},
			task: 'terminal',
			persons: { args: ['-i', 'Reply with the single word ready, and nothing else.', '--add-dir', '/record/messages', '--add-dir', '/record/screens', '--mode', 'accept-edits', '--dangerously-skip-permissions'], env: {} }
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
					'facade.agents.codex.launch has sandbox, which Codex\'s launch does not have: it has arguments, environment, trust, enterDelay, taskDelay, unattended',
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
		const values = 'it has ${folder}, ${repository}, ${home}, ${messagesDir}, ${screensDir}, ${model}, ${effort}, ${executable}, ${shimFile}, ${pipe}, ${recordDir}, ${tokenFile}, ${waitMs}, ${mcpConfig}, ${settingsFile}, ${pluginDir}.';

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
			muse: { server: 'shared', ...each }
		});
	});

	test('a time the person sets in seconds is a whole number of them, from one to an hour; any other value is not made into one - its default is used, and that is said, naming the setting (X-59)', () => {
		const read = (value: unknown) => readSeconds('facade.agents.timeout', value, 120_000);
		const wrong = (shown: string) => ({ ms: 120_000, wrong: `facade.agents.timeout is ${shown}, which is no whole number of seconds from 1 to ${MAX_TIME_S}: 120 s, its default, is used` });

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
				unattended: Object.fromEntries(Object.entries(parts.unattended?.properties ?? {}).map(([part, schema]) => [part, part === 'arguments' ? Object.fromEntries(Object.entries(schema.properties ?? {}).map(([group, each]) => [group, each.default])) : schema.default])),
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
			sections: ['facade.agents', 'facade.agents.claude', 'facade.agents.codex', 'facade.agents.antigravity', 'facade.agents.muse', 'facade.agents.custom'],
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
				// Its unattended part, part by part, each group of it as completion fills it in (L4)
				unattended: { arguments: Object.fromEntries(ARG_GROUPS.filter(group => group !== 'task' || task === 'argument').map(group => [group, launch.unattended?.arguments[group]])), environment: launch.unattended?.environment, ...(launch.settings ? { settings: launch.unattended?.settings } : {}) },
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
		const candidates = ['bot', 'my.bot_2-x', '7up', 'a'.repeat(40), 'a'.repeat(41), 'My Bot', 'Bot', '-bot', '.bot', '', 'claude', 'codex', 'agy', 'muse', 'antigravity', 'human', 'you', 'me', 'facade', 'all', 'everyone', 'init', 'kernel'];

		assert.deepStrictEqual({
			names: candidates.map(name => [name, bySchema(name)]),
			says: texts[names?.errorMessage?.replace(/^%|%$/g, '') ?? '']
		}, {
			names: candidates.map(name => [name, customAgentNameProblem(name, builtIns) === undefined]),
			says: 'A custom agent\'s name is 1 to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit - not a built-in\'s id (claude, codex, agy, muse), nor human, you, me, facade, all, everyone, init or kernel.'
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
		// Codex whose connect group the person wrote without Facade's approval line, and what would refuse its start (X-38)
		const connect = codexCli.defaults.launch.arguments.connect?.filter(arg => !arg.includes('default_tools_approval_mode')).filter((arg, i, all) => !(arg === '-c' && (all[i + 1] === '-c' || all[i + 1] === '--no-daemon')));
		const theirConnect = readCliConfig(codexCli, name => name === 'launch' ? { arguments: { connect } } : undefined);
		const problems = ['Codex cannot be started: /home/.codex/config.toml has an MCP server of its own named facade, which Facade\'s server would be merged into. Rename that server there, or take it out.'];
		const theirs = parts(launchDocument({ folder: '/lab', yolo: false, framework: true, clis: [{ cli: codexCli, config: theirConnect, yours: { arguments: { connect } }, program: { target: { executable: '/bin/codex', args: [], throughCmd: false } }, trust: { kind: 'none' }, problems }] })).shown.codex;
		const sandboxOff = process.platform === 'win32' ? 'unavailable' : 'on';
		const yoursToAnswer = 'kept: it can put up a question for you to answer, as it does outside Facade';
		const toldInWords = 'kept: no launch can take its question tool away, so what it is told as it starts has it ask through Facade messages; asked for that tool by name, it can still put one up';
		const changedConnect = 'as your launch\'s connect group says: Facade\'s own lets its server through, and you changed it';

		assert.deepStrictEqual({
			comments: [on.comments.length, on.comments[0].includes('/lab'), on.comments[1].includes('YOLO is on'), parts(shownWith(false)).comments[1].includes('YOLO is off'), parts(shownWith({ wrong: 'facade.agents.yolo is "yes"' })).comments[1].includes('"yes"'), on.comments[2].includes('unattended part'), on.comments[3].includes('is on'), parts(shownWith(true, false)).comments[3].includes('is off')],
			shown: on.shown,
			theirs: { yours: theirs.whenYouStartIt.facadeTools, startAgent: theirs.throughStartAgent.facadeTools, cannotStart: theirs.cannotStart }
		}, {
			comments: [7, true, true, true, true, true, true, true],
			shown: {
				claude: {
					program: 'C:/tools/claude.cmd', throughCmd: true, offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'refused: /home/.claude/settings.json denies mcp__facade', approvalsWithYoloOff: 'asks you, as its CLI does', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'refused: /home/.claude/settings.json denies mcp__facade', approvalsWithYoloOff: 'its edits in its folder unasked; anything else that would ask is refused unasked', questions: 'taken away by its launch\'s questions group: it asks through Facade messages', projectMcpServers: 'with YOLO off, those of its folder\'s .mcp.json you have not approved for its project are turned off for the run, so that it does not stop to ask about them' },
					trust: { file: '/home/.claude.json', merge: { projects: { '/lab': { hasTrustDialogAccepted: true } } }, kept: 'for good: Facade never takes it back' }, wrongSettings: ['facade.agents.claude.launch has extra, which Claude Code\'s launch does not have: it has arguments, environment, trust, settings, enterDelay, taskDelay, unattended'], verified: '2.1.296', launch: JSON.parse(JSON.stringify(config.launch)), yourChanges: yours
				},
				codex: {
					program: 'C:/node/node.exe', script: 'C:/npm/codex.js', offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'never asked: its launch lets Facade\'s server through alone', approvalsWithYoloOff: 'asks you, as its CLI does', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: sandboxOff }, facadeTools: 'never asked: its launch lets Facade\'s server through alone', approvalsWithYoloOff: 'anything that would ask is refused unasked', questions: 'taken away by its launch\'s questions group: it asks through Facade messages' },
					trust: { arguments: ['-c', 'projects={ ${folder} = { trust_level = "trusted" } }'] }, verified: '0.162.1', launch: launch(codexCli), yourChanges: {}
				},
				muse: {
					program: 'C:/muse/muse.exe', offered: true, task: 'argument',
					whenYouStartIt: { sandbox: { yoloOn: 'off', yoloOff: 'on' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing, its sandbox still on', approvalsWithYoloOff: 'nothing asked, nothing refused: it cannot let Facade\'s tools alone through, so its approvals are off', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'off', yoloOff: 'on' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing, its sandbox still on', approvalsWithYoloOff: 'nothing asked, nothing refused: it cannot let Facade\'s tools alone through, so its approvals are off', questions: toldInWords },
					trust: 'none: the CLI asks whether you trust the folder', verified: '1.4.4', launch: launch(museCli), yourChanges: {}
				},
				antigravity: {
					program: 'not found: agy is not on the PATH a terminal there has', offered: true, task: 'typed',
					whenYouStartIt: { sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing; it has no sandbox', approvalsWithYoloOff: 'nothing asked, nothing refused: it cannot let Facade\'s tools alone through, so its approvals are off', questions: yoursToAnswer },
					throughStartAgent: { sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' }, facadeTools: 'never asked: it cannot let Facade\'s server alone through, so with YOLO off it asks for nothing; it has no sandbox', approvalsWithYoloOff: 'nothing asked, nothing refused: it cannot let Facade\'s tools alone through, so its approvals are off', questions: toldInWords },
					trust: 'cannot be given: the file is no absolute path', verified: '1.3.2', launch: launch(antigravityCli), yourChanges: {}
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
		const yours = 'kept: it can put up a question for you to answer, as it does outside Facade';

		assert.deepStrictEqual({
			claude: shown(claudeCli),
			codex: shown(codexCli),
			emptied: shown(claudeCli, { unattended: { arguments: { questions: null } } }),
			muse: shown(museCli),
			custom: shown(customAgentOf('mine', { path: '/bin/mine' }, undefined).cli)
		}, {
			claude: [yours, 'taken away by its launch\'s questions group: it asks through Facade messages'],
			codex: [yours, 'taken away by its launch\'s questions group: it asks through Facade messages'],
			emptied: [yours, 'kept: your launch empties its questions group, so it can put up a question that waits for someone to pick an answer'],
			muse: [yours, 'kept: no launch can take its question tool away, so what it is told as it starts has it ask through Facade messages; asked for that tool by name, it can still put one up'],
			custom: ['as your launch\'s questions group says', 'as your launch\'s questions group says']
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
				whenYouStartIt: ['never asked: its launch lets Facade\'s server through alone', path.join(home, '.claude.json')],
				throughStartAgent: [`refused: ${path.join(bots, 'settings.json')} denies mcp__facade, which wins over Facade's allow: with YOLO off, Claude Code refuses Facade's tools`, path.join(bots, '.claude.json')],
				both: undefined
			});
		} finally {
			temp.remove();
		}
	});

	test('a CLI told of its task in its terminal has no task group: one the person sets is wrong, and is never given', () => {
		const config = readCliConfig(antigravityCli, name => name === 'launch' ? { arguments: { task: ['--prompt', '${task}'] } } : undefined);

		assert.deepStrictEqual({ wrong: config.wrong, given: antigravityCli.launch(inputFor(antigravityCli, { config, task: 'Plan.' }), '/bin/agy').args.includes('--prompt') }, {
			wrong: ['facade.agents.antigravity.launch.arguments has task, which is no group of Antigravity\'s arguments: it has warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra'],
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
			'"x\\ud800" has half of a character in it, which Codex\'s configuration cannot hold.'
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

		const otherKind = (keys: string) => `${file} has ${JSON.stringify(keys)} as another kind of value than Antigravity writes there`;
		assert.deepStrictEqual({ table, changing }, {
			table: [
				['unreadable', true, `${file} is not valid JSON: A key was expected at offset 2`],
				['unreadable', true, `${file} holds a list, not a JSON object`],
				['unreadable', true, otherKind('projects')],
				['unreadable', true, otherKind('projects.C:/Lab')],
				['unreadable', true, otherKind('trustedWorkspaces')],
				['unreadable', true, otherKind('trustedWorkspaces')]
			],
			changing: ['unreadable', `${file} kept changing as it was read`]
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
			outcomes: [`Facade merged ${entry} into ${settings}: Antigravity trusts ${worktree} now.`, `${settings} has ${entry} already: Antigravity trusted ${worktree} before.`],
			first: { trustedWorkspaces: [path.resolve(worktree)] },
			after: `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me",\n\t\t${JSON.stringify(path.resolve(worktree))}\n\t]\n}`,
			listed: `${settings} has ${entry} already: Antigravity trusted ${worktree} before.`,
			linked: `Facade merged ${entry} into ${settings}: Antigravity trusts ${worktree} now.`,
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
			unreadable: `${path.join(temp.dir, 'qclaude', '.claude.json')} could not be read: EISDIR: illegal operation on a directory, read, so Facade left it alone and cannot give Claude Code the person's trust in ${repository}: put the file right, or set facade.agents.claude.launch.trust to null for Claude Code to ask.`,
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
			unknown: 'facade.agents.antigravity.launch.trust.merge has ${repo}, for which Facade has no value: it has ${home}, ${folder}, ${repository}.',
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
			'facade.agents.antigravity.launch.trust.file is "agy/trusted.json", which is no absolute path: start it with ${home}.',
			'facade.agents.antigravity.launch.trust.file is "~agy/trusted.json", which is no absolute path: start it with ${home}.'
		]);
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
			return codexCli.conflict?.(args, folder, env) !== undefined;
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
		const project = codexCli.conflict?.(withServer, folder, env);

		assert.deepStrictEqual({ conflicts, project }, {
			conflicts: { table: true, subtable: true, dotted: true, underServers: true, inline: true, arrayOfTables: true, likeIt: false, inAString: false, noToml: false, frameworkOff: false },
			project: `${path.join(repository, '.codex', 'config.toml')} has an MCP server of its own named facade, which Facade's server would be merged into. Rename that server there, or take it out.`
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
			spaces: ['facade.agents.claude.path is "   ", only spaces, which name no file: give the file, or leave it empty for the claude PATH finds']
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
