/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { tomlString } from '../clis/codex';
import { describeLaunches, PLACEHOLDERS } from '../clis/describe';
import { DestinationEnvironment, planLaunch } from '../clis/plan';
import { redacted } from '../clis/redact';
import { catalogFrom } from './settingsFixtures';
import { tempDir } from './util';

suite('CLIs: Show Agent Launch (CLIS-4.1)', () => {
	let temp: ReturnType<typeof tempDir>;
	let destination: DestinationEnvironment;
	let cwd: string;

	setup(() => {
		temp = tempDir('fd-describe-');
		const bin = path.join(temp.dir, 'bin');
		fs.mkdirSync(bin);
		for (const name of ['claude', 'codex']) {
			fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n');
			fs.chmodSync(path.join(bin, name), 0o755);
		}
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		destination = { host: { PATH: bin, HOME: temp.dir, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, terminal: { API_TOKEN: 'from-terminal', PLAIN: 'p' }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	test('what a start adds is shown in its place - the Facade tools\' and session tracking\'s arguments and variables - what only a start has named by placeholders, and no launch file written (CLIS-4.1, 2.2, 2.4)', () => {
		const catalog = catalogFrom();
		const home = path.join(temp.dir, 'facade');
		const runDir = path.join(home, 'runs', PLACEHOLDERS.run, 'tools');
		const sessionFile = path.join(home, 'runs', `${PLACEHOLDERS.run}.session.json`);
		const server = { command: '/runtime', args: ['/ext/dist/shim.js'], env: { ELECTRON_RUN_AS_NODE: '1', FACADE_RUN: PLACEHOLDERS.run, FACADE_AGENT: '#aN', FACADE_LAUNCH_CONTEXT: PLACEHOLDERS.context }, instructions: PLACEHOLDERS.instructions };
		const described = describeLaunches(catalog, destination, cwd, false, { sessionFile, sessionHook: cli => `node hook.cjs ${cli}`, tools: { server, skill: 'SKILL', runDir }, runDir });
		const claude = described.find(each => each.cli === 'claude')!;
		const codex = described.find(each => each.cli === 'codex')!;
		const after = (args: readonly string[] | undefined, option: string) => args?.[args.indexOf(option) + 1];
		assert.deepStrictEqual([after(claude.args, '--mcp-config'), after(claude.args, '--plugin-dir'), after(claude.args, '--allowedTools'), after(claude.args, '--session-id')],
			[path.join(runDir, 'mcp.json'), path.join(runDir, 'plugin'), 'mcp__facade', PLACEHOLDERS.session]);
		// Its run settings are a file of the run, named by its path and shown, as a start would write them
		const settings = claude.runSettings?.settings as { hooks: { SessionStart: { hooks: { command: string }[] }[] }; env: unknown };
		assert.deepStrictEqual([after(claude.args, '--settings'), claude.runSettings?.file, settings.hooks.SessionStart[0].hooks[0].command, settings.env],
			[path.join(runDir, 'claude-settings.json'), path.join(runDir, 'claude-settings.json'), 'node hook.cjs claude', { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' }]);
		assert.deepStrictEqual(codex.args!.slice(0, 2), ['-c', 'mcp_servers.facade.command="/runtime"']);
		assert.ok(codex.args!.some(arg => arg.startsWith('hooks=')), 'Codex\'s session hooks');
		assert.deepStrictEqual([claude.environment.sources.at(-1), claude.environment.variables.filter(each => each.source === 'facade')],
			['facade', [{ source: 'facade', name: 'FACADE_CODE_SESSION_FILE', value: sessionFile }]]);
		assert.ok(!fs.existsSync(home), 'no launch file is written');
		// Without what a start adds, the configured launch alone
		const configured = describeLaunches(catalog, destination, cwd, false).find(each => each.cli === 'claude')!;
		assert.deepStrictEqual([configured.args!.includes('--mcp-config'), configured.environment.sources.includes('facade')], [false, false]);
	});

	test('each CLI as a new start would have it now: program and source, working directory, the literal arguments a launch gets, YOLO, sandbox, approvals and trust - one configuration', () => {
		const catalog = catalogFrom({ clis: {
			codex: { args: ['--search', '--api-key', 'sk-123'], env: { OPENAI_API_KEY: 'sk-live', MODE: 'fast', GONE: null } },
			muse: { enabled: false }
		} });
		const described = describeLaunches(catalog, destination, cwd, false);
		const codex = described.find(each => each.cli === 'codex')!;
		const planned = planLaunch(catalog, { cli: 'codex', alias: '#a1', cwd, yolo: false }, destination);
		assert.deepStrictEqual({
			program: codex.program, cwd: codex.cwd, sources: codex.environment.sources, variables: codex.environment.variables, args: codex.args,
			yolo: codex.yolo, sandbox: codex.sandbox, approvals: codex.approvals, problems: codex.problems
		}, {
			program: { file: path.join(temp.dir, 'bin', 'codex'), configured: '', throughCmd: false },
			cwd,
			sources: ['host', 'terminal', 'launch', 'run'],
			variables: [
				{ source: 'terminal', name: 'API_TOKEN', value: '<redacted>' },
				{ source: 'terminal', name: 'PLAIN', value: '<redacted>' },
				{ source: 'launch', name: 'OPENAI_API_KEY', value: '<redacted>' },
				{ source: 'launch', name: 'MODE', value: '<redacted>' },
				{ source: 'launch', name: 'GONE', value: null },
				{ source: 'run', name: 'ELECTRON_RUN_AS_NODE', value: null },
				{ source: 'run', name: 'TERM_PROGRAM', value: 'vscode' },
				{ source: 'run', name: 'COLORTERM', value: 'truecolor' },
				{ source: 'run', name: 'FACADE_AGENT', value: '#aN' }
			],
			// The same arguments a launch gets, in order, with the secret redacted
			args: planned.args.map(arg => arg === 'sk-123' ? '<redacted>' : arg),
			yolo: false, sandbox: { state: 'on', by: ['--sandbox', 'workspace-write'] }, approvals: { state: 'native' }, problems: []
		});
		const claude = described.find(each => each.cli === 'claude')!;
		assert.deepStrictEqual(claude.environment.variables.filter(each => each.source === 'adapter'), [
			{ source: 'adapter', name: 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', value: null },
			{ source: 'adapter', name: 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL', value: '1' }
		]);
		// The trust each start is given, as its arguments, or as the entry merged into the CLI's file - named, never written (CLIS-3.3)
		const trusted = ['-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`];
		const trustAt = codex.args!.indexOf(trusted[1]);
		assert.ok(trustAt > 0, 'the planned invocation includes its trust override');
		assert.deepStrictEqual([claude.sandbox, codex.trust, codex.args!.slice(trustAt - 1, trustAt + 1)], [{ state: 'on' }, { kind: 'arguments', args: trusted }, trusted]);
		assert.deepStrictEqual(claude.trust, { kind: 'file', target: { file: path.join(temp.dir, '.claude.json'), keys: ['projects', fs.realpathSync(cwd), 'hasTrustDialogAccepted'], entry: { value: true }, folder: fs.realpathSync(cwd) } });
		assert.ok(!fs.existsSync(path.join(temp.dir, '.claude.json')));
		// A built-in turned off is described, with no plan
		const muse = described.find(each => each.cli === 'muse')!;
		assert.deepStrictEqual([muse.enabled, muse.args, muse.trust], [false, undefined, undefined]);
	});

	test('a configuration with errors shows them, naming their settings, and no invented plan; a CLI not found says why', () => {
		const described = describeLaunches(catalogFrom({ clis: { claude: { args: { yoloOn: [] } } } }), destination, cwd, true);
		const claude = described.find(each => each.cli === 'claude')!;
		assert.deepStrictEqual([claude.problems.map(problem => problem.said.kind), claude.args, claude.trust], [['arguments_type'], undefined, undefined]);
		assert.match(claude.problems[0].text, /^clis\.claude\.args must be an array/);
		// With a configuration error no program is looked for: a wrong command is never PATH's command (CLIS-1.2, CONFIGURATION-4.1)
		const wrong = describeLaunches(catalogFrom({ clis: { codex: { command: 7 } } }), destination, cwd, true).find(each => each.cli === 'codex')!;
		assert.deepStrictEqual([wrong.program, wrong.args], [{ unresolved: true }, undefined]);
		// Texts that quote a configured value - a command not found - have the secrets in them redacted
		const secret = describeLaunches(catalogFrom({ clis: { codex: { command: 'OPENAI_API_KEY=sk-live codex' } } }), destination, cwd, true).find(each => each.cli === 'codex')!;
		assert.ok('missing' in secret.program && !JSON.stringify(secret.program).includes('sk-live') && secret.program.missing.includes('OPENAI_API_KEY=<redacted>'), JSON.stringify(secret.program));
		const pi = described.find(each => each.cli === 'pi')!;
		assert.ok('missing' in pi.program && /^pi was not found on the PATH/.test(pi.program.missing) && pi.program.said.kind === 'not_on_path');
		assert.deepStrictEqual([pi.args, pi.sandbox, pi.approvals], [undefined, { state: 'none' }, { state: 'none' }]);
	});

	test('CONFIGURATION-4.2: secrets are redacted wherever they appear - the value of any name containing key, token, secret, password, auth or credential, as an option\'s value apart, after =, in a configuration assignment, one starting with a dash too; a later-filled value is kept', () => {
		assert.deepStrictEqual(redacted(['--key-material', 'SENTINEL_A', '--api-key', '-SENTINEL_B', '-c', 'service_key_id="SENTINEL_C"', '--auth-token', '--verbose']), [
			'--key-material', '<redacted>', '--api-key', '<redacted>', '-c', 'service_key_id=<redacted>', '--auth-token', '--verbose'
		]);
		assert.deepStrictEqual(redacted(['--token', 'abc', '--max-tokens', '5', 'API_KEY=xyz', '--password=hunter2', '--auth', '${prompt}', '--name', 'n']), [
			'--token', '<redacted>', '--max-tokens', '<redacted>', 'API_KEY=<redacted>', '--password=<redacted>', '--auth', '${prompt}', '--name', 'n'
		]);
		assert.deepStrictEqual(redacted({ env: { GITHUB_TOKEN: 'ghp', SESSION_KEY: 'k', USER: 'me' }, nested: [{ secret: 's' }] }), {
			env: { GITHUB_TOKEN: '<redacted>', SESSION_KEY: '<redacted>', USER: 'me' }, nested: [{ secret: '<redacted>' }]
		});
	});

	test('secrets inside values are redacted too: authorization headers, bearer credentials, URL passwords, a JSON or TOML value\'s secret members, and names such as OPENAI_KEY, GH_PAT or DB_PASS', () => {
		assert.deepStrictEqual(redacted([
			'--header', 'Authorization: Bearer sk-1',
			'-H', 'X-Api-Key: k-2',
			'--header=Proxy-Authorization: Basic dXNlcjpw',
			'--settings', '{"env":{"ANTHROPIC_API_KEY":"sk-3","MODE":"fast"},"apiKeyHelper":"~/bin/key"}',
			'-c', 'mcp_servers.x.env={ OPENAI_KEY = "sk-4", LEVEL = "2" }',
			'--note', 'send Bearer abc.def to it',
			'--settings', '{"sandbox":{"enabled":true}}'
		]), [
			'--header', 'Authorization: <redacted>',
			'-H', 'X-Api-Key: <redacted>',
			'--header=Proxy-Authorization: <redacted>',
			// A name that only looks like a secret's is redacted too: the document errs on the side of hiding
			'--settings', '{"env":{"ANTHROPIC_API_KEY":"<redacted>","MODE":"fast"},"apiKeyHelper":"<redacted>"}',
			'-c', 'mcp_servers.x.env={ OPENAI_KEY = "<redacted>", LEVEL = "2" }',
			'--note', 'send Bearer <redacted> to it',
			// Text without a secret stays exactly as written
			'--settings', '{"sandbox":{"enabled":true}}'
		]);
		assert.deepStrictEqual(redacted({ OPENAI_KEY: 'a', GH_PAT: 'b', DB_PASS: 'c', KEY: 'd', HEADERS: '{"Authorization":"Bearer e"}', EXTRA: 'Authorization: token f', PATH: '/bin', KEYBOARD: 'us', MONKEY: 'x', BYPASS: 'y', HTTPS_PROXY: 'http://me:pw@proxy:8080' }), {
			OPENAI_KEY: '<redacted>', GH_PAT: '<redacted>', DB_PASS: '<redacted>', KEY: '<redacted>', HEADERS: '{"Authorization":"<redacted>"}', EXTRA: 'Authorization: <redacted>',
			PATH: '/bin', KEYBOARD: '<redacted>', MONKEY: '<redacted>', BYPASS: 'y', HTTPS_PROXY: 'http://me:<redacted>@proxy:8080'
		});
		// A whole value under a secret's name, however deep it goes
		assert.deepStrictEqual(redacted({ credentials: { user: 'u', pw: 'p' }, tokens: 3 }), { credentials: '<redacted>', tokens: '<redacted>' });
		// A number under a secret's name is one too
		assert.deepStrictEqual(redacted({ DB_PASSWORD: 12345678, PORT: 5432, API_KEY: 7 }), { DB_PASSWORD: '<redacted>', PORT: 5432, API_KEY: '<redacted>' });
	});

	test('CONFIGURATION-4.2: the run settings a start would give Claude Code show its entry\'s variables by name alone, a removed key variable empty, and the person\'s own settings with any secret redacted', () => {
		const claude = describeLaunches(catalogFrom({ clis: { claude: {
			env: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'sk-entry', ANTHROPIC_API_KEY: null },
			args: ['--settings', '{"env":{"MODE":"fast"},"apiKeyHelper":"~/bin/key","includeCoAuthoredBy":false}']
		} } }), destination, cwd, true).find(each => each.cli === 'claude')!;
		assert.deepStrictEqual(claude.runSettings?.settings, {
			env: { MODE: '<redacted>', ANTHROPIC_BASE_URL: '<redacted>', ANTHROPIC_AUTH_TOKEN: '<redacted>', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' },
			apiKeyHelper: '<redacted>', includeCoAuthoredBy: false, disabledMcpjsonServers: ['facade']
		});
		assert.ok(!JSON.stringify(claude).includes('sk-entry'));
	});

	test('CONFIGURATION-4.2: a variable Facade merges its tools into - OpenCode\'s configuration - holds the person\'s value, so it is hidden as theirs is: nothing of the person\'s layers is in the description', () => {
		fs.writeFileSync(path.join(temp.dir, 'bin', 'opencode'), '#!/bin/sh\n');
		fs.chmodSync(path.join(temp.dir, 'bin', 'opencode'), 0o755);
		const home = path.join(temp.dir, 'facade');
		const runDir = path.join(home, 'runs', PLACEHOLDERS.run, 'tools');
		const server = { command: '/runtime', args: ['/ext/dist/shim.js'], env: { FACADE_RUN: PLACEHOLDERS.run }, instructions: PLACEHOLDERS.instructions };
		const catalog = catalogFrom({ clis: { opencode: { env: { OPENCODE_CONFIG_CONTENT: '{"instructions":["SENTINEL_INSTRUCTION"]}' } } } });
		const opencode = describeLaunches({ ...catalog }, { ...destination, terminal: { PLAIN: 'SENTINEL_TERMINAL' } }, cwd, false,
			{ sessionFile: path.join(home, 'runs', `${PLACEHOLDERS.run}.session.json`), sessionHook: () => 'hook', tools: { server, skill: 'SKILL', runDir }, runDir }).find(each => each.cli === 'opencode')!;
		assert.deepStrictEqual([opencode.environment.variables.filter(each => each.name === 'OPENCODE_CONFIG_CONTENT').map(each => [each.source, each.value]), JSON.stringify(opencode).includes('SENTINEL')],
			[[['launch', '<redacted>'], ['facade', '<redacted>']], false]);
	});

	test('Show Agent Launch redacts a secret the configured arguments or environment carry in any of these forms', () => {
		const claude = describeLaunches(catalogFrom({ clis: { claude: {
			args: ['--mcp-config', '{"env":{"ANTHROPIC_API_KEY":"sk-live"}}'],
			env: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-head', GH_PAT: 'ghp_x' }
		} } }), destination, cwd, true).find(each => each.cli === 'claude')!;
		const shown = JSON.stringify([claude.args, claude.environment.variables]);
		assert.ok(!/sk-live|sk-head|ghp_x/.test(shown), shown);
		assert.ok(claude.args!.includes('{"env":{"ANTHROPIC_API_KEY":"<redacted>"}}'));
	});
});
