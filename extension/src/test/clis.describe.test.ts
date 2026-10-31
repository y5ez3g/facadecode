/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { catalogOf } from '../clis/catalog';
import { tomlString } from '../clis/codex';
import { describeLaunches } from '../clis/describe';
import { DestinationEnvironment, planLaunch } from '../clis/plan';
import { redacted } from '../clis/redact';
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

	test('each CLI as a new start would have it now: program and source, working directory, the literal arguments a launch gets, YOLO, sandbox, approvals and trust - one configuration', () => {
		const settings: { readonly [name: string]: unknown } = {
			'facade.codex.launch': { arguments: ['--search', '--api-key', 'sk-123'], environment: { OPENAI_API_KEY: 'sk-live', MODE: 'fast', GONE: null } },
			'facade.muse.enabled': false
		};
		const catalog = catalogOf(name => settings[name]);
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
				{ source: 'terminal', name: 'PLAIN', value: 'p' },
				{ source: 'launch', name: 'OPENAI_API_KEY', value: '<redacted>' },
				{ source: 'launch', name: 'MODE', value: 'fast' },
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
		assert.deepStrictEqual(claude.environment.variables.filter(each => each.source === 'adapter'), [{ source: 'adapter', name: 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', value: null }]);
		// The trust each start is given, as its arguments, or as the entry merged into the CLI's file - named, never written (CLIS-3.3)
		const trusted = ['-c', `projects={ ${tomlString(fs.realpathSync(cwd))} = { trust_level = "trusted" } }`];
		assert.deepStrictEqual([claude.sandbox, codex.trust, codex.args!.slice(2, 4)], [{ state: 'on' }, { kind: 'arguments', args: trusted }, trusted]);
		assert.deepStrictEqual(claude.trust, { kind: 'file', target: { file: path.join(temp.dir, '.claude.json'), keys: ['projects', fs.realpathSync(cwd), 'hasTrustDialogAccepted'], entry: { value: true }, folder: fs.realpathSync(cwd) } });
		assert.ok(!fs.existsSync(path.join(temp.dir, '.claude.json')));
		// A built-in turned off is described, with no plan
		const muse = described.find(each => each.cli === 'muse')!;
		assert.deepStrictEqual([muse.enabled, muse.args, muse.trust], [false, undefined, undefined]);
	});

	test('a configuration with errors shows them, naming their settings, and no invented plan; a CLI not found says why', () => {
		const settings: { readonly [name: string]: unknown } = { 'facade.claude.launch': { arguments: { yoloOn: [] } } };
		const described = describeLaunches(catalogOf(name => settings[name]), destination, cwd, true);
		const claude = described.find(each => each.cli === 'claude')!;
		assert.deepStrictEqual([claude.problems.map(problem => problem.said.kind), claude.args, claude.trust], [['arguments_type'], undefined, undefined]);
		assert.match(claude.problems[0].text, /^facade\.claude\.launch\.arguments must be an array/);
		// With a configuration error no program is looked for: a wrong .path is never PATH's command (CLIS-1.2, 4.1)
		const wrong = describeLaunches(catalogOf(name => ({ 'facade.codex.path': 7 })[name]), destination, cwd, true).find(each => each.cli === 'codex')!;
		assert.deepStrictEqual([wrong.program, wrong.args], [{ unresolved: true }, undefined]);
		// Texts that quote a configured value - a .path not found - have the secrets in them redacted
		const secret = describeLaunches(catalogOf(name => ({ 'facade.codex.path': 'OPENAI_API_KEY=sk-live codex' })[name]), destination, cwd, true).find(each => each.cli === 'codex')!;
		assert.ok('missing' in secret.program && !JSON.stringify(secret.program).includes('sk-live') && secret.program.missing.includes('OPENAI_API_KEY=<redacted>'), JSON.stringify(secret.program));
		const pi = described.find(each => each.cli === 'pi')!;
		assert.ok('missing' in pi.program && /^pi was not found on the PATH/.test(pi.program.missing) && pi.program.said.kind === 'not_on_path');
		assert.deepStrictEqual([pi.args, pi.sandbox, pi.approvals], [undefined, { state: 'none' }, { state: 'none' }]);
	});

	test('secrets are redacted wherever they appear: a value under a secret\'s name, an option\'s value, a NAME=value; a count of tokens and a later-filled value are kept', () => {
		assert.deepStrictEqual(redacted(['--token', 'abc', '--max-tokens', '5', 'API_KEY=xyz', '--password=hunter2', '--auth', '${prompt}', '--name', 'n']), [
			'--token', '<redacted>', '--max-tokens', '5', 'API_KEY=<redacted>', '--password=<redacted>', '--auth', '${prompt}', '--name', 'n'
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
			PATH: '/bin', KEYBOARD: 'us', MONKEY: 'x', BYPASS: 'y', HTTPS_PROXY: 'http://me:<redacted>@proxy:8080'
		});
		// A whole value under a secret's name, however deep it goes
		assert.deepStrictEqual(redacted({ credentials: { user: 'u', pw: 'p' }, tokens: 3 }), { credentials: '<redacted>', tokens: 3 });
		// A number under a secret's name is one too
		assert.deepStrictEqual(redacted({ DB_PASSWORD: 12345678, PORT: 5432, API_KEY: 7 }), { DB_PASSWORD: '<redacted>', PORT: 5432, API_KEY: '<redacted>' });
	});

	test('Show Agent Launch redacts a secret the configured arguments or environment carry in any of these forms', () => {
		const settings: { readonly [name: string]: unknown } = {
			'facade.claude.launch': {
				arguments: ['--mcp-config', '{"env":{"ANTHROPIC_API_KEY":"sk-live"}}'],
				environment: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-head', GH_PAT: 'ghp_x' }
			}
		};
		const claude = describeLaunches(catalogOf(name => settings[name]), destination, cwd, true).find(each => each.cli === 'claude')!;
		const shown = JSON.stringify([claude.args, claude.environment.variables]);
		assert.ok(!/sk-live|sk-head|ghp_x/.test(shown), shown);
		assert.ok(claude.args!.includes('{"env":{"ANTHROPIC_API_KEY":"<redacted>"}}'));
	});
});
