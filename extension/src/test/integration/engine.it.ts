/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Rust engine's acceptance on the extension's side (spec.md "验收"), in one window that runs on it: core of this Facade root runs the
// agents, the window's terminal reaches it with `facade`, End Agent hides the card and tab and keeps the record for Resume Agent,
// and a program asking its terminal's colours is told the theme's. Fake CLIs only; the window runs
// `FACADE_IT_ONLY=engine` (or the whole suite with FACADE_IT_ENGINE=rust) and no other part of the suite asks for these.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';
import { until } from './editors';
import { aliasOf, hasAgentTab, keepConversation, listed, newCard, resumeCard, state } from './rustWindowDriver';

const RECORD = process.env.FACADE_IT_RECORD!;
/** The Facade root of this run: core's home, its settings file and its programs' state, as a terminal's `FACADE_HOME` names it. */
const HOME = process.env.FACADE_HOME!;
const ON = process.env.FACADE_IT_JOURNEY === 'engine';

type Card = PanelState['cards'][number];

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
			const seen = (JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) as ReturnType<typeof listed>).find(agent => `#${agent.agent_id}` === alias);
			assert.ok(seen, `the terminal lists ${alias}: ${fs.readFileSync(`${out}.json`, 'utf8')}`);
			assert.ok(seen.machine_id && seen.windows?.length === 1 && seen.windows[0].machine_id === seen.machine_id
				&& seen.windows[0].window_id !== 'terminal', 'it is the editor window\'s agent on this machine');
		} finally {
			shell.dispose();
			await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId }).then(undefined, () => undefined);
			await until('the agent to go', async () => (await state()).cards.some(each => each.runId === card.runId) ? undefined : true);
		}
	});

	test('End Agent hides the card and tab, and Resume Agent continues the retained agent by number (LIFECYCLE-3.1, 3.3)', async function () {
		this.timeout(120_000);
		const first = await newCard();
		const alias = aliasOf(first);
		const id = alias.slice(1);
		const launch = await launchOf(alias);
		// Core learns the conversation's ID from Claude Code's SessionStart hook
		const session = await until('its session in core', () => listed().find(agent => agent.agent_id === id)?.session);
		keepConversation(launch.cwd, session, 'Engine journey conversation');
		const screens = path.join(HOME, 'core', 'screens');
		await until('its screen log in core', () => fs.existsSync(path.join(screens, id)) ? true : undefined);
		await until('its terminal tab to open', () => hasAgentTab(first) || undefined);

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: first.runId });
		await until('its card and terminal tab to close', async () => !(await state()).cards.some(card => card.alias === alias) && !hasAgentTab(first) || undefined);
		const stopped = await until('End Agent to stop the retained agent', () => {
			const record = listed().find(agent => agent.agent_id === id);
			assert.ok(record, `End Agent retains ${alias} in facade list`);
			return record.process === 'ended' ? record : undefined;
		});
		assert.strictEqual(stopped.session, session);
		assert.strictEqual(stopped.state_detail?.how, 'stopped');
		assert.ok(fs.existsSync(path.join(screens, id)), 'its screen log stays');

		const second = await resumeCard();
		try {
			assert.strictEqual(aliasOf(second), alias, 'Resume Agent shows the original number');
			const resumed = await until('the CLI to resume its original session', async () => {
				const launch = await launchOf(alias);
				return launch.args[launch.args.indexOf('--resume') + 1] === session ? launch : undefined;
			});
			assert.strictEqual(fs.realpathSync(resumed.cwd), fs.realpathSync(launch.cwd), 'in the same folder');
			const records = listed().filter(agent => agent.session === session);
			assert.strictEqual(records.length, 1, 'one record holds the resumed session');
			const [agent] = records;
			assert.strictEqual(agent?.agent_id, id, 'core lists the resumed agent by its original number');
			assert.strictEqual(agent.process, 'running');
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
