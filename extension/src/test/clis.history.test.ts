/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { BATCH, MOST_READS_PER_BATCH, VendorHistory } from '../clis/history';
import { claudeProjectFolderName } from '../clis/history/claude';
import { piSessionDirectory } from '../clis/history/pi';
import { tempDir } from './util';

// Fixtures in the store formats these readers were written against: they test Facade's readers, not what a current CLI writes,
// which needs an isolated real CLI (CLIS-5.1). No test reads a real ~/.claude or ~/.codex: the stores are given by environment.

const homeEnv = (home: string) => ({ HOME: home, USERPROFILE: home });

const id = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Stores found by `env` for every directory, as both CLIs' launches would find them. */
const everywhere = (env: { readonly [name: string]: string }) => () => ({ claude: env, codex: env });

suite('CLIs: vendor conversation discovery for Resume (LIFECYCLE-3.2, CLIS-2.4)', () => {
	let temp: ReturnType<typeof tempDir>;
	let claudeDir: string;
	let codexHome: string;
	let repo: string;
	let history: VendorHistory;

	setup(() => {
		temp = tempDir('fd-history-');
		claudeDir = path.join(temp.dir, 'claude');
		codexHome = path.join(temp.dir, 'codex');
		repo = path.join(temp.dir, 'repo');
		fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
		fs.mkdirSync(`${repo}-other`);
		history = new VendorHistory({ environment: everywhere({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, ...homeEnv(path.join(temp.dir, 'home')) }) });
	});
	teardown(() => temp.remove());

	test('Pi reads native and overridden session roots, original cwd and the latest rename, without confusing encoded neighbour folders', async () => {
		const agent = path.join(temp.dir, 'pi');
		const dir = path.join(agent, 'sessions', '--work-repo--');
		fs.mkdirSync(dir, { recursive: true });
		const write = (n: number, cwd: string) => fs.writeFileSync(path.join(dir, `2026-10-31T00-00-00-000Z_${id(n)}.jsonl`), [
			{ type: 'session', version: 3, id: id(n), timestamp: '2026-10-31T00:00:00Z', cwd },
			{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix the test\nDetails' }] } },
			{ type: 'session_info', name: 'Named native work' }
		].map(line => JSON.stringify(line)).join('\n'));
		write(1, path.join(repo, 'pkg')); write(2, `${repo}-other`);
		for (const env of [{ PI_CODING_AGENT_DIR: agent }, { PI_CODING_AGENT_SESSION_DIR: dir }]) {
			const result = await new VendorHistory({ environment: () => ({ pi: env }) }).open({ environment: 'local', directories: [repo] }).next();
			assert.deepStrictEqual(result.entries.map(each => [each.key.sessionId, each.cwd, each.title]), [[id(1), path.join(repo, 'pkg'), 'Named native work']]);
		}
	});

	test('Pi discovery resolves native session-dir overrides in launch, environment, project and global precedence', () => {
		const home = path.join(temp.dir, 'home'), agent = path.join(home, '.pi', 'agent');
		fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(path.join(repo, '.pi'));
		const env = { HOME: home, USERPROFILE: home };
		fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: '~/global' }));
		assert.strictEqual(piSessionDirectory(env, repo), path.join(home, 'global'));
		fs.writeFileSync(path.join(repo, '.pi', 'settings.json'), JSON.stringify({ sessionDir: './project' }));
		assert.strictEqual(piSessionDirectory(env, repo), path.join(repo, 'project'));
		const override = { ...env, PI_CODING_AGENT_SESSION_DIR: '~/environment' };
		assert.strictEqual(piSessionDirectory(override, repo), path.join(home, 'environment'));
		assert.strictEqual(piSessionDirectory(override, repo, ['--session-dir', 'launch']), path.join(repo, 'launch'));
		assert.strictEqual(piSessionDirectory(override, repo, ['--session-dir=~/launch']), path.join(home, 'launch'));
	});

	test('OpenCode 2 SQLite history respects roots, archives and child sessions, and reads committed WAL changes', async () => {
		const { DatabaseSync } = await import('node:sqlite');
		const data = path.join(temp.dir, 'data');
		const dir = path.join(data, 'opencode'); fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'opencode.db');
		const db = new DatabaseSync(file);
		try {
			db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)');
			const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)');
			insert.run('ses_a1', repo, 'Native work', 1000, null, null);
			insert.run('ses_a2', path.join(repo, 'pkg'), 'Subfolder work', 2000, null, null);
			insert.run('ses_child', repo, 'Child', 3000, 'ses_a1', null);
			insert.run('ses_archived', repo, 'Archived', 4000, null, 4000);
			insert.run('ses_other', `${repo}-other`, 'Neighbour', 5000, null, null);
			const history = new VendorHistory({ environment: () => ({ opencode: { XDG_DATA_HOME: data } }) });
			const result = await history.open({ environment: 'local', directories: [repo] }).next();
			assert.deepStrictEqual(result.entries.map(each => [each.key.sessionId, each.title, each.cwd]), [['ses_a2', 'Subfolder work', path.join(repo, 'pkg')], ['ses_a1', 'Native work', repo]]);
		} finally { db.close(); }
	});

	test('Codex SQLite lists paginated native history with no rollout, preserves names and excludes indexed archives from the rollout fallback', async () => {
		const { DatabaseSync } = await import('node:sqlite');
		fs.mkdirSync(codexHome, { recursive: true });
		const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
		const archived = codex(repo, id(2), 10_000);
		try {
			db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, title TEXT, updated_at INTEGER, recency_at_ms INTEGER, rollout_path TEXT, history_mode TEXT, archived INTEGER, source TEXT)');
			const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
			insert.run(id(1), repo, 'User rename', 'First prompt', 1, 12345, '/absent/rollout.jsonl', 'paginated', 0, 'cli');
			insert.run(id(2), repo, null, 'Archived', 2, 20000, archived, 'legacy', 1, 'cli');
			insert.run(id(3), repo, null, 'Subagent', 3, 30000, '', 'paginated', 0, '{"subagent":{}}');
			const entries = await all();
			assert.deepStrictEqual(entries.map(each => [each.key.sessionId, each.title, each.activityAt]), [[id(1), 'User rename', 12345]]);
		} finally { db.close(); }
	});

	/** A Claude Code conversation of `cwd`, its lines as given, last active at `at`. */
	const claude = (cwd: string, sessionId: string, at: number, lines: readonly object[] = [{ type: 'user', sessionId, cwd, entrypoint: 'cli', message: { role: 'user', content: `Work ${sessionId.slice(-2)}` } }]) => {
		const dir = path.join(claudeDir, 'projects', claudeProjectFolderName(cwd));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${sessionId}.jsonl`);
		fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
		fs.utimesSync(file, at / 1000, at / 1000);
		return file;
	};
	/** A Codex rollout of `cwd`, by day as Codex keeps them, last active at `at`. */
	const codex = (cwd: string, sessionId: string, at: number, name = `rollout-${at}-${sessionId}.jsonl`) => {
		const dir = path.join(codexHome, 'sessions', '2026', '10', '27');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, name);
		fs.writeFileSync(file, [
			{ type: 'session_meta', payload: { id: sessionId, cwd, timestamp: new Date(at).toISOString(), originator: 'codex_vscode' } },
			{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] } },
			{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests\nwith detail' }] } }
		].map(line => JSON.stringify(line)).join('\n') + '\n');
		fs.utimesSync(file, at / 1000, at / 1000);
		return file;
	};
	const all = async (scope = [repo]) => {
		const pager = history.open({ environment: 'local', directories: scope });
		const entries = [];
		for (; ;) {
			const batch = await pager.next();
			entries.push(...batch.entries);
			if (batch.done) {
				return entries;
			}
		}
	};

	test('Claude uses native AI/custom titles from the tail, with latest summary and saved prompt fallbacks', async () => {
		const base = Date.UTC(2026, 9, 31, 18);
		const user = (sessionId: string) => ({ type: 'user', sessionId, cwd: repo, parentUuid: null, timestamp: new Date(base - 10_000).toISOString(), message: { content: 'can you pull remote' } });
		const padding = { type: 'attachment', padding: 'x'.repeat(180_000) };
		claude(repo, id(1), base, [user(id(1)), { type: 'ai-title', sessionId: id(1), aiTitle: 'Old title' }, padding,
			{ type: 'ai-title', sessionId: id(1), aiTitle: 'Pull remote' }]);
		claude(repo, id(2), base - 1000, [user(id(2)), padding,
			{ type: 'custom-title', sessionId: id(2), customTitle: 'Previous rename' },
			{ type: 'custom-title', sessionId: id(2), customTitle: 'Release notes' },
			{ type: 'ai-title', sessionId: id(2), aiTitle: 'Generated later' }]);
		claude(repo, id(3), base - 2000, [user(id(3)), { type: 'summary', summary: 'Old summary' }, padding, { type: 'summary', summary: 'Final summary' }]);
		claude(repo, id(4), base - 3000, [user(id(4)), padding, { type: 'last-prompt', sessionId: id(4), lastPrompt: 'Latest native prompt' }]);
		assert.deepStrictEqual((await all()).map(entry => entry.title), ['Pull remote', 'Release notes', 'Final summary', 'Latest native prompt']);
	});

	test('Claude renames in sidecars invalidate cached titles without touching the transcript, and a tail rename takes precedence', async () => {
		const base = Date.UTC(2026, 9, 31);
		const file = claude(repo, id(1), base, [
			{ type: 'user', sessionId: id(1), cwd: repo, message: { content: 'First prompt' } },
			{ type: 'custom-title', sessionId: id(1), customTitle: 'Old head title' },
			{ type: 'attachment', padding: 'x'.repeat(180_000) },
			{ type: 'ai-title', sessionId: id(1), aiTitle: 'AI title' }
		]);
		const title = async () => (await all())[0].title;
		assert.strictEqual(await title(), 'Old head title');
		const sidecar = path.join(path.dirname(file), id(1), 'custom-title.json');
		fs.mkdirSync(path.dirname(sidecar));
		fs.writeFileSync(sidecar, JSON.stringify({ customTitle: 'Native rename' }));
		assert.strictEqual(await title(), 'Native rename');
		fs.writeFileSync(sidecar, JSON.stringify({ customTitle: 'Second rename' }));
		assert.strictEqual(await title(), 'Second rename');
		fs.unlinkSync(sidecar);
		assert.strictEqual(await title(), 'Old head title');
		fs.writeFileSync(sidecar, JSON.stringify({ customTitle: 'Stale sidecar' }));
		fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', sessionId: id(1), customTitle: 'Latest tail title' }) + '\n');
		fs.utimesSync(file, base / 1000, base / 1000);
		assert.strictEqual(await title(), 'Latest tail title');
		fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', sessionId: id(1), customTitle: '' }) + '\n');
		assert.strictEqual(await title(), 'AI title');
	});

	test('Claude activity is the last valid user/assistant timestamp, bounded by mtime; maintenance and renaming do not reorder work', async () => {
		const base = Date.UTC(2026, 9, 31);
		claude(repo, id(1), base + 50_000, [
			{ type: 'user', sessionId: id(1), cwd: repo, timestamp: new Date(base).toISOString(), message: { content: 'Older work' } },
			{ type: 'assistant', sessionId: id(1), timestamp: new Date(base + 2000).toISOString(), message: { content: [] } },
			{ type: 'assistant', timestamp: 'invalid' },
			{ type: 'system', timestamp: new Date(base + 40_000).toISOString() },
			{ type: 'custom-title', sessionId: id(1), customTitle: 'Renamed old work' }
		]);
		codex(repo, id(2), base + 3000);
		claude(repo, id(3), base + 1000, [{ type: 'user', sessionId: id(3), cwd: repo, timestamp: new Date(base + 90_000).toISOString(), message: { content: 'Future clock' } }]);
		assert.deepStrictEqual((await all()).map(entry => [entry.key.sessionId, entry.activityAt]), [[id(2), base + 3000], [id(1), base + 2000], [id(3), base + 1000]]);
	});

	test('Claude hides a continued segment only while its successor has conversation records; dependency changes invalidate the cache', async () => {
		const base = Date.UTC(2026, 9, 31);
		const source = [{ type: 'user', sessionId: id(1), cwd: repo, parentUuid: null, message: { content: 'Original' } },
			{ type: 'continued-in', sessionId: id(1), continuedInSessionId: id(2) }];
		const file = claude(repo, id(1), base, source);
		const ids = async () => (await all()).map(entry => entry.key.sessionId);
		assert.deepStrictEqual(await ids(), [id(1)]);
		const successor = claude(repo, id(2), base + 1000, [{ type: 'custom-title', sessionId: id(2), customTitle: 'Only bookkeeping' }]);
		assert.deepStrictEqual(await ids(), [id(1)]);
		claude(repo, id(2), base + 1000, [{ type: 'user', sessionId: id(2), cwd: repo, parentUuid: null, message: { content: 'Continued work' } }]);
		assert.deepStrictEqual(await ids(), [id(2)]);
		fs.unlinkSync(successor);
		assert.deepStrictEqual(await ids(), [id(1)]);
		claude(repo, id(2), base + 1000, [{ type: 'user', sessionId: id(2), cwd: repo, parentUuid: null, message: { content: 'Continued work' } }]);
		fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: id(1), cwd: repo, message: { content: 'Independent work after continuation' } }) + '\n');
		fs.utimesSync(file, (base + 2000) / 1000, (base + 2000) / 1000);
		assert.deepStrictEqual(await ids(), [id(1), id(2)]);
	});

	test('Claude forks can contain copied parent IDs; child and daemon transcripts are not root conversations', async () => {
		const base = Date.UTC(2026, 9, 31);
		claude(repo, id(1), base, [{ type: 'user', sessionId: id(99), cwd: repo, message: { content: 'Parent prompt' } },
			{ type: 'ai-title', sessionId: id(1), aiTitle: 'Fork title' }]);
		for (const [i, fields] of [{ isSidechain: true }, { teamName: 'workers' }, { sessionKind: 'daemon' }, { sessionKind: 'daemon-worker' }].entries()) {
			claude(repo, id(i + 2), base + i, [{ type: 'user', sessionId: id(i + 2), cwd: repo, ...fields, message: { content: 'Internal work' } }]);
		}
		assert.deepStrictEqual((await all()).map(entry => [entry.key.sessionId, entry.title]), [[id(1), 'Fork title']]);
	});

	test('native activity orders every page even when all file mtimes are newer, and read bounds retain pending entries', async () => {
		const base = Date.UTC(2026, 9, 31);
		const count = MOST_READS_PER_BATCH + 3;
		for (let n = 0; n < count; n++) {
			claude(repo, id(n), base + 100_000 + count - n, [{ type: 'user', sessionId: id(n), cwd: repo,
				timestamp: new Date(base + n).toISOString(), message: { content: `Work ${n}` } }]);
		}
		const pager = history.open({ environment: 'local', directories: [repo] });
		assert.deepStrictEqual(await pager.next(), { entries: [], done: false });
		const entries = [];
		for (;;) {
			const batch = await pager.next();
			entries.push(...batch.entries);
			if (batch.done) { break; }
			assert.strictEqual(batch.entries.length, BATCH);
		}
		assert.deepStrictEqual(entries.map(entry => entry.key.sessionId), Array.from({ length: count }, (_, n) => id(count - n - 1)));
	});

	test('both stores, the scope\'s folders and the folders below them, most recently active first, with title, folder and time; each conversation\'s own lines confirm its folder', async () => {
		const base = Date.UTC(2026, 9, 27, 12);
		claude(repo, id(1), base + 1_000);
		claude(path.join(repo, 'pkg'), id(2), base + 3_000, [{ type: 'summary', summary: 'Refactor the parser' }, { type: 'user', sessionId: id(2), cwd: path.join(repo, 'pkg'), message: { content: 'x' } }]);
		// A lossy project-folder name of a neighbour, a file naming another conversation, and an unrelated project
		claude(`${repo}-other`, id(3), base + 4_000);
		claude(repo, id(4), base + 5_000, [{ type: 'user', sessionId: id(99), cwd: repo }]);
		claude(path.join(temp.dir, 'elsewhere'), id(5), base + 6_000);
		codex(repo, id(6), base + 2_000);
		codex(path.join(temp.dir, 'elsewhere'), id(7), base + 7_000);
		const entries = await all();
		assert.deepStrictEqual(entries.map(entry => [entry.key.cli, entry.key.sessionId, entry.title, entry.cwd, entry.activityAt]), [
			['claude', id(2), 'Refactor the parser', path.join(repo, 'pkg'), base + 3_000],
			['codex', id(6), 'Add tests', repo, base + 2_000],
			['claude', id(1), 'Work 01', repo, base + 1_000]
		]);
		assert.ok(entries.every(entry => entry.key.environment === 'local' && entry.unavailable === undefined));
	});

	test('a title is the first prompt even after a preamble longer than the head: Codex writes its instructions and skills first', async () => {
		const base = Date.UTC(2026, 9, 29, 10);
		// As Codex 0.165.0 writes a rollout: about 100 KB of developer instructions before the environment and the first prompt
		const preamble = { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x'.repeat(100 * 1024) }] } };
		const file = codex(repo, id(1), base);
		const [meta, ...rest] = fs.readFileSync(file, 'utf8').trim().split('\n');
		fs.writeFileSync(file, [meta, JSON.stringify(preamble), ...rest].join('\n') + '\n');
		fs.utimesSync(file, base / 1000, base / 1000);
		claude(repo, id(2), base - 1_000, [
			{ type: 'user', sessionId: id(2), cwd: repo, message: { role: 'user', content: `<command-name>${'y'.repeat(100 * 1024)}</command-name>` } },
			{ type: 'user', sessionId: id(2), cwd: repo, message: { role: 'user', content: 'What time is it?' } }
		]);
		assert.deepStrictEqual((await all()).map(entry => [entry.key.cli, entry.title]), [['codex', 'Add tests'], ['claude', 'What time is it?']]);
	});

	/** Antigravity 1.4.10's summary table, as its store has it. */
	const AGY_SCHEMA = 'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "", raw_summary BLOB, group_id TEXT NOT NULL DEFAULT \'\',PRIMARY KEY (`conversation_id`))';
	type AgyRow = { readonly id: string; readonly folders: readonly string[]; readonly at: number; readonly title?: string; readonly preview?: string; readonly parent?: string; readonly file?: boolean };
	/** Antigravity's store in `home`: a summary row each, as it writes them, and the conversation's own file unless it dropped it. */
	const agy = (home: string, rows: readonly AgyRow[]) => {
		const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
		const dir = path.join(home, '.gemini', 'antigravity-cli');
		fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
		const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
		db.exec('PRAGMA journal_mode=WAL');
		db.exec(AGY_SCHEMA);
		const insert = db.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?)');
		for (const row of rows) {
			const time = new Date(row.at).toISOString().replace('T', ' ').replace('Z', '+00:00');
			insert.run(row.id, row.title ?? '', row.preview ?? '', time, JSON.stringify(row.folders.map(folder => pathToFileURL(folder).href).sort()), row.parent ?? '', time);
			if (row.file !== false) {
				fs.writeFileSync(path.join(dir, 'conversations', `${row.id}.db`), '');
			}
		}
		return { dir, db };
	};

	test('Antigravity: its summaries of the folder\'s and subfolders\' conversations, titled by its own title else the first prompt; not a subagent\'s, one whose file it dropped, or another folder\'s; read without leaving a file beside its database', async () => {
		const home = path.join(temp.dir, 'agy-home');
		const base = Date.UTC(2026, 9, 29, 10);
		const spaced = path.join(repo, 'My Project', 'café');
		fs.mkdirSync(spaced, { recursive: true });
		const { dir, db } = agy(home, [
			{ id: id(1), folders: [repo], at: base + 1_000, title: 'Fix Login Redirect' },
			{ id: id(2), folders: [path.join(repo, 'pkg')], at: base + 2_000, preview: 'please look at the failing test\nin src/app.ts' },
			// --add-dir folders are sorted in with its own: the remaining in-scope choice still needs explicit confirmation
			{ id: id(3), folders: [path.join(temp.dir, 'aaa-messages'), repo], at: base + 3_000, title: 'Refactor Billing' },
			{ id: id(4), folders: [spaced], at: base + 4_000, title: 'Translate Readme' },
			{ id: id(5), folders: [repo], at: base + 5_000, title: 'Explore Codebase', parent: id(3) },
			{ id: id(6), folders: [repo], at: base + 6_000, title: 'Old Migration Plan', file: false },
			{ id: id(7), folders: [path.join(temp.dir, 'elsewhere')], at: base + 7_000, title: 'Elsewhere' }
		]);
		db.close();
		const history = new VendorHistory({ environment: () => ({ agy: homeEnv(home) }) });
		const list = async () => (await history.open({ environment: 'local', directories: [repo] }).next()).entries.map(entry => [entry.key.cli, entry.key.sessionId, entry.title, entry.cwd, entry.activityAt]);
		const listed = await list();
		const left = fs.readdirSync(dir).filter(name => name.startsWith('conversation_summaries'));
		// While Antigravity writes a conversation, what it has not yet merged into the database is read too
		const writing = agy(path.join(temp.dir, 'agy-busy'), []);
		writing.db.prepare('INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, last_user_input_time) VALUES (?, ?, ?, ?, ?)').run(id(8), 'Write Release Notes', '2026-10-29 18:01:33.762093+00:00', JSON.stringify([pathToFileURL(repo).href]), '2026-10-29 18:01:33+00:00');
		fs.writeFileSync(path.join(writing.dir, 'conversations', `${id(8)}.db`), '');
		const busy = await new VendorHistory({ environment: () => ({ agy: { ...homeEnv(path.join(temp.dir, 'agy-busy')) } }) }).open({ environment: 'local', directories: [repo] }).next();
		writing.db.close();
		assert.deepStrictEqual([listed, left, busy.entries.map(entry => [entry.title, entry.activityAt])], [[
			['agy', id(4), 'Translate Readme', spaced, base + 4_000],
			['agy', id(3), 'Refactor Billing', repo, base + 3_000],
			['agy', id(2), 'please look at the failing test', path.join(repo, 'pkg'), base + 2_000],
			['agy', id(1), 'Fix Login Redirect', repo, base + 1_000]
		], ['conversation_summaries.db'], [['Write Release Notes', Date.UTC(2026, 9, 29, 18, 1, 33, 762)]]]);
	});

	test('Antigravity preserves an ambiguous native workspace set; a previously observed cwd resolves it without guessing from sorted roots', async () => {
		const home = path.join(temp.dir, 'agy-roots'), a = path.join(repo, 'a'), z = path.join(repo, 'z');
		fs.mkdirSync(a); fs.mkdirSync(z);
		const { db } = agy(home, [{ id: id(1), folders: [z, a], at: Date.now() }]); db.close();
		const options = { environment: () => ({ agy: homeEnv(home) }) };
		const scope = { environment: 'local', directories: [repo] };
		const found = (await new VendorHistory(options).open(scope).next()).entries[0];
		assert.deepStrictEqual(found.cwdChoices, [a, z]);
		const known = (await new VendorHistory({ ...options, knownCwd: () => z }).open(scope).next()).entries[0];
		assert.strictEqual(known.cwd, z); assert.strictEqual(known.cwdChoices, undefined);
	});

	/** Muse Code 1.4.14's index of conversations, as its data folder has it. */
	const MUSE_SCHEMA = 'CREATE TABLE "sessions" ( session_id TEXT PRIMARY KEY, session_stream_id TEXT NOT NULL, session_dir TEXT NOT NULL, session_log_path TEXT NOT NULL UNIQUE, layout TEXT NOT NULL, workspace_root TEXT, workspace_key TEXT, provider_id TEXT, model_id TEXT, git_branch TEXT, title TEXT NOT NULL, effective_long_title TEXT, title_provenance TEXT CHECK(title_provenance IN (\'generated\',\'manual\')), title_name_fingerprint TEXT, title_source_fingerprint TEXT, first_user_prompt TEXT, search_text TEXT NOT NULL, created_at_us INTEGER, updated_at_us INTEGER, prompt_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, status_rank INTEGER NOT NULL, source_fingerprint TEXT, indexed_at_us INTEGER NOT NULL, latest_segment_terminated INTEGER NOT NULL DEFAULT 0, session_name TEXT, session_name_revision INTEGER CHECK(session_name_revision >= 0), session_name_description_dependency TEXT, msp_created_at_us INTEGER, msp_updated_at_us INTEGER, msp_last_activity_at_us INTEGER, msp_order_key_us INTEGER, msp_turn_count INTEGER, msp_fork_source_session_id TEXT, msp_fork_cut_cursor TEXT, msp_fork_cut_explicit INTEGER, msp_fork_command_id TEXT, msp_provider_id TEXT, msp_model_id TEXT, msp_title TEXT, msp_first_user_prompt TEXT, msp_branch TEXT, msp_source_fingerprint TEXT, msp_kind TEXT, msp_parent_session_id TEXT, msp_created_by_client_name TEXT, msp_created_by_client_version TEXT, logged_session_name TEXT, logged_session_name_revision INTEGER, logged_session_name_seeded INTEGER, msp_resumed_by_client_name TEXT, msp_resumed_by_client_version TEXT, msp_spawned_by_parent_session_id TEXT, msp_spawned_by_project TEXT, msp_spawned_by_thread TEXT, CHECK ((effective_long_title IS NULL) = (title_provenance IS NULL)), CHECK (effective_long_title IS NULL OR title_provenance=\'generated\' OR title_name_fingerprint IS NOT NULL), CHECK ((session_name IS NULL) = (session_name_revision IS NULL)));';
	type MuseRow = { readonly id: string; readonly cwd: string; readonly prompt?: string; readonly name?: string; readonly at: number; readonly last?: number; readonly prompts?: number; readonly status?: string; readonly log?: boolean };
	/** Muse Code's data folder `dir`: a row each, as its index keeps them, and the conversation's log unless it is gone. */
	const muse = (dir: string, rows: readonly MuseRow[]) => {
		const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
		fs.mkdirSync(dir, { recursive: true });
		const db = new DatabaseSync(path.join(dir, 'session-index.db'));
		db.exec('PRAGMA journal_mode=WAL');
		db.exec(MUSE_SCHEMA);
		const insert = db.prepare(`INSERT INTO sessions (session_id, session_stream_id, session_dir, session_log_path, layout, workspace_root, workspace_key, title, first_user_prompt,
			search_text, created_at_us, updated_at_us, prompt_count, status, status_rank, indexed_at_us, session_name, session_name_revision, msp_last_activity_at_us, msp_kind)
			VALUES (?, ?, ?, ?, 'v2', ?, ?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'root')`);
		for (const row of rows) {
			const folder = path.join(dir, 'sessions', '2026', '10', '29', row.id);
			const log = path.join(folder, 'session.jsonl');
			if (row.log !== false) {
				fs.mkdirSync(folder, { recursive: true });
				fs.writeFileSync(log, '{}\n');
			}
			const us = row.at * 1000;
			insert.run(row.id, row.id, folder, log, row.cwd, row.cwd, row.prompt ?? 'New session', row.prompt ?? null, us, us, row.prompts ?? (row.prompt ? 1 : 0), row.status ?? 'valid', us,
				row.name ?? null, row.name ? 1 : null, row.last === undefined ? null : row.last * 1000);
		}
		db.close();
	};

	test('Muse Code: its index\'s conversations of the folder and subfolders, titled by the name the person gave else the first line of their first prompt; not one without a prompt, invalid, whose log is gone or another folder\'s; XDG_DATA_HOME moves it', async () => {
		const base = Date.UTC(2026, 9, 29, 10);
		const data = path.join(temp.dir, 'xdg', 'muse');
		muse(data, [
			{ id: id(1), cwd: repo, prompt: 'Add a README section about installing the CLI.', at: base + 1_000 },
			{ id: id(2), cwd: repo, prompt: 'Refactor the login form\ninto two components.', name: 'login-refactor', at: base + 2_000 },
			// The last turn's end orders it, not a later reopening
			{ id: id(3), cwd: path.join(repo, 'pkg'), prompt: 'Explain the build script.', at: base + 9_000, last: base + 3_000 },
			{ id: id(4), cwd: repo, at: base + 4_000 },
			{ id: id(5), cwd: repo, prompt: 'Broken', at: base + 5_000, status: 'invalid' },
			{ id: id(6), cwd: repo, prompt: 'Old plan', at: base + 6_000, log: false },
			{ id: id(7), cwd: path.join(temp.dir, 'elsewhere'), prompt: 'Elsewhere', at: base + 7_000 }
		]);
		const listed = async (env: { readonly [name: string]: string }) => (await new VendorHistory({ environment: () => ({ muse: env }) }).open({ environment: 'local', directories: [repo] }).next()).entries
			.map(entry => [entry.key.cli, entry.key.sessionId, entry.title, entry.cwd, entry.activityAt]);
		const fromXdg = await listed({ XDG_DATA_HOME: path.join(temp.dir, 'xdg'), ...homeEnv(path.join(temp.dir, 'home')) });
		muse(path.join(temp.dir, 'home', '.local', 'share', 'muse'), [{ id: id(8), cwd: repo, prompt: 'In the home folder', at: base }]);
		assert.deepStrictEqual([fromXdg, await listed({ ...homeEnv(path.join(temp.dir, 'home')) })], [[
			['muse', id(3), 'Explain the build script.', path.join(repo, 'pkg'), base + 3_000],
			['muse', id(2), 'login-refactor', repo, base + 2_000],
			['muse', id(1), 'Add a README section about installing the CLI.', repo, base + 1_000]
		], [['muse', id(8), 'In the home folder', repo, base]]]);
	});

	test('one entry per CLI and session - its most recent file - and one whose folder is gone, or whose CLI cannot run here, says why', async () => {
		const base = Date.UTC(2026, 9, 27, 12);
		codex(repo, id(1), base + 1_000, 'rollout-a.jsonl');
		codex(repo, id(1), base + 5_000, 'rollout-b.jsonl');
		const gone = path.join(repo, 'deleted');
		claude(gone, id(2), base + 2_000);
		const entries = await all();
		assert.deepStrictEqual(entries.map(entry => [entry.key.sessionId, entry.activityAt, entry.unavailable]), [
			[id(1), base + 5_000, undefined],
			[id(2), base + 2_000, `Its working directory no longer exists: ${gone}`]
		]);
		const limited = new VendorHistory({ environment: everywhere({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, ...homeEnv(temp.dir) }), unavailable: cli => cli === 'codex' ? 'codex was not found on the PATH' : undefined });
		const batch = await limited.open({ environment: 'local', directories: [repo] }).next();
		assert.strictEqual(batch.entries[0].unavailable, 'codex was not found on the PATH');
	});

	test('a picker session asks once per CLI and folder whether a conversation can be resumed there, however many it lists (LIFECYCLE-3.2)', async () => {
		const base = Date.UTC(2026, 9, 27, 12);
		for (let n = 0; n < 12; n++) {
			claude(repo, id(n), base + n * 1_000);
		}
		claude(path.join(repo, 'pkg'), id(20), base + 20_000);
		codex(repo, id(30), base + 30_000);
		const asked: string[] = [];
		const counting = new VendorHistory({ environment: everywhere({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, ...homeEnv(temp.dir) }), unavailable: (cli, cwd) => { asked.push(`${cli} ${path.relative(repo, cwd) || '.'}`); return undefined; } });
		const pager = counting.open({ environment: 'local', directories: [repo] });
		assert.strictEqual((await pager.next()).entries.length, 14);
		assert.deepStrictEqual(asked.sort(), ['claude .', `claude pkg`, 'codex .']);
		await counting.open({ environment: 'local', directories: [repo] }).next();
		assert.strictEqual(asked.length, 6, 'a new picker session asks again: a CLI installed meanwhile is found');
	});

	test('batches of 100, with no age cutoff; a batch that reaches its read bound ends early and the next goes on, so an older match stays reachable', async () => {
		const base = Date.UTC(2020, 0, 1);
		for (let n = 0; n < 230; n++) {
			claude(repo, id(n), base + n * 1_000);
		}
		const pager = history.open({ environment: 'local', directories: [repo] });
		const sizes: [number, boolean][] = [];
		for (let batch = await pager.next(); ; batch = await pager.next()) {
			sizes.push([batch.entries.length, batch.done]);
			if (batch.done) {
				break;
			}
		}
		assert.deepStrictEqual(sizes, [[BATCH, false], [BATCH, false], [30, true]]);
		// Far more unrelated rollouts than a batch reads, all newer than the one that matches
		const old = new VendorHistory({ environment: everywhere({ CLAUDE_CONFIG_DIR: path.join(temp.dir, 'none'), CODEX_HOME: codexHome, ...homeEnv(temp.dir) }) });
		for (let n = 0; n < MOST_READS_PER_BATCH + 20; n++) {
			codex(path.join(temp.dir, 'elsewhere'), id(1_000 + n), base + 10_000_000 + n, `rollout-x-${n}.jsonl`);
		}
		codex(repo, id(7), base, 'rollout-old.jsonl');
		const continuing = old.open({ environment: 'local', directories: [repo] });
		const first = await continuing.next();
		const second = await continuing.next();
		assert.deepStrictEqual([first.entries.length, first.done, second.entries.map(entry => entry.key.sessionId), second.done], [0, false, [id(7)], true]);
	});

	test('a picker session reads each file\'s head once, and a later session reuses what was read for files that did not change', async () => {
		const base = Date.UTC(2026, 9, 27);
		for (let n = 0; n < 5; n++) {
			claude(repo, id(n), base + n);
		}
		codex(repo, id(9), base + 9);
		const nodeFs: typeof fs = require('fs');
		const original = nodeFs.promises.open;
		let opened = 0;
		nodeFs.promises.open = (async (...args: Parameters<typeof original>) => {
			opened++;
			return original(...args);
		}) as typeof original;
		try {
			assert.strictEqual((await all()).length, 6);
			const firstSession = opened;
			assert.strictEqual((await all()).length, 6);
			assert.deepStrictEqual([firstSession, opened], [6, 6]);
			claude(repo, id(0), base + 100, [{ type: 'user', sessionId: id(0), cwd: repo, message: { content: 'Changed' } }]);
			const again = await all();
			assert.deepStrictEqual([opened, again[0].title], [7, 'Changed']);
		} finally {
			nodeFs.promises.open = original;
		}
	});

	test('a closed picker session reads nothing more; stores that are not there list nothing', async () => {
		claude(repo, id(1), Date.now());
		const pager = history.open({ environment: 'local', directories: [repo] });
		pager.dispose();
		assert.deepStrictEqual(await pager.next(), { entries: [], done: true });
		const empty = new VendorHistory({ environment: everywhere({ CLAUDE_CONFIG_DIR: path.join(temp.dir, 'none'), CODEX_HOME: path.join(temp.dir, 'none'), ...homeEnv(temp.dir) }) });
		assert.deepStrictEqual(await empty.open({ environment: 'local', directories: [repo] }).next(), { entries: [], done: true });
	});

	test('each directory\'s stores are those its CLIs\' launch environment finds - CLAUDE_CONFIG_DIR, CODEX_HOME, else the home folder - never the extension host\'s own (CLIS-1.2)', async () => {
		const base = Date.UTC(2026, 9, 27, 12);
		const other = path.join(temp.dir, 'other');
		fs.mkdirSync(other);
		const otherHome = path.join(temp.dir, 'other-home');
		// The repo's launches use the stores above; the other folder's have none configured, so theirs are in its home folder
		claude(repo, id(1), base + 1_000);
		codex(repo, id(2), base + 2_000);
		const otherClaude = path.join(otherHome, '.claude', 'projects', claudeProjectFolderName(other));
		fs.mkdirSync(otherClaude, { recursive: true });
		fs.writeFileSync(path.join(otherClaude, `${id(3)}.jsonl`), JSON.stringify({ type: 'user', sessionId: id(3), cwd: other, message: { content: 'Other work' } }) + '\n');
		fs.utimesSync(path.join(otherClaude, `${id(3)}.jsonl`), (base + 3_000) / 1000, (base + 3_000) / 1000);
		// A rollout of the other folder in the repo's Codex home: the other folder's Resume would not find it there
		codex(other, id(4), base + 4_000);
		const asked: string[] = [];
		const scoped = new VendorHistory({
			environment: directory => {
				asked.push(directory);
				return directory === repo
					? { claude: { CLAUDE_CONFIG_DIR: claudeDir, ...homeEnv(otherHome) }, codex: { CODEX_HOME: codexHome, ...homeEnv(otherHome) } }
					: { claude: { ...homeEnv(otherHome) }, codex: { ...homeEnv(otherHome) } };
			}
		});
		const pager = scoped.open({ environment: 'local', directories: [repo, other] });
		const entries = (await pager.next()).entries;
		assert.deepStrictEqual(entries.map(entry => [entry.key.cli, entry.key.sessionId, entry.cwd]), [
			['claude', id(3), other],
			['codex', id(2), repo],
			['claude', id(1), repo]
		]);
		// Asked once per directory in a picker session, not per page or per file
		await pager.next();
		assert.deepStrictEqual(asked, [repo, other]);
	});
});
