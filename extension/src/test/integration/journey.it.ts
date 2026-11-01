/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const RECORD = process.env.FACADE_IT_RECORD!;
const CLI = process.env.FACADE_IT_CLI ?? 'claude';
const AVATAR = process.env.FACADE_IT_AVATAR ?? `avatar-${CLI}.png`;
/** The home folder the suite's settings give agents' terminals (`terminal.integrated.env.*`). */
const AGENTS_HOME = process.env.FACADE_IT_AGENTS_HOME;

/**
 * The arguments each built-in is started with in a folder with YOLO on, the default (CLIS-1.3, 3.3) - Codex's trust is checked apart -
 * and the custom CLI the suite configures, with its start arguments exactly as configured (CLIS-3.4).
 */
const ARGUMENTS: { readonly [cli: string]: readonly string[] } = {
	claude: ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""}}', '--dangerously-skip-permissions'],
	agy: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
	muse: ['--disable-approval', '--disable-sandbox', '--trust-workspace'],
	opencode: ['--auto'],
	pi: ['--approve'],
	'my-cli': ['--from-custom', 'two words']
};
/** Whether this run's CLI is the suite's custom one rather than a built-in. */
const CUSTOM = CLI === 'my-cli';

/** Native store fixtures: actual vendor interoperability is verified separately with isolated native CLIs. */
function resumeFixture(cwd: string): { sessionId: string; args: string[] } {
	const id = '86da4482-2bae-4a45-b193-a5664c19826a', title = 'Resume integration fixture';
	const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
	const sqlite = (file: string, sql: string, insert: string, values: (string | number)[]) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const db = new DatabaseSync(file); try { db.exec(sql); db.prepare(insert).run(...values); } finally { db.close(); }
	};
	if (CLI === 'claude') {
		const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
		write(path.join(dir, `${id}.jsonl`), [
			{ type: 'user', sessionId: id, cwd, parentUuid: null, message: { role: 'user', content: 'Initial prompt before native naming' } },
			{ type: 'attachment', padding: 'x'.repeat(80_000) },
			{ type: 'assistant', sessionId: id, timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(), message: { role: 'assistant', content: [] } },
			{ type: 'ai-title', sessionId: id, aiTitle: title }
		].map(value => JSON.stringify(value)).join('\n') + '\n');
	} else if (CLI === 'codex') {
		write(path.join(AGENTS_HOME!, '.codex', 'sessions', '2026', '10', '31', `rollout-it-${id}.jsonl`), [
			{ type: 'session_meta', payload: { id, cwd } },
			{ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: title }] } }
		].map(value => JSON.stringify(value)).join('\n'));
	} else if (CLI === 'pi') {
		write(path.join(AGENTS_HOME!, '.pi', 'agent', 'sessions', '--integration--', `${id}.jsonl`), [
			{ type: 'session', version: 3, id, cwd }, { type: 'message', message: { role: 'user', content: title } }
		].map(value => JSON.stringify(value)).join('\n'));
	} else if (CLI === 'agy') {
		const dir = path.join(AGENTS_HOME!, '.gemini', 'antigravity-cli');
		write(path.join(dir, 'conversations', `${id}.db`), 'fixture');
		sqlite(path.join(dir, 'conversation_summaries.db'), 'CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT)',
			'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)', [id, title, title, new Date().toISOString(), JSON.stringify([pathToFileURL(cwd).href]), '']);
	} else if (CLI === 'opencode') {
		const session = 'ses_integration';
		sqlite(path.join(AGENTS_HOME!, '.local', 'share', 'opencode', 'opencode.db'), 'CREATE TABLE IF NOT EXISTS session_v2 (id TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)',
			'INSERT INTO session_v2 VALUES (?, ?, ?, ?, NULL)', [session, cwd, title, Date.now()]);
		return { sessionId: session, args: ['--session', session] };
	} else if (CLI === 'muse') {
		const dir = path.join(AGENTS_HOME!, '.local', 'share', 'muse'), log = path.join(dir, `${id}.jsonl`);
		write(log, '{}\n');
		sqlite(path.join(dir, 'session-index.db'), 'CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, workspace_root TEXT, status TEXT, prompt_count INTEGER, session_log_path TEXT, first_user_prompt TEXT, updated_at_us INTEGER)',
			"INSERT OR REPLACE INTO sessions VALUES (?, ?, 'valid', 1, ?, ?, ?)", [id, cwd, log, title, Date.now() * 1000]);
	}
	return { sessionId: id, args: [({ codex: 'resume', muse: 'resume', agy: '--conversation', pi: '--session' } as Record<string, string>)[CLI] ?? '--resume', id] };
}

/** Whether two paths name one folder as this system names them: Windows ignores case, and VS Code writes its drive in lower case. */
function sameFolder(a: string, b: string): boolean {
	return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

/** New Agent with the preselected CLI, accepted as soon as its picker shows: the card it creates. */
async function newCard(): Promise<PanelState['cards'][number]> {
	const before = (await state()).cardCount;
	void vscode.commands.executeCommand('facade.newAgent');
	// The picker shows once its CLIs are found: accepted as soon as it is there, however long that takes
	return until('a new card', async () => {
		const now = await state();
		if (now.cardCount > before) {
			return now.cards[0];
		}
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

suite(`Journey: a person starts and closes ${CLI} (J01, J07)`, () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('New Agent with the preselected CLI creates the card and terminal at once, and its CLI runs in the folder', async () => {
		const card = await newCard();
		assert.ok(vscode.window.terminals.some(terminal => terminal.name.startsWith(card.name)), 'its editor terminal exists');
		const alias = card.tooltip.join(' ').match(/#a\d+/)?.[0];
		assert.ok(alias, 'the card shows its short ID');
		const pidFile = `${RECORD}.${alias}`;
		const pid = await until('the fake CLI to start', async () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : undefined);
		assert.ok(alive(pid));
		// A built-in's maker avatar; the custom CLI's initial on a theme colour, and the terminal icon on its tab (PANEL-1.3, LIFECYCLE-2.2)
		if (CUSTOM) {
			const avatar = card.avatar as { initial: string; color: string };
			assert.deepStrictEqual([avatar.initial, ['blue', 'orange', 'purple'].includes(avatar.color)], ['M', true]);
			const terminal = vscode.window.terminals.find(each => each.name.startsWith(card.name))!;
			assert.strictEqual(((terminal.creationOptions as vscode.TerminalOptions).iconPath as vscode.ThemeIcon).id, 'terminal');
		} else {
			assert.deepStrictEqual(card.avatar, { file: AVATAR });
		}
		const launch = JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] };
		assert.ok(sameFolder(launch.cwd, vscode.workspace.workspaceFolders![0].uri.fsPath), `${launch.cwd} is the workspace folder`);
		if (CLI === 'codex') {
			assert.strictEqual(launch.args[0], '--dangerously-bypass-approvals-and-sandbox');
			assert.ok(launch.args.some(arg => arg.startsWith('projects={ ') && arg.includes('trust_level = "trusted"')));
		} else if (CLI === 'claude') {
			assert.strictEqual(launch.args[0], '--settings');
			const settings = JSON.parse(launch.args[1]);
			assert.deepStrictEqual(settings.env, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' });
			assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('hook.cjs'));
			assert.match(launch.args[launch.args.indexOf('--session-id') + 1], /^[0-9a-f-]{36}$/);
			assert.ok(launch.args.includes('--dangerously-skip-permissions'));
		} else if (CUSTOM) {
			assert.deepStrictEqual(launch.args, ARGUMENTS[CLI]);
		} else {
			for (const arg of ARGUMENTS[CLI]) { assert.ok(launch.args.includes(arg), `missing native argument ${arg}`); }
		}
		// Antigravity's trust in the folder, in its settings in the home its terminal sees: the suite's, never the person's (CLIS-3.3)
		if (CLI === 'agy') {
			const settings = JSON.parse(fs.readFileSync(path.join(AGENTS_HOME!, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as { trustedWorkspaces: string[] };
			assert.ok(settings.trustedWorkspaces.some(folder => sameFolder(folder, launch.cwd)), JSON.stringify(settings));
		}
		// The CLI asked whether its terminal takes reports, was answered by ptyd and reported idle - or, Muse Code reporting nothing,
		// its screen showed its empty input: the dot says not working (CLIS-2.3, D80). Until then it was starting, never red (D81)
		const dots = new Set([card.dot]);
		const reported = await until('its idle report', async () => {
			const now = (await state()).cards.find(each => each.runId === card.runId);
			if (now) {
				dots.add(now.dot);
			}
			return now?.dot === 'idle' ? now : undefined;
		});
		assert.strictEqual(reported.dot, 'idle');
		assert.ok(!dots.has('error'), `never red as it started: ${[...dots].join(', ')}`);

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
		assert.ok(!(await state()).cards.some(each => each.runId === card.runId), 'Close Agent removes the card at once');
		await until('the process to end in the background', async () => alive(pid) ? undefined : true);
	});

	test('Resume uses the saved cwd and exact ID; Pin and Unpin synchronize with the native tab', async function () {
		if (CUSTOM) { this.skip(); }
		const cwd = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'nested');
		fs.mkdirSync(cwd, { recursive: true });
		const fixture = resumeFixture(cwd);
		const before = (await state()).cardCount;
		void vscode.commands.executeCommand('facade.history');
		const card = await until('the resumed card', async () => {
			const current = await state();
			if (current.cardCount > before) { return current.cards[0]; }
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
		assert.strictEqual(card.name, 'Resume integration fixture');
		const alias = card.tooltip.join(' ').match(/#a\d+/)![0];
		const launch = await until('the resumed process', async () => fs.existsSync(`${RECORD}.args.${alias}`) ? JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] } : undefined);
		assert.ok(sameFolder(launch.cwd, cwd));
		assert.deepStrictEqual(launch.args.slice(0, 2), fixture.args);
		await until('the native session identity', async () => (await state()).cards.find(each => each.runId === card.runId)?.menu.pin || undefined);
		await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
		await until('the pinned card', async () => (await state()).cards.find(each => each.runId === card.runId)?.pinned ? true : undefined);
		await until('the pinned native tab', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label.startsWith(card.name) && tab.isPinned) ? true : undefined);
		await vscode.commands.executeCommand('facade.unpinAgent', { run_id: card.runId });
		await until('the unpinned card and tab', async () => !(await state()).cards.find(each => each.runId === card.runId)?.pinned && vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label.startsWith(card.name) && !tab.isPinned) ? true : undefined);
		// A native action saves the same restoration intent.
		await vscode.commands.executeCommand('workbench.action.pinEditor');
		await until('the card following a native Pin', async () => (await state()).cards.find(each => each.runId === card.runId)?.pinned ? true : undefined);
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
	});

	test('PANEL-1.2, 2.3: a card\'s location filter keeps the count; with no card left the page says none is in its location, and its Clear Filter shows every agent again', async function () {
		// Once, with the first built-in: the filter is the panel's, whatever the CLI
		if (CLI !== 'claude') {
			this.skip();
		}
		const card = await newCard();
		await vscode.commands.executeCommand('facade.filterByLocation', { run_id: card.runId });
		const filtered = await until('the filter', async () => { const now = await state(); return now.filter ? now : undefined; });
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
		const left = await until('the filtered empty panel', async () => { const now = await state(); return now.empty === 'noMatch' ? now : undefined; });
		const said = await until('the page to say so', async () => {
			const text = await vscode.commands.executeCommand<string[]>('facade.probe', { op: 'read', selector: '#empty p' });
			return text?.length ? text : undefined;
		});
		assert.strictEqual(await vscode.commands.executeCommand('facade.probe', { op: 'click', selector: '#empty button', index: 0 }), true);
		const cleared = await until('Clear Filter', async () => { const now = await state(); return now.filter === undefined ? now : undefined; });
		assert.deepStrictEqual([filtered.filter?.kind, filtered.cards.map(each => each.runId), filtered.cardCount, left.cardCount, said, cleared.empty], [
			'location', [card.runId], 1, 0, [`No agents found in "${filtered.filter?.label}".`], 'noAgents'
		]);
	});

	test('CLIS-4.1, ARCHITECTURE-3.3: Show Agent Launch shows each CLI as a start in this folder would have it, starting none; Show Agents Log shows the log', async function () {
		// Once, with the first built-in: the documents are the window's, whatever the CLI
		if (CLI !== 'claude') {
			this.skip();
		}
		const before = (await state()).cardCount;
		// As the Command Palette runs it; Resume may have remembered a nested cwd, so accept the location picker if shown.
		const showing = vscode.commands.executeCommand('facade.showAgentLaunch');
		const launch = await until('the launch document', async () => {
			const document = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'facade-launch');
			if (document) { return document; }
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
		await showing;
		const text = launch.getText();
		assert.match(text, /^Agent launch in /);
		assert.match(text, /^YOLO: on, from facade\.yolo; it applies to agents started from now on$/m);
		for (const name of ['Claude Code (claude, facade.claude)', 'Codex (codex, facade.codex)', 'Pi (pi, facade.pi)']) {
			assert.ok(text.includes(`\n${name}\n  Status: available\n`), `${name} available in:\n${text}`);
		}
		assert.ok(text.includes('\n    --dangerously-skip-permissions\n'), text);
		assert.strictEqual((await state()).cardCount, before, 'no agent was started');
		await vscode.commands.executeCommand('facade.showAgentsLog');
		const log = await until('the log document', async () => vscode.workspace.textDocuments.find(document => document.uri.scheme === 'facade-agents-log'));
		assert.ok(log.getText().trim() && log.getText() !== 'No agent events yet\n', 'this run has logged its agents');
	});
});
