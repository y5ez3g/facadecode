/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { piSessionFolderName } from '../../clis/history/pi';
import { SUGGESTED_NAMES } from '../../core/names';
import type { PanelState } from '../../webview/protocol';
import { linesOf } from '../detailLines';
import { unspun } from '../../base/tabSpinner';

const RECORD = process.env.FACADE_IT_RECORD!;
const CLI = process.env.FACADE_IT_CLI ?? 'claude';
const AVATAR = process.env.FACADE_IT_AVATAR ?? `avatar-${CLI}.png`;
/** The home folder the suite's settings give agents' terminals (`terminal.integrated.env.*`). */
const AGENTS_HOME = process.env.FACADE_IT_AGENTS_HOME;

/**
 * The arguments each built-in is started with in a folder with YOLO on, the default (CLIS-1.3, 3.3), after its Facade tools' own,
 * which the tools' journey checks (CLIS-3.2); Codex's trust is checked apart.
 * The configured custom CLI starts with its exact start arguments (CLIS-3.4).
 */
const ARGUMENTS: { readonly [cli: string]: readonly string[] } = {
	claude: ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""},"disabledMcpjsonServers":["facade"]}', '--dangerously-skip-permissions'],
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
			// This journey accepts the most recent entry. In a complete serial run the other vendors' earlier fixtures remain,
			// so this newly written conversation must also have new native activity, not an artificially old timestamp.
			{ type: 'assistant', sessionId: id, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [] } },
			{ type: 'ai-title', sessionId: id, aiTitle: title }
		].map(value => JSON.stringify(value)).join('\n') + '\n');
	} else if (CLI === 'codex') {
		write(path.join(AGENTS_HOME!, '.codex', 'sessions', '2026', '10', '31', `rollout-it-${id}.jsonl`), [
			{ type: 'session_meta', payload: { id, cwd } },
			{ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: title }] } }
		].map(value => JSON.stringify(value)).join('\n'));
	} else if (CLI === 'pi') {
		// In the folder Pi 1.4 keeps the sessions of `cwd` in, named for it, where its history reader looks
		write(path.join(AGENTS_HOME!, '.pi', 'agent', 'sessions', piSessionFolderName(cwd), `${id}.jsonl`), [
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
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	// The picker shows once its CLIs are found: accepted as soon as it is there, however long that takes. A new card goes last
	// (PANEL-2.1): it is the one not there before.
	return until('a new card', async () => {
		const now = await state();
		const added = now.cards.find(card => !before.has(card.runId));
		if (added) {
			return added;
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

suite(`Journey: a person starts and closes ${CLI} (J07)`, () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('New Agent with the preselected CLI creates the card and terminal at once, and its CLI runs in the folder', async () => {
		const card = await newCard();
		const terminal = vscode.window.terminals.find(each => unspun(each.name) === card.name);
		assert.ok(terminal, 'its editor terminal shows only the agent name');
		const alias = linesOf(card).join(' ').match(/#a\d+/)?.[0];
		assert.ok(alias, 'the card shows its short ID');
		const pidFile = `${RECORD}.${alias}`;
		const pid = await until('the fake CLI to start', async () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : undefined);
		assert.ok(alive(pid));
		// A built-in's maker avatar; the custom CLI's initial on a theme colour, and the terminal icon on its tab (PANEL-1.3, LIFECYCLE-2.2)
		if (CUSTOM) {
			const avatar = card.avatar as { initial: string; color: string };
			assert.deepStrictEqual([avatar.initial, ['blue', 'orange', 'purple'].includes(avatar.color)], ['M', true]);
			assert.strictEqual(((terminal.creationOptions as vscode.TerminalOptions).iconPath as vscode.ThemeIcon).id, 'terminal');
		} else {
			assert.deepStrictEqual(card.avatar, { file: AVATAR });
			assert.strictEqual(((terminal.creationOptions as vscode.TerminalOptions).iconPath as vscode.ThemeIcon).id, `facade-cli-${CLI}`);
		}
		const launch = JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] };
		assert.ok(sameFolder(launch.cwd, vscode.workspace.workspaceFolders![0].uri.fsPath), `${launch.cwd} is the workspace folder`);
		if (CUSTOM) {
			assert.deepStrictEqual(launch.args, ARGUMENTS[CLI], 'no injected MCP or built-in arguments');
			assert.strictEqual(fs.existsSync(`${RECORD}.mcp.${alias}`), false, 'no MCP server is started for an unintegrated custom CLI');
		} else if (CLI === 'codex') {
			assert.ok(launch.args.includes('--dangerously-bypass-approvals-and-sandbox'), launch.args.join(' '));
			assert.ok(launch.args.some(arg => arg.startsWith('projects={ ') && arg.includes('trust_level = "trusted"')));
		} else if (CLI === 'claude') {
			const settingsAt = launch.args.indexOf('--settings');
			assert.ok(settingsAt >= 0, 'the native session hooks accompany the MCP configuration');
			assert.strictEqual(launch.args.filter(arg => arg === '--settings').length, 1);
			assert.ok(launch.args.includes('--mcp-config'));
			const settings = JSON.parse(launch.args[settingsAt + 1]);
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
		// its screen showed its empty input: the card says not working, without a dot (CLIS-2.3). Until then it was
		// starting, never red (CLIS-2.3)
		const dots = new Set([card.dot]);
		const reported = await until('its idle report', async () => {
			const now = (await state()).cards.find(each => each.runId === card.runId);
			if (now) {
				dots.add(now.dot);
			}
			return now?.stateText === 'Idle' ? now : undefined;
		});
		assert.strictEqual(reported.dot, 'none');
		assert.ok(!dots.has('error'), `never red as it started: ${[...dots].join(', ')}`);
		for (const title of ['✳ Checking responsive layout', '⠐ Checking responsive layout', '● 检查标题更新 | workspace']) {
			fs.writeFileSync(`${RECORD}.quirks.${alias}`, JSON.stringify({ title, reportedTitle: 'Plain activity title' }));
			// Its terminal's title and its report's are no card's: its second line is Facade's own, unmarked, before any message, and its details' title
			// is its conversation's, from its CLI's own history (PANEL-1.4, 1.5, CLIS-2.4). The CLI writes both within a fifth of a second
			await new Promise(resolve => setTimeout(resolve, 1_000));
			const shown = (await state()).cards.find(each => each.runId === card.runId);
			const said = shown ? [shown.line, ...linesOf(shown)] : [];
			assert.deepStrictEqual([!!shown && !/^(?:\u{1F9D1}|\u{1F4E8}|\u{1F514})/u.test(shown.line), said.filter(line => /Checking responsive layout|检查标题更新|Plain activity title/.test(line))], [true, []], JSON.stringify(shown));
			assert.strictEqual(unspun(terminal.name), card.name, 'CLI titles never change the native terminal name');
			await until('the name-only editor tab', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
				.some(tab => tab.input instanceof vscode.TabInputTerminal && unspun(tab.label) === card.name) ? true : undefined);
		}

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
		assert.ok(!(await state()).cards.some(each => each.runId === card.runId), 'End Agent removes the card at once');
		await until('the process to end in the background', async () => alive(pid) ? undefined : true);
	});

	test('LIFECYCLE-2.2: a split of an agent\'s tab becomes, in the new group, an ordinary terminal in the agent\'s folder; the agent stays in its group, no agent starts, and no empty tab is left', async function () {
		if (CLI !== 'claude') { this.skip(); }
		this.timeout(90_000);
		const seen = () => JSON.stringify({
			groups: vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, active: group.isActive, tabs: group.tabs.map(tab => [tab.input instanceof vscode.TabInputTerminal ? 'terminal' : 'other', unspun(tab.label), tab.isActive]) })),
			// What the editor says of each terminal's start: a copy has neither a shell nor a pseudoterminal of its own (LIFECYCLE-2.2)
			terminals: vscode.window.terminals.map(each => [each.name, Object.fromEntries(Object.entries(each.creationOptions).map(([key, value]) => [key, key === 'env' ? (value ? 'set' : value) : key === 'pty' ? 'pty' : value]))])
		});
		const cards: string[] = [];
		try {
			const first = await newCard();
			cards.push(first.runId);
			await until('its tab active', async () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal ? true : undefined);
			const before = seen();
			// What terminals the editor opens for the split: VS Code 1.105 opens none - its split of a terminal tab is an empty group
			const opened: vscode.Terminal[] = [];
			const listening = vscode.window.onDidOpenTerminal(terminal => opened.push(terminal));
			await vscode.commands.executeCommand('workbench.action.splitEditorRight');
			const copied = await until('a copy, or none', async () => opened.length ? true : undefined, 5_000).catch(() => false);
			if (!copied) {
				listening.dispose();
				// No copy reported, so none to put a terminal in place of: the agent stays as it was, alone (LIFECYCLE-2.2). Only an editor
				// before 1.144 may make none - 1.105 opens an empty group - so that a later one making none is a regression seen
				const [major, minor] = vscode.version.split('.').map(Number);
				assert.ok(major === 1 && minor < 144, `VS Code ${vscode.version} copies a terminal tab it splits, and no copy was seen: ${seen()}`);
				console.log(`  split: VS Code ${vscode.version} makes no copy of a terminal tab it splits: ${seen()}`);
				assert.deepStrictEqual([(await state()).cards.map(card => card.runId), vscode.window.terminals.length], [[first.runId], 1]);
				return;
			}
			// The ordinary terminal in the copy's place, in the agent's folder, and the copy gone
			// New Agent starts in the window's folder: the terminal starts there too
			const agentFolder = vscode.workspace.workspaceFolders![0].uri.fsPath;
			let last = '';
			const shell = await until('an ordinary terminal in the copy\'s place, the copy gone', async () => {
				last = seen();
				const ordinary = opened.find(each => !('pty' in each.creationOptions) && (each.creationOptions as vscode.TerminalOptions).cwd !== undefined && each.exitStatus === undefined);
				const groups = vscode.window.tabGroups.all.map(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputTerminal).length);
				return ordinary && groups.length === 2 && groups.every(count => count === 1) ? ordinary : undefined;
			}, 20_000).catch(err => { throw new Error(`${(err as Error).message}: before ${before}, after ${last}`); });
			listening.dispose();
			const cwd = (shell.creationOptions as vscode.TerminalOptions).cwd;
			const shellFolder = typeof cwd === 'string' ? cwd : cwd?.fsPath ?? '';
			assert.deepStrictEqual([(await state()).cards.map(card => card.runId), vscode.window.tabGroups.all[0].tabs.some(tab => unspun(tab.label) === first.name)],
				[[first.runId], true], `the agent stays, alone, in its group: ${seen()}`);
			assert.strictEqual(fs.realpathSync(shellFolder), fs.realpathSync(agentFolder), `the terminal starts in the agent's folder: ${seen()}`);
			shell.dispose();
		} finally {
			for (const run of cards) {
				await vscode.commands.executeCommand('facade.closeAgent', { run_id: run }).then(undefined, () => undefined);
			}
			await vscode.commands.executeCommand('workbench.action.closeAllGroups');
		}
	});

	test('PANEL-3.3: native Modern UI settings reach the webview initially and on live changes, with a traditional fallback on older editors', async function () {
		if (CLI !== 'claude') { this.skip(); }
		const setting = 'workbench.experimental.modernUI';
		const configuration = vscode.workspace.getConfiguration();
		const original = configuration.inspect<boolean>(setting);
		const check = async (modern: boolean) => {
			const wanted = modern ? ['8px', '4px', '2px'] : ['10px', '0px', '0px'];
			return until(`scrollbar style ${wanted}`, async () => {
				const styles = await vscode.commands.executeCommand<{ width: string; top: string; bottom: string; clipBottom: string; borderRadius: string }[]>('facade.probe', { op: 'style', selector: '.facade-scrollbar, .facade-scrollbar-thumb' });
				return styles?.length === 2 && styles[0].width === wanted[0] && styles[1].borderRadius === wanted[1]
					&& styles[0].top === wanted[2] && Math.abs(parseFloat(styles[0].bottom) - parseFloat(styles[0].clipBottom) - (modern ? 2 : 0)) < 0.001 ? true : undefined;
			});
		};
		await check(configuration.get(setting) === true);
		if (original?.defaultValue === undefined) {
			assert.notStrictEqual(configuration.get(setting), true, 'an editor without Modern UI uses traditional lists');
			return;
		}
		try {
			for (const modern of [false, true, false]) {
				await configuration.update(setting, modern, vscode.ConfigurationTarget.Global);
				await check(modern);
			}
		} finally {
			await configuration.update(setting, original.globalValue, vscode.ConfigurationTarget.Global);
		}
	});

	test('Resume uses the saved cwd and exact ID; Pin and Unpin synchronize with the native tab', async function () {
		if (CUSTOM) { this.skip(); }
		const cwd = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'nested');
		fs.mkdirSync(cwd, { recursive: true });
		const fixture = resumeFixture(cwd);
		const before = new Set((await state()).cards.map(each => each.runId));
		void vscode.commands.executeCommand('facade.history');
		const card = await until('the resumed card', async () => {
			const current = await state();
			const added = current.cards.find(each => !before.has(each.runId));
			if (added) { return added; }
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
		assert.ok(SUGGESTED_NAMES.includes(card.name), `Resume assigns a short name, not the history title: ${card.name}`);
		const alias = linesOf(card).join(' ').match(/#a\d+/)![0];
		const launch = await until('the resumed process', async () => fs.existsSync(`${RECORD}.args.${alias}`) ? JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] } : undefined);
		assert.ok(sameFolder(launch.cwd, cwd));
		const resumeAt = launch.args.indexOf(fixture.args[0]);
		assert.ok(resumeAt >= 0, 'the native resume option accompanies the MCP configuration');
		assert.deepStrictEqual(launch.args.slice(resumeAt, resumeAt + 2), fixture.args);
		await until('the native session identity', async () => (await state()).cards.find(each => each.runId === card.runId)?.menu.pin || undefined);
		await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
		await until('the pinned card', async () => (await state()).cards.find(each => each.runId === card.runId)?.pinned ? true : undefined);
		await until('the pinned native tab', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => unspun(tab.label).startsWith(card.name) && tab.isPinned) ? true : undefined).catch(error => {
			console.error('Native Pin state', JSON.stringify({ terminal: vscode.window.activeTerminal?.name, tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({ label: tab.label, pinned: tab.isPinned, active: tab.isActive, groupActive: tab.group.isActive })) }));
			throw error;
		});
		await vscode.commands.executeCommand('facade.unpinAgent', { run_id: card.runId });
		await until('the unpinned card and tab', async () => !(await state()).cards.find(each => each.runId === card.runId)?.pinned && vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => unspun(tab.label).startsWith(card.name) && !tab.isPinned) ? true : undefined);
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
		// Filter by Working Location..., as the person takes the card's location: in this window of one folder, the item after its
		// whole folder
		void vscode.commands.executeCommand('facade.filter');
		const filtered = await until('the filter', async () => {
			const now = await state();
			if (now.filter) {
				return now;
			}
			await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
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
		assert.match(text, /^YOLO: on, from facade\.yolo; applies to newly started agents$/m);
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
