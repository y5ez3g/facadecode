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
		const before = (await state()).cardCount;
		void vscode.commands.executeCommand('facade.newAgent');
		// The picker shows once its CLIs are found: accepted as soon as it is there, however long that takes
		const card = await until('a new card', async () => {
			const now = await state();
			if (now.cardCount > before) {
				return now.cards[0];
			}
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			return undefined;
		});
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
		// its screen showed its empty input: the dot says not working (CLIS-2.3, D80)
		const reported = await until('its idle report', async () => (await state()).cards.find(each => each.runId === card.runId && each.dot === 'idle'));
		assert.strictEqual(reported.dot, 'idle');

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
		assert.ok(!(await state()).cards.some(each => each.runId === card.runId), 'Close Agent removes the card at once');
		await until('the process to end in the background', async () => alive(pid) ? undefined : true);
	});
});
