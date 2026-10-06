/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLock } from '../base/lock';
import { antigravityCli, antigravitySettingsFile, trustAntigravityWorkspace } from '../clis/antigravity';
import { claudeCli, claudeConfigFile, trustClaudeProject } from '../clis/claude';
import { AgentCli, fullAccessQuestion, LaunchInput, skillMarkdown } from '../clis/cli';
import { codexCli } from '../clis/codex';
import { cliModels, launchTarget, unsafeForCmd, which } from '../clis/executable';
import { museCli } from '../clis/muse';
import { installedClis, knownClis } from '../clis/registry';
import { replaceFsFunction, tempDir } from './util';

const BOM = String.fromCharCode(0xfeff);
const SKILL = { name: 'facade', description: 'How to work in Facade Code.', body: '# Working in Facade Code' };
const SKILL_MD = '---\nname: facade\ndescription: How to work in Facade Code.\n---\n\n# Working in Facade Code\n';
const MCP = { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', '/runs/7.token'], env: { ELECTRON_RUN_AS_NODE: '1' } };

/** What a launch of `cli` is given, as the core gives it for PID 7. */
function inputFor(cli: AgentCli, overrides: Partial<LaunchInput> = {}): LaunchInput {
	return { folder: '/lab', trusted: false, model: cli.models[0], mcp: MCP, skills: [SKILL], runDir: '/runs', slug: '7', ...overrides };
}

suite('CLIs: each launch, argument by argument', () => {

	test('Claude Code runs in its own UI at full access, its warning about it taken by the person\'s leave, with Facade\'s server alone and the person\'s own settings, the switches that would stop it at a question with nobody there off, its skill from the run, on the model asked for, the task after the options', () => {
		const spec = claudeCli.launch(inputFor(claudeCli, { model: 'opus', prompt: '--- Plan\nAdd clamp.' }), '/bin/claude');
		const file = (name: string) => JSON.parse(spec.files.find(each => path.basename(each.path) === name)?.content ?? 'null');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files.map(each => each.path), config: file('7.mcp.json'), settings: file('7.settings.json'), plugin: file('plugin.json'), skill: spec.files[3]?.content, injected: spec.injected }, {
			executable: '/bin/claude',
			args: [
				'--mcp-config', path.join('/runs', '7.mcp.json'),
				'--strict-mcp-config',
				'--settings', path.join('/runs', '7.settings.json'),
				'--plugin-dir', path.join('/runs', '7.plugin'),
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
			settings: { skipDangerousModePermissionPrompt: true, promptSuggestionEnabled: false, spinnerTipsEnabled: false, feedbackSurveyRate: 0, awaySummaryEnabled: false, emojiCompletionEnabled: false },
			plugin: { name: 'facade', version: '1.0.0', description: 'How to work in Facade Code with your children and the person.', author: { name: 'Facade Code' } },
			skill: SKILL_MD,
			injected: []
		});
	});

	test('Claude Code thinks as hard as Facade sets for each model: Sonnet at high, Opus at xhigh, by their full names too; any other model as Claude Code would; and without a task it starts at its input box', () => {
		const effort = (model: string) => claudeCli.launch(inputFor(claudeCli, { model }), '/bin/claude').args.slice(-2);

		assert.deepStrictEqual({
			efforts: ['sonnet', 'claude-sonnet-5-5', 'opus', 'claude-opus-5-5', 'haiku'].map(effort),
			noTask: claudeCli.launch(inputFor(claudeCli), '/bin/claude').args.includes('--')
		}, {
			efforts: [['--effort', 'high'], ['--effort', 'high'], ['--effort', 'xhigh'], ['--effort', 'xhigh'], ['--model', 'haiku']],
			noTask: false
		});
	});

	test('Codex runs in its own UI at full access, with Facade\'s server and the switches that would stop it at a question as -c overrides, the project\'s hooks unreviewed, in a process of its own; its skill goes into the folder', () => {
		const spec = codexCli.launch(inputFor(codexCli, { model: 'gpt-6-luna', prompt: '--- Plan' }), '/bin/codex');

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
				'-c', 'check_for_update_on_startup=false',
				'-c', 'tui.show_tooltips=false',
				'-c', 'notice.hide_rate_limit_model_nudge=true',
				'--dangerously-bypass-approvals-and-sandbox',
				'--no-daemon',
				'--dangerously-bypass-hook-trust',
				'--model', 'gpt-6-luna',
				'--', '--- Plan'
			],
			env: {},
			cwd: '/lab',
			files: [],
			injected: [{ path: '.agents/skills/facade/SKILL.md', content: SKILL_MD }],
			noTask: false
		});
	});

	test('in a worktree Facade made, Codex is told for that launch alone to trust it, by its real path - only its ASCII letters in lower case on Windows, as Codex keys it - as a table whose key keeps the dots of the path; elsewhere it is not', () => {
		const temp = tempDir('facade-codex-');
		try {
			const worktree = path.join(temp.dir, 'Lab.V2-Ä');
			fs.mkdirSync(worktree);
			const trust = (trusted: boolean) => codexCli.launch(inputFor(codexCli, { folder: worktree, trusted }), '/bin/codex').args.filter(arg => arg.startsWith('projects='));
			const key = process.platform === 'win32' ? worktree.replace(/[A-Z]/g, letter => letter.toLowerCase()) : worktree;

			assert.deepStrictEqual({ trusted: trust(true), untrusted: trust(false) }, { trusted: [`projects={ ${JSON.stringify(key)} = { trust_level = "trusted" } }`], untrusted: [] });
		} finally {
			temp.remove();
		}
	});

	test('Codex is given each environment variable of Facade\'s server by its name, in quotes where TOML cannot write it bare', () => {
		const spec = codexCli.launch(inputFor(codexCli, { mcp: { ...MCP, env: { ELECTRON_RUN_AS_NODE: '1', 'NODE.OPTIONS': '--no-warnings' } } }), '/bin/codex');

		assert.strictEqual(spec.args.find(arg => arg.startsWith('mcp_servers.facade.env=')), 'mcp_servers.facade.env={ ELECTRON_RUN_AS_NODE = "1", "NODE.OPTIONS" = "--no-warnings" }');
	});

	test('Muse Code runs in its own UI at full access - no approvals, no sandbox - trusting a worktree Facade made for the run alone, at the level of thought it is given; its server, which finds the agent from its environment, and its skill go into the folder', () => {
		const spec = museCli.launch(inputFor(museCli, { trusted: true, effort: 'max' }), '/bin/muse.cmd');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, untrusted: museCli.launch(inputFor(museCli), '/bin/muse.cmd').args }, {
			executable: '/bin/muse.cmd',
			args: ['--model', 'muse-spark-1.3-contributor', '--reasoning-effort', 'max', '--disable-approval', '--disable-sandbox', '--trust-workspace'],
			env: {},
			cwd: '/lab',
			files: [],
			injected: {
				'.mcp.json': { mcpServers: { facade: { command: MCP.command, args: MCP.args, env: { ...MCP.env, FACADE_AGENTS_PIPE: '${FACADE_AGENTS_PIPE}', FACADE_AGENTS_TOKEN: '${FACADE_AGENTS_TOKEN}' } } } },
				'.agents/skills/facade/SKILL.md': SKILL_MD
			},
			untrusted: ['--model', 'muse-spark-1.3-contributor', '--reasoning-effort', 'high', '--disable-approval', '--disable-sandbox']
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

	test('Antigravity runs in its own UI without asking, its background update off, warming up on a first message of its own; its server and skill go into the folder as one plugin, which every agent there shares', () => {
		const spec = antigravityCli.launch(inputFor(antigravityCli, { prompt: 'Not given here.' }), '/bin/agy.exe');
		const injected = Object.fromEntries(spec.injected.map(file => [file.path, file.path.endsWith('.json') ? JSON.parse(file.content) : file.content]));

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd, files: spec.files, injected, task: antigravityCli.task }, {
			executable: '/bin/agy.exe',
			args: ['-i', 'Reply with the single word ready, and nothing else.', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash-high'],
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

	test('Antigravity lists the models it has with `agy models`, an id and a name a line: Facade reads the ids, for it starts with its own model and says nothing when given one it has not', () => {
		const listed = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\nModels: 2\n';

		assert.deepStrictEqual({ args: antigravityCli.listModels?.args, ids: antigravityCli.listModels?.parse(listed) }, { args: ['models'], ids: ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking'] });
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

suite('CLIs: what the person agrees to before Facade starts one, word for word', () => {

	test('the person is asked, once, to let Facade start each CLI at full access: what that lets it do, the flags it takes, and what Facade does for them in the worktrees it makes, in the files the CLIs read on this machine', () => {
		const once = (name: string) => `\n\nFacade asks this once: from then on every ${name} agent starts this way, in every window, including those your agents start.`;

		assert.deepStrictEqual([claudeCli, codexCli, museCli, antigravityCli].map(fullAccessQuestion), [
			{
				message: 'Let Facade start Claude Code with full access?',
				detail: `Claude Code will run every command and make every edit without asking you, outside any sandbox: it can do whatever you can on this computer. Facade starts it with --dangerously-skip-permissions and tells each launch that you agreed here, so Claude Code does not warn you again. In the worktrees Facade makes, Facade also tells Claude Code that you trust the repository they belong to: Claude Code keeps that trust for the whole repository, its main checkout included, in its own configuration (${claudeConfigFile()}).${once('Claude Code')}`
			},
			{
				message: 'Let Facade start Codex with full access?',
				detail: `Codex will run every command without asking you and outside its sandbox: it can edit any file on this computer and reach the network. Facade starts it with --dangerously-bypass-approvals-and-sandbox, and with --dangerously-bypass-hook-trust, which runs the project's hooks without Codex's review. In the worktrees Facade makes, Facade tells Codex to trust the folder for that run alone, and writes nothing into ~/.codex/config.toml.${once('Codex')}`
			},
			{
				message: 'Let Facade start Muse Code with full access?',
				detail: `Muse Code will run every command without asking you and outside its sandbox: it can do whatever you can on this computer. Facade starts it with --disable-approval --disable-sandbox. In the worktrees Facade makes, and nowhere else, Facade also tells Muse Code to trust the folder for that run alone, with --trust-workspace, which stores nothing: the project's own hooks, MCP servers and skills load there without Muse Code asking.${once('Muse Code')}`
			},
			{
				message: 'Let Facade start Antigravity with full access?',
				detail: `Antigravity will run every command and make every edit without asking you: it can do whatever you can on this computer. Facade starts it with --mode accept-edits --dangerously-skip-permissions. Before Antigravity starts in a worktree Facade made, Facade adds the worktree to trustedWorkspaces in ${antigravitySettingsFile()}, and nowhere else.${once('Antigravity')}`
			}
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

	test('Claude Code\'s trust in a repository is written under its root, once, into a file that is not there yet or beside what the file holds, laid out as it is', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const config = path.join(temp.dir, '.claude.json');
		const first = [trustClaudeProject(repository, lock, config), trustClaudeProject(repository, lock, config)];
		const made = JSON.parse(fs.readFileSync(config, 'utf8'));
		const theirs = `${BOM}{\r\n  "theme": "dark",\r\n  "projects": {\r\n    "C:/Other": {\r\n      "allowedTools": []\r\n    }\r\n  }\r\n}\r\n`;
		fs.writeFileSync(config, theirs);
		const merged = trustClaudeProject(repository, lock, config);
		const after = fs.readFileSync(config, 'utf8');

		assert.deepStrictEqual({ first, made, merged, after: JSON.parse(after.slice(1)), layout: [after.startsWith(`${BOM}{\r\n  "theme": "dark",\r\n`), after.endsWith('}\r\n')], locked }, {
			first: ['written', 'there'],
			made: { projects: { [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			merged: 'written',
			after: { theme: 'dark', projects: { 'C:/Other': { allowedTools: [] }, [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			layout: [true, true],
			locked: [config, config, config]
		});
	});

	test('Claude Code\'s configuration that is not a JSON object, whose projects are not one, or whose project is not one, is left alone', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const config = path.join(temp.dir, '.claude.json');
		const left = (content: string) => {
			fs.writeFileSync(config, content);
			return [trustClaudeProject(repository, lock, config), fs.readFileSync(config, 'utf8') === content];
		};

		assert.deepStrictEqual([left('{ not json'), left('[]'), left('{"projects":[]}'), left(`{"projects":{${JSON.stringify(claudeKey(repository))}:true}}`)], [['unreadable', true], ['unreadable', true], ['unreadable', true], ['unreadable', true]]);
	});

	test('Claude Code\'s own write that comes between Facade\'s read and its write is kept: the file is read again, and the trust added to what Claude Code wrote', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
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
			trust = trustClaudeProject(repository, lock, config);
		} finally {
			restore();
		}

		assert.deepStrictEqual({ trust, after: JSON.parse(fs.readFileSync(config, 'utf8')), left: fs.readdirSync(temp.dir).sort() }, {
			trust: 'written',
			after: { numStartups: 22, projects: { [claudeKey(repository)]: { hasTrustDialogAccepted: true } } },
			left: ['.claude.json', 'Lab']
		});
	});

	test('Antigravity\'s trust in a folder is written once, by its real path, into a file that is not there yet or beside what the file holds, laid out as it is; a folder listed already, whatever its case, is left as it is', () => {
		const worktree = path.join(temp.dir, 'Clamp');
		fs.mkdirSync(worktree);
		const settings = path.join(temp.dir, 'antigravity-cli', 'settings.json');
		const outcomes = [trustAntigravityWorkspace(worktree, lock, settings), trustAntigravityWorkspace(worktree, lock, settings)];
		const first = JSON.parse(fs.readFileSync(settings, 'utf8'));
		const theirs = `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me"\n\t]\n}`;
		fs.writeFileSync(settings, theirs);
		const merged = trustAntigravityWorkspace(worktree, lock, settings);
		const after = fs.readFileSync(settings, 'utf8');
		fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [process.platform === 'win32' ? worktree.toUpperCase() : worktree] }));
		const listed = trustAntigravityWorkspace(worktree, lock, settings);

		assert.deepStrictEqual({ outcomes, first, merged, after, listed, locked: locked.length }, {
			outcomes: ['written', 'there'],
			first: { trustedWorkspaces: [fs.realpathSync.native(worktree)] },
			merged: 'written',
			after: `{\n\t"model": "gemini-3.8-flash-high",\n\t"trustedWorkspaces": [\n\t\t"C:\\\\Users\\\\me",\n\t\t${JSON.stringify(fs.realpathSync.native(worktree))}\n\t]\n}`,
			listed: 'there',
			locked: 4
		});
	});

	test('Antigravity\'s settings that do not parse, or whose list is no list, are left alone', () => {
		const worktree = path.join(temp.dir, 'Clamp');
		fs.mkdirSync(worktree);
		const settings = path.join(temp.dir, 'settings.json');
		const left = (content: string) => {
			fs.writeFileSync(settings, content);
			return [trustAntigravityWorkspace(worktree, lock, settings), fs.readFileSync(settings, 'utf8') === content];
		};

		assert.deepStrictEqual([left('{ not json'), left('{"trustedWorkspaces": "everything"}')], [['unreadable', true], ['unreadable', true]]);
	});

	test('each CLI says what became of the trust, in the file it keeps it in now: Claude Code in CLAUDE_CONFIG_DIR where it is set, else in the home folder - in its folder\'s .config.json where an older version left one - as Antigravity', () => {
		const repository = path.join(temp.dir, 'Lab');
		fs.mkdirSync(repository);
		const home = path.join(temp.dir, 'home');
		const env = { USERPROFILE: home, HOME: home };
		const worktree = { folder: repository, repository };
		const said = {
			claudeHome: claudeConfigFile(env),
			agyHome: antigravitySettingsFile(env),
			claude: claudeCli.trust?.write(worktree, lock, env),
			claudeAgain: claudeCli.trust?.write(worktree, lock, env),
			agy: antigravityCli.trust?.write(worktree, lock, env)
		};
		// What an older Claude Code left in its folder: it reads that file still.
		const legacy = path.join(home, '.claude', '.config.json');
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, '{}');
		const older = claudeConfigFile(env);
		const moved = { ...env, CLAUDE_CONFIG_DIR: path.join(temp.dir, 'qclaude') };
		const elsewhere = claudeConfigFile(moved);
		// A folder where the file would be: it cannot be read.
		fs.mkdirSync(elsewhere, { recursive: true });

		assert.deepStrictEqual({ ...said, older, elsewhere, unreadable: claudeCli.trust?.write(worktree, lock, moved) }, {
			claudeHome: path.join(home, '.claude.json'),
			agyHome: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
			claude: `Claude Code trusts the repository ${repository} now, in ${path.join(home, '.claude.json')}.`,
			claudeAgain: `Claude Code trusted the repository ${repository} already.`,
			agy: `Antigravity trusts ${repository} now, in the trustedWorkspaces of ${path.join(home, '.gemini', 'antigravity-cli', 'settings.json')}.`,
			older: legacy,
			elsewhere: path.join(temp.dir, 'qclaude', '.claude.json'),
			unreadable: `${path.join(temp.dir, 'qclaude', '.claude.json')} could not be read, or is not as Claude Code writes it, and was left alone: Claude Code will ask whether to trust ${repository}.`
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

suite('CLIs: which of them this machine has, and what models one lists', () => {

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
			installed: installedClis(env).map(each => [each.cli.id, each.executable]),
			none: installedClis({ PATH: '' })
		}, {
			known: ['claude', 'codex', 'agy', 'muse'],
			installed: [['claude', first], ['agy', agy]],
			none: []
		});
	});

	test('a command is found on PATH - a folder in quotes too - or by its own path; a folder of its name is not it', () => {
		const tool = executable('bin', 'tool');
		fs.mkdirSync(path.join(temp.dir, 'dir', `tool${process.platform === 'win32' ? '.exe' : ''}`), { recursive: true });
		const env = { PATH: [path.join(temp.dir, 'dir'), `"${path.join(temp.dir, 'bin')}"`].join(path.delimiter), PATHEXT: '.EXE' };

		assert.deepStrictEqual([which('tool', env), which(tool, {}), which('missing', env), which('tool', {}), which('tool', { Path: path.join(temp.dir, 'bin'), PATHEXT: '.EXE' })], [tool, tool, undefined, undefined, tool]);
	});

	test('on Windows, a CLI that is a .cmd of its own lists its models through cmd.exe, its path in quotes, spaces and all; one whose path cmd.exe would read a variable in is not asked', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		this.timeout(20_000);
		/** A CLI that is a .cmd in `folder`, printing two models. */
		const lister = (folder: string) => {
			const file = path.join(temp.dir, folder, 'models.cmd');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, '@echo quick\r\n@echo deep\r\n');
			return { cli: { ...antigravityCli, listModels: { args: ['models'], parse: (output: string) => output.split(/\r?\n/).filter(Boolean) } }, executable: file };
		};

		assert.deepStrictEqual({ spaced: await cliModels(lister('with space')), variable: await cliModels(lister('100%')) }, { spaced: ['quick', 'deep'], variable: undefined });
	});

	test('a CLI\'s models are the ids it prints, read as its definition says; none where it lists none, fails, or has no way to list them', async function () {
		this.timeout(20_000);
		/** A CLI that is Node, printing what `script` prints. */
		const lister = (script: string): { cli: AgentCli; executable: string } => ({
			cli: { ...antigravityCli, listModels: { args: ['-e', script], parse: output => output.split(/\r?\n/).filter(Boolean) } },
			executable: process.execPath
		});

		assert.deepStrictEqual({
			listed: await cliModels(lister('console.log("quick"); console.log("deep")')),
			none: await cliModels(lister('')),
			failed: await cliModels(lister('console.log("quick"); process.exit(3)')),
			noWay: await cliModels({ cli: claudeCli, executable: process.execPath })
		}, { listed: ['quick', 'deep'], none: undefined, failed: undefined, noWay: undefined });
	});

	test('the home folder a CLI keeps the person\'s settings in is the one the operating system says now', () => {
		assert.deepStrictEqual(antigravitySettingsFile(), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'));
	});
});
