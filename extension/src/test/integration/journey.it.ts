/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const RECORD = process.env.FACADE_IT_RECORD!;
const CLI = process.env.FACADE_IT_CLI ?? 'claude';
const AVATAR = process.env.FACADE_IT_AVATAR ?? `avatar-${CLI}.png`;
/** The home folder the suite's settings give agents' terminals (`terminal.integrated.env.*`). */
const AGENTS_HOME = process.env.FACADE_IT_AGENTS_HOME;

/** The arguments each built-in is started with in a folder with YOLO on, the default (CLIS-1.3, 3.3); Codex's trust is checked apart. */
const ARGUMENTS: { readonly [cli: string]: readonly string[] } = {
	claude: ['--settings', '{"env":{"CLAUDE_CODE_DISABLE_TERMINAL_TITLE":""}}', '--dangerously-skip-permissions'],
	agy: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
	muse: ['--disable-approval', '--disable-sandbox', '--trust-workspace'],
	opencode: ['--auto'],
	pi: ['--approve']
};

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
		assert.strictEqual(card.avatar?.file, AVATAR);
		const launch = JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] };
		assert.ok(sameFolder(launch.cwd, vscode.workspace.workspaceFolders![0].uri.fsPath), `${launch.cwd} is the workspace folder`);
		if (CLI === 'codex') {
			assert.strictEqual(launch.args[0], '--dangerously-bypass-approvals-and-sandbox');
			assert.ok(launch.args.some(arg => arg.startsWith('projects={ ') && arg.includes('trust_level = "trusted"')));
		} else {
			assert.deepStrictEqual(launch.args, ARGUMENTS[CLI]);
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
		// As the Command Palette runs it, with no argument; one working location: no picker, its document at once
		await vscode.commands.executeCommand('facade.showAgentLaunch');
		const launch = await until('the launch document', async () => vscode.workspace.textDocuments.find(document => document.uri.scheme === 'facade-launch'));
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
