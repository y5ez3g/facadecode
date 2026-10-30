/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const RECORD = process.env.FACADE_IT_RECORD!;
const CLI = process.env.FACADE_IT_CLI ?? 'claude';

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
		assert.strictEqual(card.avatar?.file, `avatar-${CLI}.png`);
		const launch = JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { cwd: string; args: string[] };
		assert.strictEqual(launch.cwd, vscode.workspace.workspaceFolders![0].uri.fsPath);
		assert.ok(launch.args.includes(CLI === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions'));
		if (CLI === 'codex') {
			assert.ok(launch.args.some(arg => arg.startsWith('projects={ ') && arg.includes('trust_level = "trusted"')));
		}

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
		assert.ok(!(await state()).cards.some(each => each.runId === card.runId), 'Close Agent removes the card at once');
		await until('the process to end in the background', async () => alive(pid) ? undefined : true);
	});
});
