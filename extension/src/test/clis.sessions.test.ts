/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import { codexSession } from '../clis/codex';
import { museSession, museTarget } from '../clis/muse';
import { openCodeSession, OPENCODE_SESSION_PLUGIN } from '../clis/opencode';
import { antigravityAdapter } from '../clis/antigravity';
import { pathToFileURL } from 'url';
import { recordedSession, sessionHookCommand, SESSION_HOOK_SCRIPT, SessionIntegrationInput } from '../clis/identity';
import { tempDir } from './util';
import { MuseIdentity } from '../clis/museIdentity';

suite('Native session integration preserves configuration and exact identity (CLIS-2.4)', () => {
	let temp: ReturnType<typeof tempDir>;
	let input: SessionIntegrationInput;
	setup(() => {
		temp = tempDir('fd-native-session-');
		input = { file: path.join(temp.dir, 'our.session.json'), hook: 'capture-session', env: { HOME: temp.dir, XDG_CONFIG_HOME: path.join(temp.dir, 'config') }, cwd: temp.dir, platform: 'linux', extra: [] };
	});
	teardown(() => temp.remove());

	test('Codex keeps per-launch user hooks and states, trusts only its own added handlers, and never disables hook trust', () => {
		const user = 'hooks={SessionStart=[{hooks=[{type="command",command="user-hook"}]}],Stop=[{hooks=[{type="command",command="stop-hook"}]}],state={"user-key"={enabled=false}}}';
		const session = codexSession({ ...input, extra: ['-c', user] });
		const config = parseToml(session.args![1]) as any;
		assert.strictEqual(config.hooks.SessionStart[0].hooks[0].command, 'user-hook');
		assert.strictEqual(config.hooks.Stop[0].hooks[0].command, 'stop-hook');
		assert.strictEqual(config.hooks.state['user-key'].enabled, false);
		assert.ok(config.hooks.state['/<session-flags>/config.toml:session_start:1:0'].trusted_hash.startsWith('sha256:'));
		assert.strictEqual(config.hooks.SessionEnd[0].hooks[0].timeout, 3, 'native timeout normalization is part of the trust fingerprint');
		assert.ok(!session.args!.join(' ').includes('bypass-hook-trust'));
	});

	test('Muse replaces a consumed override once and preserves every user hook, without editing the native settings', () => {
		const dir = path.join(temp.dir, 'config', 'muse'); fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'settings.json');
		const text = JSON.stringify({ schema_version: 1, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'from-settings' }] }] } });
		fs.writeFileSync(file, text);
		const configured = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-prompt' }] }], Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] };
		const result = museSession({ ...input, extra: ['--model', 'own-model', '-c', `hooks=${JSON.stringify(configured)}`] });
		assert.deepStrictEqual(result.extra, ['--model', 'own-model']);
		const hooks = JSON.parse(result.args![1].slice(6));
		assert.strictEqual(hooks.UserPromptSubmit[0].hooks[0].command, 'user-prompt');
		assert.strictEqual(hooks.Stop[0].hooks[0].command, 'user-stop');
		assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
		const normal = JSON.parse(museSession(input).args![1].slice(6));
		assert.strictEqual(normal.SessionStart[0].hooks[0].command, 'from-settings');
	});

	test('OpenCode keeps JSONC plugins, directives and options; its native environment overlay still wins', () => {
		const dir = path.join(temp.dir, 'config', 'opencode'); fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'cli.json');
		const original = '{// own plugins\n"plugins":["own-plugin", "-builtin", {"package":"custom", "options":{"color":"blue"}},],"theme":{"name":"own"}}';
		fs.writeFileSync(file, original);
		const result = openCodeSession(input);
		const content = JSON.parse(result.env.OPENCODE_CLI_CONFIG_CONTENT);
		assert.deepStrictEqual(content.plugins.slice(0, -1), ['own-plugin', '-builtin', { package: 'custom', options: { color: 'blue' } }]);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
		const overlay = openCodeSession({ ...input, env: { ...input.env, OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":["overlay"],"theme":{"name":"run"}}' } });
		assert.deepStrictEqual(JSON.parse(overlay.env.OPENCODE_CLI_CONFIG_CONTENT).plugins.slice(0, -1), ['overlay']);
		assert.deepStrictEqual(JSON.parse(overlay.env.OPENCODE_CLI_CONFIG_CONTENT).theme, { name: 'run' });
	});

	test('Antigravity preserves native title passthrough and all other per-run settings without writing the user file', () => {
		const directory = path.join(temp.dir, '.gemini', 'antigravity-cli'); fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, 'settings.json'), original = JSON.stringify({ title: { enabled: true, command: 'native-title' } }); fs.writeFileSync(file, original);
		const result = antigravityAdapter.sessionIntegration!({ ...input, extra: ['--model', 'native-model', '--settings', '{"theme":"custom","title":{"command":"run-title"}}'] });
		assert.deepStrictEqual(result.extra, ['--model', 'native-model']);
		assert.strictEqual(result.env?.FACADE_CODE_TITLE_COMMAND, 'run-title');
		assert.strictEqual(JSON.parse(result.args![1]).theme, 'custom');
		assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
	});


	test('Antigravity composes tool permissions, per-launch settings and native identity into one overlay', () => {
		const result = antigravityAdapter.sessionIntegration!({ ...input, tools: true, extra: [
			'--conversation', 'exact', '--settings', '{"permissions":{"allow":["mcp(facade_facade/*)"]}}',
			'--settings', '{"permissions":{"allow":["read(*)"],"deny":["shell(rm *)"]},"theme":"dark"}'
		] });
		assert.deepStrictEqual(result.extra, ['--conversation', 'exact']);
		const settings = JSON.parse(result.args![1]);
		assert.deepStrictEqual(settings.permissions, { allow: ['read(*)', 'mcp(facade_facade/*)'], deny: ['shell(rm *)'] });
		assert.deepStrictEqual([settings.theme, settings.title.command], ['dark', input.hook]);
	});

	test('the Windows Muse installer resolves its selected native version, never another channel or an arbitrary batch wrapper', () => {
		const file = path.join(temp.dir, 'muse.cmd'), program = path.join(temp.dir, 'muse-bin-1.4.14-R7309.1.exe');
		fs.writeFileSync(file, '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
		fs.writeFileSync(path.join(temp.dir, '.muse-launcher.ps1'), 'function Get-ActiveBinary { $binary = Join-Path $Dir "muse-bin-$version.exe" }');
		fs.writeFileSync(path.join(temp.dir, '.muse-version'), '1.4.14-R7309.1\n');
		fs.writeFileSync(program, 'native fixture');
		assert.deepStrictEqual(museTarget(file, 'win32', {}, temp.dir), { executable: program, args: [], throughCmd: false });
		assert.strictEqual(museTarget(file, 'win32', { MUSE_CHANNEL: 'muse-canary' }, temp.dir).throughCmd, true);
		fs.writeFileSync(file, '@echo off\r\nmy-own-launcher %*\r\n');
		assert.strictEqual(museTarget(file, 'win32', {}, temp.dir).throughCmd, true);
		assert.deepStrictEqual(museSession({ ...input, throughCmd: true }), { unavailable: true });
	});

	test('OpenCode follows its selected native route and location, clears identity on Home, and leaves background sessions alone', () => {
		const plugin = path.join(temp.dir, 'plugin.mjs'); fs.writeFileSync(plugin, OPENCODE_SESSION_PLUGIN);
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs';
		process.env.FACADE_CODE_SESSION_FILE=${JSON.stringify(input.file)};
		let capture; globalThis.setInterval = callback => { capture=callback; return {unref(){}}; };
		const plugin = (await import(${JSON.stringify(pathToFileURL(plugin).href)})).default;
		let route={type:'home'}, info; plugin.setup({ui:{router:{current:()=>route}}, data:{session:{get:()=>info}}});
		const read=()=>JSON.parse(fs.readFileSync(process.env.FACADE_CODE_SESSION_FILE,'utf8'));
		assert.equal(read().session_id,null);
		route={type:'session',sessionID:'ses_selected'}; info={location:{directory:${JSON.stringify(temp.dir)}}}; capture();
		assert.equal(read().session_id,'ses_selected'); assert.equal(read().cwd,${JSON.stringify(temp.dir)});
		route={type:'home'}; capture(); assert.equal(read().session_id,null);`;
		execFileSync(process.execPath, ['--input-type=module', '-e', script]);
	});

	test('a vendor that filters environment variables still records its bound run; empty history cannot be pinned and a late old Stop cannot replace a new session', () => {
		const one = '86da4482-2bae-4a45-b193-a5664c19826a', two = '96da4482-2bae-4a45-b193-a5664c19826a';
		const transcript = path.join(temp.dir, 'history.jsonl');
		const run = (id: string, event: string, existing = true) => execFileSync(process.execPath, ['-e', SESSION_HOOK_SCRIPT, input.file], {
			env: {}, input: JSON.stringify({ session_id: id, hook_event_name: event, cwd: temp.dir, transcript_path: existing ? null : transcript })
		});
		run(one, 'SessionStart', false);
		assert.strictEqual(recordedSession(input.file)?.sessionId, null);
		fs.writeFileSync(transcript, '{}\n'); run(one, 'Stop', false);
		assert.strictEqual(recordedSession(input.file)?.sessionId, one);
		run(one, 'SessionEnd');
		assert.strictEqual(recordedSession(input.file)?.sessionId, null);
		run(two, 'UserPromptSubmit'); run(one, 'Stop');
		assert.deepStrictEqual(recordedSession(input.file), { sessionId: two, cwd: temp.dir, source: 'UserPromptSubmit' });
	});

	test('Windows hook commands stay within cmd limits and encode Unicode and shell metacharacters as literal PowerShell data', () => {
		const runtime = 'C:\\Program Files\\Code & Tools\\Code.exe';
		const file = "C:\\Users\\姓名's folder\\runs\\our.session.json";
		const script = "C:\\Users\\姓名's folder\\runs\\our.session.d\\hook.cjs";
		const command = sessionHookCommand(runtime, 'win32', 'muse', file, script);
		assert.ok(command.length < 2000);
		const decoded = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');
		assert.ok(decoded.includes("姓名''s folder"));
		assert.ok(decoded.includes("'C:\\Program Files\\Code & Tools\\Code.exe'"));
		assert.ok(!decoded.includes(SESSION_HOOK_SCRIPT));
	});

	test('Muse follows only its hook-bound process across endpoint changes and host reload; another process, ambiguous roots and changed generation cannot steal the Pin', async () => {
		const data = path.join(temp.dir, 'muse-data'), runtime = path.join(data, 'runtime', 'muse'), sessions = path.join(runtime, 'sessions');
		fs.mkdirSync(sessions, { recursive: true });
		const file = path.join(temp.dir, 'muse.json'); fs.writeFileSync(file, JSON.stringify({ data }));
		const one = '86da4482-2bae-4a45-b193-a5664c19826a', two = '96da4482-2bae-4a45-b193-a5664c19826a';
		const { DatabaseSync } = await import('node:sqlite');
		const db = new DatabaseSync(path.join(data, 'session-index.db'));
		db.exec('CREATE TABLE sessions (session_id TEXT, workspace_root TEXT, status TEXT, prompt_count INTEGER, session_log_path TEXT)');
		for (const id of [one, two]) {
			const log = path.join(data, `${id}.jsonl`); fs.writeFileSync(log, '{}\n');
			db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(id, temp.dir, 'valid', 1, log);
		}
		db.close();
		const endpoint = 'ms-abcdef123456.sock', generation = 'pid=1234';
		const lease = path.join(runtime, `${endpoint}.lease`);
		fs.writeFileSync(lease, JSON.stringify({ schema_version: 1, endpoint_hint: endpoint, process_generation_hint: generation, pid: 1234 }));
		const write = (id: string, other = false) => fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ schema_version: 1, session_id: id,
			endpoint_hint: other ? 'ms-other.sock' : endpoint, process_generation_hint: generation, target_eligibility: 'message_capable' }));
		write(one);
		const directFile = path.join(temp.dir, 'direct.json'); fs.writeFileSync(directFile, JSON.stringify({ data }));
		const direct = new MuseIdentity(directFile);
		assert.strictEqual(direct.read(undefined, 9999).sessionId, null);
		assert.strictEqual(direct.read(undefined, 1234).sessionId, one, 'an exact PTY PID can bind a resumed session before its first prompt');
		write(two, true);
		let native = new MuseIdentity(file);
		assert.strictEqual(native.read().sessionId, null, 'nothing is inferred from a native directory alone');
		assert.strictEqual(native.read(one).sessionId, one);
		fs.unlinkSync(path.join(sessions, `${one}.json`));
		assert.strictEqual(native.read().sessionId, null, 'native /clear removes its registration');
		write(two);
		const changedEndpoint = 'ms-new.sock';
		fs.writeFileSync(path.join(runtime, `${changedEndpoint}.lease`), JSON.stringify({ schema_version: 1, endpoint_hint: changedEndpoint, process_generation_hint: generation, pid: 1234 }));
		fs.writeFileSync(path.join(sessions, `${two}.json`), JSON.stringify({ schema_version: 1, session_id: two, endpoint_hint: changedEndpoint, process_generation_hint: generation, target_eligibility: 'message_capable' }));
		native = new MuseIdentity(file);
		assert.strictEqual(native.read().sessionId, two, 'reload keeps the process binding, even though Muse no longer runs the CLI hook');
		write(one);
		assert.strictEqual(native.read().sessionId, null, 'two roots for one endpoint are ambiguous');
		fs.unlinkSync(path.join(sessions, `${one}.json`));
		fs.writeFileSync(path.join(runtime, `${changedEndpoint}.lease`), JSON.stringify({ schema_version: 1, endpoint_hint: changedEndpoint, process_generation_hint: 'pid=9999', pid: 9999 }));
		assert.strictEqual(native.read().sessionId, null, 'an endpoint generation change is not the same process');
	});
});
