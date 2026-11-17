/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Rust engine's acceptance on the extension's side (spec.md "验收"), in one window that runs on it: core of this Facade root runs the
// agents, the window's terminal reaches it with `facade`, End Agent leaves nothing of an agent in core, Recent continues a conversation
// by its session as a new agent, and a program asking its terminal's colours is told the theme's. Fake CLIs only; the window runs
// `FACADE_IT_ONLY=engine` (or the whole suite with FACADE_IT_ENGINE=rust) and no other part of the suite asks for these.

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';
import { linesOf } from '../detailLines';

const RECORD = process.env.FACADE_IT_RECORD!;
/** The Facade root of this run: core's home, its settings file and its programs' state, as a terminal's `FACADE_HOME` names it. */
const HOME = process.env.FACADE_HOME!;
const ON = process.env.FACADE_IT_JOURNEY === 'engine';

type Card = PanelState['cards'][number];

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
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
async function newCard(): Promise<Card> {
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	return until('a new card', async () => {
		const added = (await state()).cards.find(card => !before.has(card.runId));
		// Its short ID comes with core's answer to the start
		if (added && /#a\d+/.test(linesOf(added).join(' '))) {
			return added;
		}
		if (!added) {
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		}
		return undefined;
	});
}

/** The short ID a card shows, `#a1`, which core calls `a1`. */
function aliasOf(card: Card): string {
	const alias = linesOf(card).join(' ').match(/#a\d+/)?.[0];
	assert.ok(alias, 'the card shows its short ID');
	return alias;
}

/** What core says: its programs as the package carries them, run for this root, never as an agent. */
function facade(...args: string[]): { readonly status: number | null; readonly out: string } {
	const { FACADE_AGENT: _agent, ...env } = process.env;
	const run = spawnSync(path.join(vscode.extensions.getExtension('facade.facadecode')!.extensionPath, 'bin', process.platform === 'win32' ? 'facade.exe' : 'facade'), args, { env: { ...env, FACADE_HOME: HOME }, encoding: 'utf8', timeout: 20_000 });
	return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

interface Listed { readonly agent_id: string; readonly name: string; readonly window_id: string; readonly cwd: string; readonly process: string; readonly session?: string }

function listed(): Listed[] {
	const run = facade('list', '--json');
	assert.strictEqual(run.status, 0, run.out);
	return JSON.parse(run.out) as Listed[];
}

/** Everything the store holds, as text: each table's rows, so that what a record kept - its start's ID, say - can be looked for. */
function storeText(): string {
	const db = new DatabaseSync(path.join(HOME, 'core', 'facade.db'), { readOnly: true });
	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
		return tables.map(table => JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all(), (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value)).join('\n');
	} finally {
		db.close();
	}
}

/** A launch's recorded arguments. */
async function launchOf(alias: string): Promise<{ cwd: string; args: string[] }> {
	const file = `${RECORD}.args.${alias}`;
	return until(`${alias}'s CLI to start`, () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { cwd: string; args: string[] } : undefined);
}

/** What a program was given on its input so far: its terminal's answers among it. */
function stdinText(alias: string): string {
	const log = `${RECORD}.stdin.${alias}`;
	return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { data: string }).data).join('');
}

/** The colour of OSC 11 a program was answered with after the first `since` characters of its input, as a brightness from 0 to 1. */
async function backgroundOf(alias: string, since: number): Promise<number> {
	// eslint-disable-next-line no-control-regex
	const reply = await until('the answer to its colour question', () => /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i.exec(stdinText(alias).slice(since)) ?? undefined);
	const channel = (hex: string) => parseInt(hex, 16) / (16 ** hex.length - 1);
	return (channel(reply[1]) + channel(reply[2]) + channel(reply[3])) / 3;
}

(ON ? suite : suite.skip)('Journey: the Rust engine in this window (spec 验收)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('the window runs on core of this Facade root', async () => {
		const log = path.join(HOME, 'core', 'logs', 'daemon.log');
		await until('core\'s daemon of this root to run', () => fs.existsSync(log) && /listening on/.test(fs.readFileSync(log, 'utf8')) ? true : undefined);
		assert.ok(fs.existsSync(path.join(HOME, 'core', 'facade.db')), 'its store is in the root\'s core folder');
		assert.deepStrictEqual(listed().filter(agent => agent.process !== 'ended'), [], 'no agent runs before this journey starts one');
	});

	test('`facade list` in the window\'s terminal shows the agent the editor started', async function () {
		this.timeout(90_000);
		const card = await newCard();
		const alias = aliasOf(card);
		const out = path.join(path.dirname(RECORD), 'terminal-list');
		// On Windows, PowerShell without the person's profile; its files written as ASCII, which `>` would write as UTF-16
		const windows = process.platform === 'win32';
		const shell = vscode.window.createTerminal({ name: 'engine-journey shell', ...windows ? { shellPath: 'powershell.exe', shellArgs: ['-NoProfile'] } : {} });
		try {
			// PATH has core's program of this root, YOLO is on by default, so the terminal sees the editor's agents
			shell.sendText(windows
				? `(Get-Command facade).Source | Out-File -Encoding ascii '${out}.which'; facade list --json | Out-File -Encoding ascii '${out}.json'; $LASTEXITCODE | Out-File -Encoding ascii '${out}.done'`
				: `command -v facade > '${out}.which'; facade list --json > '${out}.json'; echo $? > '${out}.done'`);
			await until('the terminal\'s `facade list`', () => fs.existsSync(`${out}.done`) ? true : undefined, 60_000);
			assert.strictEqual(fs.readFileSync(`${out}.done`, 'utf8').trim(), '0', fs.existsSync(`${out}.json`) ? fs.readFileSync(`${out}.json`, 'utf8') : 'no output');
			assert.strictEqual(path.basename(path.dirname(path.dirname(fs.readFileSync(`${out}.which`, 'utf8').trim()))), 'core', `the terminal runs core's own facade: ${fs.readFileSync(`${out}.which`, 'utf8')}`);
			const seen = (JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) as Listed[]).find(agent => `#${agent.agent_id}` === alias);
			assert.ok(seen, `the terminal lists ${alias}: ${fs.readFileSync(`${out}.json`, 'utf8')}`);
			assert.notStrictEqual(seen.window_id, 'terminal', 'it is the editor window\'s agent');
		} finally {
			shell.dispose();
			await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId }).then(undefined, () => undefined);
			await until('the agent to go', async () => (await state()).cards.some(each => each.runId === card.runId) ? undefined : true);
		}
	});

	test('End Agent leaves no record and no screen log of the agent in core; Recent has its conversation, and a click continues it by session as a new agent', async function () {
		this.timeout(120_000);
		const first = await newCard();
		const alias = aliasOf(first);
		const id = alias.slice(1);
		const launch = await launchOf(alias);
		// Core learns the conversation's ID from Claude Code's SessionStart hook
		const session = await until('its session in core', () => listed().find(agent => agent.agent_id === id)?.session);
		// What Claude Code itself keeps of its conversation, which Recent reads: the fixture this fake CLI does not write
		const store = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', launch.cwd.replace(/[^A-Za-z0-9]/g, '-'));
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, `${session}.jsonl`), [
			{ type: 'user', sessionId: session, cwd: launch.cwd, parentUuid: null, message: { role: 'user', content: 'Engine journey conversation' } },
			{ type: 'assistant', sessionId: session, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [] } },
			{ type: 'ai-title', sessionId: session, aiTitle: 'Engine journey conversation' }
		].map(value => JSON.stringify(value)).join('\n') + '\n');
		const screens = path.join(HOME, 'core', 'screens');
		await until('its screen log in core', () => fs.existsSync(path.join(screens, id)) ? true : undefined);
		assert.ok(storeText().includes(first.runId), 'core keeps the agent\'s record, with its start\'s ID, while it is there');
		assert.ok(listed().some(agent => agent.agent_id === id));

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: first.runId });
		await until('End Agent to remove the agent from core', () => listed().some(agent => agent.agent_id === id) ? undefined : true);
		assert.ok(!fs.existsSync(path.join(screens, id)), 'its screen log is gone');
		assert.ok(!storeText().includes(first.runId), 'its record is gone');
		assert.ok(!(await state()).cards.some(card => card.runId === first.runId), 'its card is gone');

		// Recent: the conversation is there, and choosing it starts a new agent in core that continues the same session
		const before = new Set((await state()).cards.map(card => card.runId));
		void vscode.commands.executeCommand('facade.history');
		const second = await until('the card Recent starts', async () => {
			const added = (await state()).cards.find(card => !before.has(card.runId));
			if (added) {
				return added;
			}
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
		try {
			const secondAlias = aliasOf(second);
			assert.notStrictEqual(secondAlias, alias, 'a new agent, with a number of its own');
			const resumed = await launchOf(secondAlias);
			const resumeAt = resumed.args.indexOf('--resume');
			assert.deepStrictEqual(resumeAt >= 0 ? resumed.args.slice(resumeAt, resumeAt + 2) : resumed.args, ['--resume', session], 'its CLI continues the same session');
			assert.strictEqual(fs.realpathSync(resumed.cwd), fs.realpathSync(launch.cwd), 'in the same folder');
			assert.ok(listed().some(agent => `#${agent.agent_id}` === secondAlias), 'core lists the new agent');
			assert.ok(!listed().some(agent => agent.agent_id === id), 'and not the one End Agent removed');
		} finally {
			await vscode.commands.executeCommand('facade.closeAgent', { run_id: second.runId }).then(undefined, () => undefined);
		}
	});

	test('a program that asks for its terminal\'s colours is told the dark theme\'s, then, in a light theme, the light one\'s', async function () {
		this.timeout(120_000);
		const theme = vscode.workspace.getConfiguration('workbench');
		const original = theme.inspect<string>('colorTheme')?.globalValue;
		const ask = (alias: string) => fs.writeFileSync(`${RECORD}.quirks.${alias}`, JSON.stringify({ ask: '\x1b]11;?\x1b\\', asked: Date.now() }));
		const cards: Card[] = [];
		try {
			await theme.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
			await until('the dark theme', () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? true : undefined);
			const dark = await newCard();
			cards.push(dark);
			const darkAlias = aliasOf(dark);
			await launchOf(darkAlias);
			const darkSince = stdinText(darkAlias).length;
			ask(darkAlias);
			const darkBackground = await backgroundOf(darkAlias, darkSince);
			assert.ok(darkBackground < 0.3, `a dark background in a dark theme: ${darkBackground}`);

			await theme.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
			await until('the light theme', () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? true : undefined);
			// The window tells core about its colours when the theme changes; a program started after that is answered with them
			const light = await newCard();
			cards.push(light);
			const lightAlias = aliasOf(light);
			await launchOf(lightAlias);
			const lightSince = stdinText(lightAlias).length;
			ask(lightAlias);
			const lightBackground = await backgroundOf(lightAlias, lightSince);
			assert.ok(lightBackground > 0.7, `a light background in a light theme: ${lightBackground}`);
		} finally {
			await theme.update('colorTheme', original, vscode.ConfigurationTarget.Global);
			for (const card of cards) {
				await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId }).then(undefined, () => undefined);
			}
		}
	});
});
