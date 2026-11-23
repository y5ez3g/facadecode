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
import { BUILT_IN_NAMES } from '../../base/names';
import type { PanelState } from '../../webview/protocol';
import type { Pin } from '../../core/ports';
import { linesOf } from '../detailLines';
import { unspun } from '../../base/tabSpinner';
import { observeAcceptanceImplementation } from './acceptanceImplementation';
import { frameworkSocket } from './editors';
import { fixturePid, legacyStopResult, pidGone, windowsProcessStart } from './journeyProcess';
import { RESUME_PICKER_STATE, type ResumePickerState } from './resumePickerFixture';

const RECORD = process.env.FACADE_IT_RECORD!;
const CLI = process.env.FACADE_IT_CLI ?? 'claude';
const AVATAR = process.env.FACADE_IT_AVATAR ?? `avatar-${CLI}.png`;
/** The home folder the suite's settings give agents' terminals (`terminal.integrated.env.*`). */
const AGENTS_HOME = process.env.FACADE_IT_AGENTS_HOME;

/**
 * The arguments each built-in is started with in a folder with YOLO on, the default (CLIS-1.3, 3.3), after its Facade tools' own,
 * which the tools' journey checks (CLIS-3.2); Claude Code's and Codex's are checked apart.
 * The suite's program starts with exactly its args (CONFIGURATION-2.3).
 */
const ARGUMENTS: { readonly [cli: string]: readonly string[] } = {
	agy: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
	muse: ['--disable-approval', '--disable-sandbox'],
	opencode: ['--auto'],
	pi: [],
	'my-cli': ['--from-custom', 'two words']
};
/** Whether the windows run on the Framework: framework starts each CLI with its own wiring rather than the extension's run files. */
const FRAMEWORK = process.env.FACADE_IT_IMPLEMENTATION === 'framework';
/** Whether this run's CLI is the suite's program rather than a built-in. */
const CUSTOM = CLI === 'my-cli';
const WAIT_MS = 20_000;

/** Native store fixtures: actual vendor interoperability is verified separately with isolated native CLIs. */
function resumeFixture(cwd: string): { title: string; args: string[] } {
	const id = '86da4482-2bae-4a45-b193-a5664c19826a', title = `Resume integration fixture for ${CLI}`;
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
		return { title, args: ['--session', session] };
	} else if (CLI === 'muse') {
		const dir = path.join(AGENTS_HOME!, '.local', 'share', 'muse'), log = path.join(dir, `${id}.jsonl`);
		write(log, '{}\n');
		sqlite(path.join(dir, 'session-index.db'), 'CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, workspace_root TEXT, status TEXT, prompt_count INTEGER, session_log_path TEXT, first_user_prompt TEXT, updated_at_us INTEGER)',
			"INSERT OR REPLACE INTO sessions VALUES (?, ?, 'valid', 1, ?, ?, ?)", [id, cwd, log, title, Date.now() * 1000]);
	}
	return { title, args: [({ codex: 'resume', muse: 'resume', agy: '--conversation', pi: '--session' } as Record<string, string>)[CLI] ?? '--resume', id] };
}

/** Whether two paths name one folder as this system names them: Windows ignores case, and VS Code writes its drive in lower case. */
function sameFolder(a: string, b: string): boolean {
	return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

/** The fake CLI's record uses a leading hash on either implementation. */
function fixtureAlias(card: PanelState['cards'][number]): string | undefined {
	const alias = card.alias;
	if (!(FRAMEWORK ? /^a\d+$/ : /^#a\d+$/).test(alias)) { return undefined; }
	return FRAMEWORK ? `#${alias}` : alias;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = WAIT_MS): Promise<T> {
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
		// On the Framework its short ID comes with framework's answer to the start (RULES-2.2): the card is the test's once it has it
		if (added && fixtureAlias(added)) {
			return added;
		}
		if (!added) {
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		}
		return undefined;
	});
}

/** Stop and clear the fixture from the workspace once its lifecycle has been checked. */
async function stopAndHide(runId: string): Promise<void> {
	await vscode.commands.executeCommand('facade.stopAgent', { run_id: runId });
	if (FRAMEWORK) { await vscode.commands.executeCommand('facade.hideAgent', { run_id: runId }); }
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
	let firstRun: string | undefined;

	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	teardown(async () => {
		if (firstRun !== undefined) {
			try {
				await stopAndHide(firstRun);
			} finally {
				firstRun = undefined;
			}
		}
	});

	test('New Agent with the preselected CLI creates the card and terminal at once, and its CLI runs in the folder', async function () {
		const card = await newCard();
		firstRun = card.runId;
		observeAcceptanceImplementation(this, card);
		const terminal = vscode.window.terminals.find(each => unspun(each.name) === card.name);
		assert.ok(terminal, 'its editor terminal shows only the agent name');
		const alias = fixtureAlias(card);
		assert.ok(alias, 'the card shows its short ID');
		const pidFile = `${RECORD}.${alias}`;
		const pid = await until('the fake CLI to start', async () => fixturePid(pidFile));
		assert.ok(alive(pid));
		const windowsLegacy = !FRAMEWORK && process.platform === 'win32';
		const creation = windowsLegacy ? await windowsProcessStart(pid) : undefined;
		// A built-in's maker avatar; a program's white robot, on its card and its tab (PANEL-1.3, LIFECYCLE-2.2, CONFIGURATION-2.4)
		if (CUSTOM) {
			assert.deepStrictEqual(card.avatar, { file: 'robot-pearl-face.svg', eyes: 'robot-eyes.svg' });
			assert.strictEqual(((terminal.creationOptions as vscode.TerminalOptions).iconPath as vscode.ThemeIcon).id, 'facade-robot-pearl');
		} else {
			assert.deepStrictEqual(card.avatar, { file: AVATAR });
			assert.strictEqual(((terminal.creationOptions as vscode.TerminalOptions).iconPath as vscode.ThemeIcon).id, `facade-cli-${CLI}`);
		}
		const launch = JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] };
		assert.ok(sameFolder(launch.cwd, vscode.workspace.workspaceFolders![0].uri.fsPath), `${launch.cwd} is the workspace folder`);
		if (CUSTOM) {
			assert.deepStrictEqual(launch.args, ARGUMENTS[CLI], 'no injected MCP or built-in arguments');
			assert.strictEqual(fs.existsSync(`${RECORD}.mcp.${alias}`), false, 'no MCP server is started for a program');
		} else if (CLI === 'codex') {
			assert.ok(launch.args.includes('--dangerously-bypass-approvals-and-sandbox'), launch.args.join(' '));
			const folderTrusted = launch.args.some(arg => arg.startsWith('projects={ ') && arg.includes('trust_level = "trusted"'));
			assert.strictEqual(folderTrusted, !FRAMEWORK, 'folder trust for a person starting Codex');
		} else if (CLI === 'claude' && FRAMEWORK) {
			// Framework's own wiring: its tools and its SessionStart hook come inline, in one `--settings`, and its plugin and MCP files are its run's
			const settingsAt = launch.args.indexOf('--settings');
			assert.ok(settingsAt >= 0 && launch.args.filter(arg => arg === '--settings').length === 1, 'one --settings carries the native session hook');
			const settings = JSON.parse(launch.args[settingsAt + 1]);
			assert.match(settings.hooks.SessionStart[0].hooks[0].command, /hook session-start/);
			assert.ok(launch.args.includes('--mcp-config'));
			assert.ok(launch.args.includes('--dangerously-skip-permissions'));
		} else if (CLI === 'claude') {
			const settingsAt = launch.args.indexOf('--settings');
			assert.ok(settingsAt >= 0, 'the native session hooks accompany the MCP configuration');
			assert.strictEqual(launch.args.filter(arg => arg === '--settings').length, 1);
			assert.ok(launch.args.includes('--mcp-config'));
			// Its run settings are a file of the run, given by its path, never inline (CONFIGURATION-4.2)
			const file = launch.args[settingsAt + 1];
			assert.ok(path.isAbsolute(file) && path.basename(file) === 'claude-settings.json', file);
			const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
			assert.deepStrictEqual(settings.env, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' });
			assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('hook.cjs'));
			assert.match(launch.args[launch.args.indexOf('--session-id') + 1], /^[0-9a-f-]{36}$/);
			assert.ok(launch.args.includes('--dangerously-skip-permissions'));
		} else if (CUSTOM) {
			assert.deepStrictEqual(launch.args, ARGUMENTS[CLI]);
		} else {
			for (const arg of ARGUMENTS[CLI]) { assert.ok(launch.args.includes(arg), `missing native argument ${arg}`); }
		}
		if (CLI === 'muse') {
			assert.strictEqual(launch.args.includes('--trust-workspace'), !FRAMEWORK, 'folder trust for a person starting Muse');
		} else if (CLI === 'pi') {
			assert.strictEqual(launch.args.includes('--approve'), !FRAMEWORK, 'startup approvals for a person starting Pi');
		}
		// Check the folder trust in Antigravity's isolated settings (CLIS-3.3).
		if (CLI === 'agy') {
			// Framework gives the run's settings by file, or inline in earlier builds; the legacy implementation updates the CLI's settings file.
			const argument = launch.args[launch.args.indexOf('--settings') + 1];
			const text = FRAMEWORK ? (fs.existsSync(argument) ? fs.readFileSync(argument, 'utf8') : argument)
				: fs.readFileSync(path.join(AGENTS_HOME!, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8');
			const settings = JSON.parse(text) as { trustedWorkspaces?: string[] };
			const folderTrusted = settings.trustedWorkspaces?.some(folder => sameFolder(folder, launch.cwd)) ?? false;
			assert.strictEqual(folderTrusted, !FRAMEWORK, 'folder trust for a person starting Antigravity');
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
			if (FRAMEWORK) {
				// RULES-6.2 shows the Orchestrator's terminal title in the card and its details.
				const shown = await until(`the card title ${title}`, async () => (await state()).cards.find(each => each.runId === card.runId && each.line === title));
				assert.ok(linesOf(shown).includes(`Title: ${title}`), JSON.stringify(shown));
				assert.ok(!linesOf(shown).some(line => line.includes('Plain activity title')), JSON.stringify(shown));
			} else {
				// CLIS-2.4 gives the legacy implementation a title from history. Let the fixture publish both other titles before checking.
				await new Promise(resolve => setTimeout(resolve, 1_000));
				const shown = (await state()).cards.find(each => each.runId === card.runId);
				const said = shown ? [shown.line, ...linesOf(shown)] : [];
				assert.deepStrictEqual([!!shown && !/^(?:\u{1F9D1}|\u{1F4E8}|\u{1F514})/u.test(shown.line), said.filter(line => /Checking responsive layout|检查标题更新|Plain activity title/.test(line))], [true, []], JSON.stringify(shown));
			}
			assert.strictEqual(unspun(terminal.name), card.name, 'CLI titles never change the native terminal name');
			await until('the name-only editor tab', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
				.some(tab => tab.input instanceof vscode.TabInputTerminal && unspun(tab.label) === card.name) ? true : undefined);
		}

		await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
		if (!FRAMEWORK) {
			assert.ok(!(await state()).cards.some(each => each.runId === card.runId), 'Stop Agent removes the card at once');
		}
		const deadline = Date.now() + WAIT_MS;
		let nextProbe = 0;
		let lastCreation: string | undefined;
		try {
			await until('the process to end in the background', async () => {
				if (!windowsLegacy) { return alive(pid) ? undefined : true; }
				if (pidGone(pid)) { return true; }
				const now = Date.now();
				if (now < nextProbe || now >= deadline) { return undefined; }
				const observedCreation = await windowsProcessStart(pid, Math.min(2_000, deadline - now));
				lastCreation = observedCreation ?? lastCreation;
				nextProbe = Date.now() + 1_000;
				return creation && observedCreation && creation !== observedCreation && Date.now() <= deadline ? true : undefined;
			});
		} catch (error) {
			const identity = windowsLegacy ? ` Windows creation before Stop ${creation ?? 'unavailable'}, last ${lastCreation ?? 'unavailable'}.` : '';
			const cleanup = !FRAMEWORK ? ` Stop result ${legacyStopResult(process.env.FACADE_HOME, card.runId) ?? 'unavailable'}.` : '';
			throw new Error(`${error.message}. Run ${card.runId}, fixture PID ${pid}.${identity}${cleanup}`, { cause: error });
		}
		if (FRAMEWORK) {
			await until('Stop to retain the ended card', async () => (await state()).cards.find(each => each.runId === card.runId && each.orchestrator?.running === false));
			await vscode.commands.executeCommand('facade.hideAgent', { run_id: card.runId });
		}
		firstRun = undefined;
	});

	test('Stop Agent ends the targeted process and leaves a second editor agent running', async function () {
		const target = await newCard();
		firstRun = target.runId;
		observeAcceptanceImplementation(this, target);
		const survivor = await newCard();
		const pidOf = (card: PanelState['cards'][number]) => {
			const pidFile = `${RECORD}.${fixtureAlias(card)}`;
			return until('the fake CLI PID', async () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : undefined);
		};
		try {
			const [ended, kept] = await Promise.all([pidOf(target), pidOf(survivor)]);
			assert.notStrictEqual(ended, kept);
			assert.ok(alive(ended) && alive(kept), 'both fixture agents were running');
			await vscode.commands.executeCommand('facade.stopAgent', { run_id: target.runId });
			await until('the target process to end', async () => alive(ended) ? undefined : true);
			const cards = (await state()).cards;
			assert.ok(alive(kept) && cards.some(card => card.runId === survivor.runId));
		} finally {
			await stopAndHide(survivor.runId);
		}
	});

	test('LIFECYCLE-2.2: a person types English, Chinese and emoji in an agent terminal, unchanged and without submitting', async function () {
		if (CUSTOM) { this.skip(); }
		const card = await newCard();
		let watching: vscode.Disposable | undefined;
		try {
			observeAcceptanceImplementation(this, card);
			const alias = fixtureAlias(card);
			assert.ok(alias);
			const terminal = vscode.window.terminals.find(each => unspun(each.name) === card.name);
			assert.ok(terminal, 'the agent has its editor terminal');
			await until('its editor tab in front', async () => {
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
				return tab?.input instanceof vscode.TabInputTerminal && unspun(tab.label) === card.name ? true : undefined;
			});
			await until('the fake CLI ready', async () => (await state()).cards.find(each => each.runId === card.runId)?.stateText === 'Idle' ? true : undefined);
			const pty = (terminal.creationOptions as vscode.ExtensionTerminalOptions).pty;
			assert.ok(pty, 'the terminal uses the product Pseudoterminal');
			let screen = '';
			// Read the same output that draws this terminal, on either implementation.
			watching = pty.onDidWrite(data => { screen += data; });
			const file = `${RECORD}.bytes.${alias}`;
			if (!FRAMEWORK && CLI === 'agy') {
				// The legacy implementation can finish its startup MCP probe after the fake CLI reports Idle.
				const probe = Buffer.from('\x1b[200~/mcp\x1b[201~\r\x1b');
				await until('the MCP panel close key to reach the fake CLI', async () =>
					fs.existsSync(file) && fs.readFileSync(file).includes(probe) || undefined);
			}
			const offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
			const received = () => fs.existsSync(file) ? fs.readFileSync(file).subarray(offset) : Buffer.alloc(0);
			const text = 'hello 中文 🚀';
			const expected = Buffer.from(text, 'utf8');
			// VS Code sends this through the Pseudoterminal's handleInput, as it does a person's typing; no tool types for them.
			terminal.sendText(text, false);
			const bytes = await until('the fake CLI to receive all typed bytes', async () => received().length >= expected.length ? received() : undefined)
				.catch(error => { throw new Error(`${(error as Error).message}; expected UTF-8 ${expected.toString('hex')}, received ${received().toString('hex')}`); });
			assert.deepStrictEqual(bytes, expected, 'the CLI receives exactly the typed UTF-8 bytes, with no Enter');
			await until('the same text drawn in its input box', async () => screen.includes(text) ? true : undefined);
			assert.strictEqual(fs.existsSync(`${RECORD}.received.${alias}`), false, 'the draft was never submitted');
		} finally {
			watching?.dispose();
			await stopAndHide(card.runId);
		}
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
			observeAcceptanceImplementation(this, first);
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
			assert.ok(sameFolder(fs.realpathSync(shellFolder), fs.realpathSync(agentFolder)), `the terminal starts in the agent's folder: ${shellFolder}, ${agentFolder}: ${seen()}`);
			shell.dispose();
		} finally {
			for (const run of cards) {
				await stopAndHide(run).then(undefined, () => undefined);
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

	test('Resuming opens the saved cwd and exact session ID, with the implementation\'s Pin behavior', async function () {
		if (CUSTOM) { this.skip(); }
		const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
		// The Orchestrator matches the exact queried folder. The old history picker includes descendants.
		const cwd = FRAMEWORK ? folder : path.join(folder, 'nested');
		fs.mkdirSync(cwd, { recursive: true });
		const fixture = resumeFixture(cwd);
		const before = new Set((await state()).cards.map(each => each.runId));
		const started = async () => (await state()).cards.filter(each => !before.has(each.runId));
		const history = vscode.commands.executeCommand(FRAMEWORK ? 'facade.resumeAgent' : 'facade.continueSession');
		void history.then(undefined, () => undefined);
		try {
			let lastPicker: ResumePickerState | undefined;
			await until('the Resume fixture ' + fixture.title + ' to be selected', async () => {
				const picker = await vscode.commands.executeCommand<ResumePickerState>(RESUME_PICKER_STATE).then(value => value, () => undefined);
				lastPicker = picker;
				if (!picker || picker.busy || picker.active < 0) { return undefined; }
				const target = picker.labels.indexOf(fixture.title);
				if (target < 0) { return undefined; }
				assert.strictEqual(picker.labels.lastIndexOf(fixture.title), target, 'the Resume fixture title identifies one row');
				if (target === picker.active) { return true; }
				await vscode.commands.executeCommand(target < picker.active ? 'workbench.action.quickOpenSelectPrevious' : 'workbench.action.quickOpenSelectNext');
				return undefined;
			}).catch(error => { throw new Error(`${(error as Error).message}; picker: ${JSON.stringify(lastPicker)}`); });
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			await history;
			// On the Framework its short ID and name come with framework's answer to the start.
			const card = await until('the resumed card', async () => (await started()).find(fixtureAlias));
			assert.ok(BUILT_IN_NAMES.includes(card.name), `Resume assigns a short name, not the history title: ${card.name}`);
			const alias = fixtureAlias(card);
			assert.ok(alias);
			observeAcceptanceImplementation(this, card);
			const launch = await until('the resumed process', async () => fs.existsSync(`${RECORD}.args.${alias}`) ? JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] } : undefined);
			assert.ok(sameFolder(launch.cwd, cwd));
			const resumeAt = launch.args.indexOf(fixture.args[0]);
			assert.ok(resumeAt >= 0, 'the native resume option accompanies the MCP configuration');
			assert.deepStrictEqual(launch.args.slice(resumeAt, resumeAt + 2), fixture.args);
			const pinnable = await until('the native session identity', async () => (await state()).cards.find(each => each.runId === card.runId && each.menu.pin));
			await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
			await until('the pinned card', async () => (await state()).cards.find(each => each.runId === card.runId && each.pinned)).catch(async error => {
				console.error('Resumed Pin state', JSON.stringify({ before: pinnable, after: (await state()).cards.find(each => each.runId === card.runId) ?? null }));
				throw error;
			});
			if (FRAMEWORK) {
				await vscode.commands.executeCommand('facade.unpinAgent', { run_id: card.runId });
				await until('the unpinned workspace card', async () => (await state()).cards.find(each => each.runId === card.runId && !each.pinned));
				await vscode.commands.executeCommand('workbench.action.pinEditor');
				await until('the native tab to be marked', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
					.find(tab => tab.input instanceof vscode.TabInputTerminal && unspun(tab.label) === card.name && tab.isPinned));
				const nativeOnly = (await state()).cards.find(each => each.runId === card.runId);
				assert.ok(nativeOnly && !nativeOnly.pinned, 'native tab pinning leaves the workspace Pin alone');
				return;
			}
			await until('the pinned native tab', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => unspun(tab.label).startsWith(card.name) && tab.isPinned) ? true : undefined).catch(error => {
				console.error('Native Pin state', JSON.stringify({ terminal: vscode.window.activeTerminal?.name, tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({ label: tab.label, pinned: tab.isPinned, active: tab.isActive, groupActive: tab.group.isActive })) }));
				throw error;
			});
			await vscode.commands.executeCommand('facade.unpinAgent', { run_id: card.runId });
			// LIFECYCLE-3.4: the tab-change event can precede completion of Facade's own mark command. Observe the unpinned state across
			// two polls before issuing a separate native action; one early observation can still be inside that command's event guard.
			let unpinned = 0;
			await until('the unpinned card and tab to settle', async () => {
				const agreed = !(await state()).cards.find(each => each.runId === card.runId)?.pinned && vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => unspun(tab.label).startsWith(card.name) && !tab.isPinned);
				unpinned = agreed ? unpinned + 1 : 0;
				return unpinned >= 2 ? true : undefined;
			});
			// A native action acts on the active group's front tab alone and saves the same restoration intent.
			await vscode.commands.executeCommand('facade.revealAgent', { run_id: card.runId });
			await until('the resumed terminal in front for native Pin', async () => {
				const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
				return tab?.input instanceof vscode.TabInputTerminal && unspun(tab.label).startsWith(card.name) && !tab.isPinned ? true : undefined;
			});
			await vscode.commands.executeCommand('workbench.action.pinEditor');
			try {
				await until('the card and tab following a native Pin', async () => (await state()).cards.find(each => each.runId === card.runId)?.pinned && vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => unspun(tab.label).startsWith(card.name) && tab.isPinned) ? true : undefined);
			} catch (error) {
				console.error('Native Pin synchronization', JSON.stringify({ cards: (await state()).cards.map(each => ({ runId: each.runId, name: each.name, pinned: each.pinned })),
					tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({ label: tab.label, pinned: tab.isPinned, active: tab.isActive, groupActive: tab.group.isActive })) }));
				throw error;
			}
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
			await history.then(undefined, () => undefined);
			await Promise.all((await started()).map(card => stopAndHide(card.runId)));
			await until('the resumed cards to close', async () => (await started()).length === 0 || undefined);
		}
	});

	test('PANEL-1.2, 2.3: a card\'s location filter keeps the count; with no card left the page says none is in its location, and its Clear Filter shows every agent again', async function () {
		// Once, with the first built-in: the filter is the panel's, whatever the CLI
		if (CLI !== 'claude') {
			this.skip();
		}
		const card = await newCard();
		observeAcceptanceImplementation(this, card);
		// Filter by Working Location..., as the person takes the card's location: in this window of one folder, the item after its
		// whole folder
		// The picker lists its locations once the window's locations are read, later in a remote window: a key before that accepts the
		// first item, every agent, which closes the picker - so it is opened again and given its time before the keys
		const filtered = await until('the filter', async () => {
			const now = await state();
			if (now.filter) {
				return now;
			}
			void vscode.commands.executeCommand('facade.filter');
			await new Promise(resolve => setTimeout(resolve, 2_500));
			await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			await new Promise(resolve => setTimeout(resolve, 500));
			return (await state()).filter ? await state() : undefined;
		}, 60_000);
		await stopAndHide(card.runId);
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

	if (!FRAMEWORK && CLI === 'claude') {
		test('PANEL-1.3: the Webview Pin and Unpin buttons persist only the exact card’s native session', async function () {
			const cards: PanelState['cards'][number][] = [];
			const home = path.join(process.env.FACADE_HOME!, 'extension');
			const uri = vscode.workspace.workspaceFolders![0].uri.toString();
			const ledgerKey = process.platform === 'linux' ? uri : uri.toLowerCase();
			const readJson = <T>(file: string): T | undefined => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : undefined;
			const saved = (): readonly Pin[] => {
				const workspace = readJson<{ bindings: Record<string, string> }>(path.join(home, 'workspace-uris.json'))?.bindings[ledgerKey];
				if (!workspace) { return []; }
				const file = path.join(home, 'workspaces', workspace, 'workspace-state.json');
				return readJson<{ 'facade.pins'?: readonly Pin[] }>(file)?.['facade.pins'] ?? [];
			};
			const selector = (run: string, pinned: boolean) =>
				'.agent[data-run=' + JSON.stringify(run) + '] .pin-button:not([hidden])[data-look="' + (pinned ? 'filled' : 'outline') + '"]';
			const rendered = async (run: string, pinned: boolean) =>
				(await vscode.commands.executeCommand<string[]>('facade.probe', { op: 'read', selector: selector(run, pinned) }))?.length === 1;
			const changePin = async (run: string, wasPinned: boolean, wanted: readonly string[]) => {
				const before = await state();
				await until('the exact rendered Pin button', async () => await rendered(run, wasPinned) || undefined);
				assert.strictEqual(await vscode.commands.executeCommand('facade.probe', { op: 'click', selector: selector(run, wasPinned) }), true);
				return until('the new Webview state and saved Pins for the expected sessions', async () => {
					const now = await state();
					const pins = saved();
					const card = now.cards.find(each => each.runId === run);
					if (now.revision > before.revision && card && !!card.pinned !== wasPinned && await rendered(run, !wasPinned) &&
						pins.length === wanted.length && pins.every((pin, index) => pin.conversation.sessionId === wanted[index])) {
						return pins;
					}
					return undefined;
				});
			};
			try {
				cards.push(await newCard());
				cards.push(await newCard());
				const [first, second] = cards;
				observeAcceptanceImplementation(this, first);
				const [firstSession, secondSession] = await Promise.all(cards.map(card => until('its exact native conversation can be pinned', async () => {
					const session = readJson<{ session_id?: string }>(path.join(home, 'runs', card.runId + '.session.json'))?.session_id;
					return typeof session === 'string' && session && (await state()).cards.some(each => each.runId === card.runId && each.menu.pin)
						? session : undefined;
				})));
				assert.notStrictEqual(firstSession, secondSession);
				assert.deepStrictEqual(saved(), []);
				await changePin(first.runId, false, [firstSession]);
				assert.ok(await rendered(second.runId, false), 'the neighboring card remains unpinned');
				const both = await changePin(second.runId, false, [firstSession, secondSession]);
				const remaining = await changePin(first.runId, true, [secondSession]);
				assert.deepStrictEqual(remaining, [both[1]], 'Unpin preserves the neighboring card’s exact Pin');
				assert.ok(await rendered(second.runId, true), 'the Webview still renders its neighboring Pin');
				console.log('  Webview Pin observation ' + JSON.stringify({
					target: { run: first.runId, session: firstSession, pin: both[0].id },
					retained: { run: second.runId, session: secondSession, pin: remaining[0].id },
				}));
			} finally {
				await Promise.all(cards.map(card => stopAndHide(card.runId)));
			}
		});
	}

	test('CLIS-4.1, ARCHITECTURE-3.3: Show Agent Command Line shows each CLI as a start in this folder would have it, starting none; Show Agents Log shows the log', async function () {
		// Once, with the first built-in: the documents are the window's, whatever the CLI
		if (CLI !== 'claude') {
			this.skip();
		}
		const before = (await state()).cardCount;
		// The Framework has no Show Agent Command Line (the specification takes it away); its log is framework's own
		if (!FRAMEWORK) {
			const showing = vscode.commands.executeCommand('facade.showAgentLaunch');
			const launch = await until('the launch document', async () => {
				const document = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'facade-launch');
				if (document) { return document; }
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
				return undefined;
			});
			await showing;
			assert.strictEqual(launch.uri.path, '/Agent Command Line');
			const text = launch.getText();
			assert.match(text, /^Agent command line in /);
			assert.match(text, /^YOLO: on, from yolo in .*facade\.json; applies to newly started agents$/m);
			for (const name of ['Claude Code (claude, clis.claude)', 'Codex (codex, clis.codex)', 'Pi (pi, clis.pi)']) {
				assert.ok(text.includes(`\n${name}\n  State: available\n`), `${name} available in:\n${text}`);
			}
			assert.ok(text.includes('\n    --dangerously-skip-permissions\n'), text);
			assert.strictEqual((await state()).cardCount, before, 'showing the launch does not start an agent');
		}
		const card = await newCard();
		firstRun = card.runId;
		observeAcceptanceImplementation(this, card);
		const pidFile = `${RECORD}.${fixtureAlias(card)}`;
		const pid = await until('the logged fake CLI', async () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : undefined);
		await until('the log to contain a known event from this Facade root', async () => {
			await vscode.commands.executeCommand('facade.showAgentsLog');
			const document = vscode.window.activeTextEditor?.document;
			if (document?.uri.scheme !== 'facade-agents-log') { return undefined; }
			const logged = document.getText();
			return (FRAMEWORK ? logged.includes(`listening on ${frameworkSocket(process.env.FACADE_HOME!)}`)
				: logged.includes(`Started ${card.alias} (${CLI}) pid ${pid}`)) || undefined;
		});
	});
});
