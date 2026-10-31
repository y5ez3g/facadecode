/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { withFileLock } from '../base/lock';
import type { CliAdapter } from '../clis/adapter';
import { BUILT_IN_ADAPTERS } from '../clis/catalog';
import { claudeConfigFile, claudeProjectKey } from '../clis/claude';
import type { Environment } from '../clis/environment';
import { mergeTrust, TrustTarget, writeTrust } from '../clis/trust';
import type { Location, PlanRequest } from '../core/ports';
import type * as HostClisModule from '../host/clis';
import { tempDir } from './util';
import { withModules } from './withModules';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A built-in adapter by its API ID. */
function adapterOf(id: string): CliAdapter {
	return BUILT_IN_ADAPTERS.find(adapter => adapter.id === id)!;
}

/** The trust target of the built-in `id` for a run in `cwd` with the environment `env` (CLIS-3.3). */
function targetOf(id: string, cwd: string, env: Environment, platform: NodeJS.Platform = 'darwin'): TrustTarget {
	return adapterOf(id).trustTarget!(cwd, env, platform);
}

suite('CLIs: the folder a run starts in, trusted as the CLI\'s own question would (CLIS-3.3, D62)', () => {
	let temp: ReturnType<typeof tempDir>;
	let home: string;
	let cwd: string;
	let env: Environment;

	setup(() => {
		temp = tempDir('fd-trust-');
		home = path.join(temp.dir, 'home');
		cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(home);
		fs.mkdirSync(cwd);
		env = { HOME: home };
	});
	teardown(() => temp.remove());

	test('Claude Code: hasTrustDialogAccepted for the project in its global configuration - CLAUDE_CONFIG_DIR\'s, else the home folder\'s, an older version\'s .config.json where it left one', () => {
		assert.deepStrictEqual(targetOf('claude', cwd, env), { file: path.join(home, '.claude.json'), keys: ['projects', cwd, 'hasTrustDialogAccepted'], entry: { value: true }, folder: cwd });
		const config = path.join(temp.dir, 'claude-config');
		assert.strictEqual(targetOf('claude', cwd, { ...env, CLAUDE_CONFIG_DIR: config }).file, path.join(config, '.claude.json'));
		assert.strictEqual(claudeConfigFile({ ...env, CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://login.example' }, 'darwin'), path.join(home, '.claude-custom-oauth.json'));
		assert.strictEqual(claudeConfigFile({ USERPROFILE: home }, 'win32'), path.join(home, '.claude.json'));
		// An older version's file counts where it holds something, or where it is empty, may be written and the current one is not there
		const legacy = path.join(home, '.claude', '.config.json');
		fs.mkdirSync(path.dirname(legacy));
		fs.writeFileSync(legacy, '{}');
		assert.strictEqual(claudeConfigFile(env, 'darwin'), legacy);
		fs.writeFileSync(legacy, '');
		assert.strictEqual(claudeConfigFile(env, 'darwin'), legacy);
		fs.writeFileSync(path.join(home, '.claude.json'), '{}');
		assert.strictEqual(claudeConfigFile(env, 'darwin'), path.join(home, '.claude.json'));
	});

	test('Claude Code keys its trust on the repository\'s main checkout - from a linked worktree and a folder inside it too - and on the folder itself outside a repository', () => {
		const main = path.join(temp.dir, 'main');
		fs.mkdirSync(main);
		git(main, 'init', '-q', '-b', 'main');
		git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
		const worktree = path.join(temp.dir, 'main.worktrees', 'feature');
		git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
		const inside = path.join(worktree, 'src', 'deep');
		fs.mkdirSync(inside, { recursive: true });
		assert.deepStrictEqual([claudeProjectKey(main, 'darwin'), claudeProjectKey(worktree, 'darwin'), claudeProjectKey(inside, 'darwin'), claudeProjectKey(cwd, 'darwin')], [main, main, main, cwd]);
		assert.deepStrictEqual(targetOf('claude', worktree, env).keys, ['projects', main, 'hasTrustDialogAccepted']);
		// A `.git` file whose Git directory does not name it back is a checkout of its own, as Claude Code takes it
		const stray = path.join(temp.dir, 'stray');
		fs.mkdirSync(stray);
		fs.writeFileSync(path.join(stray, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);
		assert.strictEqual(claudeProjectKey(stray, 'darwin'), stray);
		// A folder opened through a link is keyed by its real path
		const link = path.join(temp.dir, 'link');
		// A junction on Windows, which needs no administrator; a link elsewhere
		fs.symlinkSync(worktree, link, 'junction');
		assert.strictEqual(claudeProjectKey(link, 'darwin'), main);
	});

	test('the entry is merged into the file as it is written - its indentation, line endings and byte order mark - and every other byte kept', () => {
		const file = path.join(home, '.claude.json');
		const target = targetOf('claude', cwd, env);
		// Two spaces, another project there
		const before = { numStartups: 3, projects: { '/other': { allowedTools: [] } } };
		fs.writeFileSync(file, `${JSON.stringify(before, undefined, 2)}\n`);
		assert.deepStrictEqual(mergeTrust(target), { kind: 'written' });
		const after = { numStartups: 3, projects: { '/other': { allowedTools: [] }, [cwd]: { hasTrustDialogAccepted: true } } };
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify(after, undefined, 2)}\n`);
		// Tabs, CRLF and a byte order mark; no projects yet
		fs.writeFileSync(file, `\uFEFF${JSON.stringify({ numStartups: 1 }, undefined, '\t').split('\n').join('\r\n')}\r\n`);
		mergeTrust(target);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `\uFEFF${JSON.stringify({ numStartups: 1, projects: { [cwd]: { hasTrustDialogAccepted: true } } }, undefined, '\t').split('\n').join('\r\n')}\r\n`);
		// A project there not yet trusted keeps its other keys; a null is taken for nothing
		const untrusted = `{\n  "projects": {\n    ${JSON.stringify(cwd)}: {\n      "allowedTools": ["Bash"],\n      "hasTrustDialogAccepted": false\n    }\n  },\n  "big": 12345678901234567890\n}\n`;
		fs.writeFileSync(file, untrusted);
		mergeTrust(target);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), untrusted.replace('false', 'true'));
		fs.writeFileSync(file, '{"projects":null,"theme":"dark"}');
		mergeTrust(target);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `{"projects":${JSON.stringify({ [cwd]: { hasTrustDialogAccepted: true } })},"theme":"dark"}`);
		// One that is not there is made with the entry alone, readable by its owner only
		fs.rmSync(file);
		assert.strictEqual(writeTrust('Claude Code', target), `Trusted ${cwd} for Claude Code: merged ${JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } })} into ${file}.`);
		// Windows has no POSIX modes to read back
		assert.deepStrictEqual([fs.readFileSync(file, 'utf8'), process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o600], [`${JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }, undefined, 2)}\n`, true]);
	});

	test('an entry already there writes nothing; a file that cannot be read, or not as the CLI writes it, is left byte for byte as it is, with why', () => {
		const file = path.join(home, '.claude.json');
		const target = targetOf('claude', cwd, env);
		fs.writeFileSync(file, `{ "projects": { ${JSON.stringify(cwd)}: { "hasTrustDialogAccepted": true } } }`);
		const stamp = fs.statSync(file).mtimeMs;
		assert.deepStrictEqual([mergeTrust(target), writeTrust('Claude Code', target), fs.statSync(file).mtimeMs], [{ kind: 'there' }, undefined, stamp]);
		const unreadable: { readonly [name: string]: string } = {
			malformed: '{ "projects": { ',
			list: '[]',
			projectsList: '{ "projects": [] }',
			projectList: `{ "projects": { ${JSON.stringify(cwd)}: [] } }`,
			valueObject: `{ "projects": { ${JSON.stringify(cwd)}: { "hasTrustDialogAccepted": {} } } }`
		};
		const why: { [name: string]: string } = {};
		for (const [name, text] of Object.entries(unreadable)) {
			fs.writeFileSync(file, text);
			const outcome = mergeTrust(target);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), text, name);
			why[name] = outcome.kind === 'unreadable' ? outcome.why : outcome.kind;
		}
		assert.match(why.malformed, /^is not valid JSON: /);
		assert.deepStrictEqual([why.list, why.projectsList, why.projectList, why.valueObject], [
			'contains an array; expected a JSON object',
			'has a list at ["projects"], where an object belongs',
			`has a list at ${JSON.stringify(['projects', cwd])}, where an object belongs`,
			`has an object at ${JSON.stringify(['projects', cwd, 'hasTrustDialogAccepted'])}, where true belongs`
		]);
		fs.writeFileSync(file, '[]');
		assert.strictEqual(writeTrust('Claude Code', target), `Did not trust ${cwd} for Claude Code: ${file} contains an array; expected a JSON object, so Facade left it as it is; Claude Code asks in its terminal.`);
		// A folder where the file goes cannot be read either, and stays
		fs.rmSync(file);
		fs.mkdirSync(file);
		assert.strictEqual(mergeTrust(target).kind, 'unreadable');
		assert.deepStrictEqual(fs.readdirSync(file), []);
	});

	test('the merge takes the CLI\'s own lock, <file>.lock: a folder lock as Claude Code takes it is waited for, never written through, and one left behind is taken over', () => {
		const target = targetOf('claude', cwd, env);
		const locked: string[] = [];
		mergeTrust(target, (file, fn) => (locked.push(file), fn()));
		assert.deepStrictEqual(locked, [target.file]);
		fs.rmSync(target.file);
		const lock = `${target.file}.lock`;
		fs.mkdirSync(lock);
		assert.throws(() => mergeTrust(target, (file, fn) => withFileLock(file, fn, { waitMs: 200 })), /Timed out .* waiting for another window to release the lock/);
		assert.strictEqual(fs.existsSync(target.file), false);
		// Older than its holder keeps it fresh: left behind
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, past, past);
		assert.deepStrictEqual([mergeTrust(target), fs.existsSync(lock), fs.existsSync(target.file)], [{ kind: 'written' }, false, true]);
	});

	test('Antigravity: the folder an item of the trustedWorkspaces of its settings in the home folder, the folder its run takes for its working directory - PWD where that names it, else the real path; on Windows the folder as given', () => {
		const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
		const folder = canonicalFolder(cwd);
		assert.deepStrictEqual(targetOf('agy', cwd, env), { file, keys: ['trustedWorkspaces'], entry: { item: folder }, folder });
		assert.strictEqual(targetOf('agy', cwd, { USERPROFILE: home }, 'win32').file, file);
		assert.strictEqual(targetOf('agy', 'C:\\work\\repo', { USERPROFILE: 'C:\\Users\\me' }, 'win32').folder, path.resolve('C:\\work\\repo'));
		// A folder reached through a link: the PWD that names it, as a Go program takes its working directory; else its real path
		const link = path.join(temp.dir, 'link');
		fs.symlinkSync(cwd, link, 'junction');
		assert.deepStrictEqual([targetOf('agy', link, { ...env, PWD: link }).folder, targetOf('agy', link, { ...env, PWD: temp.dir }).folder, targetOf('agy', link, env).folder], [link, folder, folder]);
		assert.deepStrictEqual(mergeTrust(targetOf('agy', cwd, env)), { kind: 'written' });
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ trustedWorkspaces: [folder] }, undefined, 2)}\n`);
	});

	test('a list entry: the folder added at the end of the list at its keys as the file is written - made where there is none, a null taken for nothing - and nothing written where it is there', () => {
		const file = path.join(home, 'settings.json');
		const target: TrustTarget = { file, keys: ['trustedWorkspaces'], entry: { item: cwd }, folder: cwd };
		assert.deepStrictEqual(mergeTrust(target), { kind: 'written' });
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ trustedWorkspaces: [cwd] }, undefined, 2)}\n`);
		const stamp = fs.statSync(file).mtimeMs;
		assert.deepStrictEqual([mergeTrust(target), writeTrust('Antigravity', target), fs.statSync(file).mtimeMs], [{ kind: 'there' }, undefined, stamp]);
		// Comments, tabs, the other settings and the other folders kept; the folder goes last
		const settings = `{\n\t// mine\n\t"theme": "dark",\n\t"trustedWorkspaces": ["/a", "/b"]\n}\n`;
		fs.writeFileSync(file, settings);
		assert.deepStrictEqual(mergeTrust(target), { kind: 'written' });
		assert.strictEqual(fs.readFileSync(file, 'utf8'), settings.replace('"/b"]', `"/b", ${JSON.stringify(cwd)}]`));
		// An empty list in a file with CRLF line endings and a byte order mark: both kept
		fs.writeFileSync(file, '\uFEFF{\r\n  "theme": "dark",\r\n  "trustedWorkspaces": []\r\n}\r\n');
		mergeTrust(target);
		const written = fs.readFileSync(file, 'utf8');
		assert.deepStrictEqual([written.startsWith('\uFEFF'), /(?<!\r)\n/.test(written), JSON.parse(written.slice(1))], [true, false, { theme: 'dark', trustedWorkspaces: [cwd] }]);
		fs.writeFileSync(file, '{"trustedWorkspaces":null,"theme":"dark"}');
		mergeTrust(target);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), `{"trustedWorkspaces":${JSON.stringify([cwd])},"theme":"dark"}`);
		fs.rmSync(file);
		assert.strictEqual(writeTrust('Antigravity', target), `Trusted ${cwd} for Antigravity: merged ${JSON.stringify({ trustedWorkspaces: [cwd] })} into ${file}.`);
	});

	test('a list entry is there only when the list names the folder exactly as the CLI does: another case, other slashes or another spelling of it is not, as the CLI may compare text; something else at its keys is left byte for byte, with why', () => {
		const file = path.join(home, 'settings.json');
		const target: TrustTarget = { file, keys: ['trustedWorkspaces'], entry: { item: cwd }, folder: cwd };
		const other = cwd.toUpperCase() === cwd ? cwd.toLowerCase() : cwd.toUpperCase();
		for (const spelling of [other, cwd.split(path.sep).join(path.sep === '\\' ? '/' : '\\'), `${cwd}${path.sep}`, `${cwd}${path.sep}x${path.sep}..`]) {
			fs.writeFileSync(file, JSON.stringify({ trustedWorkspaces: [spelling] }));
			assert.deepStrictEqual(mergeTrust(target), { kind: 'written' }, spelling);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { trustedWorkspaces: [spelling, cwd] }, spelling);
			assert.deepStrictEqual(mergeTrust(target), { kind: 'there' }, spelling);
		}
		// A relative entry, or one that is not text, is never the folder
		fs.writeFileSync(file, JSON.stringify({ trustedWorkspaces: [path.basename(cwd), 7, null] }));
		assert.deepStrictEqual(mergeTrust(target), { kind: 'written' });
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { trustedWorkspaces: [path.basename(cwd), 7, null, cwd] });
		const unreadable: readonly (readonly [string, string])[] = [
			['{"trustedWorkspaces":{}}', 'has an object at ["trustedWorkspaces"], where a list belongs'],
			['{"trustedWorkspaces":"/a"}', 'has "/a" at ["trustedWorkspaces"], where a list belongs'],
			['{"trustedWorkspaces":true}', 'has true at ["trustedWorkspaces"], where a list belongs']
		];
		for (const [text, why] of unreadable) {
			fs.writeFileSync(file, text);
			assert.deepStrictEqual(mergeTrust(target), { kind: 'unreadable', why });
			assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
		}
		fs.writeFileSync(file, '{"trustedWorkspaces":{}}');
		assert.strictEqual(writeTrust('Antigravity', target), `Did not trust ${cwd} for Antigravity: ${file} has an object at ["trustedWorkspaces"], where a list belongs, so Facade left it as it is; Antigravity asks in its terminal.`);
	});
});

suite('CLIs: the window trusts each start\'s folder before it starts (CLIS-3.3, D62)', () => {
	let temp: ReturnType<typeof tempDir>;
	let home: string;
	let location: Location;
	let settings: { [name: string]: unknown };
	let destination: { host: { [name: string]: string }; terminal?: { [name: string]: string }; platform: NodeJS.Platform };

	const vscode = {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		workspace: { getConfiguration: (section?: string) => ({ get: (name: string) => settings[section ? `${section}.${name}` : name] }) }
	};
	const load = withModules({ vscode });
	const { HostClis } = load<typeof HostClisModule>(require.resolve('../host/clis'));

	setup(() => {
		temp = tempDir('fd-host-trust-');
		home = path.join(temp.dir, 'home');
		const bin = path.join(temp.dir, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
		fs.chmodSync(path.join(bin, 'claude'), 0o755);
		const cwd = path.join(temp.dir, 'repo');
		fs.mkdirSync(cwd);
		location = { id: 'loc-1', uri: `file://${cwd}`, path: cwd, label: 'repo', environment: 'local', folders: [] } as unknown as Location;
		settings = {};
		destination = { host: { PATH: bin, HOME: home }, platform: 'darwin' };
	});
	teardown(() => temp.remove());

	const clis = (log: string[] = []) => new HostClis({ read: name => settings[name], destination: () => destination, log: line => log.push(line) });
	const request = (cli: string, run: string): PlanRequest => ({ run, alias: '#a1', name: 'n', cli, location, yolo: false });

	test('Codex is planned through the same catalog, with per-launch trust and no native configuration writes', async () => {
		const program = path.join(temp.dir, 'bin', 'codex');
		fs.writeFileSync(program, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		fs.mkdirSync(home);
		const config = path.join(home, 'config.toml');
		const original = 'model = "keep-my-model"\n';
		fs.writeFileSync(config, original);
		destination.host.CODEX_HOME = home;
		const log: string[] = [];
		const planner = clis(log);
		assert.deepStrictEqual((await planner.list(location)).clis.map(cli => [cli.id, cli.available]), [['claude', true], ['codex', true], ['agy', false], ['muse', false], ['opencode', false], ['pi', false]]);
		const planned = await planner.plan(request('codex', 'codex-1'));
		assert.strictEqual(planned.cli, 'codex');
		assert.strictEqual(planned.env.CODEX_HOME, home);
		assert.strictEqual('trust' in planned, false);
		assert.deepStrictEqual([fs.readFileSync(config, 'utf8'), fs.readdirSync(home), log], [original, ['config.toml'], []]);
	});

	test('a start of Claude Code has its folder trusted in its own file, in the launch\'s home, said in the log; the core\'s plan names none of it', async () => {
		const log: string[] = [];
		const planner = clis(log);
		const claude = await planner.plan(request('claude', 'run-1'));
		assert.deepStrictEqual(['trust' in claude, JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))], [false, { projects: { [location.path]: { hasTrustDialogAccepted: true } } }]);
		// Up to what was merged: a Windows folder has a colon of its own after its drive
		assert.deepStrictEqual(log.map(line => line.slice(0, line.indexOf(': '))), [`Trusted ${location.path} for Claude Code`]);
		// Again: there already, nothing written or said
		await planner.plan(request('claude', 'run-2'));
		assert.strictEqual(log.length, 1);
		// Where the folder's terminal environment puts Claude Code's configuration
		destination = { ...destination, terminal: { CLAUDE_CONFIG_DIR: path.join(temp.dir, 'claude-config') } };
		await planner.plan(request('claude', 'run-3'));
		assert.ok(fs.existsSync(path.join(temp.dir, 'claude-config', '.claude.json')));
	});

	test('a start of Antigravity has its folder trusted in its own settings, in the launch\'s home, said in the log; Muse Code, OpenCode and Pi write nothing', async () => {
		for (const name of ['agy', 'muse', 'opencode', 'pi']) {
			fs.writeFileSync(path.join(temp.dir, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		}
		const log: string[] = [];
		const planner = clis(log);
		const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
		const folder = canonicalFolder(location.path);
		const agy = await planner.plan(request('agy', 'run-1'));
		assert.deepStrictEqual([agy.cli, 'trust' in agy, JSON.parse(fs.readFileSync(file, 'utf8'))], ['agy', false, { trustedWorkspaces: [folder] }]);
		assert.deepStrictEqual(log, [`Trusted ${folder} for Antigravity: merged ${JSON.stringify({ trustedWorkspaces: [folder] })} into ${file}.`]);
		await planner.plan(request('agy', 'run-2'));
		assert.strictEqual(log.length, 1);
		for (const cli of ['muse', 'opencode', 'pi']) {
			assert.strictEqual((await planner.plan(request(cli, `run-${cli}`))).cli, cli);
		}
		assert.deepStrictEqual([fs.readdirSync(home), log.length], [['.gemini'], 1]);
		// A settings file it cannot read: left as it is, and the start goes ahead
		fs.writeFileSync(file, '{ "trustedWorkspaces": ');
		assert.strictEqual((await planner.plan(request('agy', 'run-3'))).cli, 'agy');
		assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "trustedWorkspaces": ');
		assert.match(log[1], /^Did not trust .* for Antigravity: .*settings\.json is not valid JSON: .*, so Facade left it as it is; Antigravity asks in its terminal\.$/);
	});

	test('a file that cannot be read is left as it is and the start goes ahead, the log saying why; so does a lock that cannot be had', async () => {
		fs.mkdirSync(home);
		fs.writeFileSync(path.join(home, '.claude.json'), '{ broken');
		const log: string[] = [];
		const planned = await clis(log).plan(request('claude', 'run-1'));
		assert.strictEqual(planned.cli, 'claude');
		assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ broken');
		assert.match(log[0], /^Did not trust .* for Claude Code: .*\.claude\.json is not valid JSON: .*, so Facade left it as it is; Claude Code asks in its terminal\.$/);
		// Where the CLI's file cannot even be made: a file where its folder goes
		const blocked = path.join(temp.dir, 'claude-config');
		fs.writeFileSync(blocked, '');
		destination = { ...destination, terminal: { CLAUDE_CONFIG_DIR: blocked } };
		const again = await clis(log).plan(request('claude', 'run-2'));
		assert.strictEqual(again.cli, 'claude');
		assert.match(log[1], /^Did not trust .* for Claude Code in .*\.claude\.json: .*; Claude Code asks in its terminal\.$/);
	});
});
